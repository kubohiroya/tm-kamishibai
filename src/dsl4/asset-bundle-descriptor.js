import {fromByteArray, toByteArray} from 'base64-js';

import {computeDsl4Sha256Integrity} from './source-descriptor.js';
import {deepFreeze} from './story-document.js';

const bundleKeys = new Set(['files', 'formatVersion', 'integrity', 'manifest']);
const manifestKeys = new Set(['assets', 'formatVersion']);
const assetKeys = new Set(['bitmapResolution', 'id', 'kind', 'loading', 'source', 'target']);
const projectSourceKeys = new Set(['name', 'type']);
const fileSourceKeys = new Set(['files', 'inputPath', 'mode', 'type']);
const remoteSourceKeys = new Set(['contentType', 'integrity', 'size', 'type', 'url']);
const bareRemoteSourceKeys = new Set(['type', 'url']);
const fileMetadataKeys = new Set(['integrity', 'path', 'size']);
const payloadKeys = new Set(['assetId', 'data', 'encoding', 'integrity', 'path', 'size']);
const assetKinds = new Set(['backdrop', 'costume', 'image', 'poseModel', 'sound']);

export const dsl4AssetBundleStoragePaths = deepFreeze({
  bundled: 'extensionStorage.kubohiroyakamishibai4.components.kubohiroyakamishibairuntime4.assets',
  unbundled: 'extensionStorage.kubohiroyakamishibairuntime4.assets',
});

export class Dsl4AssetBundleError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'Dsl4AssetBundleError';
    this.code = code;
  }
}

/** @param {string} code @param {string} message @returns {never} */
function fail(code, message) {
  throw new Dsl4AssetBundleError(code, message);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name */
function positiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

/** @param {Record<string, unknown>} value @param {Set<string>} keys @param {string} name */
function exactKeys(value, keys, name) {
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.has(key));
  const missing = [...keys].filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    fail(
      'K4-ASSET-BUNDLE-DESCRIPTOR-001',
      `${name} keys are invalid (unknown: ${unknown.sort().join(', ') || 'none'}; missing: ${missing.sort().join(', ') || 'none'})`,
    );
  }
}

/** @param {Record<string, unknown>} value @param {Readonly<Record<string, unknown>>} storyAsset @param {string} name */
function exactAssetKeys(value, storyAsset, name) {
  const expected = new Set(assetKeys);
  if (!Object.hasOwn(value, 'target')) expected.delete('target');
  // Resolution 1 is the compatibility default for pre-metadata manifests. A high-density
  // declaration is always explicit so that a tampered bundle cannot silently fall back to 1.
  if (!Object.hasOwn(value, 'bitmapResolution') && storyAsset.bitmapResolution !== 2) {
    expected.delete('bitmapResolution');
  }
  exactKeys(value, expected, name);
}

/** @param {unknown} value @param {string} name */
function bitmapResolution(value, name) {
  if (value !== 1 && value !== 2) {
    fail('K4-ASSET-BUNDLE-DESCRIPTOR-001', `${name} must be 1 or 2`);
  }
  return /** @type {1 | 2} */ (value);
}

/** @param {Record<string, unknown>} value @param {string} name @param {boolean} allowBare */
function exactRemoteSourceKeys(value, name, allowBare) {
  const hasVerificationMetadata = ['contentType', 'integrity', 'size'].some((key) =>
    Object.hasOwn(value, key),
  );
  exactKeys(
    value,
    hasVerificationMetadata || !allowBare ? remoteSourceKeys : bareRemoteSourceKeys,
    name,
  );
}

/** @param {unknown} value @param {string} name */
function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('K4-ASSET-BUNDLE-DESCRIPTOR-001', `${name} must be a non-empty string without NUL`);
  }
  return /** @type {string} */ (value);
}

