import {embeddedPoseNetFiles} from './posenet-bundle-assets.js';

export const dsl4PoseNetModelDefaults = Object.freeze({
  architecture: 'MobileNetV1',
  multiplier: 0.75,
  outputStride: 16,
  inputResolution: 257,
});

const poseNetBaseUrl =
  'https://storage.googleapis.com/tfjs-models/savedmodel/posenet/mobilenet/float/075/';

const expectedFiles = Object.freeze([
  Object.freeze({
    path: 'model-stride16.json',
    url: `${poseNetBaseUrl}model-stride16.json`,
    mediaType: 'application/json',
    sha256: 'dd63bf2d3b983e8c80020749f135164beda00a33374c8a7be230b9598f24f798',
    maxBytes: 64 * 1024,
  }),
  Object.freeze({
    path: 'group1-shard1of2.bin',
    url: `${poseNetBaseUrl}group1-shard1of2.bin`,
    mediaType: 'application/octet-stream',
    sha256: 'ce6afc62f89782d43139fab76c641b281a82dee2cd2759aa036c4b28aea16439',
    maxBytes: 4 * 1024 * 1024,
  }),
  Object.freeze({
    path: 'group1-shard2of2.bin',
    url: `${poseNetBaseUrl}group1-shard2of2.bin`,
    mediaType: 'application/octet-stream',
    sha256: '2a35b8cfb86eb50928931e03dc30c0972fdd375f148b177ee40676b81a17692d',
    maxBytes: 1024 * 1024,
  }),
]);

export const dsl4PoseNetBundleManifest = Object.freeze({
  formatVersion: 1,
  model: dsl4PoseNetModelDefaults,
  runtime: Object.freeze({
    package: '@tensorflow-models/posenet',
    version: '2.2.2',
  }),
  source: Object.freeze({
    provider: 'tensorflow',
    repository: 'https://github.com/tensorflow/tfjs-models/tree/v2.2.2/posenet',
    modelUrl: poseNetBaseUrl,
  }),
  license: Object.freeze({
    spdx: 'Apache-2.0',
    notice: 'https://www.apache.org/licenses/LICENSE-2.0',
  }),
  limits: Object.freeze({
    maxFiles: expectedFiles.length,
    maxTotalBytes: 5 * 1024 * 1024,
  }),
  files: expectedFiles,
});

/** @param {string} code @param {string} message */
function bundleError(code, message) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} label */
function requireBytes(value, label) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw bundleError('K4-POSENET-ASSET-001', `${label} must be a Uint8Array or ArrayBuffer`);
}

/** @param {unknown} value */
function requireSubtleCrypto(value) {
  if (!isRecord(value) || typeof value.digest !== 'function') {
    throw bundleError('K4-POSENET-ASSET-001', 'Web Crypto subtle.digest is required');
  }
  return /** @type {{digest: Function}} */ (value);
}

