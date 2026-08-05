import {createDsl4AssetDependencyIndex} from './asset-dependency-index.js';

/** @param {Iterable<string>} values */
function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** @param {unknown} error @param {string} fallbackCode @param {string} fallbackMessage */
function lifecycleError(error, fallbackCode, fallbackMessage) {
  const errorRecord =
    typeof error === 'object' && error !== null
      ? /** @type {Record<string, unknown>} */ (error)
      : {};
  if (typeof errorRecord.code === 'string') return error;
  const wrapped = new Error(
    error instanceof Error && error.message ? error.message : fallbackMessage,
    {
      cause: error,
    },
  );
  Object.defineProperty(wrapped, 'code', {value: fallbackCode});
  return wrapped;
}

/** @param {unknown} lifecycle */
function validateLifecycle(lifecycle) {
  const candidate =
    typeof lifecycle === 'object' && lifecycle !== null
      ? /** @type {Record<string, unknown>} */ (lifecycle)
      : {};
  if (
    typeof candidate.prepare !== 'function' ||
    typeof candidate.setLoading !== 'function' ||
    typeof candidate.release !== 'function'
  ) {
    throw new TypeError('assetLifecycle must provide prepare, setLoading, and release methods');
  }
  return /** @type {{prepare: Function, setLoading: Function, release: Function}} */ (lifecycle);
}

/**
 * @typedef {object} Preparation
 * @property {number} token
 * @property {'startup' | 'scene'} phase
 * @property {string | null} sceneId
 * @property {number} generation
 * @property {ReadonlyArray<string>} assetIds
 * @property {AbortController} abortController
 * @property {'pending' | 'ready' | 'failed'} status
 * @property {Promise<void>} promise
 * @property {unknown} error
 */

/**
 * Coordinate preparation timing without knowing how any asset kind is decoded or registered.
 *
 * @param {object} options
 * @param {Readonly<Record<string, unknown>>} options.storyDocument
 * @param {unknown} options.lifecycle
 * @param {(type: string, details: Record<string, unknown>) => void} options.onEvent
 */
