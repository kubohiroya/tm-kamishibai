import {deepFreeze} from './story-document.js';

export const dsl4AssetSnapshotWatchDefaults = deepFreeze({
  foregroundIntervalMs: 500,
  backgroundIntervalMs: 5_000,
  quietWindowMs: 100,
  retryIntervalMs: 50,
  stabilityTimeoutMs: 2_000,
});

export class Dsl4AssetSnapshotWatchError extends Error {
  code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'Dsl4AssetSnapshotWatchError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function milliseconds(value: unknown, name: string, minimum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

function validateClock(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.now !== 'function' ||
    typeof value.sleep !== 'function' ||
    typeof value.setTimeout !== 'function' ||
    typeof value.clearTimeout !== 'function'
  ) {
    throw new TypeError('asset snapshot watch clock is invalid');
  }
  return value as Readonly<Record<string, Function>>;
}

const defaultClock = Object.freeze({
  now: () => Date.now(),
  sleep: (delay: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, delay);
    }),
  setTimeout: (callback: Function, delay: number) => setTimeout(callback, delay),
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
});

function validateReadResult(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.key !== 'string' ||
    value.key.length === 0 ||
    !isRecord(value.value) ||
    (value.release !== undefined && typeof value.release !== 'function')
  ) {
    throw new TypeError('asset snapshot read must return key, value, and optional release');
  }
  return value as {key: string; value: Readonly<Record<string, unknown>>; release?: Function};
}

function safeDiagnostic(error: unknown) {
  const code =
    isRecord(error) && typeof error.code === 'string' && /^K4-ASSET-[A-Z0-9-]+$/u.test(error.code)
      ? error.code
      : 'K4-ASSET-PREPARE-001';
  const message =
    isRecord(error) && typeof error.message === 'string'
      ? error.message.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 300)
      : 'Asset snapshot could not be prepared';
  return deepFreeze({
    formatVersion: 1,
    code,
    severity: 'error',
    message,
    ...(isRecord(error) && typeof error.displayName === 'string'
      ? {displayName: error.displayName.slice(0, 500)}
      : {}),
    ...(isRecord(error) && typeof error.sourceId === 'string'
      ? {sourceId: error.sourceId.slice(0, 200)}
      : {}),
    ...(isRecord(error) && typeof error.path === 'string' ? {path: error.path.slice(0, 500)} : {}),
  });
}

/**
 * Serialize stable reads, candidate replacement, acknowledgement, and resource release. The injected
 * reader is the only component allowed to access platform file handles.
 */