/** @param {Uint8Array} bytes @param {{digest: Function}} subtleCrypto */
async function sha256(bytes, subtleCrypto) {
  const digest = await subtleCrypto.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/** @param {unknown} manifest */
function validateManifestShape(manifest) {
  if (!isRecord(manifest) || manifest.formatVersion !== 1) {
    throw bundleError('K4-POSENET-ASSET-001', 'PoseNet bundle manifest format is invalid');
  }
  const model = manifest.model;
  if (
    !isRecord(model) ||
    model.architecture !== dsl4PoseNetModelDefaults.architecture ||
    model.multiplier !== dsl4PoseNetModelDefaults.multiplier ||
    model.outputStride !== dsl4PoseNetModelDefaults.outputStride ||
    model.inputResolution !== dsl4PoseNetModelDefaults.inputResolution
  ) {
    throw bundleError('K4-POSENET-ASSET-001', 'PoseNet model configuration is not supported');
  }
  if (
    !isRecord(manifest.runtime) ||
    manifest.runtime.package !== '@tensorflow-models/posenet' ||
    manifest.runtime.version !== '2.2.2'
  ) {
    throw bundleError('K4-POSENET-ASSET-001', 'PoseNet runtime provenance is invalid');
  }
  if (
    !isRecord(manifest.source) ||
    manifest.source.provider !== 'tensorflow' ||
    manifest.source.repository !==
      'https://github.com/tensorflow/tfjs-models/tree/v2.2.2/posenet' ||
    manifest.source.modelUrl !== poseNetBaseUrl
  ) {
    throw bundleError('K4-POSENET-ASSET-001', 'PoseNet source provenance is invalid');
  }
  if (
    !isRecord(manifest.license) ||
    manifest.license.spdx !== 'Apache-2.0' ||
    manifest.license.notice !== 'https://www.apache.org/licenses/LICENSE-2.0'
  ) {
    throw bundleError('K4-POSENET-ASSET-001', 'PoseNet license metadata is missing');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== expectedFiles.length) {
    throw bundleError('K4-POSENET-ASSET-004', 'PoseNet bundle file count is invalid');
  }
  if (
    !isRecord(manifest.limits) ||
    manifest.limits.maxFiles !== expectedFiles.length ||
    manifest.limits.maxTotalBytes !== 5 * 1024 * 1024
  ) {
    throw bundleError('K4-POSENET-ASSET-004', 'PoseNet bundle limits are invalid');
  }
  for (const expected of expectedFiles) {
    const actual = manifest.files.find((file) => isRecord(file) && file.path === expected.path);
    if (
      !isRecord(actual) ||
      actual.url !== expected.url ||
      actual.mediaType !== expected.mediaType ||
      actual.sha256 !== expected.sha256 ||
      actual.maxBytes !== expected.maxBytes
    ) {
      throw bundleError(
        'K4-POSENET-ASSET-001',
        `PoseNet file metadata is invalid: ${expected.path}`,
      );
    }
  }
}

/**
 * Verify the fixed PoseNet supply before it is made visible to a runtime.
 *
 * @param {object} [options]
 * @param {ReadonlyArray<unknown>} [options.files]
 * @param {unknown} [options.manifest]
 * @param {unknown} [options.subtleCrypto]
 */
export async function verifyDsl4PoseNetBundle(options = {}) {
  const manifest = options.manifest ?? dsl4PoseNetBundleManifest;
  validateManifestShape(manifest);
  const subtleCrypto = requireSubtleCrypto(options.subtleCrypto ?? globalThis.crypto?.subtle);
  const files = options.files ?? embeddedPoseNetFiles;
  if (!Array.isArray(files) || files.length !== expectedFiles.length) {
    throw bundleError('K4-POSENET-ASSET-004', 'PoseNet bundle must contain exactly three files');
  }
  const verifiedFiles = [];
  let totalBytes = 0;
  for (const expected of expectedFiles) {
    const candidate = files.find((file) => isRecord(file) && file.path === expected.path);
    if (!isRecord(candidate)) {
      throw bundleError('K4-POSENET-ASSET-002', `PoseNet file is missing: ${expected.path}`);
    }
    const bytes = requireBytes(candidate.bytes, `PoseNet file ${expected.path}`);
    if (bytes.byteLength < 1 || bytes.byteLength > expected.maxBytes) {
      throw bundleError('K4-POSENET-ASSET-004', `PoseNet file exceeds its limit: ${expected.path}`);
    }
    totalBytes += bytes.byteLength;
    const actualHash = await sha256(bytes, subtleCrypto);
    if (actualHash !== expected.sha256) {
      throw bundleError(
        'K4-POSENET-ASSET-003',
        `PoseNet file integrity mismatch: ${expected.path}`,
      );
    }
    verifiedFiles.push(
      Object.freeze({
        path: expected.path,
        url: expected.url,
        mediaType: expected.mediaType,
        bytes: new Uint8Array(bytes),
      }),
    );
  }
  if (totalBytes > dsl4PoseNetBundleManifest.limits.maxTotalBytes) {
    throw bundleError('K4-POSENET-ASSET-004', 'PoseNet bundle exceeds the total byte limit');
  }
  const jsonFile = verifiedFiles.find((file) => file.path === 'model-stride16.json');
  if (!jsonFile) {
    throw bundleError('K4-POSENET-ASSET-002', 'PoseNet model JSON is missing');
  }
  /** @type {any} */
  let modelJson;
  try {
    modelJson = JSON.parse(new TextDecoder().decode(jsonFile.bytes));
  } catch (error) {
    throw bundleError(
      'K4-POSENET-ASSET-001',
      `PoseNet model JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const weightsManifest =
    isRecord(modelJson) && Array.isArray(modelJson.weightsManifest)
      ? /** @type {unknown[]} */ (modelJson.weightsManifest)
      : [];
  const manifestPaths = weightsManifest.flatMap((entry) =>
    isRecord(entry) && Array.isArray(entry.paths) ? entry.paths : [],
  );
  const expectedShardPaths = expectedFiles
    .filter(({path}) => path.endsWith('.bin'))
    .map(({path}) => path);
  if (
    !Array.isArray(manifestPaths) ||
    manifestPaths.length !== expectedShardPaths.length ||
    expectedShardPaths.some((path) => !manifestPaths.includes(path))
  ) {
    throw bundleError('K4-POSENET-ASSET-001', 'PoseNet model JSON references unexpected shards');
  }
  return Object.freeze({
    manifest,
    files: Object.freeze(verifiedFiles),
  });
}

/** @param {unknown} value @param {string} label */
function validateRuntime(value, label) {
  if (
    !isRecord(value) ||
    typeof value.Webcam !== 'function' ||
    typeof value.loadFromFiles !== 'function'
  ) {
    throw bundleError('K4-POSENET-RUNTIME-001', `${label} must provide Webcam and loadFromFiles`);
  }
  return /** @type {{Webcam: Function, loadFromFiles: Function}} */ (value);
}

/** @param {unknown} input @param {unknown} baseUrl */
function requestUrl(input, baseUrl) {
  const value = typeof input === 'string' ? input : isRecord(input) ? input.url : undefined;
  if (typeof value !== 'string') return null;
  try {
    return new URL(value, typeof baseUrl === 'string' ? baseUrl : 'http://localhost/').href;
  } catch {
    return null;
  }
}

/**
 * Wrap a Teachable Machine Pose runtime so PoseNet's implicit storage.googleapis.com requests
 * are fulfilled from the verified embedded supply. Unknown requests fail closed.
 *
 * @param {object} options
 * @param {unknown} options.runtime
 * @param {object} [options.globalObject]
 * @param {unknown} [options.files]
 * @param {unknown} [options.manifest]
 * @param {unknown} [options.subtleCrypto]
 */
export function createDsl4BundledTMPoseRuntime(options) {
  if (!isRecord(options)) throw new TypeError('PoseNet runtime options are required');
  const runtime = validateRuntime(options.runtime, 'PoseNet runtime');
  const globalObject = isRecord(options.globalObject)
    ? /** @type {Record<string, any>} */ (options.globalObject)
    : /** @type {Record<string, any>} */ (globalThis);
  const responseConstructor = globalObject.Response ?? globalThis.Response;
  if (typeof responseConstructor !== 'function') {
    throw bundleError('K4-POSENET-RUNTIME-001', 'Response constructor is required');
  }
  const verification = verifyDsl4PoseNetBundle({
    files: /** @type {ReadonlyArray<unknown> | undefined} */ (options.files),
    manifest: options.manifest,
    subtleCrypto: options.subtleCrypto ?? globalObject.crypto?.subtle,
  });
  const pending = new Map();

  /** @param {unknown} model @param {unknown} weights @param {unknown} metadata */
  async function loadFromFiles(model, weights, metadata) {
    const task = async () => {
      const bundle = await verification;
      const byUrl = new Map(bundle.files.map((file) => [String(file.url), file]));
      const previousFetch = globalObject.fetch;
      if (typeof previousFetch !== 'function') {
        throw bundleError('K4-POSENET-RUNTIME-001', 'Browser fetch is required');
      }
      const baseUrl = globalObject.location?.href ?? 'http://localhost/';
      /** @param {unknown} input @param {unknown} [_init] */
      const localFetch = async (input, _init) => {
        const url = requestUrl(input, baseUrl);
        const file = url ? byUrl.get(url) : undefined;
        if (!file) {
          throw bundleError(
            'K4-POSENET-FETCH-001',
            `Unexpected PoseNet request: ${url ?? '(invalid)'}`,
          );
        }
        return new responseConstructor(file.bytes.slice().buffer, {
          status: 200,
          headers: {'content-type': file.mediaType},
        });
      };
      try {
        globalObject.fetch = localFetch;
      } catch (error) {
        throw bundleError(
          'K4-POSENET-FETCH-001',
          `PoseNet fetch interception is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        return await runtime.loadFromFiles(model, weights, metadata);
      } finally {
        if (globalObject.fetch === localFetch) {
          try {
            globalObject.fetch = previousFetch;
          } catch {
            // The host's global object should be writable in a browser; leave the runtime error intact.
          }
        }
      }
    };
    const previous = pending.get('load') ?? Promise.resolve();
    const current = previous.then(task, task);
    pending.set(
      'load',
      current.catch(() => {}),
    );
    return current;
  }

  return Object.freeze({
    Webcam: runtime.Webcam,
    loadFromFiles,
    poseNetManifest: dsl4PoseNetBundleManifest,
  });
}
