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
 */
export function createDsl4AsyncInputActionPort(options) {
  if (!isRecord(options)) throw new TypeError('Async input action port options must be an object');
  const composition = validateComposition(options.composition);

  return Object.freeze({
    /** @param {unknown} payload @param {unknown} context */
    keyInputToChangeScene(payload, context) {
      return composition.waitForKeyCandidate({
        candidates: validateCandidates(payload, 'codes'),
        signal: validateSignal(context),
      });
    },

    /** @param {unknown} payload @param {unknown} context */
    touchInputToChangeScene(payload, context) {
      return composition.waitForActorTouchCandidate({
        candidates: validateCandidates(payload, 'actors'),
        signal: validateSignal(context),
      });
    },
  });
}
