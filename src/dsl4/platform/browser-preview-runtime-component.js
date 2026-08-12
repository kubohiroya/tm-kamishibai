import {createDsl4EmbeddedAssetBundle} from '../asset-bundle-descriptor.js';
import {computeDsl4Sha256Integrity} from '../source-descriptor.js';
import {extractDsl4PoseArchive, isDsl4PoseArchivePath} from './pose-archive-extractor.js';

const defaultQuietWindowMs = 100;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class Dsl4BrowserPreviewRuntimeAssetError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'Dsl4BrowserPreviewRuntimeAssetError';
    this.code = code;
  }
}

/** @param {string} code @param {string} message @param {unknown} [cause] @returns {never} */
function fail(code, message, cause) {
  throw new Dsl4BrowserPreviewRuntimeAssetError(code, message, cause);
}

/** @param {unknown} value @param {string} name */
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} name */
function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} name */
function safeRelativePath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail('K4-ASSET-PATH-001', `${name} must be a non-empty relative path`);
  }
  const segments = value.split('/');
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    fail('K4-ASSET-PATH-001', `${name} must stay inside the selected project root`);
  }
  return segments;
}

/** @param {unknown} error */
function errorName(error) {
  return isRecord(error) && typeof error.name === 'string' ? error.name : '';
}

/** @param {unknown} error @param {string} label @returns {never} */
function mapReadError(error, label) {
  if (error instanceof Dsl4BrowserPreviewRuntimeAssetError) throw error;
  if (errorName(error) === 'NotFoundError') {
    fail('K4-ASSET-MISSING', `The declared preview asset is missing: ${label}`, error);
  }
  if (['NotAllowedError', 'SecurityError'].includes(errorName(error))) {
    fail('K4-ASSET-PERMISSION-001', 'Preview asset read permission was denied', error);
  }
  fail('K4-ASSET-PREPARE-001', `The preview asset could not be read: ${label}`, error);
}

/** @param {Record<string, any>} root @param {ReadonlyArray<string>} segments */
async function resolveParent(root, segments) {
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (typeof current.getDirectoryHandle !== 'function') {
      fail(
        'K4-ASSET-PROJECT-DIRECTORY-REQUIRED',
        'Local file assets require opening a project directory',
      );
    }
    current = await current.getDirectoryHandle(segment);
    if (!isRecord(current) || current.kind !== 'directory') {
      fail('K4-ASSET-PATH-001', 'Asset path does not resolve through directories');
    }
  }
  return current;
}

/** @param {unknown} handleInput @param {number} maxFileBytes @param {string} label */
async function readHandle(handleInput, maxFileBytes, label) {
  const handle = isRecord(handleInput) ? /** @type {Record<string, any>} */ (handleInput) : {};
  if (handle.kind !== 'file' || typeof handle.getFile !== 'function') {
    fail('K4-ASSET-PREPARE-001', `The preview asset is not a readable file: ${label}`);
  }
  let file;
  try {
    file = await handle.getFile();
  } catch (error) {
    mapReadError(error, label);
  }
  if (
    !isRecord(file) ||
    !Number.isSafeInteger(file.size) ||
    Number(file.size) < 0 ||
    typeof file.arrayBuffer !== 'function'
  ) {
    fail('K4-ASSET-PREPARE-001', `The preview asset file contract is invalid: ${label}`);
  }
  if (Number(file.size) > maxFileBytes) {
    fail('K4-ASSET-LIMIT-001', `The preview asset exceeds maxAssetFileBytes: ${label}`);
  }
  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (error) {
    mapReadError(error, label);
  }
  if (!(buffer instanceof ArrayBuffer)) {
    fail('K4-ASSET-PREPARE-001', `The preview asset did not return an ArrayBuffer: ${label}`);
  }
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength !== Number(file.size) || bytes.byteLength > maxFileBytes) {
    fail('K4-ASSET-UNSTABLE-001', `The preview asset changed while being read: ${label}`);
  }
  return bytes;
}

