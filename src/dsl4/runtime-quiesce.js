import {deepFreeze} from './story-document.js';

export const dsl4RuntimeQuiesceDefaults = Object.freeze({
  quiesceTimeoutMs: 5_000,
  minimumQuiesceTimeoutMs: 100,
  maximumQuiesceTimeoutMs: 30_000,
});

/** @param {() => void} callback @param {number} milliseconds */
export function defaultScheduleQuiesceTimeout(callback, milliseconds) {
  const timer = setTimeout(callback, milliseconds);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
}

/** @param {string} code @param {string} message @param {Readonly<Record<string, unknown>> | null} action */
export function createDsl4RuntimeQuiesceError(code, message, action) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  if (typeof action?.id === 'string') {
    Object.defineProperty(error, 'storyPath', {value: action.id});
  }
  return error;
}

/** @param {Readonly<Record<string, unknown>>} token @param {number} candidateId */
export function retagDsl4QuiesceToken(token, candidateId) {
  return deepFreeze({...token, candidateId});
}

/**
 * @param {object} options
 * @param {number} options.candidateId
 * @param {number} options.runtimeGeneration
 * @param {string} options.storyPath
 * @param {Readonly<Record<string, unknown>> | null} options.action
 * @param {string | null} options.sceneId
 * @param {number} options.actionIndex
 * @param {Readonly<Record<string, unknown>>} options.variables
 * @param {'next-action' | 'replay-action' | 'finished'} options.resumeMode
 */
export function createDsl4QuiesceToken({
  candidateId,
  runtimeGeneration,
  storyPath,
  action,
  sceneId,
  actionIndex,
  variables,
  resumeMode,
}) {
  return deepFreeze({
    kind: 'Dsl4QuiesceToken',
    version: 1,
    candidateId,
    runtimeGeneration,
    storyPath,
    actionSignature: action
      ? {
          command: String(action.command),
          target: action.target === null ? null : String(action.target),
          handler: String(action.handler ?? 'core'),
        }
      : null,
    sceneId,
    actionIndex,
    variables,
    resumeMode,
  });
}