export function createDsl4AssetSnapshotWatch(options: {
  read: (
    context: unknown,
    options: {signal: AbortSignal; revision: number},
  ) => unknown | Promise<unknown>;
  onCandidate: (candidate: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
  onDiagnostic?: (
    diagnostic: Readonly<Record<string, unknown>> | null,
  ) => unknown | Promise<unknown>;
  onStatus?: (state: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
  onError?: (error: unknown) => unknown;
  clock?: Readonly<Record<string, Function>>;
  foregroundIntervalMs?: number;
  backgroundIntervalMs?: number;
  quietWindowMs?: number;
  retryIntervalMs?: number;
  stabilityTimeoutMs?: number;
}) {
  if (!isRecord(options)) throw new TypeError('asset snapshot watch options are required');
  if (typeof options.read !== 'function' || typeof options.onCandidate !== 'function') {
    throw new TypeError('asset snapshot watch requires read and onCandidate');
  }
  if (options.onDiagnostic !== undefined && typeof options.onDiagnostic !== 'function') {
    throw new TypeError('onDiagnostic must be a function');
  }
  if (options.onStatus !== undefined && typeof options.onStatus !== 'function') {
    throw new TypeError('onStatus must be a function');
  }
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new TypeError('onError must be a function');
  }
  const clock = validateClock(options.clock ?? defaultClock);
  const foregroundIntervalMs = milliseconds(
    options.foregroundIntervalMs ?? dsl4AssetSnapshotWatchDefaults.foregroundIntervalMs,
    'foregroundIntervalMs',
    1,
  );
  const backgroundIntervalMs = milliseconds(
    options.backgroundIntervalMs ?? dsl4AssetSnapshotWatchDefaults.backgroundIntervalMs,
    'backgroundIntervalMs',
    foregroundIntervalMs,
  );
  const quietWindowMs = milliseconds(
    options.quietWindowMs ?? dsl4AssetSnapshotWatchDefaults.quietWindowMs,
    'quietWindowMs',
    0,
  );
  const retryIntervalMs = milliseconds(
    options.retryIntervalMs ?? dsl4AssetSnapshotWatchDefaults.retryIntervalMs,
    'retryIntervalMs',
    1,
  );
  const stabilityTimeoutMs = milliseconds(
    options.stabilityTimeoutMs ?? dsl4AssetSnapshotWatchDefaults.stabilityTimeoutMs,
    'stabilityTimeoutMs',
    retryIntervalMs,
  );
  const maximumAttempts = Math.ceil(stabilityTimeoutMs / retryIntervalMs) + 1;

  let started = false;
  let disposed = false;
  let hidden = false;
  let context: unknown = null;
  let generation = 0;
  let nextRevision = 1;
  let activeRevision = 0;
  let activeKey: string | null = null;
  let status: 'idle' | 'stabilizing' | 'watching' | 'candidate' | 'diagnostic' | 'disposed' =
    'idle';
  let active: {
    revision: number;
    key: string;
    value: Readonly<Record<string, unknown>>;
    release?: Function;
  } | null = null;
  let candidate: {
    revision: number;
    key: string;
    value: Readonly<Record<string, unknown>>;
    release?: Function;
  } | null = null;
  let diagnostic: Readonly<Record<string, unknown>> | null = null;
  let timer: unknown = null;
  let cycle: Promise<Readonly<Record<string, unknown>>> | null = null;
  let rerun = false;
  let controller: AbortController | null = null;

  function snapshot() {
    return deepFreeze({
      version: 1,
      status,
      started,
      disposed,
      hidden,
      generation,
      activeRevision,
      activeKey,
      candidate: candidate ? {revision: candidate.revision, key: candidate.key} : null,
      diagnostic,
      reading: cycle !== null,
    });
  }

  async function notify(observer: Function | undefined, ...values: unknown[]) {
    if (!observer) return;
    try {
      await observer(...values);
    } catch (error) {
      try {
        options.onError?.(error);
      } catch {
        // Error observers cannot change state.
      }
    }
  }

  async function render() {
    await notify(options.onStatus, snapshot());
  }

  async function setDiagnostic(value: Readonly<Record<string, unknown>> | null) {
    const changed = diagnostic?.code !== value?.code;
    diagnostic = value;
    if (changed) await notify(options.onDiagnostic, value);
  }

  async function setStatus(
    value: 'idle' | 'stabilizing' | 'watching' | 'candidate' | 'diagnostic' | 'disposed',
  ) {
    status = value;
    await render();
  }

  async function release(value: {release?: Function} | null, reason: string) {
    if (!value?.release) return;
    const operation = value.release;
    delete value.release;
    await operation(reason);
  }

  function cancelTimer() {
    if (timer === null) return;
    clock.clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    if (!started || disposed || cycle) return;
    cancelTimer();
    timer = clock.setTimeout(
      () => {
        timer = null;
        void pollNow().catch(() => {});
      },
      hidden ? backgroundIntervalMs : foregroundIntervalMs,
    );
  }

  async function stableRead(requestedGeneration: number, revision: number) {
    const begunAt = Number(clock.now());
    let attempts = 0;
    while (!disposed && requestedGeneration === generation) {
      attempts += 1;
      const readOptions = {signal: controller?.signal as AbortSignal, revision};
      const first = validateReadResult(await options.read(context, readOptions));
      await clock.sleep(quietWindowMs);
      if (disposed || requestedGeneration !== generation) {
        await release(first, 'stale-generation');
        return null;
      }
      const second = validateReadResult(await options.read(context, readOptions));
      if (first.key === second.key) {
        await release(first, 'stable-read-duplicate');
        return second;
      }
      await release(first, 'unstable-read');
      await release(second, 'unstable-read');
      const elapsed = Number(clock.now()) - begunAt;
      if (elapsed >= stabilityTimeoutMs || attempts >= maximumAttempts) {
        throw new Dsl4AssetSnapshotWatchError(
          'K4-ASSET-UNSTABLE-001',
          'Asset snapshot did not stabilize before the finite timeout',
        );
      }
      await clock.sleep(Math.min(retryIntervalMs, stabilityTimeoutMs - elapsed));
    }
    return null;
  }

  async function run(requestedGeneration: number) {
    if (disposed || requestedGeneration !== generation) return snapshot();
    const revision = nextRevision++;
    controller?.abort();
    controller = new AbortController();
    await setStatus('stabilizing');
    try {
      const read = await stableRead(requestedGeneration, revision);
      if (!read || disposed || requestedGeneration !== generation) return snapshot();
      if (read.key === activeKey || read.key === candidate?.key) {
        await release(read, read.key === activeKey ? 'unchanged' : 'duplicate-candidate');
        await setDiagnostic(null);
        await setStatus(candidate ? 'candidate' : 'watching');
        return snapshot();
      }
      await release(candidate, 'superseded');
      candidate = {
        revision,
        key: read.key,
        value: read.value,
        ...(read.release === undefined ? {} : {release: read.release}),
      };
      try {
        await options.onCandidate(
          deepFreeze({formatVersion: 1, revision, key: read.key, value: read.value}),
        );
      } catch (error) {
        await release(candidate, 'candidate-observer-failed');
        candidate = null;
        throw error;
      }
      await setDiagnostic(null);
      await setStatus('candidate');
      return snapshot();
    } catch (error) {
      if (disposed || requestedGeneration !== generation) return snapshot();
      await setDiagnostic(safeDiagnostic(error));
      await setStatus('diagnostic');
      return snapshot();
    }
  }

  function pollNow() {
    if (!started || disposed) throw new TypeError('asset snapshot watch is not active');
    cancelTimer();
    if (cycle) {
      rerun = true;
      return cycle;
    }
    const requestedGeneration = generation;
    cycle = (async () => {
      do {
        rerun = false;
        await run(requestedGeneration);
      } while (rerun && !disposed && requestedGeneration === generation);
      return snapshot();
    })();
    cycle = cycle.finally(() => {
      cycle = null;
      schedule();
    });
    return cycle;
  }

  function start(value: unknown) {
    if (started || disposed) throw new TypeError('asset snapshot watch can only start once');
    context = value;
    started = true;
    generation += 1;
    return pollNow();
  }

  async function update(value: unknown) {
    if (!started || disposed) throw new TypeError('asset snapshot watch is not active');
    context = value;
    generation += 1;
    rerun = false;
    controller?.abort();
    cancelTimer();
    await release(candidate, 'context-replaced');
    candidate = null;
    if (cycle) await cycle;
    return pollNow();
  }

  async function accept(revision: number) {
    if (!candidate || candidate.revision !== revision) {
      throw new Dsl4AssetSnapshotWatchError('K4-ASSET-STALE-001', 'Asset candidate is stale');
    }
    await release(active, 'generation-replaced');
    active = candidate;
    candidate = null;
    activeKey = active.key;
    activeRevision = active.revision;
    await setDiagnostic(null);
    await setStatus('watching');
    return snapshot();
  }

  async function discard(revision: number) {
    if (!candidate || candidate.revision !== revision) {
      throw new Dsl4AssetSnapshotWatchError('K4-ASSET-STALE-001', 'Asset candidate is stale');
    }
    await release(candidate, 'candidate-discarded');
    candidate = null;
    await setStatus(active ? 'watching' : 'idle');
    return snapshot();
  }

  async function setHidden(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError('hidden must be boolean');
    hidden = value;
    cancelTimer();
    schedule();
    await render();
    return snapshot();
  }

  async function dispose() {
    if (disposed) return snapshot();
    disposed = true;
    generation += 1;
    rerun = false;
    controller?.abort();
    controller = null;
    cancelTimer();
    if (cycle) await cycle;
    const errors: unknown[] = [];
    async function releaseOnDispose(value: {release?: Function} | null) {
      try {
        await release(value, 'watch-disposed');
      } catch (error) {
        errors.push(error);
      }
    }
    await releaseOnDispose(candidate);
    await releaseOnDispose(active);
    candidate = null;
    active = null;
    activeKey = null;
    diagnostic = null;
    status = 'disposed';
    await render();
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Asset snapshot watch resource release failed');
    }
    return snapshot();
  }

  return Object.freeze({
    start,
    update,
    pollNow,
    accept,
    discard,
    setHidden,
    dispose,
    getState: snapshot,
    async whenIdle() {
      while (cycle) await cycle;
      return snapshot();
    },
  });
}