/** @param {Record<string, any>} root @param {string} filePath @param {number} maxFileBytes */
async function readSingleFile(root, filePath, maxFileBytes) {
  const segments = safeRelativePath(filePath, 'asset file');
  try {
    const parent = await resolveParent(root, segments);
    if (typeof parent.getFileHandle !== 'function') {
      fail('K4-ASSET-PREPARE-001', 'Project directory cannot resolve asset files');
    }
    const name = /** @type {string} */ (segments.at(-1));
    return [
      {
        path: name,
        bytes: await readHandle(await parent.getFileHandle(name), maxFileBytes, filePath),
      },
    ];
  } catch (error) {
    mapReadError(error, filePath);
  }
}

/** @param {Record<string, any>} root @param {string} directoryPath @param {number} maxFileBytes */
async function readPoseDirectory(root, directoryPath, maxFileBytes) {
  const segments = safeRelativePath(directoryPath, 'pose model directory');
  try {
    const parent = await resolveParent(root, segments);
    if (typeof parent.getDirectoryHandle !== 'function') {
      fail(
        'K4-ASSET-PROJECT-DIRECTORY-REQUIRED',
        'Local pose models require opening a project directory',
      );
    }
    const directory = await parent.getDirectoryHandle(/** @type {string} */ (segments.at(-1)));
    if (
      !isRecord(directory) ||
      directory.kind !== 'directory' ||
      typeof directory.entries !== 'function'
    ) {
      fail('K4-ASSET-POSE-BUNDLE-001', 'Pose model is not an enumerable directory');
    }
    /** @type {Array<[string, Record<string, any>]>} */
    const entries = [];
    for await (const entry of directory.entries()) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        entry[0].length === 0 ||
        entry[0].includes('/') ||
        entry[0].includes('\\') ||
        !isRecord(entry[1]) ||
        entry[1].kind !== 'file'
      ) {
        fail('K4-ASSET-POSE-BUNDLE-001', 'Pose model contains an unsupported entry');
      }
      entries.push([entry[0], /** @type {Record<string, any>} */ (entry[1])]);
    }
    entries.sort(([left], [right]) => left.localeCompare(right, 'en'));
    if (entries.length !== 3) {
      fail('K4-ASSET-POSE-BUNDLE-001', 'Pose model requires exactly three files');
    }
    const files = [];
    for (const [name, handle] of entries) {
      files.push({
        path: name,
        bytes: await readHandle(handle, maxFileBytes, `${directoryPath}/${name}`),
      });
    }
    return files;
  } catch (error) {
    mapReadError(error, directoryPath);
  }
}

/** @param {Record<string, any>} root @param {string} assetId @param {string} sourcePath @param {number} maxFileBytes @param {number} maxTotalBytes @param {{digest: Function}} subtleCrypto */
async function readPoseSource(
  root,
  assetId,
  sourcePath,
  maxFileBytes,
  maxTotalBytes,
  subtleCrypto,
) {
  if (!isDsl4PoseArchivePath(sourcePath)) {
    return readPoseDirectory(root, sourcePath, maxFileBytes);
  }
  const [archive] = await readSingleFile(root, sourcePath, maxFileBytes);
  const extracted = await extractDsl4PoseArchive({
    assetId,
    bytes: archive.bytes,
    maxArchiveBytes: maxFileBytes,
    maxFileBytes,
    maxTotalBytes,
    subtleCrypto,
  });
  return extracted.files.map((file) => ({path: file.path, bytes: file.bytes}));
}

/** @param {Readonly<Record<string, any>>} asset @param {string} id */
function commonManifestAsset(asset, id) {
  return {
    id,
    kind: asset.kind,
    loading: asset.loading,
    ...(asset.target === undefined ? {} : {target: asset.target}),
    ...(asset.kind === 'backdrop' || asset.kind === 'costume'
      ? {bitmapResolution: asset.bitmapResolution ?? 1}
      : {}),
  };
}

