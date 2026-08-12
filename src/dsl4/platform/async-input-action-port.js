import {createDsl4OrderedCursorNotifier} from './ordered-cursor-notifier.js';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} message */
function inputPortError(message) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: 'K4-ASYNC-INPUT-PORT-001'});
  return error;
}

/** @param {unknown} value */
function validateComposition(value) {
  const methods = ['waitForKeyCandidate', 'waitForActorTouchCandidate'];
  if (!isRecord(value) || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`Async Input composition must provide ${methods.join(', ')}`);
  }
  return /** @type {Record<string, Function>} */ (value);
}

/** @param {unknown} value */
function validateArbitration(value) {
  if (value === undefined) return null;
  if (
    !isRecord(value) ||
    typeof value.beginStoryInput !== 'function' ||
    typeof value.finishStoryInput !== 'function'
  ) {
    throw new TypeError('inputArbitration must provide beginStoryInput and finishStoryInput');
  }
  return /** @type {Record<string, Function>} */ (value);
}

/** @param {unknown} value @param {'codes' | 'actors'} property */
function validateCandidates(value, property) {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value[property])) {
    throw inputPortError(`${property} payload must contain one candidates array`);
  }
  const candidates = value[property];
  if (
    candidates.length === 0 ||
    candidates.some(
      (candidate) =>
        typeof candidate !== 'string' || candidate.length === 0 || candidate !== candidate.trim(),
    ) ||
    new Set(candidates).size !== candidates.length
  ) {
    throw inputPortError(`${property} candidates must be non-empty unique strings`);
  }
  return /** @type {string[]} */ (candidates);
}

/** @param {unknown} value */
function validateSignal(value) {
  const signal = isRecord(value) ? value.signal : null;
  if (
    !isRecord(signal) ||
    typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function' ||
    typeof signal.removeEventListener !== 'function'
  ) {
    throw inputPortError('Async input action context must provide an AbortSignal');
  }
  return /** @type {AbortSignal} */ (/** @type {unknown} */ (signal));
}

/**
 * Adapt one session-owned Async Input composition to DSL 4.0 scene-transition actions.
 *
 * @param {object} options
 * @param {unknown} options.composition
 * @param {unknown} [options.inputArbitration]
 * @param {(payload: Readonly<{visible: boolean, source: string, cursor: string}>) => unknown | Promise<unknown>} [options.setCursor]
 */
export function createDsl4AsyncInputActionPort(options) {
  if (!isRecord(options)) throw new TypeError('Async input action port options must be an object');
  const composition = validateComposition(options.composition);
  const inputArbitration = validateArbitration(options.inputArbitration);
  const setCursor = options.setCursor;
  if (setCursor !== undefined && typeof setCursor !== 'function') {
    throw new TypeError('setCursor must be a function');
  }
  let touchCursorId = 0;
  const publishCursor = setCursor ? createDsl4OrderedCursorNotifier(setCursor) : null;

  /** @param {boolean} visible @param {string} source */
  function notifyTouchCursor(visible, source) {
    publishCursor?.(Object.freeze({visible, source, cursor: 'pointer'}));
  }

  /**
   * @param {'key' | 'touch'} kind
   * @param {string[]} inputCandidates
   * @param {() => unknown} wait
   */
  function runWait(kind, inputCandidates, wait) {
    if (!inputArbitration) return wait();
    const token = inputArbitration.beginStoryInput(kind, inputCandidates);
    let operation;
    try {
      operation = wait();
    } catch (error) {
      inputArbitration.finishStoryInput(token);
      throw error;
    }
    return Promise.resolve(operation).then(
      (candidate) => {
        inputArbitration.finishStoryInput(token, {accepted: true});
        return candidate;
      },
      (error) => {
        inputArbitration.finishStoryInput(token);
        throw error;
      },
    );
  }

  return Object.freeze({
    /** @param {unknown} payload @param {unknown} context */
    keyInputToChangeScene(payload, context) {
      const inputCandidates = validateCandidates(payload, 'codes');
      const signal = validateSignal(context);
      return runWait('key', inputCandidates, () =>
        composition.waitForKeyCandidate({candidates: inputCandidates, signal}),
      );
    },

    /** @param {unknown} payload @param {unknown} context */
    touchInputToChangeScene(payload, context) {
      const inputCandidates = validateCandidates(payload, 'actors');
      const signal = validateSignal(context);
      touchCursorId += 1;
      const cursorSource = `touch-input-${touchCursorId}`;
      notifyTouchCursor(true, cursorSource);
      let operation;
      try {
        operation = runWait('touch', inputCandidates, () =>
          composition.waitForActorTouchCandidate({candidates: inputCandidates, signal}),
        );
      } catch (error) {
        notifyTouchCursor(false, cursorSource);
        throw error;
      }
      return Promise.resolve(operation).finally(() => notifyTouchCursor(false, cursorSource));
    },
  });
}
