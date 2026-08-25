import {createDsl4PoseStateEvent} from '../pose-feedback-policy.js';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const feedbackModes = new Set(['scratchMirror', 'scratchBinding', 'presenter']);
const poseBindingKeys = new Set(['confidence', 'progress']);

/** @param {string} code @param {string} message */
function portError(code, message) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

/** @param {string} message */
function abortError(message) {
  const error = portError('K4-POSE-PORT-004', message);
  error.name = 'AbortError';
  return error;
}

function deferred() {
  let resolve = () => {};
  /** @type {Promise<void>} */
  const promise = new Promise((resolvePromise) => {
    resolve = () => resolvePromise();
  });
  return {promise, resolve};
}

/** @param {unknown} value @param {string} label */
function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw portError('K4-POSE-PORT-001', `${label} must be a non-empty string`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @param {(number: number) => boolean} accepts */
function requireNumber(value, label, accepts) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !accepts(value)) {
    throw portError('K4-POSE-PORT-001', `${label} is invalid`);
  }
  return value;
}

/** @param {unknown} value @param {string} label */
function requireBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw portError('K4-POSE-PORT-001', `${label} must be boolean`);
  }
  return value;
}

/** @param {unknown} value */
function validatePoseStateBinding(value) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new TypeError('pose state binding must be an object');
  const keys = Object.keys(value);
  if (
    keys.length === 0 ||
    keys.some((key) => !poseBindingKeys.has(key)) ||
    keys.some((key) => {
      const number = value[key];
      return typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1;
    })
  ) {
    throw new TypeError('pose state binding must contain normalized confidence or progress');
  }
  return /** @type {Readonly<{confidence?: number, progress?: number}>} */ (value);
}

/** @param {unknown} value */
function validateContext(value) {
  const signal = isRecord(value) ? value.signal : null;
  if (
    !isRecord(signal) ||
    typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function' ||
    typeof signal.removeEventListener !== 'function'
  ) {
    throw portError('K4-POSE-PORT-001', 'pose action signal is invalid');
  }
  const actionSignal = isRecord(value) ? (value.actionSignal ?? signal) : null;
  if (
    !isRecord(actionSignal) ||
    typeof actionSignal.aborted !== 'boolean' ||
    typeof actionSignal.addEventListener !== 'function' ||
    typeof actionSignal.removeEventListener !== 'function'
  ) {
    throw portError('K4-POSE-PORT-001', 'pose action owner signal is invalid');
  }
  return {
    signal: /** @type {AbortSignal} */ (/** @type {unknown} */ (signal)),
    actionSignal: /** @type {AbortSignal} */ (/** @type {unknown} */ (actionSignal)),
  };
}

/** @param {unknown} value */
function validateTMComposition(value) {
  const methods = [
    'activatePoseModel',
    'isPoseModelRegistered',
    'getActivePoseModelName',
    'showPreview',
    'hidePreview',
    'isPreviewVisible',
    'setPreviewPosition',
    'startRecognition',
    'stopRecognition',
    'isRecognizing',
    'confidenceOf',
    'configureAccumulatedPose',
    'resetAccumulatedPose',
    'subscribeAccumulatedPose',
  ];
  if (!isRecord(value) || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`TM composition must provide ${methods.join(', ')}`);
  }
  return /** @type {Record<string, Function>} */ (value);
}

/** @param {unknown} value */
function validateAsyncInputComposition(value) {
  if (
    !isRecord(value) ||
    typeof value.waitForPoseCandidate !== 'function' ||
    typeof value.releaseAll !== 'function'
  ) {
    throw new TypeError('Async Input composition must provide waitForPoseCandidate and releaseAll');
  }
  return /** @type {Record<string, Function>} */ (value);
}

