import {deepFreeze} from './story-document.js';

const imageExtensions = new Map([
  ['gif', 'image/gif'],
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['png', 'image/png'],
  ['svg', 'image/svg+xml'],
  ['webp', 'image/webp'],
]);
const audioExtensions = new Map([
  ['mp3', 'audio/mpeg'],
  ['ogg', 'audio/ogg'],
  ['wav', 'audio/wav'],
  ['wave', 'audio/wav'],
]);

export class Dsl4AssetCandidateValidationError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'Dsl4AssetCandidateValidationError';
    this.code = code;
  }
}

/** @param {string} code @param {string} message @param {unknown} [cause] @returns {never} */
function fail(code, message, cause) {
  throw new Dsl4AssetCandidateValidationError(code, message, cause);
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

/** @param {unknown} value */
function signal(value) {
  if (
    !isRecord(value) ||
    typeof value.aborted !== 'boolean' ||
    typeof value.addEventListener !== 'function' ||
    typeof value.removeEventListener !== 'function'
  ) {
    throw new TypeError('asset candidate validator requires an AbortSignal');
  }
  return /** @type {AbortSignal} */ (/** @type {unknown} */ (value));
}

function abortError() {
  const error = new Dsl4AssetCandidateValidationError(
    'K4-ASSET-PREPARE-001',
    'Asset candidate validation was cancelled',
  );
  error.name = 'AbortError';
  return error;
}

/** @param {string} filePath */
function extension(filePath) {
  const value = filePath.split('.').at(-1)?.toLowerCase() ?? '';
  return value === filePath.toLowerCase() ? '' : value;
}

/** @param {Uint8Array} bytes @param {ReadonlyArray<number>} signature */
function startsWith(bytes, signature) {
  return signature.every((value, index) => bytes[index] === value);
}

/** @param {Uint8Array} bytes */
function imageType(bytes) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 6 && /^GIF8[79]a$/u.test(new TextDecoder().decode(bytes.subarray(0, 6)))) {
    return 'image/gif';
  }
  try {
    const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, 4_096));
    if (/^(?:\uFEFF)?\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|\/?>)/iu.test(text)) {
      return 'image/svg+xml';
    }
  } catch {
    // The signature error below is authoritative.
  }
  return null;
}

/** @param {Uint8Array} bytes */
function audioType(bytes) {
  if (
    bytes.length >= 12 &&
    new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === 'WAVE'
  ) {
    return 'audio/wav';
  }
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) return 'audio/ogg';
  if (startsWith(bytes, [0x49, 0x44, 0x33])) return 'audio/mpeg';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return null;
}

/** @param {unknown} value @param {string} name */
function decodedMetrics(value, name) {
  if (!isRecord(value)) fail('K4-ASSET-DECODE-001', `${name} decoder returned an invalid result`);
  return /** @type {Record<string, any>} */ (value);
}

/** @param {Readonly<Record<string, any>>} storyDocument @param {string} assetId */
function referencedPoseLabels(storyDocument, assetId) {
  const labels = new Set();
  for (const scene of /** @type {ReadonlyArray<Readonly<Record<string, any>>>} */ (
    storyDocument.scenes ?? []
  )) {
    if (scene.poseModel !== assetId) continue;
    for (const action of /** @type {ReadonlyArray<Readonly<Record<string, any>>>} */ (
      scene.actions ?? []
    )) {
      if (action.command !== 'pose') continue;
      for (const step of /** @type {ReadonlyArray<Readonly<Record<string, any>>>} */ (
        action.args?.steps ?? []
      )) {
        if (typeof step.pose === 'string') labels.add(step.pose);
      }
    }
  }
  return [...labels].sort();
}

