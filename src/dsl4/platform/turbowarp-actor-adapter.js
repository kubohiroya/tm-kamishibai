import {normalizeBubbleReveal, splitBubbleText} from '@kubohiroya/turbowarp-bubble';
import {normalizeDsl4BubbleMotions} from '../bubble-motion.js';
import {applyDsl4MoveEasing, dsl4MoveEasingNames, isDsl4MoveEasing} from '../move-easing.js';

const defaultFrameMilliseconds = 1000 / 60;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} code @param {string} message */
function adapterError(code, message) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

function createDefaultScheduler() {
  /** @param {() => void} callback @param {number} milliseconds */
  const schedule = (callback, milliseconds) => setTimeout(callback, milliseconds);
  /** @param {unknown} handle */
  const cancel = (handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle));
  return Object.freeze({
    now: () => performance.now(),
    setTimeout: schedule,
    clearTimeout: cancel,
  });
}

/** @param {unknown} value */
function validateScheduler(value) {
  const methods = ['now', 'setTimeout', 'clearTimeout'];
  if (!isRecord(value) || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`TurboWarp actor scheduler must provide ${methods.join(', ')}`);
  }
  return /** @type {{now: () => number, setTimeout: (callback: () => void, milliseconds: number) => unknown, clearTimeout: (handle: unknown) => void}} */ (
    /** @type {unknown} */ (value)
  );
}

/** @param {unknown} value @param {boolean} speechAdvanceTypewriterEnabled @param {boolean} bubbleEnabled */
function validateRuntime(value, speechAdvanceTypewriterEnabled, bubbleEnabled) {
  if (!isRecord(value) || !Array.isArray(value.targets)) {
    throw new TypeError('TurboWarp runtime must provide a targets array');
  }
  const looks = /** @type {Record<string, unknown> | null} */ (
    isRecord(value.ext_scratch3_looks) ? value.ext_scratch3_looks : null
  );
  if (
    !bubbleEnabled &&
    (looks === null ||
      typeof looks._say !== 'function' ||
      (speechAdvanceTypewriterEnabled && typeof looks._think !== 'function'))
  ) {
    throw new TypeError(
      `TurboWarp runtime must provide ext_scratch3_looks._say${speechAdvanceTypewriterEnabled ? ' and _think' : ''}`,
    );
  }
  return {
    runtime: /** @type {Record<string, unknown> & {targets: unknown[]}} */ (value),
    say: bubbleEnabled
      ? null
      : /** @type {(message: string, target: unknown) => void} */ (
          /** @type {Function} */ (looks?._say).bind(looks)
        ),
    think:
      !bubbleEnabled && typeof looks?._think === 'function'
        ? /** @type {(message: string, target: unknown) => void} */ (looks._think.bind(looks))
        : null,
  };
}

/** @param {unknown} value @param {string} operation @param {boolean} extended */
function validateSpeechSpec(value, operation, extended) {
  if (!extended) return validateSpec(value, ['text', 'seconds'], operation);
  if (!isRecord(value)) {
    throw adapterError('K4-TW-ACTOR-002', `${operation} specification must be an object`);
  }
  const allowed = new Set([
    'text',
    'seconds',
    'characterIntervalSeconds',
    'startSound',
    'characterSound',
    'noSoundCharacters',
    'restCharacters',
    'restCharacterIntervalSeconds',
    'bubbleStyle',
    'bubbleReveal',
    'bubbleMotions',
    'waitFor',
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (!Object.hasOwn(value, 'text') || unknown.length > 0) {
    throw adapterError(
      'K4-TW-ACTOR-002',
      `${operation} specification keys are invalid: ${unknown.sort().join(', ') || 'text is missing'}`,
    );
  }
  if (Object.hasOwn(value, 'characterSound') && !Object.hasOwn(value, 'characterIntervalSeconds')) {
    throw adapterError(
      'K4-TW-ACTOR-002',
      `${operation}.characterSound requires characterIntervalSeconds`,
    );
  }
  if (
    Object.hasOwn(value, 'noSoundCharacters') &&
    (!Object.hasOwn(value, 'characterIntervalSeconds') || !Object.hasOwn(value, 'characterSound'))
  ) {
    throw adapterError(
      'K4-TW-ACTOR-002',
      `${operation}.noSoundCharacters requires characterIntervalSeconds and characterSound`,
    );
  }
  if (
    Object.hasOwn(value, 'restCharacters') !== Object.hasOwn(value, 'restCharacterIntervalSeconds')
  ) {
    throw adapterError(
      'K4-TW-ACTOR-002',
      `${operation}.restCharacters and restCharacterIntervalSeconds must be specified together`,
    );
  }
  if (
    (Object.hasOwn(value, 'restCharacters') ||
      Object.hasOwn(value, 'restCharacterIntervalSeconds')) &&
    !Object.hasOwn(value, 'characterIntervalSeconds')
  ) {
    throw adapterError(
      'K4-TW-ACTOR-002',
      `${operation}.restCharacters requires characterIntervalSeconds`,
    );
  }
  if (Object.hasOwn(value, 'waitFor') && value.waitFor !== 'advance') {
    throw adapterError('K4-TW-ACTOR-002', `${operation}.waitFor must be advance`);
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw adapterError('K4-TW-ACTOR-002', `${field} must be a non-empty string`);
  }
  return value;
}

/** @param {string} text */
function defaultSegmentText(text) {
  if (typeof Intl !== 'object' || typeof Intl.Segmenter !== 'function') {
    throw adapterError(
      'K4-TW-ACTOR-002',
      'Intl.Segmenter is required for Unicode grapheme segmentation',
    );
  }
  const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
  return [...segmenter.segment(text)].map(({segment}) => segment);
}

/** @param {unknown} value @param {string} field */
function finiteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw adapterError('K4-TW-ACTOR-002', `${field} must be a finite number`);
  }
  return value;
}