/** @param {unknown} value @param {string} name */
function safeRelativePath(value, name) {
  const filePath = nonEmptyString(value, name);
  const segments = filePath.split('/');
  if (
    filePath.startsWith('/') ||
    filePath.includes('\\') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(filePath) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    fail('K4-ASSET-BUNDLE-PATH-001', `${name} must be a canonical relative POSIX path`);
  }
  return filePath;
}

/** @param {unknown} value @returns {unknown} */
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

/** @param {unknown} value */
function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

/** @param {Uint8Array} bytes */
function encodeBase64(bytes) {
  return fromByteArray(bytes);
}

/** @param {string} value */
function decodeBase64(value) {
  let bytes;
  try {
    bytes = toByteArray(value);
  } catch {
    fail('K4-ASSET-BUNDLE-BASE64-001', 'Asset payload is not canonical base64');
  }
  if (encodeBase64(bytes) !== value) {
    fail('K4-ASSET-BUNDLE-BASE64-001', 'Asset payload is not canonical base64');
  }
  return bytes;
}

/** @param {unknown} value @param {string} name */
function sri(value, name) {
  if (typeof value !== 'string' || !/^sha256-[A-Za-z0-9+/]{43}=$/u.test(value)) {
    fail('K4-ASSET-BUNDLE-DESCRIPTOR-001', `${name} must be a SHA-256 SRI value`);
  }
  return value;
}

