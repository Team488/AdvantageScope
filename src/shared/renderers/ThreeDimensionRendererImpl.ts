import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTF, GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import {
  Config3dField,
  Config3d_Rotation,
  DEFAULT_DRIVER_STATIONS,
  STANDARD_FIELD_LENGTH,
  STANDARD_FIELD_WIDTH
} from "../AdvantageScopeAssets";
import { Rotation3d } from "../geometry";
import { convert } from "../units";
import { checkArrayType, clampValue } from "../util";
import TabRenderer from "./TabRenderer";
import {
  ThreeDimensionRendererCommand,
  ThreeDimensionRendererCommand_AnyObj,
  ThreeDimensionRendererCommand_RobotObj
} from "./ThreeDimensionRenderer";
import makeAxesField from "./threeDimension/AxesField";
import makeEvergreenField from "./threeDimension/EvergreenField";
import ObjectManager from "./threeDimension/ObjectManager";
import optimizeGeometries from "./threeDimension/OptimizeGeometries";
import AprilTagManager from "./threeDimension/objectManagers/AprilTagManager";
import AxesManager from "./threeDimension/objectManagers/AxesManager";
import ConeManager from "./threeDimension/objectManagers/ConeManager";
import GamePieceManager from "./threeDimension/objectManagers/GamePieceManager";
import HeatmapManager from "./threeDimension/objectManagers/HeatmapManager";
import RobotManager from "./threeDimension/objectManagers/RobotManager";
import TrajectoryManager from "./threeDimension/objectManagers/TrajectoryManager";
import ZebraManager from "./threeDimension/objectManagers/ZebraManager";

export default class ThreeDimensionRendererImpl implements TabRenderer {
  private LOWER_POWER_MAX_FPS = 30;
  private MAX_ORBIT_FOV = 160;
  private MIN_ORBIT_FOV = 10;
  private ORBIT_FIELD_DEFAULT_TARGET = new THREE.Vector3(0, 0.5, 0);
  private ORBIT_AXES_DEFAULT_TARGET = new THREE.Vector3(STANDARD_FIELD_LENGTH / 2, 0, -STANDARD_FIELD_WIDTH / 2);
  private ORBIT_ROBOT_DEFAULT_TARGET = new THREE.Vector3(0, 0.5, 0);
  private ORBIT_FIELD_DEFAULT_POSITION = new THREE.Vector3(0, 6, -12);
  private ORBIT_AXES_DEFAULT_POSITION = new THREE.Vector3(
    2 + STANDARD_FIELD_LENGTH / 2,
    2,
    -4 - STANDARD_FIELD_WIDTH / 2
  );
  private ORBIT_ROBOT_DEFAULT_POSITION = new THREE.Vector3(2, 1, 1);
  private DS_CAMERA_HEIGHT = convert(62, "inches", "meters"); // https://www.ergocenter.ncsu.edu/wp-content/uploads/sites/18/2017/09/Anthropometric-Summary-Data-Tables.pdf
  private DS_CAMERA_OFFSET = 1.5; // Distance away from the glass
  private MATERIAL_SPECULAR: THREE.Color = new THREE.Color(0x666666); // Overridden if not cinematic
  private MATERIAL_SHININESS: number = 100; // Overridden if not cinematic
  private WPILIB_ROTATION = getQuaternionFromRotSeq([
    {
      axis: "x",
      degrees: -90
    },
    {
      axis: "y",
      degrees: 180
    }
  ]);
  private CAMERA_ROTATION = getQuaternionFromRotSeq([
    {
      axis: "z",
      degrees: -90
    },
    {
      axis: "y",
      degrees: -90
    }
  ]);

  private shouldResetCamera = true;
  private mode: "cinematic" | "standard" | "low-power";
  private canvas: HTMLCanvasElement;
  private annotationsDiv: HTMLElement;
  private alert: HTMLElement;

  private renderer: THREE.WebGLRenderer;
  private cssRenderer: CSS2DRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private wpilibCoordinateGroup: THREE.Group; // Rotated to match WPILib coordinates
  private wpilibFieldCoordinateGroup: THREE.Group; // Field coordinates (origin at driver stations and flipped based on alliance)
  private field: THREE.Object3D | null = null;
  private fieldStagedPieces: THREE.Object3D | null = null;
  private fieldPieces: { [key: string]: THREE.Mesh } = {};
  private primaryRobotGroup: THREE.Group;
  private fixedCameraObj: THREE.Object3D;
  private fixedCameraOverrideObj: THREE.Object3D;
  private dsCameraGroup: THREE.Group;
  private dsCameraObj: THREE.Object3D;