/** @param {unknown} value */
function validateSequencePayload(value) {
  if (!isRecord(value) || !isRecord(value.recognition)) {
    throw portError('K4-POSE-PORT-001', 'waitForPose payload is invalid');
  }
  const recognition = value.recognition;
  const feedback = recognition.feedback === undefined ? {} : recognition.feedback;
  const navigation = recognition.navigation === undefined ? {} : recognition.navigation;
  if (!isRecord(feedback) || !isRecord(navigation)) {
    throw portError('K4-POSE-PORT-001', 'waitForPose policy is invalid');
  }
  const feedbackRecord = /** @type {Record<string, unknown>} */ (feedback);
  const navigationRecord = /** @type {Record<string, unknown>} */ (navigation);
  const feedbackMode =
    feedbackRecord.mode === undefined
      ? 'scratchMirror'
      : requireString(feedbackRecord.mode, 'feedback.mode');
  if (!feedbackModes.has(feedbackMode)) {
    throw portError('K4-POSE-PORT-001', 'feedback.mode is unsupported');
  }
  const stepIndex = requireNumber(
    value.stepIndex ?? 0,
    'stepIndex',
    (number) => Number.isSafeInteger(number) && number >= 0,
  );
  const stepCount = requireNumber(
    value.stepCount ?? 1,
    'stepCount',
    (number) => Number.isSafeInteger(number) && number >= 1,
  );
  if (stepIndex >= stepCount) {
    throw portError('K4-POSE-PORT-001', 'stepIndex must be less than stepCount');
  }
  return {
    target: requireString(value.target, 'target'),
    pose: requireString(value.pose, 'pose'),
    stepIndex,
    stepCount,
    poseModel: requireString(value.poseModel, 'poseModel'),
    confidenceThreshold: requireNumber(
      recognition.confidenceThreshold,
      'confidenceThreshold',
      (number) => number >= 0 && number <= 1,
    ),
    fullConfidenceHoldSeconds: requireNumber(
      recognition.fullConfidenceHoldSeconds,
      'fullConfidenceHoldSeconds',
      (number) => number > 0,
    ),
    idleChargePerSecond: requireNumber(
      recognition.idleChargePerSecond,
      'idleChargePerSecond',
      (number) => number >= 0,
    ),
    idleSound:
      recognition.idleSound === null ? null : requireString(recognition.idleSound, 'idleSound'),
    chargeSound:
      recognition.chargeSound === null
        ? null
        : requireString(recognition.chargeSound, 'chargeSound'),
    feedbackMode,
    allowSkip:
      navigationRecord.allowSkip === undefined
        ? false
        : requireBoolean(navigationRecord.allowSkip, 'navigation.allowSkip'),
  };
}

/** @param {unknown} value */
function validateSelectionPayload(value) {
  if (!isRecord(value) || !Array.isArray(value.poses) || !isRecord(value.recognition)) {
    throw portError('K4-POSE-PORT-001', 'poseInputToChangeScene payload is invalid');
  }
  const poses = value.poses.map((pose) => requireString(pose, 'pose candidate'));
  if (poses.length === 0 || new Set(poses).size !== poses.length) {
    throw portError('K4-POSE-PORT-001', 'pose candidates must be non-empty and unique');
  }
  const recognition = value.recognition;
  return {
    poses,
    poseModel: requireString(value.poseModel, 'poseModel'),
    accumulationPerSecond: requireNumber(
      recognition.accumulationPerSecond,
      'accumulationPerSecond',
      (number) => number >= 0,
    ),
    decayPerSecond: requireNumber(
      recognition.decayPerSecond,
      'decayPerSecond',
      (number) => number >= 0 && number <= 1,
    ),
    scoreThreshold: requireNumber(
      recognition.scoreThreshold,
      'scoreThreshold',
      (number) => number >= 0,
    ),
  };
}

/** @param {() => void} callback @param {number} delayMilliseconds */
function defaultSchedule(callback, delayMilliseconds) {
  const timer = setTimeout(callback, delayMilliseconds);
  return () => clearTimeout(timer);
}

