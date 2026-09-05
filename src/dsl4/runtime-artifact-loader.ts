import {
  dsl4AssetBundleStoragePaths,
  Dsl4AssetBundleError,
  validateDsl4EmbeddedAssetBundle,
} from './asset-bundle-descriptor.js';
import {Dsl4BinaryEntryError, validateDsl4BinaryEntryAssetBundle} from './binary-entry-provider.js';
import {validateDsl4AssetDistributionResolution} from './asset-distribution-profile.js';
import {validateDsl4RuntimeArtifactDescriptor} from './runtime-artifact-descriptor.js';
import {Dsl4SourceDescriptorError, resolveDsl4EmbeddedSource} from './source-descriptor.js';
import {applyDsl4SourceOrigins, Dsl4SourceOriginError} from './source-origin-descriptor.js';
import {deepFreeze, sourceOriginForStoryPath} from './story-document.js';
import type {Dsl4SubtleCrypto} from './subtle-crypto.js';

export const dsl4RuntimeArtifactStoragePaths = deepFreeze({
  bundled:
    'extensionStorage.kubohiroyakamishibai4.components.kubohiroyakamishibairuntime4.artifact',
  unbundled: 'extensionStorage.kubohiroyakamishibairuntime4.artifact',
});

export const dsl4AssetDistributionStoragePaths = deepFreeze({
  bundled:
    'extensionStorage.kubohiroyakamishibai4.components.kubohiroyakamishibairuntime4.assetDistribution',
  unbundled: 'extensionStorage.kubohiroyakamishibairuntime4.assetDistribution',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diagnostic(
  storyDocument: Readonly<Record<string, unknown>> | null,
  sourceId: string,
  code: string,
  message: string,
  path: string = '$.artifact',
) {
  const origin = storyDocument
    ? sourceOriginForStoryPath(storyDocument)
    : {
        sourceId,
        range: deepFreeze({
          start: {line: 1, column: 1, offset: 0},
          end: {line: 1, column: 1, offset: 0},
        }),
      };
  return deepFreeze({
    version: 1,
    code,
    severity: 'error',
    message,
    sourceId: origin.sourceId,
    range: origin.range,
    path,
    related: [],
  });
}

function failure(
  storyDocument: Readonly<Record<string, unknown>> | null,
  sourceId: string,
  code: string,
  message: string,
  path?: string,
) {
  return deepFreeze({
    ok: false,
    diagnostics: [diagnostic(storyDocument, sourceId, code, message, path)],
  });
}

function storedArtifacts(project: unknown) {
  if (!isRecord(project)) return [];
  const extensionStorage = isRecord(project.extensionStorage) ? project.extensionStorage : {};
  const runtimeStorage = isRecord(extensionStorage.kubohiroyakamishibairuntime4)
    ? extensionStorage.kubohiroyakamishibairuntime4
    : {};
  const bundleStorage = isRecord(extensionStorage.kubohiroyakamishibai4)
    ? extensionStorage.kubohiroyakamishibai4
    : {};
  const components = isRecord(bundleStorage.components) ? bundleStorage.components : {};
  const bundledRuntime = isRecord(components.kubohiroyakamishibairuntime4)
    ? components.kubohiroyakamishibairuntime4
    : {};
  return [
    {
      channel: 'unbundled',
      artifact: runtimeStorage.artifact,
      path: dsl4RuntimeArtifactStoragePaths.unbundled,
    },
    {
      channel: 'bundled',
      artifact: bundledRuntime.artifact,
      path: dsl4RuntimeArtifactStoragePaths.bundled,
    },
  ].filter(({artifact}) => artifact !== undefined);
}

function storedAssetBundles(project: unknown) {
  if (!isRecord(project)) return [];
  const extensionStorage = isRecord(project.extensionStorage) ? project.extensionStorage : {};
  const runtimeStorage = isRecord(extensionStorage.kubohiroyakamishibairuntime4)
    ? extensionStorage.kubohiroyakamishibairuntime4
    : {};
  const bundleStorage = isRecord(extensionStorage.kubohiroyakamishibai4)
    ? extensionStorage.kubohiroyakamishibai4
    : {};
  const components = isRecord(bundleStorage.components) ? bundleStorage.components : {};
  const bundledRuntime = isRecord(components.kubohiroyakamishibairuntime4)
    ? components.kubohiroyakamishibairuntime4
    : {};
  return [
    {
      channel: 'unbundled',
      assets: runtimeStorage.assets,
      path: dsl4AssetBundleStoragePaths.unbundled,
    },
    {
      channel: 'bundled',
      assets: bundledRuntime.assets,
      path: dsl4AssetBundleStoragePaths.bundled,
    },
  ].filter(({assets}) => assets !== undefined);
}

function storedAssetDistributions(project: unknown) {
  if (!isRecord(project)) return [];
  const extensionStorage = isRecord(project.extensionStorage) ? project.extensionStorage : {};
  const runtimeStorage = isRecord(extensionStorage.kubohiroyakamishibairuntime4)
    ? extensionStorage.kubohiroyakamishibairuntime4
    : {};
  const bundleStorage = isRecord(extensionStorage.kubohiroyakamishibai4)
    ? extensionStorage.kubohiroyakamishibai4
    : {};
  const components = isRecord(bundleStorage.components) ? bundleStorage.components : {};
  const bundledRuntime = isRecord(components.kubohiroyakamishibairuntime4)
    ? components.kubohiroyakamishibairuntime4
    : {};
  return [
    {
      channel: 'unbundled',
      distribution: runtimeStorage.assetDistribution,
      path: dsl4AssetDistributionStoragePaths.unbundled,
    },
    {
      channel: 'bundled',
      distribution: bundledRuntime.assetDistribution,
      path: dsl4AssetDistributionStoragePaths.bundled,
    },
  ].filter(({distribution}) => distribution !== undefined);
}

/**
 * Resolve, parse, and validate one immutable runtime component snapshot.
 *
 */
export async function loadDsl4RuntimeArtifact(
  project: unknown,
  sourceFrontend: {
    parse(source: string, options?: {sourceId?: string}): Readonly<Record<string, any>>;
  },
  {
    maxSourceBytes,
    historyNavigationAvailable = false,
    requireAssetBundle = false,
    assetBundleFormat = 'embedded-base64',
    maxAssetFiles,
    maxAssetFileBytes,
    maxAssetBytes,
    subtleCrypto = globalThis.crypto?.subtle,
  }: {
    maxSourceBytes: number;
    historyNavigationAvailable?: boolean;
    requireAssetBundle?: boolean;
    assetBundleFormat?: 'embedded-base64' | 'binary-entry';
    maxAssetFiles?: number;
    maxAssetFileBytes?: number;
    maxAssetBytes?: number;
    subtleCrypto?: Dsl4SubtleCrypto | undefined;
  },
) {
  if (!sourceFrontend || typeof sourceFrontend.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse');
  }
  let source;
  try {
    source = await resolveDsl4EmbeddedSource(project, {maxSourceBytes, subtleCrypto});
  } catch (error) {
    if (error instanceof Dsl4SourceDescriptorError) {
      return failure(null, 'main', error.code, error.message, '$.source');
    }
    throw error;
  }

  const parsed = sourceFrontend.parse(source.descriptor.text, {
    sourceId: source.descriptor.sourceId,
  });
  if (!parsed.ok) return deepFreeze({ok: false, diagnostics: parsed.diagnostics});
  let storyDocument = parsed.storyDocument as Readonly<Record<string, unknown>>;
  if (source.descriptor.sourceOrigins !== undefined) {
    try {
      storyDocument = applyDsl4SourceOrigins(storyDocument, source.descriptor.sourceOrigins);
    } catch (error) {
      if (error instanceof Dsl4SourceOriginError) {
        return failure(
          storyDocument,
          source.descriptor.sourceId,
          error.code,
          error.message,
          '$.source.sourceOrigins',
        );
      }
      throw error;
    }
  }
  const artifacts = storedArtifacts(project);
  if (artifacts.length === 0) {
    return failure(
      storyDocument,
      source.descriptor.sourceId,
      'K4-ARTIFACT-CHANNEL-MISSING',
      'DSL 4.0 runtime artifact descriptor is missing',
    );
  }
  if (artifacts.length !== 1) {
    return failure(
      storyDocument,
      source.descriptor.sourceId,
      'K4-ARTIFACT-CHANNEL-AMBIGUOUS',
      'DSL 4.0 runtime artifact exists in both bundled and unbundled storage',
    );
  }
  const stored = artifacts[0];
  if (stored.channel !== source.channel) {
    return failure(
      storyDocument,
      source.descriptor.sourceId,
      'K4-ARTIFACT-CHANNEL-MISMATCH',
      'DSL 4.0 source and runtime artifact must use the same storage channel',
    );
  }
  const distributions = storedAssetDistributions(project);
  if (distributions.length > 1) {
    return failure(
      storyDocument,
      source.descriptor.sourceId,
      'K4-ASSET-DISTRIBUTION-CHANNEL-AMBIGUOUS',
      'DSL 4.0 asset distribution exists in both bundled and unbundled storage',
      '$.assetDistribution',
    );
  }
  if (distributions.length === 1 && distributions[0].channel !== source.channel) {
    return failure(
      storyDocument,
      source.descriptor.sourceId,
      'K4-ASSET-DISTRIBUTION-CHANNEL-MISMATCH',
      'DSL 4.0 source, runtime artifact, and asset distribution must use the same storage channel',
      '$.assetDistribution',
    );
  }
  let effectiveStoryDocument = storyDocument;
  if (distributions.length === 1) {
    try {
      effectiveStoryDocument = validateDsl4AssetDistributionResolution(
        storyDocument,
        distributions[0].distribution,
      ).storyDocument;
    } catch (error) {
      const diagnosticError = error && typeof error === 'object' ? error : {};
      return failure(
        storyDocument,
        source.descriptor.sourceId,
        'code' in diagnosticError && typeof diagnosticError.code === 'string'
          ? diagnosticError.code
          : 'K4-ASSET-DISTRIBUTION-001',
        'message' in diagnosticError && typeof diagnosticError.message === 'string'
          ? diagnosticError.message
          : 'DSL 4.0 asset distribution is invalid',
        '$.assetDistribution',
      );
    }
  }
  const validated = await validateDsl4RuntimeArtifactDescriptor(
    effectiveStoryDocument,
    source.descriptor,
    stored.artifact,
    {maxSourceBytes, historyNavigationAvailable, subtleCrypto},
  );
  if (!validated.ok) return validated;
  const validatedSuccess = validated as unknown as {artifact: Readonly<Record<string, unknown>>};
  let assetBundle = null;
  let assetBundlePath = null;
  let getAssetFile = null;
  if (requireAssetBundle) {
    if (maxAssetFiles === undefined || maxAssetBytes === undefined) {
      throw new TypeError(
        'maxAssetFiles and maxAssetBytes are required for complete component loading',
      );
    }
    const bundles = storedAssetBundles(project);
    if (bundles.length === 0) {
      return failure(
        storyDocument,
        source.descriptor.sourceId,
        'K4-ASSET-BUNDLE-CHANNEL-MISSING',
        'DSL 4.0 embedded asset bundle is missing',
        '$.assets',
      );
    }
    if (bundles.length !== 1) {
      return failure(
        storyDocument,
        source.descriptor.sourceId,
        'K4-ASSET-BUNDLE-CHANNEL-AMBIGUOUS',
        'DSL 4.0 asset bundle exists in both bundled and unbundled storage',
        '$.assets',
      );
    }
    const storedBundle = bundles[0];
    if (storedBundle.channel !== source.channel) {
      return failure(
        storyDocument,
        source.descriptor.sourceId,
        'K4-ASSET-BUNDLE-CHANNEL-MISMATCH',
        'DSL 4.0 source, runtime artifact, and assets must use the same storage channel',
        '$.assets',
      );
    }
    try {
      if (assetBundleFormat === 'embedded-base64') {
        const validatedBundle = await validateDsl4EmbeddedAssetBundle(
          effectiveStoryDocument,
          storedBundle.assets,
          {maxFiles: maxAssetFiles, maxTotalBytes: maxAssetBytes, subtleCrypto},
        );
        assetBundle = validatedBundle.descriptor;
        getAssetFile = validatedBundle.getFile;
      } else if (assetBundleFormat === 'binary-entry') {
        if (maxAssetFileBytes === undefined) {
          throw new TypeError('maxAssetFileBytes is required for binary-entry component loading');
        }
        assetBundle = await validateDsl4BinaryEntryAssetBundle(
          effectiveStoryDocument,
          storedBundle.assets,
          {
            maxFiles: maxAssetFiles,
            maxFileBytes: maxAssetFileBytes,
            maxTotalBytes: maxAssetBytes,
            subtleCrypto,
          },
        );
      } else {
        throw new TypeError('assetBundleFormat must be embedded-base64 or binary-entry');
      }
      assetBundlePath = storedBundle.path;
    } catch (error) {
      if (error instanceof Dsl4AssetBundleError || error instanceof Dsl4BinaryEntryError) {
        return failure(
          effectiveStoryDocument,
          source.descriptor.sourceId,
          error.code,
          error.message,
          '$.assets',
        );
      }
      throw error;
    }
  }
  const result = {
    ok: true,
    channel: source.channel,
    sourcePath: source.path,
    artifactPath: stored.path,
    sourceDescriptor: source.descriptor,
    runtimeArtifact: validatedSuccess.artifact,
    storyDocument: effectiveStoryDocument,
    diagnostics: [],
  };
  if (assetBundle && assetBundlePath) {
    Object.assign(result, {assetBundle, assetBundlePath});
    if (getAssetFile) Object.assign(result, {getAssetFile});
  }
  return deepFreeze(result);
}

/** Load a complete immutable source, control artifact, and embedded asset snapshot. */
export function loadDsl4RuntimeComponent(
  project: unknown,
  sourceFrontend: {
    parse(source: string, options?: {sourceId?: string}): Readonly<Record<string, any>>;
  },
  options: {
    maxSourceBytes: number;
    maxAssetFiles: number;
    maxAssetBytes: number;
    historyNavigationAvailable?: boolean;
    subtleCrypto?: Dsl4SubtleCrypto | undefined;
  },
) {
  return loadDsl4RuntimeArtifact(project, sourceFrontend, {
    ...options,
    requireAssetBundle: true,
    assetBundleFormat: 'embedded-base64',
  });
}

/**
 * Load immutable source, control artifact, and ZIP-entry asset metadata.
 *
 * The returned component intentionally has no byte getter. The caller must create a bounded,
 * releasable provider from an SB3 or editor backing store.
 */
export function loadDsl4BinaryEntryRuntimeComponent(
  project: unknown,
  sourceFrontend: {
    parse(source: string, options?: {sourceId?: string}): Readonly<Record<string, any>>;
  },
  options: Parameters<typeof loadDsl4RuntimeArtifact>[2],
) {
  return loadDsl4RuntimeArtifact(project, sourceFrontend, {
    ...options,
    requireAssetBundle: true,
    assetBundleFormat: 'binary-entry',
  });
}