export function createDsl4AssetPreloadCoordinator({storyDocument, lifecycle, onEvent}) {
  const port = validateLifecycle(lifecycle);
  if (typeof onEvent !== 'function')
    throw new TypeError('asset preload onEvent must be a function');
  const index = createDsl4AssetDependencyIndex(storyDocument);
  const startupAssetIds = sortedUnique([...index.startup, ...index.cover, ...index.actors]);
  const loading = storyDocument.loading ?? null;
  /** @type {Preparation | null} */
  let current = null;
  let nextToken = 1;
  let releasePromise = Promise.resolve();

  /** @param {Preparation} preparation */
  function context(preparation) {
    return Object.freeze({
      signal: preparation.abortController.signal,
      generation: preparation.generation,
      sceneId: preparation.sceneId,
    });
  }

  /** @param {Preparation} preparation @param {Record<string, unknown>} payload */
  function invokePrepare(preparation, payload) {
    let operation;
    try {
      operation = port.prepare(Object.freeze(payload), context(preparation));
    } catch (error) {
      operation = Promise.reject(error);
    }
    const operationPromise = Promise.resolve(operation).then(
      () => {
        preparation.status = 'ready';
      },
      (error) => {
        preparation.status = 'failed';
        preparation.error = error;
        throw error;
      },
    );
    void operationPromise.catch(() => {});
    /** @type {(reason?: unknown) => void} */
    let rejectAborted = () => {};
    const abortedPromise = new Promise((_resolve, reject) => {
      rejectAborted = reject;
    });
    const handleAbort = () => {
      const error = new Error('Asset preparation was cancelled');
      error.name = 'AbortError';
      rejectAborted(error);
    };
    preparation.abortController.signal.addEventListener('abort', handleAbort, {once: true});
    preparation.promise = Promise.race([operationPromise, abortedPromise]).finally(() => {
      preparation.abortController.signal.removeEventListener('abort', handleAbort);
    });
    void preparation.promise.catch(() => {});
  }

  /** @param {string} reason */
  function cancelCurrent(reason) {
    const preparation = current;
    if (!preparation) return;
    preparation.abortController.abort(reason);
    current = null;
  }

  /** @param {number} generation */
  async function prepareStartup(generation) {
    cancelCurrent('startup-replaced');
    /** @type {Preparation} */
    const preparation = {
      token: nextToken++,
      phase: 'startup',
      sceneId: null,
      generation,
      assetIds: startupAssetIds,
      abortController: new AbortController(),
      status: 'pending',
      promise: Promise.resolve(),
      error: null,
    };
    current = preparation;
    try {
      await releasePromise;
      if (current !== preparation || preparation.abortController.signal.aborted) {
        return Object.freeze({ok: false, cancelled: true});
      }
      onEvent('assets.startup.start', {assetIds: startupAssetIds});
      invokePrepare(preparation, {
        phase: 'startup',
        sceneId: null,
        assetIds: startupAssetIds,
      });
      await preparation.promise;
      if (current !== preparation || preparation.abortController.signal.aborted) {
        return Object.freeze({ok: false, cancelled: true});
      }
      current = null;
      onEvent('assets.startup.ready', {assetIds: startupAssetIds});
      return Object.freeze({ok: true});
    } catch (error) {
      if (current === preparation) current = null;
      if (preparation.abortController.signal.aborted) {
        return Object.freeze({ok: false, cancelled: true});
      }
      return Object.freeze({
        ok: false,
        cancelled: false,
        error: lifecycleError(error, 'K4-ASSET-STARTUP-001', 'Asset startup preparation failed'),
      });
    }
  }

  /** @param {string} sceneId @param {number} generation */
  function beginScene(sceneId, generation) {
    cancelCurrent('scene-superseded');
    const scene = index.scenes[sceneId];
    if (!scene) throw new TypeError(`Unknown asset dependency scene: ${sceneId}`);
    /** @type {Preparation} */
    const preparation = {
      token: nextToken++,
      phase: 'scene',
      sceneId,
      generation,
      assetIds: scene.lazy,
      abortController: new AbortController(),
      status: scene.lazy.length === 0 ? 'ready' : 'pending',
      promise: Promise.resolve(),
      error: null,
    };
    current = preparation;
    onEvent('assets.preload.start', {sceneId, assetIds: scene.lazy});
    if (scene.lazy.length > 0) {
      invokePrepare(preparation, {phase: 'scene', sceneId, assetIds: scene.lazy});
    }
  }

  /** @param {string} sceneId */
  async function waitForScene(sceneId) {
    const preparation = current;
    if (!preparation || preparation.phase !== 'scene' || preparation.sceneId !== sceneId) {
      return Object.freeze({ok: true});
    }
    await Promise.resolve();
    if (current !== preparation || preparation.abortController.signal.aborted) {
      return Object.freeze({ok: false, cancelled: true});
    }

    let loadingVisible = false;
    let failure = null;
    if (preparation.status === 'pending') {
      try {
        await port.setLoading(
          Object.freeze({visible: true, sceneId, loading}),
          context(preparation),
        );
        if (current !== preparation || preparation.abortController.signal.aborted) {
          return Object.freeze({ok: false, cancelled: true});
        }
        loadingVisible = true;
        onEvent('assets.loading.show', {sceneId});
      } catch (error) {
        failure = error;
      }
    }
    if (!failure) {
      try {
        await preparation.promise;
      } catch (error) {
        failure = error;
      }
    }
    if (loadingVisible) {
      try {
        await port.setLoading(
          Object.freeze({visible: false, sceneId, loading}),
          context(preparation),
        );
        if (current === preparation && !preparation.abortController.signal.aborted) {
          onEvent('assets.loading.hide', {sceneId});
        }
      } catch (error) {
        failure ??= error;
      }
    }
    if (current !== preparation || preparation.abortController.signal.aborted) {
      return Object.freeze({ok: false, cancelled: true});
    }
    current = null;
    if (failure) {
      return Object.freeze({
        ok: false,
        cancelled: false,
        error: lifecycleError(failure, 'K4-ASSET-PREPARE-001', 'Scene asset preparation failed'),
      });
    }
    onEvent('assets.scene.ready', {sceneId, assetIds: preparation.assetIds});
    return Object.freeze({ok: true});
  }

  /** @param {string} reason */
  function release(reason) {
    cancelCurrent(reason);
    releasePromise = releasePromise
      .catch(() => {})
      .then(() => port.release(Object.freeze({reason})))
      .then(() => undefined);
    void releasePromise.catch(() => {});
    return releasePromise;
  }

  return Object.freeze({prepareStartup, beginScene, waitForScene, cancel: cancelCurrent, release});
}
