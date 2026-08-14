// Name: TMPose
// ID: tmpose
// Description: Use Teachable Machine Pose models for camera-based pose recognition in TurboWarp.
// By: Hiroya Kubo
// License: MPL-2.0

(function (Scratch) {
  'use strict';

  const extensionName = "TMPose";
  const blocks = [{ "opcode": "versionReporter", "blockType": "REPORTER", "text": "TMPose version", "description": "Returns the extension version." }, { "opcode": "setModelURL", "blockType": "COMMAND", "text": "set model URL to [URL]", "description": "Sets the Teachable Machine Pose model URL.", "arguments": { "URL": { "type": "STRING", "defaultValue": "https://teachablemachine.withgoogle.com/models/XXXX/" } } }, { "opcode": "startCamera", "blockType": "COMMAND", "text": "start camera", "description": "Starts the camera and attaches the preview." }, { "opcode": "stopCamera", "blockType": "COMMAND", "text": "stop camera", "description": "Stops the camera and prediction loop." }, { "opcode": "isCameraRunning", "blockType": "BOOLEAN", "text": "camera is running?", "description": "Reports whether the camera is running." }, { "opcode": "refreshCameraList", "blockType": "COMMAND", "text": "refresh camera list", "description": "Refreshes the list of available video input devices." }, { "opcode": "setCameraSelection", "blockType": "COMMAND", "text": "set camera to [CAMERA]", "description": "Selects the default, front, back, or a detected camera and switches a running camera.", "arguments": { "CAMERA": { "type": "STRING", "menu": "cameraMenu", "defaultValue": "default" } } }, { "opcode": "cameraCountReporter", "blockType": "REPORTER", "text": "camera count", "description": "Returns the number of video input devices found by the latest refresh." }, { "opcode": "cameraDeviceIdReporter", "blockType": "REPORTER", "text": "camera device ID", "description": "Returns the active camera device ID when available." }, { "opcode": "cameraDeviceNameReporter", "blockType": "REPORTER", "text": "camera device name", "description": "Returns the active camera device name when available." }, { "opcode": "showPreview", "blockType": "COMMAND", "text": "show camera preview", "description": "Shows the camera preview." }, { "opcode": "hidePreview", "blockType": "COMMAND", "text": "hide camera preview", "description": "Hides the camera preview." }, { "opcode": "isPreviewVisible", "blockType": "BOOLEAN", "text": "camera preview is visible?", "description": "Reports whether the preview is configured as visible." }, { "opcode": "setPreviewOpacity", "blockType": "COMMAND", "text": "set camera preview opacity to [OPACITY]", "description": "Sets preview opacity from 0 to 1.", "arguments": { "OPACITY": { "type": "NUMBER", "defaultValue": 0.6 } } }, { "opcode": "setPreviewPosition", "blockType": "COMMAND", "text": "set camera preview position to [POSITION]", "description": "Sets the preview position on the stage.", "arguments": { "POSITION": { "type": "STRING", "menu": "positionMenu", "defaultValue": "bottom-right" } } }, { "opcode": "setPreviewMirroring", "blockType": "COMMAND", "text": "set camera preview to [MIRRORING]", "description": "Sets whether the preview is mirrored without changing the recognition input.", "arguments": { "MIRRORING": { "type": "STRING", "menu": "previewMirroringMenu", "defaultValue": "mirrored" } } }, { "opcode": "previewMirroringReporter", "blockType": "REPORTER", "text": "camera preview mirroring", "description": "Returns mirrored or unmirrored for the current preview setting." }, { "opcode": "loadModel", "blockType": "COMMAND", "text": "load model", "description": "Loads the configured pose model." }, { "opcode": "isModelLoaded", "blockType": "BOOLEAN", "text": "model is loaded?", "description": "Reports whether the model is loaded." }, { "opcode": "startPredict", "blockType": "COMMAND", "text": "start recognition", "description": "Starts pose recognition." }, { "opcode": "stopPredict", "blockType": "COMMAND", "text": "stop recognition", "description": "Stops pose recognition." }, { "opcode": "isPredicting", "blockType": "BOOLEAN", "text": "recognition is running?", "description": "Reports whether recognition is running." }, { "opcode": "currentPoseReporter", "blockType": "REPORTER", "text": "current pose", "description": "Returns the highest-scoring pose label." }, { "opcode": "scoreReporter", "blockType": "REPORTER", "text": "confidence", "description": "Returns the confidence of the current pose." }, { "opcode": "poseScoreReporter", "blockType": "REPORTER", "text": "confidence of [NAME]", "description": "Returns the confidence for a named pose.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "jump" } } }, { "opcode": "setAccumulatedPoseParameters", "blockType": "COMMAND", "text": "set accumulated pose accumulation [ACCUMULATION] decay [DECAY]", "description": "Sets the accumulation rate per second and the decay retained per second; decay changes apply to the next recognition session.", "featureFlag": "temporalPoseScoring", "arguments": { "ACCUMULATION": { "type": "NUMBER", "defaultValue": 1 }, "DECAY": { "type": "NUMBER", "defaultValue": 0.9 } } }, { "opcode": "setAccumulatedPoseThreshold", "blockType": "COMMAND", "text": "set accumulated pose threshold [THRESHOLD]", "description": "Sets the minimum accumulated score required to report a pose; values below the threshold report an empty string.", "featureFlag": "temporalPoseScoring", "arguments": { "THRESHOLD": { "type": "NUMBER", "defaultValue": 0 } } }, { "opcode": "resetAccumulatedPose", "blockType": "COMMAND", "text": "reset accumulated pose scores", "description": "Clears all accumulated pose scores.", "featureFlag": "temporalPoseScoring" }, { "opcode": "accumulatedPoseReporter", "blockType": "REPORTER", "text": "accumulated pose", "description": "Returns the pose label whose accumulated score is highest and meets the threshold, or an empty string otherwise.", "featureFlag": "temporalPoseScoring" }, { "opcode": "accumulatedScoreReporter", "blockType": "REPORTER", "text": "accumulated score", "description": "Returns the highest accumulated pose score without rounding.", "featureFlag": "temporalPoseScoring" }, { "opcode": "accumulatedPoseScoreReporter", "blockType": "REPORTER", "text": "accumulated score of [NAME]", "description": "Returns the accumulated score for a named pose without rounding.", "featureFlag": "temporalPoseScoring", "arguments": { "NAME": { "type": "STRING", "defaultValue": "jump" } } }, { "opcode": "isPose", "blockType": "BOOLEAN", "text": "pose is [NAME]?", "description": "Reports whether the named pose has at least 0.75 confidence.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "jump" } } }, { "opcode": "isPoseWithThreshold", "blockType": "BOOLEAN", "text": "pose is [NAME] with confidence at least [THRESHOLD]?", "description": "Reports whether the named pose meets the given threshold.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "jump" }, "THRESHOLD": { "type": "NUMBER", "defaultValue": 0.75 } } }, { "opcode": "cameraMsReporter", "blockType": "REPORTER", "text": "camera startup time (ms)", "description": "Returns camera startup time in milliseconds." }, { "opcode": "modelLoadMsReporter", "blockType": "REPORTER", "text": "model load time (ms)", "description": "Returns model load time in milliseconds." }, { "opcode": "firstPredictMsReporter", "blockType": "REPORTER", "text": "first recognition time (ms)", "description": "Returns first prediction time in milliseconds." }, { "opcode": "lastErrorReporter", "blockType": "REPORTER", "text": "last error", "description": "Returns the latest recorded error message." }];
  const definitions = {
    extensionName,
    blocks
  };
  const FEATURE_FLAGS = {
    temporalPoseScoring: false,
    accumulatedPoseEvents: false
  };
  const version = "1.8.0";
  const packageMetadata = {
    version
  };
  const EXTENSION_ID = "tmpose";
  const VERSION = `${packageMetadata.version}-typescript`;
  const DOCS_URI = "https://kubohiroya.github.io/turbowarp-tmpose/";
  const ACCUMULATED_POSE_CHANGED_EVENT = "TMPOSE_ACCUMULATED_POSE_CHANGED";
  const BLOCK_ICON_URI = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21V8h13M43 8h13v13M8 43v13h13M43 56h13V43M32 25v15M20 31l12 5 12-5M32 40 23 52M32 40l9 12"/><circle cx="32" cy="18" r="5"/></g></svg>'
  )}`;
  const TFJS_URL = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@1.3.1/dist/tf.min.js";
  const TMPOSE_URL = "https://cdn.jsdelivr.net/npm/@teachablemachine/pose@0.8.3/dist/teachablemachine-pose.min.js";
  const POSITION_ITEMS = [
    { text: "top left", value: "top-left" },
    { text: "top right", value: "top-right" },
    { text: "bottom left", value: "bottom-left" },
    { text: "bottom right", value: "bottom-right" },
    { text: "center", value: "center" },
    { text: "full stage", value: "full-stage" }
  ];
  const POSITION_ALIASES = {
    左上: "top-left",
    右上: "top-right",
    左下: "bottom-left",
    右下: "bottom-right",
    中央: "center",
    ステージ全体: "full-stage",
    "top-left": "top-left",
    "top-right": "top-right",
    "bottom-left": "bottom-left",
    "bottom-right": "bottom-right",
    center: "center",
    "full-stage": "full-stage"
  };
  const PREVIEW_MIRRORING_ITEMS = [
    { text: "mirrored", value: "mirrored" },
    { text: "unmirrored", value: "unmirrored" }
  ];
  const PREVIEW_MIRRORING_ALIASES = {
    mirrored: true,
    unmirrored: false,
    mirror: true,
    normal: false,
    "左右反転": true,
    "そのまま": false
  };
  const CAMERA_SELECTION_ITEMS = [
    { text: "default camera", value: "default" },
    { text: "front camera", value: "front" },
    { text: "back camera", value: "back" }
  ];
  const CAMERA_SELECTION_ALIASES = {
    default: "default",
    front: "front",
    back: "back",
    user: "front",
    environment: "back",
    "既定": "default",
    "インカメラ": "front",
    "前面カメラ": "front",
    "背面カメラ": "back"
  };
  const loadingPromises = /* @__PURE__ */ new Map();
  function normalizePosition(value) {
    return POSITION_ALIASES[String(value ?? "bottom-right")] ?? "bottom-right";
  }
  function normalizePreviewMirroring(value) {
    return PREVIEW_MIRRORING_ALIASES[String(value ?? "mirrored").trim().toLowerCase()] ?? true;
  }
  function normalizeCameraSelection(value) {
    const selection = String(value ?? "default").trim();
    const normalized = CAMERA_SELECTION_ALIASES[selection.toLowerCase() || "default"];
    if (normalized === "default" || normalized === "front" || normalized === "back") {
      return { kind: "preference", value: normalized };
    }
    return { kind: "device", value: selection };
  }
  function cameraConstraints(selection) {
    if (selection.kind === "device") return { deviceId: { exact: selection.value } };
    if (selection.value === "front") return { facingMode: { ideal: "user" } };
    if (selection.value === "back") return { facingMode: { ideal: "environment" } };
    return void 0;
  }
  function scriptLoadedFor(src) {
    if (src === TFJS_URL) return typeof globalThis.tf !== "undefined";
    if (src === TMPOSE_URL) return typeof globalThis.tmPose !== "undefined";
    return false;
  }
  function loadScript(src) {
    if (scriptLoadedFor(src)) return Promise.resolve();
    const active = loadingPromises.get(src);
    if (active) return active;
    const existing = Array.from(document.scripts).find((script) => script.src === src);
    if (existing?.dataset.tmposeLoaded === "true") return Promise.resolve();
    const promise = new Promise((resolve, reject) => {
      const script = existing ?? document.createElement("script");
      const cleanup = () => {
        script.removeEventListener("load", handleLoad);
        script.removeEventListener("error", handleError);
      };
      const handleLoad = () => {
        cleanup();
        script.dataset.tmposeLoaded = "true";
        resolve();
      };
      const handleError = () => {
        cleanup();
        loadingPromises.delete(src);
        reject(new Error("TMPose: Failed to load script: " + src));
      };
      script.addEventListener("load", handleLoad, { once: true });
      script.addEventListener("error", handleError, { once: true });
      if (!existing) {
        script.src = src;
        document.head.appendChild(script);
      } else {
        queueMicrotask(() => {
          if (scriptLoadedFor(src)) handleLoad();
        });
      }
    });
    loadingPromises.set(src, promise);
    return promise;
  }
  function rectanglesIntersect(left, right) {
    return left.right > right.left && left.left < right.right && left.bottom > right.top && left.top < right.bottom;
  }
  function canvasScore(width, height) {
    if (width <= 0 || height <= 0) return Number.NEGATIVE_INFINITY;
    const area = width * height;
    const aspectPenalty = Math.abs(width / height - 4 / 3);
    return area / (1 + aspectPenalty * 4);
  }
  function isDocumentHidden() {
    return typeof document !== "undefined" && document.visibilityState === "hidden";
  }
  class TMPoseExtension {
    constructor(featureFlags = {}, dependencies = {}) {
      this.featureFlags = { ...FEATURE_FLAGS, ...featureFlags };
      this.tmPoseRuntime = dependencies.runtime ?? null;
      this.allowRemoteLibraries = dependencies.allowRemoteLibraries ?? true;
      this.onAccumulatedPoseChanged = dependencies.onAccumulatedPoseChanged ?? null;
      this.modelURL = "";
      this.model = null;
      this.webcam = null;
      this.cameraRunning = false;
      this.cameraSelection = "default";
      this.cameraSelectionIsDeviceId = false;
      this.cameraDevices = [];
      this.activeCameraDeviceId = "";
      this.activeCameraDeviceName = "";
      this.cameraSelectionQueue = Promise.resolve();
      this.predicting = false;
      this.loopStarted = false;
      this.loopGeneration = 0;
      this.activeModelOperations = /* @__PURE__ */ new Map();
      this.currentPoseName = "";
      this.score = 0;
      this.predictions = {};
      this.accumulationCoefficient = 1;
      this.decayCoefficient = 0.9;
      this.activeDecayCoefficient = 0.9;
      this.accumulatedPoseThreshold = 0;
      this.accumulatedPoseName = "";
      this.accumulatedScore = 0;
      this.accumulatedPredictions = {};
      this.lastAccumulationTime = null;
      this.previewOpacity = 0.6;
      this.previewPosition = "bottom-right";
      this.previewMirrored = true;
      this.previewVisible = true;
      this.previewCanvas = null;
      this.previewStageElement = null;
      this.cameraMs = 0;
      this.modelLoadMs = 0;
      this.firstPredictMs = 0;
      this.lastError = "";
      this.accumulatedPosePausedForBackground = isDocumentHidden();
      this.visibilityChangeListener = () => this.handleDocumentVisibilityChange();
      if (this.featureFlags.temporalPoseScoring && typeof document !== "undefined") {
        document.addEventListener("visibilitychange", this.visibilityChangeListener);
      }
    }
    getInfo() {
      return {
        id: EXTENSION_ID,
        name: Scratch.translate(definitions.extensionName),
        docsURI: DOCS_URI,
        blockIconURI: BLOCK_ICON_URI,
        blocks: definitions.blocks.filter((block) => !block.featureFlag || this.featureFlags[block.featureFlag]).map((block) => ({
          opcode: block.opcode,
          blockType: Scratch.BlockType[block.blockType],
          text: Scratch.translate(block.text),
          ...block.disableMonitor ? { disableMonitor: true } : {},
          ...block.arguments ? {
            arguments: Object.fromEntries(Object.entries(block.arguments).map(([name, argument]) => [
              name,
              {
                type: Scratch.ArgumentType[argument.type],
                defaultValue: argument.defaultValue,
                ...argument.menu ? { menu: argument.menu } : {}
              }
            ]))
          } : {}
        })),
        menus: {
          positionMenu: {
            acceptReporters: true,
            items: POSITION_ITEMS.map((item) => ({ text: Scratch.translate(item.text), value: item.value }))
          },
          previewMirroringMenu: {
            acceptReporters: true,
            items: PREVIEW_MIRRORING_ITEMS.map((item) => ({ text: Scratch.translate(item.text), value: item.value }))
          },
          cameraMenu: {
            acceptReporters: true,
            items: "getCameraMenuItems"
          }
        }
      };
    }
    versionReporter() {
      return VERSION;
    }
    setLastError(error) {
      this.lastError = String(error?.message ?? error);
    }
    setModelURL(args) {
      this.modelURL = String(args.URL || "").trim();
      if (this.modelURL && !this.modelURL.endsWith("/")) this.modelURL += "/";
      this.model = null;
      this.modelLoadMs = 0;
      this.firstPredictMs = 0;
    }
    async ensureLibrariesLoaded() {
      if (this.tmPoseRuntime) return;
      if (!this.allowRemoteLibraries) {
        throw new Error("TMPose: A preloaded Teachable Machine Pose runtime is required.");
      }
      if (typeof globalThis.tf === "undefined") await loadScript(TFJS_URL);
      if (typeof globalThis.tmPose === "undefined") await loadScript(TMPOSE_URL);
      if (typeof globalThis.tmPose === "undefined") {
        throw new Error("TMPose: Teachable Machine Pose could not be loaded.");
      }
      this.tmPoseRuntime = globalThis.tmPose;
    }
    cleanupCameraResources() {
      const video = this.webcam?.webcam;
      if (video?.srcObject) {
        video.srcObject.getTracks().forEach((track) => track.stop());
        video.srcObject = null;
      }
      this.previewCanvas?.parentNode?.removeChild(this.previewCanvas);
      this.previewCanvas = null;
      this.previewStageElement = null;
      this.webcam = null;
      this.cameraRunning = false;
      this.activeCameraDeviceId = "";
      this.activeCameraDeviceName = "";
      this.loopStarted = false;
      this.loopGeneration += 1;
    }
    async startCamera() {
      if (this.cameraRunning && this.webcam) {
        this.attachPreviewToStage();
        return;
      }
      try {
        this.lastError = "";
        const startedAt = performance.now();
        await this.ensureLibrariesLoaded();
        this.webcam = new this.tmPoseRuntime.Webcam(320, 240, true);
        const constraints = cameraConstraints(this.resolvedCameraSelection());
        if (constraints) await this.webcam.setup(constraints);
        else await this.webcam.setup();
        await this.webcam.play();
        this.attachPreviewToStage();
        this.cameraRunning = true;
        try {
          await this.refreshCameraDevices();
        } catch {
        }
        this.updateActiveCameraInfo();
        this.cameraMs = Math.round(performance.now() - startedAt);
        this.startLoopIfNeeded();
      } catch (error) {
        this.cleanupCameraResources();
        this.setLastError(error);
        throw error;
      }
    }
    stopCamera() {
      try {
        this.stopPredict();
        this.cleanupCameraResources();
        this.currentPoseName = "";
        this.score = 0;
        this.predictions = {};
      } catch (error) {
        this.setLastError(error);
        throw error;
      }
    }
    isCameraRunning() {
      return this.cameraRunning;
    }
    getCameraMenuItems() {
      const fixedItems = CAMERA_SELECTION_ITEMS.map((item) => ({
        text: Scratch.translate(item.text),
        value: item.value
      }));
      const seen = /* @__PURE__ */ new Set();
      const deviceItems = [];
      this.cameraDevices.forEach((device, index) => {
        if (!device.deviceId || seen.has(device.deviceId)) return;
        seen.add(device.deviceId);
        deviceItems.push({
          text: device.label || `${Scratch.translate("camera")} ${index + 1}`,
          value: device.deviceId
        });
      });
      return [...fixedItems, ...deviceItems];
    }
    async refreshCameraDevices() {
      const mediaDevices = typeof navigator === "undefined" ? void 0 : navigator.mediaDevices;
      if (!mediaDevices || typeof mediaDevices.enumerateDevices !== "function") {
        throw new Error("TMPose: Camera enumeration is not available in this browser.");
      }
      const devices = await mediaDevices.enumerateDevices();
      this.cameraDevices = devices.filter((device) => device.kind === "videoinput").map((device) => ({ deviceId: device.deviceId, label: device.label }));
      return this.cameraDevices;
    }
    async refreshCameraList() {
      try {
        this.lastError = "";
        await this.refreshCameraDevices();
        if (this.cameraRunning) this.updateActiveCameraInfo();
      } catch (error) {
        this.setLastError(error);
        throw error;
      }
    }
    setCameraSelection(args) {
      const selection = normalizeCameraSelection(args.CAMERA);
      return this.enqueueCameraSelection(selection);
    }
    setCameraDeviceId(deviceId) {
      if (typeof deviceId !== "string" || deviceId.trim().length === 0) {
        return Promise.reject(new Error("TMPose: Camera device ID must be a non-empty string."));
      }
      return this.enqueueCameraSelection({ kind: "device", value: deviceId });
    }
    resolvedCameraSelection() {
      return this.cameraSelectionIsDeviceId ? { kind: "device", value: this.cameraSelection } : { kind: "preference", value: this.cameraSelection };
    }
    enqueueCameraSelection(selection) {
      const operation = this.cameraSelectionQueue.then(() => this.applyCameraSelection(selection));
      this.cameraSelectionQueue = operation.catch(() => void 0);
      return operation;
    }
    async applyCameraSelection(selection) {
      const previousSelection = this.cameraSelection;
      const previousSelectionIsDeviceId = this.cameraSelectionIsDeviceId;
      const wasRunning = this.cameraRunning;
      this.cameraSelection = selection.value;
      this.cameraSelectionIsDeviceId = selection.kind === "device";
      if (!wasRunning) return;
      this.cleanupCameraResources();
      try {
        await this.startCamera();
      } catch (switchError) {
        this.cameraSelection = previousSelection;
        this.cameraSelectionIsDeviceId = previousSelectionIsDeviceId;
        try {
          await this.startCamera();
        } catch (rollbackError) {
          const error = new AggregateError(
            [switchError, rollbackError],
            "TMPose: Camera switch and rollback both failed."
          );
          this.setLastError(error);
          throw error;
        }
        this.setLastError(switchError);
        throw switchError;
      }
    }
    updateActiveCameraInfo() {
      const stream = this.webcam?.webcam?.srcObject;
      const videoTrack = stream?.getVideoTracks?.()[0] ?? stream?.getTracks?.().find((track) => track.kind === "video" || track.kind === void 0);
      const settings = videoTrack?.getSettings?.() ?? {};
      const selectedDeviceId = this.cameraSelectionIsDeviceId ? this.cameraSelection : "";
      this.activeCameraDeviceId = String(settings.deviceId || selectedDeviceId);
      const device = this.cameraDevices.find((candidate) => candidate.deviceId === this.activeCameraDeviceId);
      this.activeCameraDeviceName = String(videoTrack?.label || device?.label || "");
    }
    cameraCountReporter() {
      return this.cameraDevices.length;
    }
    cameraDeviceIdReporter() {
      return this.activeCameraDeviceId;
    }
    cameraDeviceNameReporter() {
      return this.activeCameraDeviceName;
    }
    showPreview() {
      try {
        this.previewVisible = true;
        if (!this.webcam?.canvas) throw new Error("TMPose: Start the camera before showing the preview.");
        this.attachPreviewToStage();
        this.previewCanvas.style.display = "block";
        this.validatePreviewAttachment(this.previewStageElement, this.previewCanvas);
      } catch (error) {
        this.setLastError(error);
        throw error;
      }
    }
    hidePreview() {
      this.previewVisible = false;
      if (this.previewCanvas) this.previewCanvas.style.display = "none";
    }
    isPreviewVisible() {
      return this.previewVisible;
    }
    setPreviewOpacity(args) {
      let opacity = args.OPACITY === "" ? 0.6 : Number(args.OPACITY);
      if (Number.isNaN(opacity)) opacity = 0.6;
      this.previewOpacity = Math.max(0, Math.min(1, opacity));
      if (this.previewCanvas) this.previewCanvas.style.opacity = String(this.previewOpacity);
    }
    setPreviewPosition(args) {
      this.previewPosition = normalizePosition(args.POSITION);
      if (this.previewCanvas) {
        this.updatePreviewStyle();
        this.validatePreviewAttachment(this.previewStageElement, this.previewCanvas);
      }
    }
    setPreviewMirroring(args) {
      this.previewMirrored = normalizePreviewMirroring(args.MIRRORING);
      if (this.previewCanvas) this.updatePreviewStyle();
    }
    previewMirroringReporter() {
      return this.previewMirrored ? "mirrored" : "unmirrored";
    }
    async loadModel() {
      if (this.model) return;
      if (!this.modelURL) throw new Error("TMPose: Set the model URL first.");
      try {
        this.lastError = "";
        const startedAt = performance.now();
        await this.ensureLibrariesLoaded();
        if (typeof this.tmPoseRuntime.load !== "function") {
          throw new Error("TMPose: The Teachable Machine Pose URL loader is not available.");
        }
        this.model = await this.tmPoseRuntime.load(
          this.modelURL + "model.json",
          this.modelURL + "metadata.json"
        );
        this.modelLoadMs = Math.round(performance.now() - startedAt);
      } catch (error) {
        this.setLastError(error);
        throw error;
      }
    }
    isModelLoaded() {
      return Boolean(this.model);
    }
    usePreparedModel(model) {
      if (!model || typeof model !== "object") {
        throw new TypeError("TMPose: Prepared model must be an object.");
      }
      if (this.predicting && this.model !== model) {
        throw new Error("TMPose: Stop recognition before changing the active model.");
      }
      this.model = model;
      this.modelURL = "";
      this.modelLoadMs = 0;
      this.firstPredictMs = 0;
    }
    clearPreparedModel(model) {
      if (model !== void 0 && this.model !== model) return;
      this.stopPredict();
      this.model = null;
      this.modelURL = "";
      this.modelLoadMs = 0;
      this.firstPredictMs = 0;
    }
    async startPredict() {
      try {
        this.lastError = "";
        const startingNewSession = !this.predicting;
        if (!this.cameraRunning) await this.startCamera();
        await this.loadModel();
        if (startingNewSession && this.featureFlags.temporalPoseScoring) {
          this.startAccumulatedPoseSession();
        }
        this.predicting = true;
        this.startLoopIfNeeded();
      } catch (error) {
        this.setLastError(error);
        throw error;
      }
    }
    stopPredict() {
      this.predicting = false;
      this.currentPoseName = "";
      this.score = 0;
      this.predictions = {};
      this.resetAccumulatedPose("stop");
    }
    isPredicting() {
      return this.predicting;
    }
    findStageElement() {
      try {
        const stageCanvas = this.findLikelyStageCanvas();
        if (stageCanvas.parentElement) return stageCanvas.parentElement;
      } catch {
      }
      const editorStage = document.querySelector(".stage_stage-wrapper_2bejr") || document.querySelector('[class*="stage_stage-wrapper"]') || document.querySelector('[class*="stage-wrapper"]') || document.querySelector('[class*="stage-wrapper_stage-wrapper"]');
      if (editorStage) return editorStage;
      throw new Error("TMPose: TurboWarp stage element was not found.");
    }
    findLikelyStageCanvas() {
      const webcamCanvas = this.webcam?.canvas ?? null;
      const allCanvases = Array.from(document.querySelectorAll("canvas")).filter((canvas) => canvas !== webcamCanvas && canvas !== this.previewCanvas);
      const visibleCandidates = allCanvases.map((canvas) => {
        const rect = canvas.getBoundingClientRect();
        const style = window.getComputedStyle(canvas);
        return { canvas, rect, style, score: canvasScore(rect.width, rect.height) };
      }).filter((item) => item.rect.width >= 200 && item.rect.height >= 150).filter((item) => item.style.display !== "none").filter((item) => item.style.visibility !== "hidden").filter((item) => Number(item.style.opacity || 1) !== 0).sort((left, right) => right.score - left.score);
      if (visibleCandidates[0]) return visibleCandidates[0].canvas;
      const fallbackCandidates = allCanvases.map((canvas) => ({ canvas, score: canvasScore(canvas.width, canvas.height) })).filter((item) => item.canvas.width >= 200 && item.canvas.height >= 150).sort((left, right) => right.score - left.score);
      if (fallbackCandidates[0]) return fallbackCandidates[0].canvas;
      throw new Error("TMPose: No likely stage canvas was found. The editor or packager DOM may be unsupported.");
    }
    validatePreviewAttachment(stage, canvas) {
      if (!stage || !canvas || canvas.parentElement !== stage) {
        throw new Error("TMPose: Preview canvas was not attached to the stage.");
      }
      const canvasStyle = window.getComputedStyle(canvas);
      if (canvasStyle.display === "none" && this.previewVisible) {
        throw new Error("TMPose: Preview canvas is hidden by display:none.");
      }
      if (canvasStyle.visibility === "hidden" && this.previewVisible) {
        throw new Error("TMPose: Preview canvas is hidden by visibility:hidden.");
      }
      const stageRect = stage.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const documentHidden = typeof document.visibilityState === "string" && document.visibilityState === "hidden";
      const layoutUnavailable = stageRect.width === 0 || stageRect.height === 0;
      if (!documentHidden && !layoutUnavailable && this.previewVisible) {
        if (canvasRect.width <= 0 || canvasRect.height <= 0) {
          throw new Error("TMPose: Preview canvas was attached but has zero size.");
        }
        if (!rectanglesIntersect(stageRect, canvasRect)) {
          throw new Error("TMPose: Preview canvas does not intersect the stage.");
        }
      }
    }
    attachPreviewToStage() {
      if (!this.webcam) throw new Error("TMPose: Start the camera before attaching the preview.");
      if (!this.webcam.canvas) throw new Error("TMPose: webcam.canvas is unavailable.");
      const stage = this.findStageElement();
      const canvas = this.webcam.canvas;
      let stageCanvas = null;
      try {
        const candidate = this.findLikelyStageCanvas();
        if (candidate.parentElement === stage) stageCanvas = candidate;
      } catch {
      }
      this.previewCanvas = canvas;
      this.previewStageElement = stage;
      const computed = window.getComputedStyle(stage);
      if (computed.position === "static") stage.style.position = "relative";
      stage.style.overflow = "hidden";
      Object.assign(canvas.style, {
        position: "absolute",
        zIndex: "auto",
        pointerEvents: "none",
        border: "2px solid rgba(255, 255, 255, 0.7)",
        borderRadius: "8px",
        background: "#000",
        opacity: String(this.previewOpacity),
        display: this.previewVisible ? "block" : "none",
        boxSizing: "border-box"
      });
      if (stageCanvas && typeof stage.insertBefore === "function") {
        stage.insertBefore(canvas, stageCanvas.nextSibling);
      } else if (canvas.parentNode !== stage) {
        stage.appendChild(canvas);
      }
      this.updatePreviewStyle();
      this.validatePreviewAttachment(stage, canvas);
    }
    updatePreviewStyle() {
      const canvas = this.previewCanvas;
      if (!canvas) throw new Error("TMPose: Start the camera before positioning the preview.");
      Object.assign(canvas.style, {
        left: "",
        right: "",
        top: "",
        bottom: "",
        transform: "",
        objectFit: "",
        width: "35%",
        height: "auto",
        borderRadius: "8px"
      });
      let positionTransform = "";
      switch (this.previewPosition) {
        case "top-left":
          canvas.style.left = "8px";
          canvas.style.top = "8px";
          break;
        case "top-right":
          canvas.style.right = "8px";
          canvas.style.top = "8px";
          break;
        case "bottom-left":
          canvas.style.left = "8px";
          canvas.style.bottom = "8px";
          break;
        case "center":
          canvas.style.left = "50%";
          canvas.style.top = "50%";
          positionTransform = "translate(-50%, -50%)";
          break;
        case "full-stage":
          canvas.style.left = "0";
          canvas.style.top = "0";
          canvas.style.width = "100%";
          canvas.style.height = "100%";
          canvas.style.objectFit = "cover";
          canvas.style.borderRadius = "0";
          break;
        default:
          canvas.style.right = "8px";
          canvas.style.bottom = "8px";
      }
      const mirroringTransform = this.previewMirrored ? "" : "scaleX(-1)";
      canvas.style.transform = [positionTransform, mirroringTransform].filter(Boolean).join(" ");
    }
    startLoopIfNeeded() {
      if (this.loopStarted || !this.cameraRunning || !this.webcam) return;
      this.loopStarted = true;
      const generation = ++this.loopGeneration;
      void this.loop(generation);
    }
    trackPreparedModelOperation(model, operation) {
      let active = this.activeModelOperations.get(model);
      if (!active) {
        active = /* @__PURE__ */ new Set();
        this.activeModelOperations.set(model, active);
      }
      active.add(operation);
      void operation.then(
        () => {
          active.delete(operation);
          if (active.size === 0) this.activeModelOperations.delete(model);
        },
        () => {
          active.delete(operation);
          if (active.size === 0) this.activeModelOperations.delete(model);
        }
      );
      return operation;
    }
    async waitForPreparedModelIdle(model) {
      await Promise.allSettled([...this.activeModelOperations.get(model) ?? []]);
    }
    async loop(generation = this.loopGeneration) {
      if (generation !== this.loopGeneration || !this.cameraRunning || !this.webcam) {
        if (generation === this.loopGeneration) this.loopStarted = false;
        return;
      }
      try {
        this.webcam.update();
        if (this.predicting && this.model) {
          const model = this.model;
          const first = this.firstPredictMs === 0;
          const startedAt = first ? performance.now() : 0;
          const prediction = await this.trackPreparedModelOperation(
            model,
            (async () => {
              const estimate = await model.estimatePose(this.webcam.canvas);
              return model.predict(estimate.posenetOutput);
            })()
          );
          if (generation !== this.loopGeneration || !this.cameraRunning || !this.predicting || this.model !== model) {
          } else {
            if (first) this.firstPredictMs = Math.round(performance.now() - startedAt);
            let best = { className: "", probability: 0 };
            this.predictions = {};
            for (const result of prediction) {
              this.predictions[result.className] = result.probability;
              if (result.probability > best.probability) best = result;
            }
            this.currentPoseName = best.className;
            this.score = best.probability;
            if (this.featureFlags.temporalPoseScoring) {
              this.updateAccumulatedPose(prediction);
            }
          }
        }
      } catch (error) {
        this.setLastError(error);
      }
      if (generation === this.loopGeneration && this.cameraRunning && this.webcam) {
        requestAnimationFrame(() => void this.loop(generation));
      } else if (generation === this.loopGeneration) {
        this.loopStarted = false;
      }
    }
    currentPoseReporter() {
      return this.currentPoseName;
    }
    scoreReporter() {
      return Math.round(this.score * 100) / 100;
    }
    poseScoreReporter(args) {
      const value = this.predictions[String(args.NAME || "")] || 0;
      return Math.round(value * 100) / 100;
    }
    setAccumulatedPoseParameters(args) {
      const accumulation = args.ACCUMULATION === "" ? 1 : Number(args.ACCUMULATION);
      const decay = args.DECAY === "" ? 0.9 : Number(args.DECAY);
      this.accumulationCoefficient = Number.isFinite(accumulation) ? Math.max(0, accumulation) : 1;
      this.decayCoefficient = Number.isFinite(decay) ? Math.max(0, Math.min(1, decay)) : 0.9;
    }
    setAccumulatedPoseThreshold(args) {
      const threshold = args.THRESHOLD === "" ? 0 : Number(args.THRESHOLD);
      this.accumulatedPoseThreshold = Number.isFinite(threshold) ? Math.max(0, threshold) : 0;
      this.updateAccumulatedPoseSelection();
    }
    startAccumulatedPoseSession(now = performance.now()) {
      this.activeDecayCoefficient = this.decayCoefficient;
      this.lastAccumulationTime = now;
    }
    supportsAccumulatedPoseEvents() {
      return this.featureFlags.temporalPoseScoring && this.featureFlags.accumulatedPoseEvents;
    }
    emitAccumulatedPoseChanged(previousPoseName, reason) {
      if (!this.supportsAccumulatedPoseEvents() || previousPoseName === this.accumulatedPoseName) return;
      const payload = {
        version: 1,
        poseName: this.accumulatedPoseName,
        previousPoseName,
        score: this.accumulatedScore,
        reason,
        timestamp: performance.now()
      };
      if (this.onAccumulatedPoseChanged) {
        try {
          this.onAccumulatedPoseChanged(payload);
        } catch {
        }
      } else if (typeof Scratch !== "undefined") {
        Scratch.vm?.runtime?.emit(ACCUMULATED_POSE_CHANGED_EVENT, payload);
      }
    }
    dispose() {
      this.stopCamera();
      if (this.featureFlags.temporalPoseScoring && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", this.visibilityChangeListener);
      }
      this.onAccumulatedPoseChanged = null;
    }
    resetAccumulatedPose(reason = "reset") {
      const previousPoseName = this.accumulatedPoseName;
      this.accumulatedPoseName = "";
      this.accumulatedScore = 0;
      this.accumulatedPredictions = {};
      this.lastAccumulationTime = this.predicting ? performance.now() : null;
      this.emitAccumulatedPoseChanged(previousPoseName, reason);
    }
    handleDocumentVisibilityChange() {
      if (typeof document === "undefined") return;
      if (isDocumentHidden()) {
        this.accumulatedPosePausedForBackground = true;
        return;
      }
      if (this.accumulatedPosePausedForBackground) {
        this.accumulatedPosePausedForBackground = false;
        this.lastAccumulationTime = this.predicting ? performance.now() : null;
      }
    }
    updateAccumulatedPose(prediction, now = performance.now()) {
      if (isDocumentHidden()) {
        this.accumulatedPosePausedForBackground = true;
        return;
      }
      if (this.accumulatedPosePausedForBackground) return;
      const elapsedSeconds = this.lastAccumulationTime === null ? 0 : Math.max(0, (now - this.lastAccumulationTime) / 1e3);
      const decayMultiplier = elapsedSeconds === 0 ? 1 : Math.pow(this.activeDecayCoefficient, elapsedSeconds);
      for (const name of Object.keys(this.accumulatedPredictions)) {
        this.accumulatedPredictions[name] *= decayMultiplier;
      }
      for (const result of prediction) {
        const name = String(result.className || "");
        const probability = Number(result.probability);
        if (!name || !Number.isFinite(probability)) continue;
        const contribution = Math.max(0, Math.min(1, probability)) * this.accumulationCoefficient * elapsedSeconds;
        this.accumulatedPredictions[name] = (this.accumulatedPredictions[name] || 0) + contribution;
      }
      this.lastAccumulationTime = now;
      this.updateAccumulatedPoseSelection();
    }
    updateAccumulatedPoseSelection() {
      const previousPoseName = this.accumulatedPoseName;
      this.accumulatedPoseName = "";
      this.accumulatedScore = 0;
      let bestPoseName = "";
      for (const [name, value] of Object.entries(this.accumulatedPredictions)) {
        if (value > this.accumulatedScore) {
          bestPoseName = name;
          this.accumulatedScore = value;
        }
      }
      if (bestPoseName && this.accumulatedScore >= this.accumulatedPoseThreshold) {
        this.accumulatedPoseName = bestPoseName;
      }
      this.emitAccumulatedPoseChanged(previousPoseName, "prediction");
    }
    accumulatedPoseReporter() {
      return this.accumulatedPoseName;
    }
    accumulatedScoreReporter() {
      return this.accumulatedScore;
    }
    accumulatedPoseScoreReporter(args) {
      const value = this.accumulatedPredictions[String(args.NAME || "")] || 0;
      return value;
    }
    isPose(args) {
      return (this.predictions[String(args.NAME || "")] || 0) >= 0.75;
    }
    isPoseWithThreshold(args) {
      const name = String(args.NAME || "");
      let threshold = args.THRESHOLD === "" ? 0.75 : Number(args.THRESHOLD);
      if (Number.isNaN(threshold)) threshold = 0.75;
      threshold = Math.max(0, Math.min(1, threshold));
      return (this.predictions[name] || 0) >= threshold;
    }
    cameraMsReporter() {
      return this.cameraMs;
    }
    modelLoadMsReporter() {
      return this.modelLoadMs;
    }
    firstPredictMsReporter() {
      return this.firstPredictMs;
    }
    lastErrorReporter() {
      return this.lastError;
    }
  }
  if (!Scratch.extensions.unsandboxed) {
    throw new Error("TMPose must run without the extension sandbox.");
  }
  const extension = new TMPoseExtension();
  Scratch.extensions.register(extension);
  if (Scratch.vm?.runtime) {
    Scratch.vm.runtime.ext_tmpose = extension;
  }

})(Scratch);