/** @param {Readonly<Record<string, any>>} storyDocument */
function hasLocalFiles(storyDocument) {
  return Object.values(storyDocument.assets ?? {}).some(
    (asset) => isRecord(asset) && typeof asset.file === 'string',
  );
}

/**
 * Capture exactly the local files declared by one validated StoryDocument.
 *
 * @param {Readonly<Record<string, any>>} storyDocument
 * @param {Record<string, any> | null} projectRoot
 * @param {{maxAssetFileBytes: number, maxAssetFiles: number, maxAssetBytes: number, subtleCrypto: {digest: Function}}} options
 */
async function captureAssetSnapshot(storyDocument, projectRoot, options) {
  const manifestAssets = [];
  const blobs = new Map();
  const adoption = [];
  let fileCount = 0;
  let totalBytes = 0;
  const assets = /** @type {Readonly<Record<string, Readonly<Record<string, any>>>>} */ (
    storyDocument.assets ?? {}
  );
  for (const id of Object.keys(assets).sort()) {
    const asset = assets[id];
    const common = commonManifestAsset(asset, id);
    if (asset.delivery === 'remote') {
      manifestAssets.push({...common, source: {type: 'remote', ...asset.source}});
      continue;
    }
    if (typeof asset.file !== 'string') {
      manifestAssets.push({...common, source: {type: 'project', name: asset.name}});
      continue;
    }
    if (!projectRoot) {
      fail(
        'K4-ASSET-PROJECT-DIRECTORY-REQUIRED',
        `Local asset ${id} requires opening a project directory`,
      );
    }
    const files =
      asset.kind === 'poseModel'
        ? await readPoseSource(
            projectRoot,
            id,
            asset.file,
            options.maxAssetFileBytes,
            options.maxAssetBytes,
            options.subtleCrypto,
          )
        : await readSingleFile(projectRoot, asset.file, options.maxAssetFileBytes);
    fileCount += files.length;
    if (fileCount > options.maxAssetFiles) {
      fail('K4-ASSET-LIMIT-001', 'Preview assets exceed maxAssetFiles');
    }
    const metadata = [];
    for (const file of files) {
      totalBytes += file.bytes.byteLength;
      if (totalBytes > options.maxAssetBytes) {
        fail('K4-ASSET-LIMIT-001', 'Preview assets exceed maxAssetBytes');
      }
      const integrity = await computeDsl4Sha256Integrity(file.bytes, options.subtleCrypto);
      metadata.push({path: file.path, size: file.bytes.byteLength, integrity});
      adoption.push([id, file.path, file.bytes.byteLength, integrity]);
      blobs.set(`${id}\0${file.path}`, new Uint8Array(file.bytes));
    }
    manifestAssets.push({
      ...common,
      source: {
        type: 'file',
        inputPath: asset.file,
        mode:
          asset.kind === 'poseModel' && isDsl4PoseArchivePath(asset.file)
            ? 'archive'
            : asset.kind === 'poseModel'
              ? 'directory'
              : 'file',
        files: metadata,
      },
    });
  }
  return {
    key: JSON.stringify(adoption),
    manifest: {formatVersion: 1, assets: manifestAssets},
    blobs,
  };
}

/**
 * Build one runtime component for a browser preview source generation. Project assets stay owned by
 * TurboWarp; declared local files are copied into the session-only bundle after a stable double read.
 *
 * @param {object} input
 * @param {Readonly<Record<string, any>>} input.baseComponent
 * @param {Readonly<Record<string, any>>} input.sourceResult
 * @param {unknown} [input.projectRoot]
 * @param {number} input.maxAssetFileBytes
 * @param {number} input.maxAssetFiles
 * @param {number} input.maxAssetBytes
 * @param {number} [input.quietWindowMs]
 * @param {(milliseconds: number) => Promise<unknown>} [input.sleep]
 * @param {{digest: Function}} [input.subtleCrypto]
 */
