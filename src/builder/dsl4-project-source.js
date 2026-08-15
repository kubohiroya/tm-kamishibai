import {lstat, open, readdir, realpath} from 'node:fs/promises';
import path from 'node:path';

import {
  dsl4ExternalSourceManifestFilenames,
  dsl4ProjectSourceFilenameSuffix,
  Dsl4ExternalSourceManifestError,
  resolveDsl4ExternalSourceManifestContract,
} from '../dsl4/external-source-manifest.js';
import {parseDsl4ExternalSourceManifest} from './dsl4-external-source.js';
import {Sb3BuilderError} from './errors.js';

export const dsl4ProjectSourceDefaults = Object.freeze({maxSourceManifestBytes: 32 * 1024});

const defaultFileSystem = Object.freeze({lstat, open, readdir, realpath});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} message @param {string} code @param {unknown} [cause] @returns {never} */
function fail(message, code, cause) {
  throw new Sb3BuilderError(message, {stage: 'dsl4-project-source', code, cause});
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

/** @param {unknown} value */
function positiveLimit(value) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError('maxSourceManifestBytes must be a positive safe integer');
  }
  return Number(value);
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
  if (value.readdir !== undefined && typeof value.readdir !== 'function') {
    throw new TypeError('fileSystem.readdir must be a function when present');
  }
  return /** @type {{realpath: Function, lstat: Function, open: Function, readdir?: Function}} */ (
    value
  );
}

/** @param {string} filePath @param {number} limit @param {{open: Function}} fileSystem */
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
  if (size > limit) fail('Source manifest exceeds its byte limit', 'K4-SOURCE-MANIFEST-SIZE-001');
  return Buffer.concat(chunks, size);
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

/**
 * Resolve an optional source manifest and a root-level `.k4.yml` entry without inventing a fixed
 * story filename.
 *
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {string} [options.sourceManifest]
 * @param {string} [options.source]
 * @param {string} [options.sourceId]
 * @param {number} [options.maxSourceManifestBytes]
 * @param {{realpath: Function, lstat: Function, open: Function, readdir?: Function}} [options.fileSystem]
 * @param {(filePath: string, limit: number) => Promise<Buffer | Uint8Array>} [options.readFile]
 */
