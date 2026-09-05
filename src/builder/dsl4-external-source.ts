import {randomBytes} from 'node:crypto';
import {lstat, open, realpath} from 'node:fs/promises';
import path from 'node:path';

import {createVerifiedRemoteCacheDatabaseName} from '@kubohiroya/turbowarp-asset-manager/composition';

import {validateDsl4CacheIdentity} from '../dsl4/cache-identity.js';
import {
  Dsl4ExternalSourceManifestError,
  parseDsl4ExternalSourceManifestSource,
  serializeDsl4ExternalSourceManifestSource,
  validateDsl4ExternalSourceManifestContract,
} from '../dsl4/external-source-manifest.js';
import {
  createDsl4EmbeddedSourceDescriptor,
  Dsl4SourceDescriptorError,
} from '../dsl4/source-descriptor.js';
import {deepFreeze} from '../dsl4/story-document.js';
import {Sb3BuilderError} from './errors.js';

const defaultFileSystem = Object.freeze({lstat, open, realpath});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string, code: string, cause?: unknown): never {
  throw new Sb3BuilderError(message, {stage: 'dsl4-external-source', code, cause});
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

function cacheIdentity(value: unknown) {
  try {
    return validateDsl4CacheIdentity(value);
  } catch (error) {
    fail(
      error instanceof Error ? error.message : 'Cache identity is invalid',
      'K4-SOURCE-MANIFEST-001',
      error,
    );
  }
}

function maximumBytes(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError('maxSourceBytes must be a positive safe integer');
  }
  return Number(value);
}

function validateFileSystem(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.realpath !== 'function' ||
    typeof value.lstat !== 'function' ||
    typeof value.open !== 'function'
  ) {
    throw new TypeError('fileSystem must provide realpath, lstat, and open');
  }
  return value as {realpath: Function; lstat: Function; open: Function};
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
  if (size > limit) {
    fail('External source exceeds the finite raw read limit', 'K4-SOURCE-SIZE-001');
  }
  return Buffer.concat(chunks, size);
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

export function validateDsl4ExternalSourceManifest(input: unknown) {
  try {
    return validateDsl4ExternalSourceManifestContract(input);
  } catch (error) {
    if (error instanceof Dsl4ExternalSourceManifestError) {
      fail(error.message, error.code, error);
    }
    throw error;
  }
}

export function parseDsl4ExternalSourceManifest(source: string, {filename}: {filename: string}) {
  try {
    return parseDsl4ExternalSourceManifestSource(source, {filename});
  } catch (error) {
    if (error instanceof Dsl4ExternalSourceManifestError) {
      fail(error.message, error.code, error);
    }
    throw error;
  }
}

export function serializeDsl4ExternalSourceManifest(
  input: unknown,
  {filename}: {filename: string},
) {
  try {
    return serializeDsl4ExternalSourceManifestSource(input, {filename});
  } catch (error) {
    if (error instanceof Dsl4ExternalSourceManifestError) {
      fail(error.message, error.code, error);
    }
    throw error;
  }
}

/**
 * Add a stable cache identity to a source manifest once. Existing identities are preserved,
 * including their database name when the script is renamed.
 */
export function ensureDsl4ExternalSourceCacheIdentity(
  input: unknown,
  {createStableId = () => randomBytes(16).toString('hex')}: {createStableId?: () => string} = {},
) {
  if (typeof createStableId !== 'function')
    throw new TypeError('createStableId must be a function');
  const manifest = validateDsl4ExternalSourceManifest(input);
  if (manifest.path === undefined) {
    fail('External source manifest path is unresolved', 'K4-SOURCE-MISSING');
  }
  const label = path.posix.basename(manifest.path);
  if (manifest.cacheId !== undefined) {
    return deepFreeze({
      created: false,
      manifest,
      cacheIdentity: cacheIdentity({
        id: manifest.cacheId,
        label,
        databaseName: manifest.cacheDatabaseName,
      }),
    });
  }
  const id = createStableId();
  const databaseName = createVerifiedRemoteCacheDatabaseName({id, label});
  const identity = cacheIdentity({id, label, databaseName});
  return deepFreeze({
    created: true,
    manifest: {
      ...manifest,
      cacheId: identity.id,
      cacheDatabaseName: identity.databaseName,
    },
    cacheIdentity: identity,
  });
}

