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

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} message @param {string} code @param {unknown} [cause] @returns {never} */
function fail(message, code, cause) {
  throw new Sb3BuilderError(message, {stage: 'dsl4-local-assets', code, cause});
}

/** @param {unknown} error */
function errorCode(error) {
  return isRecord(error) && typeof error.code === 'string' ? error.code : '';
}

/** @param {string} ancestor @param {string} candidate */
function isWithin(ancestor, candidate) {
  const relative = path.relative(ancestor, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/** @param {unknown} value @param {string} name */
function positiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

/** @param {unknown} value */
function validateFileSystem(value) {
  if (
    !isRecord(value) ||
    typeof value.realpath !== 'function' ||
    typeof value.lstat !== 'function' ||
    typeof value.open !== 'function' ||
    typeof value.readdir !== 'function'
  ) {
    throw new TypeError('fileSystem must provide realpath, lstat, open, and readdir');
  }
  return /** @type {{realpath: Function, lstat: Function, open: Function, readdir: Function}} */ (
    value
  );
}

/** @param {unknown} value @param {string} assetId */
function localPath(value, assetId) {
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

/** @param {Record<string, any>} left @param {Record<string, any>} right */
function sameFileState(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/** @param {Record<string, any>} state */
function stateKey(state) {
  return `${state.dev}:${state.ino}:${state.size}:${state.mtimeMs}:${state.ctimeMs}`;
}

/**
 * @param {string} filePath
 * @param {number} limit
 * @param {{open: Function}} fileSystem
 */
async function readBoundedFile(filePath, limit, fileSystem) {
  const handle = await fileSystem.open(filePath, 'r');
  /** @type {Buffer[]} */
  const chunks = [];
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

/**
 * @param {string} filePath
 * @param {string} assetId
 * @param {number} limit
 * @param {{lstat: Function}} fileSystem
 * @param {(filePath: string, limit: number) => Promise<Buffer | Uint8Array>} readFile
 */
async function readStableFile(filePath, assetId, limit, fileSystem, readFile) {
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

/**
 * @param {string} rootPath
 * @param {{lstat: Function, readdir: Function}} fileSystem
 * @param {string} assetId
 */
async function enumerateDirectory(rootPath, fileSystem, assetId) {
  /** @type {{path: string, absolutePath: string, state: Record<string, any>}[]} */
  const files = [];
  /** @param {string} directoryPath @param {string} relativeDirectory */
  async function visit(directoryPath, relativeDirectory) {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = /** @type {import('node:fs').Dirent[]} */ (
        await fileSystem.readdir(directoryPath, {withFileTypes: true})
      );
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

/** @param {{path: string, state: Record<string, any>}[]} files */
function directorySignature(files) {
  return files.map((file) => `${file.path}\0${stateKey(file.state)}`).join('\n');
}

/**
 * Load one immutable metadata snapshot plus copy-on-read bytes for every DSL 4.0 asset.
 *
 * @param {string} projectRoot
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {object} options
 * @param {number} options.maxFileBytes
 * @param {number} options.maxFiles
 * @param {number} options.maxTotalBytes
 * @param {{digest: Function}} [options.subtleCrypto]
 * @param {{realpath: Function, lstat: Function, open: Function, readdir: Function}} [options.fileSystem]
 * @param {(filePath: string, limit: number) => Promise<Buffer | Uint8Array>} [options.readFile]
 */
export async function loadDsl4LocalAssetSnapshot(
  projectRoot,
  storyDocument,
  {
    maxFileBytes,
    maxFiles,
    maxTotalBytes,
    subtleCrypto = globalThis.crypto?.subtle,
    fileSystem = defaultFileSystem,
    readFile,
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

  /** @type {Map<string, Buffer>} */
  const blobs = new Map();
  /** @type {Record<string, unknown>[]} */
  const manifestAssets = [];
  let fileCount = 0;
  let totalBytes = 0;
  const assets = /** @type {Readonly<Record<string, Readonly<Record<string, unknown>>>>} */ (
    storyDocument.assets ?? {}
  );

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
      const source = /** @type {Readonly<Record<string, unknown>>} */ (asset.source);
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
    if (asset.kind !== 'poseModel' && !requestedState.isFile()) {
      fail(`Asset ${assetId} must be a regular file`, 'K4-ASSET-FILE-001');
    }
    if (asset.kind === 'poseModel' && !requestedState.isFile() && !requestedState.isDirectory()) {
      fail(`PoseModel ${assetId} must be a file or directory`, 'K4-ASSET-FILE-001');
    }

    const archiveMode =
      asset.kind === 'poseModel' && requestedState.isFile() && isDsl4PoseArchivePath(inputPath);
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

    /** @type {Record<string, unknown>[]} */
    const manifestFiles = [];
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
    /** @param {string} assetId @param {string} filePath */
    getFile(assetId, filePath) {
      const contents = blobs.get(`${assetId}\0${filePath}`);
      if (!contents) {
        throw new Sb3BuilderError(`Asset snapshot file not found: ${assetId}/${filePath}`, {
          stage: 'dsl4-local-assets',
          code: 'K4-ASSET-LOOKUP-001',
        });
      }
      return Buffer.from(contents);
    },
  });
}