export async function resolveDsl4ProjectSource(options) {
  if (!isRecord(options)) throw new TypeError('project source options are required');
  if (typeof options.projectRoot !== 'string' || options.projectRoot.length === 0) {
    throw new TypeError('projectRoot must be a non-empty string');
  }
  const limit = positiveLimit(
    options.maxSourceManifestBytes ?? dsl4ProjectSourceDefaults.maxSourceManifestBytes,
  );
  const fileSystem = validateFileSystem(options.fileSystem ?? defaultFileSystem);
  const readSnapshot =
    options.readFile ?? ((filePath, maximum) => readBoundedFile(filePath, maximum, fileSystem));
  if (typeof readSnapshot !== 'function') throw new TypeError('readFile must be a function');
  const requestedRoot = path.resolve(options.projectRoot);
  let canonicalRoot;
  try {
    canonicalRoot = await fileSystem.realpath(requestedRoot);
    const rootState = await fileSystem.lstat(canonicalRoot);
    if (!rootState.isDirectory()) fail('Project root is not a directory', 'K4-SOURCE-ROOT-001');
  } catch (error) {
    if (error instanceof Sb3BuilderError) throw error;
    fail('Cannot resolve project root', 'K4-SOURCE-ROOT-001', error);
  }

  /** @type {string | null} */
  let manifestPath = null;
  if (options.sourceManifest !== undefined) {
    if (typeof options.sourceManifest !== 'string' || options.sourceManifest.length === 0) {
      throw new TypeError('sourceManifest must be a non-empty string when present');
    }
    const requestedManifest = path.resolve(options.sourceManifest);
    if (!isWithin(requestedRoot, requestedManifest)) {
      fail('Source manifest must remain inside the project root', 'K4-SOURCE-MANIFEST-001');
    }
    manifestPath = path.resolve(canonicalRoot, path.relative(requestedRoot, requestedManifest));
  } else {
    for (const filename of dsl4ExternalSourceManifestFilenames) {
      const candidate = path.join(canonicalRoot, filename);
      try {
        const state = await fileSystem.lstat(candidate);
        if (!state.isFile()) {
          fail('Source manifest must be a regular file', 'K4-SOURCE-MANIFEST-001');
        }
        manifestPath = candidate;
        break;
      } catch (error) {
        if (error instanceof Sb3BuilderError) throw error;
        if (errorCode(error) === 'ENOENT') continue;
        fail('Cannot inspect source manifest', 'K4-SOURCE-MANIFEST-001', error);
      }
    }
  }

  /** @type {Record<string, any>} */
  let manifestInput = {};
  if (manifestPath !== null) {
    const extension = path.extname(manifestPath);
    if (!['.yml', '.yaml', '.json'].includes(extension)) {
      fail('Source manifest must use .yml, .yaml, or .json', 'K4-SOURCE-MANIFEST-001');
    }
    try {
      const canonicalManifest = await fileSystem.realpath(manifestPath);
      if (!isWithin(canonicalRoot, canonicalManifest) || canonicalManifest !== manifestPath) {
        fail(
          'Source manifest must not escape the project root or use a symlink',
          'K4-SOURCE-MANIFEST-001',
        );
      }
      const before = await fileSystem.lstat(canonicalManifest);
      if (!before.isFile())
        fail('Source manifest must be a regular file', 'K4-SOURCE-MANIFEST-001');
      const first = Buffer.from(await readSnapshot(canonicalManifest, limit));
      const middle = await fileSystem.lstat(canonicalManifest);
      const second = Buffer.from(await readSnapshot(canonicalManifest, limit));
      const after = await fileSystem.lstat(canonicalManifest);
      if (
        first.byteLength > limit ||
        second.byteLength > limit ||
        !sameFileState(before, middle) ||
        !sameFileState(middle, after) ||
        !first.equals(second)
      ) {
        fail('Source manifest changed while it was being read', 'K4-SOURCE-MANIFEST-UNSTABLE');
      }
      let source;
      try {
        source = new TextDecoder('utf-8', {fatal: true}).decode(first);
      } catch (error) {
        fail('Source manifest is not valid UTF-8', 'K4-SOURCE-MANIFEST-UTF8-001', error);
      }
      manifestInput = parseDsl4ExternalSourceManifest(source, {
        filename: path.basename(canonicalManifest),
      });
    } catch (error) {
      if (error instanceof Sb3BuilderError) throw error;
      fail('Cannot read source manifest', 'K4-SOURCE-MANIFEST-001', error);
    }
  }

  /** @type {string[]} */
  let sourcePaths = [];
  if (options.source === undefined && manifestInput.path === undefined) {
    if (typeof fileSystem.readdir !== 'function') {
      throw new TypeError('fileSystem.readdir is required for source auto-discovery');
    }
    /** @type {any[]} */
    let entries;
    try {
      entries = await fileSystem.readdir(canonicalRoot, {withFileTypes: true});
    } catch (error) {
      fail('Cannot enumerate project entry sources', 'K4-SOURCE-READ-001', error);
    }
    sourcePaths = entries
      .filter(
        (entry) =>
          isRecord(entry) &&
          typeof entry.name === 'string' &&
          typeof entry.isFile === 'function' &&
          entry.isFile() &&
          entry.name.endsWith(dsl4ProjectSourceFilenameSuffix),
      )
      .map((entry) => String(entry.name))
      .sort();
  }

  try {
    const manifest = resolveDsl4ExternalSourceManifestContract(manifestInput, {
      sourcePaths,
      ...(options.source === undefined ? {} : {sourcePath: options.source}),
      ...(options.sourceId === undefined ? {} : {sourceId: options.sourceId}),
    });
    return Object.freeze({
      manifest,
      manifestPath,
      manifestFilename: manifestPath === null ? null : path.basename(manifestPath),
      manifestExists: manifestPath !== null,
    });
  } catch (error) {
    if (error instanceof Dsl4ExternalSourceManifestError) {
      fail(error.message, error.code, error);
    }
    throw error;
  }
}
