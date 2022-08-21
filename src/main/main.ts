import {
  app,
  BrowserWindow,
  BrowserWindowConstructorOptions,
  dialog,
  Menu,
  MessageChannelMain,
  MessagePortMain,
  nativeTheme,
  shell
} from "electron";
import fs from "fs";
import jsonfile from "jsonfile";
import os from "os";
import path from "path";
import NamedMessage from "../lib/NamedMessage";
import Preferences from "../lib/Preferences";
import checkForUpdate from "./checkForUpdate";
import { DEFAULT_PREFS, LAST_OPEN_FILE, PREFS_FILENAME, REPOSITORY, WINDOW_ICON } from "./constants";
import net from "net";
import StateTracker from "./StateTracker";

// Global variables
var hubWindows: BrowserWindow[] = []; // Ordered by last focus time (recent first)
var downloadWindow: BrowserWindow | null = null;
var prefsWindow: BrowserWindow | null = null;
var satelliteWindows: BrowserWindow[] = [];
var windowPorts: { [id: number]: MessagePortMain } = {};

var hubStateTracker = new StateTracker();
var usingUsb = false; // Menu bar setting, bundled with other prefs for renderers
var firstOpenPath: string | null = null; // Cache path to open immediately

// Live RLOG variables
const RLOG_CONNECT_TIMEOUT_MS = 1000; // How long to wait when connecting
const RLOG_DATA_TIMEOUT_MS = 3000; // How long with no data until timeout
const RLOG_HEARTBEAT_DELAY_MS = 1000; // How long to wait between heartbeats
const RLOG_HEARTBEAT_DATA = new Uint8Array([6, 3, 2, 8]);
var rlogSocket: net.Socket | null = null;
var rlogSocketTimeout: NodeJS.Timeout | null = null;
var rlogDataArray = new Uint8Array();

/** Records the last open file for the robot program (and recent files for the OS). */
function recordOpenFile(filePath: string) {
  fs.writeFile(LAST_OPEN_FILE, filePath, () => {});
  app.addRecentDocument(filePath);
}

// WINDOW MESSAGE HANDLING

/**
 * Sends a message to a single window.
 * @param window The window target
 * @param name The name of the message
 * @param data Arbitrary data to include
 */
function sendMessage(window: BrowserWindow, name: string, data?: any) {
  windowPorts[window.id].postMessage({ name: name, data: data });
}

/** Sends the current preferences to all windows (including USB menu bar setting) */
function sendAllPreferences() {
  var data: Preferences = jsonfile.readFileSync(PREFS_FILENAME);
  data.usb = usingUsb;
  nativeTheme.themeSource = data.theme;
  hubWindows.forEach((window) => {
    if (!window.isDestroyed()) {
      sendMessage(window, "set-preferences", data);
    }
  });
  if (downloadWindow != null && !downloadWindow.isDestroyed()) sendMessage(downloadWindow, "set-preferences", data);
}

/**
 * Process a message from a hub window.
 * @param window The source hub window
 * @param message The received message
 */
