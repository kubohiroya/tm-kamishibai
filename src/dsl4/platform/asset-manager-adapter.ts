import {createAssetManagerComposition} from '@kubohiroya/turbowarp-asset-manager/composition';

const supportedKinds = new Set(['backdrop', 'costume', 'image', 'sound']);
const bitmapFilePattern = /\.(?:png|jpe?g|webp)(?:[?#].*)?$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function adapterError(code: string, message: string) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

function abortError() {
  const error = new Error('Asset Manager preparation was cancelled');
  error.name = 'AbortError';
  return error;
}

function requireNonEmptyString(value: unknown, label: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw adapterError('K4-ASSET-ADAPTER-001', `${label} must be a non-empty string`);
  }
  return value;
}

function declaredBitmapResolution(asset: Record<string, unknown>, label: string) {
  if (asset.kind !== 'backdrop' && asset.kind !== 'costume') {
    if (Object.hasOwn(asset, 'bitmapResolution')) {
      throw adapterError(
        'K4-ASSET-ADAPTER-001',
        `${label} bitmapResolution is only valid for backdrop and costume assets`,
      );
    }
    return undefined;
  }
  const value = asset.bitmapResolution ?? 1;
  if (value !== 1 && value !== 2) {
    throw adapterError('K4-ASSET-ADAPTER-001', `${label} bitmapResolution must be 1 or 2`);
  }
  return value as 1 | 2;
}

/**
 * Keep SVG and project assets on their existing registration path. The upstream composition
 * accepts bitmapResolution only for raster MIME types; file-backed assets expose their MIME
 * through the source filename, while verified remote assets provide Content-Type directly.
 */
function embeddedBitmapResolution(
  asset: Record<string, unknown>,
  sourceName: string,
  mimeType: string,
) {
  const resolution = declaredBitmapResolution(asset, `Asset ${String(asset.id)}`);
  if (resolution === undefined) return undefined;
  const mediaType = mimeType.split(';', 1)[0].trim().toLowerCase();
  const isRasterMime = mediaType.startsWith('image/') && mediaType !== 'image/svg+xml';
  const isRasterPath = mediaType.length === 0 && bitmapFilePattern.test(sourceName);
  return isRasterMime || isRasterPath ? resolution : undefined;
}

function projectAssetLocator(
  asset: Record<string, unknown>,
  source: Record<string, unknown>,
  runtime: unknown,
) {
  const name = requireNonEmptyString(source.name, 'project asset name');
  if (asset.kind === 'backdrop') return Object.freeze({kind: 'backdrop', name});
  if (asset.kind === 'sound') return Object.freeze({kind: 'sound', name});
  if (asset.kind === 'image') {
    throw adapterError(
      'K4-ASSET-ADAPTER-002',
      'Target-independent image assets must use embedded or remote delivery',
    );
  }
  const logicalTarget = requireNonEmptyString(asset.target, 'costume target');
  const target = resolveProjectTargetName(runtime, logicalTarget);
  return Object.freeze({kind: 'costume', target, name});
}

function projectSpriteName(target: unknown) {
  if (!isRecord(target) || !isRecord(target.sprite)) return null;
  return typeof target.sprite.name === 'string' && target.sprite.name.length > 0
    ? target.sprite.name
    : null;
}

function actorVariableMatches(target: unknown, actorId: string) {
  if (!isRecord(target) || typeof target.lookupVariableByNameAndType !== 'function') return false;
  const variable = target.lookupVariableByNameAndType('actorName', '');
  return isRecord(variable) && variable.value === actorId;
}

/**
 * Resolve a DSL actor ID to the physical project sprite name used by project assets.
 *
 * The 3.2 base project keeps all story actors on a physical `Actor` sprite and stores the
 * logical actor ID in its `actorName` variable. Asset Manager resolves project costumes by
 * physical sprite name, so passing the logical ID directly produces a missing-source error.
 */
function resolveProjectTargetName(runtime: unknown, logicalTarget: string) {
  if (!isRecord(runtime) || !Array.isArray(runtime.targets)) return logicalTarget;
  const targets = runtime.targets.filter((target) => isRecord(target) && target.isStage !== true);
  if (targets.some((target) => projectSpriteName(target) === logicalTarget)) return logicalTarget;
  const actorMatches = targets.filter((target) => actorVariableMatches(target, logicalTarget));
  const actorTarget =
    actorMatches.find((target) => target.isOriginal === true) ?? actorMatches[0] ?? null;
  const resolvedName = projectSpriteName(actorTarget);
  if (resolvedName !== null) return resolvedName;
  const templateNames = new Set(
    targets
      .filter((target) => actorVariableMatches(target, '_template_'))
      .map(projectSpriteName)
      .filter((name) => name !== null),
  );
  return templateNames.size === 1 ? [...templateNames][0] : logicalTarget;
}

function projectAssetReadiness(locator: Record<string, unknown>, runtime: unknown) {
  if (!isRecord(runtime) || !Array.isArray(runtime.targets)) return 'unknown';
  let target = null;
  if (locator.kind === 'backdrop' || !Object.hasOwn(locator, 'target')) {
    target = runtime.targets.find((candidate) => isRecord(candidate) && candidate.isStage === true);
  } else {
    target = runtime.targets.find(
      (candidate) => isRecord(candidate) && projectSpriteName(candidate) === locator.target,
    );
  }
  if (!isRecord(target) || !isRecord(target.sprite)) return 'unknown';
  const collection = locator.kind === 'sound' ? target.sprite.sounds : target.sprite.costumes;
  if (!Array.isArray(collection)) return 'unknown';
  const source = collection.find(
    (candidate) => isRecord(candidate) && candidate.name === locator.name,
  );
  if (!source) return 'missing';
  if (locator.kind === 'sound') return source.soundId ? 'ready' : 'pending';
  return typeof source.skinId === 'number' ? 'ready' : 'pending';
}

async function waitForProjectAsset(
  locator: Record<string, unknown>,
  runtime: unknown,
  signal: AbortSignal | null,
) {
  const timeoutMilliseconds = 15_000;
  const pollMilliseconds = 50;
  const deadline = Date.now() + timeoutMilliseconds;
  while (true) {
    if (signal?.aborted) throw abortError();
    const readiness = projectAssetReadiness(locator, runtime);
    if (readiness !== 'pending' || Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, pollMilliseconds));
  }
}