/** @param {Uint8Array} bytes @param {string} name */
function parseJson(bytes, name) {
  try {
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch (error) {
    fail('K4-ASSET-POSE-BUNDLE-001', `Pose model ${name} is not valid UTF-8 JSON`, error);
  }
}

/**
 * Validate one already stable file-backed asset without retaining source paths or bytes in the result.
 * Any decoder resource returned by the injected inspectors remains owned until `release()`.
 *
 * @param {object} options
 * @param {Readonly<Record<string, any>>} options.storyDocument
 * @param {Readonly<Record<string, any>>} options.asset
 * @param {ReadonlyArray<{path: string, bytes: Uint8Array}>} options.files
 * @param {AbortSignal} options.signal
 * @param {number} options.maxImagePixels
 * @param {number} options.maxAudioDurationSeconds
 * @param {number} options.maxAudioChannels
 * @param {number} options.maxAudioSampleRate
 * @param {(bytes: Uint8Array, context: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.inspectImage]
 * @param {(bytes: Uint8Array, context: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.inspectAudio]
 */
export async function validateDsl4AssetCandidate({
  storyDocument,
  asset,
  files,
  signal: inputSignal,
  maxImagePixels,
  maxAudioDurationSeconds,
  maxAudioChannels,
  maxAudioSampleRate,
  inspectImage,
  inspectAudio,
}) {
  if (storyDocument.kind !== 'StoryDocument' || storyDocument.version !== '4.0') {
    throw new TypeError('asset candidate validation requires a DSL 4.0 StoryDocument');
  }
  if (!isRecord(asset) || typeof asset.id !== 'string' || !Array.isArray(files)) {
    throw new TypeError('asset candidate requires one asset and files array');
  }
  const abortSignal = signal(inputSignal);
  if (abortSignal.aborted) throw abortError();
  const imageLimit = positiveLimit(maxImagePixels, 'maxImagePixels');
  const durationLimit = positiveLimit(maxAudioDurationSeconds, 'maxAudioDurationSeconds');
  const channelLimit = positiveLimit(maxAudioChannels, 'maxAudioChannels');
  const sampleRateLimit = positiveLimit(maxAudioSampleRate, 'maxAudioSampleRate');
  if (
    files.length === 0 ||
    files.some(
      (file) =>
        !isRecord(file) ||
        typeof file.path !== 'string' ||
        file.path.length === 0 ||
        !(file.bytes instanceof Uint8Array),
    )
  ) {
    throw new TypeError('asset candidate files are invalid');
  }

  /** @type {Function[]} */
  const releases = [];
  let released = false;
  /** @param {unknown} decoded */
  function own(decoded) {
    if (isRecord(decoded) && typeof decoded.release === 'function') releases.push(decoded.release);
  }
  async function release() {
    if (released) return;
    released = true;
    const errors = [];
    for (const operation of releases.reverse()) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Asset candidate release failed');
  }

  try {
    if (['backdrop', 'costume', 'image'].includes(String(asset.kind))) {
      if (files.length !== 1 || typeof inspectImage !== 'function') {
        fail('K4-ASSET-DECODE-001', `Image ${asset.id} requires one browser-decodable file`);
      }
      const file = files[0];
      const expectedType = imageExtensions.get(extension(file.path));
      const actualType = imageType(file.bytes);
      if (!expectedType || expectedType !== actualType) {
        fail('K4-ASSET-SIGNATURE-001', `Image ${asset.id} extension and signature do not match`);
      }
      const decoded = decodedMetrics(
        await inspectImage(
          file.bytes,
          Object.freeze({assetId: asset.id, mediaType: actualType, signal: abortSignal}),
        ),
        'image',
      );
      own(decoded);
      if (
        !Number.isSafeInteger(decoded.width) ||
        !Number.isSafeInteger(decoded.height) ||
        decoded.width < 1 ||
        decoded.height < 1 ||
        decoded.width * decoded.height > imageLimit
      ) {
        fail('K4-ASSET-LIMIT-001', `Image ${asset.id} exceeds the pixel limit`);
      }
      if (abortSignal.aborted) throw abortError();
      return Object.freeze({
        summary: deepFreeze({
          assetId: asset.id,
          kind: asset.kind,
          fileCount: 1,
          mediaType: actualType,
          width: decoded.width,
          height: decoded.height,
        }),
        release,
      });
    }

    if (asset.kind === 'sound') {
      if (files.length !== 1 || typeof inspectAudio !== 'function') {
        fail('K4-ASSET-DECODE-001', `Sound ${asset.id} requires one browser-decodable file`);
      }
      const file = files[0];
      const expectedType = audioExtensions.get(extension(file.path));
      const actualType = audioType(file.bytes);
      if (!expectedType || expectedType !== actualType) {
        fail('K4-ASSET-SIGNATURE-001', `Sound ${asset.id} extension and signature do not match`);
      }
      const decoded = decodedMetrics(
        await inspectAudio(
          file.bytes,
          Object.freeze({assetId: asset.id, mediaType: actualType, signal: abortSignal}),
        ),
        'audio',
      );
      own(decoded);
      if (
        typeof decoded.durationSeconds !== 'number' ||
        !Number.isFinite(decoded.durationSeconds) ||
        decoded.durationSeconds < 0 ||
        decoded.durationSeconds > durationLimit ||
        !Number.isSafeInteger(decoded.channels) ||
        decoded.channels < 1 ||
        decoded.channels > channelLimit ||
        !Number.isSafeInteger(decoded.sampleRate) ||
        decoded.sampleRate < 1 ||
        decoded.sampleRate > sampleRateLimit
      ) {
        fail('K4-ASSET-LIMIT-001', `Sound ${asset.id} exceeds an audio limit`);
      }
      if (abortSignal.aborted) throw abortError();
      return Object.freeze({
        summary: deepFreeze({
          assetId: asset.id,
          kind: 'sound',
          fileCount: 1,
          mediaType: actualType,
          durationSeconds: decoded.durationSeconds,
          channels: decoded.channels,
          sampleRate: decoded.sampleRate,
        }),
        release,
      });
    }

    if (asset.kind !== 'poseModel') {
      throw new TypeError(`unsupported asset candidate kind: ${String(asset.kind)}`);
    }
    const byPath = new Map(files.map((file) => [file.path, file.bytes]));
    const weights = files.filter((file) => file.path.endsWith('.bin'));
    if (
      files.length !== 3 ||
      !byPath.has('model.json') ||
      !byPath.has('metadata.json') ||
      weights.length !== 1
    ) {
      fail('K4-ASSET-POSE-BUNDLE-001', `Pose model ${asset.id} bundle is incomplete`);
    }
    const model = parseJson(/** @type {Uint8Array} */ (byPath.get('model.json')), 'model.json');
    const metadata = parseJson(
      /** @type {Uint8Array} */ (byPath.get('metadata.json')),
      'metadata.json',
    );
    if (!isRecord(model) || !Array.isArray(model.weightsManifest) || !isRecord(metadata)) {
      fail('K4-ASSET-POSE-BUNDLE-001', `Pose model ${asset.id} metadata is invalid`);
    }
    const declaredWeights = model.weightsManifest.flatMap((entry) =>
      isRecord(entry) && Array.isArray(entry.paths) ? entry.paths : [],
    );
    const labels = Array.isArray(metadata.labels) ? metadata.labels : null;
    if (
      declaredWeights.length !== 1 ||
      declaredWeights[0] !== weights[0].path ||
      !labels ||
      labels.length === 0 ||
      labels.some((label) => typeof label !== 'string' || label.length === 0) ||
      new Set(labels).size !== labels.length
    ) {
      fail('K4-ASSET-POSE-BUNDLE-001', `Pose model ${asset.id} manifest is inconsistent`);
    }
    const missingLabels = referencedPoseLabels(storyDocument, asset.id).filter(
      (label) => !labels.includes(label),
    );
    if (missingLabels.length > 0) {
      fail('K4-ASSET-POSE-LABEL-001', `Pose model ${asset.id} is missing referenced labels`);
    }
    if (abortSignal.aborted) throw abortError();
    return Object.freeze({
      summary: deepFreeze({
        assetId: asset.id,
        kind: 'poseModel',
        fileCount: 3,
        labelCount: labels.length,
      }),
      release,
    });
  } catch (error) {
    try {
      await release();
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], 'Asset validation and cleanup failed');
    }
    throw error;
  }
}
