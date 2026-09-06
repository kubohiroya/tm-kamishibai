import {createDsl4EmbeddedAssetBundle} from '../asset-bundle-descriptor.js';
import {computeDsl4Sha256Integrity} from '../source-descriptor.js';
import type {Dsl4SubtleCrypto} from '../subtle-crypto.js';
import {extractDsl4PoseArchive, isDsl4PoseArchivePath} from './pose-archive-extractor.js';

const defaultQuietWindowMs = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Dsl4BrowserPreviewFile {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface Dsl4BrowserPreviewFileHandle {
  readonly kind: 'file';
  getFile(): Promise<Dsl4BrowserPreviewFile>;
}

interface Dsl4BrowserPreviewDirectoryHandle {
  readonly kind: 'directory';
  readonly dsl4SourceOnly?: unknown;
  getDirectoryHandle?(name: string): Promise<Dsl4BrowserPreviewDirectoryHandle>;
  getFileHandle?(name: string): Promise<Dsl4BrowserPreviewFileHandle>;
  entries?(): AsyncIterable<
    [string, Dsl4BrowserPreviewFileHandle | Dsl4BrowserPreviewDirectoryHandle]
  >;
}

interface Dsl4BrowserPreviewAsset {
  readonly kind?: unknown;
  readonly loading?: unknown;
  readonly target?: unknown;
  readonly bitmapResolution?: unknown;
  readonly delivery?: unknown;
  readonly source?: unknown;
  readonly file?: unknown;
  readonly name?: unknown;
}

interface Dsl4BrowserPreviewStoryDocument {
  readonly kind?: unknown;
  readonly version?: unknown;
  readonly assets?: Readonly<Record<string, Dsl4BrowserPreviewAsset>>;
}

interface Dsl4BrowserPreviewSourceSnapshot {
  readonly integrity?: unknown;
  readonly displayName?: unknown;
}

interface Dsl4BrowserPreviewSourceResult {
  readonly ok?: unknown;
  readonly storyDocument?: Dsl4BrowserPreviewStoryDocument;
  readonly sourceSnapshot?: Dsl4BrowserPreviewSourceSnapshot;
}

interface Dsl4BrowserPreviewRuntimeComponent {
  readonly [key: string]: unknown;
}

interface Dsl4BrowserPreviewLocalFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export class Dsl4BrowserPreviewRuntimeAssetError extends Error {
  code: string;
  displayName: string | undefined;
  path: string | undefined;

  constructor(
    code: string,
    message: string,
    cause?: unknown,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'Dsl4BrowserPreviewRuntimeAssetError';
    this.displayName = undefined;
    this.path = undefined;
    this.code = code;
    if (typeof details.displayName === 'string') this.displayName = details.displayName;
    if (typeof details.path === 'string') this.path = details.path;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new Dsl4BrowserPreviewRuntimeAssetError(code, message, cause);
}

function positiveInteger(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return Number(value);
}

function safeRelativePath(value: unknown, name: string) {
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

function errorName(error: unknown) {
  return isRecord(error) && typeof error.name === 'string' ? error.name : '';
}

function mapReadError(error: unknown, label: string): never {
  if (error instanceof Dsl4BrowserPreviewRuntimeAssetError) throw error;
  if (errorName(error) === 'NotFoundError') {
    fail('K4-ASSET-MISSING', `The declared preview asset is missing: ${label}`, error);
  }
  if (['NotAllowedError', 'SecurityError'].includes(errorName(error))) {
    fail('K4-ASSET-PERMISSION-001', 'Preview asset read permission was denied', error);
  }
  fail('K4-ASSET-PREPARE-001', `The preview asset could not be read: ${label}`, error);
}

async function resolveParent(
  root: Dsl4BrowserPreviewDirectoryHandle,
  segments: ReadonlyArray<string>,
) {
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

async function readHandle(handleInput: unknown, maxFileBytes: number, label: string) {
  if (
    !isRecord(handleInput) ||
    handleInput.kind !== 'file' ||
    typeof handleInput.getFile !== 'function'
  ) {
    fail('K4-ASSET-PREPARE-001', `The preview asset is not a readable file: ${label}`);
  }
  const handle = handleInput as unknown as Dsl4BrowserPreviewFileHandle;
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

async function readSingleFile(
  root: Dsl4BrowserPreviewDirectoryHandle,
  filePath: string,
  maxFileBytes: number,
): Promise<Dsl4BrowserPreviewLocalFile[]> {
  const segments = safeRelativePath(filePath, 'asset file');
  try {
    const parent = await resolveParent(root, segments);
    if (typeof parent.getFileHandle !== 'function') {
      fail('K4-ASSET-PREPARE-001', 'Project directory cannot resolve asset files');
    }
    const name = segments.at(-1) as string;
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

async function readPoseDirectory(
  root: Dsl4BrowserPreviewDirectoryHandle,
  directoryPath: string,
  maxFileBytes: number,
): Promise<Dsl4BrowserPreviewLocalFile[]> {
  const segments = safeRelativePath(directoryPath, 'pose model directory');
  try {
    const parent = await resolveParent(root, segments);
    if (typeof parent.getDirectoryHandle !== 'function') {
      fail(
        'K4-ASSET-PROJECT-DIRECTORY-REQUIRED',
        'Local pose models require opening a project directory',
      );
    }
    const directory = await parent.getDirectoryHandle(segments.at(-1) as string);
    if (
      !isRecord(directory) ||
      directory.kind !== 'directory' ||
      typeof directory.entries !== 'function'
    ) {
      fail('K4-ASSET-POSE-BUNDLE-001', 'Pose model is not an enumerable directory');
    }
    const entries: Array<[string, Dsl4BrowserPreviewFileHandle]> = [];
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
      entries.push([entry[0], entry[1] as unknown as Dsl4BrowserPreviewFileHandle]);
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

async function readPoseSource(
  root: Dsl4BrowserPreviewDirectoryHandle,
  assetId: string,
  sourcePath: string,
  maxFileBytes: number,
  maxTotalBytes: number,
  subtleCrypto: Dsl4SubtleCrypto,
) {
  if (!isDsl4PoseArchivePath(sourcePath)) {
    return readPoseDirectory(root, sourcePath, maxFileBytes);
  }
  const [archive] = await readSingleFile(root, sourcePath, maxFileBytes);
  if (!archive) throw new TypeError(`Pose archive is empty: ${sourcePath}`);
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

function commonManifestAsset(asset: Dsl4BrowserPreviewAsset, id: string) {
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

function hasLocalFiles(storyDocument: Dsl4BrowserPreviewStoryDocument) {
  return Object.values(storyDocument.assets ?? {}).some(
    (asset) => isRecord(asset) && typeof asset.file === 'string',
  );
}

/** Capture exactly the local files declared by one validated StoryDocument. */
async function captureAssetSnapshot(
  storyDocument: Dsl4BrowserPreviewStoryDocument,
  projectRoot: Dsl4BrowserPreviewDirectoryHandle | null,
  options: {
    maxAssetFileBytes: number;
    maxAssetFiles: number;
    maxAssetBytes: number;
    subtleCrypto: Dsl4SubtleCrypto;
  },
) {
  const manifestAssets: Record<string, unknown>[] = [];
  const blobs = new Map<string, Uint8Array>();
  const adoption: unknown[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  const assets = storyDocument.assets ?? {};
  for (const [id, asset] of Object.entries(assets).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const common = commonManifestAsset(asset, id);
    if (asset.delivery === 'remote') {
      manifestAssets.push({
        ...common,
        source: {type: 'remote', ...(isRecord(asset.source) ? asset.source : {})},
      });
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
    let files;
    try {
      files =
        asset.kind === 'recognitionModel'
          ? await readPoseSource(
              projectRoot,
              id,
              asset.file,
              options.maxAssetFileBytes,
              options.maxAssetBytes,
              options.subtleCrypto,
            )
          : await readSingleFile(projectRoot, asset.file, options.maxAssetFileBytes);
    } catch (error) {
      const failure =
        error instanceof Dsl4BrowserPreviewRuntimeAssetError
          ? error
          : new Dsl4BrowserPreviewRuntimeAssetError(
              'K4-ASSET-PREPARE-001',
              `The preview asset could not be prepared: ${asset.file}`,
              error,
            );
      throw new Dsl4BrowserPreviewRuntimeAssetError(failure.code, failure.message, failure, {
        displayName: asset.file,
        path: `$.assets[${JSON.stringify(id)}].file`,
      });
    }
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
          asset.kind === 'recognitionModel' && isDsl4PoseArchivePath(asset.file)
            ? 'archive'
            : asset.kind === 'recognitionModel'
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
 */
export async function createDsl4BrowserPreviewRuntimeComponent(input: {
  baseComponent: Dsl4BrowserPreviewRuntimeComponent;
  sourceResult: unknown;
  projectRoot?: unknown;
  maxAssetFileBytes: number;
  maxAssetFiles: number;
  maxAssetBytes: number;
  quietWindowMs?: number;
  sleep?: (milliseconds: number) => Promise<unknown>;
  subtleCrypto?: Dsl4SubtleCrypto | undefined;
}) {
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
  const sourceResult = input.sourceResult as Dsl4BrowserPreviewSourceResult;
  const storyDocument = input.sourceResult
    .storyDocument as unknown as Dsl4BrowserPreviewStoryDocument;
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
        ? (input.projectRoot as unknown as Dsl4BrowserPreviewDirectoryHandle)
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
    subtleCrypto: subtleCrypto as Dsl4SubtleCrypto,
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
    storyDocument as unknown as Readonly<Record<string, unknown>>,
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
    sourceDescriptor: sourceResult.sourceSnapshot,
    assetBundle,
    getAssetFile(assetId: string, filePath: string) {
      const bytes = snapshot.blobs.get(`${assetId}\0${filePath}`);
      if (!bytes)
        fail('K4-ASSET-MISSING', `Preview asset payload is missing: ${assetId}/${filePath}`);
      return new Uint8Array(bytes);
    },
  });
}
