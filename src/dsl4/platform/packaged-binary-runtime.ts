import {
  claimDsl4PackagerEntrySource,
  createDsl4BinaryEntryProviderFromPackagerSource,
} from '../packager-entry-source.js';
import {dsl4BinaryEntryFormatVersion} from '../binary-entry-provider.js';
import {loadDsl4BinaryEntryRuntimeComponent} from '../runtime-artifact-loader.js';
import {deepFreeze} from '../story-document.js';
import type {Dsl4SubtleCrypto} from '../subtle-crypto.js';

const archiveSurfaces = new Set(['plain-html', 'zip-one-asset']);
const directSurfaces = new Set(['zip', 'electron']);

export const dsl4PackagedBinaryRuntimeMaximums = deepFreeze({
  maxArchiveBytes: 1024 * 1024 * 1024,
  maxArchiveEntries: 16_384,
  maxArchiveEntryBytes: 512 * 1024 * 1024,
  maxArchiveExpandedBytes: 1024 * 1024 * 1024,
  maxAssetFiles: 4096,
  maxAssetFileBytes: 512 * 1024 * 1024,
  maxAssetBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
});

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

function storedAssetDescriptors(project: unknown) {
  if (!isRecord(project)) return [];
  const extensionStorage = isRecord(project.extensionStorage) ? project.extensionStorage : {};
  const unbundled = isRecord(extensionStorage.kubohiroyakamishibairuntime4)
    ? extensionStorage.kubohiroyakamishibairuntime4
    : {};
  const bundled = isRecord(extensionStorage.kubohiroyakamishibai4)
    ? extensionStorage.kubohiroyakamishibai4
    : {};
  const components = isRecord(bundled.components) ? bundled.components : {};
  const bundledRuntime = isRecord(components.kubohiroyakamishibairuntime4)
    ? components.kubohiroyakamishibairuntime4
    : {};
  return [unbundled.assets, bundledRuntime.assets].filter((value) => value !== undefined);
}

/**
 * Return the root binary-entry descriptor without interpreting Base64 or legacy nested formats.
 * Full channel and descriptor validation remains authoritative in the shared runtime loader.
 */
export function inspectDsl4PackagedBinaryRuntime(project: unknown) {
  const descriptors = storedAssetDescriptors(project);
  const descriptor = descriptors.find(
    (candidate) => isRecord(candidate) && candidate.formatVersion === dsl4BinaryEntryFormatVersion,
  );
  return descriptor ? deepFreeze({formatVersion: descriptor.formatVersion}) : null;
}

export function resolveDsl4PackagerSessionPolicy(surface: string) {
  if (archiveSurfaces.has(surface)) {
    return deepFreeze({policy: 'prefer', sessionBackingEnabled: true});
  }
  if (directSurfaces.has(surface)) {
    return deepFreeze({policy: 'disabled', sessionBackingEnabled: false});
  }
  throw new TypeError(`Unsupported DSL 4.0 Packager source surface: ${surface}`);
}

/**
 * A successful build has already enforced the author-selected CLI limits. At runtime, raise the
 * normal release defaults only as far as the signed descriptor requires, while retaining a fixed
 * browser safety ceiling.
 */
function resolveAssetLimits(
  descriptor: Record<string, any>,
  defaults: Readonly<{maxAssetFiles: number; maxAssetBytes: number}>,
) {
  const defaultFiles = positiveSafeInteger(defaults.maxAssetFiles, 'maxAssetFiles');
  const defaultBytes = positiveSafeInteger(defaults.maxAssetBytes, 'maxAssetBytes');
  const files = Array.isArray(descriptor.files) ? descriptor.files : [];
  let declaredBytes = 0;
  let declaredFileBytes = 0;
  for (const file of files) {
    if (!isRecord(file) || !Number.isSafeInteger(file.size) || Number(file.size) < 0) continue;
    declaredBytes += Number(file.size);
    declaredFileBytes = Math.max(declaredFileBytes, Number(file.size));
  }
  return deepFreeze({
    maxAssetFiles: Math.min(
      Math.max(defaultFiles, files.length),
      dsl4PackagedBinaryRuntimeMaximums.maxAssetFiles,
    ),
    maxAssetFileBytes: Math.min(
      Math.max(defaultBytes, declaredFileBytes),
      dsl4PackagedBinaryRuntimeMaximums.maxAssetFileBytes,
    ),
    maxAssetBytes: Math.min(
      Math.max(defaultBytes, declaredBytes),
      dsl4PackagedBinaryRuntimeMaximums.maxAssetBytes,
    ),
  });
}

function diagnosticError(diagnostic: Readonly<Record<string, any>>) {
  const error = new Error(
    String(diagnostic?.message ?? 'The packaged DSL 4.0 binary component is invalid.'),
  );
  if (typeof diagnostic?.code === 'string') {
    Object.defineProperty(error, 'code', {value: diagnostic.code});
  }
  return error;
}

/**
 * Claim the source installed by the pinned Packager adapter and create the runtime-owned provider.
 * Returns null for the Base64 rollback format. On success, ownership moves to the returned provider.
 */
export async function createDsl4PackagedBinaryRuntimeBridge(options: {
  project: unknown;
  sourceFrontend: {
    parse(source: string, options?: {sourceId?: string}): Readonly<Record<string, any>>;
  };
  maxSourceBytes: number;
  maxAssetFiles: number;
  maxAssetBytes: number;
  globalObject?: Record<PropertyKey, any>;
  subtleCrypto?: Dsl4SubtleCrypto | undefined;
}) {
  if (!isRecord(options)) throw new TypeError('Packaged binary runtime options are required');
  const descriptors = storedAssetDescriptors(options.project);
  const descriptor = descriptors.find(
    (candidate) => isRecord(candidate) && candidate.formatVersion === dsl4BinaryEntryFormatVersion,
  );
  if (!descriptor) return null;
  const assetLimits = resolveAssetLimits(descriptor, options);
  const component = await loadDsl4BinaryEntryRuntimeComponent(
    options.project,
    options.sourceFrontend,
    {
      maxSourceBytes: positiveSafeInteger(options.maxSourceBytes, 'maxSourceBytes'),
      ...assetLimits,
      subtleCrypto: options.subtleCrypto,
    },
  );
  if (!component.ok) throw diagnosticError(component.diagnostics[0]);
  const loaded = component as unknown as Readonly<{
    storyDocument: Readonly<Record<string, unknown>>;
  }>;

  const source = claimDsl4PackagerEntrySource({
    globalObject: options.globalObject ?? globalThis,
  });
  const policy = resolveDsl4PackagerSessionPolicy(source.surface);
  const provider = await createDsl4BinaryEntryProviderFromPackagerSource(
    loaded.storyDocument,
    descriptor,
    source,
    {
      ...dsl4PackagedBinaryRuntimeMaximums,
      ...assetLimits,
      subtleCrypto: options.subtleCrypto,
    },
  );
  return Object.freeze({
    assetBundleFormat: 'binary-entry',
    binaryEntryProvider: provider,
    runtimeLimits: assetLimits,
    sessionBacking: Object.freeze({policy: policy.policy}),
    sessionBackingEnabled: policy.sessionBackingEnabled,
    surface: source.surface,
  });
}
