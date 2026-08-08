import {dsl4MoveEasingNames, isDsl4MoveEasing} from '../move-easing.js';

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

/** @param {unknown} value @param {boolean} speechAdvanceTypewriterEnabled */
function validateHost(value, speechAdvanceTypewriterEnabled) {
  const methods = [
    'showActor',
    'hideActor',
    'setActorLayer',
    'setTransparency',
    'createTransparencyTransition',
    'createMove',
    'createSay',
    ...(speechAdvanceTypewriterEnabled ? ['createThink'] : []),
  ];
  if (!isRecord(value) || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`Actor presentation host must provide ${methods.join(', ')}`);
  }
  return /** @type {Record<string, Function>} */ (value);
}

/** @param {unknown} value @param {string} command @param {boolean} extended */
function validateSpeechPayload(value, command, extended) {
  if (!extended) return validatePayloadShape(value, ['target', 'text', 'seconds'], command);
  if (!isRecord(value)) {
    throw portError('K4-ACTOR-PORT-001', `${command} payload must be an object`);
  }
  const allowed = new Set([
    'target',
    'text',
    'seconds',
    'waitFor',
    'characterIntervalSeconds',
    'startSound',
    'characterSound',
    'noSoundCharacters',
    'restCharacters',
    'restCharacterIntervalSeconds',
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = ['target', 'text'].filter((key) => !Object.hasOwn(value, key));
  if (
    unknown.length > 0 ||
    missing.length > 0 ||
    (!Object.hasOwn(value, 'seconds') && !Object.hasOwn(value, 'waitFor'))
  ) {
    throw portError(
      'K4-ACTOR-PORT-001',
      `${command} payload keys are invalid (unknown: ${unknown.sort().join(', ') || 'none'}; missing: ${missing.sort().join(', ') || 'seconds or waitFor'})`,
    );
  }
  if (Object.hasOwn(value, 'characterSound') && !Object.hasOwn(value, 'characterIntervalSeconds')) {
    throw portError(
      'K4-ACTOR-PORT-001',
      `${command}.characterSound requires characterIntervalSeconds`,
    );
  }
  if (
    Object.hasOwn(value, 'noSoundCharacters') &&
    (!Object.hasOwn(value, 'characterIntervalSeconds') || !Object.hasOwn(value, 'characterSound'))
  ) {
    throw portError(
      'K4-ACTOR-PORT-001',
      `${command}.noSoundCharacters requires characterIntervalSeconds and characterSound`,
    );
  }
  if (
    Object.hasOwn(value, 'restCharacters') !== Object.hasOwn(value, 'restCharacterIntervalSeconds')
  ) {
    throw portError(
      'K4-ACTOR-PORT-001',
      `${command}.restCharacters and restCharacterIntervalSeconds must be specified together`,
    );
  }
  if (
    (Object.hasOwn(value, 'restCharacters') ||
      Object.hasOwn(value, 'restCharacterIntervalSeconds')) &&
    !Object.hasOwn(value, 'characterIntervalSeconds')
  ) {
    throw portError(
      'K4-ACTOR-PORT-001',
      `${command}.restCharacters requires characterIntervalSeconds`,
    );
  }
  return value;
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

/** @param {unknown} value @param {string[]} keys @param {string} command @param {string[]} [optionalKeys] */
function validatePayloadShape(value, keys, command, optionalKeys = []) {
  const allowedKeys = new Set([...keys, ...optionalKeys]);
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw portError(
      'K4-ACTOR-PORT-001',
      `${command} payload must provide ${keys.join(', ')}${optionalKeys.length > 0 ? ` and only optional ${optionalKeys.join(', ')}` : ''}`,
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

/** @param {number} value @param {string} field */
function requireTransparency(value, field) {
  if (value < 0 || value > 100) {
    throw portError('K4-ACTOR-PORT-001', `setTransparency.${field} must be between 0 and 100`);
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

/** @param {unknown} value @param {'setTransparency' | 'moveTo' | 'say' | 'think'} command */
function validatePresentationOperation(value, command) {
  if (!isRecord(value) || typeof value.start !== 'function' || typeof value.finish !== 'function') {
    throw portError(
      'K4-ACTOR-PORT-004',
      `${command} presentation operation must provide start and finish`,
    );
  }
  return /** @type {{start: () => unknown, startBackground?: () => void, finish: (reason?: string) => unknown}} */ (
    /** @type {unknown} */ (value)
  );
}

/**
 * Start a validated presentation operation. Abort synchronously calls finish before rejection.
 *
 * @param {{start: () => unknown, finish: (reason?: string) => unknown}} operation
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
 * Complete one speech operation from its timer or an explicitly armed advance gate.
 *
 * @param {{start: () => unknown, finish: (reason?: string) => unknown}} operation
 * @param {AbortSignal} signal
 * @param {unknown} context
 * @param {boolean} waitForAdvance
 */
async function runSpeechPresentationOperation(operation, signal, context, waitForAdvance) {
  if (!waitForAdvance) return runPresentationOperation(operation, signal);
  if (!isRecord(context) || typeof context.createAdvanceWait !== 'function') {
    throw portError('K4-ACTOR-PORT-001', 'speech advance context must provide createAdvanceWait');
  }
  const advanceWait = context.createAdvanceWait();
  if (
    !isRecord(advanceWait) ||
    !isRecord(advanceWait.promise) ||
    typeof advanceWait.promise.then !== 'function' ||
    typeof advanceWait.cancel !== 'function'
  ) {
    if (isRecord(advanceWait) && typeof advanceWait.cancel === 'function') {
      advanceWait.cancel();
    }
    throw portError('K4-ACTOR-PORT-001', 'createAdvanceWait returned an invalid handle');
  }
  const presentation = runPresentationOperation(operation, signal);
  try {
    const outcome = await Promise.race([
      presentation.then(() => 'presentation'),
      advanceWait.promise.then((/** @type {unknown} */ result) => {
        if (isRecord(result) && result.outcome === 'advance') return 'advance';
        if (isRecord(result) && result.outcome === 'cancelled') return 'cancelled';
        throw portError('K4-ACTOR-PORT-001', 'speech advance wait returned an invalid outcome');
      }),
    ]);
    if (outcome === 'advance') operation.finish('advance');
    if (outcome === 'cancelled') {
      operation.finish('cancel');
      if (signal.aborted) throw abortError();
      throw portError('K4-ACTOR-PORT-001', 'speech advance wait was cancelled unexpectedly');
    }
    return await presentation;
  } catch (error) {
    try {
      operation.finish('cancel');
    } catch (finishError) {
      if (error instanceof Error && error.cause === undefined) {
        Object.defineProperty(error, 'cause', {value: finishError});
      }
    }
    throw error;
  } finally {
    advanceWait.cancel();
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
 * @param {boolean} [options.speechAdvanceTypewriterEnabled]
 * @param {(actorId: string) => unknown | Promise<unknown>} [options.stopActorLoop]
 */
export function createDsl4ActorActionPort(options) {
  if (!isRecord(options)) throw new TypeError('actor action port options must be an object');
  const composition = validateComposition(options.composition);
  if (typeof options.resolveActor !== 'function') {
    throw new TypeError('resolveActor must be a function');
  }
  const resolveActor = options.resolveActor;
  const speechAdvanceTypewriterEnabled = options.speechAdvanceTypewriterEnabled ?? false;
  if (typeof speechAdvanceTypewriterEnabled !== 'boolean') {
    throw new TypeError('speechAdvanceTypewriterEnabled must be boolean');
  }
  const host = validateHost(options.host, speechAdvanceTypewriterEnabled);
  if (options.stopActorLoop !== undefined && typeof options.stopActorLoop !== 'function') {
    throw new TypeError('stopActorLoop must be a function');
  }
  const stopActorLoop = options.stopActorLoop;

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

  /** @param {string} sound */
  function requireAudioAsset(sound) {
    if (!composition.isRegistered(sound)) {
      throw portError('K4-ACTOR-PORT-002', `Character sound is not registered: ${sound}`);
    }
    const mimeType = composition.getMimeType(sound);
    if (typeof mimeType !== 'string' || !mimeType.startsWith('audio/')) {
      throw portError('K4-ACTOR-PORT-002', `Character sound ${sound} must have audio MIME type`);
    }
  }

  /** @param {string} target @param {Readonly<Record<string, unknown>>} context @param {AbortSignal} signal */
  async function resolveTarget(target, context, signal) {
    return validateActor(await runCancellable(() => resolveActor(target, context), signal), target);
  }

  /** @param {'say' | 'think'} command @param {unknown} payload @param {unknown} context */
  async function runSpeech(command, payload, context) {
    const value = validateSpeechPayload(payload, command, speechAdvanceTypewriterEnabled);
    const target = requireNonEmptyString(value.target, 'target', command);
    if (typeof value.text !== 'string') {
      throw portError('K4-ACTOR-PORT-001', `${command}.text must be a string`);
    }
    const text = value.text;
    let seconds;
    if (Object.hasOwn(value, 'seconds')) {
      seconds = requireFiniteNumber(value.seconds, 'seconds', command);
      if (seconds < 0) {
        throw portError('K4-ACTOR-PORT-001', `${command}.seconds must not be negative`);
      }
    }
    const waitFor = value.waitFor;
    if (waitFor !== undefined && waitFor !== 'advance') {
      throw portError('K4-ACTOR-PORT-001', `${command}.waitFor must be advance`);
    }
    let characterIntervalSeconds;
    if (Object.hasOwn(value, 'characterIntervalSeconds')) {
      characterIntervalSeconds = requireFiniteNumber(
        value.characterIntervalSeconds,
        'characterIntervalSeconds',
        command,
      );
      if (characterIntervalSeconds <= 0) {
        throw portError(
          'K4-ACTOR-PORT-001',
          `${command}.characterIntervalSeconds must be greater than zero`,
        );
      }
    }
    let startSound;
    if (Object.hasOwn(value, 'startSound')) {
      startSound = requireNonEmptyString(value.startSound, 'startSound', command);
    }
    let characterSound;
    if (Object.hasOwn(value, 'characterSound')) {
      characterSound = requireNonEmptyString(value.characterSound, 'characterSound', command);
    }
    let noSoundCharacters;
    if (Object.hasOwn(value, 'noSoundCharacters')) {
      noSoundCharacters = requireNonEmptyString(
        value.noSoundCharacters,
        'noSoundCharacters',
        command,
      );
    }
    let restCharacters;
    if (Object.hasOwn(value, 'restCharacters')) {
      restCharacters = requireNonEmptyString(value.restCharacters, 'restCharacters', command);
    }
    let restCharacterIntervalSeconds;
    if (Object.hasOwn(value, 'restCharacterIntervalSeconds')) {
      restCharacterIntervalSeconds = requireFiniteNumber(
        value.restCharacterIntervalSeconds,
        'restCharacterIntervalSeconds',
        command,
      );
      if (restCharacterIntervalSeconds <= 0) {
        throw portError(
          'K4-ACTOR-PORT-001',
          `${command}.restCharacterIntervalSeconds must be greater than zero`,
        );
      }
    }
    const signal = validateContext(context);
    if (signal.aborted) throw abortError();
    for (const sound of new Set([startSound, characterSound].filter(Boolean))) {
      requireAudioAsset(/** @type {string} */ (sound));
    }
    const actionContext = /** @type {Readonly<Record<string, unknown>>} */ (
      /** @type {unknown} */ (context)
    );
    const actor = await resolveTarget(target, actionContext, signal);
    const operation = validatePresentationOperation(
      host[command === 'say' ? 'createSay' : 'createThink'](
        actor,
        Object.freeze({
          text,
          ...(seconds === undefined ? {} : {seconds}),
          ...(characterIntervalSeconds === undefined ? {} : {characterIntervalSeconds}),
          ...(startSound === undefined ? {} : {startSound}),
          ...(characterSound === undefined ? {} : {characterSound}),
          ...(noSoundCharacters === undefined ? {} : {noSoundCharacters}),
          ...(restCharacters === undefined ? {} : {restCharacters}),
          ...(restCharacterIntervalSeconds === undefined ? {} : {restCharacterIntervalSeconds}),
        }),
        actionContext,
      ),
      command,
    );
    return runSpeechPresentationOperation(operation, signal, context, waitFor === 'advance');
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
      await runCancellable(() => stopActorLoop?.(target), signal);
      await runCancellable(() => composition.applyToTarget(skin, actor), signal);
      await runCancellable(
        () => host.showActor(actor, Object.freeze({x, y, scale}), actionContext),
        signal,
      );
    },

    /** @param {unknown} payload @param {unknown} context */
    async hide(payload, context) {
      const value = validatePayloadShape(payload, ['target'], 'hide');
      const target = requireNonEmptyString(value.target, 'target', 'hide');
      const signal = validateContext(context);
      if (signal.aborted) throw abortError();
      const actionContext = /** @type {Readonly<Record<string, unknown>>} */ (
        /** @type {unknown} */ (context)
      );
      const actor = await resolveTarget(target, actionContext, signal);
      await runCancellable(() => host.hideActor(actor, actionContext), signal);
    },

    /** @param {unknown} payload @param {unknown} context */
    async setLayer(payload, context) {
      const value = validatePayloadShape(payload, ['target', 'layer'], 'setLayer');
      const target = requireNonEmptyString(value.target, 'target', 'setLayer');
      const layer = value.layer;
      if (
        layer !== 'front' &&
        layer !== 'back' &&
        (typeof layer !== 'number' || !Number.isFinite(layer))
      ) {
        throw portError(
          'K4-ACTOR-PORT-001',
          'setLayer.layer must be front, back, or a finite number',
        );
      }
      const signal = validateContext(context);
      if (signal.aborted) throw abortError();
      const actionContext = /** @type {Readonly<Record<string, unknown>>} */ (
        /** @type {unknown} */ (context)
      );
      const actor = await resolveTarget(target, actionContext, signal);
      await runCancellable(() => host.setActorLayer(actor, layer, actionContext), signal);
    },

    /** @param {unknown} payload @param {unknown} context */
    async setTransparency(payload, context) {
      const transitionRequested =
        isRecord(payload) &&
        ['from', 'to', 'seconds', 'background'].some((field) => Object.hasOwn(payload, field));
      const transition = transitionRequested
        ? Object.hasOwn(/** @type {Record<string, unknown>} */ (payload), 'background')
          ? validatePayloadShape(
              payload,
              ['target', 'from', 'to', 'seconds', 'background'],
              'setTransparency',
            )
          : validatePayloadShape(payload, ['target', 'from', 'to', 'seconds'], 'setTransparency')
        : null;
      const value =
        transition ?? validatePayloadShape(payload, ['target', 'transparency'], 'setTransparency');
      const target = requireNonEmptyString(value.target, 'target', 'setTransparency');
      const effect = transition
        ? (() => {
            const from = requireTransparency(
              requireFiniteNumber(transition.from, 'from', 'setTransparency'),
              'from',
            );
            const to = requireTransparency(
              requireFiniteNumber(transition.to, 'to', 'setTransparency'),
              'to',
            );
            const seconds = requireFiniteNumber(transition.seconds, 'seconds', 'setTransparency');
            if (seconds < 0 || !Number.isFinite(seconds * 1000)) {
              throw portError(
                'K4-ACTOR-PORT-001',
                'setTransparency.seconds must produce a finite non-negative duration',
              );
            }
            const background = transition.background ?? false;
            if (typeof background !== 'boolean') {
              throw portError('K4-ACTOR-PORT-001', 'setTransparency.background must be a boolean');
            }
            return Object.freeze({from, to, seconds, background});
          })()
        : Object.freeze({
            transparency: requireTransparency(
              requireFiniteNumber(value.transparency, 'transparency', 'setTransparency'),
              'transparency',
            ),
          });
      const signal = validateContext(context);
      if (signal.aborted) throw abortError();
      const actionContext = /** @type {Readonly<Record<string, unknown>>} */ (
        /** @type {unknown} */ (context)
      );
      const actor = await resolveTarget(target, actionContext, signal);
      if (!transition) {
        await runCancellable(() => host.setTransparency(actor, effect, actionContext), signal);
        return;
      }
      const transitionEffect =
        /** @type {Readonly<{from: number, to: number, seconds: number, background: boolean}>} */ (
          effect
        );
      const operation = validatePresentationOperation(
        host.createTransparencyTransition(
          actor,
          Object.freeze({
            from: transitionEffect.from,
            to: transitionEffect.to,
            seconds: transitionEffect.seconds,
          }),
          actionContext,
        ),
        'setTransparency',
      );
      if (!transitionEffect.background) return runPresentationOperation(operation, signal);
      if (signal.aborted) throw abortError();
      if (typeof operation.startBackground !== 'function') {
        throw portError(
          'K4-ACTOR-PORT-004',
          'setTransparency background operation must provide startBackground',
        );
      }
      operation.startBackground();
    },

    /** @param {unknown} payload @param {unknown} context */
    async moveTo(payload, context) {
      const value = validatePayloadShape(payload, ['target', 'x', 'y', 'seconds'], 'moveTo', [
        'easing',
      ]);
      const target = requireNonEmptyString(value.target, 'target', 'moveTo');
      const x = requireFiniteNumber(value.x, 'x', 'moveTo');
      const y = requireFiniteNumber(value.y, 'y', 'moveTo');
      const seconds = requireFiniteNumber(value.seconds, 'seconds', 'moveTo');
      const easing = value.easing ?? 'linear';
      if (!isDsl4MoveEasing(easing)) {
        throw portError(
          'K4-ACTOR-PORT-001',
          `moveTo.easing must be one of ${dsl4MoveEasingNames.join(', ')}`,
        );
      }
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
        host.createMove(actor, Object.freeze({x, y, seconds, easing}), actionContext),
        'moveTo',
      );
      return runPresentationOperation(operation, signal);
    },

    /** @param {unknown} payload @param {unknown} context */
    say(payload, context) {
      return runSpeech('say', payload, context);
    },

    /** @param {unknown} payload @param {unknown} context */
    think(payload, context) {
      if (!speechAdvanceTypewriterEnabled) {
        throw portError('K4-ACTOR-PORT-001', 'think is disabled');
      }
      return runSpeech('think', payload, context);
    },
  });
}