/**
 * Create the two mutually exclusive DSL 4.0 pose action methods.
 *
 * @param {object} options
 * @param {unknown} options.tmComposition
 * @param {unknown} options.asyncInputComposition
 * @param {(poseModel: string) => ReadonlyArray<string> | null} options.getPoseModelLabels
 * @param {(sound: string, options?: Readonly<{untilDone?: boolean}>) => unknown | Promise<unknown>} [options.playSound]
 * @param {(sound: string) => unknown | Promise<unknown>} [options.stopSound]
 * @param {(payload: Readonly<{visible: boolean, source: string, label: string, cursor?: string}>) => unknown | Promise<unknown>} [options.setBusy]
 * @param {(payload: Readonly<{visible: boolean, source: string, cursor: string}>) => unknown | Promise<unknown>} [options.setCursor]
 * @param {() => Promise<unknown>} [options.ensureCameraStarted]
 * @param {(event: Readonly<{phase: 'waiting' | 'charging' | 'completed' | 'cancelled', target: string, pose: string, stepIndex: number, confidence: number, progress: number}>) => unknown} [options.onPoseState]
 * @param {() => Readonly<{confidence?: number, progress?: number}> | null} [options.readPoseStateBinding]
 * @param {(callback: () => void, delayMilliseconds: number) => () => void} [options.schedule]
 * @param {() => number} [options.now]
 */
