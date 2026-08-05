import {createAssetManagerComposition} from '@kubohiroya/turbowarp-asset-manager/composition';

const supportedKinds = new Set(['backdrop', 'costume', 'sound']);

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
  const error = new Error('Asset Manager preparation was cancelled');
  error.name = 'AbortError';
  return error;
}

/** @param {unknown} value @param {string} label */
function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw adapterError('K4-ASSET-ADAPTER-001', `${label} must be a non-empty string`);
  }
  return value;
}

/** @param {Record<string, unknown>} asset @param {Record<string, unknown>} source */
function projectResourceId(asset, source) {
  const name = requireNonEmptyString(source.name, 'project asset name');
  if (asset.kind === 'backdrop') return `backdrop:${name}`;
  if (asset.kind === 'sound') return `sound:@stage:${name}`;
  const target = requireNonEmptyString(asset.target, 'costume target');
  return `costume:${target}:${name}`;
}

/** @param {unknown} value */
function validateComposition(value) {
  if (
    !isRecord(value) ||
    typeof value.registerProjectAsset !== 'function' ||
    typeof value.registerEmbeddedAsset !== 'function' ||
    typeof value.releaseAsset !== 'function'
  ) {
    throw new TypeError(
      'Asset Manager composition must provide registerProjectAsset, registerEmbeddedAsset, and releaseAsset',
    );
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
    throw adapterError('K4-ASSET-ADAPTER-001', 'asset preparation signal is invalid');
  }
  return /** @type {AbortSignal} */ (/** @type {unknown} */ (value));
}

/**
 * Adapt validated DSL 4.0 image/audio materialization to one private Asset Manager composition.
 *
 * This module is intentionally outside the core DSL 4.0 index. The app shell imports it only
 * after the startup-fixed DSL 4.0 flag has been enabled.
 *
 * @param {object} [options]
 * @param {unknown} [options.composition]
 * @param {() => unknown} [options.createComposition]
 */
export function createDsl4AssetManagerAdapter(options = {}) {
  if (!isRecord(options)) throw new TypeError('asset manager adapter options must be an object');
  if (options.composition !== undefined && options.createComposition !== undefined) {
    throw new TypeError('Provide either composition or createComposition, not both');
  }
  if (options.createComposition !== undefined && typeof options.createComposition !== 'function') {
    throw new TypeError('createComposition must be a function');
  }
  const composition = validateComposition(
    options.composition ??
      /** @type {() => unknown} */ (options.createComposition ?? createAssetManagerComposition)(),
  );
  const ownedResources = new WeakSet();
  const releasedResources = new WeakSet();

  return Object.freeze({
    /**
     * @param {unknown} payload
     * @param {unknown} [context]
     */
    async prepare(payload, context = {}) {
      if (!isRecord(payload) || !isRecord(payload.asset) || !Array.isArray(payload.files)) {
        throw adapterError(
          'K4-ASSET-ADAPTER-001',
          'asset manager payload must provide an asset record and files array',
        );
      }
      if (!isRecord(context)) {
        throw adapterError('K4-ASSET-ADAPTER-001', 'asset preparation context must be an object');
      }
      const asset = payload.asset;
      const assetId = requireNonEmptyString(asset.id, 'asset id');
      const assetKind = requireNonEmptyString(asset.kind, 'asset kind');
      if (!supportedKinds.has(assetKind)) {
        throw adapterError(
          'K4-ASSET-ADAPTER-002',
          `Asset Manager does not support DSL 4.0 asset kind: ${assetKind}`,
        );
      }
      if (!isRecord(asset.source)) {
        throw adapterError('K4-ASSET-ADAPTER-001', `Asset ${assetId} source is invalid`);
      }
      const source = asset.source;
      const signal = validateSignal(context.signal);
      if (signal?.aborted) throw abortError();

      /** @type {Readonly<Record<string, string>> | null} */
      let projectRegistration = null;
      /** @type {Readonly<Record<string, unknown>> | null} */
      let embeddedRegistration = null;
      if (source.type === 'project') {
        if (payload.files.length !== 0) {
          throw adapterError(
            'K4-ASSET-ADAPTER-001',
            `Project asset ${assetId} must not provide embedded files`,
          );
        }
        projectRegistration = Object.freeze({
          name: assetId,
          resourceId: projectResourceId(asset, source),
        });
      } else if (source.type === 'file' || source.type === 'remote') {
        if (payload.files.length !== 1 || !isRecord(payload.files[0])) {
          throw adapterError(
            'K4-ASSET-ADAPTER-003',
            `Materialized ${assetKind} asset ${assetId} must contain exactly one file`,
          );
        }
        const file = payload.files[0];
        const sourceName = requireNonEmptyString(file.path, 'materialized asset source');
        if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength === 0) {
          throw adapterError(
            'K4-ASSET-ADAPTER-001',
            `Embedded asset ${assetId} bytes must be a non-empty Uint8Array`,
          );
        }
        embeddedRegistration = Object.freeze({
          name: assetId,
          sourceName,
          mimeType:
            source.type === 'remote'
              ? requireNonEmptyString(file.contentType, 'remote asset Content-Type')
              : '',
          bytes: file.bytes,
        });
      } else {
        throw adapterError('K4-ASSET-ADAPTER-001', `Asset ${assetId} source type is unsupported`);
      }

      let cancelled = false;
      const cancelRegistration = () => {
        if (cancelled) return;
        cancelled = true;
        composition.releaseAsset(assetId);
      };
      signal?.addEventListener('abort', cancelRegistration, {once: true});
      try {
        if (signal?.aborted) {
          cancelRegistration();
          throw abortError();
        }
        const registration = await (projectRegistration
          ? composition.registerProjectAsset(projectRegistration)
          : composition.registerEmbeddedAsset(embeddedRegistration));
        if (signal?.aborted) {
          cancelRegistration();
          throw abortError();
        }
        if (
          !isRecord(registration) ||
          registration.name !== assetId ||
          typeof registration.mimeType !== 'string' ||
          registration.mimeType.length === 0
        ) {
          cancelRegistration();
          throw adapterError(
            'K4-ASSET-ADAPTER-004',
            `Asset Manager returned an invalid registration for ${assetId}`,
          );
        }
        const resource = Object.freeze({
          adapter: 'asset-manager',
          assetId,
          kind: assetKind,
          name: registration.name,
          mimeType: registration.mimeType,
        });
        ownedResources.add(resource);
        return resource;
      } finally {
        signal?.removeEventListener('abort', cancelRegistration);
      }
    },

    /** @param {unknown} resource */
    release(resource) {
      if (!isRecord(resource) || !ownedResources.has(resource)) {
        throw adapterError(
          'K4-ASSET-ADAPTER-005',
          'Asset Manager resource is not owned by this adapter',
        );
      }
      if (releasedResources.has(resource)) return;
      releasedResources.add(resource);
      composition.releaseAsset(resource.name);
    },
  });
}