function handleHubMessage(window: BrowserWindow, message: NamedMessage) {
  switch (message.name) {
    case "historical-start":
      let sendError = () => {
        sendMessage(window, "historical-data", {
          success: false
        });
      };
      fs.open(message.data, "r", (error, file) => {
        if (error) sendError();
        fs.readFile(file, (error, buffer) => {
          if (error) {
            sendError();
          } else {
            sendMessage(window, "historical-data", {
              success: true,
              raw: buffer
            });
          }
        });
      });
      break;

    case "live-rlog-start":
      rlogSocket = net.createConnection({
        host: message.data.address,
        port: message.data.port
      });

      rlogSocket.setTimeout(RLOG_CONNECT_TIMEOUT_MS, () => {
        sendMessage(window, "live-rlog-data", { status: false });
      });

      function appendArray(newArray: Uint8Array) {
        let fullArray = new Uint8Array(rlogDataArray.length + newArray.length);
        fullArray.set(rlogDataArray);
        fullArray.set(newArray, rlogDataArray.length);
        rlogDataArray = fullArray;
      }

      rlogSocket.on("data", (data) => {
        appendArray(data);
        if (rlogSocketTimeout != null) clearTimeout(rlogSocketTimeout);
        rlogSocketTimeout = setTimeout(() => {
          rlogSocket?.destroy();
        }, RLOG_DATA_TIMEOUT_MS);

        while (true) {
          var expectedLength;
          if (rlogDataArray.length < 4) {
            break;
          } else {
            expectedLength = new DataView(rlogDataArray.buffer).getInt32(0) + 4;
            if (rlogDataArray.length < expectedLength) {
              break;
            }
          }

          var singleArray = rlogDataArray.slice(4, expectedLength);
          rlogDataArray = rlogDataArray.slice(expectedLength);

          if (rlogSocket) {
            sendMessage(window, "live-rlog-data", { success: true, raw: new Uint8Array(singleArray) });
          }
        }
      });

      rlogSocket.on("error", () => {
        sendMessage(window, "live-rlog-data", { success: false });
      });

      rlogSocket.on("close", () => {
        sendMessage(window, "live-rlog-data", { success: false });
      });
      break;

    case "live-rlog-stop":
      rlogSocket?.destroy();
      break;
  }
}

// Send live RLOG heartbeat
setInterval(() => {
  rlogSocket?.write(RLOG_HEARTBEAT_DATA);
}, RLOG_HEARTBEAT_DELAY_MS);

// CREATE WINDOWS

