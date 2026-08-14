import {
  createBundledTMPoseRuntime,
  createPoseNetProjectBundle,
  createPoseNetProjectBundleFromLoader,
  loadPoseNetProjectBundle,
  poseNetBundleManifest,
  poseNetModelDefaults,
  validatePoseNetProjectBundle,
  verifyPoseNetBundle,
} from '@kubohiroya/turbowarp-tmpose/posenet';

export const dsl4PoseNetBundleStoragePaths = Object.freeze({
  bundled: 'extensionStorage.kubohiroyakamishibai4.components.kubohiroyakamishibairuntime4.poseNet',
  unbundled: 'extensionStorage.kubohiroyakamishibairuntime4.poseNet',
});

export const createDsl4BundledTMPoseRuntime = createBundledTMPoseRuntime;
export const createDsl4PoseNetProjectBundle = createPoseNetProjectBundle;
export const createDsl4PoseNetProjectBundleFromLoader = createPoseNetProjectBundleFromLoader;
export const dsl4PoseNetBundleManifest = poseNetBundleManifest;
export const dsl4PoseNetModelDefaults = poseNetModelDefaults;
export const loadDsl4PoseNetProjectBundleData = loadPoseNetProjectBundle;
export const validateDsl4PoseNetProjectBundle = validatePoseNetProjectBundle;
export const verifyDsl4PoseNetBundle = verifyPoseNetBundle;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} code @param {string} message */
function storageError(code, message) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

/** @param {unknown} project */
function storedProjectBundles(project) {
  if (!isRecord(project)) return [];
  const extensionStorage = isRecord(project.extensionStorage) ? project.extensionStorage : {};
  const unbundled = isRecord(extensionStorage.kubohiroyakamishibairuntime4)
    ? extensionStorage.kubohiroyakamishibairuntime4
    : {};
  const bundled = isRecord(extensionStorage.kubohiroyakamishibai4)
    ? extensionStorage.kubohiroyakamishibai4
    : {};
  const components = isRecord(bundled.components) ? bundled.components : {};
  const bundledRuntime = isRecord(components.kubohiroyakamishibairuntime4)
    ? components.kubohiroyakamishibairuntime4
    : {};
  return [unbundled.poseNet, bundledRuntime.poseNet].filter((value) => value !== undefined);
}

/**
 * Locate the one explicit PoseNet model-data descriptor stored in an SB3 project.
 * TMPose owns descriptor decoding, integrity verification, and runtime fetch interception.
 *
 * @param {unknown} project
 */
export function loadDsl4PoseNetProjectBundle(project) {
  const bundles = storedProjectBundles(project);
  if (bundles.length === 0) {
    throw storageError('K4-POSENET-ASSET-002', 'PoseNet project bundle is missing');
  }
  if (bundles.length !== 1) {
    throw storageError(
      'K4-POSENET-ASSET-001',
      'PoseNet project bundle exists in both storage channels',
    );
  }
  return bundles[0];
}

/**
 * Delay both SB3 storage lookup and TMPose project-bundle decoding until pose recognition starts.
 *
 * @param {object} options
 * @param {unknown} options.runtime
 * @param {unknown} options.project
 * @param {Record<PropertyKey, unknown>} [options.globalObject]
 * @param {Pick<SubtleCrypto, 'digest'>} [options.subtleCrypto]
 */
export function createDsl4ProjectTMPoseRuntime(options) {
  if (!isRecord(options) || !isRecord(options.runtime)) {
    throw new TypeError('DSL 4.0 project TMPose runtime options are required');
  }
  const runtime = options.runtime;
  if (typeof runtime.Webcam !== 'function' || typeof runtime.loadFromFiles !== 'function') {
    throw new TypeError('DSL 4.0 project TMPose runtime must provide Webcam and loadFromFiles');
  }
  let bundledRuntime;
  const loadRuntime = () => {
    bundledRuntime ??= createBundledTMPoseRuntime({
      runtime: /** @type {any} */ (runtime),
      globalObject: /** @type {any} */ (options.globalObject),
      projectBundle: /** @type {any} */ (loadDsl4PoseNetProjectBundle(options.project)),
      subtleCrypto: options.subtleCrypto,
    });
    return bundledRuntime;
  };
  return Object.freeze({
    Webcam: runtime.Webcam,
    /** @param {unknown} model @param {unknown} weights @param {unknown} metadata */
    async loadFromFiles(model, weights, metadata) {
      return loadRuntime().loadFromFiles(model, weights, metadata);
    },
    poseNetManifest: poseNetBundleManifest,
  });
}
