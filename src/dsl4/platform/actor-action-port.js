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
  const error = new Error('DSL 4.0 actor action was cancelled');
  error.name = 'AbortError';
  if (cause !== undefined) Object.defineProperty(error, 'cause', {value: cause});
  return error;
}

/** @param {unknown} value */
function validateComposition(value) {
  const methods = ['isRegistered', 'getMimeType', 'applyToTarget'];
  if (!isRecord(value) || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`Asset Manager composition must provide ${methods.join(', ')}`);
  }
  return /** @type {Record<string, Function>} */ (value);
}

/** @param {unknown} value */
function validateHost(value) {
  const methods = ['showActor', 'createMove', 'createSay'];
  if (!isRecord(value) || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`Actor presentation host must provide ${methods.join(', ')}`);
  }
  return /** @type {Record<string, Function>} */ (value);
}

/** @param {unknown} value */
function validateContext(value) {
  if (!isRecord(value) || !isRecord(value.signal)) {
    throw portError('K4-ACTOR-PORT-001', 'actor action context must provide an AbortSignal');
  }
  const signal = value.signal;
  if (
    typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function' ||
    typeof signal.removeEventListener !== 'function'
  ) {
    throw portError('K4-ACTOR-PORT-001', 'actor action signal is invalid');
  }
  return /** @type {AbortSignal} */ (/** @type {unknown} */ (signal));
}

/** @param {unknown} value @param {string[]} keys @param {string} command */
function validatePayloadShape(value, keys, command) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw portError(
      'K4-ACTOR-PORT-001',
      `${command} payload must provide exactly ${keys.join(', ')}`,
    );
  }
  return value;
}

/** @param {unknown} value @param {string} field @param {string} command */
function requireNonEmptyString(value, field, command) {
  if (typeof value !== 'string' || value.length === 0) {
    throw portError('K4-ACTOR-PORT-001', `${command}.${field} must be a non-empty string`);
  }
  return value;
}

/** @param {unknown} value @param {string} field @param {string} command */
function requireFiniteNumber(value, field, command) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw portError('K4-ACTOR-PORT-001', `${command}.${field} must be a finite number`);
  }
  return value;
}

/** @param {unknown} value @param {string} actorId */
function validateActor(value, actorId) {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.isStage !== false
  ) {
    throw portError('K4-ACTOR-PORT-003', `Actor target is unavailable: ${actorId}`);
  }
  return /** @type {Readonly<{id: string, isStage: false}>} */ (/** @type {unknown} */ (value));
}

/**
 * Race one operation with action cancellation and contain stale settlement.
 *
 * @template T
 * @param {() => T | Promise<T>} start
 * @param {AbortSignal} signal
 */