/** Create the app menu. */
function setupMenu() {
  const isMac = process.platform === "darwin";

  const template: (Electron.MenuItemConstructorOptions | Electron.MenuItem)[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Open...",
          accelerator: "CmdOrCtrl+O",
          click(_, window) {
            if (window == null || !hubWindows.includes(window)) return;
            var files = dialog.showOpenDialog(window, {
              title: "Select a robot log file to open",
              properties: ["openFile"],
              filters: [{ name: "Robot logs", extensions: ["rlog", "wpilog"] }]
            });
            files.then((files) => {
              if (files.filePaths.length > 0) {
                sendMessage(window, "open-file", files.filePaths[0]);
                recordOpenFile(files.filePaths[0]);
              }
            });
          }
        },
        {
          label: "Connect to Robot",
          accelerator: "CmdOrCtrl+K",
          click(_, window) {
            if (window == null || !hubWindows.includes(window)) return;
            sendMessage(window, "start-live", "robot");
          }
        },
        {
          label: "Connect to Simulator",
          accelerator: "CmdOrCtrl+Shift+K",
          click(_, window) {
            if (window == null || !hubWindows.includes(window)) return;
            sendMessage(window, "start-live", "sim");
          }
        },
        {
          label: "Download Logs...",
          accelerator: "CmdOrCtrl+D",
          click(_, window) {
            if (window == null) return;
            openDownload(window);
          }
        },
        {
          label: "Export CSV...",
          accelerator: "CmdOrCtrl+E",
          click(_, window) {
            if (window == null || !hubWindows.includes(window)) return;
            sendMessage(window, "export-csv");
          }
        },
        { type: "separator" },
        {
          label: "Use USB roboRIO Address",
          type: "checkbox",
          checked: false,
          click(item) {
            usingUsb = item.checked;
            sendAllPreferences();
          }
        },
        { type: "separator" },
        {
          label: "New Window",
          accelerator: "CommandOrControl+N",
          click() {
            createHubWindow();
          }
        },
        isMac ? { role: "close", accelerator: "Shift+Cmd+W" } : { role: "quit" }
      ]
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    {
      label: "Tabs",
      submenu: [
        {
          label: "New Line Graph",
          accelerator: "CmdOrCtrl+1",
          click(_, window) {
            if (window == null || !hubWindows.includes(window)) return;
            sendMessage(window, "tab-command", { type: "new", detail: 1 });
          }
        },
        {
          label: "New Table",
          accelerator: "CmdOrCtrl+2",
          click(_, window) {
            if (window == null || !hubWindows.includes(window)) return;
            sendMessage(window, "tab-command", { type: "new", detail: 2 });
          }
        },
        {
          label: "New Odometry",
          accelerator: "CmdOrCtrl+3",
          click(_, window) {
            if (window == null || !hubWindows.includes(window)) return;
            sendMessage(window, "tab-command", { type: "new", detail: 3 });
          }
        },
        {
          label: "New Points",
          accelerator: "CmdOrCtrl+4",
          click(_, window) {
            if (window == null || !hubWindows.includes(window)) return;
            sendMessage(window, "tab-command", { type: "new", detail: 4 });
          }
        },
        { type: "separator" },
        {
          label: "Previous Tab",
          accelerator: "CmdOrCtrl+Left",
          click(_, window) {
            if (window == null || !hubWindows.includes(window)) return;
            sendMessage(window, "tab-command", { type: "move", detail: -1 });
          }
        },
        {
          label: "Next Tab",
          accelerator: "CmdOrCtrl+Right",
          click(_, window) {
            if (window == null || !hubWindows.includes(window)) return;
            sendMessage(window, "tab-command", { type: "move", detail: 1 });
          }
        },
        { type: "separator" },
        {
          label: "Shift Left",
          accelerator: "CmdOrCtrl+[",
          click(_, window) {
            if (window == null || !hubWindows.includes(window)) return;
            sendMessage(window, "tab-command", { type: "shift", detail: -1 });
          }
        },
        {
          label: "Shift Right",
          accelerator: "CmdOrCtrl+]",
          click(_, window) {
            if (window == null || !hubWindows.includes(window)) return;
            sendMessage(window, "tab-command", { type: "shift", detail: 1 });
          }
        },
        { type: "separator" },
        {
          label: "Close Tab",
          accelerator: isMac ? "Cmd+W" : "Ctrl+Q",
          click(_, window) {
            if (window == null || !hubWindows.includes(window)) return;
            sendMessage(window, "tab-command", { type: "close" });
          }
        }
      ]
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "View Repository",
          click() {
            shell.openExternal("https://github.com/" + REPOSITORY);
          }
        },
        {
          label: "Team Website",
          click() {
            shell.openExternal("https://littletonrobotics.org");
          }
        }
      ]
    }
  ];

  if (isMac) {
    template.splice(0, 0, {
      role: "appMenu",
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Preferences...",
          accelerator: "Cmd+,",
          click(_, window) {
            if (window == null) return;
            openPreferences(window);
          }
        },
        {
          label: "Check for Updates...",
          click() {
            checkForUpdate(true);
          }
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    });
  } else {
    (template[template.length - 1].submenu as Electron.MenuItemConstructorOptions[]).splice(
      0,
      0,
      {
        label: "About Advantage Scope",
        click() {
          dialog.showMessageBox({
            type: "info",
            title: "About",
            message: "Advantage Scope",
            detail: "Version: " + app.getVersion() + "\nPlatform: " + process.platform + "-" + process.arch,
            buttons: ["Close"],
            icon: WINDOW_ICON
          });
        }
      },
      {
        label: "Show Preferences...",
        accelerator: "Ctrl+,",
        click(_, window) {
          if (window == null) return;
          openPreferences(window);
        }
      },
      {
        label: "Check for Updates...",
        click() {
          checkForUpdate(true);
        }
      },
      { type: "separator" }
    );
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/** Creates a new hub window. */
function createHubWindow() {
  var prefs: BrowserWindowConstructorOptions = {
    minWidth: 800,
    minHeight: 400,
    icon: WINDOW_ICON,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "hub$preload.js")
    }
  };

  // Manage window state
  var focusedWindow = BrowserWindow.getFocusedWindow();
  const defaultWidth = 1100;
  const defaultHeight = 650;
  if (hubWindows.length == 0) {
    let state = hubStateTracker.getState(defaultWidth, defaultHeight);
    prefs.x = state.x;
    prefs.y = state.y;
    prefs.width = state.width;
    prefs.height = state.height;
  } else if (focusedWindow != null) {
    var bounds = focusedWindow.getBounds();
    prefs.x = bounds.x + 30;
    prefs.y = bounds.y + 30;
    prefs.width = bounds.width;
    prefs.height = bounds.height;
  } else {
    prefs.width = defaultWidth;
    prefs.height = defaultHeight;
  }

  // Set fancy window effects
  if (process.platform == "darwin") {
    prefs.vibrancy = "sidebar";
    if (Number(os.release().split(".")[0]) >= 20) prefs.titleBarStyle = "hiddenInset";
  }

  // Create window
  var window = new BrowserWindow(prefs);
  hubWindows.push(window);
  const { port1, port2 } = new MessageChannelMain();
  windowPorts[window.id] = port2;
  window.webContents.postMessage("port", null, [port1]);
  port2.on("message", (event) => {
    handleHubMessage(window, event.data);
  });
  port2.start();

  // Finish setup
  if (!app.isPackaged) window.webContents.openDevTools();
  window.once("ready-to-show", window.show);
  sendMessage(window, "set-fullscreen", window.isFullScreen());
  sendMessage(window, "set-platform", {
    platform: process.platform,
    release: os.release()
  });
  sendAllPreferences();
  window.on("enter-full-screen", () => sendMessage(window, "set-fullscreen", true));
  window.on("leave-full-screen", () => sendMessage(window, "set-fullscreen", false));
  window.on("blur", () => sendMessage(window, "set-focused", false));
  window.on("focus", () => {
    sendMessage(window, "set-focused", true);
    hubStateTracker.setFocusedWindow(window);
  });

  window.loadFile(path.join(__dirname, "../www/hub.html"));
  return window;
}

