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

/** @param {unknown} [cause] */
function abortError(cause) {
  const error = new Error('DSL 4.0 media action was cancelled');
  error.name = 'AbortError';
  if (cause !== undefined) Object.defineProperty(error, 'cause', {value: cause});
  return error;
}

function createDefaultScheduler() {
  /** @param {() => void} callback @param {number} milliseconds */
  const schedule = (callback, milliseconds) => setTimeout(callback, milliseconds);
  /** @param {unknown} handle */
  const cancel = (handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle));
  return Object.freeze({
    setTimeout: schedule,
    clearTimeout: cancel,
  });
}

/** @param {unknown} value */
function validateScheduler(value) {
  if (
    !isRecord(value) ||
    typeof value.setTimeout !== 'function' ||
    typeof value.clearTimeout !== 'function'
  ) {
    throw new TypeError('Media action scheduler must provide setTimeout and clearTimeout');
  }
  return /** @type {{setTimeout: (callback: () => void, milliseconds: number) => unknown, clearTimeout: (handle: unknown) => void}} */ (
    /** @type {unknown} */ (value)
  );
}

/** @param {unknown} value */
function validateComposition(value) {
  const methods = [
    'isRegistered',
    'getMimeType',
    'applyToStage',
    'applyToTarget',
    'playSound',
    'stopSound',
  ];
  if (!isRecord(value) || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`Asset Manager composition must provide ${methods.join(', ')}`);
  }
  return /** @type {Record<string, Function>} */ (value);
}

/** @param {unknown} value @param {string[]} keys @param {string} command */
function validatePayload(value, keys, command) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw portError(
      'K4-MEDIA-PORT-001',
      `${command} payload must provide exactly ${keys.join(', ')}`,
    );
  }
  for (const key of keys) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw portError('K4-MEDIA-PORT-001', `${command}.${key} must be a non-empty string`);
    }
  }
  return /** @type {Record<string, string>} */ (/** @type {unknown} */ (value));
}

/** @param {unknown} value */
function validateContext(value) {
  if (!isRecord(value) || !isRecord(value.signal)) {
    throw portError('K4-MEDIA-PORT-001', 'media action context must provide an AbortSignal');
  }
  const signal = value.signal;
  if (
    typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function' ||
    typeof signal.removeEventListener !== 'function'
  ) {
    throw portError('K4-MEDIA-PORT-001', 'media action signal is invalid');
  }
  return /** @type {AbortSignal} */ (/** @type {unknown} */ (signal));
}

/**
 * Race one platform operation with action cancellation and contain stale settlement.
 *
 * @template T
 * @param {() => T | Promise<T>} start
 * @param {AbortSignal} signal
 * @param {(() => unknown) | undefined} [cancel]
 */
async function runCancellable(start, signal, cancel) {
  if (signal.aborted) throw abortError();
  /** @type {(error: Error) => void} */
  let rejectAbort = () => {};
  let cancelled = false;
  const aborted = new Promise((_resolve, reject) => {
    rejectAbort = reject;
  });
  const handleAbort = () => {
    if (cancelled) return;
    cancelled = true;
    let cleanupError;
    try {
      cancel?.();
    } catch (error) {
      cleanupError = error;
    }
    rejectAbort(abortError(cleanupError));
  };
  signal.addEventListener('abort', handleAbort, {once: true});
  if (signal.aborted) {
    signal.removeEventListener('abort', handleAbort);
    throw abortError();
  }

  let operation;
  try {
    operation = Promise.resolve(start());
  } catch (error) {
    signal.removeEventListener('abort', handleAbort);
    throw error;
  }
  void operation.catch(() => {});
  try {
    return await /** @type {Promise<T>} */ (Promise.race([operation, aborted]));
  } finally {
    signal.removeEventListener('abort', handleAbort);
  }
}

/**
 * Adapt DSL 4.0 media actions to one app-shell-scoped Asset Manager composition.
 *
 * @param {object} options
 * @param {unknown} options.composition
 * @param {(actorId: string, context: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} options.resolveActor
 * @param {(actor: unknown, scale: number, context: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.setActorScale]
 * @param {unknown} [options.scheduler]
 * @param {(error: unknown) => unknown} [options.onBackgroundError]
 */