  private objectManagers: {
    type: ThreeDimensionRendererCommand_AnyObj["type"];
    manager: ObjectManager<ThreeDimensionRendererCommand_AnyObj>;
    active: boolean;
  }[] = [];

  private shouldRender = false;
  private cameraIndex: CameraIndex = CameraIndexEnum.OrbitField;
  private orbitFov = 50;
  private primaryRobotModel = "";
  private resolutionVector = new THREE.Vector2();
  private fieldConfigCache: Config3dField | null = null;
  private lastCameraIndex = -1;
  private lastAutoDriverStation = -1;
  private lastFrameTime = 0;
  private lastWidth: number | null = 0;
  private lastHeight: number | null = 0;
  private lastDevicePixelRatio: number | null = null;
  private lastIsDark: boolean | null = null;
  private lastCommandString: string = "";
  private lastAssetsString: string = "";
  private lastFieldTitle: string = "";

  constructor(
    mode: "cinematic" | "standard" | "low-power",
    canvas: HTMLCanvasElement,
    annotationsDiv: HTMLElement,
    alert: HTMLElement
  ) {
    this.mode = mode;
    this.canvas = canvas;
    this.annotationsDiv = annotationsDiv;
    this.alert = alert;
    this.renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      powerPreference: mode === "cinematic" ? "high-performance" : mode === "low-power" ? "low-power" : "default"
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = mode === "cinematic";
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.cssRenderer = new CSS2DRenderer({ element: annotationsDiv });
    this.scene = new THREE.Scene();
    if (mode !== "cinematic") {
      this.MATERIAL_SPECULAR = new THREE.Color(0x000000);
      this.MATERIAL_SHININESS = 0;
    }

    // Change camera menu
    let startPx: [number, number] | null = null;
    canvas.addEventListener("contextmenu", (event) => {
      startPx = [event.x, event.y];
    });
    canvas.addEventListener("mouseup", (event) => {
      if (startPx && event.x === startPx[0] && event.y === startPx[1]) {
        let robotConfig = window.assets?.robots.find((robotData) => robotData.name === this.primaryRobotModel);
        let cameraList = robotConfig === undefined ? [] : robotConfig.cameras.map((camera) => camera.name);
        window.sendMainMessage("ask-3d-camera", {
          options: cameraList,
          selectedIndex: this.cameraIndex >= cameraList.length ? CameraIndexEnum.OrbitField : this.cameraIndex,
          fov: this.orbitFov
        });
      }
      startPx = null;
    });

    // Create coordinate groups
    this.wpilibCoordinateGroup = new THREE.Group();
    this.scene.add(this.wpilibCoordinateGroup);
    this.wpilibCoordinateGroup.rotation.setFromQuaternion(this.WPILIB_ROTATION);
    this.wpilibFieldCoordinateGroup = new THREE.Group();
    this.wpilibCoordinateGroup.add(this.wpilibFieldCoordinateGroup);

    // Create camera
    {
      const aspect = 2;
      const near = 0.15;
      const far = 1000;
      this.camera = new THREE.PerspectiveCamera(this.orbitFov, aspect, near, far);
    }

    // Create controls
    {
      this.controls = new OrbitControls(this.camera, canvas);
      this.controls.maxDistance = 250;
      this.controls.enabled = true;
      this.controls.update();
    }

    // Add lights
    {
      const light = new THREE.HemisphereLight(0xffffff, 0x444444, mode === "cinematic" ? 0.5 : 2);
      this.scene.add(light);
    }
    if (mode !== "cinematic") {
      const light = new THREE.PointLight(0xffffff, 0.5);
      light.position.set(0, 0, 10);
      this.wpilibCoordinateGroup.add(light);
    } else {
      [
        [0, 1, 0, -2],
        [6, -3, 6, 2],
        [-6, -3, -6, 2]
      ].forEach(([x, y, targetX, targetY]) => {
        const light = new THREE.SpotLight(0xffffff, 150, 0, 50 * (Math.PI / 180), 0.2, 2);
        light.position.set(x, y, 8);
        light.target.position.set(targetX, targetY, 0);
        light.castShadow = true;
        light.shadow.mapSize.width = 2048;
        light.shadow.mapSize.height = 2048;
        light.shadow.bias = -0.0001;
        this.wpilibCoordinateGroup.add(light, light.target);
      });
      {
        const light = new THREE.PointLight(0xff0000, 60);
        light.position.set(4.5, 0, 5);
        this.wpilibCoordinateGroup.add(light);
      }
      {
        const light = new THREE.PointLight(0x0000ff, 60);
        light.position.set(-4.5, 0, 5);
        this.wpilibCoordinateGroup.add(light);
      }
    }

    // Create fixed camera objects
    {
      this.fixedCameraObj = new THREE.Object3D();
      this.primaryRobotGroup = new THREE.Group().add(this.fixedCameraObj);
      this.primaryRobotGroup.visible = false;
      this.fixedCameraOverrideObj = new THREE.Object3D();
      this.fixedCameraOverrideObj.visible = false;
      this.wpilibFieldCoordinateGroup.add(this.primaryRobotGroup, this.fixedCameraOverrideObj);
    }

    // Create DS camera object
    {
      this.dsCameraObj = new THREE.Object3D();
      this.dsCameraObj.position.set(-this.DS_CAMERA_OFFSET, 0.0, this.DS_CAMERA_HEIGHT);
      this.dsCameraGroup = new THREE.Group().add(this.dsCameraObj);
      this.wpilibCoordinateGroup.add(this.dsCameraGroup);
    }

    // Render when camera is moved
    this.controls.addEventListener("change", () => (this.shouldRender = true));
  }

