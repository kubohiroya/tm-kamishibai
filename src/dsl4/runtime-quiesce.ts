import {deepFreeze} from './story-document.js';

export const dsl4RuntimeQuiesceDefaults = Object.freeze({
  quiesceTimeoutMs: 5_000,
  minimumQuiesceTimeoutMs: 100,
  maximumQuiesceTimeoutMs: 30_000,
});

export function defaultScheduleQuiesceTimeout(callback: () => void, milliseconds: number) {
  const timer = setTimeout(callback, milliseconds);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
}

export function createDsl4RuntimeQuiesceError(
  code: string,
  message: string,
  action: Readonly<Record<string, unknown>> | null,
) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  if (typeof action?.id === 'string') {
    Object.defineProperty(error, 'storyPath', {value: action.id});
  }
  return error;
}

export function retagDsl4QuiesceToken(
  token: Readonly<Record<string, unknown>>,
  candidateId: number,
) {
  return deepFreeze({...token, candidateId});
}

export function createDsl4QuiesceToken({
  candidateId,
  runtimeGeneration,
  storyPath,
  action,
  sceneId,
  actionIndex,
  variables,
  resumeMode,
}: {
  candidateId: number;
  runtimeGeneration: number;
  storyPath: string;
  action: Readonly<Record<string, unknown>> | null;
  sceneId: string | null;
  actionIndex: number;
  variables: Readonly<Record<string, unknown>>;
  resumeMode: 'next-action' | 'replay-action' | 'finished';
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
