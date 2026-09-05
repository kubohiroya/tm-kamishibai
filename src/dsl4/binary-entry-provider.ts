import {computeDsl4Sha256Integrity} from './source-descriptor.js';
import {validateDsl4AssetBundleManifest} from './asset-bundle-descriptor.js';
import {deepFreeze} from './story-document.js';
import type {Dsl4SubtleCrypto} from './subtle-crypto.js';

const descriptorKeys = new Set(['files', 'formatVersion', 'integrity', 'manifest']);
const legacyFileKeys = new Set(['assetId', 'entry', 'integrity', 'path', 'size']);
const rootFileKeys = new Set(['assetId', 'contentType', 'entry', 'integrity', 'path', 'size']);
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export const dsl4LegacyBinaryEntryFormatVersion = 2;
export const dsl4LegacyBinaryEntryPrefix = 'kamishibai/assets/v1/';
export const dsl4BinaryEntryFormatVersion = 3;
export const dsl4BinaryEntryPrefix = 'k4asset-v1-';
export const dsl4BinaryEntryPrefixes = deepFreeze([
  dsl4LegacyBinaryEntryPrefix,
  dsl4BinaryEntryPrefix,
]);

const contentTypesByExtension = new Map([
  ['bin', 'application/octet-stream'],
  ['gif', 'image/gif'],
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['json', 'application/json'],
  ['m4a', 'audio/mp4'],
  ['mp3', 'audio/mpeg'],
  ['oga', 'audio/ogg'],
  ['ogg', 'audio/ogg'],
  ['png', 'image/png'],
  ['svg', 'image/svg+xml'],
  ['wav', 'audio/wav'],
  ['webp', 'image/webp'],
]);

