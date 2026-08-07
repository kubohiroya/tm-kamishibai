import {watch} from 'node:fs';
import path from 'node:path';

import {resolveDsl4FeatureFlags} from '../dsl4/feature-flags.js';
import {createDsl4PreviewSourceGraphGeneration} from '../dsl4/preview-source-graph-generation.js';
import {computeDsl4Sha256Integrity} from '../dsl4/source-descriptor.js';
import {deepFreeze} from '../dsl4/story-document.js';
import {
  loadDsl4ExternalSource,
  validateDsl4ExternalSourceManifest,
} from './dsl4-external-source.js';
import {loadDsl4LocalAssetSnapshot} from './dsl4-local-assets.js';
import {loadDsl4BuildSourceGraph} from './dsl4-source-graph.js';
import {resolveDsl4BuildSourceLimits} from './dsl4-source-limits.js';

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

/** @param {unknown} value @param {string} name */
function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
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
      'K4-INCLUDE-CYCLE': 'DSL 4.0 source includes contain a cycle',
      'K4-INCLUDE-LIMIT-001': 'DSL 4.0 source includes exceed a configured limit',
      'K4-INCLUDE-READ-001': 'An included DSL 4.0 source could not be read',
      'K4-DECLARATION-DUPLICATE': 'A DSL 4.0 declaration is duplicated across sources',
      'K4-ASSET-MISSING': 'A project-local asset is missing',
      'K4-ASSET-UNSTABLE-001': 'Project-local assets did not form a stable generation',
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
 * @param {unknown} [options.featureFlags]
 * @param {number} [options.maxSourceFiles]
 * @param {number} [options.maxTotalSourceBytes]
 * @param {number} [options.maxIncludeDepth]
 * @param {number} [options.maxAssetFileBytes]
 * @param {number} [options.maxAssetFiles]
 * @param {number} [options.maxTotalAssetBytes]
 * @param {(result: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} options.onResult
 * @param {(error: unknown) => void} [options.onError]
 * @param {number} [options.quietWindowMs]
 * @param {number} [options.retryIntervalMs]
 * @param {number} [options.stabilityTimeoutMs]
 * @param {{digest: Function}} [options.subtleCrypto]
 * @param {(projectRoot: string, manifest: unknown, options: {maxSourceBytes: number, subtleCrypto?: {digest: Function}}) => Promise<Record<string, any>>} [options.loadSource]
 * @param {(directory: string, listener: (eventType: string, filename: string | Buffer | null) => void, options?: {recursive?: boolean}) => {close: Function, on: Function}} [options.watchFactory]
 * @param {typeof loadDsl4BuildSourceGraph} [options.loadSourceGraph]
 * @param {typeof loadDsl4LocalAssetSnapshot} [options.loadAssets]
 * @param {{now: Function, setTimeout: Function, clearTimeout: Function, sleep: Function}} [options.clock]
 */
export function createDsl4PreviewSourceWatcher({
  projectRoot,
  manifest: inputManifest,
  sourceFrontend,
  maxSourceBytes,
  featureFlags: inputFeatureFlags = {},
  maxSourceFiles,
  maxTotalSourceBytes,
  maxIncludeDepth,
  maxAssetFileBytes,
  maxAssetFiles,
  maxTotalAssetBytes,
  onResult,
  onError,
  quietWindowMs = dsl4PreviewWatchDefaults.quietWindowMs,
  retryIntervalMs = dsl4PreviewWatchDefaults.retryIntervalMs,
  stabilityTimeoutMs = dsl4PreviewWatchDefaults.stabilityTimeoutMs,
  subtleCrypto = globalThis.crypto?.subtle,
  loadSource = loadDsl4ExternalSource,
  watchFactory = (directory, listener, options = {}) =>
    watch(directory, {persistent: true, recursive: options.recursive === true}, listener),
  loadSourceGraph = loadDsl4BuildSourceGraph,
  loadAssets = loadDsl4LocalAssetSnapshot,
  clock: inputClock = defaultClock,
}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('projectRoot must be a non-empty string');
  }
  const manifest = validateDsl4ExternalSourceManifest(inputManifest);
  if (!isRecord(sourceFrontend) || typeof sourceFrontend.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse');
  }
  const featureFlags = resolveDsl4FeatureFlags(inputFeatureFlags);
  const sourceLimits = resolveDsl4BuildSourceLimits({
    sourceIncludesEnabled: featureFlags.dsl4SourceIncludes,
    maxSourceBytes,
    maxTotalSourceBytes,
  });
  if (typeof onResult !== 'function') throw new TypeError('onResult must be a function');
  if (onError !== undefined && typeof onError !== 'function') {
    throw new TypeError('onError must be a function');
  }
  if (typeof loadSource !== 'function') throw new TypeError('loadSource must be a function');
  if (typeof watchFactory !== 'function') throw new TypeError('watchFactory must be a function');
  if (featureFlags.dsl4SourceIncludes && typeof loadSourceGraph !== 'function') {
    throw new TypeError('loadSourceGraph must be a function');
  }
  if (featureFlags.dsl4SourceIncludes && typeof loadAssets !== 'function') {
    throw new TypeError('loadAssets must be a function');
  }
  const graphLimits = featureFlags.dsl4SourceIncludes
    ? {
        maxSourceFiles: positiveSafeInteger(maxSourceFiles, 'maxSourceFiles'),
        maxSourceBytes: sourceLimits.maxSourceFileBytes,
        maxTotalSourceBytes: sourceLimits.maxSourceGraphBytes,
        maxIncludeDepth: positiveSafeInteger(maxIncludeDepth, 'maxIncludeDepth'),
      }
    : null;
  const assetLimits = featureFlags.dsl4SourceIncludes
    ? {
        maxFileBytes: positiveSafeInteger(maxAssetFileBytes, 'maxAssetFileBytes'),
        maxFiles: positiveSafeInteger(maxAssetFiles, 'maxAssetFiles'),
        maxTotalBytes: positiveSafeInteger(maxTotalAssetBytes, 'maxTotalAssetBytes'),
      }
    : null;
  if (assetLimits && assetLimits.maxFileBytes > assetLimits.maxTotalBytes) {
    throw new TypeError('maxAssetFileBytes must be less than or equal to maxTotalAssetBytes');
  }
  const quiet = finiteMilliseconds(quietWindowMs, 'quietWindowMs', 0);
  const retry = finiteMilliseconds(retryIntervalMs, 'retryIntervalMs', 1);
  const timeout = finiteMilliseconds(stabilityTimeoutMs, 'stabilityTimeoutMs', retry);
  const maximumAttempts = Math.ceil(timeout / retry) + 1;
  const clock = validateClock(inputClock);
  const sourcePath = path.resolve(projectRoot, ...manifest.path.split('/'));
  const sourceDirectory = path.dirname(sourcePath);
  const sourceBasename = path.basename(sourcePath);
  const textEncoder = new TextEncoder();

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

  async function loadIncludedGeneration() {
    if (!graphLimits || !assetLimits) {
      throw new TypeError('Source Graph preview limits are unavailable');
    }
    const entrySource = await loadSource(projectRoot, manifest, {
      maxSourceBytes: sourceLimits.maxSourceFileBytes,
      subtleCrypto,
    });
    const sourceGraph = await loadSourceGraph(projectRoot, entrySource, {
      limits: graphLimits,
    });
    const generation = /** @type {Readonly<Record<string, any>>} */ (
      await createDsl4PreviewSourceGraphGeneration(sourceGraph, {
        sourceFrontend,
        sourceId: manifest.sourceId,
        displayName: path.basename(manifest.path),
        maxComposedSourceBytes: sourceLimits.maxComposedSourceBytes,
        subtleCrypto,
      })
    );
    let assetIntegrity = 'invalid-source';
    if (generation.result.ok) {
      const assets = await loadAssets(projectRoot, generation.result.storyDocument, {
        ...assetLimits,
        subtleCrypto,
      });
      assetIntegrity = await computeDsl4Sha256Integrity(
        textEncoder.encode(JSON.stringify(assets.manifest)),
        subtleCrypto,
      );
    }
    const key = await computeDsl4Sha256Integrity(
      textEncoder.encode(
        JSON.stringify({
          formatVersion: 1,
          sourceIntegrity: generation.key,
          assetIntegrity,
        }),
      ),
      subtleCrypto,
    );
    return {key, result: generation.result};
  }

  /** @param {number} requestedRevision */
  async function loadStableIncludedGeneration(requestedRevision) {
    const first = await loadIncludedGeneration();
    await clock.sleep(quiet);
    if (disposed || requestedRevision !== revision) return null;
    const second = await loadIncludedGeneration();
    if (first.key !== second.key) {
      const error = new Error('Source Graph or local assets changed during generation capture');
      Object.defineProperty(error, 'code', {value: 'K4-PREVIEW-SOURCE-UNSTABLE'});
      throw error;
    }
    return second;
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
        if (featureFlags.dsl4SourceIncludes) {
          const generation = await loadStableIncludedGeneration(requestedRevision);
          if (!generation || disposed || requestedRevision !== revision) return snapshot();
          await publish(generation.result, `generation:${generation.key}`);
          if (!disposed && requestedRevision === revision) status = 'watching';
          return snapshot();
        }
        const loaded = await loadSource(projectRoot, manifest, {
          maxSourceBytes: sourceLimits.maxSourceFileBytes,
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
        const transient = new Set([
          'K4-SOURCE-MISSING',
          'K4-PREVIEW-SOURCE-UNSTABLE',
          'K4-ASSET-MISSING',
          'K4-ASSET-UNSTABLE-001',
        ]);
        if (!transient.has(code)) {
          if (
            !code.startsWith('K4-SOURCE-') &&
            !code.startsWith('K4-INCLUDE-') &&
            !code.startsWith('K4-DECLARATION-') &&
            !code.startsWith('K4-ASSET-')
          ) {
            throw error;
          }
          const result = sourceFailure(code, 'error', manifest.sourceId);
          await publish(result, `diagnostic:${code}`);
          if (!disposed && requestedRevision === revision) status = 'watching';
          return snapshot();
        }
        lastTransientCode = code;
      }

      const elapsed = Number(clock.now()) - startedAt;
      if (elapsed >= timeout || attempts >= maximumAttempts) {
        const code = lastTransientCode.endsWith('-MISSING')
          ? lastTransientCode
          : 'K4-PREVIEW-SOURCE-UNSTABLE';
        const severity = code.endsWith('-MISSING') ? 'error' : 'warning';
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
    const watcher = watchFactory(
      featureFlags.dsl4SourceIncludes ? path.resolve(projectRoot) : sourceDirectory,
      (eventType, filename) => {
        if (disposed) return;
        const changedName = filename === null ? null : String(filename);
        if (
          featureFlags.dsl4SourceIncludes ||
          changedName === null ||
          changedName === sourceBasename
        ) {
          notifyChange();
        }
      },
      {recursive: featureFlags.dsl4SourceIncludes},
    );
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