/** @param {Readonly<Record<string, unknown>>} storyDocument @param {unknown} inputManifest */
export function validateDsl4AssetBundleManifest(storyDocument, inputManifest) {
  if (!isRecord(inputManifest)) {
    fail('K4-ASSET-BUNDLE-DESCRIPTOR-001', 'Asset bundle manifest must be an object');
  }
  exactKeys(inputManifest, manifestKeys, 'manifest');
  if (inputManifest.formatVersion !== 1 || !Array.isArray(inputManifest.assets)) {
    fail('K4-ASSET-BUNDLE-DESCRIPTOR-001', 'Asset bundle manifest format is invalid');
  }
  const storyAssets = /** @type {Readonly<Record<string, Readonly<Record<string, unknown>>>>} */ (
    storyDocument.assets ?? {}
  );
  const expectedIds = Object.keys(storyAssets).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const seenIds = new Set();
  const assets = /** @type {Record<string, any>[]} */ (
    inputManifest.assets.map((candidate, index) => {
      if (!isRecord(candidate)) {
        fail('K4-ASSET-BUNDLE-DESCRIPTOR-001', `manifest.assets[${index}] must be an object`);
      }
      const id = nonEmptyString(candidate.id, `manifest.assets[${index}].id`);
      if (seenIds.has(id)) fail('K4-ASSET-BUNDLE-DUPLICATE-001', `Duplicate asset ID: ${id}`);
      seenIds.add(id);
      const storyAsset = storyAssets[id];
      if (!storyAsset) fail('K4-ASSET-BUNDLE-MANIFEST-001', `Unknown asset in bundle: ${id}`);
      exactAssetKeys(candidate, storyAsset, `manifest.assets[${index}]`);
      const storyResolution =
        storyAsset.kind === 'backdrop' || storyAsset.kind === 'costume'
          ? bitmapResolution(
              storyAsset.bitmapResolution ?? 1,
              `StoryDocument asset ${id}.bitmapResolution`,
            )
          : undefined;
      const candidateResolution = Object.hasOwn(candidate, 'bitmapResolution')
        ? bitmapResolution(candidate.bitmapResolution, `manifest.assets[${index}].bitmapResolution`)
        : undefined;
      if (
        !assetKinds.has(String(candidate.kind)) ||
        candidate.kind !== storyAsset.kind ||
        candidate.loading !== storyAsset.loading ||
        Object.hasOwn(candidate, 'target') !== (storyAsset.target !== undefined) ||
        candidate.target !== storyAsset.target ||
        (storyResolution !== undefined &&
          (candidateResolution === undefined
            ? storyResolution !== 1
            : candidateResolution !== storyResolution)) ||
        (storyResolution === undefined && candidateResolution !== undefined)
      ) {
        fail('K4-ASSET-BUNDLE-MANIFEST-001', `Asset metadata does not match StoryDocument: ${id}`);
      }
      if (!isRecord(candidate.source)) {
        fail('K4-ASSET-BUNDLE-DESCRIPTOR-001', `Asset ${id} source must be an object`);
      }
      if (candidate.source.type === 'project') {
        exactKeys(candidate.source, projectSourceKeys, `Asset ${id} project source`);
        if (typeof storyAsset.file === 'string' || candidate.source.name !== storyAsset.name) {
          fail('K4-ASSET-BUNDLE-MANIFEST-001', `Project asset source does not match: ${id}`);
        }
        return deepFreeze({...candidate, source: {...candidate.source}});
      }
      if (candidate.source.type === 'remote') {
        exactRemoteSourceKeys(
          candidate.source,
          `Asset ${id} remote source`,
          storyAsset.kind === 'poseModel',
        );
        const storySource = isRecord(storyAsset.source) ? storyAsset.source : {};
        if (
          storyAsset.delivery !== 'remote' ||
          candidate.source.url !== storySource.url ||
          candidate.source.integrity !== storySource.integrity ||
          candidate.source.contentType !== storySource.contentType ||
          candidate.source.size !== storySource.size
        ) {
          fail('K4-ASSET-BUNDLE-MANIFEST-001', `Remote asset source does not match: ${id}`);
        }
        return deepFreeze({...candidate, source: {...candidate.source}});
      }
      if (candidate.source.type !== 'file') {
        fail('K4-ASSET-BUNDLE-DESCRIPTOR-001', `Asset ${id} source type is invalid`);
      }
      exactKeys(candidate.source, fileSourceKeys, `Asset ${id} file source`);
      const inputPath = safeRelativePath(candidate.source.inputPath, `Asset ${id} inputPath`);
      if (
        inputPath !== storyAsset.file ||
        !['file', 'directory'].includes(String(candidate.source.mode)) ||
        (storyAsset.kind !== 'poseModel' && candidate.source.mode !== 'file') ||
        !Array.isArray(candidate.source.files) ||
        candidate.source.files.length === 0
      ) {
        fail('K4-ASSET-BUNDLE-MANIFEST-001', `File asset source does not match: ${id}`);
      }
      const seenPaths = new Set();
      const files = candidate.source.files.map((file, fileIndex) => {
        if (!isRecord(file)) {
          fail('K4-ASSET-BUNDLE-DESCRIPTOR-001', `Asset ${id} file[${fileIndex}] is invalid`);
        }
        exactKeys(file, fileMetadataKeys, `Asset ${id} file[${fileIndex}]`);
        const filePath = safeRelativePath(file.path, `Asset ${id} file path`);
        if (seenPaths.has(filePath)) {
          fail('K4-ASSET-BUNDLE-DUPLICATE-001', `Duplicate asset file: ${id}/${filePath}`);
        }
        seenPaths.add(filePath);
        if (!Number.isSafeInteger(file.size) || Number(file.size) < 0) {
          fail('K4-ASSET-BUNDLE-DESCRIPTOR-001', `Asset ${id} file size is invalid`);
        }
        return {
          path: filePath,
          size: Number(file.size),
          integrity: sri(file.integrity, 'integrity'),
        };
      });
      const sortedFiles = [...files].sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      );
      if (canonicalJson(files) !== canonicalJson(sortedFiles)) {
        fail('K4-ASSET-BUNDLE-ORDER-001', `Asset ${id} files are not in canonical order`);
      }
      return deepFreeze({...candidate, source: {...candidate.source, inputPath, files}});
    })
  );
  const actualIds = assets.map(({id}) => String(id));
  const sortedActualIds = [...actualIds].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (canonicalJson(sortedActualIds) !== canonicalJson(expectedIds)) {
    fail('K4-ASSET-BUNDLE-MANIFEST-001', 'Asset bundle must contain every StoryDocument asset');
  }
  const sortedAssets = [...assets].sort((left, right) =>
    String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0,
  );
  if (canonicalJson(assets) !== canonicalJson(sortedAssets)) {
    fail('K4-ASSET-BUNDLE-ORDER-001', 'Asset bundle manifest is not in canonical order');
  }
  return deepFreeze({formatVersion: 1, assets});
}

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {unknown} input
 * @param {object} options
 * @param {number} options.maxFiles
 * @param {number} options.maxTotalBytes
 * @param {{digest: Function}} [options.subtleCrypto]
 */
