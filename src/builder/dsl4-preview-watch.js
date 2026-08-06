import {watch} from 'node:fs';
import path from 'node:path';

import {deepFreeze} from '../dsl4/story-document.js';
import {
  loadDsl4ExternalSource,
  validateDsl4ExternalSourceManifest,
} from './dsl4-external-source.js';

export const dsl4PreviewWatchDefaults = Object.freeze({
  quietWindowMs: 100,
  retryIntervalMs: 50,
  stabilityTimeoutMs: 2_000,
});

/** @param {() => void} callback @param {number} milliseconds */
function schedule(callback, milliseconds) {
  return globalThis.setTimeout(callback, milliseconds);
}

/** @param {ReturnType<typeof globalThis.setTimeout>} timer */
function cancelSchedule(timer) {
  globalThis.clearTimeout(timer);
}

/** @param {number} milliseconds */
function sleep(milliseconds) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

const defaultClock = Object.freeze({
  now: () => globalThis.performance.now(),
  setTimeout: schedule,
  clearTimeout: cancelSchedule,
  sleep,
});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name @param {number} minimum */
function finiteMilliseconds(value, name, minimum) {
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
    typeof value.setTimeout !== 'function' ||
    typeof value.clearTimeout !== 'function' ||
    typeof value.sleep !== 'function'
  ) {
    throw new TypeError('clock must provide now, setTimeout, clearTimeout, and sleep');
  }
  return /** @type {{now: Function, setTimeout: Function, clearTimeout: Function, sleep: Function}} */ (
    value
  );
}

/** @param {unknown} error */
function errorCode(error) {
  return isRecord(error) && typeof error.code === 'string' ? error.code : '';
}

/** @param {string} code */
function diagnosticMessage(code) {
  return (
    {
      'K4-PREVIEW-SOURCE-UNSTABLE':
        'DSL 4.0 source did not become stable before the preview retry limit',
      'K4-SOURCE-MISSING': 'DSL 4.0 source is missing',
      'K4-SOURCE-PATH-001': 'DSL 4.0 source path is not allowed',
      'K4-SOURCE-READ-001': 'DSL 4.0 source could not be read',
      'K4-SOURCE-FILE-001': 'DSL 4.0 source is not a regular file',
      'K4-SOURCE-SIZE-001': 'DSL 4.0 source exceeds the configured byte limit',
      'K4-SOURCE-UTF8-001': 'DSL 4.0 source is not valid UTF-8',
    }[code] ?? 'DSL 4.0 source could not be prepared for preview'
  );
}

/** @param {string} code @param {'error' | 'warning'} severity @param {string} sourceId */
function sourceDiagnostic(code, severity, sourceId) {
  return deepFreeze({
    version: 1,
    code,
    severity,
    message: diagnosticMessage(code),
    sourceId,
    range: {
      start: {line: 1, column: 1, offset: 0},
      end: {line: 1, column: 1, offset: 0},
    },
    path: '$',
    related: [],
  });
}

/** @param {string} code @param {'error' | 'warning'} severity @param {string} sourceId */
function sourceFailure(code, severity, sourceId) {
  return deepFreeze({
    ok: false,
    canonicalSource: '',
    diagnostics: [sourceDiagnostic(code, severity, sourceId)],
    sourceSnapshot: null,
  });
}

/**
 * Watch one manifest-authorized source and publish only immutable, stable frontend results.
 *
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {unknown} options.manifest
 * @param {{parse(source: string, options?: {sourceId?: string}): any}} options.sourceFrontend
 * @param {number} options.maxSourceBytes
 * @param {(result: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} options.onResult
 * @param {(error: unknown) => void} [options.onError]
 * @param {number} [options.quietWindowMs]
 * @param {number} [options.retryIntervalMs]
 * @param {number} [options.stabilityTimeoutMs]
 * @param {{digest: Function}} [options.subtleCrypto]
 * @param {(projectRoot: string, manifest: unknown, options: {maxSourceBytes: number, subtleCrypto?: {digest: Function}}) => Promise<Record<string, any>>} [options.loadSource]
 * @param {(directory: string, listener: (eventType: string, filename: string | Buffer | null) => void) => {close: Function, on: Function}} [options.watchFactory]
 * @param {{now: Function, setTimeout: Function, clearTimeout: Function, sleep: Function}} [options.clock]
 */
