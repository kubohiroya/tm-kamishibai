import {createAssetManagerComposition as createDefaultAssetManagerComposition} from '@kubohiroya/turbowarp-asset-manager/composition';
import {createAsyncInputComposition as createDefaultAsyncInputComposition} from '@kubohiroya/turbowarp-async-input/composition';

import {
  createDsl4EmbeddedAssetLifecycle,
  createDsl4RemoteAssetLifecycle,
} from '../embedded-asset-lifecycle.js';
import {validateDsl4CacheIdentity} from '../cache-identity.js';
import {createDsl4AssetManagerAdapter} from './asset-manager-adapter.js';
import {createDsl4PlatformAssetAdapter} from './asset-adapter-router.js';
import {createDsl4PoseActionPort} from './pose-action-port.js';
import {createDsl4PoseArchiveExtractor} from './pose-archive-extractor.js';
import {createDsl4TMPosePlatform} from './tmpose-model-adapter.js';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const posePreviewMirroringModes = new Set(['mirrored', 'unmirrored']);

/** @param {unknown} value */
function validateRuntimeComponent(value) {
  const component = isRecord(value) ? value : {};
  const storyDocument = isRecord(component.storyDocument) ? component.storyDocument : null;
  const assetBundle = isRecord(component.assetBundle) ? component.assetBundle : null;
  const manifest = isRecord(assetBundle?.manifest) ? assetBundle.manifest : null;
  if (
    storyDocument?.kind !== 'StoryDocument' ||
    storyDocument.version !== '4.0' ||
    !Array.isArray(manifest?.assets) ||
    typeof component.getAssetFile !== 'function'
  ) {
    throw new TypeError('runtimeComponent must provide a validated StoryDocument and asset bundle');
  }
  const ids = new Set();
  for (const asset of manifest.assets) {
    if (!isRecord(asset) || typeof asset.id !== 'string' || ids.has(asset.id)) {
      throw new TypeError('asset bundle manifest must contain unique asset records');
    }
    ids.add(asset.id);
  }
  return component;
}

/** @param {unknown} value */
function validateTMPoseRuntime(value) {
  if (
    !isRecord(value) ||
    typeof value.Webcam !== 'function' ||
    typeof value.loadFromFiles !== 'function'
  ) {
    throw new TypeError('tmPoseRuntime must provide Webcam and loadFromFiles');
  }
  return value;
}

/** @param {unknown} value @param {string} label @param {string[]} methods */
function validateCompositionMethods(value, label, methods) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  const missing = methods.filter((method) => typeof value[method] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(`${label} must provide ${missing.join(', ')}`);
  }
  return /** @type {Record<string, Function>} */ (value);
}

/**
 * Release compositions created before a complete session could be published.
 *
 * Async cleanup cannot be awaited by this synchronous factory, but each composition is still
 * empty at this point. Rejections are contained to avoid an unhandled cleanup failure.
 *
 * @param {unknown[]} compositions
 * @param {unknown} failure
 * @returns {never}
 */
function failCreation(compositions, failure) {
  const cleanupErrors = [];
  for (const composition of [...compositions].reverse()) {
    if (!isRecord(composition) || typeof composition.releaseAll !== 'function') continue;
    try {
      void Promise.resolve(composition.releaseAll()).catch(() => {});
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [failure, ...cleanupErrors],
      'DSL 4.0 platform asset session creation failed during cleanup',
    );
  }
  throw failure;
}

function disposedError() {
  const error = new Error('DSL 4.0 platform asset session is disposing or disposed');
  Object.defineProperty(error, 'code', {value: 'K4-PLATFORM-ASSET-SESSION-001'});
  return error;
}

