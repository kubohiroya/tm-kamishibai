import {createAssetManagerComposition} from '@kubohiroya/turbowarp-asset-manager/composition';

const supportedKinds = new Set(['backdrop', 'costume', 'image', 'sound']);

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
function projectAssetLocator(asset, source) {
  const name = requireNonEmptyString(source.name, 'project asset name');
  if (asset.kind === 'backdrop') return Object.freeze({kind: 'backdrop', name});
  if (asset.kind === 'sound') return Object.freeze({kind: 'sound', name});
  if (asset.kind === 'image') {
    throw adapterError(
      'K4-ASSET-ADAPTER-002',
      'Target-independent image assets must use embedded or remote delivery',
    );
  }
  const target = requireNonEmptyString(asset.target, 'costume target');
  return Object.freeze({kind: 'costume', target, name});
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
 * @param {(blob: Blob) => string} [options.createObjectURL]
 * @param {(url: string) => void} [options.revokeObjectURL]
 */
export function createDsl4AssetManagerAdapter(options = {}) {
  if (!isRecord(options)) throw new TypeError('asset manager adapter options must be an object');
  if (options.composition !== undefined && options.createComposition !== undefined) {
    throw new TypeError('Provide either composition or createComposition, not both');
  }
  if (options.createComposition !== undefined && typeof options.createComposition !== 'function') {
    throw new TypeError('createComposition must be a function');
  }
  if (options.createObjectURL !== undefined && typeof options.createObjectURL !== 'function') {
    throw new TypeError('createObjectURL must be a function');
  }
  if (options.revokeObjectURL !== undefined && typeof options.revokeObjectURL !== 'function') {
    throw new TypeError('revokeObjectURL must be a function');
  }
  const hasInjectedObjectUrlOwner = options.createObjectURL !== undefined;
  if (hasInjectedObjectUrlOwner !== (options.revokeObjectURL !== undefined)) {
    throw new TypeError('createObjectURL and revokeObjectURL must be provided together');
  }
  const composition = validateComposition(
    options.composition ??
      /** @type {() => unknown} */ (options.createComposition ?? createAssetManagerComposition)(),
  );
  const ownedResources = new WeakSet();
  const releasedResources = new WeakSet();
  /** @type {((blob: Blob) => string) | undefined} */
  let createObjectURL;
  /** @type {((url: string) => void) | undefined} */
  let revokeObjectURL;
  if (hasInjectedObjectUrlOwner) {
    createObjectURL = /** @type {(blob: Blob) => string} */ (options.createObjectURL);
    revokeObjectURL = /** @type {(url: string) => void} */ (options.revokeObjectURL);
  } else {
    const urlOwner = globalThis.URL;
    if (
      typeof urlOwner?.createObjectURL === 'function' &&
      typeof urlOwner?.revokeObjectURL === 'function'
    ) {
      createObjectURL = urlOwner.createObjectURL.bind(urlOwner);
      revokeObjectURL = urlOwner.revokeObjectURL.bind(urlOwner);
    }
  }

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

      /** @type {Readonly<Record<string, unknown>> | null} */
      let projectRegistration = null;
      /** @type {Readonly<Record<string, unknown>> | null} */
      let embeddedRegistration = null;
      /** @type {Uint8Array | null} */
      let imageBytes = null;
      if (source.type === 'project') {
        if (payload.files.length !== 0) {
          throw adapterError(
            'K4-ASSET-ADAPTER-001',
            `Project asset ${assetId} must not provide embedded files`,
          );
        }
        projectRegistration = Object.freeze({
          name: assetId,
          nameMode: 'literal',
          locator: projectAssetLocator(asset, source),
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
          nameMode: 'literal',
          sourceName,
          mimeType:
            source.type === 'remote'
              ? requireNonEmptyString(file.contentType, 'remote asset Content-Type')
              : '',
          bytes: file.bytes,
        });
        if (assetKind === 'image') imageBytes = new Uint8Array(file.bytes);
      } else {
        throw adapterError('K4-ASSET-ADAPTER-001', `Asset ${assetId} source type is unsupported`);
      }
      if (
        assetKind === 'image' &&
        (!imageBytes ||
          typeof createObjectURL !== 'function' ||
          typeof revokeObjectURL !== 'function')
      ) {
        throw adapterError(
          'K4-ASSET-ADAPTER-006',
          'Target-independent image assets require Object URL support',
        );
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
        if (assetKind === 'image' && !registration.mimeType.startsWith('image/')) {
          cancelRegistration();
          throw adapterError(
            'K4-ASSET-ADAPTER-004',
            `Target-independent image asset has a non-image MIME type: ${assetId}`,
          );
        }
        let objectUrl;
        if (assetKind === 'image') {
          const currentImageBytes = /** @type {Uint8Array} */ (imageBytes);
          const createImageObjectUrl = /** @type {(blob: Blob) => string} */ (createObjectURL);
          const revokeImageObjectUrl = /** @type {(url: string) => void} */ (revokeObjectURL);
          const imageBuffer = new ArrayBuffer(currentImageBytes.byteLength);
          new Uint8Array(imageBuffer).set(currentImageBytes);
          try {
            objectUrl = createImageObjectUrl(
              new Blob([imageBuffer], {type: registration.mimeType}),
            );
          } catch {
            cancelRegistration();
            throw adapterError('K4-ASSET-ADAPTER-006', 'Object URL creation failed');
          }
          if (typeof objectUrl !== 'string' || objectUrl.length === 0) {
            cancelRegistration();
            throw adapterError('K4-ASSET-ADAPTER-006', 'Object URL creation returned no URL');
          }
          if (signal?.aborted) {
            cancelRegistration();
            revokeImageObjectUrl(objectUrl);
            throw abortError();
          }
        }
        const resource = Object.freeze({
          adapter: 'asset-manager',
          assetId,
          kind: assetKind,
          name: registration.name,
          mimeType: registration.mimeType,
          ...(objectUrl ? {objectUrl} : {}),
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
      let releaseError;
      try {
        composition.releaseAsset(resource.name);
      } catch (error) {
        releaseError = error;
      }
      if (typeof resource.objectUrl === 'string') {
        /** @type {(url: string) => void} */ (revokeObjectURL)(resource.objectUrl);
      }
      if (releaseError) throw releaseError;
    },
  });
}
