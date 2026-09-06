import {createTMComposition} from '@kubohiroya/turbowarp-tm/composition';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function adapterError(code: string, message: string) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

function abortError() {
  const error = new Error('TM model preparation was cancelled');
  error.name = 'AbortError';
  return error;
}

function requireNonEmptyString(value: unknown, label: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw adapterError('K4-TM-ADAPTER-001', `${label} must be a non-empty string`);
  }
  return value;
}

function validateComposition(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.registerPoseModel !== 'function' ||
    typeof value.releasePoseModel !== 'function'
  ) {
    throw new TypeError('TM composition must provide registerPoseModel and releasePoseModel');
  }
  return value as Record<'registerPoseModel' | 'releasePoseModel', (...parameters: any[]) => any>;
}

function validateSignal(value: unknown) {
  if (value === undefined) return null;
  if (
    !isRecord(value) ||
    typeof value.aborted !== 'boolean' ||
    typeof value.addEventListener !== 'function' ||
    typeof value.removeEventListener !== 'function'
  ) {
    throw adapterError('K4-TM-ADAPTER-001', 'pose model preparation signal is invalid');
  }
  return value as unknown as AbortSignal;
}

function validateFiles(files: unknown[], assetId: string) {
  if (files.length !== 3) {
    throw adapterError(
      'K4-TM-ADAPTER-002',
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
      throw adapterError('K4-TM-ADAPTER-002', `Pose model ${assetId} files are invalid`);
    }
    paths.add(candidate.path);
    if (candidate.path.endsWith('.bin')) weights += 1;
  }
  if (!paths.has('model.json') || !paths.has('metadata.json') || weights !== 1) {
    throw adapterError(
      'K4-TM-ADAPTER-002',
      `Pose model ${assetId} requires model.json, metadata.json, and one weights file`,
    );
  }
}

/** Adapt a validated DSL 4.0 recognitionModel materialization to one TM composition. */
export function createDsl4TMModelAdapter(options: {composition: unknown}) {
  if (!isRecord(options)) throw new TypeError('TM adapter options must be an object');
  const composition = validateComposition(options.composition);
  const ownedResources = new WeakSet();
  const releasedResources = new WeakSet();
  const activeResources = new Map();

  const adapter = {
    async prepare(payload: unknown, context: unknown = {}) {
      if (!isRecord(payload) || !isRecord(payload.asset) || !Array.isArray(payload.files)) {
        throw adapterError(
          'K4-TM-ADAPTER-001',
          'TM payload must provide an asset record and files array',
        );
      }
      if (!isRecord(context)) {
        throw adapterError('K4-TM-ADAPTER-001', 'pose model context must be an object');
      }
      const asset = payload.asset;
      const assetId = requireNonEmptyString(asset.id, 'recognition model asset id');
      if (asset.kind !== 'recognitionModel') {
        throw adapterError(
          'K4-TM-ADAPTER-003',
          `TM adapter does not support asset kind: ${String(asset.kind)}`,
        );
      }
      if (
        !isRecord(asset.source) ||
        (asset.source.type !== 'file' && asset.source.type !== 'remote')
      ) {
        throw adapterError(
          'K4-TM-ADAPTER-001',
          `Recognition model ${assetId} must use a materialized file source`,
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
        const registration = await composition.registerPoseModel(
          {
            name: assetId,
            files: payload.files.map((file) => ({
              path: (file as Record<string, unknown>).path,
              bytes: (file as Record<string, unknown>).bytes,
            })),
          },
          signal ? {signal} : undefined,
        );
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
            'K4-TM-ADAPTER-004',
            `TM returned an invalid registration for ${assetId}`,
          );
        }
        const resource = Object.freeze({
          adapter: 'tm',
          assetId,
          kind: asset.kind,
          name: registration.name,
          labels: Object.freeze([...registration.labels]),
        });
        ownedResources.add(resource);
        activeResources.set(assetId, resource);
        return resource;
      } finally {
        signal?.removeEventListener('abort', cancelRegistration);
      }
    },

    async release(resource: unknown) {
      if (!isRecord(resource) || !ownedResources.has(resource)) {
        throw adapterError('K4-TM-ADAPTER-005', 'TM resource is not owned by this adapter');
      }
      if (releasedResources.has(resource)) return;
      releasedResources.add(resource);
      if (activeResources.get(resource.name) === resource) activeResources.delete(resource.name);
      await composition.releasePoseModel(resource.name);
    },

    getPoseModelLabels(poseModel: unknown) {
      if (typeof poseModel !== 'string' || poseModel.length === 0) return null;
      const resource = activeResources.get(poseModel);
      return resource ? resource.labels : null;
    },
  };
  return Object.freeze(adapter);
}

/** Create a TM composition and adapter pair for one app-shell runtime instance. */
export function createDsl4TMPlatform(options: {
  runtime: unknown;
  createFile?: Function;
  createComposition?: Function;
  modelInitializationPolicy?: 'legacy' | 'latest-needed';
  parallelModelInitialization?: boolean;
}) {
  if (!isRecord(options)) throw new TypeError('TM platform options must be an object');
  const createComposition = options.createComposition ?? createTMComposition;
  if (typeof createComposition !== 'function') {
    throw new TypeError('createComposition must be a function');
  }
  if (
    options.modelInitializationPolicy !== undefined &&
    options.modelInitializationPolicy !== 'legacy' &&
    options.modelInitializationPolicy !== 'latest-needed'
  ) {
    throw new TypeError('modelInitializationPolicy must be legacy or latest-needed');
  }
  if (
    options.parallelModelInitialization !== undefined &&
    typeof options.parallelModelInitialization !== 'boolean'
  ) {
    throw new TypeError('parallelModelInitialization must be a boolean');
  }
  const composition = createComposition({
    runtime: options.runtime,
    ...(options.createFile === undefined ? {} : {createFile: options.createFile}),
    ...(options.modelInitializationPolicy === undefined
      ? {}
      : {modelInitializationPolicy: options.modelInitializationPolicy}),
    ...(options.parallelModelInitialization === undefined
      ? {}
      : {parallelModelInitialization: options.parallelModelInitialization}),
  });
  return Object.freeze({
    composition,
    adapter: createDsl4TMModelAdapter({composition}),
  });
}