/** @param {unknown} value */
function validateActor(value) {
  const methods = ['lookupVariableByNameAndType', 'setXY', 'setSize', 'setVisible'];
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.isStage !== false ||
    methods.some((method) => typeof value[method] !== 'function')
  ) {
    throw adapterError('K4-TW-ACTOR-002', 'TurboWarp actor target is invalid');
  }
  finiteNumber(value.x, 'actor.x');
  finiteNumber(value.y, 'actor.y');
  return /** @type {Record<string, unknown> & {id: string, isStage: false, x: number, y: number, lookupVariableByNameAndType: (name: string, type: string) => unknown, setXY: (x: number, y: number) => void, setSize: (size: number) => void, setVisible: (visible: boolean) => void}} */ (
    /** @type {unknown} */ (value)
  );
}

/** @param {unknown} value */
function validateEffectActor(value) {
  const actor = validateActor(value);
  if (typeof actor.setEffect !== 'function') {
    throw adapterError('K4-TW-ACTOR-002', 'TurboWarp actor target must provide setEffect');
  }
  return /** @type {ReturnType<typeof validateActor> & {setEffect: (effect: string, value: number) => void}} */ (
    actor
  );
}

/** @param {unknown} value @param {string[]} keys @param {string} operation @param {string[]} [optionalKeys] */
function validateSpec(value, keys, operation, optionalKeys = []) {
  const allowedKeys = new Set([...keys, ...optionalKeys]);
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw adapterError(
      'K4-TW-ACTOR-002',
      `${operation} specification must provide exactly ${keys.join(', ')}${optionalKeys.length > 0 ? ` with only optional ${optionalKeys.join(', ')}` : ''}`,
    );
  }
  return value;
}

/** @param {number} seconds @param {string} operation */
function durationMilliseconds(seconds, operation) {
  finiteNumber(seconds, `${operation}.seconds`);
  const duration = seconds * 1000;
  if (seconds < 0 || !Number.isFinite(duration)) {
    throw adapterError(
      'K4-TW-ACTOR-002',
      `${operation}.seconds must produce a finite non-negative duration`,
    );
  }
  return duration;
}

/**
 * Connect the DSL4 actor presentation boundary to one TurboWarp runtime.
 *
 * @param {object} options
 * @param {unknown} options.runtime
 * @param {unknown} [options.scheduler]
 * @param {number} [options.frameMilliseconds]
 * @param {boolean} [options.speechAdvanceTypewriterEnabled]
 * @param {(sound: string) => unknown | Promise<unknown>} [options.playSpeechSound]
 * @param {(sound: string) => unknown | Promise<unknown>} [options.stopSpeechSound]
 * @param {(text: string) => string[]} [options.segmentText]
 * @param {unknown} [options.bubbleComposition]
 */
