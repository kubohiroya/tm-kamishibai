import {unzipSync} from 'fflate';

import {
  createDsl4OneShotBinaryEntryProvider,
  dsl4BinaryEntryPrefix,
  Dsl4BinaryEntryError,
  validateDsl4BinaryEntryAssetBundle,
} from '../dsl4/binary-entry-provider.js';
import {Sb3BuilderError} from './errors.js';
import {installDsl4BinaryEntryRuntimeComponent} from './dsl4-source.js';
import {readSb3, serializeSb3} from './sb3.js';

/** @param {string} code @param {string} message @param {unknown} [cause] @returns {never} */
function entryFail(code, message, cause) {
  throw new Dsl4BinaryEntryError(code, message, cause);
}

/** @param {string} message @param {string} code @param {unknown} [cause] @returns {never} */
function builderFail(message, code, cause) {
  throw new Sb3BuilderError(message, {stage: 'dsl4-binary-entry', code, cause});
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

/** @param {Uint8Array} left @param {Uint8Array} right */
function equalBytes(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** @param {string} entryName */
function validateArchiveEntryName(entryName) {
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

/** @param {unknown} value @param {string} name */
function sortedUniqueNames(value, name) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  const names = /** @type {string[]} */ (value);
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
 *
 * @param {Buffer | Uint8Array} baseSb3Bytes
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {unknown} sourceDescriptor
 * @param {unknown} runtimeArtifact
 * @param {{descriptor: unknown, entryNames: readonly string[], getEntry(entryName: string): Uint8Array, releaseEntries?: () => Promise<void> | void}} binaryBundle
 * @param {Parameters<typeof installDsl4BinaryEntryRuntimeComponent>[5]} options
 */
export async function embedDsl4BinaryEntryRuntimeComponentInSb3(
  baseSb3Bytes,
  storyDocument,
  sourceDescriptor,
  runtimeArtifact,
  binaryBundle,
  options,
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
      releaseEntries:
        binaryBundle.releaseEntries === undefined
          ? undefined
          : () => binaryBundle.releaseEntries?.(),
      subtleCrypto: options.subtleCrypto,
    });
    const expectedNames = [
      ...new Set(
        /** @type {ReadonlyArray<Record<string, any>>} */ (provider.descriptor.files).map(
          ({entry}) => String(entry),
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
    const existingOwnedEntries = Object.keys(archive).filter((name) =>
      name.startsWith(dsl4BinaryEntryPrefix),
    );
    if (existingOwnedEntries.length > 0 && options.replaceExisting !== true) {
      entryFail(
        'K4-ASSET-ENTRY-ARCHIVE-EXISTS-001',
        'SB3 already contains reserved DSL 4.0 binary entries',
      );
    }
    const candidateEntries = new Map();
    for (const assetId of provider.assetIds) {
      const asset = await provider.consumeAsset(assetId);
      const descriptorFiles = /** @type {ReadonlyArray<Record<string, any>>} */ (
        provider.descriptor.files
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
 * @param {Buffer | Uint8Array} sb3Bytes
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {unknown} descriptor
 * @param {object} options
 * @param {number} options.maxArchiveBytes
 * @param {number} options.maxArchiveEntries
 * @param {number} options.maxArchiveEntryBytes
 * @param {number} options.maxArchiveExpandedBytes
 * @param {number} options.maxAssetFiles
 * @param {number} options.maxAssetFileBytes
 * @param {number} options.maxAssetBytes
 * @param {number} options.maxCompressionRatio
 * @param {boolean} [options.releaseAfterLastAsset]
 * @param {{digest: Function}} [options.subtleCrypto]
 */
export async function createDsl4BinaryEntryProviderFromSb3(
  sb3Bytes,
  storyDocument,
  descriptor,
  options,
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
  for (const file of /** @type {ReadonlyArray<Record<string, any>>} */ (validated.files)) {
    const existing = expectedEntries.get(file.entry);
    if (existing !== undefined && existing !== file.size) {
      entryFail(
        'K4-ASSET-ENTRY-MANIFEST-001',
        `Content-addressed entry has conflicting sizes: ${file.entry}`,
      );
    }
    expectedEntries.set(file.entry, file.size);
  }
  let retainedBytes = new Uint8Array(sb3Bytes);
  const metadata = new Map();
  const seen = new Set();
  let entryCount = 0;
  let expandedBytes = 0;
  try {
    unzipSync(retainedBytes, {
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
            compressedSize: info.size,
            originalSize: info.originalSize,
          });
        } else if (info.name.startsWith(dsl4BinaryEntryPrefix)) {
          entryFail('K4-ASSET-ENTRY-MANIFEST-001', `Unexpected reserved ZIP entry: ${info.name}`);
        }
        return false;
      },
    });
  } catch (error) {
    retainedBytes = new Uint8Array(0);
    metadata.clear();
    if (error instanceof Dsl4BinaryEntryError) throw error;
    entryFail('K4-ASSET-ENTRY-ARCHIVE-001', 'SB3 is not a valid bounded ZIP archive', error);
  }
  if (!seen.has('project.json')) {
    retainedBytes = new Uint8Array(0);
    metadata.clear();
    entryFail('K4-ASSET-ENTRY-ARCHIVE-001', 'SB3 is missing project.json');
  }
  for (const entryName of expectedEntries.keys()) {
    if (!metadata.has(entryName)) {
      retainedBytes = new Uint8Array(0);
      metadata.clear();
      entryFail('K4-ASSET-ENTRY-MANIFEST-001', `SB3 is missing binary entry: ${entryName}`);
    }
  }
  return createDsl4OneShotBinaryEntryProvider(storyDocument, validated, {
    maxFiles: options.maxAssetFiles,
    maxFileBytes: options.maxAssetFileBytes,
    maxTotalBytes: options.maxAssetBytes,
    maxCompressionRatio: ratioLimit,
    releaseAfterLastAsset: options.releaseAfterLastAsset,
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
