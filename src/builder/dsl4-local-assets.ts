import {lstat, open, readdir, realpath} from 'node:fs/promises';
import path from 'node:path';

import {computeDsl4Sha256Integrity, Dsl4SourceDescriptorError} from '../dsl4/source-descriptor.js';
import {
  extractDsl4PoseArchive,
  isDsl4PoseArchivePath,
} from '../dsl4/platform/pose-archive-extractor.js';
import {deepFreeze} from '../dsl4/story-document.js';
import {Sb3BuilderError} from './errors.js';

const defaultFileSystem = Object.freeze({lstat, open, readdir, realpath});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string, code: string, cause?: unknown): never {
  throw new Sb3BuilderError(message, {stage: 'dsl4-local-assets', code, cause});
}

function errorCode(error: unknown) {
  return isRecord(error) && typeof error.code === 'string' ? error.code : '';
}

function isWithin(ancestor: string, candidate: string) {
  const relative = path.relative(ancestor, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function positiveLimit(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

function validateFileSystem(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.realpath !== 'function' ||
    typeof value.lstat !== 'function' ||
    typeof value.open !== 'function' ||
    typeof value.readdir !== 'function'
  ) {
    throw new TypeError('fileSystem must provide realpath, lstat, open, and readdir');
  }
  return value as {realpath: Function; lstat: Function; open: Function; readdir: Function};
}

function localPath(value: unknown, assetId: string) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail(`Asset ${assetId} file must be a non-empty path without NUL`, 'K4-ASSET-PATH-001');
  }
  const segments = value.split('/');
  if (
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    path.posix.normalize(value) !== value
  ) {
    fail(
      `Asset ${assetId} file must be a normalized POSIX-relative path without dot segments`,
      'K4-ASSET-PATH-001',
    );
  }
  return value;
}

function sameFileState(left: Record<string, any>, right: Record<string, any>) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function stateKey(state: Record<string, any>) {
  return `${state.dev}:${state.ino}:${state.size}:${state.mtimeMs}:${state.ctimeMs}`;
}

async function readBoundedFile(filePath: string, limit: number, fileSystem: {open: Function}) {
  const handle = await fileSystem.open(filePath, 'r');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (size <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - size + 1));
      const result = await handle.read(chunk, 0, chunk.length, null);
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      size += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  if (size > limit) fail('Asset file exceeds maxFileBytes', 'K4-ASSET-SIZE-001');
  return Buffer.concat(chunks, size);
}

async function readStableFile(
  filePath: string,
  assetId: string,
  limit: number,
  fileSystem: {lstat: Function},
  readFile: (filePath: string, limit: number) => Promise<Buffer | Uint8Array>,
) {
  let before;
  let first;
  let middle;
  let second;
  let after;
  try {
    before = await fileSystem.lstat(filePath);
    if (!before.isFile()) fail(`Asset ${assetId} entry is not a regular file`, 'K4-ASSET-FILE-001');
    if (before.size > limit) fail(`Asset ${assetId} exceeds maxFileBytes`, 'K4-ASSET-SIZE-001');
    first = Buffer.from(await readFile(filePath, limit));
    middle = await fileSystem.lstat(filePath);
    second = Buffer.from(await readFile(filePath, limit));
    after = await fileSystem.lstat(filePath);
  } catch (error) {
    if (error instanceof Sb3BuilderError) throw error;
    fail(`Cannot read asset ${assetId}`, 'K4-ASSET-READ-001', error);
  }
  if (first.length > limit || second.length > limit) {
    fail(`Asset ${assetId} exceeds maxFileBytes`, 'K4-ASSET-SIZE-001');
  }
  if (!sameFileState(before, middle) || !sameFileState(middle, after) || !first.equals(second)) {
    fail(`Asset ${assetId} changed while it was being read`, 'K4-ASSET-UNSTABLE-001');
  }
  return first;
}

async function enumerateDirectory(
  rootPath: string,
  fileSystem: {lstat: Function; readdir: Function},
  assetId: string,
) {
  const files: {path: string; absolutePath: string; state: Record<string, any>}[] = [];
  async function visit(directoryPath: string, relativeDirectory: string) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = (await fileSystem.readdir(directoryPath, {
        withFileTypes: true,
      })) as import('node:fs').Dirent[];
    } catch (error) {
      fail(`Cannot enumerate poseModel ${assetId}`, 'K4-ASSET-READ-001', error);
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (
        !entry.name ||
        entry.name === '.' ||
        entry.name === '..' ||
        entry.name.includes('/') ||
        entry.name.includes('\\') ||
        entry.name.includes('\0')
      ) {
        fail(`PoseModel ${assetId} contains an unsafe entry name`, 'K4-ASSET-PATH-001');
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(directoryPath, entry.name);
      let state;
      try {
        state = await fileSystem.lstat(absolutePath);
      } catch (error) {
        fail(`Cannot inspect poseModel ${assetId}`, 'K4-ASSET-READ-001', error);
      }
      if (state.isSymbolicLink()) {
        fail(`PoseModel ${assetId} contains a symbolic link`, 'K4-ASSET-SYMLINK-001');
      }
      if (state.isDirectory()) await visit(absolutePath, relativePath);
      else if (state.isFile()) files.push({path: relativePath, absolutePath, state});
      else fail(`PoseModel ${assetId} contains a special file`, 'K4-ASSET-FILE-001');
    }
  }
  await visit(rootPath, '');
  return files;
}