function validateComposition(value: unknown) {
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
  return value as Record<
    'registerProjectAsset' | 'registerEmbeddedAsset' | 'releaseAsset',
    (...parameters: any[]) => any
  >;
}

function validateSignal(value: unknown) {
  if (value === undefined) return null;
  if (
    !isRecord(value) ||
    typeof value.aborted !== 'boolean' ||
    typeof value.addEventListener !== 'function' ||
    typeof value.removeEventListener !== 'function'
  ) {
    throw adapterError('K4-ASSET-ADAPTER-001', 'asset preparation signal is invalid');
  }
  return value as unknown as AbortSignal;
}

/**
 * Adapt validated DSL 4.0 image/audio materialization to one private Asset Manager composition.
 * This module is intentionally outside the core DSL 4.0 index. The app shell imports it only
 * after the startup-fixed DSL 4.0 flag has been enabled.
 */
export function createDsl4AssetManagerAdapter(
  options: {
    composition?: unknown;
    createComposition?: () => unknown;
    runtime?: unknown;
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
  } = {},
) {
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
      ((options.createComposition ?? createAssetManagerComposition) as () => unknown)(),
  );
  const ownedResources = new WeakSet();
  const releasedResources = new WeakSet();
  let createObjectURL: ((blob: Blob) => string) | undefined;
  let revokeObjectURL: ((url: string) => void) | undefined;
  if (hasInjectedObjectUrlOwner) {
    createObjectURL = options.createObjectURL as (blob: Blob) => string;
    revokeObjectURL = options.revokeObjectURL as (url: string) => void;
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
     */
    async prepare(payload: unknown, context: unknown = {}) {
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
      declaredBitmapResolution(asset, `Asset ${assetId}`);
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

      let projectRegistration: Readonly<Record<string, unknown>> | null = null;
      let embeddedRegistration: Readonly<Record<string, unknown>> | null = null;
      let imageBytes: Uint8Array | null = null;
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
          locator: projectAssetLocator(asset, source, options.runtime),
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
        const bitmapResolution = embeddedBitmapResolution(
          asset,
          sourceName,
          source.type === 'remote' ? String(file.contentType ?? '') : '',
        );
        embeddedRegistration = Object.freeze({
          name: assetId,
          nameMode: 'literal',
          sourceName,
          mimeType:
            source.type === 'remote'
              ? requireNonEmptyString(file.contentType, 'remote asset Content-Type')
              : '',
          bytes: file.bytes,
          ...(bitmapResolution === undefined ? {} : {bitmapResolution}),
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
        if (projectRegistration) {
          const locator = projectRegistration.locator as Record<string, unknown>;
          if (projectAssetReadiness(locator, options.runtime) === 'pending') {
            await waitForProjectAsset(locator, options.runtime, signal);
          }
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
          const currentImageBytes = imageBytes as Uint8Array;
          const createImageObjectUrl = createObjectURL as (blob: Blob) => string;
          const revokeImageObjectUrl = revokeObjectURL as (url: string) => void;
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

    release(resource: unknown) {
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
        (revokeObjectURL as (url: string) => void)(resource.objectUrl);
      }
      if (releaseError) throw releaseError;
    },
  });
}
