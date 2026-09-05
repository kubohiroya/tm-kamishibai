import {deepFreeze} from './story-document.js';

const debugModes = new Set(['breakpoints', 'step']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function abortError(reason: unknown) {
  const error = new Error(String(reason ?? 'Debug execution was cancelled'));
  error.name = 'AbortError';
  return error;
}

/** Coordinate development-only action pauses without persisting debug preferences in a story. */
export function createDsl4DebugExecutionCoordinator({
  enabled = false,
  mode = 'breakpoints',
}: {enabled?: boolean; mode?: 'breakpoints' | 'step'} = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('debug execution enabled must be boolean');
  if (typeof mode !== 'string' || !debugModes.has(mode)) {
    throw new TypeError('debug execution mode must be breakpoints or step');
  }

  let currentMode = mode;
  let revision = 0;
  let disposed = false;
  const subscribers: Set<(state: Readonly<Record<string, unknown>>) => unknown> = new Set();
  let activePause: {resolve: Function; reject: Function; cleanup: Function} | null = null;
  let pauseLocation: Readonly<Record<string, unknown>> | null = null;

  function snapshot() {
    return deepFreeze({
      version: 1,
      enabled,
      mode: currentMode,
      status: !enabled ? 'disabled' : pauseLocation ? 'paused' : 'running',
      paused: pauseLocation !== null,
      reason: pauseLocation?.reason ?? null,
      sceneId: pauseLocation?.sceneId ?? null,
      actionIndex: pauseLocation?.actionIndex ?? null,
      actionPath: pauseLocation?.actionPath ?? null,
      command: pauseLocation?.command ?? null,
      revision,
      disposed,
    });
  }

  function publish() {
    const state = snapshot();
    for (const subscriber of subscribers) {
      try {
        subscriber(state);
      } catch {
        // Debug observers cannot change execution semantics.
      }
    }
    return state;
  }

  function releasePause(outcome: 'resume' | 'cancel', reason?: unknown) {
    const pause = activePause;
    if (!pause) return snapshot();
    activePause = null;
    pauseLocation = null;
    pause.cleanup();
    revision += 1;
    const state = publish();
    if (outcome === 'resume') pause.resolve(state);
    else pause.reject(abortError(reason));
    return state;
  }

  return Object.freeze({
    enabled,
    getState: snapshot,
    subscribe(subscriber: (state: Readonly<Record<string, unknown>>) => unknown) {
      if (typeof subscriber !== 'function') {
        throw new TypeError('debug execution subscriber must be a function');
      }
      if (disposed) throw new TypeError('debug execution coordinator is disposed');
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    setMode(nextMode: 'breakpoints' | 'step') {
      if (typeof nextMode !== 'string' || !debugModes.has(nextMode)) {
        throw new TypeError('debug execution mode must be breakpoints or step');
      }
      if (disposed) throw new TypeError('debug execution coordinator is disposed');
      if (currentMode === nextMode) return snapshot();
      currentMode = nextMode;
      revision += 1;
      return publish();
    },
    beforeAction(input: unknown): Promise<Readonly<Record<string, unknown>>> {
      if (!isRecord(input)) return Promise.reject(new TypeError('debug action input is required'));
      const {command, sceneId, actionIndex, actionPath, signal} = input;
      if (
        typeof command !== 'string' ||
        typeof sceneId !== 'string' ||
        !Number.isSafeInteger(actionIndex) ||
        Number(actionIndex) < 0 ||
        typeof actionPath !== 'string' ||
        !isRecord(signal) ||
        typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function'
      ) {
        return Promise.reject(new TypeError('debug action input is invalid'));
      }
      const actionSignal = signal as unknown as AbortSignal;
      if (disposed) return Promise.reject(new TypeError('debug execution coordinator is disposed'));
      if (!enabled || (currentMode !== 'step' && command !== 'debugger')) {
        return Promise.resolve(snapshot());
      }
      if (activePause) {
        return Promise.reject(new TypeError('debug execution already has an active pause'));
      }
      if (actionSignal.aborted) return Promise.reject(abortError(actionSignal.reason));

      return new Promise((resolve, reject) => {
        const onAbort = () => releasePause('cancel', actionSignal.reason);
        const cleanup = () => actionSignal.removeEventListener('abort', onAbort);
        activePause = {resolve, reject, cleanup};
        pauseLocation = deepFreeze({
          reason: command === 'debugger' ? 'debugger' : 'step',
          sceneId,
          actionIndex: Number(actionIndex),
          actionPath,
          command,
        });
        actionSignal.addEventListener('abort', onAbort, {once: true});
        revision += 1;
        publish();
      });
    },
    resume() {
      if (disposed) throw new TypeError('debug execution coordinator is disposed');
      return releasePause('resume');
    },
    cancel(reason = 'debug execution cancelled') {
      if (disposed) return snapshot();
      return releasePause('cancel', reason);
    },
    dispose() {
      if (disposed) return snapshot();
      releasePause('cancel', 'debug execution disposed');
      disposed = true;
      revision += 1;
      const state = publish();
      subscribers.clear();
      return state;
    },
  });
}
