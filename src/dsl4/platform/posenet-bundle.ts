import {
  createBundledTMRuntime,
  createPoseNetProjectBundle,
  createPoseNetProjectBundleFromLoader,
  loadPoseNetProjectBundle,
  poseNetBundleManifest,
  poseNetModelDefaults,
  validatePoseNetProjectBundle,
  verifyPoseNetBundle,
} from '@kubohiroya/turbowarp-tm/posenet';

export const dsl4PoseNetBundleStoragePaths = Object.freeze({
  bundled: 'extensionStorage.kubohiroyakamishibai4.components.kubohiroyakamishibairuntime4.poseNet',
  unbundled: 'extensionStorage.kubohiroyakamishibairuntime4.poseNet',
});

export const createDsl4BundledTMRuntime = createBundledTMRuntime;
export const createDsl4PoseNetProjectBundle = createPoseNetProjectBundle;
export const createDsl4PoseNetProjectBundleFromLoader = createPoseNetProjectBundleFromLoader;
export const dsl4PoseNetBundleManifest = poseNetBundleManifest;
export const dsl4PoseNetModelDefaults = poseNetModelDefaults;
export const loadDsl4PoseNetProjectBundleData = loadPoseNetProjectBundle;
export const validateDsl4PoseNetProjectBundle = validatePoseNetProjectBundle;
export const verifyDsl4PoseNetBundle = verifyPoseNetBundle;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storageError(code: string, message: string) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

function storedProjectBundles(project: unknown) {
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
 * TM owns descriptor decoding, integrity verification, and runtime fetch interception.
 */
export function loadDsl4PoseNetProjectBundle(project: unknown) {
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

/** Delay both SB3 storage lookup and TM project-bundle decoding until pose recognition starts. */
export function createDsl4ProjectTMRuntime(options: {
  runtime: unknown;
  project: unknown;
  globalObject?: Record<PropertyKey, unknown>;
  subtleCrypto?: Pick<SubtleCrypto, 'digest'> | undefined;
}) {
  if (!isRecord(options) || !isRecord(options.runtime)) {
    throw new TypeError('DSL 4.0 project TM runtime options are required');
  }
  const runtime = options.runtime;
  if (typeof runtime.Webcam !== 'function' || typeof runtime.loadFromFiles !== 'function') {
    throw new TypeError('DSL 4.0 project TM runtime must provide Webcam and loadFromFiles');
  }
  let bundledRuntime;
  const loadRuntime = () => {
    bundledRuntime ??= createBundledTMRuntime({
      runtime: runtime as any,
      globalObject: options.globalObject as any,
      projectBundle: loadDsl4PoseNetProjectBundle(options.project) as any,
      subtleCrypto: options.subtleCrypto,
    });
    return bundledRuntime;
  };
  return Object.freeze({
    Webcam: runtime.Webcam,
    async loadFromFiles(model: unknown, weights: unknown, metadata: unknown) {
      return loadRuntime().loadFromFiles(model, weights, metadata);
    },
    poseNetManifest: poseNetBundleManifest,
  });
}
