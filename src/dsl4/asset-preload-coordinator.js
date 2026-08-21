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
    typeof candidate.releaseAssets !== 'function' ||
    typeof candidate.release !== 'function'
  ) {
    throw new TypeError(
      'assetLifecycle must provide prepare, setLoading, releaseAssets, and release methods',
    );
  }
  return /** @type {{prepare: Function, setLoading: Function, releaseAssets: Function, release: Function}} */ (
    lifecycle
  );
}

/**
 * @typedef {Readonly<{ok: true, prepared: boolean}> | Readonly<{ok: false, cancelled: true}> | Readonly<{ok: false, cancelled: false, error: unknown}>} Readiness
 *
 * @typedef {object} Preparation
 * @property {number} token
 * @property {'startup' | 'scene'} phase
 * @property {string | null} sceneId
 * @property {number} generation
 * @property {ReadonlyArray<string>} assetIds
 * @property {AbortController} abortController
 * @property {'pending' | 'ready' | 'failed'} status
 * @property {Promise<void>} promise
 * @property {Promise<Readiness> | null} waitPromise
 * @property {unknown} error
 */

/**
 * Coordinate preparation timing without knowing how any asset kind is decoded or registered.
 *
 * @param {object} options
 * @param {Readonly<Record<string, unknown>>} options.storyDocument
 * @param {unknown} options.lifecycle
 * @param {(type: string, details: Record<string, unknown>) => void} options.onEvent
 * @param {ReadonlyArray<string>} [options.excludedStartupAssetIds]
 * @param {ReadonlyArray<string>} [options.persistentAssetIds]
 */
