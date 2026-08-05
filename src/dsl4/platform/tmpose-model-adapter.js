import {createTMPoseComposition} from '@kubohiroya/turbowarp-tmpose/composition';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} code @param {string} message */
function adapterError(code, message) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

function abortError() {
  const error = new Error('TMPose model preparation was cancelled');
  error.name = 'AbortError';
  return error;
}

/** @param {unknown} value @param {string} label */
function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw adapterError('K4-TMPOSE-ADAPTER-001', `${label} must be a non-empty string`);
  }
  return value;
}

/** @param {unknown} value */
function validateComposition(value) {
  if (
    !isRecord(value) ||
    typeof value.registerPoseModel !== 'function' ||
    typeof value.releasePoseModel !== 'function'
  ) {
    throw new TypeError('TMPose composition must provide registerPoseModel and releasePoseModel');
  }
  return /** @type {Record<string, Function>} */ (value);
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
    throw adapterError('K4-TMPOSE-ADAPTER-001', 'pose model preparation signal is invalid');
  }
  return /** @type {AbortSignal} */ (/** @type {unknown} */ (value));
}

/** @param {unknown[]} files @param {string} assetId */
function validateFiles(files, assetId) {
  if (files.length !== 3) {
    throw adapterError(
      'K4-TMPOSE-ADAPTER-002',
      `Pose model ${assetId} must contain exactly three files`,
    );
  }
  const paths = new Set();
  let weights = 0;
  for (const candidate of files) {
    if (
      !isRecord(candidate) ||
      typeof candidate.path !== 'string' ||
      candidate.path.length === 0 ||
      candidate.path.includes('/') ||
      candidate.path.includes('\\') ||
      paths.has(candidate.path) ||
      !(candidate.bytes instanceof Uint8Array) ||
      candidate.bytes.byteLength === 0
    ) {
      throw adapterError('K4-TMPOSE-ADAPTER-002', `Pose model ${assetId} files are invalid`);
    }
    paths.add(candidate.path);
    if (candidate.path.endsWith('.bin')) weights += 1;
  }
  if (!paths.has('model.json') || !paths.has('metadata.json') || weights !== 1) {
    throw adapterError(
      'K4-TMPOSE-ADAPTER-002',
      `Pose model ${assetId} requires model.json, metadata.json, and one weights file`,
    );
  }
}

/**
 * Adapt a validated DSL 4.0 poseModel materialization to one TMPose composition.
 *
 * @param {object} options
 * @param {unknown} options.composition
 */
export function createDsl4TMPoseModelAdapter(options) {
  if (!isRecord(options)) throw new TypeError('TMPose adapter options must be an object');
  const composition = validateComposition(options.composition);
  const ownedResources = new WeakSet();
  const releasedResources = new WeakSet();

  return Object.freeze({
    /** @param {unknown} payload @param {unknown} [context] */
    async prepare(payload, context = {}) {
      if (!isRecord(payload) || !isRecord(payload.asset) || !Array.isArray(payload.files)) {
        throw adapterError(
          'K4-TMPOSE-ADAPTER-001',
          'TMPose payload must provide an asset record and files array',
        );
      }
      if (!isRecord(context)) {
        throw adapterError('K4-TMPOSE-ADAPTER-001', 'pose model context must be an object');
      }
      const asset = payload.asset;
      const assetId = requireNonEmptyString(asset.id, 'pose model asset id');
      if (asset.kind !== 'poseModel') {
        throw adapterError(
          'K4-TMPOSE-ADAPTER-003',
          `TMPose adapter does not support asset kind: ${String(asset.kind)}`,
        );
      }
      if (!isRecord(asset.source) || asset.source.type !== 'file') {
        throw adapterError(
          'K4-TMPOSE-ADAPTER-001',
          `Pose model ${assetId} must use an embedded file source`,
        );
      }
      validateFiles(payload.files, assetId);
      const signal = validateSignal(context.signal);
      if (signal?.aborted) throw abortError();

      let cancelled = false;
      let cancellation = Promise.resolve();
      const cancelRegistration = () => {
        if (cancelled) return;
        cancelled = true;
        cancellation = Promise.resolve(composition.releasePoseModel(assetId));
      };
      signal?.addEventListener('abort', cancelRegistration, {once: true});
      try {
        if (signal?.aborted) {
          cancelRegistration();
          await cancellation;
          throw abortError();
        }
        const registration = await composition.registerPoseModel({
          name: assetId,
          files: payload.files.map((file) => ({
            path: /** @type {Record<string, unknown>} */ (file).path,
            bytes: /** @type {Record<string, unknown>} */ (file).bytes,
          })),
        });
        if (signal?.aborted) {
          cancelRegistration();
          await cancellation;
          throw abortError();
        }
        if (
          !isRecord(registration) ||
          registration.name !== assetId ||
          !Array.isArray(registration.labels) ||
          registration.labels.some((label) => typeof label !== 'string')
        ) {
          cancelRegistration();
          await cancellation;
          throw adapterError(
            'K4-TMPOSE-ADAPTER-004',
            `TMPose returned an invalid registration for ${assetId}`,
          );
        }
        const resource = Object.freeze({
          adapter: 'tmpose',
          assetId,
          kind: 'poseModel',
          name: registration.name,
          labels: Object.freeze([...registration.labels]),
        });
        ownedResources.add(resource);
        return resource;
      } finally {
        signal?.removeEventListener('abort', cancelRegistration);
      }
    },

    /** @param {unknown} resource */
    async release(resource) {
      if (!isRecord(resource) || !ownedResources.has(resource)) {
        throw adapterError('K4-TMPOSE-ADAPTER-005', 'TMPose resource is not owned by this adapter');
      }
      if (releasedResources.has(resource)) return;
      releasedResources.add(resource);
      await composition.releasePoseModel(resource.name);
    },
  });
}

/**
 * Create a TMPose composition and adapter pair for one app-shell runtime instance.
 *
 * @param {object} options
 * @param {unknown} options.runtime
 * @param {Function} [options.createFile]
 * @param {Function} [options.createComposition]
 */
export function createDsl4TMPosePlatform(options) {
  if (!isRecord(options)) throw new TypeError('TMPose platform options must be an object');
  const createComposition = options.createComposition ?? createTMPoseComposition;
  if (typeof createComposition !== 'function') {
    throw new TypeError('createComposition must be a function');
  }
  const composition = createComposition({
    runtime: options.runtime,
    ...(options.createFile === undefined ? {} : {createFile: options.createFile}),
  });
  return Object.freeze({
    composition,
    adapter: createDsl4TMPoseModelAdapter({composition}),
  });
}