export async function createDsl4BrowserPreviewRuntimeComponent(input) {
  if (!isRecord(input)) throw new TypeError('browser preview runtime component input is required');
  if (!isRecord(input.baseComponent)) throw new TypeError('baseComponent must be an object');
  if (
    !isRecord(input.sourceResult) ||
    input.sourceResult.ok !== true ||
    !isRecord(input.sourceResult.storyDocument) ||
    !isRecord(input.sourceResult.sourceSnapshot)
  ) {
    throw new TypeError('sourceResult must contain one valid source generation');
  }
  const storyDocument = /** @type {Readonly<Record<string, any>>} */ (
    input.sourceResult.storyDocument
  );
  if (storyDocument.kind !== 'StoryDocument' || storyDocument.version !== '4.0') {
    throw new TypeError('sourceResult must contain a DSL 4.0 StoryDocument');
  }
  const maxAssetFileBytes = positiveInteger(input.maxAssetFileBytes, 'maxAssetFileBytes');
  const maxAssetFiles = positiveInteger(input.maxAssetFiles, 'maxAssetFiles');
  const maxAssetBytes = positiveInteger(input.maxAssetBytes, 'maxAssetBytes');
  const quietWindowMs = nonNegativeInteger(
    input.quietWindowMs ?? defaultQuietWindowMs,
    'quietWindowMs',
  );
  const sleep =
    input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  if (typeof sleep !== 'function') throw new TypeError('sleep must be a function');
  const subtleCrypto = input.subtleCrypto ?? globalThis.crypto?.subtle;
  if (!isRecord(subtleCrypto) || typeof subtleCrypto.digest !== 'function') {
    throw new TypeError('Web Crypto digest is required for preview assets');
  }
  const projectRoot =
    input.projectRoot === undefined || input.projectRoot === null
      ? null
      : isRecord(input.projectRoot) && input.projectRoot.kind === 'directory'
        ? /** @type {Record<string, any>} */ (input.projectRoot)
        : (() => {
            throw new TypeError('projectRoot must be a directory handle');
          })();
  if (projectRoot?.dsl4SourceOnly === true && hasLocalFiles(storyDocument)) {
    fail(
      'K4-ASSET-PROJECT-DIRECTORY-REQUIRED',
      'Local file assets require opening a project directory instead of one story file',
    );
  }
  const captureOptions = {
    maxAssetFileBytes,
    maxAssetFiles,
    maxAssetBytes,
    subtleCrypto: /** @type {{digest: Function}} */ (subtleCrypto),
  };
  let snapshot = await captureAssetSnapshot(storyDocument, projectRoot, captureOptions);
  if (hasLocalFiles(storyDocument)) {
    await sleep(quietWindowMs);
    const stable = await captureAssetSnapshot(storyDocument, projectRoot, captureOptions);
    if (snapshot.key !== stable.key) {
      fail('K4-ASSET-UNSTABLE-001', 'Preview assets changed during stable generation capture');
    }
    snapshot = stable;
  }
  const assetBundle = await createDsl4EmbeddedAssetBundle(
    storyDocument,
    {
      manifest: snapshot.manifest,
      getFile(assetId, filePath) {
        const bytes = snapshot.blobs.get(`${assetId}\0${filePath}`);
        if (!bytes)
          fail('K4-ASSET-MISSING', `Preview asset payload is missing: ${assetId}/${filePath}`);
        return new Uint8Array(bytes);
      },
    },
    {maxFiles: maxAssetFiles, maxTotalBytes: maxAssetBytes, subtleCrypto},
  );
  return Object.freeze({
    ...input.baseComponent,
    storyDocument,
    sourceDescriptor: input.sourceResult.sourceSnapshot,
    assetBundle,
    /** @param {string} assetId @param {string} filePath */
    getAssetFile(assetId, filePath) {
      const bytes = snapshot.blobs.get(`${assetId}\0${filePath}`);
      if (!bytes)
        fail('K4-ASSET-MISSING', `Preview asset payload is missing: ${assetId}/${filePath}`);
      return new Uint8Array(bytes);
    },
  });
}
