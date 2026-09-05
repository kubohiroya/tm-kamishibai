const transitionEndpoints = Object.freeze({
  fadeOut: -100,
  fadeUp: 0,
  fadeToWhite: 100,
  fadeFromWhite: 0,
  reset: 0,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function transitionError(code: string, message: string) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

function abortError() {
  const error = transitionError('K4-TRANSITION-PORT-003', 'Stage transition was cancelled');
  error.name = 'AbortError';
  return error;
}

function defaultScheduler() {
  return Object.freeze({
    setTimeout(callback: () => void, milliseconds: number) {
      return setTimeout(callback, milliseconds);
    },
    clearTimeout(handle: ReturnType<typeof setTimeout>) {
      clearTimeout(handle);
    },
  });
}

function validateScheduler(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.setTimeout !== 'function' ||
    typeof value.clearTimeout !== 'function'
  ) {
    throw new TypeError('transition scheduler must provide setTimeout and clearTimeout');
  }
  return value as {
    setTimeout: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  };
}

function validateContext(value: unknown) {
  const signal = isRecord(value) ? value.signal : null;
  if (
    !isRecord(signal) ||
    typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function' ||
    typeof signal.removeEventListener !== 'function'
  ) {
    throw transitionError(
      'K4-TRANSITION-PORT-001',
      'transition context must provide an AbortSignal',
    );
  }
  return signal as unknown as AbortSignal;
}

function validatePayload(value: unknown) {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['effect', 'seconds'].includes(key)) ||
    typeof value.effect !== 'string' ||
    !Object.hasOwn(transitionEndpoints, value.effect) ||
    typeof value.seconds !== 'number' ||
    !Number.isFinite(value.seconds) ||
    value.seconds < 0
  ) {
    throw transitionError(
      'K4-TRANSITION-PORT-001',
      'transition must provide a supported effect and non-negative seconds',
    );
  }
  return value as unknown as {effect: keyof typeof transitionEndpoints; seconds: number};
}

/**
 * Render the DSL 3.2 brightness transitions through one TurboWarp Stage target.
 * Cancellation commits the named effect endpoint synchronously before rejecting, matching the
 * rehearsal skip behavior of the 3.2 runtime.
 */
export function createDsl4TurboWarpTransitionPort(options: {
  runtime: unknown;
  scheduler?: unknown;
  now?: () => number;
  frameMilliseconds?: number;
}) {
  if (!isRecord(options)) throw new TypeError('transition port options must be an object');
  const runtime = options.runtime;
  if (!isRecord(runtime) || typeof runtime.getTargetForStage !== 'function') {
    throw new TypeError('TurboWarp runtime must provide getTargetForStage');
  }
  const stageCandidate = runtime.getTargetForStage();
  if (
    !isRecord(stageCandidate) ||
    stageCandidate.isStage !== true ||
    typeof stageCandidate.setEffect !== 'function'
  ) {
    throw transitionError('K4-TRANSITION-PORT-002', 'TurboWarp Stage target is unavailable');
  }
  const stage = stageCandidate as Record<string, unknown> & {
    setEffect: (effect: string, value: number) => void;
  };
  const scheduler = validateScheduler(options.scheduler ?? defaultScheduler());
  const now = options.now ?? (() => performance.now());
  if (typeof now !== 'function') throw new TypeError('transition now must be a function');
  const frameMilliseconds = options.frameMilliseconds ?? 50;
  if (!Number.isFinite(frameMilliseconds) || frameMilliseconds <= 0) {
    throw new TypeError('transition frameMilliseconds must be positive');
  }
  let disposed = false;
  let active: {finish: () => void} | null = null;

  function currentBrightness() {
    const value = isRecord(stage.effects) ? stage.effects.brightness : 0;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  return Object.freeze({
    transition(payload: unknown, context: unknown) {
      if (disposed) throw transitionError('K4-TRANSITION-PORT-004', 'transition port is disposed');
      const input = validatePayload(payload);
      const signal = validateContext(context);
      if (signal.aborted) throw abortError();
      active?.finish();
      const start = currentBrightness();
      const endpoint = transitionEndpoints[input.effect];
      const durationMilliseconds = input.seconds * 1000;
      if (durationMilliseconds === 0 || start === endpoint) {
        stage.setEffect('brightness', endpoint);
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const startedAt = Number(now());
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const cleanup = () => {
          if (timer !== undefined) scheduler.clearTimeout(timer);
          timer = undefined;
          signal.removeEventListener('abort', handleAbort);
          if (active === operation) active = null;
        };
        const finish = () => {
          if (settled) return;
          settled = true;
          stage.setEffect('brightness', endpoint);
          cleanup();
          resolve(undefined);
        };
        const handleAbort = () => {
          if (settled) return;
          settled = true;
          stage.setEffect('brightness', endpoint);
          cleanup();
          reject(abortError());
        };
        const tick = () => {
          timer = undefined;
          if (settled) return;
          const elapsed = Math.max(0, Number(now()) - startedAt);
          const progress = Math.min(1, elapsed / durationMilliseconds);
          stage.setEffect('brightness', start + (endpoint - start) * progress);
          if (progress >= 1) finish();
          else timer = scheduler.setTimeout(tick, frameMilliseconds);
        };
        const operation = {finish};
        active = operation;
        signal.addEventListener('abort', handleAbort, {once: true});
        timer = scheduler.setTimeout(tick, frameMilliseconds);
        if (signal.aborted) handleAbort();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active?.finish();
      active = null;
    },
  });
}