  saveState(): unknown {
    return {
      cameraIndex: this.cameraIndex,
      orbitFov: this.orbitFov,
      cameraPosition: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      cameraTarget: [this.controls.target.x, this.controls.target.y, this.controls.target.z]
    };
  }

  restoreState(state: unknown) {
    if (typeof state !== "object" || state === null) return;
    if ("cameraIndex" in state && typeof state.cameraIndex === "number") {
      this.cameraIndex = state.cameraIndex;
    }
    if ("orbitFov" in state && typeof state.orbitFov === "number") {
      this.orbitFov = state.orbitFov;
    }
    if (
      "cameraPosition" in state &&
      checkArrayType(state.cameraPosition, "number") &&
      (state.cameraPosition as number[]).length === 3
    ) {
      this.camera.position.set(...(state.cameraPosition as [number, number, number]));
    }
    if (
      "cameraTarget" in state &&
      checkArrayType(state.cameraTarget, "number") &&
      (state.cameraTarget as number[]).length === 3
    ) {
      this.controls.target.set(...(state.cameraTarget as [number, number, number]));
    }
    this.controls.update();
    this.lastCameraIndex = this.cameraIndex; // Don't reset camera position
    this.shouldResetCamera = false;
    this.shouldRender = true;
  }

  /** Switches the selected camera. */
  set3DCamera(index: number) {
    this.cameraIndex = index;
    this.shouldRender = true;
  }

  /** Updates the orbit FOV. */
  setFov(fov: number) {
    this.orbitFov = clampValue(fov, this.MIN_ORBIT_FOV, this.MAX_ORBIT_FOV);
    this.shouldRender = true;
  }

  stop() {}

  /** Resets the camera position and controls target. */
  private resetCamera(command: ThreeDimensionRendererCommand) {
    if (this.cameraIndex === -1) {
      // Orbit field
      if (command && command.game === "Axes") {
        this.camera.position.copy(this.ORBIT_AXES_DEFAULT_POSITION);
        this.controls.target.copy(this.ORBIT_AXES_DEFAULT_TARGET);
      } else {
        this.camera.position.copy(this.ORBIT_FIELD_DEFAULT_POSITION);
        this.controls.target.copy(this.ORBIT_FIELD_DEFAULT_TARGET);
      }
    } else if (this.cameraIndex === -2) {
      // Orbit robot
      this.camera.position.copy(this.ORBIT_ROBOT_DEFAULT_POSITION);
      this.controls.target.copy(this.ORBIT_ROBOT_DEFAULT_TARGET);
    } else {
      // Driver Station
      let fieldConfig = this.getFieldConfig(command);
      if (fieldConfig !== null) {
        let driverStation = -1;
        if (this.cameraIndex < -3) {
          driverStation = -4 - this.cameraIndex;
        } else {
          driverStation = command.autoDriverStation;
        }
        if (driverStation >= 0) {
          let position = fieldConfig.driverStations[driverStation];
          this.dsCameraGroup.position.set(position[0], position[1], 0);
          this.dsCameraGroup.rotation.set(0, 0, Math.atan2(-position[1], -position[0]));
          this.camera.position.copy(this.dsCameraObj.getWorldPosition(new THREE.Vector3()));
          this.camera.rotation.setFromQuaternion(this.dsCameraObj.getWorldQuaternion(new THREE.Quaternion()));
          this.controls.target.copy(this.ORBIT_FIELD_DEFAULT_TARGET); // Look at the center of the field
        }
      }
    }
    this.controls.update();
  }