export function createDsl4PreviewSourceWatcher({
  projectRoot,
  manifest: inputManifest,
  sourceFrontend,
  maxSourceBytes,
  onResult,
  onError,
  quietWindowMs = dsl4PreviewWatchDefaults.quietWindowMs,
  retryIntervalMs = dsl4PreviewWatchDefaults.retryIntervalMs,
  stabilityTimeoutMs = dsl4PreviewWatchDefaults.stabilityTimeoutMs,
  subtleCrypto = globalThis.crypto?.subtle,
  loadSource = loadDsl4ExternalSource,
  watchFactory = (directory, listener) => watch(directory, {persistent: true}, listener),
  clock: inputClock = defaultClock,
}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('projectRoot must be a non-empty string');
  }
  const manifest = validateDsl4ExternalSourceManifest(inputManifest);
  if (!isRecord(sourceFrontend) || typeof sourceFrontend.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse');
  }
  if (!Number.isSafeInteger(maxSourceBytes) || Number(maxSourceBytes) < 1) {
    throw new TypeError('maxSourceBytes must be a positive safe integer');
  }
  if (typeof onResult !== 'function') throw new TypeError('onResult must be a function');
  if (onError !== undefined && typeof onError !== 'function') {
    throw new TypeError('onError must be a function');
  }
  if (typeof loadSource !== 'function') throw new TypeError('loadSource must be a function');
  if (typeof watchFactory !== 'function') throw new TypeError('watchFactory must be a function');
  const quiet = finiteMilliseconds(quietWindowMs, 'quietWindowMs', 0);
  const retry = finiteMilliseconds(retryIntervalMs, 'retryIntervalMs', 1);
  const timeout = finiteMilliseconds(stabilityTimeoutMs, 'stabilityTimeoutMs', retry);
  const maximumAttempts = Math.ceil(timeout / retry) + 1;
  const clock = validateClock(inputClock);
  const sourcePath = path.resolve(projectRoot, ...manifest.path.split('/'));
  const sourceDirectory = path.dirname(sourcePath);
  const sourceBasename = path.basename(sourcePath);

  let started = false;
  let disposed = false;
  /** @type {'idle' | 'watching' | 'waiting' | 'stabilizing' | 'failed' | 'disposed'} */
  let status = 'idle';
  let revision = 0;
  let published = 0;
  /** @type {Readonly<Record<string, unknown>> | null} */
  let lastPublication = null;
  let publicationKey = '';
  /** @type {any} */
  let quietTimer = null;
  /** @type {{close: Function, on: Function} | null} */
  let fileWatcher = null;
  let operationQueue = Promise.resolve();

  function snapshot() {
    return deepFreeze({
      version: 1,
      status,
      revision,
      published,
      lastPublication,
      started,
      disposed,
    });
  }

  /** @param {unknown} error */
  function reportInternalError(error) {
    status = disposed ? 'disposed' : 'failed';
    try {
      onError?.(error);
    } catch {
      // Error observers cannot change preview watch state.
    }
  }

  /** @param {() => unknown | Promise<unknown>} operation */
  function enqueue(operation) {
    const result = operationQueue.then(operation);
    operationQueue = result.then(
      () => undefined,
      (error) => reportInternalError(error),
    );
    return result;
  }

  /** @param {Readonly<Record<string, unknown>>} result @param {string} key */
  async function publish(result, key) {
    if (disposed || key === publicationKey) return;
    await onResult(result);
    if (disposed) return;
    publicationKey = key;
    published += 1;
    const diagnostics = /** @type {ReadonlyArray<Record<string, unknown>>} */ (
      result.diagnostics ?? []
    );
    const diagnostic = diagnostics[0];
    const sourceSnapshot = /** @type {Record<string, unknown> | null} */ (
      result.sourceSnapshot ?? null
    );
    lastPublication = deepFreeze(
      sourceSnapshot
        ? {
            kind: 'source',
            integrity: sourceSnapshot.integrity,
            ok: result.ok,
            diagnosticCount: diagnostics.length,
          }
        : {
            kind: 'diagnostic',
            code: diagnostic?.code ?? 'K4-PREVIEW-INTERNAL',
            severity: diagnostic?.severity ?? 'error',
          },
    );
  }

  /** @param {number} requestedRevision */
  async function stabilize(requestedRevision) {
    if (disposed || requestedRevision !== revision) return snapshot();
    status = 'stabilizing';
    const startedAt = Number(clock.now());
    let lastTransientCode = 'K4-PREVIEW-SOURCE-UNSTABLE';
    let attempts = 0;

    while (!disposed && requestedRevision === revision) {
      attempts += 1;
      try {
        const loaded = await loadSource(projectRoot, manifest, {
          maxSourceBytes,
          subtleCrypto,
        });
        if (disposed || requestedRevision !== revision) return snapshot();
        if (!isRecord(loaded) || !isRecord(loaded.descriptor)) {
          throw new TypeError('loadSource returned an invalid external source snapshot');
        }
        const descriptor = loaded.descriptor;
        if (
          typeof descriptor.text !== 'string' ||
          typeof descriptor.integrity !== 'string' ||
          descriptor.sourceId !== manifest.sourceId
        ) {
          throw new TypeError('loadSource returned an invalid source descriptor');
        }
        const parsed = sourceFrontend.parse(descriptor.text, {sourceId: manifest.sourceId});
        if (
          !isRecord(parsed) ||
          typeof parsed.ok !== 'boolean' ||
          !Array.isArray(parsed.diagnostics)
        ) {
          throw new TypeError('sourceFrontend returned an invalid result');
        }
        const result = deepFreeze({...parsed, sourceSnapshot: descriptor});
        await publish(result, `source:${descriptor.integrity}`);
        if (!disposed && requestedRevision === revision) status = 'watching';
        return snapshot();
      } catch (error) {
        const code = errorCode(error);
        if (code !== 'K4-SOURCE-MISSING' && code !== 'K4-PREVIEW-SOURCE-UNSTABLE') {
          if (!code.startsWith('K4-SOURCE-')) throw error;
          const result = sourceFailure(code, 'error', manifest.sourceId);
          await publish(result, `diagnostic:${code}`);
          if (!disposed && requestedRevision === revision) status = 'watching';
          return snapshot();
        }
        lastTransientCode = code;
      }

      const elapsed = Number(clock.now()) - startedAt;
      if (elapsed >= timeout || attempts >= maximumAttempts) {
        const code =
          lastTransientCode === 'K4-SOURCE-MISSING'
            ? 'K4-SOURCE-MISSING'
            : 'K4-PREVIEW-SOURCE-UNSTABLE';
        const severity = code === 'K4-SOURCE-MISSING' ? 'error' : 'warning';
        await publish(sourceFailure(code, severity, manifest.sourceId), `diagnostic:${code}`);
        if (!disposed && requestedRevision === revision) status = 'watching';
        return snapshot();
      }
      await clock.sleep(Math.min(retry, timeout - elapsed));
    }
    return snapshot();
  }

  /** @param {number} requestedRevision */
  function enqueueStabilize(requestedRevision) {
    return enqueue(() => stabilize(requestedRevision));
  }

  function notifyChange() {
    if (!started || disposed) throw new TypeError('preview source watcher is not active');
    revision += 1;
    status = 'waiting';
    if (quietTimer !== null) clock.clearTimeout(quietTimer);
    const requestedRevision = revision;
    quietTimer = clock.setTimeout(() => {
      quietTimer = null;
      void enqueueStabilize(requestedRevision);
    }, quiet);
    return snapshot();
  }

  function start() {
    if (started || disposed) throw new TypeError('preview source watcher can only start once');
    const watcher = watchFactory(sourceDirectory, (eventType, filename) => {
      if (disposed) return;
      const changedName = filename === null ? null : String(filename);
      if (changedName === null || changedName === sourceBasename) notifyChange();
    });
    if (
      !isRecord(watcher) ||
      typeof watcher.close !== 'function' ||
      typeof watcher.on !== 'function'
    ) {
      try {
        watcher?.close?.();
      } catch {
        // Invalid watcher cleanup is best-effort before start fails.
      }
      throw new TypeError('watchFactory must return close and on methods');
    }
    fileWatcher = watcher;
    fileWatcher.on('error', /** @param {unknown} error */ (error) => reportInternalError(error));
    started = true;
    status = 'watching';
    revision += 1;
    return enqueueStabilize(revision);
  }

  async function dispose() {
    if (disposed) return snapshot();
    disposed = true;
    revision += 1;
    if (quietTimer !== null) {
      clock.clearTimeout(quietTimer);
      quietTimer = null;
    }
    try {
      fileWatcher?.close();
    } catch (error) {
      reportInternalError(error);
    }
    fileWatcher = null;
    await operationQueue;
    status = 'disposed';
    return snapshot();
  }

  return Object.freeze({
    start,
    notifyChange,
    dispose,
    getState: snapshot,
    whenIdle() {
      return operationQueue.then(snapshot);
    },
  });
}
