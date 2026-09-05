import {
  createDsl4OneShotBinaryEntryProvider,
  dsl4BinaryEntryFormatVersion,
  dsl4BinaryEntryPrefix,
  Dsl4BinaryEntryError,
  validateDsl4BinaryEntryAssetBundle,
} from './binary-entry-provider.js';

export const dsl4PackagerEntrySourceContractVersion = 1;
export const dsl4PackagerEntrySourceRegistryName =
  '@kubohiroya/tm-kamishibai/dsl4-packager-entry-source/v1';

const supportedSurfaces = new Set(['plain-html', 'zip', 'zip-one-asset', 'electron']);

export class Dsl4PackagerEntrySourceError extends Error {
  code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'Dsl4PackagerEntrySourceError';
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new Dsl4PackagerEntrySourceError(code, message, cause);
}

function isRecord(value: unknown): value is Record<PropertyKey, any> {
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

async function releaseSource(source: unknown) {
  if (!isRecord(source) || typeof source.release !== 'function') return;
  try {
    await source.release();
  } catch (error) {
    fail('K4-PACKAGER-ENTRY-SOURCE-RELEASE-001', 'Packager entry source release failed', error);
  }
}

/**
 * Claim the single source registered by the fixed TurboWarp Packager adapter.
 * The registry deletes its global slot during claim, so a second runtime cannot accidentally
 * reuse the same ZIP closure.
 */
export function claimDsl4PackagerEntrySource({
  globalObject = globalThis,
}: {globalObject?: Record<PropertyKey, any>} = {}) {
  if (!isRecord(globalObject)) throw new TypeError('globalObject must be an object');
  const key = Symbol.for(dsl4PackagerEntrySourceRegistryName);
  const registry = globalObject[key];
  if (!isRecord(registry) || registry.contractVersion !== dsl4PackagerEntrySourceContractVersion) {
    fail(
      'K4-PACKAGER-ENTRY-SOURCE-MISSING-001',
      'A compatible Packager entry source is not registered',
    );
  }
  if (typeof registry.claim !== 'function') {
    fail(
      'K4-PACKAGER-ENTRY-SOURCE-CONTRACT-001',
      'Packager entry source registry does not provide claim',
    );
  }
  let source;
  try {
    source = registry.claim();
  } catch (error) {
    if (error instanceof Dsl4PackagerEntrySourceError) throw error;
    if (isRecord(error) && typeof error.code === 'string') {
      fail(
        error.code,
        typeof error.message === 'string' ? error.message : 'Packager entry source claim failed',
        error,
      );
    }
    fail('K4-PACKAGER-ENTRY-SOURCE-CLAIM-001', 'Packager entry source claim failed', error);
  }
  if (
    !isRecord(source) ||
    source.contractVersion !== dsl4PackagerEntrySourceContractVersion ||
    !supportedSurfaces.has(source.surface) ||
    !isRecord(source.archive) ||
    !Array.isArray(source.entries) ||
    typeof source.readEntry !== 'function' ||
    typeof source.release !== 'function'
  ) {
    void releaseSource(source).catch(() => {});
    fail(
      'K4-PACKAGER-ENTRY-SOURCE-CONTRACT-001',
      'Claimed Packager entry source has an invalid contract',
    );
  }
  return source;
}

/**
 * Convert a claimed Packager source into the validated provider consumed by the runtime policy.
 * This function takes ownership of `source`. A validation failure releases it; a successful
 * provider releases it only through the provider lifecycle.
 */
export async function createDsl4BinaryEntryProviderFromPackagerSource(
  storyDocument: Readonly<Record<string, unknown>>,
  descriptor: unknown,
  source: unknown,
  options: {
    maxArchiveBytes: number;
    maxArchiveEntries: number;
    maxArchiveEntryBytes: number;
    maxArchiveExpandedBytes: number;
    maxAssetFiles: number;
    maxAssetFileBytes: number;
    maxAssetBytes: number;
    maxCompressionRatio: number;
    releaseAfterLastAsset?: boolean;
    subtleCrypto?: {digest: Function} | undefined;
  },
) {
  if (!isRecord(source)) throw new TypeError('source must be an object');
  const archiveByteLimit = positiveLimit(options.maxArchiveBytes, 'maxArchiveBytes');
  const archiveEntryLimit = positiveLimit(options.maxArchiveEntries, 'maxArchiveEntries');
  const archiveEntryByteLimit = positiveLimit(options.maxArchiveEntryBytes, 'maxArchiveEntryBytes');
  const archiveExpandedLimit = positiveLimit(
    options.maxArchiveExpandedBytes,
    'maxArchiveExpandedBytes',
  );
  const maxAssetFiles = positiveLimit(options.maxAssetFiles, 'maxAssetFiles');
  const maxAssetFileBytes = positiveLimit(options.maxAssetFileBytes, 'maxAssetFileBytes');
  const maxAssetBytes = positiveLimit(options.maxAssetBytes, 'maxAssetBytes');
  const ratioLimit = positiveRatio(options.maxCompressionRatio, 'maxCompressionRatio');
  const releaseAfterLastAsset = options.releaseAfterLastAsset ?? false;
  if (typeof releaseAfterLastAsset !== 'boolean') {
    throw new TypeError('releaseAfterLastAsset must be boolean');
  }
  try {
    if (
      source.contractVersion !== dsl4PackagerEntrySourceContractVersion ||
      !supportedSurfaces.has(source.surface) ||
      !isRecord(source.archive) ||
      !Array.isArray(source.entries) ||
      typeof source.readEntry !== 'function' ||
      typeof source.release !== 'function'
    ) {
      fail(
        'K4-PACKAGER-ENTRY-SOURCE-CONTRACT-001',
        'Packager entry source has an invalid contract',
      );
    }
    const archive = source.archive;
    for (const [name, value, limit] of [
      ['bytes', archive.bytes, archiveByteLimit],
      ['entryCount', archive.entryCount, archiveEntryLimit],
      ['expandedBytes', archive.expandedBytes, archiveExpandedLimit],
      ['maxEntryBytes', archive.maxEntryBytes, archiveEntryByteLimit],
    ]) {
      if (!Number.isSafeInteger(value) || Number(value) < 0) {
        fail('K4-PACKAGER-ENTRY-SOURCE-CONTRACT-001', `Packager archive ${name} is invalid`);
      }
      if (Number(value) > limit) {
        fail('K4-ASSET-ENTRY-ARCHIVE-LIMIT-001', `Packager archive exceeds ${name} limit`);
      }
    }
    const validated = await validateDsl4BinaryEntryAssetBundle(storyDocument, descriptor, {
      maxFiles: maxAssetFiles,
      maxFileBytes: maxAssetFileBytes,
      maxTotalBytes: maxAssetBytes,
      subtleCrypto: options.subtleCrypto,
    });
    if (validated.formatVersion !== dsl4BinaryEntryFormatVersion) {
      fail(
        'K4-PACKAGER-ENTRY-FORMAT-001',
        'Packager entry source requires a root binary entry descriptor',
      );
    }
    const expected = new Map();
    for (const file of validated.files as ReadonlyArray<Record<string, any>>) {
      expected.set(file.entry, file.size);
    }
    const supplied = new Map();
    let previousName = '';
    for (const candidate of source.entries) {
      if (
        !isRecord(candidate) ||
        typeof candidate.name !== 'string' ||
        !candidate.name.startsWith(dsl4BinaryEntryPrefix) ||
        !Number.isSafeInteger(candidate.compressedSize) ||
        Number(candidate.compressedSize) < 0 ||
        !Number.isSafeInteger(candidate.uncompressedSize) ||
        Number(candidate.uncompressedSize) < 0
      ) {
        fail('K4-PACKAGER-ENTRY-SOURCE-CONTRACT-001', 'Packager entry metadata is invalid');
      }
      if (supplied.has(candidate.name)) {
        fail('K4-ASSET-ENTRY-DUPLICATE-001', `Duplicate Packager entry: ${candidate.name}`);
      }
      if (previousName !== '' && previousName.localeCompare(candidate.name, 'en') >= 0) {
        fail(
          'K4-PACKAGER-ENTRY-SOURCE-CONTRACT-001',
          'Packager entry metadata must be sorted and unique',
        );
      }
      previousName = candidate.name;
      const expectedSize = expected.get(candidate.name);
      if (expectedSize === undefined) {
        fail(
          'K4-ASSET-ENTRY-MANIFEST-001',
          `Unexpected reserved Packager entry: ${candidate.name}`,
        );
      }
      if (candidate.uncompressedSize !== expectedSize) {
        fail('K4-ASSET-ENTRY-SIZE-001', `Packager entry size does not match: ${candidate.name}`);
      }
      if (
        (candidate.compressedSize === 0 && candidate.uncompressedSize !== 0) ||
        (candidate.compressedSize !== 0 &&
          candidate.uncompressedSize / candidate.compressedSize > ratioLimit)
      ) {
        fail(
          'K4-ASSET-ENTRY-COMPRESSION-001',
          `Packager entry exceeds compression ratio: ${candidate.name}`,
        );
      }
      supplied.set(candidate.name, candidate);
    }
    for (const entryName of expected.keys()) {
      if (!supplied.has(entryName)) {
        fail('K4-ASSET-ENTRY-MANIFEST-001', `Packager entry is missing: ${entryName}`);
      }
    }
    return await createDsl4OneShotBinaryEntryProvider(storyDocument, validated, {
      maxFiles: maxAssetFiles,
      maxFileBytes: maxAssetFileBytes,
      maxTotalBytes: maxAssetBytes,
      maxCompressionRatio: ratioLimit,
      releaseAfterLastAsset,
      async readEntry(entryName, readOptions) {
        const loaded = await source.readEntry(entryName, readOptions);
        if (
          !isRecord(loaded) ||
          !ArrayBuffer.isView(loaded.bytes) ||
          !Number.isSafeInteger(loaded.compressedSize) ||
          Number(loaded.compressedSize) < 0
        ) {
          fail(
            'K4-PACKAGER-ENTRY-SOURCE-CONTRACT-001',
            'Packager entry source returned invalid data',
          );
        }
        const view = loaded.bytes;
        return {
          bytes: new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
          compressedSize: Number(loaded.compressedSize),
        };
      },
      releaseEntries: () => source.release(),
      subtleCrypto: options.subtleCrypto,
    });
  } catch (error) {
    try {
      await releaseSource(source);
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], 'Packager entry source validation failed');
    }
    if (error instanceof Dsl4BinaryEntryError || error instanceof Dsl4PackagerEntrySourceError) {
      throw error;
    }
    throw error;
  }
}