export function createDsl4MediaActionPort(options) {
  if (!isRecord(options)) throw new TypeError('media action port options must be an object');
  const composition = validateComposition(options.composition);
  if (typeof options.resolveActor !== 'function') {
    throw new TypeError('resolveActor must be a function');
  }
  const resolveActor = options.resolveActor;
  if (options.setActorScale !== undefined && typeof options.setActorScale !== 'function') {
    throw new TypeError('setActorScale must be a function');
  }
  const setActorScale = options.setActorScale;
  if (options.onBackgroundError !== undefined && typeof options.onBackgroundError !== 'function') {
    throw new TypeError('onBackgroundError must be a function');
  }
  const onBackgroundError = options.onBackgroundError ?? (() => {});
  const scheduler = validateScheduler(options.scheduler ?? createDefaultScheduler());
  /** @type {Map<string, {timer?: unknown, active: boolean}>} */
  const actorLoops = new Map();
  /** @type {Map<string, Promise<unknown>>} */
  const actorSkinQueues = new Map();

  /** @param {string} target @param {() => unknown | Promise<unknown>} apply */
  function enqueueActorSkin(target, apply) {
    const previous = actorSkinQueues.get(target) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(apply);
    actorSkinQueues.set(target, operation);
    void operation.then(
      () => {
        if (actorSkinQueues.get(target) === operation) actorSkinQueues.delete(target);
      },
      () => {
        if (actorSkinQueues.get(target) === operation) actorSkinQueues.delete(target);
      },
    );
    return operation;
  }

  /** @param {string} target */
  function waitForActorSkin(target) {
    const operation = actorSkinQueues.get(target);
    return operation === undefined
      ? Promise.resolve()
      : operation.then(
          () => {},
          () => {},
        );
  }

  /** @param {string} target @param {{timer?: unknown, active: boolean}} [expectedLoop] */
  function stopLoop(target, expectedLoop) {
    const loop = actorLoops.get(target);
    if (expectedLoop !== undefined && loop !== expectedLoop) return waitForActorSkin(target);
    if (!loop) return waitForActorSkin(target);
    loop.active = false;
    if (loop.timer !== undefined) scheduler.clearTimeout(loop.timer);
    if (actorLoops.get(target) === loop) actorLoops.delete(target);
    return waitForActorSkin(target);
  }

  function stopAllLoops() {
    return Promise.all([...actorLoops.keys()].map((target) => stopLoop(target))).then(() => {});
  }

  /** @param {string} assetId @param {'image' | 'audio'} kind */
  function requireAsset(assetId, kind) {
    if (!composition.isRegistered(assetId)) {
      throw portError('K4-MEDIA-PORT-002', `Media asset is not registered: ${assetId}`);
    }
    const mimeType = composition.getMimeType(assetId);
    if (typeof mimeType !== 'string' || !mimeType.startsWith(`${kind}/`)) {
      throw portError('K4-MEDIA-PORT-002', `Media asset ${assetId} must have ${kind} MIME type`);
    }
  }

  /** @param {unknown} value @param {string} actorId */
  function validateActor(value, actorId) {
    if (
      !isRecord(value) ||
      typeof value.id !== 'string' ||
      value.id.length === 0 ||
      value.isStage !== false
    ) {
      throw portError('K4-MEDIA-PORT-003', `Actor target is unavailable: ${actorId}`);
    }
    return /** @type {Readonly<{id: string, isStage: false}>} */ (/** @type {unknown} */ (value));
  }

  return Object.freeze({
    /** @param {unknown} payload @param {unknown} context */
    stage(payload, context) {
      const {backdrop} = validatePayload(payload, ['backdrop'], 'stage');
      const signal = validateContext(context);
      if (signal.aborted) throw abortError();
      requireAsset(backdrop, 'image');
      return runCancellable(() => composition.applyToStage(backdrop), signal);
    },

    /** @param {unknown} payload @param {unknown} context */
    bgm(payload, context) {
      const {sound} = validatePayload(payload, ['sound'], 'bgm');
      const signal = validateContext(context);
      if (signal.aborted) throw abortError();
      requireAsset(sound, 'audio');
      return runCancellable(
        () => composition.playSound(sound),
        signal,
        () => composition.stopSound(sound),
      );
    },

    /** @param {unknown} payload @param {unknown} context */
    sound(payload, context) {
      const {sound} = validatePayload(payload, ['sound'], 'sound');
      const signal = validateContext(context);
      if (signal.aborted) throw abortError();
      requireAsset(sound, 'audio');
      return runCancellable(
        () => composition.playSound(sound, {untilDone: true}),
        signal,
        () => composition.stopSound(sound),
      );
    },

    /** @param {unknown} payload @param {unknown} context */
    async setSkin(payload, context) {
      if (
        !isRecord(payload) ||
        Object.keys(payload).some((key) => !['target', 'skin', 'scale'].includes(key)) ||
        !Object.hasOwn(payload, 'target') ||
        !Object.hasOwn(payload, 'skin')
      ) {
        throw portError(
          'K4-MEDIA-PORT-001',
          'setSkin payload must provide target, skin, and only optional scale',
        );
      }
      const target = payload.target;
      const skin = payload.skin;
      if (typeof target !== 'string' || !target || typeof skin !== 'string' || !skin) {
        throw portError('K4-MEDIA-PORT-001', 'setSkin target and skin must be non-empty strings');
      }
      const scale = payload.scale;
      if (
        scale !== undefined &&
        (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0)
      ) {
        throw portError('K4-MEDIA-PORT-001', 'setSkin.scale must be a positive finite number');
      }
      if (scale !== undefined && !setActorScale) {
        throw portError('K4-MEDIA-PORT-001', 'setSkin.scale requires an actor scale adapter');
      }
      const signal = validateContext(context);
      if (signal.aborted) throw abortError();
      requireAsset(skin, 'image');
      const actionContext = /** @type {Readonly<Record<string, unknown>>} */ (
        /** @type {unknown} */ (context)
      );
      const actor = validateActor(
        await runCancellable(() => resolveActor(target, actionContext), signal),
        target,
      );
      await runCancellable(() => stopLoop(target), signal);
      await runCancellable(
        () => enqueueActorSkin(target, () => composition.applyToTarget(skin, actor)),
        signal,
      );
      if (scale !== undefined) {
        await runCancellable(
          () => /** @type {Function} */ (setActorScale)(actor, scale, actionContext),
          signal,
        );
      }
    },

    /** @param {unknown} payload @param {unknown} context */
    async loop(payload, context) {
      if (
        !isRecord(payload) ||
        Object.keys(payload).length !== 2 ||
        !Object.hasOwn(payload, 'target') ||
        !Object.hasOwn(payload, 'steps') ||
        typeof payload.target !== 'string' ||
        payload.target.length === 0 ||
        !Array.isArray(payload.steps) ||
        payload.steps.length === 0
      ) {
        throw portError(
          'K4-MEDIA-PORT-001',
          'loop payload must provide target and non-empty steps',
        );
      }
      const target = payload.target;
      const steps = payload.steps.map((step) => {
        if (
          !isRecord(step) ||
          Object.keys(step).length !== 2 ||
          typeof step.skin !== 'string' ||
          step.skin.length === 0 ||
          typeof step.seconds !== 'number' ||
          !Number.isFinite(step.seconds) ||
          step.seconds < 0
        ) {
          throw portError(
            'K4-MEDIA-PORT-001',
            'loop steps must provide a non-empty skin and non-negative finite seconds',
          );
        }
        requireAsset(step.skin, 'image');
        return Object.freeze({skin: step.skin, seconds: step.seconds});
      });
      if (!steps.some(({seconds}) => seconds > 0)) {
        throw portError('K4-MEDIA-PORT-001', 'loop requires at least one positive duration');
      }
      const signal = validateContext(context);
      if (signal.aborted) throw abortError();
      const actionContext = /** @type {Readonly<Record<string, unknown>>} */ (
        /** @type {unknown} */ (context)
      );
      const actor = validateActor(
        await runCancellable(() => resolveActor(target, actionContext), signal),
        target,
      );
      await runCancellable(() => stopLoop(target), signal);
      /** @type {{timer?: unknown, active: boolean}} */
      const state = {active: true};
      actorLoops.set(target, state);

      /** @param {number} index */
      async function applyStep(index) {
        if (!state.active) return;
        const step = steps[index];
        await enqueueActorSkin(target, () => composition.applyToTarget(step.skin, actor));
        if (!state.active) return;
        state.timer = scheduler.setTimeout(() => {
          state.timer = undefined;
          void applyStep((index + 1) % steps.length).catch((error) => {
            void stopLoop(target, state);
            onBackgroundError(error);
          });
        }, step.seconds * 1000);
      }

      try {
        await runCancellable(
          () => applyStep(0),
          signal,
          () => void stopLoop(target, state),
        );
      } catch (error) {
        await stopLoop(target, state);
        throw error;
      }
    },

    stopActorLoop: stopLoop,
    stopAllLoops,
    dispose: stopAllLoops,
  });
}
