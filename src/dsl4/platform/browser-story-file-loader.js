import {createDsl4EmbeddedAssetBundle} from '../asset-bundle-descriptor.js';
import {createDsl4RuntimeArtifactDescriptor} from '../runtime-artifact-descriptor.js';
import {loadDsl4RuntimeComponent} from '../runtime-artifact-loader.js';
import {
  computeDsl4Sha256Integrity,
  createDsl4EmbeddedSourceDescriptor,
} from '../source-descriptor.js';

const storyFilenamePattern = /\.k4\.ya?ml$/iu;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} value @param {string} name */
function safePath(value, name) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
  ) {
    throw new TypeError(`${name} must be a safe relative path`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TypeError(`${name} must stay inside the selected project directory`);
  }
  return segments.join('/');
}

/** @param {unknown} value @param {string} name */
function positiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

/** @param {unknown} value */
function requireFile(value) {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    !Number.isSafeInteger(value.size) ||
    Number(value.size) < 0 ||
    typeof value.arrayBuffer !== 'function'
  ) {
    throw new TypeError('selected browser entry must provide the File contract');
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {Readonly<Record<string, any>>} entry */
function entryPath(entry) {
  return safePath(
    String(entry.path ?? entry.file?.webkitRelativePath ?? entry.file?.name ?? ''),
    'file path',
  );
}

/**
 * Find exactly one DSL 4.0 YAML source among files selected or dropped by the user.
 *
 * @param {ReadonlyArray<Readonly<{path?: string, file: unknown}>>} entries
 */
export function selectDsl4BrowserStorySource(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('Select or drop a .k4.yml file');
  }
  const candidates = entries.filter((entry) => storyFilenamePattern.test(entryPath(entry)));
  if (candidates.length === 0) throw new TypeError('No .k4.yml file was selected');
  if (candidates.length > 1)
    throw new TypeError('Select a directory containing exactly one .k4.yml file');
  return candidates[0];
}

/** @param {Readonly<Record<string, any>>} handle @param {string} prefix @param {Array<{path: string, file: unknown}>} output */
async function collectHandle(handle, prefix, output) {
  const path = prefix ? `${prefix}/${handle.name}` : handle.name;
  if (handle.kind === 'file' && typeof handle.getFile === 'function') {
    output.push({path: safePath(path, 'dropped file path'), file: await handle.getFile()});
    return;
  }
  if (handle.kind !== 'directory' || typeof handle.entries !== 'function') {
    throw new TypeError('Dropped entry must be a file or enumerable directory');
  }
  /** @type {Array<[string, Record<string, any>]>} */
  const children = [];
  for await (const entry of handle.entries()) children.push(entry);
  children.sort(([left], [right]) => left.localeCompare(right, 'en'));
  for (const [, child] of children) await collectHandle(child, path, output);
}

/**
 * Collect files from a modern drag-and-drop payload without reading unrelated paths.
 *
 * @param {unknown} dataTransferInput
 */