/**
 * Creates a new preferences window if it doesn't already exist.
 * @param parentWindow The parent window to use for alignment
 */
function openPreferences(parentWindow: Electron.BrowserWindow) {}

/**
 * Creates a new download window if it doesn't already exist.
 * @param parentWindow The parent window to use for alignment
 */
function openDownload(parentWindow: Electron.BrowserWindow) {}

// APPLICATION EVENTS

// Workaround to set menu bar color on some Linux environments
if (process.platform == "linux" && fs.existsSync(PREFS_FILENAME)) {
  var prefs: Preferences = jsonfile.readFileSync(PREFS_FILENAME);
  if (prefs.theme == "dark") {
    process.env["GTK_THEME"] = "Adwaita:dark";
  }
}

app.whenReady().then(() => {
  // Check preferences and set theme
  if (!fs.existsSync(PREFS_FILENAME)) {
    jsonfile.writeFileSync(PREFS_FILENAME, DEFAULT_PREFS);
    nativeTheme.themeSource = DEFAULT_PREFS.theme;
  } else {
    var prefs: Preferences = jsonfile.readFileSync(PREFS_FILENAME);
    nativeTheme.themeSource = prefs.theme;
  }

  // Create menu and window
  setupMenu();
  var window = createHubWindow();

  // Check for file path given as argument
  if (app.isPackaged) {
    if (process.argv.length > 1) {
      firstOpenPath = process.argv[1];
    }
  } else {
    if (process.argv.length > 2) {
      firstOpenPath = process.argv[2];
    }
  }

  // Open file if exists
  if (firstOpenPath != null) {
    sendMessage(window, "open-file", firstOpenPath);
    recordOpenFile(firstOpenPath);
  }

  // Create new window if activated while none exist
  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length == 0) createHubWindow();
  });

  // Send update notification once the window is ready
  window.once("show", () => checkForUpdate(false));
});

app.on("window-all-closed", function () {
  if (process.platform !== "darwin") app.quit();
});

// macOS only, Linux & Windows start a new process and pass the file as an argument
app.on("open-file", (_, path) => {
  if (app.isReady()) {
    // Already running, create a new window
    var window = createHubWindow();
    sendMessage(window, "open-file", path);
    recordOpenFile(path);
  } else {
    // Not running yet, open in first window
    firstOpenPath = path;
  }
});

// Remove the open file path from temp file
app.on("quit", () => {
  fs.unlink(LAST_OPEN_FILE, () => {});
});
