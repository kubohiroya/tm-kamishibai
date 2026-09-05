const mirroringModes = new Set(['mirrored', 'unmirrored']);
const cameraPreferences = ['default', 'front', 'back'];
const controlOrder = ['mirroring', 'cameraMenu'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireFunction(value: unknown, label: string) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function requireElement(value: unknown, label: string) {
  if (!isRecord(value) || typeof value.append !== 'function' || !isRecord(value.ownerDocument)) {
    throw new TypeError(`${label} must be a DOM element`);
  }
  return value as unknown as HTMLElement;
}

function assignStyles(element: HTMLElement, values: Readonly<Record<string, string>>) {
  Object.assign(element.style, values);
}

/** The camera preview box the controls are anchored against, in client pixels. */
interface PreviewAnchorRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly visible?: boolean;
}

/** The space a control group reserves in the shared preview layout, in stage pixels. */
interface ReservedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The members of the shared preview layout bridge these controls reserve space through. */
interface PreviewLayoutBridge {
  registerReservedRect(owner: unknown, rect: ReservedRect): unknown;
  updateReservedRect(owner: unknown, rect: ReservedRect): unknown;
  unregisterReservedRect(owner: unknown): unknown;
}

function anchorStyle(position: string, rect: PreviewAnchorRect) {
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

function normalizeSelection(value: unknown) {
  if (typeof value === 'string' && cameraPreferences.includes(value)) return value;
  if (isRecord(value) && typeof value.deviceId === 'string' && value.deviceId.length > 0) {
    return {deviceId: value.deviceId};
  }
  return 'default';
}

/**
 * Render fixed app-shell controls around the current TM preview rectangle.
 * The renderer owns its DOM listeners and nodes. Asset bytes and Object URLs remain owned by the
 * platform asset session; this renderer only borrows URLs until stop/dispose.
 */
export function createDsl4CameraPreviewControls(options: {
  container: unknown;
  preview: Readonly<Record<string, unknown>>;
  assetUrls: Readonly<Record<string, string>>;
  port: unknown;
  getPreviewRect: () => PreviewAnchorRect | null;
  labels?: Readonly<Record<string, string>>;
  schedule?: (callback: () => void) => () => void;
  previewLayout?: {
    registerReservedRect: Function;
    updateReservedRect: Function;
    unregisterReservedRect: Function;
  };
  onError?: (error: unknown, context: Readonly<Record<string, string>>) => void;
}) {
  if (!isRecord(options)) throw new TypeError('camera preview controls options must be an object');
  const container = requireElement(options.container, 'container');
  const preview = isRecord(options.preview) ? options.preview : {};
  const controls = isRecord(preview.controls) ? preview.controls : {};
  const configuredNames = controlOrder.filter((name) => isRecord(controls[name]));
  if (configuredNames.length === 0) {
    throw new TypeError('camera preview controls require at least one configured control');
  }
  const assetUrls = isRecord(options.assetUrls) ? options.assetUrls : {};
  const port = (isRecord(options.port) ? options.port : {}) as Record<
    string,
    (...args: any[]) => any
  >;
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
  const labels = {
    mirroring: 'Switch camera preview mirroring',
    cameraMenu: 'Select camera',
    default: 'Default camera',
    front: 'Front camera',
    back: 'Back camera',
    detectedCamera: 'Camera',
    currentCamera: 'Current camera',
    ...(isRecord(options.labels) ? options.labels : {}),
  } as Record<string, string>;
  const schedule =
    options.schedule ??
    ((callback) => {
      const frame = setTimeout(callback, 16);
      return () => clearTimeout(frame);
    });
  requireFunction(schedule, 'schedule');
  let previewLayout: PreviewLayoutBridge | null = null;
  if (options.previewLayout !== undefined) {
    if (!isRecord(options.previewLayout)) {
      throw new TypeError('previewLayout must implement the shared preview layout bridge');
    }
    const candidateLayout = options.previewLayout as Record<string, unknown>;
    for (const method of ['registerReservedRect', 'updateReservedRect', 'unregisterReservedRect']) {
      requireFunction(candidateLayout[method], `previewLayout.${method}`);
    }
    previewLayout = candidateLayout as unknown as PreviewLayoutBridge;
  }
  if (options.onError !== undefined) requireFunction(options.onError, 'onError');
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const document = container.ownerDocument;
  const groups = new Map();
  const registeredLayoutOwners = new Set();
  const listeners: Array<() => void> = [];
  let mirroring = mirroringModes.has(String(preview.mirroring))
    ? String(preview.mirroring)
    : 'mirrored';
  let running = false;
  let interactive = false;
  let disposed = false;
  let cancelScheduled: null | (() => void) = null;
  let mirrorButton: HTMLButtonElement | null = null;
  let mirrorImage: HTMLImageElement | null = null;
  let cameraButton: HTMLButtonElement | null = null;
  let cameraImage: HTMLImageElement | null = null;
  let cameraSelect: HTMLSelectElement | null = null;
  let deviceSelections: Map<string, Readonly<{deviceId: string}>> = new Map();

  function assetUrl(assetId: string) {
    const value = assetUrls[assetId];
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`Missing camera preview control asset URL: ${assetId}`);
    }
    return value;
  }

  function groupFor(position: string) {
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

  function createButton(name: string, control: Record<string, unknown>) {
    const button = document.createElement('button') as HTMLButtonElement;
    button.type = 'button';
    button.dataset.dsl4PreviewControl = name;
    button.setAttribute('aria-label', String(labels[name]));
    assignStyles(button, {opacity: String(control.opacity ?? 1), cursor: 'pointer'});
    const image = document.createElement('img') as HTMLImageElement;
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
    cameraSelect = document.createElement('select') as HTMLSelectElement;
    cameraSelect.dataset.dsl4PreviewCameraMenu = 'true';
    cameraSelect.setAttribute('aria-label', String(labels.cameraMenu));
    assignStyles(cameraSelect, {cursor: 'pointer'});
    cameraSelect.hidden = true;
    cameraButton.after(cameraSelect);
  }

  function updateMirrorIcon() {
    if (!mirrorImage || !mirroringControl) return;
    const assets = mirroringControl.assets as Record<string, unknown>;
    const targetAsset = mirroring === 'mirrored' ? assets.showUnmirrored : assets.showMirrored;
    mirrorImage.src = assetUrl(String(targetAsset));
  }
  updateMirrorIcon();

  function listen(target: EventTarget, type: string, listener: (event: Event) => void) {
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

  function layoutOwner(position: string) {
    return `camera-controls-${position}`;
  }

  function measuredControlRect(group: any) {
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

  function unregisterLayoutOwner(position: string) {
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

  function selectionToken(selection: unknown) {
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

  function appendDeviceOption(device: unknown, token: string, fallbackLabel: string) {
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
      rect !== null &&
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
        ...anchorStyle(position, rect),
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

  function setMirroring(mode: unknown) {
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