  private getFieldConfig(command: ThreeDimensionRendererCommand): Config3dField | null {
    let fieldTitle = command.game;
    if (fieldTitle === "Evergreen") {
      return {
        name: "Evergreen",
        path: "",
        rotations: [],
        widthInches: convert(STANDARD_FIELD_LENGTH, "meters", "inches"),
        heightInches: convert(STANDARD_FIELD_WIDTH, "meters", "inches"),
        defaultOrigin: "auto",
        driverStations: DEFAULT_DRIVER_STATIONS,
        gamePieces: []
      };
    } else if (fieldTitle === "Axes") {
      return {
        name: "Axes",
        path: "",
        rotations: [],
        widthInches: convert(STANDARD_FIELD_LENGTH, "meters", "inches"),
        heightInches: convert(STANDARD_FIELD_WIDTH, "meters", "inches"),
        defaultOrigin: "blue",
        driverStations: DEFAULT_DRIVER_STATIONS,
        gamePieces: []
      };
    } else {
      let fieldConfig = window.assets?.field3ds.find((fieldData) => fieldData.name === fieldTitle);
      if (fieldConfig === undefined) return null;
      return fieldConfig;
    }
  }

  /** Make a new object manager for the provided type. */
  private makeObjectManager(
    type: ThreeDimensionRendererCommand_AnyObj["type"]
  ): ObjectManager<ThreeDimensionRendererCommand_AnyObj> {
    let args = [
      this.wpilibFieldCoordinateGroup,
      this.MATERIAL_SPECULAR,
      this.MATERIAL_SHININESS,
      this.mode,
      () => (this.shouldRender = true)
    ] as const;
    let manager: ObjectManager<ThreeDimensionRendererCommand_AnyObj>;
    switch (type) {
      case "robot":
      case "ghost":
        manager = new RobotManager(...args);
        break;
      case "gamePiece":
        manager = new GamePieceManager(...args, this.fieldPieces);
        break;
      case "trajectory":
        manager = new TrajectoryManager(...args);
        break;
      case "heatmap":
        manager = new HeatmapManager(...args, () => this.fieldConfigCache);
        break;
      case "aprilTag":
        manager = new AprilTagManager(...args);
        break;
      case "axes":
        manager = new AxesManager(...args);
        break;
      case "cone":
        manager = new ConeManager(...args);
        break;
      case "zebra":
        manager = new ZebraManager(...args);
        break;
    }
    manager.setResolution(this.resolutionVector);
    return manager;
  }

