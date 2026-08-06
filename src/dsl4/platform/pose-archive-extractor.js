import {unzipSync} from 'fflate';

export const DSL4_POSE_ARCHIVE_EXTRACTOR_FORMAT = 'tmpose-zip-v1';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} assetId @param {string} code @param {string} message @param {unknown} [cause] */
function archiveError(assetId, code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : {cause});
  Object.defineProperties(error, {
    code: {value: code},
    storyPath: {value: `/assets/${assetId.replaceAll('~', '~0').replaceAll('/', '~1')}`},
  });
  return error;
}

function abortError() {
  const error = new Error('Pose archive extraction was cancelled');
  error.name = 'AbortError';
  return error;
}

/** @param {unknown} value @param {string} name */
function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return /** @type {number} */ (value);
}

/** @param {unknown} value */
function validateLimits(value) {
  if (!isRecord(value)) throw new TypeError('pose archive limits must be an object');
  const maxCompressionRatio = value.maxCompressionRatio;
  if (
    typeof maxCompressionRatio !== 'number' ||
    !Number.isFinite(maxCompressionRatio) ||
    maxCompressionRatio < 1
  ) {
    throw new TypeError('maxCompressionRatio must be a finite number >= 1');
  }
  const limits = {
    maxArchiveBytes: positiveSafeInteger(value.maxArchiveBytes, 'maxArchiveBytes'),
    maxEntries: positiveSafeInteger(value.maxEntries, 'maxEntries'),
    maxCompressedEntryBytes: positiveSafeInteger(
      value.maxCompressedEntryBytes,
      'maxCompressedEntryBytes',
    ),
    maxExpandedEntryBytes: positiveSafeInteger(
      value.maxExpandedEntryBytes,
      'maxExpandedEntryBytes',
    ),
    maxTotalExpandedBytes: positiveSafeInteger(
      value.maxTotalExpandedBytes,
      'maxTotalExpandedBytes',
    ),
    maxCompressionRatio,
  };
  if (limits.maxEntries < 3) throw new TypeError('maxEntries must permit three pose model files');
  if (limits.maxTotalExpandedBytes < limits.maxExpandedEntryBytes) {
    throw new TypeError('maxTotalExpandedBytes must be >= maxExpandedEntryBytes');
  }
  return Object.freeze(limits);
}

/** @param {unknown} value */
function validateSignal(value) {
  if (value === undefined) return null;
  if (
    !isRecord(value) ||
    typeof value.aborted !== 'boolean' ||
    typeof value.addEventListener !== 'function' ||
    typeof value.removeEventListener !== 'function'
  ) {
    throw new TypeError('pose archive extraction signal must be an AbortSignal');
  }
  return /** @type {AbortSignal} */ (/** @type {unknown} */ (value));
}