async function runCancellable(start, signal) {
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
    rejectAbort(abortError());
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

/** @param {unknown} value @param {'moveTo' | 'say'} command */
function validatePresentationOperation(value, command) {
  if (!isRecord(value) || typeof value.start !== 'function' || typeof value.finish !== 'function') {
    throw portError(
      'K4-ACTOR-PORT-004',
      `${command} presentation operation must provide start and finish`,
    );
  }
  return /** @type {{start: () => unknown, finish: () => unknown}} */ (
    /** @type {unknown} */ (value)
  );
}

/**
 * Start a validated presentation operation. Abort synchronously calls finish before rejection.
 *
 * @param {{start: () => unknown, finish: () => unknown}} operation
 * @param {AbortSignal} signal
 */
async function runPresentationOperation(operation, signal) {
  if (signal.aborted) throw abortError();
  /** @type {(error: Error) => void} */
  let rejectAbort = () => {};
  let started = false;
  let settled = false;
  let cancelled = false;
  /** @type {Error | undefined} */
  let cancellationError;
  const aborted = new Promise((_resolve, reject) => {
    rejectAbort = reject;
  });
  const handleAbort = () => {
    if (cancelled || settled) return;
    cancelled = true;
    let finishError;
    try {
      if (started) operation.finish();
    } catch (error) {
      finishError = error;
    }
    cancellationError = abortError(finishError);
    rejectAbort(cancellationError);
  };
  signal.addEventListener('abort', handleAbort, {once: true});
  if (signal.aborted) {
    signal.removeEventListener('abort', handleAbort);
    throw abortError();
  }

  let presentation;
  try {
    started = true;
    presentation = Promise.resolve(operation.start());
  } catch (error) {
    signal.removeEventListener('abort', handleAbort);
    throw error;
  }
  const trackedPresentation = presentation.then(
    (result) => {
      settled = true;
      if (cancelled) throw cancellationError ?? abortError();
      return result;
    },
    (error) => {
      settled = true;
      if (cancelled) throw cancellationError ?? abortError();
      throw error;
    },
  );
  void trackedPresentation.catch(() => {});
  try {
    return await Promise.race([trackedPresentation, aborted]);
  } finally {
    signal.removeEventListener('abort', handleAbort);
  }
}

/**
 * Adapt DSL 4.0 actor actions to an app-shell-scoped presentation host.
 *
 * The host must create move/say operations without presentation side effects. Their start method
 * begins presentation, and finish synchronously applies the action's skipped final state.
 *
 * @param {object} options
 * @param {unknown} options.composition
 * @param {(actorId: string, context: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} options.resolveActor
 * @param {unknown} options.host
 */
export function createDsl4ActorActionPort(options) {
  if (!isRecord(options)) throw new TypeError('actor action port options must be an object');
  const composition = validateComposition(options.composition);
  if (typeof options.resolveActor !== 'function') {
    throw new TypeError('resolveActor must be a function');
  }
  const resolveActor = options.resolveActor;
  const host = validateHost(options.host);

  /** @param {string} skin */
  function requireImageAsset(skin) {
    if (!composition.isRegistered(skin)) {
      throw portError('K4-ACTOR-PORT-002', `Actor skin is not registered: ${skin}`);
    }
    const mimeType = composition.getMimeType(skin);
    if (typeof mimeType !== 'string' || !mimeType.startsWith('image/')) {
      throw portError('K4-ACTOR-PORT-002', `Actor skin ${skin} must have image MIME type`);
    }
  }

  /** @param {string} target @param {Readonly<Record<string, unknown>>} context @param {AbortSignal} signal */
  async function resolveTarget(target, context, signal) {
    return validateActor(await runCancellable(() => resolveActor(target, context), signal), target);
  }

  return Object.freeze({
    /** @param {unknown} payload @param {unknown} context */
    async show(payload, context) {
      const value = validatePayloadShape(payload, ['target', 'skin', 'x', 'y', 'scale'], 'show');
      const target = requireNonEmptyString(value.target, 'target', 'show');
      const skin = requireNonEmptyString(value.skin, 'skin', 'show');
      const x = requireFiniteNumber(value.x, 'x', 'show');
      const y = requireFiniteNumber(value.y, 'y', 'show');
      const scale = requireFiniteNumber(value.scale, 'scale', 'show');
      if (scale <= 0) {
        throw portError('K4-ACTOR-PORT-001', 'show.scale must be greater than zero');
      }
      const signal = validateContext(context);
      if (signal.aborted) throw abortError();
      requireImageAsset(skin);
      const actionContext = /** @type {Readonly<Record<string, unknown>>} */ (
        /** @type {unknown} */ (context)
      );
      const actor = await resolveTarget(target, actionContext, signal);
      await runCancellable(() => composition.applyToTarget(skin, actor), signal);
      await runCancellable(
        () => host.showActor(actor, Object.freeze({x, y, scale}), actionContext),
        signal,
      );
    },

    /** @param {unknown} payload @param {unknown} context */
    async moveTo(payload, context) {
      const value = validatePayloadShape(payload, ['target', 'x', 'y', 'seconds'], 'moveTo');
      const target = requireNonEmptyString(value.target, 'target', 'moveTo');
      const x = requireFiniteNumber(value.x, 'x', 'moveTo');
      const y = requireFiniteNumber(value.y, 'y', 'moveTo');
      const seconds = requireFiniteNumber(value.seconds, 'seconds', 'moveTo');
      if (seconds < 0) {
        throw portError('K4-ACTOR-PORT-001', 'moveTo.seconds must not be negative');
      }
      const signal = validateContext(context);
      if (signal.aborted) throw abortError();
      const actionContext = /** @type {Readonly<Record<string, unknown>>} */ (
        /** @type {unknown} */ (context)
      );
      const actor = await resolveTarget(target, actionContext, signal);
      const operation = validatePresentationOperation(
        host.createMove(actor, Object.freeze({x, y, seconds}), actionContext),
        'moveTo',
      );
      return runPresentationOperation(operation, signal);
    },

    /** @param {unknown} payload @param {unknown} context */
    async say(payload, context) {
      const value = validatePayloadShape(payload, ['target', 'text', 'seconds'], 'say');
      const target = requireNonEmptyString(value.target, 'target', 'say');
      if (typeof value.text !== 'string') {
        throw portError('K4-ACTOR-PORT-001', 'say.text must be a string');
      }
      const text = value.text;
      const seconds = requireFiniteNumber(value.seconds, 'seconds', 'say');
      if (seconds < 0) {
        throw portError('K4-ACTOR-PORT-001', 'say.seconds must not be negative');
      }
      const signal = validateContext(context);
      if (signal.aborted) throw abortError();
      const actionContext = /** @type {Readonly<Record<string, unknown>>} */ (
        /** @type {unknown} */ (context)
      );
      const actor = await resolveTarget(target, actionContext, signal);
      const operation = validatePresentationOperation(
        host.createSay(actor, Object.freeze({text, seconds}), actionContext),
        'say',
      );
      return runPresentationOperation(operation, signal);
    },
  });
}
