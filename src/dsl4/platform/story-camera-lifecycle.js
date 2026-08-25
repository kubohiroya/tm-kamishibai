/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const recognitionCommands = new Set(['pose', 'poseInputToChangeScene', 'imageInputToChangeScene']);
const dsl32FullStagePreviewOpacity = 0.2;

/** @param {unknown} storyDocument */
export function storyUsesPoseRecognition(storyDocument) {
  if (!isRecord(storyDocument) || !Array.isArray(storyDocument.scenes)) return false;
  return storyDocument.scenes.some(
    (scene) =>
      isRecord(scene) &&
      Array.isArray(scene.actions) &&
      scene.actions.some(
        (action) => isRecord(action) && recognitionCommands.has(String(action.command)),
      ),
  );
}

/**
 * Own one camera stream for the complete story while pose actions own preview visibility.
 *
 * @param {object} options
 * @param {unknown} options.composition
 * @param {(payload: Readonly<{visible: boolean, source: string, label: string, cursor: string}>) => unknown | Promise<unknown>} [options.setBusy]
 */
export function createDsl4StoryCameraLifecycle(options) {
  if (!isRecord(options) || !isRecord(options.composition)) {
    throw new TypeError('story camera lifecycle options and composition are required');
  }
  const composition = /** @type {Record<string, Function>} */ (options.composition);
  const methods = [
    'startCamera',
    'stopCamera',
    'isCameraRunning',
    'hidePreview',
    'isPreviewVisible',
    'setPreviewOpacity',
    'setPreviewPosition',
    'stopRecognition',
    'isRecognizing',
  ];
  const missing = methods.filter((method) => typeof composition[method] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(`story camera composition must provide ${missing.join(', ')}`);
  }
  if (options.setBusy !== undefined && typeof options.setBusy !== 'function') {
    throw new TypeError('setBusy must be a function');
  }

  let desired = false;
  let disposed = false;
  let previewPrepared = false;
  /** @type {Promise<boolean>} */
  let queue = Promise.resolve(false);
  /** @type {Promise<boolean> | null} */
  let disposePromise = null;

  /** @param {boolean} visible */
  function notifyBusy(visible) {
    try {
      void Promise.resolve(
        options.setBusy?.(
          Object.freeze({
            visible,
            source: 'camera',
            label: 'Starting camera',
            cursor: 'wait',
          }),
        ),
      ).catch(() => {});
    } catch {
      // Presentation observers cannot change camera ownership.
    }
  }

  function stopCameraResources() {
    const errors = [];
    for (const [active, stop] of [
      [composition.isPreviewVisible, composition.hidePreview],
      [composition.isRecognizing, composition.stopRecognition],
      [composition.isCameraRunning, composition.stopCamera],
    ]) {
      try {
        if (active.call(composition)) stop.call(composition);
      } catch (error) {
        errors.push(error);
      }
    }
    previewPrepared = false;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Story camera resources could not be stopped');
    }
    return false;
  }

  async function reconcile() {
    if (!desired) return stopCameraResources();
    if (!previewPrepared) {
      composition.hidePreview();
      composition.setPreviewOpacity(dsl32FullStagePreviewOpacity);
      composition.setPreviewPosition('full-stage');
      previewPrepared = true;
    }
    if (!composition.isCameraRunning()) {
      notifyBusy(true);
      try {
        await composition.startCamera();
      } finally {
        notifyBusy(false);
      }
    }
    if (!desired) return stopCameraResources();
    return true;
  }

  function enqueue() {
    const operation = queue.catch(() => false).then(reconcile);
    queue = operation;
    return operation;
  }

  return Object.freeze({
    start() {
      if (disposed) {
        return Promise.reject(new Error('Story camera lifecycle is disposed'));
      }
      desired = true;
      return enqueue();
    },
    stop() {
      if (disposePromise) return disposePromise;
      desired = false;
      return enqueue();
    },
    dispose() {
      if (disposePromise) return disposePromise;
      desired = false;
      disposed = true;
      disposePromise = enqueue();
      return disposePromise;
    },
  });
}