  render(command: ThreeDimensionRendererCommand): void {
    // Check for new parameters
    let commandString = JSON.stringify(command);
    let assetsString = JSON.stringify(window.assets);
    let isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    let newAssets = assetsString !== this.lastAssetsString;
    if (
      this.renderer.domElement.clientWidth !== this.lastWidth ||
      this.renderer.domElement.clientHeight !== this.lastHeight ||
      window.devicePixelRatio !== this.lastDevicePixelRatio ||
      isDark !== this.lastIsDark ||
      command.game !== this.lastFieldTitle ||
      commandString !== this.lastCommandString ||
      newAssets
    ) {
      this.lastWidth = this.renderer.domElement.clientWidth;
      this.lastHeight = this.renderer.domElement.clientHeight;
      this.lastDevicePixelRatio = window.devicePixelRatio;
      this.lastIsDark = isDark;
      this.lastCommandString = commandString;
      this.lastAssetsString = assetsString;
      this.shouldRender = true;
    }

    // Exit if not visible
    if (this.canvas.getBoundingClientRect().width === 0) {
      return; // Continue trying to render
    }

    // Limit FPS in low power mode
    let now = new Date().getTime();
    if (this.mode === "low-power" && now - this.lastFrameTime < 1000 / this.LOWER_POWER_MAX_FPS) {
      return; // Continue trying to render
    }

    // Check if rendering should continue
    if (!this.shouldRender) {
      return;
    }
    this.lastFrameTime = now;
    this.shouldRender = false;

    // Get field config
    let fieldTitle = command.game;
    let fieldConfigTmp = this.getFieldConfig(command);
    this.fieldConfigCache = fieldConfigTmp;
    if (fieldConfigTmp === null) return;
    let fieldConfig = fieldConfigTmp;

    // Reset camera on first render
    if (this.shouldResetCamera) {
      this.resetCamera(command);
      this.shouldResetCamera = false;
    }

    // Update field coordinates
    if (fieldConfig) {
      let isBlue = command.origin === "blue";
      this.wpilibFieldCoordinateGroup.setRotationFromAxisAngle(new THREE.Vector3(0, 0, 1), isBlue ? 0 : Math.PI);
      this.wpilibFieldCoordinateGroup.position.set(
        convert(fieldConfig.widthInches / 2, "inches", "meters") * (isBlue ? -1 : 1),
        convert(fieldConfig.heightInches / 2, "inches", "meters") * (isBlue ? -1 : 1),
        0
      );
    }

    // Update field
    if (fieldTitle !== this.lastFieldTitle || newAssets) {
      let oldField = this.field;
      let oldFieldStagedPieces = this.fieldStagedPieces;
      let newFieldPieces: typeof this.fieldPieces = {};
      let newFieldReady = () => {
        // Remove old field
        if (oldField) {
          this.wpilibCoordinateGroup.remove(oldField);
          disposeObject(oldField);
        }
        if (oldFieldStagedPieces) {
          this.wpilibCoordinateGroup.remove(oldFieldStagedPieces);
          disposeObject(oldFieldStagedPieces);
        }

        // Add new field
        if (this.field) {
          this.wpilibCoordinateGroup.add(this.field);
          if (this.fieldStagedPieces !== null) this.wpilibCoordinateGroup.add(this.fieldStagedPieces);
        }

        // Reset game piece objects
        this.objectManagers.filter((entry) => entry.type === "gamePiece").forEach((entry) => entry.manager.dispose());
        this.objectManagers = this.objectManagers.filter((entry) => entry.type !== "gamePiece");
        Object.values(this.fieldPieces).forEach((mesh) => {
          disposeObject(mesh);
        });
        this.fieldPieces = newFieldPieces;

        this.shouldRender = true;
      };

      // Reset camera if switching between axis and non-axis or if using DS camera
      if (
        ((fieldTitle === "Axes") !== (this.lastFieldTitle === "Axes") && this.lastFieldTitle !== "") ||
        this.cameraIndex < -2
      ) {
        this.resetCamera(command);
      }
      this.lastFieldTitle = fieldTitle;

      // Load new field
      if (fieldTitle === "Evergreen") {
        this.field = makeEvergreenField(this.MATERIAL_SPECULAR, this.MATERIAL_SHININESS);
        this.fieldStagedPieces = new THREE.Object3D();
        newFieldReady();
      } else if (fieldTitle === "Axes") {
        this.field = makeAxesField(this.MATERIAL_SPECULAR, this.MATERIAL_SHININESS);
        this.fieldStagedPieces = new THREE.Object3D();
        newFieldReady();
      } else {
        const loader = new GLTFLoader();
        Promise.all([
          new Promise((resolve) => {
            loader.load(fieldConfig.path, resolve);
          }),
          ...fieldConfig.gamePieces.map(
            (_, index) =>
              new Promise((resolve) => {
                loader.load(fieldConfig.path.slice(0, -4) + "_" + index.toString() + ".glb", resolve);
              })
          )
        ]).then(async (gltfs) => {
          let gltfScenes = (gltfs as GLTF[]).map((gltf) => gltf.scene);
          if (fieldConfig === undefined) return;
          let loadCount = 0;

          console.log("Starting export");
          let exporter = new USDZExporter();
          let allMeshes: THREE.Mesh[] = [];
          gltfScenes[0].traverse((object) => {
            let mesh = object as THREE.Mesh;
            if (mesh.isMesh) {
              allMeshes.push(mesh);
            }
          });
          allMeshes.forEach((mesh) => {
            let geometry = mesh.geometry;
            let vertices: THREE.Vector3[] = [];
            let center = new THREE.Vector3();
            for (let i = 0; i < geometry.attributes.position.count; i++) {
              let vertex = new THREE.Vector3(
                geometry.attributes.position.getX(i),
                geometry.attributes.position.getY(i),
                geometry.attributes.position.getZ(i)
              );
              vertices.push(vertex);
              center.add(vertex);
            }
            center.divideScalar(vertices.length);
            let maxDistance = vertices.reduce((prev, vertex) => {
              let dist = vertex.distanceTo(center);
              return dist > prev ? dist : prev;
            }, 0);
            if (maxDistance < 0.12) {
              mesh.removeFromParent();
            }
          });
          exporter
            .parseAsync(gltfScenes[0])
            .then((usdz) => {
              console.log("Finished export");
              window.sendMainMessage("write-export", {
                path: "/Users/jonah/Downloads/export.usd",
                content: usdz
              });
            })
            .catch((error) => {
              console.log(error);
            });
          return;

          gltfScenes.forEach(async (scene, index) => {
            // Add to scene
            if (index === 0) {
              let stagedPieces = new THREE.Group();
              fieldConfig.gamePieces.forEach((gamePieceConfig) => {
                gamePieceConfig.stagedObjects.forEach((stagedName) => {
                  let stagedObject = scene.getObjectByName(stagedName);
                  if (stagedObject !== undefined) {
                    let rotation = stagedObject.getWorldQuaternion(new THREE.Quaternion());
                    let position = stagedObject.getWorldPosition(new THREE.Vector3());
                    stagedObject.removeFromParent();
                    stagedObject.rotation.setFromQuaternion(rotation);
                    stagedObject.position.copy(position);
                    stagedPieces.add(stagedObject);
                  }
                });
              });

              let fieldStagedPiecesMeshes = await optimizeGeometries(
                stagedPieces,
                this.mode,
                this.MATERIAL_SPECULAR,
                this.MATERIAL_SHININESS,
                false
              );
              this.fieldStagedPieces = new THREE.Group();
              if (fieldStagedPiecesMeshes.normal !== null) this.fieldStagedPieces.add(fieldStagedPiecesMeshes.normal);
              if (fieldStagedPiecesMeshes.transparent !== null)
                this.fieldStagedPieces.add(fieldStagedPiecesMeshes.transparent);
              if (fieldStagedPiecesMeshes.carpet !== null) this.fieldStagedPieces.add(fieldStagedPiecesMeshes.carpet);
              this.fieldStagedPieces.rotation.setFromQuaternion(getQuaternionFromRotSeq(fieldConfig.rotations));

              let fieldMeshes = await optimizeGeometries(
                scene,
                this.mode,
                this.MATERIAL_SPECULAR,
                this.MATERIAL_SHININESS
              );
              this.field = new THREE.Group();
              if (fieldMeshes.normal !== null) this.field.add(fieldMeshes.normal);
              if (fieldMeshes.transparent !== null) this.field.add(fieldMeshes.transparent);
              if (fieldMeshes.carpet !== null) this.field.add(fieldMeshes.carpet);
              this.field.rotation.setFromQuaternion(getQuaternionFromRotSeq(fieldConfig.rotations));
            } else {
              let gamePieceConfig = fieldConfig.gamePieces[index - 1];
              scene.rotation.setFromQuaternion(getQuaternionFromRotSeq(gamePieceConfig.rotations));
              scene.position.set(...gamePieceConfig.position);
              let mesh = (
                await optimizeGeometries(scene, this.mode, this.MATERIAL_SPECULAR, this.MATERIAL_SHININESS, false)
              ).normal;
              if (mesh !== null) {
                newFieldPieces[gamePieceConfig.name] = mesh;
              }
            }

            if (++loadCount === gltfScenes.length) {
              newFieldReady();
            }
          });
        });
      }
    }

    // Update primary robot
    let robotObjects = command.objects.filter(
      (object) => object.type === "robot"
    ) as ThreeDimensionRendererCommand_RobotObj[];
    this.primaryRobotGroup.visible = false;
    if (robotObjects.length > 0) {
      this.primaryRobotModel = robotObjects[0].model;
      if (robotObjects[0].poses.length > 0) {
        let pose = robotObjects[0].poses[0].pose;
        this.primaryRobotGroup.position.set(...pose.translation);
        this.primaryRobotGroup.rotation.setFromQuaternion(rotation3dToQuaternion(pose.rotation));
        this.primaryRobotGroup.visible = true;
      }
    }

    // Update camera override
    this.fixedCameraOverrideObj.visible = command.cameraOverride !== null;
    if (command.cameraOverride !== null) {
      let pose = command.cameraOverride.pose;
      this.primaryRobotGroup.position.set(...pose.translation);
      this.primaryRobotGroup.rotation.setFromQuaternion(rotation3dToQuaternion(pose.rotation));
    }

    // Update staged game pieces
    if (this.fieldStagedPieces !== null) {
      this.fieldStagedPieces.visible = command.objects.every((object) => object.type !== "gamePiece");
    }

    // Update object managers
    this.objectManagers.forEach((entry) => (entry.active = false));
    command.objects.forEach((object) => {
      let entry = this.objectManagers.find((entry) => !entry.active && entry.type === object.type);
      if (entry === undefined) {
        entry = {
          type: object.type,
          manager: this.makeObjectManager(object.type),
          active: true
        };
        this.objectManagers.push(entry);
      } else {
        entry.active = true;
      }
      if (newAssets && (entry.type === "robot" || entry.type === "ghost")) {
        (entry.manager as RobotManager).newAssets();
      }
      entry.manager.setObjectData(object);
    });
    this.objectManagers
      .filter((entry) => !entry.active)
      .forEach((entry) => {
        entry.manager.dispose();
      });
    this.objectManagers = this.objectManagers.filter((entry) => entry.active);

    // Set camera for fixed views
    {
      // Reset camera index if invalid
      let robotConfig = window.assets?.robots.find((robotData) => robotData.name === this.primaryRobotModel);
      if (robotConfig !== undefined && this.cameraIndex >= robotConfig.cameras.length)
        this.cameraIndex = CameraIndexEnum.OrbitField;

      // Update camera controls
      let orbitalCamera =
        this.cameraIndex === CameraIndexEnum.OrbitField || this.cameraIndex === CameraIndexEnum.OrbitRobot;
      let dsCamera = this.cameraIndex < CameraIndexEnum.OrbitRobot;
      if (orbitalCamera !== this.controls.enabled) {
        this.controls.enabled = orbitalCamera;
        this.controls.update();
      }

      // Update container and camera based on mode
      let fov = this.orbitFov;
      if (orbitalCamera || dsCamera) {
        this.canvas.classList.remove("fixed");
        this.annotationsDiv.classList.remove("fixed");
        this.canvas.style.width = "";
        this.canvas.style.height = "";
        this.annotationsDiv.style.width = "";
        this.annotationsDiv.style.height = "";
        if (this.cameraIndex === CameraIndexEnum.OrbitField || dsCamera) {
          // Reset to default origin
          this.wpilibCoordinateGroup.position.set(0, 0, 0);
          this.wpilibCoordinateGroup.rotation.setFromQuaternion(this.WPILIB_ROTATION);
        } else if (this.primaryRobotGroup.visible) {
          // Shift based on robot location
          this.wpilibCoordinateGroup.position.set(0, 0, 0);
          this.wpilibCoordinateGroup.rotation.setFromQuaternion(new THREE.Quaternion());
          let position = this.primaryRobotGroup.getWorldPosition(new THREE.Vector3());
          let rotation = this.primaryRobotGroup
            .getWorldQuaternion(new THREE.Quaternion())
            .multiply(this.WPILIB_ROTATION);
          position.negate();
          rotation.invert();
          this.wpilibCoordinateGroup.position.copy(position.clone().applyQuaternion(rotation));
          this.wpilibCoordinateGroup.rotation.setFromQuaternion(rotation);
        }
        if (
          this.cameraIndex !== this.lastCameraIndex ||
          (this.cameraIndex === CameraIndexEnum.DSAuto && this.lastAutoDriverStation !== command.autoDriverStation)
        ) {
          this.resetCamera(command);
        }
      } else {
        this.canvas.classList.add("fixed");
        this.annotationsDiv.classList.add("fixed");
        let aspectRatio = 16 / 9;
        if (robotConfig) {
          // Get fixed aspect ratio and FOV
          let cameraConfig = robotConfig.cameras[this.cameraIndex];
          aspectRatio = cameraConfig.resolution[0] / cameraConfig.resolution[1];
          fov = cameraConfig.fov / aspectRatio;
          let parentAspectRatio = this.canvas.parentElement
            ? this.canvas.parentElement.clientWidth / this.canvas.parentElement.clientHeight
            : aspectRatio;
          if (aspectRatio > parentAspectRatio) {
            this.canvas.style.width = "100%";
            this.canvas.style.height = ((parentAspectRatio / aspectRatio) * 100).toString() + "%";
            this.annotationsDiv.style.width = "100%";
            this.annotationsDiv.style.height = ((parentAspectRatio / aspectRatio) * 100).toString() + "%";
          } else {
            this.canvas.style.width = ((aspectRatio / parentAspectRatio) * 100).toString() + "%";
            this.canvas.style.height = "100%";
            this.annotationsDiv.style.width = ((aspectRatio / parentAspectRatio) * 100).toString() + "%";
            this.annotationsDiv.style.height = "100%";
          }

          // Update camera position
          let referenceObj: THREE.Object3D | null = null;
          if (this.fixedCameraOverrideObj.visible) {
            referenceObj = this.fixedCameraOverrideObj;
          } else if (this.primaryRobotGroup.visible) {
            this.fixedCameraObj.position.set(...cameraConfig.position);
            this.fixedCameraObj.rotation.setFromQuaternion(
              getQuaternionFromRotSeq(cameraConfig.rotations).multiply(this.CAMERA_ROTATION)
            );
            referenceObj = this.fixedCameraObj;
          }
          if (referenceObj) {
            this.camera.position.copy(referenceObj.getWorldPosition(new THREE.Vector3()));
            this.camera.rotation.setFromQuaternion(referenceObj.getWorldQuaternion(new THREE.Quaternion()));
          }
        }
      }

      // Update camera alert
      if (this.cameraIndex === CameraIndexEnum.OrbitRobot) {
        this.alert.hidden = this.primaryRobotGroup.visible;
        this.alert.innerHTML = 'Robot pose not available</br>for camera "Orbit Robot".';
      } else if (this.cameraIndex === CameraIndexEnum.DSAuto) {
        this.alert.hidden = command.autoDriverStation >= 0;
        this.alert.innerHTML = "Driver Station position</br>not available.";
      } else if (this.cameraIndex === CameraIndexEnum.OrbitField || dsCamera) {
        this.alert.hidden = true;
      } else {
        this.alert.hidden = this.primaryRobotGroup.visible || this.fixedCameraOverrideObj.visible;
        this.alert.innerHTML =
          'Robot pose not available</br>for camera "' +
          (robotConfig ? robotConfig.cameras[this.cameraIndex].name : "???") +
          '".';
      }

      // Update camera FOV
      if (fov !== this.camera.fov) {
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();
      }

      this.lastCameraIndex = this.cameraIndex;
      this.lastAutoDriverStation = command.autoDriverStation;
    }

    // Render new frame
    const devicePixelRatio = window.devicePixelRatio * (this.mode === "low-power" ? 0.75 : 1);
    const canvas = this.renderer.domElement;
    const clientWidth = canvas.clientWidth;
    const clientHeight = canvas.clientHeight;
    if (canvas.width / devicePixelRatio !== clientWidth || canvas.height / devicePixelRatio !== clientHeight) {
      this.renderer.setSize(clientWidth, clientHeight, false);
      this.cssRenderer.setSize(clientWidth, clientHeight);
      this.camera.aspect = clientWidth / clientHeight;
      this.camera.updateProjectionMatrix();
      this.resolutionVector.set(clientWidth, clientHeight);
      this.objectManagers.forEach((entry) => {
        entry.manager.setResolution(this.resolutionVector);
      });
    }
    this.scene.background = isDark ? new THREE.Color("#222222") : new THREE.Color("#ffffff");
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.render(this.scene, this.camera);
    this.cssRenderer.render(this.scene, this.camera);
  }
}

