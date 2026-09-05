import {unzipSync} from 'fflate';

import {
  createDsl4OneShotBinaryEntryProvider,
  dsl4BinaryEntryPrefixes,
  Dsl4BinaryEntryError,
  validateDsl4BinaryEntryAssetBundle,
} from '../dsl4/binary-entry-provider.js';
import {Sb3BuilderError} from './errors.js';
import {installDsl4BinaryEntryRuntimeComponent} from './dsl4-source.js';
import {readSb3, serializeSb3} from './sb3.js';

function entryFail(code: string, message: string, cause?: unknown): never {
  throw new Dsl4BinaryEntryError(code, message, cause);
}

function builderFail(message: string, code: string, cause?: unknown): never {
  throw new Sb3BuilderError(message, {stage: 'dsl4-binary-entry', code, cause});
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

function equalBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isDsl4BinaryEntryName(entryName: string) {
  return dsl4BinaryEntryPrefixes.some((prefix) => entryName.startsWith(prefix));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function installedDsl4EntryNames(project: Record<string, unknown>) {
  const extensionStorage = isRecord(project.extensionStorage) ? project.extensionStorage : {};
  const unbundled = isRecord(extensionStorage.kubohiroyakamishibairuntime4)
    ? extensionStorage.kubohiroyakamishibairuntime4
    : {};
  const bundle = isRecord(extensionStorage.kubohiroyakamishibai4)
    ? extensionStorage.kubohiroyakamishibai4
    : {};
  const components = isRecord(bundle.components) ? bundle.components : {};
  const bundled = isRecord(components.kubohiroyakamishibairuntime4)
    ? components.kubohiroyakamishibairuntime4
    : {};
  const names = new Set();
  for (const container of [unbundled, bundled]) {
    const assets = isRecord(container.assets) ? container.assets : {};
    if (!Array.isArray(assets.files)) continue;
    for (const file of assets.files) {
      if (isRecord(file) && typeof file.entry === 'string') names.add(file.entry);
    }
  }
  return names;
}

function scratchAssetEntryNames(project: Record<string, unknown>) {
  const names = new Set();
  const targets = Array.isArray(project.targets) ? project.targets : [];
  for (const target of targets) {
    if (!isRecord(target)) continue;
    for (const collectionName of ['costumes', 'sounds']) {
      const assets = Array.isArray(target[collectionName]) ? target[collectionName] : [];
      for (const asset of assets) {
        if (!isRecord(asset)) continue;
        if (typeof asset.md5ext === 'string') names.add(asset.md5ext);
        if (typeof asset.assetId === 'string' && typeof asset.dataFormat === 'string') {
          names.add(`${asset.assetId}.${asset.dataFormat}`);
        }
      }
    }
  }
  return names;
}

function validateArchiveEntryName(entryName: string) {
  const path = entryName.endsWith('/') ? entryName.slice(0, -1) : entryName;
  const segments = path.split('/');
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    entryFail('K4-ASSET-ENTRY-PATH-001', `Unsafe ZIP entry path: ${JSON.stringify(entryName)}`);
  }
}

function sortedUniqueNames(value: unknown, name: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  const names = value as string[];
  const sorted = [...new Set(names)].sort();
  if (names.length !== sorted.length || names.some((entry, index) => entry !== sorted[index])) {
    entryFail('K4-ASSET-ENTRY-ORDER-001', `${name} must be sorted and unique`);
  }
  return names;
}

/**
 * Embed an opt-in binary-entry runtime component into an SB3.
 *
 * The binary source is consumed before the output archive is mutated. Replacement removes only
 * the versioned reserved prefix after the complete candidate has passed validation.
 */
export async function embedDsl4BinaryEntryRuntimeComponentInSb3(
  baseSb3Bytes: Buffer | Uint8Array,
  storyDocument: Readonly<Record<string, unknown>>,
  sourceDescriptor: unknown,
  runtimeArtifact: unknown,
  binaryBundle: {
    descriptor: unknown;
    entryNames: readonly string[];
    getEntry(entryName: string): Uint8Array;
    releaseEntries?: () => Promise<void> | void;
  },
  options: Parameters<typeof installDsl4BinaryEntryRuntimeComponent>[5],
) {
  if (!binaryBundle || typeof binaryBundle !== 'object') {
    throw new TypeError('binaryBundle must be an object');
  }
  if (typeof binaryBundle.getEntry !== 'function') {
    throw new TypeError('binaryBundle must provide getEntry');
  }
  if (
    binaryBundle.releaseEntries !== undefined &&
    typeof binaryBundle.releaseEntries !== 'function'
  ) {
    throw new TypeError('binaryBundle.releaseEntries must be a function');
  }
  const maxAssetFiles = positiveLimit(options.maxAssetFiles, 'maxAssetFiles');
  const maxAssetFileBytes = positiveLimit(options.maxAssetFileBytes, 'maxAssetFileBytes');
  const maxAssetBytes = positiveLimit(options.maxAssetBytes, 'maxAssetBytes');
  const {archive, project} = readSb3(baseSb3Bytes);
  let provider;
  try {
    const outputProject = await installDsl4BinaryEntryRuntimeComponent(
      project,
      storyDocument,
      sourceDescriptor,
      runtimeArtifact,
      binaryBundle.descriptor,
      options,
    );
    provider = await createDsl4OneShotBinaryEntryProvider(storyDocument, binaryBundle.descriptor, {
      maxFiles: maxAssetFiles,
      maxFileBytes: maxAssetFileBytes,
      maxTotalBytes: maxAssetBytes,
      maxCompressionRatio: 1,
      readEntry(entryName) {
        const bytes = new Uint8Array(binaryBundle.getEntry(entryName));
        return {bytes, compressedSize: bytes.length};
      },
      ...(binaryBundle.releaseEntries === undefined
        ? {}
        : {releaseEntries: () => binaryBundle.releaseEntries?.()}),
      subtleCrypto: options.subtleCrypto,
    });
    const expectedNames = [
      ...new Set(
        (provider.descriptor.files as ReadonlyArray<Record<string, any>>).map(({entry}) =>
          String(entry),
        ),
      ),
    ].sort();
    const suppliedNames = sortedUniqueNames(binaryBundle.entryNames, 'binaryBundle.entryNames');
    if (
      expectedNames.length !== suppliedNames.length ||
      expectedNames.some((entry, index) => entry !== suppliedNames[index])
    ) {
      entryFail(
        'K4-ASSET-ENTRY-MANIFEST-001',
        'binaryBundle.entryNames do not exactly match the descriptor',
      );
    }
    const existingOwnedEntries = Object.keys(archive).filter(isDsl4BinaryEntryName);
    if (existingOwnedEntries.length > 0 && options.replaceExisting !== true) {
      entryFail(
        'K4-ASSET-ENTRY-ARCHIVE-EXISTS-001',
        'SB3 already contains reserved DSL 4.0 binary entries',
      );
    }
    if (existingOwnedEntries.length > 0) {
      const installedEntries = installedDsl4EntryNames(project);
      const scratchEntries = scratchAssetEntryNames(project);
      const collision = existingOwnedEntries.find(
        (entryName) => !installedEntries.has(entryName) || scratchEntries.has(entryName),
      );
      if (collision !== undefined) {
        entryFail(
          'K4-ASSET-ENTRY-ARCHIVE-COLLISION-001',
          `Reserved DSL 4.0 entry is owned by another archive component: ${collision}`,
        );
      }
    }
    const candidateEntries = new Map();
    for (const assetId of provider.assetIds) {
      const asset = await provider.consumeAsset(assetId);
      const descriptorFiles = (
        provider.descriptor.files as ReadonlyArray<Record<string, any>>
      ).filter((file) => file.assetId === assetId);
      for (const [index, file] of asset.files.entries()) {
        const entryName = String(descriptorFiles[index].entry);
        const existing = candidateEntries.get(entryName);
        if (existing && !equalBytes(existing, file.bytes)) {
          entryFail(
            'K4-ASSET-ENTRY-INTEGRITY-001',
            `Content-addressed entry collision: ${entryName}`,
          );
        }
        if (!existing) candidateEntries.set(entryName, new Uint8Array(file.bytes));
      }
    }
    for (const entryName of existingOwnedEntries) delete archive[entryName];
    for (const [entryName, bytes] of candidateEntries) archive[entryName] = bytes;
    return {
      bytes: serializeSb3(archive, outputProject),
      project: outputProject,
      descriptor: provider.descriptor,
    };
  } catch (error) {
    if (error instanceof Dsl4BinaryEntryError) builderFail(error.message, error.code, error);
    throw error;
  } finally {
    if (provider) {
      try {
        await provider.release();
      } catch (error) {
        if (error instanceof Dsl4BinaryEntryError) builderFail(error.message, error.code, error);
        throw error;
      }
    }
  }
}

/**
 * Create an asset-at-a-time provider backed by a defensive SB3 byte snapshot.
 *
 * A central-directory scan validates archive limits without inflating entries. Each consume call
 * then inflates only the requested content-addressed entry. The retained SB3 bytes and entry index
 * are dropped automatically after the last embedded asset, or on explicit release.
 *
 */
export async function createDsl4BinaryEntryProviderFromSb3(
  sb3Bytes: Buffer | Uint8Array,
  storyDocument: Readonly<Record<string, unknown>>,
  descriptor: unknown,
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
  if (!(sb3Bytes instanceof Uint8Array)) {
    throw new TypeError('sb3Bytes must be a Uint8Array');
  }
  let retainedBytes = new Uint8Array(sb3Bytes);
  let inspection;
  try {
    inspection = await inspectDsl4BinaryEntryArchive(
      retainedBytes,
      storyDocument,
      descriptor,
      options,
    );
  } catch (error) {
    retainedBytes = new Uint8Array(0);
    throw error;
  }
  const ratioLimit = positiveRatio(options.maxCompressionRatio, 'maxCompressionRatio');
  const metadata = new Map(inspection.entries.map((entry) => [entry.name, entry]));
  return createDsl4OneShotBinaryEntryProvider(storyDocument, inspection.descriptor, {
    maxFiles: options.maxAssetFiles,
    maxFileBytes: options.maxAssetFileBytes,
    maxTotalBytes: options.maxAssetBytes,
    maxCompressionRatio: ratioLimit,
    ...(options.releaseAfterLastAsset === undefined
      ? {}
      : {releaseAfterLastAsset: options.releaseAfterLastAsset}),
    readEntry(entryName, {signal}) {
      if (signal?.aborted) {
        entryFail('K4-ASSET-ENTRY-ABORTED-001', 'Binary entry consumption was aborted');
      }
      if (retainedBytes.length === 0) {
        entryFail('K4-ASSET-ENTRY-RELEASED-001', 'SB3 binary entry source was released');
      }
      const entryMetadata = metadata.get(entryName);
      if (!entryMetadata) {
        entryFail('K4-ASSET-ENTRY-LOOKUP-001', `Binary entry not found: ${entryName}`);
      }
      let extracted;
      try {
        extracted = unzipSync(retainedBytes, {filter: ({name}) => name === entryName});
      } catch (error) {
        entryFail('K4-ASSET-ENTRY-READ-001', `Cannot extract binary entry: ${entryName}`, error);
      }
      const bytes = extracted[entryName];
      if (!bytes || Object.keys(extracted).length !== 1) {
        entryFail('K4-ASSET-ENTRY-READ-001', `Binary entry extraction failed: ${entryName}`);
      }
      if (signal?.aborted) {
        entryFail('K4-ASSET-ENTRY-ABORTED-001', 'Binary entry consumption was aborted');
      }
      return {bytes: new Uint8Array(bytes), compressedSize: entryMetadata.compressedSize};
    },
    releaseEntries() {
      retainedBytes = new Uint8Array(0);
      metadata.clear();
    },
    subtleCrypto: options.subtleCrypto,
  });
}

/**
 * Inspect a normalized SB3 without inflating its entries.
 * The returned metadata is safe to embed in a fixed Packager adapter: it contains only aggregate
 * bounds and reserved content-addressed entry names, never project or asset bytes.
 */
export async function inspectDsl4BinaryEntryArchive(
  sb3Bytes: Buffer | Uint8Array,
  storyDocument: Readonly<Record<string, unknown>>,
  descriptor: unknown,
  options: {
    maxArchiveBytes: number;
    maxArchiveEntries: number;
    maxArchiveEntryBytes: number;
    maxArchiveExpandedBytes: number;
    maxAssetFiles: number;
    maxAssetFileBytes: number;
    maxAssetBytes: number;
    maxCompressionRatio: number;
    subtleCrypto?: {digest: Function} | undefined;
  },
) {
  if (!(sb3Bytes instanceof Uint8Array)) {
    throw new TypeError('sb3Bytes must be a Uint8Array');
  }
  const archiveLimit = positiveLimit(options.maxArchiveBytes, 'maxArchiveBytes');
  const archiveEntryLimit = positiveLimit(options.maxArchiveEntries, 'maxArchiveEntries');
  const archiveEntryByteLimit = positiveLimit(options.maxArchiveEntryBytes, 'maxArchiveEntryBytes');
  const archiveExpandedLimit = positiveLimit(
    options.maxArchiveExpandedBytes,
    'maxArchiveExpandedBytes',
  );
  const ratioLimit = positiveRatio(options.maxCompressionRatio, 'maxCompressionRatio');
  if (sb3Bytes.length > archiveLimit) {
    entryFail('K4-ASSET-ENTRY-ARCHIVE-LIMIT-001', 'SB3 exceeds maxArchiveBytes');
  }
  const validated = await validateDsl4BinaryEntryAssetBundle(storyDocument, descriptor, {
    maxFiles: options.maxAssetFiles,
    maxFileBytes: options.maxAssetFileBytes,
    maxTotalBytes: options.maxAssetBytes,
    subtleCrypto: options.subtleCrypto,
  });
  const expectedEntries = new Map();
  for (const file of validated.files as ReadonlyArray<Record<string, any>>) {
    const existing = expectedEntries.get(file.entry);
    if (existing !== undefined && existing !== file.size) {
      entryFail(
        'K4-ASSET-ENTRY-MANIFEST-001',
        `Content-addressed entry has conflicting sizes: ${file.entry}`,
      );
    }
    expectedEntries.set(file.entry, file.size);
  }
  const metadata = new Map();
  const seen = new Set();
  let entryCount = 0;
  let expandedBytes = 0;
  let maxEntryBytes = 0;
  try {
    unzipSync(new Uint8Array(sb3Bytes), {
      filter(info) {
        entryCount += 1;
        if (entryCount > archiveEntryLimit) {
          entryFail('K4-ASSET-ENTRY-ARCHIVE-LIMIT-001', 'SB3 exceeds maxArchiveEntries');
        }
        validateArchiveEntryName(info.name);
        if (seen.has(info.name)) {
          entryFail('K4-ASSET-ENTRY-DUPLICATE-001', `Duplicate ZIP entry: ${info.name}`);
        }
        seen.add(info.name);
        if (info.originalSize > archiveEntryByteLimit) {
          entryFail(
            'K4-ASSET-ENTRY-ARCHIVE-LIMIT-001',
            `ZIP entry exceeds maxArchiveEntryBytes: ${info.name}`,
          );
        }
        maxEntryBytes = Math.max(maxEntryBytes, info.originalSize);
        expandedBytes += info.originalSize;
        if (!Number.isSafeInteger(expandedBytes) || expandedBytes > archiveExpandedLimit) {
          entryFail('K4-ASSET-ENTRY-ARCHIVE-LIMIT-001', 'SB3 exceeds maxArchiveExpandedBytes');
        }
        const expectedSize = expectedEntries.get(info.name);
        if (expectedSize !== undefined) {
          if (info.originalSize !== expectedSize) {
            entryFail(
              'K4-ASSET-ENTRY-SIZE-001',
              `ZIP entry size does not match its descriptor: ${info.name}`,
            );
          }
          if (info.compression !== 0 && info.compression !== 8) {
            entryFail(
              'K4-ASSET-ENTRY-COMPRESSION-001',
              `ZIP entry uses an unsupported compression method: ${info.name}`,
            );
          }
          if (
            (info.size === 0 && info.originalSize !== 0) ||
            (info.size !== 0 && info.originalSize / info.size > ratioLimit)
          ) {
            entryFail(
              'K4-ASSET-ENTRY-COMPRESSION-001',
              `ZIP entry exceeds maxCompressionRatio: ${info.name}`,
            );
          }
          metadata.set(info.name, {
            name: info.name,
            compressedSize: info.size,
            uncompressedSize: info.originalSize,
          });
        } else if (isDsl4BinaryEntryName(info.name)) {
          entryFail('K4-ASSET-ENTRY-MANIFEST-001', `Unexpected reserved ZIP entry: ${info.name}`);
        }
        return false;
      },
    });
  } catch (error) {
    metadata.clear();
    if (error instanceof Dsl4BinaryEntryError) throw error;
    entryFail('K4-ASSET-ENTRY-ARCHIVE-001', 'SB3 is not a valid bounded ZIP archive', error);
  }
  if (!seen.has('project.json')) {
    entryFail('K4-ASSET-ENTRY-ARCHIVE-001', 'SB3 is missing project.json');
  }
  for (const entryName of expectedEntries.keys()) {
    if (!metadata.has(entryName)) {
      entryFail('K4-ASSET-ENTRY-MANIFEST-001', `SB3 is missing binary entry: ${entryName}`);
    }
  }
  return Object.freeze({
    descriptor: validated,
    archive: Object.freeze({
      bytes: sb3Bytes.length,
      entryCount,
      expandedBytes,
      maxEntryBytes,
    }),
    entries: Object.freeze(
      [...metadata.values()]
        .sort((left, right) => left.name.localeCompare(right.name, 'en'))
        .map((entry) => Object.freeze(entry)),
    ),
  });
}
