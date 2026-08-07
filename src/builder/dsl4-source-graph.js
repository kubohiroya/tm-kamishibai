import {lstat, open, realpath} from 'node:fs/promises';
import path from 'node:path';

import {createDsl4SourceGraph, Dsl4SourceGraphError} from '../dsl4/source-graph.js';
import {Sb3BuilderError} from './errors.js';

const defaultFileSystem = Object.freeze({lstat, open, realpath});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** @param {unknown} value */
function validateFileSystem(value) {
  if (
    !isRecord(value) ||
    typeof value.realpath !== 'function' ||
    typeof value.lstat !== 'function' ||
    typeof value.open !== 'function'
  ) {
    throw new TypeError('fileSystem must provide realpath, lstat, and open');
  }
  return /** @type {{realpath: Function, lstat: Function, open: Function}} */ (value);
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
  if (size > limit) {
    throw new Dsl4SourceGraphError(
      'K4-SOURCE-SIZE-001',
      'Included source exceeds the finite raw read limit',
    );
  }
  return Buffer.concat(chunks, size);
}

/**
 * @param {string} sourcePath
 * @param {string} canonicalRoot
 * @param {number} limit
 * @param {{realpath: Function, lstat: Function, open: Function}} fileSystem
 * @param {(filePath: string, limit: number) => Promise<Buffer | Uint8Array>} readSource
 */
async function readStableIncludedSource(sourcePath, canonicalRoot, limit, fileSystem, readSource) {
  const requestedPath = path.resolve(canonicalRoot, ...sourcePath.split('/'));
  let canonicalPath;
  try {
    canonicalPath = await fileSystem.realpath(requestedPath);
  } catch (error) {
    throw new Dsl4SourceGraphError(
      errorCode(error) === 'ENOENT' ? 'K4-SOURCE-MISSING' : 'K4-SOURCE-READ-001',
      errorCode(error) === 'ENOENT'
        ? 'Included DSL 4.0 source is missing'
        : 'Cannot resolve included DSL 4.0 source',
      {sourceId: sourcePath, sourcePath, cause: error},
    );
  }
  if (!isWithin(canonicalRoot, canonicalPath)) {
    throw new Dsl4SourceGraphError(
      'K4-SOURCE-PATH-001',
      'Included source path escapes the project root',
      {sourceId: sourcePath, sourcePath},
    );
  }

  const rawLimit = Math.min(Number.MAX_SAFE_INTEGER, limit * 2 + 3);
  try {
    const before = await fileSystem.lstat(canonicalPath);
    if (!before.isFile()) {
      throw new Dsl4SourceGraphError(
        'K4-SOURCE-FILE-001',
        'Included source is not a regular file',
        {sourceId: sourcePath, sourcePath},
      );
    }
    if (before.size > rawLimit) {
      throw new Dsl4SourceGraphError(
        'K4-SOURCE-SIZE-001',
        'Included source exceeds the finite raw read limit',
        {sourceId: sourcePath, sourcePath},
      );
    }
    const firstBytes = Buffer.from(await readSource(canonicalPath, rawLimit));
    const middle = await fileSystem.lstat(canonicalPath);
    const secondBytes = Buffer.from(await readSource(canonicalPath, rawLimit));
    const after = await fileSystem.lstat(canonicalPath);
    if (firstBytes.length > rawLimit || secondBytes.length > rawLimit) {
      throw new Dsl4SourceGraphError(
        'K4-SOURCE-SIZE-001',
        'Included source exceeds the finite raw read limit',
        {sourceId: sourcePath, sourcePath},
      );
    }
    if (
      !sameFileState(before, middle) ||
      !sameFileState(middle, after) ||
      !firstBytes.equals(secondBytes)
    ) {
      throw new Dsl4SourceGraphError(
        'K4-PREVIEW-SOURCE-UNSTABLE',
        'Included source changed while it was being read',
        {sourceId: sourcePath, sourcePath},
      );
    }
    return firstBytes;
  } catch (error) {
    if (error instanceof Dsl4SourceGraphError) throw error;
    throw new Dsl4SourceGraphError('K4-SOURCE-READ-001', 'Cannot read included DSL 4.0 source', {
      sourceId: sourcePath,
      sourcePath,
      cause: error,
    });
  }
}

/**
 * Load a complete, stable Source Graph rooted at an already validated external source.
 *
 * @param {string} projectRoot
 * @param {unknown} entrySource
 * @param {object} options
 * @param {Partial<{maxSourceFiles: number, maxSourceBytes: number, maxTotalSourceBytes: number, maxIncludeDepth: number}>} [options.limits]
 * @param {{realpath: Function, lstat: Function, open: Function}} [options.fileSystem]
 * @param {(filePath: string, limit: number) => Promise<Buffer | Uint8Array>} [options.readSource]
 */
export async function loadDsl4BuildSourceGraph(
  projectRoot,
  entrySource,
  {limits, fileSystem = defaultFileSystem, readSource} = {},
) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('projectRoot must be a non-empty string');
  }
  if (
    !isRecord(entrySource) ||
    !isRecord(entrySource.manifest) ||
    typeof entrySource.manifest.path !== 'string' ||
    !isRecord(entrySource.descriptor) ||
    typeof entrySource.descriptor.text !== 'string'
  ) {
    throw new TypeError('entrySource must contain a validated manifest and source descriptor');
  }
  const source = /** @type {{manifest: {path: string}, descriptor: {text: string}}} */ (
    entrySource
  );
  const fs = validateFileSystem(fileSystem);
  if (readSource !== undefined && typeof readSource !== 'function') {
    throw new TypeError('readSource must be a function');
  }
  const readSnapshot =
    readSource ?? ((filePath, maximum) => readBoundedFile(filePath, maximum, fs));
  let canonicalRoot;
  try {
    canonicalRoot = await fs.realpath(path.resolve(projectRoot));
    const rootState = await fs.lstat(canonicalRoot);
    if (!rootState.isDirectory()) {
      throw new Dsl4SourceGraphError('K4-SOURCE-ROOT-001', 'Project root is not a directory');
    }
  } catch (error) {
    if (error instanceof Dsl4SourceGraphError) {
      throw new Sb3BuilderError(error.message, {
        stage: 'dsl4-source-graph',
        code: error.code,
        cause: error,
      });
    }
    throw new Sb3BuilderError('Cannot resolve project root', {
      stage: 'dsl4-source-graph',
      code: 'K4-SOURCE-ROOT-001',
      cause: error,
    });
  }

  try {
    return await createDsl4SourceGraph(source.manifest.path, {
      limits,
      readSource: (sourcePath, maximum) =>
        sourcePath === source.manifest.path
          ? source.descriptor.text
          : readStableIncludedSource(sourcePath, canonicalRoot, maximum, fs, readSnapshot),
    });
  } catch (error) {
    if (error instanceof Dsl4SourceGraphError) {
      throw new Sb3BuilderError(error.message, {
        stage: 'dsl4-source-graph',
        code: error.code,
        cause: error,
      });
    }
    throw error;
  }
}