export function createDsl4TurboWarpActorPlatform(options) {
  if (!isRecord(options)) throw new TypeError('TurboWarp actor platform options must be an object');
  const speechAdvanceTypewriterEnabled = options.speechAdvanceTypewriterEnabled ?? false;
  if (typeof speechAdvanceTypewriterEnabled !== 'boolean') {
    throw new TypeError('speechAdvanceTypewriterEnabled must be boolean');
  }
  const bubbleComposition = options.bubbleComposition ?? null;
  const bubbleEnabled = bubbleComposition !== null;
  if (
    bubbleEnabled &&
    (!isRecord(bubbleComposition) ||
      typeof bubbleComposition.show !== 'function' ||
      typeof bubbleComposition.releaseAll !== 'function')
  ) {
    throw new TypeError('Bubble composition must provide show and releaseAll');
  }
  const {runtime, say, think} = validateRuntime(
    options.runtime,
    speechAdvanceTypewriterEnabled,
    bubbleEnabled,
  );
  if (options.playSpeechSound !== undefined && typeof options.playSpeechSound !== 'function') {
    throw new TypeError('playSpeechSound must be a function');
  }
  if (options.stopSpeechSound !== undefined && typeof options.stopSpeechSound !== 'function') {
    throw new TypeError('stopSpeechSound must be a function');
  }
  const playSpeechSound = options.playSpeechSound;
  const stopSpeechSound = options.stopSpeechSound;
  const segmentText = options.segmentText ?? defaultSegmentText;
  if (typeof segmentText !== 'function') throw new TypeError('segmentText must be a function');
  const scheduler = validateScheduler(options.scheduler ?? createDefaultScheduler());
  const frameMilliseconds =
    options.frameMilliseconds === undefined
      ? defaultFrameMilliseconds
      : finiteNumber(options.frameMilliseconds, 'frameMilliseconds');
  if (frameMilliseconds <= 0) {
    throw new TypeError('frameMilliseconds must be greater than zero');
  }
  /** @type {Map<ReturnType<typeof validateEffectActor>, {finish: () => void}>} */
  const activeTransparencyTransitions = new Map();
  let disposed = false;

  function ensureActive() {
    if (disposed) {
      throw adapterError('K4-TW-ACTOR-004', 'TurboWarp actor platform is disposed');
    }
  }

  function finishTransparencyTransitions() {
    const errors = [];
    for (const transition of [...activeTransparencyTransitions.values()]) {
      try {
        transition.finish();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'TurboWarp actor transparency transition cleanup failed');
    }
  }

  /** @param {string} actorId */
  function resolveActor(actorId) {
    ensureActive();
    if (typeof actorId !== 'string' || actorId.length === 0) {
      throw adapterError('K4-TW-ACTOR-001', 'actorId must be a non-empty string');
    }
    const matches = runtime.targets.filter((candidate) => {
      if (!isRecord(candidate) || candidate.isStage !== false) return false;
      if (typeof candidate.lookupVariableByNameAndType !== 'function') return false;
      const variable = candidate.lookupVariableByNameAndType('actorName', '');
      return isRecord(variable) && variable.value === actorId;
    });
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw adapterError('K4-TW-ACTOR-001', `TurboWarp actor is ambiguous: ${actorId}`);
    }
    return validateActor(matches[0]);
  }

  /** @param {'say' | 'think'} kind @param {unknown} target @param {unknown} speech */
  function createSpeech(kind, target, speech) {
    if (kind === 'think' && !speechAdvanceTypewriterEnabled) {
      throw adapterError('K4-TW-ACTOR-002', 'think is disabled');
    }
    const actor = validateActor(target);
    const value = validateSpeechSpec(speech, kind, speechAdvanceTypewriterEnabled);
    if (typeof value.text !== 'string') {
      throw adapterError('K4-TW-ACTOR-002', `${kind}.text must be a string`);
    }
    const text = value.text;
    const bubbleStyle = Object.hasOwn(value, 'bubbleStyle')
      ? requireNonEmptyString(value.bubbleStyle, `${kind}.bubbleStyle`)
      : '__dsl4_default__';
    let bubbleReveal = null;
    if (Object.hasOwn(value, 'bubbleReveal')) {
      if (!bubbleEnabled) {
        throw adapterError('K4-TW-ACTOR-002', `${kind}.bubbleReveal requires TurboWarp Bubble`);
      }
      try {
        bubbleReveal = normalizeBubbleReveal(value.bubbleReveal);
      } catch (error) {
        const normalizedError = adapterError('K4-TW-ACTOR-002', `${kind}.bubbleReveal is invalid`);
        Object.defineProperty(normalizedError, 'cause', {value: error});
        throw normalizedError;
      }
    }
    /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */
    let bubbleMotions = Object.freeze([]);
    if (Object.hasOwn(value, 'bubbleMotions')) {
      try {
        bubbleMotions = normalizeDsl4BubbleMotions(value.bubbleMotions);
      } catch (error) {
        const normalizedError = adapterError('K4-TW-ACTOR-002', `${kind}.bubbleMotions is invalid`);
        Object.defineProperty(normalizedError, 'cause', {value: error});
        throw normalizedError;
      }
    }
    if (bubbleMotions.length > 0 && !bubbleEnabled) {
      throw adapterError('K4-TW-ACTOR-002', `${kind}.bubbleMotions requires TurboWarp Bubble`);
    }
    const waitForAdvance = value.waitFor === 'advance';
    const duration = Object.hasOwn(value, 'seconds')
      ? durationMilliseconds(/** @type {number} */ (value.seconds), kind)
      : null;
    const characterInterval = Object.hasOwn(value, 'characterIntervalSeconds')
      ? durationMilliseconds(
          /** @type {number} */ (value.characterIntervalSeconds),
          `${kind}.characterInterval`,
        )
      : null;
    if (characterInterval !== null && characterInterval <= 0) {
      throw adapterError(
        'K4-TW-ACTOR-002',
        `${kind}.characterIntervalSeconds must be greater than zero`,
      );
    }
    const restCharacterInterval = Object.hasOwn(value, 'restCharacterIntervalSeconds')
      ? durationMilliseconds(
          /** @type {number} */ (value.restCharacterIntervalSeconds),
          `${kind}.restCharacterInterval`,
        )
      : null;
    if (restCharacterInterval !== null && restCharacterInterval <= 0) {
      throw adapterError(
        'K4-TW-ACTOR-002',
        `${kind}.restCharacterIntervalSeconds must be greater than zero`,
      );
    }
    let characterSound = null;
    let startSound = null;
    if (Object.hasOwn(value, 'startSound')) {
      if (typeof value.startSound !== 'string' || value.startSound.length === 0) {
        throw adapterError('K4-TW-ACTOR-002', `${kind}.startSound must be a non-empty string`);
      }
      startSound = value.startSound;
    }
    if (Object.hasOwn(value, 'characterSound')) {
      if (typeof value.characterSound !== 'string' || value.characterSound.length === 0) {
        throw adapterError('K4-TW-ACTOR-002', `${kind}.characterSound must be a non-empty string`);
      }
      characterSound = value.characterSound;
    }
    if (characterSound !== null && (!playSpeechSound || !stopSpeechSound)) {
      throw adapterError(
        'K4-TW-ACTOR-002',
        `${kind}.characterSound requires sound playback callbacks`,
      );
    }
    if (startSound !== null && (!playSpeechSound || !stopSpeechSound)) {
      throw adapterError('K4-TW-ACTOR-002', `${kind}.startSound requires sound playback callbacks`);
    }
    /** @param {unknown} source @param {string} field */
    const segmentGraphemes = (source, field) => {
      if (typeof source !== 'string' || source.length === 0) {
        throw adapterError('K4-TW-ACTOR-002', `${kind}.${field} must be a non-empty string`);
      }
      const result = segmentText(source);
      if (!Array.isArray(result) || result.some((segment) => typeof segment !== 'string')) {
        throw adapterError('K4-TW-ACTOR-002', 'segmentText must return a string array');
      }
      return result;
    };
    const segments = text.length === 0 ? [] : segmentGraphemes(text, 'text');
    const bubbleRevealChunks = bubbleReveal ? splitBubbleText(text, bubbleReveal) : [];
    const noSoundSegments = new Set(
      Object.hasOwn(value, 'noSoundCharacters')
        ? segmentGraphemes(value.noSoundCharacters, 'noSoundCharacters')
        : [],
    );
    const restSegments = new Set(
      Object.hasOwn(value, 'restCharacters')
        ? segmentGraphemes(value.restCharacters, 'restCharacters')
        : [],
    );
    const showBubble = kind === 'say' ? say : /** @type {Function | null} */ (think);
    let state = 'idle';
    /** @type {unknown} */
    let deadlineTimer;
    /** @type {unknown} */
    let characterTimer;
    let visibleCount = 0;
    let bubbleRevealedCount = bubbleReveal ? Math.min(1, bubbleRevealChunks.length) : 0;
    let bubbleMotionsStarted = false;
    /** @type {(() => void) | undefined} */
    let resolveOperation;
    /** @type {((error: unknown) => void) | undefined} */
    let rejectOperation;
    const playedSounds = new Set();
    let textCompleteNotified = false;
    let terminalNotified = false;
    /** @type {() => void} */
    let onTextComplete = () => {};
    /** @type {() => void} */
    let onTerminal = () => {};
    /** @type {Record<string, any> | null} */
    let bubbleHandle = null;
    let presentationTail = Promise.resolve();

    const cancelTimers = () => {
      if (deadlineTimer !== undefined) scheduler.clearTimeout(deadlineTimer);
      if (characterTimer !== undefined) scheduler.clearTimeout(characterTimer);
      deadlineTimer = undefined;
      characterTimer = undefined;
    };
    const stopSounds = () => {
      if (!stopSpeechSound) return;
      for (const sound of playedSounds) {
        try {
          const operation = Promise.resolve(stopSpeechSound(sound));
          void operation.catch(() => {});
        } catch {
          // Sound cleanup cannot prevent the speech operation from settling.
        }
      }
      playedSounds.clear();
    };
    /** @param {string | null} sound */
    const playSound = (sound) => {
      if (sound === null || !playSpeechSound) return;
      let playback;
      try {
        playback = Promise.resolve(playSpeechSound(sound));
        playedSounds.add(sound);
      } catch (error) {
        fail(error);
        return;
      }
      void playback.catch((error) => fail(error));
    };
    /** @param {string} segment */
    const playCharacterSound = (segment) => {
      if (noSoundSegments.has(segment) || restSegments.has(segment)) return;
      playSound(characterSound);
    };
    /** @param {string} visibleText @param {boolean} fullyRevealed */
    const queueBubbleText = (visibleText, fullyRevealed) => {
      if (!bubbleEnabled) {
        /** @type {Function} */ (showBubble)(visibleText, actor);
        return;
      }
      presentationTail = presentationTail.then(async () => {
        if (!bubbleHandle) {
          const createdHandle = await /** @type {Record<string, Function>} */ (
            bubbleComposition
          ).show({
            actor,
            actorKey: actor.id,
            kind,
            text: visibleText,
            styleName:
              bubbleStyle === '__dsl4_default__' && kind === 'think'
                ? '__dsl4_default_think__'
                : bubbleStyle,
            animationMode: fullyRevealed && waitForAdvance ? 'awaiting-continue' : 'talking',
            ...(bubbleReveal === null ? {} : {reveal: {...bubbleReveal, intervalSeconds: 0}}),
          });
          bubbleHandle = createdHandle;
          if (!bubbleMotionsStarted && bubbleMotions.length > 0) {
            bubbleMotionsStarted = true;
            for (const motion of bubbleMotions) await createdHandle.animate(motion);
          }
        } else {
          await bubbleHandle.setText(visibleText);
          if (fullyRevealed && waitForAdvance) {
            await bubbleHandle.setAnimationMode('awaiting-continue');
          }
        }
      });
      void presentationTail.catch((error) => fail(error));
    };
    /** @param {number} count @param {boolean} withSound */
    const reveal = (count, withSound) => {
      visibleCount = Math.min(count, segments.length);
      queueBubbleText(segments.slice(0, visibleCount).join(''), visibleCount >= segments.length);
      if (withSound && visibleCount > 0) playCharacterSound(segments[visibleCount - 1]);
    };
    const nextCharacterInterval = () =>
      visibleCount > 0 && restSegments.has(segments[visibleCount - 1])
        ? /** @type {number} */ (restCharacterInterval)
        : /** @type {number} */ (characterInterval);
    const notifyTextComplete = () => {
      if (textCompleteNotified) return;
      textCompleteNotified = true;
      onTextComplete();
    };
    const notifyTerminal = () => {
      if (terminalNotified) return;
      terminalNotified = true;
      onTerminal();
    };
    const cancelCharacterTimer = () => {
      if (characterTimer !== undefined) scheduler.clearTimeout(characterTimer);
      characterTimer = undefined;
    };
    const markBubbleRevealComplete = async () => {
      if (bubbleReveal === null || bubbleRevealedCount < bubbleRevealChunks.length) return;
      if (waitForAdvance) await bubbleHandle?.setAnimationMode('awaiting-continue');
      notifyTextComplete();
    };
    const scheduleBubbleReveal = () => {
      if (
        bubbleReveal === null ||
        bubbleReveal.intervalSeconds <= 0 ||
        bubbleRevealedCount >= bubbleRevealChunks.length
      ) {
        return;
      }
      characterTimer = scheduler.setTimeout(() => {
        characterTimer = undefined;
        if (state !== 'running') return;
        presentationTail = presentationTail.then(async () => {
          if (!bubbleHandle || state !== 'running') return;
          const advanced = await bubbleHandle.revealNext();
          if (advanced) bubbleRevealedCount += 1;
          if (bubbleRevealedCount >= bubbleRevealChunks.length) {
            await markBubbleRevealComplete();
          } else {
            scheduleBubbleReveal();
          }
        });
        void presentationTail.catch((error) => fail(error));
      }, bubbleReveal.intervalSeconds * 1000);
    };
    /** @param {'next' | 'all'} mode */
    const revealBubbleFromAdvance = (mode) => {
      cancelCharacterTimer();
      presentationTail = presentationTail.then(async () => {
        if (!bubbleHandle || bubbleReveal === null) return;
        if (mode === 'all') {
          await bubbleHandle.revealAll();
          bubbleRevealedCount = bubbleRevealChunks.length;
        } else {
          const advanced = await bubbleHandle.revealNext();
          if (advanced) bubbleRevealedCount += 1;
        }
        if (bubbleRevealedCount >= bubbleRevealChunks.length) {
          await markBubbleRevealComplete();
        }
      });
      void presentationTail.catch((error) => fail(error));
    };
    /** @param {'advance' | 'timeout' | 'cancel'} reason */
    const complete = (reason) => {
      if (state === 'completed' || state === 'completing' || state === 'failed') return;
      cancelTimers();
      try {
        if (bubbleReveal === null && reason !== 'cancel' && visibleCount < segments.length) {
          reveal(segments.length, false);
        }
        stopSounds();
        notifyTerminal();
        if (!bubbleEnabled) {
          /** @type {Function} */ (showBubble)('', actor);
          state = 'completed';
          resolveOperation?.();
          return;
        }
        state = 'completing';
        presentationTail = presentationTail.then(async () => {
          if (reason !== 'cancel' && typeof bubbleHandle?.finish === 'function') {
            await bubbleHandle.finish();
          }
          await bubbleHandle?.close();
          bubbleHandle = null;
        });
        void presentationTail.then(
          () => {
            state = 'completed';
            resolveOperation?.();
          },
          (error) => fail(error),
        );
      } catch (error) {
        fail(error);
      }
    };
    /** @param {unknown} error */
    function fail(error) {
      if (state === 'completed' || state === 'failed') return;
      cancelTimers();
      stopSounds();
      try {
        notifyTerminal();
      } catch {
        // The original presentation error remains authoritative.
      }
      state = 'failed';
      if (!bubbleEnabled) {
        try {
          /** @type {Function} */ (showBubble)('', actor);
        } catch {
          // The original presentation error remains authoritative.
        }
        rejectOperation?.(error);
        return;
      }
      void Promise.resolve(bubbleHandle?.close()).then(
        () => rejectOperation?.(error),
        (cleanupError) =>
          rejectOperation?.(
            new AggregateError([error, cleanupError], 'Bubble presentation cleanup failed'),
          ),
      );
    }

    return Object.freeze({
      start() {
        if (state !== 'idle') {
          throw adapterError('K4-TW-ACTOR-003', `${kind} operation can only start once`);
        }
        state = 'running';
        return new Promise((resolve, reject) => {
          resolveOperation = () => resolve(undefined);
          rejectOperation = (error) => reject(error);
          try {
            if (bubbleReveal !== null) {
              queueBubbleText(text, false);
              playSound(startSound);
              presentationTail = presentationTail.then(async () => {
                if (state !== 'running') return;
                if (bubbleRevealedCount >= bubbleRevealChunks.length) {
                  await markBubbleRevealComplete();
                } else {
                  scheduleBubbleReveal();
                }
              });
              void presentationTail.catch((error) => fail(error));
            } else if (characterInterval !== null && segments.length > 0) {
              reveal(1, false);
              playSound(startSound);
              if (state !== 'running') return;
              playCharacterSound(segments[0]);
              if (segments.length === 1) notifyTextComplete();
              const tick = () => {
                characterTimer = undefined;
                if (state !== 'running' || visibleCount >= segments.length) return;
                try {
                  reveal(visibleCount + 1, true);
                  if (state === 'running' && visibleCount >= segments.length) {
                    notifyTextComplete();
                  }
                  if (state === 'running' && visibleCount < segments.length) {
                    characterTimer = scheduler.setTimeout(tick, nextCharacterInterval());
                  }
                } catch (error) {
                  fail(error);
                }
              };
              if (state === 'running' && visibleCount < segments.length) {
                characterTimer = scheduler.setTimeout(tick, nextCharacterInterval());
              }
            } else {
              reveal(segments.length, false);
              playSound(startSound);
              if (state === 'running') notifyTextComplete();
            }
            if (state !== 'running') return;
            if (duration === 0) {
              complete('timeout');
            } else if (duration !== null) {
              deadlineTimer = scheduler.setTimeout(() => {
                deadlineTimer = undefined;
                complete('timeout');
              }, duration);
            }
          } catch (error) {
            fail(error);
          }
        });
      },
      /** @param {string} [reason] */
      finish(reason) {
        if (
          reason === 'advance' &&
          state === 'running' &&
          bubbleReveal !== null &&
          bubbleRevealedCount < bubbleRevealChunks.length
        ) {
          revealBubbleFromAdvance(bubbleReveal.intervalSeconds === 0 ? 'next' : 'all');
          return Object.freeze({consumed: true});
        }
        complete(reason === 'advance' ? 'advance' : 'cancel');
        return Object.freeze({consumed: false});
      },
      /** @param {unknown} lifecycle */
      setSpeechLifecycle(lifecycle) {
        if (
          state !== 'idle' ||
          !isRecord(lifecycle) ||
          typeof lifecycle.onTextComplete !== 'function' ||
          typeof lifecycle.onTerminal !== 'function' ||
          Object.keys(lifecycle).some((key) => key !== 'onTextComplete' && key !== 'onTerminal')
        ) {
          throw adapterError(
            'K4-TW-ACTOR-003',
            `${kind} speech lifecycle must be installed before start`,
          );
        }
        onTextComplete = /** @type {() => void} */ (lifecycle.onTextComplete);
        onTerminal = /** @type {() => void} */ (lifecycle.onTerminal);
      },
    });
  }

  const host = Object.freeze({
    /** @param {unknown} target @param {unknown} transform */
    showActor(target, transform) {
      const actor = validateActor(target);
      const value = validateSpec(transform, ['x', 'y', 'scale'], 'showActor');
      const x = finiteNumber(value.x, 'showActor.x');
      const y = finiteNumber(value.y, 'showActor.y');
      const scale = finiteNumber(value.scale, 'showActor.scale');
      if (scale <= 0) throw adapterError('K4-TW-ACTOR-002', 'showActor.scale must be positive');
      actor.setXY(x, y);
      actor.setSize(scale);
      actor.setVisible(true);
    },

    /** @param {unknown} target */
    hideActor(target) {
      ensureActive();
      validateActor(target).setVisible(false);
    },

    /** @param {unknown} target @param {unknown} scale */
    setActorScale(target, scale) {
      ensureActive();
      const value = finiteNumber(scale, 'setActorScale.scale');
      if (value <= 0) {
        throw adapterError('K4-TW-ACTOR-002', 'setActorScale.scale must be positive');
      }
      validateActor(target).setSize(value);
    },

    /** @param {unknown} target @param {unknown} layer */
    setActorLayer(target, layer) {
      ensureActive();
      const actor = validateActor(target);
      if (layer === 'front') {
        if (typeof actor.goToFront !== 'function') {
          throw adapterError('K4-TW-ACTOR-002', 'TurboWarp actor must provide goToFront');
        }
        actor.goToFront();
        return;
      }
      if (layer === 'back') {
        if (typeof actor.goToBack !== 'function') {
          throw adapterError('K4-TW-ACTOR-002', 'TurboWarp actor must provide goToBack');
        }
        actor.goToBack();
        return;
      }
      const count = finiteNumber(layer, 'setActorLayer.layer');
      const method = count >= 0 ? 'goForwardLayers' : 'goBackwardLayers';
      if (typeof actor[method] !== 'function') {
        throw adapterError('K4-TW-ACTOR-002', `TurboWarp actor must provide ${method}`);
      }
      actor[method](Math.abs(count));
    },

    /** @param {unknown} target @param {unknown} effect */
    setTransparency(target, effect) {
      ensureActive();
      const actor = validateEffectActor(target);
      const value = validateSpec(effect, ['transparency'], 'setTransparency');
      const transparency = finiteNumber(value.transparency, 'setTransparency.transparency');
      if (transparency < 0 || transparency > 100) {
        throw adapterError(
          'K4-TW-ACTOR-002',
          'setTransparency.transparency must be between 0 and 100',
        );
      }
      activeTransparencyTransitions.get(actor)?.finish();
      actor.setEffect('ghost', transparency);
    },

    /** @param {unknown} target @param {unknown} transition */
    createTransparencyTransition(target, transition) {
      ensureActive();
      const actor = validateEffectActor(target);
      const value = validateSpec(transition, ['from', 'to', 'seconds'], 'setTransparency');
      const from = finiteNumber(value.from, 'setTransparency.from');
      const to = finiteNumber(value.to, 'setTransparency.to');
      if (from < 0 || from > 100 || to < 0 || to > 100) {
        throw adapterError(
          'K4-TW-ACTOR-002',
          'setTransparency from and to must be between 0 and 100',
        );
      }
      const duration = durationMilliseconds(
        /** @type {number} */ (value.seconds),
        'setTransparency',
      );
      let state = 'idle';
      /** @type {unknown} */
      let timer;
      /** @type {(() => void) | undefined} */
      let resolveOperation;
      /** @type {((error: unknown) => void) | undefined} */
      let rejectOperation;
      /** @type {unknown} */
      let backgroundFailure;
      let operationSettled = false;
      let backgroundOwned = false;

      const cancelTimer = () => {
        if (timer === undefined) return;
        scheduler.clearTimeout(timer);
        timer = undefined;
      };
      const removeActiveTransition = () => {
        if (activeTransparencyTransitions.get(actor)?.finish === finish) {
          activeTransparencyTransitions.delete(actor);
        }
      };
      const resolvePresentation = () => {
        if (operationSettled) return;
        operationSettled = true;
        resolveOperation?.();
      };
      /** @param {unknown} error */
      const rejectPresentation = (error) => {
        if (operationSettled) return;
        operationSettled = true;
        rejectOperation?.(error);
      };
      const applyFinalState = () => {
        cancelTimer();
        try {
          actor.setEffect('ghost', to);
        } catch (error) {
          state = 'finalization-pending';
          throw error;
        }
        state = 'completed';
        removeActiveTransition();
      };
      const finish = () => {
        if (state === 'completed') return;
        try {
          applyFinalState();
        } catch (error) {
          const terminalError =
            backgroundFailure === undefined
              ? error
              : new AggregateError(
                  [backgroundFailure, error],
                  'TurboWarp actor transparency finalization retry failed',
                );
          backgroundFailure = terminalError;
          if (backgroundOwned) rejectPresentation(terminalError);
          throw terminalError;
        }
        resolvePresentation();
      };
      /** @param {unknown} error */
      const fail = (error) => {
        if (state !== 'running') return;
        cancelTimer();
        backgroundFailure = error;
        try {
          applyFinalState();
        } catch (finishError) {
          backgroundFailure = new AggregateError(
            [error, finishError],
            'TurboWarp actor transparency transition and finalization failed',
          );
        }
        rejectPresentation(backgroundFailure);
      };

      /** @param {boolean} background */
      const startOperation = (background) => {
        if (state !== 'idle') {
          throw adapterError('K4-TW-ACTOR-003', 'setTransparency operation can only start once');
        }
        ensureActive();
        backgroundOwned = background;
        const startTime = finiteNumber(scheduler.now(), 'scheduler.now()');
        activeTransparencyTransitions.get(actor)?.finish();
        actor.setEffect('ghost', from);
        state = 'running';
        activeTransparencyTransitions.set(actor, operation);
        return new Promise((resolve, reject) => {
          resolveOperation = () => resolve(undefined);
          rejectOperation = (error) => reject(error);
          if (duration === 0) {
            try {
              finish();
            } catch (error) {
              backgroundFailure = error;
            }
            return;
          }
          const tick = () => {
            timer = undefined;
            if (state !== 'running') return;
            try {
              const elapsed = Math.max(
                0,
                finiteNumber(scheduler.now(), 'scheduler.now()') - startTime,
              );
              const progress = Math.min(elapsed / duration, 1);
              if (progress >= 1) {
                finish();
                return;
              }
              actor.setEffect('ghost', from + (to - from) * progress);
              timer = scheduler.setTimeout(tick, Math.min(frameMilliseconds, duration - elapsed));
            } catch (error) {
              fail(error);
            }
          };
          try {
            timer = scheduler.setTimeout(tick, Math.min(frameMilliseconds, duration));
          } catch (error) {
            fail(error);
          }
        });
      };

      const operation = Object.freeze({
        start() {
          return startOperation(false);
        },
        startBackground() {
          const presentation = startOperation(true);
          void presentation.catch((error) => {
            backgroundFailure = error;
          });
        },
        finish,
      });
      return operation;
    },

    /** @param {unknown} target @param {unknown} destination */
    createMove(target, destination) {
      const actor = validateActor(target);
      const value = validateSpec(destination, ['x', 'y', 'seconds'], 'moveTo', ['easing']);
      const destinationX = finiteNumber(value.x, 'moveTo.x');
      const destinationY = finiteNumber(value.y, 'moveTo.y');
      const duration = durationMilliseconds(/** @type {number} */ (value.seconds), 'moveTo');
      const easing = value.easing ?? 'linear';
      if (!isDsl4MoveEasing(easing)) {
        throw adapterError(
          'K4-TW-ACTOR-002',
          `moveTo.easing must be one of ${dsl4MoveEasingNames.join(', ')}`,
        );
      }
      let state = 'idle';
      /** @type {unknown} */
      let timer;
      /** @type {(() => void) | undefined} */
      let resolveOperation;
      /** @type {((error: unknown) => void) | undefined} */
      let rejectOperation;

      const cancelTimer = () => {
        if (timer === undefined) return;
        scheduler.clearTimeout(timer);
        timer = undefined;
      };
      const complete = () => {
        if (state === 'completed' || state === 'failed') return;
        cancelTimer();
        actor.setXY(destinationX, destinationY);
        state = 'completed';
        resolveOperation?.();
      };
      /** @param {unknown} error */
      const fail = (error) => {
        if (state !== 'running') return;
        cancelTimer();
        state = 'failed';
        rejectOperation?.(error);
      };

      return Object.freeze({
        start() {
          if (state !== 'idle') {
            throw adapterError('K4-TW-ACTOR-003', 'moveTo operation can only start once');
          }
          const startX = finiteNumber(actor.x, 'actor.x');
          const startY = finiteNumber(actor.y, 'actor.y');
          const startTime = finiteNumber(scheduler.now(), 'scheduler.now()');
          state = 'running';
          return new Promise((resolve, reject) => {
            resolveOperation = () => resolve(undefined);
            rejectOperation = (error) => reject(error);
            if (duration === 0) {
              try {
                complete();
              } catch (error) {
                fail(error);
              }
              return;
            }
            const tick = () => {
              timer = undefined;
              try {
                const elapsed = Math.max(
                  0,
                  finiteNumber(scheduler.now(), 'scheduler.now()') - startTime,
                );
                const progress = Math.min(elapsed / duration, 1);
                if (progress >= 1) {
                  complete();
                  return;
                }
                const easedProgress = applyDsl4MoveEasing(easing, progress);
                actor.setXY(
                  startX + (destinationX - startX) * easedProgress,
                  startY + (destinationY - startY) * easedProgress,
                );
                timer = scheduler.setTimeout(tick, Math.min(frameMilliseconds, duration - elapsed));
              } catch (error) {
                fail(error);
              }
            };
            try {
              timer = scheduler.setTimeout(tick, Math.min(frameMilliseconds, duration));
            } catch (error) {
              fail(error);
            }
          });
        },
        finish: complete,
      });
    },

    /** @param {unknown} target @param {unknown} speech */
    createSay(target, speech) {
      return createSpeech('say', target, speech);
    },

    /** @param {unknown} target @param {unknown} speech */
    createThink(target, speech) {
      return createSpeech('think', target, speech);
    },
  });

  return Object.freeze({
    host,
    resolveActor,
    finishTransparencyTransitions,
    dispose() {
      if (disposed) return;
      finishTransparencyTransitions();
      disposed = true;
    },
  });
}