export function createDsl4PoseActionPort(options) {
  if (!isRecord(options)) throw new TypeError('pose action port options must be an object');
  const tmComposition = validateTMComposition(options.tmComposition);
  const asyncInput = validateAsyncInputComposition(options.asyncInputComposition);
  if (typeof options.getPoseModelLabels !== 'function') {
    throw new TypeError('getPoseModelLabels must be a function');
  }
  const getPoseModelLabels = options.getPoseModelLabels;
  const playSound = options.playSound ?? (() => undefined);
  const stopSound = options.stopSound ?? (() => undefined);
  const setBusy = options.setBusy;
  const setCursor = options.setCursor;
  const ensureCameraStarted = options.ensureCameraStarted;
  const onPoseState = options.onPoseState;
  const readPoseStateBinding = options.readPoseStateBinding;
  const schedule = options.schedule ?? defaultSchedule;
  const now = options.now ?? (() => performance.now());
  for (const [name, value] of Object.entries({playSound, stopSound, schedule, now})) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (onPoseState !== undefined && typeof onPoseState !== 'function') {
    throw new TypeError('onPoseState must be a function');
  }
  if (readPoseStateBinding !== undefined && typeof readPoseStateBinding !== 'function') {
    throw new TypeError('readPoseStateBinding must be a function');
  }

  if (setBusy !== undefined && typeof setBusy !== 'function') {
    throw new TypeError('setBusy must be a function');
  }
  if (setCursor !== undefined && typeof setCursor !== 'function') {
    throw new TypeError('setCursor must be a function');
  }
  if (ensureCameraStarted !== undefined && typeof ensureCameraStarted !== 'function') {
    throw new TypeError('ensureCameraStarted must be a function');
  }

  let released = false;
  /** @type {null | {controller: AbortController, done: Promise<void>, finish: () => void}} */
  let activeSequence = null;
  /** @type {null | {controller: AbortController, done: Promise<void>, finish: () => void, wake: null | (() => void), detach: () => void}} */
  let currentSelection = null;
  /** @type {Promise<void> | null} */
  let disposePromise = null;
  /** @type {Promise<void>} */
  let recognitionQueue = Promise.resolve();
  /** @type {null | {sound: string, operation: Promise<unknown>}} */
  let chargePlayback = null;
  let poseCursorId = 0;
  const previewOwners = new Set();
  /** @type {null | {signal: AbortSignal, owner: object, handleAbort: () => void}} */
  let sequencePreview = null;

  function ensureAvailable() {
    if (released) throw portError('K4-POSE-PORT-005', 'pose action port has been released');
  }

  /** @param {unknown} owner */
  function claimPreview(owner) {
    previewOwners.add(owner);
    tmComposition.setPreviewPosition('full-stage');
  }

  /** @param {unknown} owner */
  function showClaimedPreview(owner) {
    if (previewOwners.has(owner)) tmComposition.showPreview();
  }

  /** @param {unknown} owner */
  function releasePreview(owner) {
    previewOwners.delete(owner);
    if (previewOwners.size === 0) tmComposition.hidePreview();
  }

  /** @param {object} owner */
  function releaseSequencePreview(owner) {
    const lease = sequencePreview;
    if (!lease || lease.owner !== owner) return;
    sequencePreview = null;
    lease.signal.removeEventListener('abort', lease.handleAbort);
    releasePreview(owner);
  }

  /** @param {AbortSignal} signal */
  function claimSequencePreview(signal) {
    if (sequencePreview?.signal === signal) return sequencePreview.owner;
    if (sequencePreview) releaseSequencePreview(sequencePreview.owner);
    const owner = {};
    const handleAbort = () => releaseSequencePreview(owner);
    sequencePreview = {signal, owner, handleAbort};
    claimPreview(owner);
    signal.addEventListener('abort', handleAbort, {once: true});
    if (signal.aborted) handleAbort();
    return owner;
  }

  /**
   * @param {ReturnType<typeof validateSequencePayload>} input
   * @param {'waiting' | 'charging' | 'completed' | 'cancelled'} phase
   * @param {number} confidence
   * @param {number} progress
   */
  function publishPoseState(input, phase, confidence, progress) {
    if (!onPoseState) return;
    const event = createDsl4PoseStateEvent({
      phase,
      target: input.target,
      pose: input.pose,
      stepIndex: input.stepIndex,
      confidence,
      progress,
    });
    try {
      Promise.resolve(onPoseState(event)).catch(() => {});
    } catch {
      // A non-authoritative observer cannot change pose execution semantics.
    }
  }

  function readPoseBinding() {
    if (!readPoseStateBinding) return null;
    try {
      return validatePoseStateBinding(readPoseStateBinding());
    } catch {
      // Invalid or failed bindings are ignored at the authoritative tick boundary.
      return null;
    }
  }

  /** @param {boolean} visible */
  function notifyCameraBusy(visible) {
    if (!setBusy) return;
    try {
      void Promise.resolve(
        setBusy(
          Object.freeze({
            visible,
            source: 'camera',
            label: 'Starting camera',
            cursor: 'wait',
          }),
        ),
      ).catch(() => {});
    } catch {
      // Busy indicators are non-authoritative and cannot change pose execution semantics.
    }
  }

  /** @param {boolean} visible @param {string} [source] */
  function notifyPoseCursor(visible, source = 'pose') {
    if (!setCursor) return;
    try {
      void Promise.resolve(
        setCursor(
          Object.freeze({
            visible,
            source,
            cursor: 'progress',
          }),
        ),
      ).catch(() => {});
    } catch {
      // Cursor styling is non-authoritative and cannot change pose execution semantics.
    }
  }

  /**
   * Start a sound without making pose recognition or input cancellation wait for audio playback.
   * Synchronous startup failures remain authoritative; later playback failures are contained because
   * an already-running pose step cannot safely be rolled back from an audio callback.
   *
   * @param {string} sound
   * @param {Readonly<{untilDone?: boolean}>} [playOptions]
   */
  function startBackgroundSound(sound, playOptions) {
    const operation = Promise.resolve(playSound(sound, playOptions));
    void operation.catch(() => {});
    return operation;
  }

  /** @param {string} sound */
  function requestSoundStop(sound) {
    try {
      void Promise.resolve(stopSound(sound)).catch(() => {});
    } catch {
      // Sound cleanup cannot delay or replace the pose action's terminal result.
    }
  }

  /** @param {string} sound */
  function startChargeSound(sound) {
    if (chargePlayback) return;
    const playback = {sound, operation: startBackgroundSound(sound, {untilDone: true})};
    chargePlayback = playback;
    void playback.operation.then(
      () => {
        if (chargePlayback === playback) chargePlayback = null;
      },
      () => {
        if (chargePlayback === playback) chargePlayback = null;
      },
    );
  }

  function stopChargeSound() {
    const playback = chargePlayback;
    if (!playback) return;
    chargePlayback = null;
    requestSoundStop(playback.sound);
  }

  /** @template T @param {() => Promise<T>} operation */
  async function withCameraBusy(operation) {
    notifyCameraBusy(true);
    try {
      return await operation();
    } finally {
      notifyCameraBusy(false);
    }
  }

  /** @param {string} poseModel @param {ReadonlyArray<string>} poses */
  function requireKnownPoses(poseModel, poses) {
    if (!tmComposition.isPoseModelRegistered(poseModel)) {
      throw portError('K4-POSE-PORT-002', `Pose model is not registered: ${poseModel}`);
    }
    const labels = getPoseModelLabels(poseModel);
    if (!Array.isArray(labels)) {
      throw portError('K4-POSE-PORT-002', `Pose model labels are unavailable: ${poseModel}`);
    }
    for (const pose of poses) {
      if (!labels.includes(pose)) {
        throw portError('K4-POSE-PORT-003', `Unknown pose ${pose} in model ${poseModel}`);
      }
    }
  }

  /**
   * @param {Promise<void>} operation
   * @param {AbortSignal} signal
   * @param {string} message
   */
  function waitForAbortableOperation(operation, signal, message) {
    if (signal.aborted) return Promise.reject(abortError(message));
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal.removeEventListener('abort', handleAbort);
      const handleAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(abortError(message));
      };
      signal.addEventListener('abort', handleAbort, {once: true});
      operation.then(
        () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(undefined);
        },
        (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
      if (signal.aborted) handleAbort();
    });
  }

  /**
   * Serialize camera/model startup because TM does not accept an AbortSignal. Each caller may
   * stop waiting immediately while an already-started camera request remains shared by later steps.
   *
   * @param {string} poseModel
   * @param {AbortSignal} signal
   * @param {object} options
   * @param {boolean} [options.restart]
   * @param {() => void} [options.configure]
   * @param {string} options.cancelMessage
   */
  function queueRecognition(
    poseModel,
    signal,
    {restart = false, configure = () => {}, cancelMessage},
  ) {
    const operation = recognitionQueue
      .catch(() => {})
      .then(async () => {
        if (signal.aborted) throw abortError(cancelMessage);
        if (restart && tmComposition.isRecognizing()) tmComposition.stopRecognition();
        if (tmComposition.getActivePoseModelName() !== poseModel) {
          if (tmComposition.isRecognizing()) tmComposition.stopRecognition();
          tmComposition.activatePoseModel(poseModel);
        }
        configure();
        if (signal.aborted) throw abortError(cancelMessage);
        if (!tmComposition.isRecognizing()) {
          if (ensureCameraStarted) {
            await ensureCameraStarted();
            await tmComposition.startRecognition();
          } else {
            await withCameraBusy(() => tmComposition.startRecognition());
          }
        }
        if (signal.aborted) throw abortError(cancelMessage);
      });
    recognitionQueue = operation;
    return waitForAbortableOperation(operation, signal, cancelMessage);
  }

  /** @param {string} poseModel @param {AbortSignal} signal */
  function ensureRecognition(poseModel, signal) {
    return queueRecognition(poseModel, signal, {cancelMessage: 'pose action was cancelled'});
  }

  /** @param {ReturnType<typeof validateSelectionPayload>} input @param {AbortSignal} signal */
  function startSelectionRecognition(input, signal) {
    return queueRecognition(input.poseModel, signal, {
      restart: true,
      cancelMessage: 'pose candidate wait was cancelled',
      configure() {
        tmComposition.configureAccumulatedPose({
          accumulationPerSecond: input.accumulationPerSecond,
          decayPerSecond: input.decayPerSecond,
          scoreThreshold: input.scoreThreshold,
        });
      },
    });
  }

  /** @param {AbortSignal} signal */
  function waitForTick(signal) {
    if (signal.aborted) return Promise.reject(abortError('pose sequence was cancelled'));
    return new Promise((resolve, reject) => {
      let cancel = () => {};
      const cleanup = () => {
        cancel();
        signal.removeEventListener('abort', handleAbort);
      };
      const handleAbort = () => {
        cleanup();
        reject(abortError('pose sequence was cancelled'));
      };
      signal.addEventListener('abort', handleAbort, {once: true});
      cancel = schedule(() => {
        cleanup();
        resolve(now());
      }, 100);
      if (typeof cancel !== 'function') {
        cleanup();
        reject(portError('K4-POSE-PORT-001', 'schedule must return a cancellation function'));
      }
    });
  }

  /** @param {AbortSignal} externalSignal */
  function createOperation(externalSignal) {
    const controller = new AbortController();
    const completion = deferred();
    const forwardAbort = () => controller.abort(externalSignal.reason);
    externalSignal.addEventListener('abort', forwardAbort, {once: true});
    if (externalSignal.aborted) forwardAbort();
    return {
      controller,
      done: completion.promise,
      finish: completion.resolve,
      detach() {
        externalSignal.removeEventListener('abort', forwardAbort);
      },
    };
  }

  /** @param {ReturnType<typeof createOperation> & {wake: null | (() => void)}} selection */
  function waitForSequenceEnd(selection) {
    if (!activeSequence) return Promise.resolve();
    /** @type {Promise<void>} */
    return new Promise((resolve, reject) => {
      const handleAbort = () => {
        selection.controller.signal.removeEventListener('abort', handleAbort);
        selection.wake = null;
        reject(abortError('pose candidate wait was cancelled'));
      };
      selection.wake = () => {
        selection.controller.signal.removeEventListener('abort', handleAbort);
        selection.wake = null;
        resolve();
      };
      selection.controller.signal.addEventListener('abort', handleAbort, {once: true});
      if (selection.controller.signal.aborted) handleAbort();
    });
  }

  const port = {
    /** @param {unknown} payload @param {unknown} context */
    async waitForPose(payload, context) {
      ensureAvailable();
      const input = validateSequencePayload(payload);
      const {signal: externalSignal, actionSignal} = validateContext(context);
      if (externalSignal.aborted || actionSignal.aborted) {
        throw abortError('pose sequence was cancelled');
      }
      requireKnownPoses(input.poseModel, [input.pose]);
      if (activeSequence) {
        throw portError('K4-POSE-PORT-006', 'another Actor pose sequence is already active');
      }

      const operation = createOperation(externalSignal);
      activeSequence = operation;
      const previewOwner = claimSequencePreview(actionSignal);
      const displacedSelection = currentSelection;
      displacedSelection?.controller.abort('actor-sequence-priority');
      let confidence = 0;
      let progress = 0;
      let statePublished = false;
      let terminalPhase = /** @type {'completed' | 'cancelled'} */ ('cancelled');
      try {
        publishPoseState(input, 'waiting', confidence, progress);
        statePublished = true;
        notifyPoseCursor(true, 'pose-sequence');
        if (displacedSelection) await displacedSelection.done;
        await ensureRecognition(input.poseModel, operation.controller.signal);
        showClaimedPreview(previewOwner);
        if (input.idleSound) startBackgroundSound(input.idleSound);
        if (operation.controller.signal.aborted) throw abortError('pose sequence was cancelled');
        let previousTime = now();
        while (progress < 1) {
          const timestamp = /** @type {number} */ (await waitForTick(operation.controller.signal));
          const elapsedSeconds = Math.max(0, (timestamp - previousTime) / 1000);
          previousTime = timestamp;
          const binding = input.feedbackMode === 'scratchBinding' ? readPoseBinding() : null;
          const measuredConfidence = Number(tmComposition.confidenceOf(input.pose));
          if (
            !Number.isFinite(measuredConfidence) ||
            measuredConfidence < 0 ||
            measuredConfidence > 1
          ) {
            throw portError('K4-POSE-PORT-007', 'TM returned an invalid confidence');
          }
          confidence = binding?.confidence ?? measuredConfidence;
          progress = binding?.progress ?? progress;
          if (confidence >= input.confidenceThreshold) {
            progress += (confidence / input.fullConfidenceHoldSeconds) * elapsedSeconds;
            if (input.chargeSound) startChargeSound(input.chargeSound);
          } else {
            progress += input.idleChargePerSecond * elapsedSeconds;
          }
          progress = Math.min(1, progress);
          publishPoseState(
            input,
            confidence >= input.confidenceThreshold ? 'charging' : 'waiting',
            confidence,
            progress,
          );
        }
        terminalPhase = 'completed';
      } finally {
        const continuesToNextStep =
          input.stepIndex + 1 < input.stepCount &&
          (terminalPhase === 'completed' || (externalSignal.aborted && !actionSignal.aborted));
        if (!continuesToNextStep) releaseSequencePreview(previewOwner);
        if (statePublished) {
          statePublished = false;
          publishPoseState(input, terminalPhase, confidence, progress);
          notifyPoseCursor(false, 'pose-sequence');
        }
        if (input.idleSound) requestSoundStop(input.idleSound);
        if (!continuesToNextStep) stopChargeSound();
        operation.detach();
        if (activeSequence === operation) activeSequence = null;
        operation.finish();
        currentSelection?.wake?.();
      }
    },

    /** @param {unknown} payload @param {unknown} context */
    async poseInputToChangeScene(payload, context) {
      ensureAvailable();
      const input = validateSelectionPayload(payload);
      const {signal: externalSignal} = validateContext(context);
      if (externalSignal.aborted) throw abortError('pose candidate wait was cancelled');
      requireKnownPoses(input.poseModel, input.poses);

      const operation =
        /** @type {ReturnType<typeof createOperation> & {wake: null | (() => void)}} */ (
          Object.assign(createOperation(externalSignal), {wake: null})
        );
      const previousSelection = currentSelection;
      claimPreview(operation);
      previousSelection?.controller.abort('newer-pose-candidate-wait');
      currentSelection = operation;
      poseCursorId += 1;
      const cursorSource = `pose-selection-${poseCursorId}`;
      notifyPoseCursor(true, cursorSource);
      try {
        if (previousSelection) await previousSelection.done;
        await waitForSequenceEnd(operation);
        if (operation.controller.signal.aborted) {
          throw abortError('pose candidate wait was cancelled');
        }
        await startSelectionRecognition(input, operation.controller.signal);
        showClaimedPreview(operation);
        const selected = await asyncInput.waitForPoseCandidate({
          candidates: input.poses,
          signal: operation.controller.signal,
        });
        if (operation.controller.signal.aborted) {
          throw abortError('pose candidate wait was cancelled');
        }
        if (!input.poses.includes(selected)) {
          throw portError('K4-POSE-PORT-008', `Async Input returned an unknown pose: ${selected}`);
        }
        return selected;
      } finally {
        releasePreview(operation);
        notifyPoseCursor(false, cursorSource);
        operation.detach();
        operation.wake = null;
        if (currentSelection === operation) currentSelection = null;
        operation.finish();
      }
    },

    dispose() {
      if (disposePromise) return disposePromise;
      released = true;
      const sequence = activeSequence;
      const selection = currentSelection;
      sequence?.controller.abort('pose-port-dispose');
      selection?.controller.abort('pose-port-dispose');
      selection?.wake?.();
      stopChargeSound();
      if (sequencePreview) releaseSequencePreview(sequencePreview.owner);
      disposePromise = Promise.all([sequence?.done, selection?.done].filter(Boolean)).then(
        () => undefined,
      );
      return disposePromise;
    },
  };

  return Object.freeze(port);
}
