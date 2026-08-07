const mirroringModes = new Set(['mirrored', 'unmirrored']);
const cameraPreferences = ['default', 'front', 'back'];
const controlOrder = ['mirroring', 'cameraMenu'];

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} label */
function requireFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

/** @param {unknown} value @param {string} label */
function requireElement(value, label) {
  if (!isRecord(value) || typeof value.append !== 'function' || !isRecord(value.ownerDocument)) {
    throw new TypeError(`${label} must be a DOM element`);
  }
  return /** @type {HTMLElement} */ (/** @type {unknown} */ (value));
}

/** @param {HTMLElement} element @param {Readonly<Record<string, string>>} values */
function assignStyles(element, values) {
  Object.assign(element.style, values);
}

/** @param {string} position @param {Readonly<Record<string, number>>} rect */
function anchorStyle(position, rect) {
  const horizontal = position.includes('left')
    ? rect.left
    : position.includes('right')
      ? rect.left + rect.width
      : rect.left + rect.width / 2;
  const vertical = position.startsWith('top')
    ? rect.top
    : position.startsWith('bottom')
      ? rect.top + rect.height
      : rect.top + rect.height / 2;
  const transform = {
    'top-center': 'translate(-50%, -100%)',
    'bottom-center': 'translate(-50%, 0)',
    'left-center': 'translate(-100%, -50%)',
    'right-center': 'translate(0, -50%)',
    'top-right': 'translate(-100%, -100%)',
    'bottom-right': 'translate(-100%, 0)',
    'top-left': 'translate(0, -100%)',
    'bottom-left': 'translate(0, 0)',
  }[position];
  return {left: `${horizontal}px`, top: `${vertical}px`, transform: transform ?? 'none'};
}

/** @param {unknown} value */
function normalizeSelection(value) {
  if (typeof value === 'string' && cameraPreferences.includes(value)) return value;
  if (isRecord(value) && typeof value.deviceId === 'string' && value.deviceId.length > 0) {
    return {deviceId: value.deviceId};
  }
  return 'default';
}

/**
 * Render fixed app-shell controls around the current TMPose preview rectangle.
 *
 * The renderer owns its DOM listeners and nodes. Asset bytes and Object URLs remain owned by the
 * platform asset session; this renderer only borrows URLs until stop/dispose.
 *
 * @param {object} options
 * @param {unknown} options.container
 * @param {Readonly<Record<string, unknown>>} options.preview
 * @param {Readonly<Record<string, string>>} options.assetUrls
 * @param {unknown} options.port
 * @param {() => Readonly<{left: number, top: number, width: number, height: number, visible?: boolean}> | null} options.getPreviewRect
 * @param {Readonly<Record<string, string>>} [options.labels]
 * @param {(callback: () => void) => (() => void)} [options.schedule]
 * @param {{registerReservedRect: Function, updateReservedRect: Function, unregisterReservedRect: Function}} [options.previewLayout]
 * @param {(error: unknown, context: Readonly<Record<string, string>>) => void} [options.onError]
 */