/** @param {Uint8Array} bytes @param {{digest: Function}} subtleCrypto */
async function sha256Integrity(bytes, subtleCrypto) {
  const digest = new Uint8Array(await subtleCrypto.digest('SHA-256', bytes));
  const hex = [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `sha256-${hex}`;
}

/** @param {string} path */
function isSafeEntryPath(path) {
  return (
    path.length > 0 &&
    path.length <= 128 &&
    !path.includes('\0') &&
    !path.includes('/') &&
    !path.includes('\\') &&
    path !== '.' &&
    path !== '..' &&
    /^[A-Za-z0-9._-]+$/u.test(path)
  );
}

/**
 * Create a bounded extractor for one verified Teachable Machine pose ZIP.
 *
 * The extractor consumes only the verified archive bytes supplied by the lifecycle. It never
 * accepts host-provided derived files.
 *
 * @param {object} options
 * @param {unknown} options.limits
 * @param {{digest: Function}} [options.subtleCrypto]
 */
export function createDsl4PoseArchiveExtractor({
  limits: limitsValue,
  subtleCrypto = globalThis.crypto?.subtle,
}) {
  const limits = validateLimits(limitsValue);
  if (!subtleCrypto || typeof subtleCrypto.digest !== 'function') {
    throw new TypeError('pose archive extractor requires Web Crypto digest');
  }

  /**
   * @param {unknown} payload
   * @param {Readonly<Record<string, unknown>>} [context]
   */
  return async function extractPoseArchive(payload, context = {}) {
    if (!isRecord(payload)) throw new TypeError('pose archive payload must be an object');
    const assetId = payload.assetId;
    const archiveIntegrity = payload.archiveIntegrity;
    const archiveBytes = payload.bytes;
    if (typeof assetId !== 'string' || assetId.length === 0) {
      throw new TypeError('pose archive assetId must be a non-empty string');
    }
    if (typeof archiveIntegrity !== 'string' || !/^sha256-[0-9a-f]{64}$/u.test(archiveIntegrity)) {
      throw new TypeError('pose archive integrity must be canonical SHA-256 SRI');
    }
    if (!(archiveBytes instanceof Uint8Array)) {
      throw new TypeError('pose archive bytes must be a Uint8Array');
    }
    if (!isRecord(context)) throw new TypeError('pose archive context must be an object');
    const signal = validateSignal(context.signal);
    if (signal?.aborted) throw abortError();
    if (archiveBytes.byteLength > limits.maxArchiveBytes) {
      throw archiveError(
        assetId,
        'K4-ASSET-ARCHIVE-COMPRESSED-SIZE-001',
        `Pose archive exceeds the compressed byte limit: ${assetId}`,
      );
    }

    const seen = new Set();
    const expectedExpandedSizes = new Map();
    let totalExpandedBytes = 0;
    let extracted;
    try {
      extracted = unzipSync(archiveBytes, {
        filter(entry) {
          if (signal?.aborted) throw abortError();
          if (!isSafeEntryPath(entry.name)) {
            throw archiveError(
              assetId,
              'K4-ASSET-ARCHIVE-PATH-001',
              `Pose archive contains an unsafe entry path: ${assetId}`,
            );
          }
          if (seen.has(entry.name)) {
            throw archiveError(
              assetId,
              'K4-ASSET-ARCHIVE-DUPLICATE-001',
              `Pose archive contains a duplicate entry: ${assetId}`,
            );
          }
          seen.add(entry.name);
          if (seen.size > limits.maxEntries) {
            throw archiveError(
              assetId,
              'K4-ASSET-ARCHIVE-COUNT-001',
              `Pose archive contains too many entries: ${assetId}`,
            );
          }
          if (
            !Number.isSafeInteger(entry.size) ||
            entry.size < 0 ||
            entry.size > limits.maxCompressedEntryBytes
          ) {
            throw archiveError(
              assetId,
              'K4-ASSET-ARCHIVE-COMPRESSED-SIZE-001',
              `Pose archive entry exceeds the compressed byte limit: ${assetId}`,
            );
          }
          if (
            !Number.isSafeInteger(entry.originalSize) ||
            entry.originalSize < 1 ||
            entry.originalSize > limits.maxExpandedEntryBytes
          ) {
            throw archiveError(
              assetId,
              'K4-ASSET-ARCHIVE-EXPANDED-SIZE-001',
              `Pose archive entry exceeds the expanded byte limit: ${assetId}`,
            );
          }
          if (entry.originalSize / Math.max(entry.size, 1) > limits.maxCompressionRatio) {
            throw archiveError(
              assetId,
              'K4-ASSET-ARCHIVE-RATIO-001',
              `Pose archive entry exceeds the compression ratio limit: ${assetId}`,
            );
          }
          totalExpandedBytes += entry.originalSize;
          if (
            !Number.isSafeInteger(totalExpandedBytes) ||
            totalExpandedBytes > limits.maxTotalExpandedBytes
          ) {
            throw archiveError(
              assetId,
              'K4-ASSET-ARCHIVE-EXPANDED-SIZE-001',
              `Pose archive exceeds the total expanded byte limit: ${assetId}`,
            );
          }
          expectedExpandedSizes.set(entry.name, entry.originalSize);
          return true;
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (isRecord(error) && typeof error.code === 'string' && error.code.startsWith('K4-')) {
        throw error;
      }
      throw archiveError(
        assetId,
        'K4-ASSET-ARCHIVE-FORMAT-001',
        `Pose archive is not a supported ZIP: ${assetId}`,
        error,
      );
    }
    if (signal?.aborted) throw abortError();

    const paths = Object.keys(extracted).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const weights = paths.filter((path) => path.endsWith('.bin'));
    if (
      paths.length !== 3 ||
      !paths.includes('model.json') ||
      !paths.includes('metadata.json') ||
      weights.length !== 1
    ) {
      throw archiveError(
        assetId,
        'K4-ASSET-ARCHIVE-ENTRY-001',
        `Pose archive must contain model.json, metadata.json, and one weights file: ${assetId}`,
      );
    }

    const files = await Promise.all(
      paths.map(async (path) => {
        const bytes = new Uint8Array(extracted[path]);
        if (bytes.byteLength !== expectedExpandedSizes.get(path)) {
          throw archiveError(
            assetId,
            'K4-ASSET-ARCHIVE-EXPANDED-SIZE-001',
            `Pose archive entry size changed during extraction: ${assetId}`,
          );
        }
        return Object.freeze({
          path,
          size: bytes.byteLength,
          integrity: await sha256Integrity(bytes, subtleCrypto),
          archiveIntegrity,
          extractorFormat: DSL4_POSE_ARCHIVE_EXTRACTOR_FORMAT,
          bytes,
        });
      }),
    );
    if (signal?.aborted) throw abortError();
    return Object.freeze({
      archiveIntegrity,
      extractorFormat: DSL4_POSE_ARCHIVE_EXTRACTOR_FORMAT,
      files: Object.freeze(files),
    });
  };
}
