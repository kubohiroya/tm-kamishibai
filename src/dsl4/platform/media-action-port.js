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
 */
export function createDsl4MediaActionPort(options) {
  if (!isRecord(options)) throw new TypeError('media action port options must be an object');
  const composition = validateComposition(options.composition);
  if (typeof options.resolveActor !== 'function') {
    throw new TypeError('resolveActor must be a function');
  }
  const resolveActor = options.resolveActor;

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
      const {target, skin} = validatePayload(payload, ['target', 'skin'], 'setSkin');
      const signal = validateContext(context);
      if (signal.aborted) throw abortError();
      requireAsset(skin, 'image');
      const actor = validateActor(
        await runCancellable(
          () =>
            resolveActor(
              target,
              /** @type {Readonly<Record<string, unknown>>} */ (/** @type {unknown} */ (context)),
            ),
          signal,
        ),
        target,
      );
      return runCancellable(() => composition.applyToTarget(skin, actor), signal);
    },
  });
}
