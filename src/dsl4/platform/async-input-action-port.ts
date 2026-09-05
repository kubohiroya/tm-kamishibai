import {createDsl4OrderedCursorNotifier} from './ordered-cursor-notifier.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inputPortError(message: string) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: 'K4-ASYNC-INPUT-PORT-001'});
  return error;
}

function validateComposition(value: unknown) {
  const methods = ['waitForKeyCandidate', 'waitForActorTouchCandidate'];
  if (!isRecord(value) || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`Async Input composition must provide ${methods.join(', ')}`);
  }
  return value as Record<string, Function>;
}

function validateArbitration(value: unknown) {
  if (value === undefined) return null;
  if (
    !isRecord(value) ||
    typeof value.beginStoryInput !== 'function' ||
    typeof value.finishStoryInput !== 'function'
  ) {
    throw new TypeError('inputArbitration must provide beginStoryInput and finishStoryInput');
  }
  return value as Record<string, Function>;
}

function validateCandidates(value: unknown, property: 'codes' | 'actors') {
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
  return candidates as string[];
}

function validateSignal(value: unknown) {
  const signal = isRecord(value) ? value.signal : null;
  if (
    !isRecord(signal) ||
    typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function' ||
    typeof signal.removeEventListener !== 'function'
  ) {
    throw inputPortError('Async input action context must provide an AbortSignal');
  }
  return signal as unknown as AbortSignal;
}

/** Adapt one session-owned Async Input composition to DSL 4.0 scene-transition actions. */
export function createDsl4AsyncInputActionPort(options: {
  composition: unknown;
  inputArbitration?: unknown;
  setCursor?: (
    payload: Readonly<{visible: boolean; source: string; cursor: string}>,
  ) => unknown | Promise<unknown>;
}) {
  if (!isRecord(options)) throw new TypeError('Async input action port options must be an object');
  const composition = validateComposition(options.composition);
  const inputArbitration = validateArbitration(options.inputArbitration);
  const setCursor = options.setCursor;
  if (setCursor !== undefined && typeof setCursor !== 'function') {
    throw new TypeError('setCursor must be a function');
  }
  let touchCursorId = 0;
  const publishCursor = setCursor ? createDsl4OrderedCursorNotifier(setCursor) : null;

  function notifyTouchCursor(visible: boolean, source: string) {
    publishCursor?.(Object.freeze({visible, source, cursor: 'pointer'}));
  }

  function runWait(kind: 'key' | 'touch', inputCandidates: string[], wait: () => unknown) {
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
    keyInputToChangeScene(payload: unknown, context: unknown) {
      const inputCandidates = validateCandidates(payload, 'codes');
      const signal = validateSignal(context);
      return runWait('key', inputCandidates, () =>
        composition.waitForKeyCandidate({candidates: inputCandidates, signal}),
      );
    },

    touchInputToChangeScene(payload: unknown, context: unknown) {
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
