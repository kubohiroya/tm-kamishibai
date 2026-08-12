import {deepFreeze} from './story-document.js';

export const dsl4AssetSnapshotWatchDefaults = deepFreeze({
  foregroundIntervalMs: 500,
  backgroundIntervalMs: 5_000,
  quietWindowMs: 100,
  retryIntervalMs: 50,
  stabilityTimeoutMs: 2_000,
});

export class Dsl4AssetSnapshotWatchError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'Dsl4AssetSnapshotWatchError';
    this.code = code;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name @param {number} minimum */
function milliseconds(value, name, minimum) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

/** @param {unknown} value */
function validateClock(value) {
  if (
    !isRecord(value) ||
    typeof value.now !== 'function' ||
    typeof value.sleep !== 'function' ||
    typeof value.setTimeout !== 'function' ||
    typeof value.clearTimeout !== 'function'
  ) {
    throw new TypeError('asset snapshot watch clock is invalid');
  }
  return /** @type {Readonly<Record<string, Function>>} */ (value);
}

const defaultClock = Object.freeze({
  now: () => Date.now(),
  sleep: (/** @type {number} */ delay) =>
    new Promise((resolve) => {
      setTimeout(resolve, delay);
    }),
  setTimeout: (/** @type {Function} */ callback, /** @type {number} */ delay) =>
    setTimeout(callback, delay),
  clearTimeout: (/** @type {ReturnType<typeof setTimeout>} */ timer) => clearTimeout(timer),
});

/** @param {unknown} value */
function validateReadResult(value) {
  if (
    !isRecord(value) ||
    typeof value.key !== 'string' ||
    value.key.length === 0 ||
    !isRecord(value.value) ||
    (value.release !== undefined && typeof value.release !== 'function')
  ) {
    throw new TypeError('asset snapshot read must return key, value, and optional release');
  }
  return /** @type {{key: string, value: Readonly<Record<string, unknown>>, release?: Function}} */ (
    value
  );
}

/** @param {unknown} error */
function safeDiagnostic(error) {
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
 *
 * @param {object} options
 * @param {(context: unknown, options: {signal: AbortSignal, revision: number}) => unknown | Promise<unknown>} options.read
 * @param {(candidate: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} options.onCandidate
 * @param {(diagnostic: Readonly<Record<string, unknown>> | null) => unknown | Promise<unknown>} [options.onDiagnostic]
 * @param {(state: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.onStatus]
 * @param {(error: unknown) => unknown} [options.onError]
 * @param {Readonly<Record<string, Function>>} [options.clock]
 * @param {number} [options.foregroundIntervalMs]
 * @param {number} [options.backgroundIntervalMs]
 * @param {number} [options.quietWindowMs]
 * @param {number} [options.retryIntervalMs]
 * @param {number} [options.stabilityTimeoutMs]
 */
export function createDsl4AssetSnapshotWatch(options) {
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
  /** @type {unknown} */
  let context = null;
  let generation = 0;
  let nextRevision = 1;
  let activeRevision = 0;
  /** @type {string | null} */
  let activeKey = null;
  /** @type {'idle' | 'stabilizing' | 'watching' | 'candidate' | 'diagnostic' | 'disposed'} */
  let status = 'idle';
  /** @type {{revision: number, key: string, value: Readonly<Record<string, unknown>>, release?: Function} | null} */
  let active = null;
  /** @type {{revision: number, key: string, value: Readonly<Record<string, unknown>>, release?: Function} | null} */
  let candidate = null;
  /** @type {Readonly<Record<string, unknown>> | null} */
  let diagnostic = null;
  /** @type {unknown} */
  let timer = null;
  /** @type {Promise<Readonly<Record<string, unknown>>> | null} */
  let cycle = null;
  let rerun = false;
  /** @type {AbortController | null} */
  let controller = null;

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

  /** @param {Function | undefined} observer @param {...unknown} values */
  async function notify(observer, ...values) {
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

  /** @param {Readonly<Record<string, unknown>> | null} value */
  async function setDiagnostic(value) {
    const changed = diagnostic?.code !== value?.code;
    diagnostic = value;
    if (changed) await notify(options.onDiagnostic, value);
  }

  /** @param {typeof status} value */
  async function setStatus(value) {
    status = value;
    await render();
  }

  /** @param {{release?: Function} | null} value @param {string} reason */
  async function release(value, reason) {
    if (!value?.release) return;
    const operation = value.release;
    value.release = undefined;
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

  /** @param {number} requestedGeneration @param {number} revision */
  async function stableRead(requestedGeneration, revision) {
    const begunAt = Number(clock.now());
    let attempts = 0;
    while (!disposed && requestedGeneration === generation) {
      attempts += 1;
      const readOptions = {signal: /** @type {AbortSignal} */ (controller?.signal), revision};
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

  /** @param {number} requestedGeneration */
  async function run(requestedGeneration) {
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
      candidate = {revision, key: read.key, value: read.value, release: read.release};
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

  /** @param {unknown} value */
  function start(value) {
    if (started || disposed) throw new TypeError('asset snapshot watch can only start once');
    context = value;
    started = true;
    generation += 1;
    return pollNow();
  }

  /** @param {unknown} value */
  async function update(value) {
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

  /** @param {number} revision */
  async function accept(revision) {
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

  /** @param {number} revision */
  async function discard(revision) {
    if (!candidate || candidate.revision !== revision) {
      throw new Dsl4AssetSnapshotWatchError('K4-ASSET-STALE-001', 'Asset candidate is stale');
    }
    await release(candidate, 'candidate-discarded');
    candidate = null;
    await setStatus(active ? 'watching' : 'idle');
    return snapshot();
  }

  /** @param {boolean} value */
  async function setHidden(value) {
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
    /** @type {unknown[]} */
    const errors = [];
    /** @param {{release?: Function} | null} value */
    async function releaseOnDispose(value) {
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
