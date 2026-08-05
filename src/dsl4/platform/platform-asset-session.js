import {createAssetManagerComposition as createDefaultAssetManagerComposition} from '@kubohiroya/turbowarp-asset-manager/composition';

import {createDsl4EmbeddedAssetLifecycle} from '../embedded-asset-lifecycle.js';
import {createDsl4AssetManagerAdapter} from './asset-manager-adapter.js';
import {createDsl4PlatformAssetAdapter} from './asset-adapter-router.js';
import {createDsl4TMPosePlatform} from './tmpose-model-adapter.js';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
 * @param {Function} [options.createFile]
 * @param {Function} [options.createAssetManagerComposition]
 * @param {Function} [options.createTMPoseComposition]
 */
export function createDsl4PlatformAssetSession(options) {
  if (!isRecord(options)) throw new TypeError('platform asset session options must be an object');
  const runtimeComponent = validateRuntimeComponent(options.runtimeComponent);
  const tmPoseRuntime = validateTMPoseRuntime(options.tmPoseRuntime);
  if (typeof options.setLoading !== 'function') {
    throw new TypeError('setLoading must be a function');
  }
  if (options.createFile !== undefined && typeof options.createFile !== 'function') {
    throw new TypeError('createFile must be a function');
  }
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

  const created = [];
  try {
    const assetManagerCandidate = createAssetManager();
    created.push(assetManagerCandidate);
    const assetManagerComposition = validateCompositionMethods(
      assetManagerCandidate,
      'Asset Manager composition',
      [
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
      ],
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
    ]);
    const adapter = createDsl4PlatformAssetAdapter({
      mediaAdapter,
      poseAdapter: tmpose.adapter,
    });
    const embeddedLifecycle = createDsl4EmbeddedAssetLifecycle({
      runtimeComponent,
      adapter,
      setLoading: options.setLoading,
    });

    /** @type {Promise<void> | null} */
    let disposePromise = null;
    const lifecycle = Object.freeze({
      /** @param {Readonly<Record<string, unknown>>} payload @param {Readonly<Record<string, unknown>>} context */
      prepare(payload, context) {
        if (disposePromise) throw disposedError();
        return embeddedLifecycle.prepare(payload, context);
      },
      /** @param {Readonly<Record<string, unknown>>} payload @param {Readonly<Record<string, unknown>>} context */
      setLoading(payload, context) {
        if (disposePromise) throw disposedError();
        return embeddedLifecycle.setLoading(payload, context);
      },
      /** @param {Readonly<Record<string, unknown>>} payload */
      release(payload) {
        if (disposePromise) return disposePromise;
        return embeddedLifecycle.release(payload);
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
          () => embeddedLifecycle.release({reason}),
          () => tmposeComposition.releaseAll(),
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
      dispose,
    });
  } catch (error) {
    failCreation(created, error);
  }
}