function directorySignature(files: {path: string; state: Record<string, any>}[]) {
  return files.map((file) => `${file.path}\0${stateKey(file.state)}`).join('\n');
}

/** Load one immutable metadata snapshot plus copy-on-read bytes for every DSL 4.0 asset. */
export async function loadDsl4LocalAssetSnapshot(
  projectRoot: string,
  storyDocument: Readonly<Record<string, unknown>>,
  {
    maxFileBytes,
    maxFiles,
    maxTotalBytes,
    subtleCrypto = globalThis.crypto?.subtle,
    retainPoseArchives = false,
    fileSystem = defaultFileSystem,
    readFile,
  }: {
    maxFileBytes: number;
    maxFiles: number;
    maxTotalBytes: number;
    subtleCrypto?: {digest: Function} | undefined;
    retainPoseArchives?: boolean;
    fileSystem?: {realpath: Function; lstat: Function; open: Function; readdir: Function};
    readFile?: (filePath: string, limit: number) => Promise<Buffer | Uint8Array>;
  },
) {
  if (storyDocument.kind !== 'StoryDocument' || storyDocument.version !== '4.0') {
    throw new TypeError('DSL 4.0 local assets require a StoryDocument version 4.0');
  }
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('projectRoot must be a non-empty string');
  }
  const fileLimit = positiveLimit(maxFileBytes, 'maxFileBytes');
  const fileCountLimit = positiveLimit(maxFiles, 'maxFiles');
  const totalLimit = positiveLimit(maxTotalBytes, 'maxTotalBytes');
  const fs = validateFileSystem(fileSystem);
  if (readFile !== undefined && typeof readFile !== 'function') {
    throw new TypeError('readFile must be a function');
  }
  if (typeof retainPoseArchives !== 'boolean') {
    throw new TypeError('retainPoseArchives must be a boolean');
  }
  const readSnapshot = readFile ?? ((filePath, limit) => readBoundedFile(filePath, limit, fs));

  let canonicalRoot;
  try {
    canonicalRoot = await fs.realpath(path.resolve(projectRoot));
    const rootState = await fs.lstat(canonicalRoot);
    if (!rootState.isDirectory()) fail('Project root is not a directory', 'K4-ASSET-ROOT-001');
  } catch (error) {
    if (error instanceof Sb3BuilderError) throw error;
    fail('Cannot resolve project root', 'K4-ASSET-ROOT-001', error);
  }

  const blobs: Map<string, Buffer> = new Map();
  const poseArchives: Map<string, Buffer> = new Map();
  const manifestAssets: Record<string, unknown>[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  const assets = (storyDocument.assets ?? {}) as Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;

  for (const assetId of Object.keys(assets).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const asset = assets[assetId];
    const common = {
      id: assetId,
      kind: asset.kind,
      loading: asset.loading,
      ...(typeof asset.target === 'string' ? {target: asset.target} : {}),
      ...(asset.kind === 'backdrop' || asset.kind === 'costume'
        ? {bitmapResolution: asset.bitmapResolution ?? 1}
        : {}),
    };
    if (asset.delivery === 'remote') {
      const source = asset.source as Readonly<Record<string, unknown>>;
      manifestAssets.push({
        ...common,
        source: {type: 'remote', ...source},
      });
      continue;
    }
    if (typeof asset.file !== 'string') {
      manifestAssets.push({
        ...common,
        source: {type: 'project', name: asset.name},
      });
      continue;
    }

    const inputPath = localPath(asset.file, assetId);
    const requestedPath = path.resolve(canonicalRoot, ...inputPath.split('/'));
    let requestedState;
    let canonicalPath;
    try {
      requestedState = await fs.lstat(requestedPath);
      if (requestedState.isSymbolicLink()) {
        fail(`Asset ${assetId} root is a symbolic link`, 'K4-ASSET-SYMLINK-001');
      }
      canonicalPath = await fs.realpath(requestedPath);
    } catch (error) {
      if (error instanceof Sb3BuilderError) throw error;
      fail(
        `Asset ${assetId} is missing`,
        errorCode(error) === 'ENOENT' ? 'K4-ASSET-MISSING' : 'K4-ASSET-READ-001',
        error,
      );
    }
    if (!isWithin(canonicalRoot, canonicalPath)) {
      fail(`Asset ${assetId} escapes the project root`, 'K4-ASSET-PATH-001');
    }
    const recognitionModel = asset.kind === 'recognitionModel';
    if (!recognitionModel && !requestedState.isFile()) {
      fail(`Asset ${assetId} must be a regular file`, 'K4-ASSET-FILE-001');
    }
    if (recognitionModel && !requestedState.isFile() && !requestedState.isDirectory()) {
      fail(`RecognitionModel ${assetId} must be a file or directory`, 'K4-ASSET-FILE-001');
    }

    const archiveMode =
      recognitionModel && requestedState.isFile() && isDsl4PoseArchivePath(inputPath);
    if (archiveMode) {
      const archiveBytes = await readStableFile(
        canonicalPath,
        assetId,
        fileLimit,
        fs,
        readSnapshot,
      );
      let extracted;
      try {
        extracted = await extractDsl4PoseArchive({
          assetId,
          bytes: new Uint8Array(archiveBytes),
          maxArchiveBytes: fileLimit,
          maxFileBytes: fileLimit,
          maxTotalBytes: totalLimit,
          subtleCrypto,
        });
      } catch (error) {
        fail(
          `Cannot extract poseModel archive ${assetId}`,
          errorCode(error) || 'K4-ASSET-ARCHIVE-001',
          error,
        );
      }
      if (retainPoseArchives) poseArchives.set(assetId, Buffer.from(archiveBytes));
      fileCount += extracted.files.length;
      if (fileCount > fileCountLimit) fail('Asset snapshot exceeds maxFiles', 'K4-ASSET-COUNT-001');
      const manifestFiles = [];
      for (const file of extracted.files) {
        totalBytes += file.bytes.byteLength;
        if (totalBytes > totalLimit) {
          fail('Asset snapshot exceeds maxTotalBytes', 'K4-ASSET-TOTAL-SIZE-001');
        }
        const integrity = await computeDsl4Sha256Integrity(file.bytes, subtleCrypto);
        blobs.set(`${assetId}\0${file.path}`, Buffer.from(file.bytes));
        manifestFiles.push({path: file.path, size: file.bytes.byteLength, integrity});
      }
      manifestAssets.push({
        ...common,
        source: {type: 'file', inputPath, mode: 'archive', files: manifestFiles},
      });
      continue;
    }

    const directoryMode = requestedState.isDirectory();
    const firstListing = directoryMode
      ? await enumerateDirectory(canonicalPath, fs, assetId)
      : [
          {
            path: path.posix.basename(inputPath),
            absolutePath: canonicalPath,
            state: requestedState,
          },
        ];
    if (firstListing.length === 0) {
      fail(`PoseModel ${assetId} directory is empty`, 'K4-ASSET-FILE-001');
    }
    fileCount += firstListing.length;
    if (fileCount > fileCountLimit) fail('Asset snapshot exceeds maxFiles', 'K4-ASSET-COUNT-001');

    const manifestFiles: Record<string, unknown>[] = [];
    for (const file of firstListing) {
      const contents = await readStableFile(
        file.absolutePath,
        assetId,
        fileLimit,
        fs,
        readSnapshot,
      );
      totalBytes += contents.length;
      if (totalBytes > totalLimit) {
        fail('Asset snapshot exceeds maxTotalBytes', 'K4-ASSET-TOTAL-SIZE-001');
      }
      let integrity;
      try {
        integrity = await computeDsl4Sha256Integrity(contents, subtleCrypto);
      } catch (error) {
        if (error instanceof Dsl4SourceDescriptorError) {
          fail(error.message, 'K4-ASSET-INTEGRITY-001', error);
        }
        throw error;
      }
      blobs.set(`${assetId}\0${file.path}`, Buffer.from(contents));
      manifestFiles.push({path: file.path, size: contents.length, integrity});
    }
    if (directoryMode) {
      const secondListing = await enumerateDirectory(canonicalPath, fs, assetId);
      if (directorySignature(firstListing) !== directorySignature(secondListing)) {
        fail(`PoseModel ${assetId} changed while it was being read`, 'K4-ASSET-UNSTABLE-001');
      }
    }
    manifestAssets.push({
      ...common,
      source: {
        type: 'file',
        inputPath,
        mode: directoryMode ? 'directory' : 'file',
        files: manifestFiles,
      },
    });
  }

  const manifest = deepFreeze({formatVersion: 1, assets: manifestAssets});
  return Object.freeze({
    manifest,
    getFile(assetId: string, filePath: string) {
      const contents = blobs.get(`${assetId}\0${filePath}`);
      if (!contents) {
        throw new Sb3BuilderError(`Asset snapshot file not found: ${assetId}/${filePath}`, {
          stage: 'dsl4-local-assets',
          code: 'K4-ASSET-LOOKUP-001',
        });
      }
      return Buffer.from(contents);
    },
    getPoseArchive(assetId: string) {
      const contents = poseArchives.get(assetId);
      if (!contents) {
        throw new Sb3BuilderError(`Pose archive snapshot not found: ${assetId}`, {
          stage: 'dsl4-local-assets',
          code: 'K4-ASSET-LOOKUP-001',
        });
      }
      return Buffer.from(contents);
    },
  });
}