/** Read one stable external source snapshot without returning a machine-local absolute path. */
export async function loadDsl4ExternalSource(
  projectRoot: string,
  inputManifest: unknown,
  {
    maxSourceBytes,
    subtleCrypto = globalThis.crypto?.subtle,
    fileSystem = defaultFileSystem,
    readSource,
  }: {
    maxSourceBytes: number;
    subtleCrypto?: {digest: Function} | undefined;
    fileSystem?: {realpath: Function; lstat: Function; open: Function};
    readSource?: (filePath: string, limit: number) => Promise<Buffer | Uint8Array>;
  },
) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('projectRoot must be a non-empty string');
  }
  const manifest = validateDsl4ExternalSourceManifest(inputManifest);
  if (manifest.path === undefined) {
    fail('External source manifest path is unresolved', 'K4-SOURCE-MISSING');
  }
  const identity =
    manifest.cacheId === undefined
      ? null
      : cacheIdentity({
          id: manifest.cacheId,
          label: path.posix.basename(manifest.path),
          databaseName: manifest.cacheDatabaseName,
        });
  const limit = maximumBytes(maxSourceBytes);
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
      fail('Project root is not a directory', 'K4-SOURCE-ROOT-001');
    }
  } catch (error) {
    if (error instanceof Sb3BuilderError) throw error;
    fail('Cannot resolve project root', 'K4-SOURCE-ROOT-001', error);
  }

  const requestedPath = path.resolve(canonicalRoot, ...manifest.path.split('/'));
  let canonicalPath;
  try {
    canonicalPath = await fs.realpath(requestedPath);
  } catch (error) {
    fail(
      'External DSL 4.0 source is missing',
      errorCode(error) === 'ENOENT' ? 'K4-SOURCE-MISSING' : 'K4-SOURCE-READ-001',
      error,
    );
  }
  if (!isWithin(canonicalRoot, canonicalPath)) {
    fail('External source path escapes the project root', 'K4-SOURCE-PATH-001');
  }

  const rawLimit = Math.min(Number.MAX_SAFE_INTEGER, limit * 2 + 3);
  let before;
  let firstBytes;
  let middle;
  let secondBytes;
  let after;
  try {
    before = await fs.lstat(canonicalPath);
    if (!before.isFile()) fail('External source is not a regular file', 'K4-SOURCE-FILE-001');
    if (before.size > rawLimit) {
      fail('External source exceeds the finite raw read limit', 'K4-SOURCE-SIZE-001');
    }
    firstBytes = Buffer.from(await readSnapshot(canonicalPath, rawLimit));
    middle = await fs.lstat(canonicalPath);
    secondBytes = Buffer.from(await readSnapshot(canonicalPath, rawLimit));
    after = await fs.lstat(canonicalPath);
  } catch (error) {
    if (error instanceof Sb3BuilderError) throw error;
    fail('Cannot read external DSL 4.0 source', 'K4-SOURCE-READ-001', error);
  }
  if (firstBytes.length > rawLimit || secondBytes.length > rawLimit) {
    fail('External source exceeds the finite raw read limit', 'K4-SOURCE-SIZE-001');
  }
  if (
    !sameFileState(before, middle) ||
    !sameFileState(middle, after) ||
    !firstBytes.equals(secondBytes)
  ) {
    fail('External source changed while it was being read', 'K4-PREVIEW-SOURCE-UNSTABLE');
  }

  let source;
  try {
    source = new TextDecoder('utf-8', {fatal: true}).decode(firstBytes);
  } catch (error) {
    fail('External source is not valid UTF-8', 'K4-SOURCE-UTF8-001', error);
  }
  let descriptor;
  try {
    descriptor = await createDsl4EmbeddedSourceDescriptor(source, {
      sourceId: manifest.sourceId,
      displayName: path.posix.basename(manifest.path),
      maxSourceBytes: limit,
      ...(identity ? {cacheIdentity: identity} : {}),
      subtleCrypto,
    });
  } catch (error) {
    if (error instanceof Dsl4SourceDescriptorError) {
      fail(error.message, error.code, error);
    }
    throw error;
  }
  return deepFreeze({manifest, descriptor});
}