export function createDsl4CameraPreviewControls(options) {
  if (!isRecord(options)) throw new TypeError('camera preview controls options must be an object');
  const container = requireElement(options.container, 'container');
  const preview = isRecord(options.preview) ? options.preview : {};
  const controls = isRecord(preview.controls) ? preview.controls : {};
  const configuredNames = controlOrder.filter((name) => isRecord(controls[name]));
  if (configuredNames.length === 0) {
    throw new TypeError('camera preview controls require at least one configured control');
  }
  const assetUrls = isRecord(options.assetUrls) ? options.assetUrls : {};
  const port = /** @type {Record<string, Function>} */ (isRecord(options.port) ? options.port : {});
  const requiredMethods = new Set(['isCameraRunning']);
  if (configuredNames.includes('mirroring')) requiredMethods.add('setPreviewMirroring');
  if (configuredNames.includes('cameraMenu')) {
    for (const method of [
      'listCameraDevices',
      'selectCamera',
      'getCameraSelection',
      'getActiveCamera',
    ]) {
      requiredMethods.add(method);
    }
  }
  for (const method of requiredMethods) requireFunction(port[method], `port.${method}`);
  const getPreviewRect = requireFunction(options.getPreviewRect, 'getPreviewRect');
  const labels = /** @type {Record<string, string>} */ ({
    mirroring: 'Switch camera preview mirroring',
    cameraMenu: 'Select camera',
    default: 'Default camera',
    front: 'Front camera',
    back: 'Back camera',
    detectedCamera: 'Camera',
    currentCamera: 'Current camera',
    ...(isRecord(options.labels) ? options.labels : {}),
  });
  const schedule =
    options.schedule ??
    ((callback) => {
      const frame = setTimeout(callback, 16);
      return () => clearTimeout(frame);
    });
  requireFunction(schedule, 'schedule');
  /** @type {Record<string, Function> | null} */
  let previewLayout = null;
  if (options.previewLayout !== undefined) {
    if (!isRecord(options.previewLayout)) {
      throw new TypeError('previewLayout must implement the shared preview layout bridge');
    }
    const candidateLayout = /** @type {Record<string, unknown>} */ (options.previewLayout);
    for (const method of ['registerReservedRect', 'updateReservedRect', 'unregisterReservedRect']) {
      requireFunction(candidateLayout[method], `previewLayout.${method}`);
    }
    previewLayout = /** @type {Record<string, Function>} */ (candidateLayout);
  }
  if (options.onError !== undefined) requireFunction(options.onError, 'onError');
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const document = container.ownerDocument;
  const groups = new Map();
  const registeredLayoutOwners = new Set();
  /** @type {Array<() => void>} */
  const listeners = [];
  let mirroring = mirroringModes.has(String(preview.mirroring))
    ? String(preview.mirroring)
    : 'mirrored';
  let running = false;
  let interactive = false;
  let disposed = false;
  /** @type {null | (() => void)} */
  let cancelScheduled = null;
  /** @type {HTMLButtonElement | null} */
  let mirrorButton = null;
  /** @type {HTMLImageElement | null} */
  let mirrorImage = null;
  /** @type {HTMLButtonElement | null} */
  let cameraButton = null;
  /** @type {HTMLImageElement | null} */
  let cameraImage = null;
  /** @type {HTMLSelectElement | null} */
  let cameraSelect = null;
  /** @type {Map<string, Readonly<{deviceId: string}>>} */
  let deviceSelections = new Map();

  /** @param {string} assetId */
  function assetUrl(assetId) {
    const value = assetUrls[assetId];
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`Missing camera preview control asset URL: ${assetId}`);
    }
    return value;
  }

  /** @param {string} position */
  function groupFor(position) {
    let group = groups.get(position);
    if (group) return group;
    group = document.createElement('div');
    group.dataset.dsl4PreviewControlAnchor = position;
    assignStyles(group, {
      position: 'fixed',
      display: 'none',
      gap: '0.5rem',
      zIndex: '20',
      flexDirection:
        position.startsWith('left-') || position.startsWith('right-') ? 'column' : 'row',
    });
    container.append(group);
    groups.set(position, group);
    return group;
  }

  /** @param {string} name @param {Record<string, unknown>} control */
  function createButton(name, control) {
    const button = /** @type {HTMLButtonElement} */ (document.createElement('button'));
    button.type = 'button';
    button.dataset.dsl4PreviewControl = name;
    button.setAttribute('aria-label', String(labels[name]));
    assignStyles(button, {opacity: String(control.opacity ?? 1)});
    const image = /** @type {HTMLImageElement} */ (document.createElement('img'));
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    button.append(image);
    groupFor(String(control.position)).append(button);
    return {button, image};
  }

  const mirroringControl = isRecord(controls.mirroring) ? controls.mirroring : null;
  if (mirroringControl) {
    ({button: mirrorButton, image: mirrorImage} = createButton('mirroring', mirroringControl));
  }
  const cameraMenuControl = isRecord(controls.cameraMenu) ? controls.cameraMenu : null;
  if (cameraMenuControl) {
    ({button: cameraButton, image: cameraImage} = createButton('cameraMenu', cameraMenuControl));
    cameraImage.src = assetUrl(String(cameraMenuControl.buttonAsset));
    cameraSelect = /** @type {HTMLSelectElement} */ (document.createElement('select'));
    cameraSelect.dataset.dsl4PreviewCameraMenu = 'true';
    cameraSelect.setAttribute('aria-label', String(labels.cameraMenu));
    cameraSelect.hidden = true;
    cameraButton.after(cameraSelect);
  }

  function updateMirrorIcon() {
    if (!mirrorImage || !mirroringControl) return;
    const assets = /** @type {Record<string, unknown>} */ (mirroringControl.assets);
    const targetAsset = mirroring === 'mirrored' ? assets.showUnmirrored : assets.showMirrored;
    mirrorImage.src = assetUrl(String(targetAsset));
  }
  updateMirrorIcon();

  /** @param {EventTarget} target @param {string} type @param {(event: Event) => void} listener */
  function listen(target, type, listener) {
    target.addEventListener(type, listener);
    listeners.push(() => target.removeEventListener(type, listener));
  }

  function detachListeners() {
    const errors = [];
    for (const remove of listeners.splice(0).reverse()) {
      try {
        remove();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      resetCameraMenu();
    } catch (error) {
      errors.push(error);
    }
    interactive = false;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Camera preview control listener cleanup failed');
    }
  }

  /** @param {string} position */
  function layoutOwner(position) {
    return `camera-controls-${position}`;
  }

  /** @param {any} group */
  function measuredControlRect(group) {
    if (typeof group.getBoundingClientRect !== 'function') return null;
    const measured = group.getBoundingClientRect();
    const left = Number(measured.x ?? measured.left);
    const top = Number(measured.y ?? measured.top);
    const width = Number(measured.width);
    const height = Number(measured.height);
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
      return null;
    }
    return {
      x: Math.max(0, left),
      y: Math.max(0, top),
      width: Math.max(0, width + Math.min(0, left)),
      height: Math.max(0, height + Math.min(0, top)),
    };
  }

  /** @param {string} position */
  function unregisterLayoutOwner(position) {
    if (!previewLayout) return;
    const owner = layoutOwner(position);
    if (!registeredLayoutOwners.delete(owner)) return;
    previewLayout.unregisterReservedRect(owner);
  }

  function unregisterLayoutOwners() {
    if (!previewLayout) return;
    for (const owner of [...registeredLayoutOwners]) {
      previewLayout.unregisterReservedRect(owner);
      registeredLayoutOwners.delete(owner);
    }
  }

  function publishLayoutRects() {
    if (!previewLayout) return;
    for (const [position, group] of groups) {
      const owner = layoutOwner(position);
      const measured = measuredControlRect(group);
      if (!measured || measured.width <= 0 || measured.height <= 0) {
        unregisterLayoutOwner(position);
        continue;
      }
      if (registeredLayoutOwners.has(owner)) previewLayout.updateReservedRect(owner, measured);
      else {
        previewLayout.registerReservedRect(owner, measured);
        registeredLayoutOwners.add(owner);
      }
    }
  }

  function hideAndDetach() {
    const errors = [];
    try {
      unregisterLayoutOwners();
    } catch (error) {
      errors.push(error);
    }
    for (const group of groups.values()) {
      try {
        group.style.display = 'none';
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      detachListeners();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Camera preview control suspension failed');
    }
  }

  async function handleMirroring() {
    if (!interactive || !mirrorButton) return;
    const next = mirroring === 'mirrored' ? 'unmirrored' : 'mirrored';
    mirrorButton.disabled = true;
    try {
      await port.setPreviewMirroring(next);
      mirroring = next;
      updateMirrorIcon();
    } catch (error) {
      onError(error, Object.freeze({operation: 'setPreviewMirroring'}));
    } finally {
      mirrorButton.disabled = false;
    }
  }

  /** @param {unknown} selection */
  function selectionToken(selection) {
    const normalized = normalizeSelection(selection);
    if (typeof normalized === 'string') return normalized;
    for (const [token, candidate] of deviceSelections) {
      if (candidate.deviceId === normalized.deviceId) return token;
    }
    return 'default';
  }

  function resetCameraMenu() {
    if (!cameraSelect) return;
    cameraSelect.hidden = true;
    cameraSelect.replaceChildren();
    deviceSelections = new Map();
  }

  /**
   * @param {unknown} device
   * @param {string} token
   * @param {string} fallbackLabel
   */
  function appendDeviceOption(device, token, fallbackLabel) {
    if (
      !cameraSelect ||
      !isRecord(device) ||
      typeof device.deviceId !== 'string' ||
      device.deviceId.length === 0
    ) {
      return false;
    }
    deviceSelections.set(token, Object.freeze({deviceId: device.deviceId}));
    const option = document.createElement('option');
    option.value = token;
    option.textContent =
      typeof device.label === 'string' && device.label.trim().length > 0
        ? device.label.trim()
        : fallbackLabel;
    cameraSelect.append(option);
    return true;
  }

  async function openCameraMenu() {
    if (!interactive || !cameraSelect || !cameraButton) return;
    cameraButton.disabled = true;
    resetCameraMenu();
    try {
      const devices = await port.listCameraDevices();
      if (!interactive) return;
      if (!Array.isArray(devices)) throw new TypeError('listCameraDevices must return an array');
      for (const preference of cameraPreferences) {
        const option = document.createElement('option');
        option.value = preference;
        option.textContent = String(labels[preference]);
        cameraSelect.append(option);
      }
      let ordinal = 0;
      const enumeratedDeviceIds = new Set();
      for (const device of devices) {
        if (
          !isRecord(device) ||
          typeof device.deviceId !== 'string' ||
          device.deviceId.length === 0
        ) {
          continue;
        }
        ordinal += 1;
        const token = `device:${ordinal}`;
        enumeratedDeviceIds.add(device.deviceId);
        appendDeviceOption(device, token, `${String(labels.detectedCamera)} ${ordinal}`);
      }
      const activeCamera = port.getActiveCamera();
      if (
        isRecord(activeCamera) &&
        typeof activeCamera.deviceId === 'string' &&
        activeCamera.deviceId.length > 0 &&
        !enumeratedDeviceIds.has(activeCamera.deviceId)
      ) {
        appendDeviceOption(activeCamera, 'device:current', String(labels.currentCamera));
      }
      cameraSelect.value = selectionToken(port.getCameraSelection());
      cameraSelect.hidden = false;
      cameraSelect.focus();
    } catch (error) {
      resetCameraMenu();
      onError(error, Object.freeze({operation: 'listCameraDevices'}));
    } finally {
      cameraButton.disabled = false;
    }
  }

  async function selectCamera() {
    if (!interactive || !cameraSelect) return;
    const previous = selectionToken(port.getCameraSelection());
    const token = cameraSelect.value;
    const selection =
      deviceSelections.get(token) ?? (cameraPreferences.includes(token) ? token : null);
    if (selection === null) return;
    cameraSelect.disabled = true;
    try {
      await port.selectCamera(selection);
      cameraSelect.value = selectionToken(port.getCameraSelection());
      cameraSelect.hidden = true;
    } catch (error) {
      cameraSelect.value = previous;
      onError(error, Object.freeze({operation: 'selectCamera'}));
    } finally {
      cameraSelect.disabled = false;
    }
  }

  function attachListeners() {
    if (interactive || !running) return;
    interactive = true;
    if (mirrorButton) listen(mirrorButton, 'click', () => void handleMirroring());
    if (cameraButton) listen(cameraButton, 'click', () => void openCameraMenu());
    if (cameraSelect) listen(cameraSelect, 'change', () => void selectCamera());
  }

  function refresh() {
    if (disposed) return;
    const rect = getPreviewRect();
    const cameraRunning = port.isCameraRunning() === true;
    const visible =
      running &&
      cameraRunning &&
      isRecord(rect) &&
      rect.visible !== false &&
      Number(rect.width) > 0 &&
      Number(rect.height) > 0;
    if (!visible) {
      hideAndDetach();
      return;
    }
    attachListeners();
    for (const [position, group] of groups) {
      assignStyles(group, {
        ...anchorStyle(position, /** @type {Readonly<Record<string, number>>} */ (rect)),
        display: 'flex',
      });
    }
    publishLayoutRects();
  }

  function scheduleRefresh() {
    if (!running || disposed) return;
    cancelScheduled = schedule(() => {
      cancelScheduled = null;
      refresh();
      scheduleRefresh();
    });
    if (typeof cancelScheduled !== 'function') {
      throw new TypeError('schedule must return a cancellation function');
    }
  }

  function start() {
    if (disposed) throw new Error('camera preview controls are disposed');
    if (running) return;
    running = true;
    refresh();
    scheduleRefresh();
  }

  function stop() {
    if (!running) return;
    running = false;
    const cancel = cancelScheduled;
    cancelScheduled = null;
    const errors = [];
    try {
      cancel?.();
    } catch (error) {
      errors.push(error);
    }
    try {
      // Suspension must not call preview or camera providers, which may already be unavailable.
      hideAndDetach();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Camera preview control stop failed');
    }
  }

  /** @param {unknown} mode */
  function setMirroring(mode) {
    if (typeof mode !== 'string' || !mirroringModes.has(mode)) {
      throw new TypeError('camera preview mirroring mode is invalid');
    }
    mirroring = mode;
    updateMirrorIcon();
  }

  function dispose() {
    if (disposed) return;
    const errors = [];
    try {
      stop();
    } catch (error) {
      errors.push(error);
    }
    disposed = true;
    try {
      detachListeners();
    } catch (error) {
      errors.push(error);
    }
    for (const group of groups.values()) {
      try {
        group.remove();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      unregisterLayoutOwners();
    } catch (error) {
      errors.push(error);
    }
    groups.clear();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Camera preview control disposal failed');
    }
  }

  return Object.freeze({start, stop, refresh, setMirroring, dispose});
}