export function createDsl4AssetPreloadCoordinator({
  storyDocument,
  lifecycle,
  onEvent,
  excludedStartupAssetIds = [],
  persistentAssetIds = [],
}) {
  const port = validateLifecycle(lifecycle);
  if (typeof onEvent !== 'function')
    throw new TypeError('asset preload onEvent must be a function');
  const index = createDsl4AssetDependencyIndex(storyDocument);
  if (
    !Array.isArray(excludedStartupAssetIds) ||
    excludedStartupAssetIds.some((id) => typeof id !== 'string')
  ) {
    throw new TypeError('excludedStartupAssetIds must contain strings');
  }
  if (
    !Array.isArray(persistentAssetIds) ||
    persistentAssetIds.some((id) => typeof id !== 'string')
  ) {
    throw new TypeError('persistentAssetIds must contain strings');
  }
  const excludedStartup = new Set(excludedStartupAssetIds);
  const startupAssetIds = sortedUnique([...index.startup, ...index.cover, ...index.actors]).filter(
    (assetId) => !excludedStartup.has(assetId),
  );
  const startupLoadingAssetIds = index.loading.filter((assetId) => !excludedStartup.has(assetId));
  const startupContentAssetIds = startupAssetIds.filter(
    (assetId) => !startupLoadingAssetIds.includes(assetId),
  );
  const sceneRetainedAssetIds = new Set(index.sceneRetained);
  const persistentSceneAssetIds = new Set([
    ...index.loading,
    ...index.actors,
    ...index.posePreviewControls,
    ...persistentAssetIds,
  ]);
  const loading = storyDocument.loading ?? null;
  /** @type {Preparation | null} */
  let current = null;
  let nextToken = 1;
  let releasePromise = Promise.resolve();
  let cleanupPromise = Promise.resolve();
  /** @type {unknown[]} */
  let cleanupErrors = [];
  let committedRequiredAssetIds = new Set([...index.cover, ...index.loading, ...index.actors]);

  /** @param {ReadonlyArray<string>} assetIds @param {string} reason @param {string | null} sceneId */
  function scheduleAssetRelease(assetIds, reason, sceneId) {
    const selected = sortedUnique(assetIds);
    if (selected.length === 0) return cleanupPromise;
    cleanupPromise = cleanupPromise.then(async () => {
      try {
        await port.releaseAssets(Object.freeze({assetIds: selected, reason, sceneId}));
        onEvent('assets.release', {assetIds: selected, reason, sceneId});
      } catch (error) {
        cleanupErrors.push(error);
      }
    });
    return cleanupPromise;
  }

  /** @param {string} message */
  function takeCleanupFailure(message) {
    if (cleanupErrors.length === 0) return null;
    const errors = cleanupErrors;
    cleanupErrors = [];
    return new AggregateError(errors, message);
  }

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
    if (preparation.phase === 'scene') {
      scheduleAssetRelease(
        preparation.assetIds.filter(
          (assetId) =>
            sceneRetainedAssetIds.has(assetId) && !committedRequiredAssetIds.has(assetId),
        ),
        reason,
        preparation.sceneId,
      );
    }
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
      waitPromise: null,
      error: null,
    };
    current = preparation;
    let loadingVisible = false;
    try {
      await releasePromise;
      if (current !== preparation || preparation.abortController.signal.aborted) {
        return Object.freeze({ok: false, cancelled: true});
      }
      onEvent('assets.startup.start', {assetIds: startupAssetIds});
      if (startupLoadingAssetIds.length > 0) {
        await port.setLoading(
          Object.freeze({visible: true, sceneId: null, loading: null, phase: 'startup'}),
          context(preparation),
        );
        loadingVisible = true;
        onEvent('assets.loading.show', {sceneId: null, phase: 'startup-bootstrap'});
        invokePrepare(preparation, {
          phase: 'startup',
          sceneId: null,
          assetIds: startupLoadingAssetIds,
        });
        await preparation.promise;
        await port.setLoading(
          Object.freeze({visible: false, sceneId: null, loading: null, phase: 'startup'}),
          context(preparation),
        );
        loadingVisible = false;
        onEvent('assets.loading.hide', {sceneId: null, phase: 'startup-bootstrap'});
      }
      if (startupContentAssetIds.length > 0) {
        await port.setLoading(
          Object.freeze({visible: true, sceneId: null, loading, phase: 'startup'}),
          context(preparation),
        );
        loadingVisible = true;
        onEvent('assets.loading.show', {sceneId: null, phase: 'startup'});
        invokePrepare(preparation, {
          phase: 'startup',
          sceneId: null,
          assetIds: startupContentAssetIds,
        });
        await preparation.promise;
        await port.setLoading(
          Object.freeze({visible: false, sceneId: null, loading, phase: 'startup'}),
          context(preparation),
        );
        loadingVisible = false;
        onEvent('assets.loading.hide', {sceneId: null, phase: 'startup'});
      }
      if (startupAssetIds.length === 0) {
        invokePrepare(preparation, {phase: 'startup', sceneId: null, assetIds: []});
        await preparation.promise;
      }
      if (current !== preparation || preparation.abortController.signal.aborted) {
        return Object.freeze({ok: false, cancelled: true});
      }
      current = null;
      onEvent('assets.startup.ready', {assetIds: startupAssetIds});
      return Object.freeze({ok: true, prepared: true});
    } catch (error) {
      if (loadingVisible) {
        try {
          await port.setLoading(
            Object.freeze({visible: false, sceneId: null, loading, phase: 'startup'}),
            context(preparation),
          );
          onEvent('assets.loading.hide', {sceneId: null, phase: 'startup-error'});
        } catch (hideError) {
          error = new AggregateError(
            [error, hideError],
            'Asset startup and Loading cleanup failed',
          );
        }
      }
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
      waitPromise: null,
      error: null,
    };
    current = preparation;
    onEvent('assets.preload.start', {sceneId, assetIds: scene.lazy});
    if (scene.lazy.length > 0) {
      invokePrepare(preparation, {phase: 'scene', sceneId, assetIds: scene.lazy});
    }
  }

  /** @param {string} sceneId @returns {Promise<Readiness>} */
  async function waitForScene(sceneId) {
    const preparation = current;
    if (!preparation || preparation.phase !== 'scene' || preparation.sceneId !== sceneId) {
      return Object.freeze({ok: true, prepared: false});
    }
    if (!preparation.waitPromise) {
      preparation.waitPromise = /** @type {Promise<Readiness>} */ (
        (async () => {
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
            await scheduleAssetRelease(
              preparation.assetIds.filter(
                (assetId) =>
                  sceneRetainedAssetIds.has(assetId) && !committedRequiredAssetIds.has(assetId),
              ),
              'scene-prepare-failed',
              sceneId,
            );
            const cleanupError = takeCleanupFailure(
              'Scene preparation cleanup could not release one or more assets',
            );
            if (cleanupError) {
              failure = new AggregateError(
                [failure, cleanupError],
                'Scene asset preparation and cleanup failed',
              );
            }
            return Object.freeze({
              ok: false,
              cancelled: false,
              error: lifecycleError(
                failure,
                'K4-ASSET-PREPARE-001',
                'Scene asset preparation failed',
              ),
            });
          }
          onEvent('assets.scene.ready', {sceneId, assetIds: preparation.assetIds});
          return Object.freeze({ok: true, prepared: true});
        })()
      );
    }
    return preparation.waitPromise;
  }

  /** @param {string} sceneId @param {string} reason */
  async function commitScene(sceneId, reason) {
    const scene = index.scenes[sceneId];
    if (!scene) throw new TypeError(`Unknown asset dependency scene: ${sceneId}`);
    try {
      await cleanupPromise;
      const pendingFailure = takeCleanupFailure(
        'A superseded scene could not release one or more assets',
      );
      if (pendingFailure) throw pendingFailure;
      const required = new Set([...persistentSceneAssetIds, ...scene.all]);
      const releaseAssetIds = index.sceneRetained.filter((assetId) => !required.has(assetId));
      await scheduleAssetRelease(releaseAssetIds, reason, sceneId);
      const releaseFailure = takeCleanupFailure(
        'The previous scene could not release one or more assets',
      );
      if (releaseFailure) throw releaseFailure;
      committedRequiredAssetIds = required;
    } catch (error) {
      throw lifecycleError(error, 'K4-ASSET-RELEASE-001', 'Scene-retained asset release failed');
    }
  }

  /** @param {string} reason */
  function release(reason) {
    cancelCurrent(reason);
    releasePromise = releasePromise
      .catch(() => {})
      .then(async () => {
        await cleanupPromise;
        const errors = cleanupErrors;
        cleanupErrors = [];
        try {
          await port.release(Object.freeze({reason}));
        } catch (error) {
          errors.push(error);
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'One or more asset lifecycle releases failed');
        }
      });
    void releasePromise.catch(() => {});
    return releasePromise;
  }

  return Object.freeze({
    prepareStartup,
    beginScene,
    waitForScene,
    commitScene,
    cancel: cancelCurrent,
    release,
  });
}