/**
 * Create one app-shell-scoped asset session after the DSL 4.0 runtime component is validated.
 *
 * This module intentionally remains outside the default-off core index. The app shell creates a
 * session only from the enabled startup path and captures both compositions for later action-port
 * construction.
 *
 * @param {object} options
 * @param {unknown} options.runtimeComponent
 * @param {unknown} options.tmPoseRuntime
 * @param {(payload: Readonly<Record<string, unknown>>, context: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} options.setLoading
 * @param {(payload: Readonly<Record<string, unknown>>, context: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.loadRemoteAsset]
 * @param {unknown} [options.cacheIdentity]
 * @param {Readonly<Record<string, unknown>>} [options.verifiedRemoteCacheOptions]
 * @param {Readonly<Record<string, unknown>>} [options.poseArchiveLimits]
 * @param {{digest: Function}} [options.subtleCrypto]
 * @param {Function} [options.createFile]
 * @param {Function} [options.createAssetManagerComposition]
 * @param {Function} [options.createTMPoseComposition]
 * @param {Function} [options.createAsyncInputComposition]
 * @param {unknown} [options.keySource]
 * @param {unknown} [options.actorTouchSource]
 * @param {Function} [options.poseSchedule]
 * @param {Function} [options.poseNow]
 * @param {boolean} [options.poseFeedbackEnabled]
 * @param {(event: Readonly<Record<string, unknown>>) => unknown} [options.onPoseState]
 * @param {boolean} [options.posePreviewMirroringEnabled]
 * @param {() => Readonly<{confidence?: number, progress?: number}> | null} [options.readPoseStateBinding]
 */
