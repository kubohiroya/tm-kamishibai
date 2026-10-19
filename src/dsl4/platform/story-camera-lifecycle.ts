import {type Dsl4CompositionMethod, validateCompositionMethods} from './composition-contract.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const recognitionCommands = new Set(['pose', 'poseInputToChangeScene', 'imageInputToChangeScene']);
const dsl32FullStagePreviewOpacity = 0.2;

export function storyUsesPoseRecognition(storyDocument: unknown) {
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
 */
export function createDsl4StoryCameraLifecycle(options: unknown) {
  if (!isRecord(options) || !isRecord(options.composition)) {
    throw new TypeError('story camera lifecycle options and composition are required');
  }
  const composition = options.composition as Record<
    (typeof methods)[number],
    Dsl4CompositionMethod
  >;
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
  ] as const;
  validateCompositionMethods(options.composition, 'story camera composition', methods);
  if (options.setBusy !== undefined && typeof options.setBusy !== 'function') {
    throw new TypeError('setBusy must be a function');
  }
  const setBusy = options.setBusy as
    | ((
        payload: Readonly<{visible: boolean; source: string; label: string; cursor: string}>,
      ) => unknown)
    | undefined;

  let desired = false;
  let disposed = false;
  let previewPrepared = false;
  let generation = 0;
  let openingCamera: Promise<unknown> | null = null;
  let cancelCameraWait: (() => void) | null = null;
  let queue: Promise<boolean> = Promise.resolve(false);
  let disposePromise: Promise<boolean> | null = null;

  function notifyBusy(visible: boolean) {
    try {
      void Promise.resolve(
        setBusy?.(
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
    // Validated above, and each pair is read once so the stop only runs while the state is active.
    for (const [active, stop] of [
      [composition.isPreviewVisible, composition.hidePreview],
      [composition.isRecognizing, composition.stopRecognition],
      [composition.isCameraRunning, composition.stopCamera],
    ] as ReadonlyArray<[Dsl4CompositionMethod, Dsl4CompositionMethod]>) {
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

  function cameraStartup() {
    if (openingCamera) return openingCamera;
    const opening = Promise.resolve(composition.startCamera()).then(() => {
      // Browser permission requests cannot be aborted. Reclaim a late result after the
      // story has stopped, while leaving a new claim on this composition intact.
      if (!desired) stopCameraResources();
    });
    openingCamera = opening;
    const clearOpening = () => {
      if (openingCamera === opening) openingCamera = null;
    };
    void opening.then(clearOpening, clearOpening);
    return opening;
  }

  async function reconcile(expectedGeneration: number) {
    if (disposed || expectedGeneration !== generation) return false;
    if (!desired) return stopCameraResources();
    if (!previewPrepared) {
      composition.hidePreview();
      composition.setPreviewOpacity(dsl32FullStagePreviewOpacity);
      composition.setPreviewPosition('full-stage');
      previewPrepared = true;
    }
    if (!composition.isCameraRunning()) {
      notifyBusy(true);
      let cancel = () => {};
      const cancelled = new Promise<false>((resolve) => {
        cancel = () => resolve(false);
      });
      cancelCameraWait = cancel;
      try {
        const started = await Promise.race([cameraStartup().then(() => true), cancelled]);
        if (!started || expectedGeneration !== generation) return false;
      } finally {
        if (cancelCameraWait === cancel) cancelCameraWait = null;
        notifyBusy(false);
      }
    }
    if (!desired) return stopCameraResources();
    return true;
  }

  function enqueue() {
    const expectedGeneration = generation;
    const operation = queue.catch(() => false).then(() => reconcile(expectedGeneration));
    queue = operation;
    return operation;
  }

  function stopNow() {
    desired = false;
    generation += 1;
    cancelCameraWait?.();
    // Do not enqueue cleanup behind getUserMedia: the person may never answer its prompt.
    try {
      return Promise.resolve(stopCameraResources());
    } catch (error) {
      return Promise.reject(error);
    }
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
      return stopNow();
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      disposePromise = stopNow();
      return disposePromise;
    },
  });
}
