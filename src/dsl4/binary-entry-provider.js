import {computeDsl4Sha256Integrity} from './source-descriptor.js';
import {validateDsl4AssetBundleManifest} from './asset-bundle-descriptor.js';
import {deepFreeze} from './story-document.js';

const descriptorKeys = new Set(['files', 'formatVersion', 'integrity', 'manifest']);
const fileKeys = new Set(['assetId', 'entry', 'integrity', 'path', 'size']);
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export const dsl4BinaryEntryFormatVersion = 2;
export const dsl4BinaryEntryPrefix = 'kamishibai/assets/v1/';

export class Dsl4BinaryEntryError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'Dsl4BinaryEntryError';
    this.code = code;
  }
}

/** @param {string} code @param {string} message @param {unknown} [cause] @returns {never} */
function fail(code, message, cause) {
  throw new Dsl4BinaryEntryError(code, message, cause);
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

/** @param {unknown} value @param {string} name */
function positiveRatio(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new TypeError(`${name} must be a finite number >= 1`);
  }
  return value;
}

/** @param {Record<string, unknown>} value @param {Set<string>} keys @param {string} name */
function exactKeys(value, keys, name) {
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.has(key));
  const missing = [...keys].filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    fail(
      'K4-ASSET-ENTRY-DESCRIPTOR-001',
      `${name} keys are invalid (unknown: ${unknown.sort().join(', ') || 'none'}; missing: ${missing.sort().join(', ') || 'none'})`,
    );
  }
}

/** @param {unknown} value @param {string} name */
function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('K4-ASSET-ENTRY-DESCRIPTOR-001', `${name} must be a non-empty string without controls`);
  }
  return value;
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
    fail('K4-ASSET-ENTRY-PATH-001', `${name} must be a canonical relative POSIX path`);
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

/** @param {unknown} value @param {string} name */
function sri(value, name) {
  if (typeof value !== 'string' || !/^sha256-[A-Za-z0-9+/]{43}=$/u.test(value)) {
    fail('K4-ASSET-ENTRY-DESCRIPTOR-001', `${name} must be a SHA-256 SRI value`);
  }
  const encoded = value.slice('sha256-'.length);
  if ((base64Alphabet.indexOf(encoded.charAt(encoded.length - 2)) & 3) !== 0) {
    fail('K4-ASSET-ENTRY-DESCRIPTOR-001', `${name} is not canonical base64`);
  }
  return value;
}

/** @param {string} integrity */
function integrityHex(integrity) {
  const encoded = sri(integrity, 'integrity').slice('sha256-'.length);
  let bits = 0;
  let buffer = 0;
  let output = '';
  for (const character of encoded) {
    if (character === '=') break;
    const value = base64Alphabet.indexOf(character);
    if (value < 0) fail('K4-ASSET-ENTRY-DESCRIPTOR-001', 'integrity is not canonical base64');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += ((buffer >>> bits) & 0xff).toString(16).padStart(2, '0');
      buffer &= (1 << bits) - 1;
    }
  }
  if (output.length !== 64) {
    fail('K4-ASSET-ENTRY-DESCRIPTOR-001', 'integrity must contain one SHA-256 digest');
  }
  return output;
}