export async function validateDsl4EmbeddedAssetBundle(
  storyDocument,
  input,
  {maxFiles, maxTotalBytes, subtleCrypto = globalThis.crypto?.subtle},
) {
  if (storyDocument.kind !== 'StoryDocument' || storyDocument.version !== '4.0') {
    throw new TypeError('DSL 4.0 asset bundle requires a StoryDocument version 4.0');
  }
  const fileLimit = positiveLimit(maxFiles, 'maxFiles');
  const totalLimit = positiveLimit(maxTotalBytes, 'maxTotalBytes');
  if (!isRecord(input)) fail('K4-ASSET-BUNDLE-DESCRIPTOR-001', 'Asset bundle must be an object');
  exactKeys(input, bundleKeys, 'asset bundle');
  if (input.formatVersion !== 1 || !Array.isArray(input.files)) {
    fail('K4-ASSET-BUNDLE-DESCRIPTOR-001', 'Asset bundle format is invalid');
  }
  const manifest = validateDsl4AssetBundleManifest(storyDocument, input.manifest);
  if (input.files.length > fileLimit)
    fail('K4-ASSET-BUNDLE-LIMIT-001', 'Asset bundle exceeds maxFiles');
  const expectedFiles = new Map();
  for (const asset of /** @type {ReadonlyArray<Record<string, any>>} */ (manifest.assets)) {
    if (asset.source.type !== 'file') continue;
    for (const file of asset.source.files) expectedFiles.set(`${asset.id}\0${file.path}`, file);
  }
  const blobs = new Map();
  let totalBytes = 0;
  const files = [];
  for (const [index, candidate] of input.files.entries()) {
    if (!isRecord(candidate)) {
      fail('K4-ASSET-BUNDLE-DESCRIPTOR-001', `files[${index}] must be an object`);
    }
    exactKeys(candidate, payloadKeys, `files[${index}]`);
    const assetId = nonEmptyString(candidate.assetId, `files[${index}].assetId`);
    const filePath = safeRelativePath(candidate.path, `files[${index}].path`);
    const key = `${assetId}\0${filePath}`;
    if (blobs.has(key))
      fail('K4-ASSET-BUNDLE-DUPLICATE-001', `Duplicate payload: ${assetId}/${filePath}`);
    const expected = expectedFiles.get(key);
    if (!expected)
      fail('K4-ASSET-BUNDLE-MANIFEST-001', `Unexpected payload: ${assetId}/${filePath}`);
    if (
      candidate.encoding !== 'base64' ||
      !Number.isSafeInteger(candidate.size) ||
      Number(candidate.size) < 0 ||
      candidate.size !== expected.size ||
      candidate.integrity !== expected.integrity
    ) {
      fail('K4-ASSET-BUNDLE-DESCRIPTOR-001', `Payload metadata is invalid: ${assetId}/${filePath}`);
    }
    if (typeof candidate.data !== 'string') {
      fail('K4-ASSET-BUNDLE-DESCRIPTOR-001', 'Asset payload data must be a string');
    }
    const bytes = decodeBase64(candidate.data);
    totalBytes += bytes.length;
    if (totalBytes > totalLimit) {
      fail('K4-ASSET-BUNDLE-LIMIT-001', 'Asset bundle exceeds maxTotalBytes');
    }
    if (bytes.length !== candidate.size) {
      fail('K4-ASSET-BUNDLE-SIZE-001', `Payload size does not match: ${assetId}/${filePath}`);
    }
    const integrity = await computeDsl4Sha256Integrity(bytes, subtleCrypto);
    if (integrity !== candidate.integrity) {
      fail(
        'K4-ASSET-BUNDLE-INTEGRITY-001',
        `Payload integrity does not match: ${assetId}/${filePath}`,
      );
    }
    blobs.set(key, bytes);
    files.push({
      assetId,
      path: filePath,
      size: bytes.length,
      integrity,
      encoding: 'base64',
      data: candidate.data,
    });
  }
  if (blobs.size !== expectedFiles.size) {
    fail('K4-ASSET-BUNDLE-MANIFEST-001', 'Asset bundle is missing one or more file payloads');
  }
  const sortedFiles = [...files].sort((left, right) =>
    left.assetId === right.assetId
      ? left.path < right.path
        ? -1
        : left.path > right.path
          ? 1
          : 0
      : left.assetId < right.assetId
        ? -1
        : 1,
  );
  if (canonicalJson(files) !== canonicalJson(sortedFiles)) {
    fail('K4-ASSET-BUNDLE-ORDER-001', 'Asset bundle files are not in canonical order');
  }
  const content = {formatVersion: 1, manifest, files};
  const integrity = sri(input.integrity, 'bundle integrity');
  const expectedIntegrity = await computeDsl4Sha256Integrity(
    new TextEncoder().encode(canonicalJson(content)),
    subtleCrypto,
  );
  if (integrity !== expectedIntegrity) {
    fail('K4-ASSET-BUNDLE-INTEGRITY-001', 'Asset bundle integrity does not match its content');
  }
  const descriptor = deepFreeze({...content, integrity: expectedIntegrity});
  return Object.freeze({
    descriptor,
    /** @param {string} assetId @param {string} filePath */
    getFile(assetId, filePath) {
      const bytes = blobs.get(`${assetId}\0${filePath}`);
      if (!bytes)
        fail('K4-ASSET-BUNDLE-LOOKUP-001', `Asset bundle file not found: ${assetId}/${filePath}`);
      return new Uint8Array(bytes);
    },
  });
}

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {{manifest: unknown, getFile(assetId: string, filePath: string): Uint8Array}} snapshot
 * @param {Parameters<typeof validateDsl4EmbeddedAssetBundle>[2]} options
 */
export async function createDsl4EmbeddedAssetBundle(storyDocument, snapshot, options) {
  if (!snapshot || typeof snapshot.getFile !== 'function') {
    throw new TypeError('asset snapshot must provide manifest and getFile');
  }
  const manifest = validateDsl4AssetBundleManifest(storyDocument, snapshot.manifest);
  const files = [];
  for (const asset of /** @type {ReadonlyArray<Record<string, any>>} */ (manifest.assets)) {
    if (asset.source.type !== 'file') continue;
    for (const file of asset.source.files) {
      const bytes = new Uint8Array(snapshot.getFile(String(asset.id), String(file.path)));
      files.push({
        assetId: asset.id,
        path: file.path,
        size: bytes.length,
        integrity: file.integrity,
        encoding: 'base64',
        data: encodeBase64(bytes),
      });
    }
  }
  const content = {formatVersion: 1, manifest, files};
  const descriptor = {
    ...content,
    integrity: await computeDsl4Sha256Integrity(
      new TextEncoder().encode(canonicalJson(content)),
      options.subtleCrypto,
    ),
  };
  return (await validateDsl4EmbeddedAssetBundle(storyDocument, descriptor, options)).descriptor;
}