export function createDsl4PlatformAssetSession(options) {
  if (!isRecord(options)) throw new TypeError('platform asset session options must be an object');
  const runtimeComponent = validateRuntimeComponent(options.runtimeComponent);
  const tmPoseRuntime = validateTMPoseRuntime(options.tmPoseRuntime);
  if (typeof options.setLoading !== 'function') {
    throw new TypeError('setLoading must be a function');
  }
  if (options.loadRemoteAsset !== undefined && typeof options.loadRemoteAsset !== 'function') {
    throw new TypeError('loadRemoteAsset must be a function');
  }
  const remoteEnabled = typeof options.loadRemoteAsset === 'function';
  const remoteLoader = remoteEnabled ? /** @type {Function} */ (options.loadRemoteAsset) : null;
  let cacheIdentity = null;
  if (remoteEnabled) {
    if (options.cacheIdentity === undefined) {
      throw new TypeError('cacheIdentity must be an object when remote loading is enabled');
    }
    cacheIdentity = validateDsl4CacheIdentity(options.cacheIdentity);
  }
  const componentAssetBundle = /** @type {Record<string, any>} */ (runtimeComponent.assetBundle);
  const remotePoseRequired = componentAssetBundle.manifest.assets.some(
    /** @param {unknown} asset */ (asset) =>
      isRecord(asset) &&
      asset.kind === 'poseModel' &&
      isRecord(asset.source) &&
      asset.source.type === 'remote',
  );
  if (
    options.verifiedRemoteCacheOptions !== undefined &&
    !isRecord(options.verifiedRemoteCacheOptions)
  ) {
    throw new TypeError('verifiedRemoteCacheOptions must be an object');
  }
  if (options.createFile !== undefined && typeof options.createFile !== 'function') {
    throw new TypeError('createFile must be a function');
  }
  const poseArchiveExtractor =
    remoteEnabled && remotePoseRequired
      ? createDsl4PoseArchiveExtractor({
          limits: options.poseArchiveLimits,
          subtleCrypto: options.subtleCrypto,
        })
      : null;
  const createAssetManager =
    options.createAssetManagerComposition ?? createDefaultAssetManagerComposition;
  if (typeof createAssetManager !== 'function') {
    throw new TypeError('createAssetManagerComposition must be a function');
  }
  if (
    options.createTMPoseComposition !== undefined &&
    typeof options.createTMPoseComposition !== 'function'
  ) {
    throw new TypeError('createTMPoseComposition must be a function');
  }
  const createAsyncInput =
    options.createAsyncInputComposition ?? createDefaultAsyncInputComposition;
  if (typeof createAsyncInput !== 'function') {
    throw new TypeError('createAsyncInputComposition must be a function');
  }
  if (options.poseSchedule !== undefined && typeof options.poseSchedule !== 'function') {
    throw new TypeError('poseSchedule must be a function');
  }
  if (options.poseNow !== undefined && typeof options.poseNow !== 'function') {
    throw new TypeError('poseNow must be a function');
  }
  const poseFeedbackEnabled = options.poseFeedbackEnabled ?? false;
  if (typeof poseFeedbackEnabled !== 'boolean') {
    throw new TypeError('poseFeedbackEnabled must be boolean');
  }
  if (poseFeedbackEnabled && typeof options.onPoseState !== 'function') {
    throw new TypeError('onPoseState must be a function when pose feedback is enabled');
  }
  const posePreviewMirroringEnabled = options.posePreviewMirroringEnabled ?? false;
  if (typeof posePreviewMirroringEnabled !== 'boolean') {
    throw new TypeError('posePreviewMirroringEnabled must be boolean');
  }
  if (
    poseFeedbackEnabled &&
    options.readPoseStateBinding !== undefined &&
    typeof options.readPoseStateBinding !== 'function'
  ) {
    throw new TypeError('readPoseStateBinding must be a function');
  }

  const created = [];
  try {
    const assetManagerCandidate = remoteEnabled
      ? createAssetManager(undefined, {
          verifiedRemoteCache: {
            ...options.verifiedRemoteCacheOptions,
            cacheIdentity,
          },
        })
      : createAssetManager();
    created.push(assetManagerCandidate);
    const assetManagerMethods = [
      'registerProjectAsset',
      'registerEmbeddedAsset',
      'releaseAsset',
      'releaseAll',
      'isRegistered',
      'getMimeType',
      'applyToStage',
      'applyToTarget',
      'playSound',
      'stopSound',
      'stopAllSounds',
      ...(remoteEnabled
        ? [
            'resolveVerifiedRemoteBinary',
            'getVerifiedRemoteCacheStats',
            'pruneVerifiedRemoteCache',
            'clearVerifiedRemoteCache',
            'listVerifiedRemoteStoryCaches',
            'pruneVerifiedRemoteStoryCaches',
            'deleteVerifiedRemoteStoryCache',
            'renewVerifiedRemoteStoryCacheLease',
            'releaseVerifiedRemoteStoryCacheLease',
          ]
        : []),
    ];
    const assetManagerComposition = validateCompositionMethods(
      assetManagerCandidate,
      'Asset Manager composition',
      assetManagerMethods,
    );
    const mediaAdapter = createDsl4AssetManagerAdapter({
      composition: assetManagerComposition,
    });

    const tmpose = createDsl4TMPosePlatform({
      runtime: tmPoseRuntime,
      ...(options.createFile === undefined ? {} : {createFile: options.createFile}),
      ...(options.createTMPoseComposition === undefined
        ? {}
        : {createComposition: options.createTMPoseComposition}),
    });
    created.push(tmpose.composition);
    const tmposeComposition = validateCompositionMethods(tmpose.composition, 'TMPose composition', [
      'registerPoseModel',
      'activatePoseModel',
      'releasePoseModel',
      'releaseAll',
      'isPoseModelRegistered',
      'getActivePoseModelName',
      'startCamera',
      'stopCamera',
      'isCameraRunning',
      'startRecognition',
      'stopRecognition',
      'isRecognizing',
      'currentPose',
      'confidence',
      'confidenceOf',
      'configureAccumulatedPose',
      'resetAccumulatedPose',
      'subscribeAccumulatedPose',
      ...(posePreviewMirroringEnabled ? ['setPreviewMirroring'] : []),
    ]);
    const asyncInputCandidate = createAsyncInput({
      poseSource: tmposeComposition,
      ...(options.keySource === undefined ? {} : {keySource: options.keySource}),
      ...(options.actorTouchSource === undefined
        ? {}
        : {actorTouchSource: options.actorTouchSource}),
    });
    created.push(asyncInputCandidate);
    const asyncInputComposition = validateCompositionMethods(
      asyncInputCandidate,
      'Async Input composition',
      ['waitForPoseCandidate', 'waitForKeyCandidate', 'waitForActorTouchCandidate', 'releaseAll'],
    );
    const poseActionPort = createDsl4PoseActionPort({
      tmposeComposition,
      asyncInputComposition,
      getPoseModelLabels: (poseModel) => tmpose.adapter.getPoseModelLabels(poseModel),
      playSound: (sound) => assetManagerComposition.playSound(sound),
      stopSound: (sound) => assetManagerComposition.stopSound(sound),
      ...(options.poseSchedule === undefined
        ? {}
        : {
            schedule:
              /** @type {(callback: () => void, delayMilliseconds: number) => () => void} */ (
                options.poseSchedule
              ),
          }),
      ...(options.poseNow === undefined
        ? {}
        : {now: /** @type {() => number} */ (options.poseNow)}),
      ...(poseFeedbackEnabled ? {onPoseState: options.onPoseState} : {}),
      ...(poseFeedbackEnabled && options.readPoseStateBinding !== undefined
        ? {readPoseStateBinding: options.readPoseStateBinding}
        : {}),
    });
    const adapter = createDsl4PlatformAssetAdapter({
      mediaAdapter,
      poseAdapter: tmpose.adapter,
    });
    /** @type {Readonly<Record<string, unknown>>[]} */
    const cacheWarnings = [];

    /**
     * @param {Readonly<Record<string, any>>} payload
     * @param {Readonly<Record<string, any>>} context
     */
    async function resolveVerifiedRemoteAsset(payload, context) {
      /**
       * @param {Readonly<Record<string, any>>} input
       * @param {Readonly<Record<string, any>>} loadContext
       */
      async function loadVerifiedRemote(input, loadContext) {
        if (!remoteLoader) throw new TypeError('Remote loader is unavailable');
        const loaded = await remoteLoader(
          Object.freeze({assetId: payload.assetId, ...input}),
          Object.freeze({...context, signal: loadContext.signal}),
        );
        if (!isRecord(loaded)) return loaded;
        return {
          bytes: loaded.bytes,
          contentType: loaded.contentType,
          ...(loaded.transferOwnership === true ? {transferOwnership: true} : {}),
        };
      }
      const result = await assetManagerComposition.resolveVerifiedRemoteBinary(
        {
          url: payload.url,
          integrity: payload.integrity,
          size: payload.size,
          contentType: payload.contentType,
        },
        {
          signal: context.signal,
          load: loadVerifiedRemote,
        },
      );
      if (Array.isArray(result.cacheWarnings)) {
        for (const warning of result.cacheWarnings) {
          if (!isRecord(warning)) continue;
          cacheWarnings.push(
            Object.freeze({
              assetId: payload.assetId,
              storyPath: `/assets/${String(payload.assetId)
                .replaceAll('~', '~0')
                .replaceAll('/', '~1')}`,
              operation: warning.operation,
              code: warning.code,
            }),
          );
        }
        if (cacheWarnings.length > 128) cacheWarnings.splice(0, cacheWarnings.length - 128);
      }
      return result;
    }
    const lifecycleOptions = {
      runtimeComponent,
      adapter,
      setLoading: options.setLoading,
      ...(remoteEnabled ? {resolveVerifiedRemoteAsset} : {}),
      ...(poseArchiveExtractor ? {extractRemotePoseArchive: poseArchiveExtractor} : {}),
    };
    const assetLifecycle = remoteEnabled
      ? createDsl4RemoteAssetLifecycle(lifecycleOptions)
      : createDsl4EmbeddedAssetLifecycle(lifecycleOptions);

    /** @type {Promise<void> | null} */
    let disposePromise = null;
    const posePreviewPort = posePreviewMirroringEnabled
      ? Object.freeze({
          /** @param {unknown} mode */
          setPosePreviewMirroring(mode) {
            if (disposePromise) throw disposedError();
            if (typeof mode !== 'string' || !posePreviewMirroringModes.has(mode)) {
              throw new TypeError('pose preview mirroring mode is invalid');
            }
            tmposeComposition.setPreviewMirroring(mode);
          },
        })
      : null;
    const verifiedRemoteCache = remoteEnabled
      ? Object.freeze({
          identity: cacheIdentity,
          getWarnings() {
            return Object.freeze([...cacheWarnings]);
          },
          takeWarnings() {
            const warnings = Object.freeze([...cacheWarnings]);
            cacheWarnings.length = 0;
            return warnings;
          },
          renewLease() {
            if (disposePromise) throw disposedError();
            return assetManagerComposition.renewVerifiedRemoteStoryCacheLease();
          },
          releaseLease() {
            if (disposePromise) throw disposedError();
            return assetManagerComposition.releaseVerifiedRemoteStoryCacheLease();
          },
          getStats() {
            if (disposePromise) throw disposedError();
            return assetManagerComposition.getVerifiedRemoteCacheStats();
          },
          prune() {
            if (disposePromise) throw disposedError();
            return assetManagerComposition.pruneVerifiedRemoteCache();
          },
          clear() {
            if (disposePromise) throw disposedError();
            return assetManagerComposition.clearVerifiedRemoteCache();
          },
          listStoryCaches() {
            if (disposePromise) throw disposedError();
            return assetManagerComposition.listVerifiedRemoteStoryCaches();
          },
          pruneStoryCaches() {
            if (disposePromise) throw disposedError();
            return assetManagerComposition.pruneVerifiedRemoteStoryCaches();
          },
          /** @param {string} databaseName */
          deleteStoryCache(databaseName) {
            if (disposePromise) throw disposedError();
            return assetManagerComposition.deleteVerifiedRemoteStoryCache(databaseName);
          },
        })
      : null;
    const lifecycle = Object.freeze({
      /** @param {Readonly<Record<string, unknown>>} payload @param {Readonly<Record<string, unknown>>} context */
      prepare(payload, context) {
        if (disposePromise) throw disposedError();
        return assetLifecycle.prepare(payload, context);
      },
      /** @param {Readonly<Record<string, unknown>>} payload @param {Readonly<Record<string, unknown>>} context */
      setLoading(payload, context) {
        if (disposePromise) throw disposedError();
        return assetLifecycle.setLoading(payload, context);
      },
      /** @param {Readonly<Record<string, unknown>>} payload */
      releaseAssets(payload) {
        if (disposePromise) return disposePromise;
        return assetLifecycle.releaseAssets(payload);
      },
      /** @param {Readonly<Record<string, unknown>>} payload */
      release(payload) {
        if (disposePromise) return disposePromise;
        return assetLifecycle.release(payload);
      },
    });

    /** @param {string} [reason] */
    function dispose(reason = 'dispose') {
      if (disposePromise) return disposePromise;
      if (typeof reason !== 'string' || reason.length === 0) {
        return Promise.reject(new TypeError('dispose reason must be a non-empty string'));
      }
      disposePromise = (async () => {
        const errors = [];
        for (const release of [
          () => poseActionPort.dispose(),
          () => assetLifecycle.release({reason}),
          () => asyncInputComposition.releaseAll(),
          () => tmposeComposition.releaseAll(),
          ...(remoteEnabled
            ? [() => assetManagerComposition.releaseVerifiedRemoteStoryCacheLease()]
            : []),
          () => assetManagerComposition.releaseAll(),
        ]) {
          try {
            await release();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'DSL 4.0 platform asset session disposal failed');
        }
      })();
      return disposePromise;
    }

    return Object.freeze({
      lifecycle,
      assetManagerComposition,
      tmposeComposition,
      asyncInputComposition,
      poseActionPort,
      posePreviewPort,
      verifiedRemoteCache,
      dispose,
    });
  } catch (error) {
    failCreation(created, error);
  }
}