type CameraIndex = number | CameraIndexEnum;
enum CameraIndexEnum {
  OrbitField = -1,
  OrbitRobot = -2,
  DSAuto = -3,
  DSB1 = -4,
  DSB2 = -5,
  DSB3 = -6,
  DSR1 = -7,
  DSR2 = -8,
  DSR3 = -9
}

/** Converts a rotation sequence to a quaternion. */
export function getQuaternionFromRotSeq(rotations: Config3d_Rotation[]): THREE.Quaternion {
  let quaternion = new THREE.Quaternion();
  rotations.forEach((rotation) => {
    let axis = new THREE.Vector3(0, 0, 0);
    if (rotation.axis === "x") axis.setX(1);
    if (rotation.axis === "y") axis.setY(1);
    if (rotation.axis === "z") axis.setZ(1);
    quaternion.premultiply(
      new THREE.Quaternion().setFromAxisAngle(axis, convert(rotation.degrees, "degrees", "radians"))
    );
  });
  return quaternion;
}

/** Disposes of all materials and geometries in object. */
export function disposeObject(object: THREE.Object3D) {
  object.traverse((node) => {
    let mesh = node as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((material) => material.dispose());
      } else {
        mesh.material.dispose();
      }
    }
  });
}

export function rotation3dToQuaternion(input: Rotation3d): THREE.Quaternion {
  return new THREE.Quaternion(input[1], input[2], input[3], input[0]);
}

export function quaternionToRotation3d(input: THREE.Quaternion): Rotation3d {
  return [input.w, input.x, input.y, input.z];
}