export class Dsl4BinaryEntryError extends Error {
  code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'Dsl4BinaryEntryError';
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new Dsl4BinaryEntryError(code, message, cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveLimit(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

function positiveRatio(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new TypeError(`${name} must be a finite number >= 1`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: Set<string>, name: string) {
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

function nonEmptyString(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('K4-ASSET-ENTRY-DESCRIPTOR-001', `${name} must be a non-empty string without controls`);
  }
  return value;
}

function safeRelativePath(value: unknown, name: string) {
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

function mediaType(value: unknown, name: string) {
  const contentType = nonEmptyString(value, name);
  if (
    contentType !== contentType.toLowerCase() ||
    contentType.includes(';') ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(contentType)
  ) {
    fail(
      'K4-ASSET-ENTRY-DESCRIPTOR-001',
      `${name} must be a lowercase Content-Type without parameters`,
    );
  }
  return contentType;
}

export function dsl4BinaryEntryContentType(filePath: string) {
  const logicalPath = safeRelativePath(filePath, 'logical path');
  const basename = logicalPath.slice(logicalPath.lastIndexOf('/') + 1);
  const dot = basename.lastIndexOf('.');
  const extension = dot === -1 ? '' : basename.slice(dot + 1).toLowerCase();
  return contentTypesByExtension.get(extension) ?? 'application/octet-stream';
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

function sri(value: unknown, name: string) {
  if (typeof value !== 'string' || !/^sha256-[A-Za-z0-9+/]{43}=$/u.test(value)) {
    fail('K4-ASSET-ENTRY-DESCRIPTOR-001', `${name} must be a SHA-256 SRI value`);
  }
  const encoded = value.slice('sha256-'.length);
  if ((base64Alphabet.indexOf(encoded.charAt(encoded.length - 2)) & 3) !== 0) {
    fail('K4-ASSET-ENTRY-DESCRIPTOR-001', `${name} is not canonical base64`);
  }
  return value;
}

function integrityHex(integrity: string) {
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

function equalBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function rootEntryName(value: unknown, name: string) {
  const entry = nonEmptyString(value, name);
  if (!/^k4asset-v1-[0-9a-f]{64}$/u.test(entry)) {
    fail('K4-ASSET-ENTRY-PATH-001', `${name} must be a root k4asset-v1-<sha256-hex> entry`);
  }
  return entry;
}

function binaryEntryLayout(formatVersion: number) {
  if (formatVersion === dsl4LegacyBinaryEntryFormatVersion) {
    return {
      formatVersion,
      fileKeys: legacyFileKeys,
      prefix: dsl4LegacyBinaryEntryPrefix,
      validateEntry: safeRelativePath,
      includesContentType: false,
    };
  }
  if (formatVersion === dsl4BinaryEntryFormatVersion) {
    return {
      formatVersion,
      fileKeys: rootFileKeys,
      prefix: dsl4BinaryEntryPrefix,
      validateEntry: rootEntryName,
      includesContentType: true,
    };
  }
  fail('K4-ASSET-ENTRY-DESCRIPTOR-001', 'Binary entry bundle format is invalid');
}

function entryNameForIntegrity(integrity: string, layout: ReturnType<typeof binaryEntryLayout>) {
  return `${layout.prefix}${integrityHex(integrity)}`;
}

function expectedFileMap(manifest: Readonly<Record<string, any>>) {
  const files = new Map();
  for (const asset of manifest.assets) {
    if (asset.source.type !== 'file') continue;
    for (const file of asset.source.files) files.set(`${asset.id}\0${file.path}`, file);
  }
  return files;
}

export async function validateDsl4BinaryEntryAssetBundle(
  storyDocument: Readonly<Record<string, unknown>>,
  input: unknown,
  {
    maxFiles,
    maxFileBytes,
    maxTotalBytes,
    subtleCrypto = globalThis.crypto?.subtle,
  }: {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    subtleCrypto?: Dsl4SubtleCrypto | undefined;
  },
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
  if (!Number.isSafeInteger(input.formatVersion) || !Array.isArray(input.files)) {
    fail('K4-ASSET-ENTRY-DESCRIPTOR-001', 'Binary entry bundle format is invalid');
  }
  const layout = binaryEntryLayout(Number(input.formatVersion));
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
    exactKeys(candidate, layout.fileKeys, `files[${index}]`);
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
    const entry = layout.validateEntry(candidate.entry, `files[${index}].entry`);
    const contentType = layout.includesContentType
      ? mediaType(candidate.contentType, `files[${index}].contentType`)
      : undefined;
    const expectedContentType = dsl4BinaryEntryContentType(filePath);
    if (
      size !== expected.size ||
      integrity !== expected.integrity ||
      entry !== entryNameForIntegrity(integrity, layout) ||
      (layout.includesContentType && contentType !== expectedContentType)
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
    files.push({
      assetId,
      path: filePath,
      size,
      integrity,
      ...(contentType === undefined ? {} : {contentType}),
      entry,
    });
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
  const content = {formatVersion: layout.formatVersion, manifest, files};
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

export async function createDsl4BinaryEntryAssetBundle(
  storyDocument: Readonly<Record<string, unknown>>,
  snapshot: {manifest: unknown; getFile(assetId: string, filePath: string): Uint8Array},
  options: Parameters<typeof validateDsl4BinaryEntryAssetBundle>[2],
) {
  if (!snapshot || typeof snapshot.getFile !== 'function') {
    throw new TypeError('asset snapshot must provide manifest and getFile');
  }
  const manifest = validateDsl4AssetBundleManifest(storyDocument, snapshot.manifest);
  const fileLimit = positiveLimit(options.maxFiles, 'maxFiles');
  const perFileLimit = positiveLimit(options.maxFileBytes, 'maxFileBytes');
  const totalLimit = positiveLimit(options.maxTotalBytes, 'maxTotalBytes');
  let declaredFiles = 0;
  let declaredBytes = 0;
  for (const asset of manifest.assets as ReadonlyArray<Record<string, any>>) {
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
  const layout = binaryEntryLayout(dsl4BinaryEntryFormatVersion);
  for (const asset of manifest.assets as ReadonlyArray<Record<string, any>>) {
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
      const entry = entryNameForIntegrity(integrity, layout);
      const existing = entries.get(entry);
      if (existing && !equalBytes(existing, bytes)) {
        fail('K4-ASSET-ENTRY-INTEGRITY-001', `Content-addressed entry collision: ${entry}`);
      }
      if (!existing) entries.set(entry, new Uint8Array(bytes));
      files.push({
        assetId: asset.id,
        path: file.path,
        size: bytes.length,
        integrity,
        contentType: dsl4BinaryEntryContentType(file.path),
        entry,
      });
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
    getEntry(entryName: string) {
      const bytes = entries.get(entryName);
      if (!bytes) fail('K4-ASSET-ENTRY-LOOKUP-001', `Binary entry not found: ${entryName}`);
      return new Uint8Array(bytes);
    },
  });
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) fail('K4-ASSET-ENTRY-ABORTED-001', 'Binary entry consumption was aborted');
}

function linkAbortSignals(external: AbortSignal | undefined, internal: AbortSignal) {
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

export async function createDsl4OneShotBinaryEntryProvider(
  storyDocument: Readonly<Record<string, unknown>>,
  descriptor: unknown,
  {
    maxFiles,
    maxFileBytes,
    maxTotalBytes,
    maxCompressionRatio,
    releaseAfterLastAsset = true,
    readEntry,
    releaseEntries,
    subtleCrypto = globalThis.crypto?.subtle,
  }: {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    maxCompressionRatio: number;
    releaseAfterLastAsset?: boolean;
    readEntry: (
      entryName: string,
      options: {signal?: AbortSignal},
    ) =>
      | Promise<{bytes: Uint8Array; compressedSize: number}>
      | {bytes: Uint8Array; compressedSize: number};
    releaseEntries?: () => Promise<void> | void | undefined;
    subtleCrypto?: Dsl4SubtleCrypto | undefined;
  },
) {
  if (typeof readEntry !== 'function') throw new TypeError('readEntry must be a function');
  if (releaseEntries !== undefined && typeof releaseEntries !== 'function') {
    throw new TypeError('releaseEntries must be a function');
  }
  if (typeof releaseAfterLastAsset !== 'boolean') {
    throw new TypeError('releaseAfterLastAsset must be boolean');
  }
  const ratioLimit = positiveRatio(maxCompressionRatio, 'maxCompressionRatio');
  const validated = await validateDsl4BinaryEntryAssetBundle(storyDocument, descriptor, {
    maxFiles,
    maxFileBytes,
    maxTotalBytes,
    subtleCrypto,
  });
  const filesByAsset = new Map();
  for (const file of validated.files as ReadonlyArray<Record<string, any>>) {
    const files = filesByAsset.get(file.assetId) ?? [];
    files.push(file);
    filesByAsset.set(file.assetId, files);
  }
  const assetIds = Object.freeze([...filesByAsset.keys()].sort());
  const consumed = new Set();
  let reader: typeof readEntry | null = readEntry;
  let sourceRelease: typeof releaseEntries | null = releaseEntries ?? null;
  let released = false;
  let releaseRequested = false;
  const sourceAbort = new AbortController();
  let pending: Promise<
    Readonly<{assetId: string; files: ReadonlyArray<Readonly<Record<string, unknown>>>}>
  > | null = null;

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

  /**
   * Read and validate one logical asset from the entry source.
   *
   * `consume` preserves the original one-shot builder contract. Direct runtime backing uses the
   * same validation path without consuming the asset so a released scene can materialize it again.
   */
  async function materializeAsset(
    assetId: string,
    readOptions: {signal?: AbortSignal},
    consume: boolean,
  ) {
    if (released || releaseRequested) {
      fail('K4-ASSET-ENTRY-RELEASED-001', 'Binary entry provider has been released');
    }
    if (pending) fail('K4-ASSET-ENTRY-BUSY-001', 'Binary entry provider is already reading');
    const files = filesByAsset.get(assetId);
    if (!files) fail('K4-ASSET-ENTRY-LOOKUP-001', `Binary asset not found: ${assetId}`);
    if (consume && consumed.has(assetId)) {
      fail('K4-ASSET-ENTRY-CONSUMED-001', `Binary asset was already consumed: ${assetId}`);
    }
    assertNotAborted(readOptions.signal);
    const linkedAbort = linkAbortSignals(readOptions.signal, sourceAbort.signal);
    const signal = linkedAbort.signal;
    const operation = (async () => {
      try {
        const output = [];
        for (const file of files) {
          assertNotAborted(signal);
          let loaded;
          try {
            loaded = await (reader as Function)(file.entry, {signal});
          } catch (error) {
            if (signal.aborted) {
              fail('K4-ASSET-ENTRY-ABORTED-001', 'Binary entry read was aborted', error);
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
              ...(file.contentType === undefined ? {} : {contentType: file.contentType}),
              bytes,
            }),
          );
        }
        assertNotAborted(signal);
        if (releaseRequested) {
          fail('K4-ASSET-ENTRY-ABORTED-001', 'Binary entry read was superseded by release');
        }
        if (consume) {
          consumed.add(assetId);
          if (releaseAfterLastAsset && consumed.size === assetIds.length) await finalize();
        }
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
  }

  const provider = {
    descriptor: validated,
    assetIds,
    releaseAfterLastAsset,
    get released() {
      return released;
    },
    get remainingAssetCount() {
      return assetIds.length - consumed.size;
    },
    readAsset(assetId: string, readOptions: {signal?: AbortSignal} = {}) {
      return materializeAsset(assetId, readOptions, false);
    },
    consumeAsset(assetId: string, consumeOptions: {signal?: AbortSignal} = {}) {
      return materializeAsset(assetId, consumeOptions, true);
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
  if (releaseAfterLastAsset && assetIds.length === 0) await finalize();
  return Object.freeze(provider);
}