/** @param {Uint8Array} left @param {Uint8Array} right */
function equalBytes(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** @param {string} integrity */
function entryNameForIntegrity(integrity) {
  return `${dsl4BinaryEntryPrefix}${integrityHex(integrity)}`;
}

/** @param {Readonly<Record<string, any>>} manifest */
function expectedFileMap(manifest) {
  const files = new Map();
  for (const asset of manifest.assets) {
    if (asset.source.type !== 'file') continue;
    for (const file of asset.source.files) files.set(`${asset.id}\0${file.path}`, file);
  }
  return files;
}

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {unknown} input
 * @param {object} options
 * @param {number} options.maxFiles
 * @param {number} options.maxFileBytes
 * @param {number} options.maxTotalBytes
 * @param {{digest: Function}} [options.subtleCrypto]
 */
export async function validateDsl4BinaryEntryAssetBundle(
  storyDocument,
  input,
  {maxFiles, maxFileBytes, maxTotalBytes, subtleCrypto = globalThis.crypto?.subtle},
) {
  if (storyDocument.kind !== 'StoryDocument' || storyDocument.version !== '4.0') {
    throw new TypeError('DSL 4.0 binary entry bundle requires a StoryDocument version 4.0');
  }
  const fileLimit = positiveLimit(maxFiles, 'maxFiles');
  const perFileLimit = positiveLimit(maxFileBytes, 'maxFileBytes');
  const totalLimit = positiveLimit(maxTotalBytes, 'maxTotalBytes');
  if (!isRecord(input))
    fail('K4-ASSET-ENTRY-DESCRIPTOR-001', 'Binary entry bundle must be an object');
  exactKeys(input, descriptorKeys, 'binary entry bundle');
  if (input.formatVersion !== dsl4BinaryEntryFormatVersion || !Array.isArray(input.files)) {
    fail('K4-ASSET-ENTRY-DESCRIPTOR-001', 'Binary entry bundle format is invalid');
  }
  const manifest = validateDsl4AssetBundleManifest(storyDocument, input.manifest);
  if (input.files.length > fileLimit) {
    fail('K4-ASSET-ENTRY-LIMIT-001', 'Binary entry bundle exceeds maxFiles');
  }
  const expectedFiles = expectedFileMap(manifest);
  const seen = new Set();
  const entries = new Map();
  let totalBytes = 0;
  const files = [];
  for (const [index, candidate] of input.files.entries()) {
    if (!isRecord(candidate)) {
      fail('K4-ASSET-ENTRY-DESCRIPTOR-001', `files[${index}] must be an object`);
    }
    exactKeys(candidate, fileKeys, `files[${index}]`);
    const assetId = nonEmptyString(candidate.assetId, `files[${index}].assetId`);
    const filePath = safeRelativePath(candidate.path, `files[${index}].path`);
    const key = `${assetId}\0${filePath}`;
    if (seen.has(key))
      fail('K4-ASSET-ENTRY-DUPLICATE-001', `Duplicate file: ${assetId}/${filePath}`);
    seen.add(key);
    const expected = expectedFiles.get(key);
    if (!expected) fail('K4-ASSET-ENTRY-MANIFEST-001', `Unexpected file: ${assetId}/${filePath}`);
    if (!Number.isSafeInteger(candidate.size) || Number(candidate.size) < 0) {
      fail('K4-ASSET-ENTRY-DESCRIPTOR-001', `File size is invalid: ${assetId}/${filePath}`);
    }
    const size = Number(candidate.size);
    const integrity = sri(candidate.integrity, `files[${index}].integrity`);
    const entry = safeRelativePath(candidate.entry, `files[${index}].entry`);
    if (
      size !== expected.size ||
      integrity !== expected.integrity ||
      entry !== entryNameForIntegrity(integrity)
    ) {
      fail('K4-ASSET-ENTRY-MANIFEST-001', `File metadata does not match: ${assetId}/${filePath}`);
    }
    const existingEntry = entries.get(entry);
    if (existingEntry && (existingEntry.size !== size || existingEntry.integrity !== integrity)) {
      fail('K4-ASSET-ENTRY-MANIFEST-001', `Content-addressed entry is inconsistent: ${entry}`);
    }
    entries.set(entry, {size, integrity});
    if (size > perFileLimit) {
      fail('K4-ASSET-ENTRY-LIMIT-001', `File exceeds maxFileBytes: ${assetId}/${filePath}`);
    }
    totalBytes += size;
    if (totalBytes > totalLimit) {
      fail('K4-ASSET-ENTRY-LIMIT-001', 'Binary entry bundle exceeds maxTotalBytes');
    }
    files.push({assetId, path: filePath, size, integrity, entry});
  }
  if (seen.size !== expectedFiles.size) {
    fail('K4-ASSET-ENTRY-MANIFEST-001', 'Binary entry bundle is missing one or more files');
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
    fail('K4-ASSET-ENTRY-ORDER-001', 'Binary entry files are not in canonical order');
  }
  const content = {formatVersion: dsl4BinaryEntryFormatVersion, manifest, files};
  const integrity = sri(input.integrity, 'bundle integrity');
  const expectedIntegrity = await computeDsl4Sha256Integrity(
    new TextEncoder().encode(canonicalJson(content)),
    subtleCrypto,
  );
  if (integrity !== expectedIntegrity) {
    fail('K4-ASSET-ENTRY-INTEGRITY-001', 'Binary entry bundle integrity does not match');
  }
  return deepFreeze({...content, integrity: expectedIntegrity});
}

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {{manifest: unknown, getFile(assetId: string, filePath: string): Uint8Array}} snapshot
 * @param {Parameters<typeof validateDsl4BinaryEntryAssetBundle>[2]} options
 */
export async function createDsl4BinaryEntryAssetBundle(storyDocument, snapshot, options) {
  if (!snapshot || typeof snapshot.getFile !== 'function') {
    throw new TypeError('asset snapshot must provide manifest and getFile');
  }
  const manifest = validateDsl4AssetBundleManifest(storyDocument, snapshot.manifest);
  const fileLimit = positiveLimit(options.maxFiles, 'maxFiles');
  const perFileLimit = positiveLimit(options.maxFileBytes, 'maxFileBytes');
  const totalLimit = positiveLimit(options.maxTotalBytes, 'maxTotalBytes');
  let declaredFiles = 0;
  let declaredBytes = 0;
  for (const asset of /** @type {ReadonlyArray<Record<string, any>>} */ (manifest.assets)) {
    if (asset.source.type !== 'file') continue;
    for (const file of asset.source.files) {
      declaredFiles += 1;
      declaredBytes += file.size;
      if (
        declaredFiles > fileLimit ||
        file.size > perFileLimit ||
        !Number.isSafeInteger(declaredBytes) ||
        declaredBytes > totalLimit
      ) {
        fail('K4-ASSET-ENTRY-LIMIT-001', 'Binary entry bundle exceeds a declared resource limit');
      }
    }
  }
  const files = [];
  const entries = new Map();
  for (const asset of /** @type {ReadonlyArray<Record<string, any>>} */ (manifest.assets)) {
    if (asset.source.type !== 'file') continue;
    for (const file of asset.source.files) {
      const bytes = new Uint8Array(snapshot.getFile(String(asset.id), String(file.path)));
      if (bytes.length !== file.size) {
        fail('K4-ASSET-ENTRY-SIZE-001', `File size does not match: ${asset.id}/${file.path}`);
      }
      const integrity = await computeDsl4Sha256Integrity(bytes, options.subtleCrypto);
      if (integrity !== file.integrity) {
        fail(
          'K4-ASSET-ENTRY-INTEGRITY-001',
          `File integrity does not match: ${asset.id}/${file.path}`,
        );
      }
      const entry = entryNameForIntegrity(integrity);
      const existing = entries.get(entry);
      if (existing && !equalBytes(existing, bytes)) {
        fail('K4-ASSET-ENTRY-INTEGRITY-001', `Content-addressed entry collision: ${entry}`);
      }
      if (!existing) entries.set(entry, new Uint8Array(bytes));
      files.push({assetId: asset.id, path: file.path, size: bytes.length, integrity, entry});
    }
  }
  const content = {formatVersion: dsl4BinaryEntryFormatVersion, manifest, files};
  const descriptor = await validateDsl4BinaryEntryAssetBundle(
    storyDocument,
    {
      ...content,
      integrity: await computeDsl4Sha256Integrity(
        new TextEncoder().encode(canonicalJson(content)),
        options.subtleCrypto,
      ),
    },
    options,
  );
  const names = Object.freeze([...entries.keys()].sort());
  return Object.freeze({
    descriptor,
    entryNames: names,
    /** @param {string} entryName */
    getEntry(entryName) {
      const bytes = entries.get(entryName);
      if (!bytes) fail('K4-ASSET-ENTRY-LOOKUP-001', `Binary entry not found: ${entryName}`);
      return new Uint8Array(bytes);
    },
  });
}

/** @param {AbortSignal | undefined} signal */
function assertNotAborted(signal) {
  if (signal?.aborted) fail('K4-ASSET-ENTRY-ABORTED-001', 'Binary entry consumption was aborted');
}

/** @param {AbortSignal | undefined} external @param {AbortSignal} internal */
function linkAbortSignals(external, internal) {
  if (!external) return {signal: internal, cleanup() {}};
  const controller = new AbortController();
  const abort = () => controller.abort();
  external.addEventListener('abort', abort, {once: true});
  internal.addEventListener('abort', abort, {once: true});
  if (external.aborted || internal.aborted) abort();
  return {
    signal: controller.signal,
    cleanup() {
      external.removeEventListener('abort', abort);
      internal.removeEventListener('abort', abort);
    },
  };
}

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {unknown} descriptor
 * @param {object} options
 * @param {number} options.maxFiles
 * @param {number} options.maxFileBytes
 * @param {number} options.maxTotalBytes
 * @param {number} options.maxCompressionRatio
 * @param {(entryName: string, options: {signal?: AbortSignal}) => Promise<{bytes: Uint8Array, compressedSize: number}> | {bytes: Uint8Array, compressedSize: number}} options.readEntry
 * @param {() => Promise<void> | void} [options.releaseEntries]
 * @param {{digest: Function}} [options.subtleCrypto]
 */
export async function createDsl4OneShotBinaryEntryProvider(
  storyDocument,
  descriptor,
  {
    maxFiles,
    maxFileBytes,
    maxTotalBytes,
    maxCompressionRatio,
    readEntry,
    releaseEntries,
    subtleCrypto = globalThis.crypto?.subtle,
  },
) {
  if (typeof readEntry !== 'function') throw new TypeError('readEntry must be a function');
  if (releaseEntries !== undefined && typeof releaseEntries !== 'function') {
    throw new TypeError('releaseEntries must be a function');
  }
  const ratioLimit = positiveRatio(maxCompressionRatio, 'maxCompressionRatio');
  const validated = await validateDsl4BinaryEntryAssetBundle(storyDocument, descriptor, {
    maxFiles,
    maxFileBytes,
    maxTotalBytes,
    subtleCrypto,
  });
  const filesByAsset = new Map();
  for (const file of /** @type {ReadonlyArray<Record<string, any>>} */ (validated.files)) {
    const files = filesByAsset.get(file.assetId) ?? [];
    files.push(file);
    filesByAsset.set(file.assetId, files);
  }
  const assetIds = Object.freeze([...filesByAsset.keys()].sort());
  const consumed = new Set();
  /** @type {typeof readEntry | null} */
  let reader = readEntry;
  /** @type {typeof releaseEntries | null} */
  let sourceRelease = releaseEntries ?? null;
  let released = false;
  let releaseRequested = false;
  const sourceAbort = new AbortController();
  /** @type {Promise<Readonly<{assetId: string, files: ReadonlyArray<Readonly<Record<string, unknown>>>}>> | null} */
  let pending = null;

  async function finalize() {
    if (released) return;
    released = true;
    sourceAbort.abort();
    const callback = sourceRelease;
    reader = null;
    sourceRelease = null;
    if (callback) {
      try {
        await callback();
      } catch (error) {
        fail('K4-ASSET-ENTRY-RELEASE-001', 'Binary entry source release failed', error);
      }
    }
  }

  const provider = {
    descriptor: validated,
    assetIds,
    get released() {
      return released;
    },
    get remainingAssetCount() {
      return assetIds.length - consumed.size;
    },
    /** @param {string} assetId @param {{signal?: AbortSignal}} [consumeOptions] */
    async consumeAsset(assetId, consumeOptions = {}) {
      if (released || releaseRequested) {
        fail('K4-ASSET-ENTRY-RELEASED-001', 'Binary entry provider has been released');
      }
      if (pending) fail('K4-ASSET-ENTRY-BUSY-001', 'Binary entry provider is already consuming');
      const files = filesByAsset.get(assetId);
      if (!files) fail('K4-ASSET-ENTRY-LOOKUP-001', `Binary asset not found: ${assetId}`);
      if (consumed.has(assetId)) {
        fail('K4-ASSET-ENTRY-CONSUMED-001', `Binary asset was already consumed: ${assetId}`);
      }
      assertNotAborted(consumeOptions.signal);
      const linkedAbort = linkAbortSignals(consumeOptions.signal, sourceAbort.signal);
      const signal = linkedAbort.signal;
      const operation = (async () => {
        try {
          const output = [];
          for (const file of files) {
            assertNotAborted(signal);
            let loaded;
            try {
              loaded = await /** @type {Function} */ (reader)(file.entry, {signal});
            } catch (error) {
              if (signal.aborted) {
                fail('K4-ASSET-ENTRY-ABORTED-001', 'Binary entry consumption was aborted', error);
              }
              if (error instanceof Dsl4BinaryEntryError) throw error;
              fail('K4-ASSET-ENTRY-READ-001', `Cannot read binary entry: ${file.entry}`, error);
            }
            if (
              !isRecord(loaded) ||
              !(loaded.bytes instanceof Uint8Array) ||
              !Number.isSafeInteger(loaded.compressedSize) ||
              Number(loaded.compressedSize) < 0
            ) {
              fail(
                'K4-ASSET-ENTRY-READ-001',
                `Binary entry reader returned invalid data: ${file.entry}`,
              );
            }
            const bytes = new Uint8Array(loaded.bytes);
            const compressedSize = Number(loaded.compressedSize);
            if (
              (compressedSize === 0 && bytes.length !== 0) ||
              (compressedSize !== 0 && bytes.length / compressedSize > ratioLimit)
            ) {
              fail(
                'K4-ASSET-ENTRY-COMPRESSION-001',
                `Binary entry exceeds compression ratio: ${file.entry}`,
              );
            }
            if (bytes.length !== file.size) {
              fail('K4-ASSET-ENTRY-SIZE-001', `Binary entry size does not match: ${file.entry}`);
            }
            const integrity = await computeDsl4Sha256Integrity(bytes, subtleCrypto);
            if (integrity !== file.integrity) {
              fail(
                'K4-ASSET-ENTRY-INTEGRITY-001',
                `Binary entry integrity does not match: ${file.entry}`,
              );
            }
            output.push(
              Object.freeze({
                path: file.path,
                size: bytes.length,
                integrity,
                bytes,
              }),
            );
          }
          assertNotAborted(signal);
          if (releaseRequested) {
            fail(
              'K4-ASSET-ENTRY-ABORTED-001',
              'Binary entry consumption was superseded by release',
            );
          }
          consumed.add(assetId);
          if (consumed.size === assetIds.length) await finalize();
          return Object.freeze({assetId, files: Object.freeze(output)});
        } finally {
          linkedAbort.cleanup();
        }
      })();
      pending = operation;
      try {
        return await operation;
      } finally {
        pending = null;
      }
    },
    async release() {
      if (released) return;
      releaseRequested = true;
      sourceAbort.abort();
      if (pending) {
        try {
          await pending;
        } catch {
          // The pending consumer owns its diagnostic; release still completes.
        }
      }
      await finalize();
    },
  };
  if (assetIds.length === 0) await finalize();
  return Object.freeze(provider);
}
