/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  return /** @type {AbortSignal} */ (/** @type {unknown} */ (signal));
}

/** @param {unknown} value */
function validateTMPoseComposition(value) {
  const methods = [
    'activatePoseModel',
    'isPoseModelRegistered',
    'getActivePoseModelName',
    'startRecognition',
    'stopRecognition',
    'isRecognizing',
    'confidenceOf',
    'configureAccumulatedPose',
    'resetAccumulatedPose',
    'subscribeAccumulatedPose',
  ];
  if (!isRecord(value) || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`TMPose composition must provide ${methods.join(', ')}`);
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
  return {
    pose: requireString(value.pose, 'pose'),
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
 * @param {unknown} options.tmposeComposition
 * @param {unknown} options.asyncInputComposition
 * @param {(poseModel: string) => ReadonlyArray<string> | null} options.getPoseModelLabels
 * @param {(sound: string) => unknown | Promise<unknown>} [options.playSound]
 * @param {(sound: string) => unknown | Promise<unknown>} [options.stopSound]
 * @param {(callback: () => void, delayMilliseconds: number) => () => void} [options.schedule]
 * @param {() => number} [options.now]
 */
export function createDsl4PoseActionPort(options) {
  if (!isRecord(options)) throw new TypeError('pose action port options must be an object');
  const tmpose = validateTMPoseComposition(options.tmposeComposition);
  const asyncInput = validateAsyncInputComposition(options.asyncInputComposition);
  if (typeof options.getPoseModelLabels !== 'function') {
    throw new TypeError('getPoseModelLabels must be a function');
  }
  const getPoseModelLabels = options.getPoseModelLabels;
  const playSound = options.playSound ?? (() => undefined);
  const stopSound = options.stopSound ?? (() => undefined);
  const schedule = options.schedule ?? defaultSchedule;
  const now = options.now ?? (() => performance.now());
  for (const [name, value] of Object.entries({playSound, stopSound, schedule, now})) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }

  let released = false;
  /** @type {null | {controller: AbortController, done: Promise<void>, finish: () => void}} */
  let activeSequence = null;
  /** @type {null | {controller: AbortController, done: Promise<void>, finish: () => void, wake: null | (() => void), detach: () => void}} */
  let currentSelection = null;
  /** @type {Promise<void> | null} */
  let disposePromise = null;

  function ensureAvailable() {
    if (released) throw portError('K4-POSE-PORT-005', 'pose action port has been released');
  }

  /** @param {string} poseModel @param {ReadonlyArray<string>} poses */
  function requireKnownPoses(poseModel, poses) {
    if (!tmpose.isPoseModelRegistered(poseModel)) {
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

  /** @param {string} poseModel @param {AbortSignal} signal */
  async function ensureRecognition(poseModel, signal) {
    if (signal.aborted) throw abortError('pose action was cancelled');
    if (tmpose.getActivePoseModelName() !== poseModel) {
      if (tmpose.isRecognizing()) tmpose.stopRecognition();
      tmpose.activatePoseModel(poseModel);
    }
    if (!tmpose.isRecognizing()) await tmpose.startRecognition();
    if (signal.aborted) throw abortError('pose action was cancelled');
  }

  /** @param {ReturnType<typeof validateSelectionPayload>} input @param {AbortSignal} signal */
  async function startSelectionRecognition(input, signal) {
    if (signal.aborted) throw abortError('pose candidate wait was cancelled');
    if (tmpose.isRecognizing()) tmpose.stopRecognition();
    if (tmpose.getActivePoseModelName() !== input.poseModel) {
      tmpose.activatePoseModel(input.poseModel);
    }
    tmpose.configureAccumulatedPose({
      accumulationPerSecond: input.accumulationPerSecond,
      decayPerSecond: input.decayPerSecond,
      scoreThreshold: input.scoreThreshold,
    });
    await tmpose.startRecognition();
    if (signal.aborted) throw abortError('pose candidate wait was cancelled');
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
      const externalSignal = validateContext(context);
      if (externalSignal.aborted) throw abortError('pose sequence was cancelled');
      requireKnownPoses(input.poseModel, [input.pose]);
      if (activeSequence) {
        throw portError('K4-POSE-PORT-006', 'another Actor pose sequence is already active');
      }

      const operation = createOperation(externalSignal);
      activeSequence = operation;
      const displacedSelection = currentSelection;
      displacedSelection?.controller.abort('actor-sequence-priority');
      try {
        if (displacedSelection) await displacedSelection.done;
        await ensureRecognition(input.poseModel, operation.controller.signal);
        if (input.idleSound) await playSound(input.idleSound);
        if (operation.controller.signal.aborted) throw abortError('pose sequence was cancelled');
        let progress = 0;
        let previousTime = now();
        while (progress < 1) {
          const timestamp = /** @type {number} */ (await waitForTick(operation.controller.signal));
          const elapsedSeconds = Math.max(0, (timestamp - previousTime) / 1000);
          previousTime = timestamp;
          const confidence = Number(tmpose.confidenceOf(input.pose));
          if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
            throw portError('K4-POSE-PORT-007', 'TMPose returned an invalid confidence');
          }
          if (confidence >= input.confidenceThreshold) {
            progress += (confidence / input.fullConfidenceHoldSeconds) * elapsedSeconds;
            if (input.chargeSound) await playSound(input.chargeSound);
            if (operation.controller.signal.aborted) {
              throw abortError('pose sequence was cancelled');
            }
          } else {
            progress += input.idleChargePerSecond * elapsedSeconds;
          }
        }
      } finally {
        try {
          if (input.idleSound) await stopSound(input.idleSound);
        } finally {
          operation.detach();
          if (activeSequence === operation) activeSequence = null;
          operation.finish();
          currentSelection?.wake?.();
        }
      }
    },

    /** @param {unknown} payload @param {unknown} context */
    async poseInputToChangeScene(payload, context) {
      ensureAvailable();
      const input = validateSelectionPayload(payload);
      const externalSignal = validateContext(context);
      if (externalSignal.aborted) throw abortError('pose candidate wait was cancelled');
      requireKnownPoses(input.poseModel, input.poses);

      const operation =
        /** @type {ReturnType<typeof createOperation> & {wake: null | (() => void)}} */ (
          Object.assign(createOperation(externalSignal), {wake: null})
        );
      const previousSelection = currentSelection;
      previousSelection?.controller.abort('newer-pose-candidate-wait');
      currentSelection = operation;
      try {
        if (previousSelection) await previousSelection.done;
        await waitForSequenceEnd(operation);
        if (operation.controller.signal.aborted) {
          throw abortError('pose candidate wait was cancelled');
        }
        await startSelectionRecognition(input, operation.controller.signal);
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
      disposePromise = Promise.all([sequence?.done, selection?.done].filter(Boolean)).then(
        () => undefined,
      );
      return disposePromise;
    },
  };

  return Object.freeze(port);
}