export async function collectDsl4BrowserDroppedFiles(dataTransferInput) {
  if (!isRecord(dataTransferInput)) throw new TypeError('drop payload is required');
  const dataTransfer = /** @type {Record<string, any>} */ (dataTransferInput);
  const items = Array.from(dataTransfer.items ?? []);
  /** @type {Array<{path: string, file: unknown}>} */
  const entries = [];
  if (items.some((item) => typeof item?.getAsFileSystemHandle === 'function')) {
    for (const item of items) {
      const handle = await item.getAsFileSystemHandle?.();
      if (handle) await collectHandle(handle, '', entries);
    }
  } else {
    for (const file of Array.from(dataTransfer.files ?? [])) {
      const browserFile = requireFile(file);
      entries.push({
        path: safePath(browserFile.webkitRelativePath || browserFile.name, 'dropped file path'),
        file: browserFile,
      });
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return entries;
}

/** @param {unknown} rootInput */
export async function collectDsl4BrowserDirectoryFiles(rootInput) {
  if (!isRecord(rootInput) || rootInput.kind !== 'directory') {
    throw new TypeError('selected project root must be a directory handle');
  }
  /** @type {Array<{path: string, file: unknown}>} */
  const entries = [];
  const root = /** @type {Record<string, any>} */ (rootInput);
  /** @type {Array<[string, Record<string, any>]>} */
  const children = [];
  for await (const entry of root.entries()) children.push(entry);
  children.sort(([left], [right]) => left.localeCompare(right, 'en'));
  for (const [, child] of children) await collectHandle(child, '', entries);
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return entries;
}

/** @param {Record<string, any>} file @param {number} limit @param {string} label */
async function readFile(file, limit, label) {
  if (file.size > limit) throw new TypeError(`${label} exceeds the configured byte limit`);
  const buffer = await file.arrayBuffer();
  if (!(buffer instanceof ArrayBuffer))
    throw new TypeError(`${label} did not return an ArrayBuffer`);
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength !== file.size || bytes.byteLength > limit) {
    throw new TypeError(`${label} changed while it was being read`);
  }
  return bytes;
}

/** @param {Uint8Array} bytes */
function decodeSource(bytes) {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch (error) {
    throw new TypeError('The selected .k4.yml file is not valid UTF-8', {cause: error});
  }
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

/**
 * Build one validated in-memory runtime project from a user-selected source and its allowlisted
 * local files. Only paths declared by the parsed StoryDocument are read into the asset bundle.
 *
 * @param {object} options
 * @param {unknown} options.project
 * @param {ReadonlyArray<Readonly<{path?: string, file: unknown}>>} options.entries
 * @param {{parse(source: string, options?: {sourceId?: string}): Readonly<Record<string, any>>}} options.sourceFrontend
 * @param {number} options.maxSourceBytes
 * @param {number} options.maxAssetFileBytes
 * @param {number} options.maxAssetFiles
 * @param {number} options.maxAssetBytes
 * @param {string} [options.controlProfile]
 * @param {{digest: Function}} [options.subtleCrypto]
 */
export async function buildDsl4BrowserSelectedStoryProject(options) {
  if (!isRecord(options)) throw new TypeError('browser story build options are required');
  if (!isRecord(options.project)) throw new TypeError('project must be an object');
  if (!isRecord(options.sourceFrontend) || typeof options.sourceFrontend.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse');
  }
  const maxSourceBytes = positiveLimit(options.maxSourceBytes, 'maxSourceBytes');
  const maxAssetFileBytes = positiveLimit(options.maxAssetFileBytes, 'maxAssetFileBytes');
  const maxAssetFiles = positiveLimit(options.maxAssetFiles, 'maxAssetFiles');
  const maxAssetBytes = positiveLimit(options.maxAssetBytes, 'maxAssetBytes');
  const subtleCrypto = options.subtleCrypto ?? globalThis.crypto?.subtle;
  const inputEntries = /** @type {ReadonlyArray<Readonly<{path?: string, file: unknown}>>} */ (
    /** @type {unknown} */ (options.entries)
  );
  const sourceEntry = selectDsl4BrowserStorySource(inputEntries);
  const sourcePath = entryPath(sourceEntry);
  const sourceFile = requireFile(sourceEntry.file);
  const sourceDirectory = sourcePath.includes('/')
    ? sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1)
    : '';
  const normalizedEntries = new Map();
  for (const entry of inputEntries) {
    const path = entryPath(entry);
    if (sourceDirectory && !path.startsWith(sourceDirectory)) continue;
    const relative = sourceDirectory ? path.slice(sourceDirectory.length) : path;
    normalizedEntries.set(safePath(relative, 'project file path'), requireFile(entry.file));
  }
  const sourceText = decodeSource(await readFile(sourceFile, maxSourceBytes, sourcePath));
  const parsed = options.sourceFrontend.parse(sourceText, {sourceId: 'main'});
  if (!parsed.ok) {
    const first = parsed.diagnostics?.[0];
    const error = new TypeError(first?.message ?? 'The selected DSL 4.0 source is invalid');
    if (typeof first?.code === 'string') Object.defineProperty(error, 'code', {value: first.code});
    Object.defineProperty(error, 'diagnostics', {value: parsed.diagnostics ?? []});
    throw error;
  }
  const storyDocument = parsed.storyDocument;
  const sourceDescriptor = await createDsl4EmbeddedSourceDescriptor(sourceText, {
    sourceId: 'main',
    displayName: sourcePath.split('/').at(-1) ?? sourcePath,
    maxSourceBytes,
    subtleCrypto,
  });
  const manifestAssets = [];
  const blobs = new Map();
  let fileCount = 0;
  let totalBytes = 0;
  for (const id of Object.keys(storyDocument.assets ?? {}).sort()) {
    const asset = storyDocument.assets[id];
    const common = commonManifestAsset(asset, id);
    if (asset.delivery === 'remote') {
      manifestAssets.push({...common, source: {type: 'remote', ...asset.source}});
      continue;
    }
    if (typeof asset.file !== 'string') {
      manifestAssets.push({...common, source: {type: 'project', name: asset.name}});
      continue;
    }
    const inputPath = safePath(asset.file, `asset ${id} file`);
    const selected =
      asset.kind === 'poseModel'
        ? [...normalizedEntries]
            .filter(
              ([path]) =>
                path.startsWith(`${inputPath}/`) && !path.slice(inputPath.length + 1).includes('/'),
            )
            .map(([path, file]) => ({path: path.slice(inputPath.length + 1), file}))
        : normalizedEntries.has(inputPath)
          ? [{path: inputPath.split('/').at(-1), file: normalizedEntries.get(inputPath)}]
          : [];
    selected.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    if (selected.length === 0)
      throw new TypeError(`Selected project is missing asset ${id}: ${inputPath}`);
    if (asset.kind === 'poseModel' && selected.length !== 3) {
      throw new TypeError(`Pose model ${id} must contain exactly three files`);
    }
    fileCount += selected.length;
    if (fileCount > maxAssetFiles) throw new TypeError('Selected project exceeds maxAssetFiles');
    const files = [];
    for (const selectedFile of selected) {
      const file = requireFile(selectedFile.file);
      const bytes = await readFile(file, maxAssetFileBytes, `${id}/${selectedFile.path}`);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxAssetBytes) throw new TypeError('Selected project exceeds maxAssetBytes');
      const integrity = await computeDsl4Sha256Integrity(bytes, subtleCrypto);
      files.push({path: selectedFile.path, size: bytes.byteLength, integrity});
      blobs.set(`${id}\0${selectedFile.path}`, bytes);
    }
    manifestAssets.push({
      ...common,
      source: {
        type: 'file',
        inputPath,
        mode: asset.kind === 'poseModel' ? 'directory' : 'file',
        files,
      },
    });
  }
  const assetBundle = await createDsl4EmbeddedAssetBundle(
    storyDocument,
    {
      manifest: {formatVersion: 1, assets: manifestAssets},
      getFile(assetId, filePath) {
        const bytes = blobs.get(`${assetId}\0${filePath}`);
        if (!bytes)
          throw new TypeError(`Selected asset payload is missing: ${assetId}/${filePath}`);
        return new Uint8Array(bytes);
      },
    },
    {maxFiles: maxAssetFiles, maxTotalBytes: maxAssetBytes, subtleCrypto},
  );
  blobs.clear();
  const artifactResult = await createDsl4RuntimeArtifactDescriptor(
    storyDocument,
    sourceDescriptor,
    options.controlProfile ?? 'production',
    {maxSourceBytes, subtleCrypto},
  );
  if (!artifactResult.ok) {
    const first = artifactResult.diagnostics[0];
    const error = new TypeError(first?.message ?? 'The selected DSL 4.0 controls are invalid');
    if (typeof first?.code === 'string') Object.defineProperty(error, 'code', {value: first.code});
    throw error;
  }
  const project = /** @type {Record<string, any>} */ (structuredClone(options.project));
  if (!isRecord(project.extensionStorage)) project.extensionStorage = {};
  delete project.extensionStorage.kubohiroyakamishibairuntime4;
  if (!isRecord(project.extensionStorage.kubohiroyakamishibai4)) {
    project.extensionStorage.kubohiroyakamishibai4 = {};
  }
  const bundleStorage = project.extensionStorage.kubohiroyakamishibai4;
  if (!isRecord(bundleStorage.components)) bundleStorage.components = {};
  bundleStorage.components.kubohiroyakamishibairuntime4 = {
    source: structuredClone(sourceDescriptor),
    artifact: structuredClone(
      /** @type {Readonly<Record<string, any>>} */ (artifactResult).artifact,
    ),
    assets: structuredClone(assetBundle),
    application: {mode: 'story'},
  };
  const verified = await loadDsl4RuntimeComponent(project, options.sourceFrontend, {
    maxSourceBytes,
    maxAssetFiles,
    maxAssetBytes,
    subtleCrypto,
  });
  if (!verified.ok) {
    const first = verified.diagnostics[0];
    const error = new TypeError(first?.message ?? 'The selected story component is invalid');
    if (typeof first?.code === 'string') Object.defineProperty(error, 'code', {value: first.code});
    throw error;
  }
  return Object.freeze({project, sourcePath, storyDocument});
}
