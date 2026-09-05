import {
  createDsl4EmbeddedAssetBundle,
  Dsl4AssetBundleError,
} from '../dsl4/asset-bundle-descriptor.js';
import {
  createDsl4BinaryEntryAssetBundle,
  Dsl4BinaryEntryError,
} from '../dsl4/binary-entry-provider.js';
import {createDsl4BlockSourceGraph} from '../dsl4/block-source-export.js';
import {createDsl4RuntimeArtifactDescriptor} from '../dsl4/runtime-artifact-descriptor.js';
import {
  loadDsl4BinaryEntryRuntimeComponent,
  loadDsl4RuntimeComponent,
} from '../dsl4/runtime-artifact-loader.js';
import {
  createDsl4EmbeddedSourceDescriptor,
  Dsl4SourceDescriptorError,
} from '../dsl4/source-descriptor.js';
import type {Dsl4SourceFrontend} from '../dsl4/source-frontend.js';
import {Dsl4SourceGraphError} from '../dsl4/source-graph.js';
import {createDsl4SourceGraphFrontend} from '../dsl4/source-graph-frontend.js';
import {deepFreeze} from '../dsl4/story-document.js';
import type {Dsl4SubtleCrypto} from '../dsl4/subtle-crypto.js';
import {
  Dsl4BlockSourceError,
  extractDsl4BlockSourcesFromProject,
} from '../dsl4/turbowarp-yaml-json-block-source.js';
import {
  Dsl4AssetDistributionError,
  resolveDsl4AssetDistributionProfile,
  validateDsl4AssetDistributionConfig,
  validateDsl4AssetDistributionLock,
} from '../dsl4/asset-distribution-profile.js';
import {loadDsl4ProjectJson} from './dsl4-asset-audit.js';
import {loadDsl4ExternalSource} from './dsl4-external-source.js';
import {loadDsl4LocalAssetSnapshot} from './dsl4-local-assets.js';
import {loadDsl4BuildSourceGraph} from './dsl4-source-graph.js';
import {resolveDsl4BuildSourceLimits} from './dsl4-source-limits.js';
import {embedDsl4BinaryEntryRuntimeComponentInSb3} from './dsl4-binary-entry-sb3.js';
import {resolveDsl4BuildFeatureFlags} from './dsl4-build-feature-flags.js';
import {embedDsl4PackagedRuntimeComponentInSb3} from './dsl4-source.js';
import {Sb3BuilderError} from './errors.js';
import type {Dsl4FileSystem} from './file-system.js';
import {readSb3} from './sb3.js';

export class Dsl4BuildError extends Sb3BuilderError {
  readonly diagnostics: Readonly<readonly unknown[]>;

  constructor(
    message: string,
    details: {stage: string; code: string; diagnostics?: readonly unknown[]; cause?: unknown},
  ) {
    super(message, details);
    this.name = 'Dsl4BuildError';
    this.diagnostics = deepFreeze(structuredClone(details.diagnostics ?? []));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

/**
 * The three producers that reach here do not share one diagnostic type yet: the source frontend
 * emits `Dsl4Diagnostic`, while the artifact descriptor and verifier emit a shape whose `range` may
 * be null. Only the code and the message are read, so this accepts the common surface until the two
 * shapes are unified.
 */
function failDiagnostics(
  diagnostics: readonly Readonly<{code?: string; message?: string}>[],
  stage: string,
): never {
  const first = diagnostics[0];
  throw new Dsl4BuildError(first?.message ?? 'DSL 4.0 build validation failed', {
    stage,
    code: first?.code ?? 'K4-BUILD-VALIDATION-001',
    diagnostics,
  });
}

async function loadDsl4BlockSourceFromSb3(
  baseSb3Bytes: Buffer | Uint8Array,
  {
    maxSourceBytes,
    subtleCrypto,
  }: {maxSourceBytes: number; subtleCrypto?: Dsl4SubtleCrypto | undefined},
) {
  let blockSourceSet;
  try {
    const {project} = readSb3(baseSb3Bytes);
    blockSourceSet = extractDsl4BlockSourcesFromProject(project);
  } catch (error) {
    if (error instanceof Dsl4BlockSourceError) {
      throw new Dsl4BuildError(error.message, {
        stage: 'dsl4-block-source',
        code: error.code,
        cause: error,
      });
    }
    throw error;
  }
  const text = blockSourceSet.sources[blockSourceSet.entryPath];
  if (typeof text !== 'string') {
    throw new Dsl4BuildError('Root block DSL source is missing', {
      stage: 'dsl4-block-source',
      code: 'K4-BLOCK-SOURCE-MISSING-001',
    });
  }
  try {
    const descriptor = await createDsl4EmbeddedSourceDescriptor(text, {
      sourceId: blockSourceSet.entryPath,
      displayName: blockSourceSet.entryPath,
      maxSourceBytes,
      subtleCrypto,
    });
    return {
      manifest: {path: blockSourceSet.entryPath},
      descriptor,
      blockSourceSet,
    };
  } catch (error) {
    if (error instanceof Dsl4SourceDescriptorError) {
      throw new Dsl4BuildError(error.message, {
        stage: 'dsl4-block-source',
        code: error.code,
        cause: error,
      });
    }
    throw error;
  }
}

async function createDsl4VirtualBlockSourceGraph(
  blockSourceSet: Readonly<{entryPath: string; sources: Readonly<Record<string, string>>}>,
  limits: Partial<{
    maxSourceFiles: number;
    maxSourceBytes: number;
    maxTotalSourceBytes: number;
    maxIncludeDepth: number;
  }>,
) {
  try {
    return await createDsl4BlockSourceGraph(blockSourceSet, limits);
  } catch (error) {
    if (error instanceof Dsl4SourceGraphError) {
      throw new Dsl4BuildError(error.message, {
        stage: 'dsl4-block-source-graph',
        code: error.code,
        cause: error,
      });
    }
    throw error;
  }
}

/** Build one complete, self-contained DSL 4.0 runtime component in memory. */
export async function buildDsl4RuntimeComponent(options: {
  baseSb3Bytes: Buffer | Uint8Array;
  projectRoot: string;
  sourceManifest?: unknown;
  sourceFrontend: Dsl4SourceFrontend;
  controlProfile: string;
  channel: 'bundled' | 'unbundled';
  maxSourceBytes: number;
  maxAssetFileBytes: number;
  maxAssetFiles: number;
  maxTotalAssetBytes: number;
  featureFlags?: unknown;
  maxSourceFiles?: number;
  maxTotalSourceBytes?: number;
  maxIncludeDepth?: number;
  historyNavigationAvailable?: boolean;
  replaceExisting?: boolean;
  subtleCrypto?: Dsl4SubtleCrypto | undefined;
  fileSystem?: Dsl4FileSystem | undefined;
  readSource?: (filePath: string, limit: number) => Promise<Buffer | Uint8Array>;
  readAssetFile?: (filePath: string, limit: number) => Promise<Buffer | Uint8Array>;
  assetConfig?: string;
  assetLock?: string;
  assetProfile?: string;
  maxAssetConfigBytes?: number;
  maxAssetLockBytes?: number;
  runtimeExtensionSource?: string;
  poseNetBundle?: unknown;
}) {
  if (!isRecord(options)) throw new TypeError('DSL 4.0 build options are required');
  const {
    baseSb3Bytes,
    projectRoot,
    sourceManifest,
    sourceFrontend,
    controlProfile,
    channel,
    maxSourceBytes,
    maxAssetFileBytes,
    maxAssetFiles,
    maxTotalAssetBytes,
    featureFlags: inputFeatureFlags = {},
    maxSourceFiles,
    maxTotalSourceBytes,
    maxIncludeDepth,
    historyNavigationAvailable = false,
    replaceExisting = false,
    subtleCrypto = globalThis.crypto?.subtle,
    fileSystem,
    readSource,
    readAssetFile,
    assetConfig,
    assetLock,
    assetProfile,
    maxAssetConfigBytes,
    maxAssetLockBytes,
    runtimeExtensionSource,
    poseNetBundle,
  } = options;
  if (!(baseSb3Bytes instanceof Uint8Array)) {
    throw new TypeError('baseSb3Bytes must be a Buffer or Uint8Array');
  }
  if (!sourceFrontend || typeof sourceFrontend.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse');
  }
  nonEmptyString(controlProfile, 'controlProfile');
  nonEmptyString(channel, 'channel');
  const buildFeatureFlags = resolveDsl4BuildFeatureFlags(inputFeatureFlags);
  const featureFlags = buildFeatureFlags.runtimeFeatureFlags;
  const usesBlockSource = sourceManifest === undefined || sourceManifest === null;
  const sourceGraphEnabled = featureFlags.dsl4SourceIncludes || usesBlockSource;
  const sourceLimits = resolveDsl4BuildSourceLimits({
    sourceIncludesEnabled: sourceGraphEnabled,
    maxSourceBytes,
    maxTotalSourceBytes,
  });

  let blockSourceSet = null;
  const source = usesBlockSource
    ? await loadDsl4BlockSourceFromSb3(baseSb3Bytes, {
        maxSourceBytes: sourceLimits.maxSourceFileBytes,
        subtleCrypto,
      })
    : await loadDsl4ExternalSource(projectRoot, sourceManifest, {
        maxSourceBytes: sourceLimits.maxSourceFileBytes,
        subtleCrypto,
        fileSystem,
        ...(readSource === undefined ? {} : {readSource}),
      });
  if (usesBlockSource) {
    blockSourceSet = (
      source as {
        blockSourceSet: Readonly<{entryPath: string; sources: Readonly<Record<string, string>>}>;
      }
    ).blockSourceSet;
  }
  let parsed: Readonly<Record<string, any>>;
  let sourceDescriptor = source.descriptor;
  if (sourceGraphEnabled) {
    const graphLimits = {
      maxSourceBytes: sourceLimits.maxSourceFileBytes,
      maxTotalSourceBytes: sourceLimits.maxSourceGraphBytes,
      ...(maxSourceFiles === undefined ? {} : {maxSourceFiles}),
      ...(maxIncludeDepth === undefined ? {} : {maxIncludeDepth}),
    };
    const sourceGraph = blockSourceSet
      ? await createDsl4VirtualBlockSourceGraph(blockSourceSet, graphLimits)
      : await loadDsl4BuildSourceGraph(projectRoot, source, {
          limits: graphLimits,
          ...(fileSystem === undefined ? {} : {fileSystem}),
          ...(readSource === undefined ? {} : {readSource}),
        });
    const graphFrontend = createDsl4SourceGraphFrontend(sourceFrontend);
    parsed = graphFrontend.parse(sourceGraph, {
      featureFlags: {...featureFlags, dsl4SourceIncludes: true},
      sourceId: source.descriptor.sourceId,
      maxComposedSourceBytes: sourceLimits.maxComposedSourceBytes,
    }) as Readonly<Record<string, any>>;
    if (parsed.ok) {
      try {
        sourceDescriptor = await createDsl4EmbeddedSourceDescriptor(parsed.canonicalSource, {
          sourceId: source.descriptor.sourceId,
          displayName: source.descriptor.displayName,
          maxSourceBytes: sourceLimits.maxPackagedSourceBytes,
          ...(source.descriptor.cacheIdentity
            ? {cacheIdentity: source.descriptor.cacheIdentity}
            : {}),
          ...(parsed.storyDocument.sourceOrigins
            ? {sourceOrigins: parsed.storyDocument.sourceOrigins}
            : {}),
          subtleCrypto,
        });
      } catch (error) {
        if (error instanceof Dsl4SourceDescriptorError) {
          throw new Dsl4BuildError(error.message, {
            stage: 'dsl4-source-compose',
            code: error.code,
            cause: error,
          });
        }
        throw error;
      }
    }
  } else {
    parsed = sourceFrontend.parse(source.descriptor.text, {
      sourceId: source.descriptor.sourceId,
    });
  }
  if (!parsed.ok) failDiagnostics(parsed.diagnostics, 'dsl4-parse');
  let storyDocument = parsed.storyDocument as Readonly<Record<string, unknown>>;
  let assetDistribution;
  if (assetConfig !== undefined || assetLock !== undefined || assetProfile !== undefined) {
    if (
      typeof assetConfig !== 'string' ||
      typeof assetLock !== 'string' ||
      typeof assetProfile !== 'string'
    ) {
      throw new TypeError('assetConfig, assetLock, and assetProfile must be provided together');
    }
    if (maxAssetConfigBytes === undefined || maxAssetLockBytes === undefined) {
      throw new TypeError(
        'maxAssetConfigBytes and maxAssetLockBytes are required with asset distribution',
      );
    }
    try {
      const [configInput, lockInput] = await Promise.all([
        loadDsl4ProjectJson({
          projectRoot,
          inputPath: assetConfig,
          maxBytes: maxAssetConfigBytes,
          label: 'asset distribution config',
          code: 'K4-ASSET-PROFILE-001',
        }),
        loadDsl4ProjectJson({
          projectRoot,
          inputPath: assetLock,
          maxBytes: maxAssetLockBytes,
          label: 'asset distribution lock',
          code: 'K4-ASSET-LOCK-001',
        }),
      ]);
      assetDistribution = resolveDsl4AssetDistributionProfile(
        storyDocument,
        validateDsl4AssetDistributionConfig(configInput),
        validateDsl4AssetDistributionLock(lockInput),
        assetProfile,
      );
      storyDocument = assetDistribution.storyDocument;
    } catch (error) {
      if (error instanceof Dsl4AssetDistributionError) {
        throw new Dsl4BuildError(error.message, {
          stage: 'dsl4-asset-distribution',
          code: error.code,
          cause: error,
        });
      }
      throw error;
    }
  }

  const snapshot = await loadDsl4LocalAssetSnapshot(projectRoot, storyDocument, {
    maxFileBytes: maxAssetFileBytes,
    maxFiles: maxAssetFiles,
    maxTotalBytes: maxTotalAssetBytes,
    subtleCrypto,
    fileSystem,
    ...(readAssetFile === undefined ? {} : {readFile: readAssetFile}),
  });
  let assetBundle;
  try {
    assetBundle = buildFeatureFlags.dsl4RootBinaryEntryPackaging
      ? await createDsl4BinaryEntryAssetBundle(storyDocument, snapshot, {
          maxFiles: maxAssetFiles,
          maxFileBytes: maxAssetFileBytes,
          maxTotalBytes: maxTotalAssetBytes,
          subtleCrypto,
        })
      : await createDsl4EmbeddedAssetBundle(storyDocument, snapshot, {
          maxFiles: maxAssetFiles,
          maxTotalBytes: maxTotalAssetBytes,
          subtleCrypto,
        });
  } catch (error) {
    if (
      error instanceof Dsl4AssetBundleError ||
      error instanceof Dsl4BinaryEntryError ||
      error instanceof Dsl4SourceDescriptorError
    ) {
      throw new Dsl4BuildError(error.message, {
        stage: 'dsl4-asset-bundle',
        code: error.code,
        cause: error,
      });
    }
    throw error;
  }

  const artifactResult = await createDsl4RuntimeArtifactDescriptor(
    storyDocument,
    sourceDescriptor,
    controlProfile,
    {
      maxSourceBytes: sourceLimits.maxPackagedSourceBytes,
      historyNavigationAvailable,
      subtleCrypto,
    },
  );
  if (!artifactResult.ok) failDiagnostics(artifactResult.diagnostics, 'dsl4-artifact');
  const artifactSuccess = artifactResult as unknown as {
    artifact: Readonly<Record<string, unknown>>;
  };
  const runtimeArtifact = artifactSuccess.artifact;
  const componentOptions = {
    channel,
    maxSourceBytes: sourceLimits.maxPackagedSourceBytes,
    maxAssetFiles,
    maxAssetBytes: maxTotalAssetBytes,
    historyNavigationAvailable,
    replaceExisting,
    subtleCrypto,
    ...(assetDistribution === undefined ? {} : {assetDistribution}),
    ...(runtimeExtensionSource === undefined ? {} : {runtimeExtensionSource}),
    ...(poseNetBundle === undefined ? {} : {poseNetBundle}),
  };
  const embedded = buildFeatureFlags.dsl4RootBinaryEntryPackaging
    ? await embedDsl4BinaryEntryRuntimeComponentInSb3(
        baseSb3Bytes,
        storyDocument,
        sourceDescriptor,
        runtimeArtifact,
        assetBundle as Awaited<ReturnType<typeof createDsl4BinaryEntryAssetBundle>>,
        {...componentOptions, maxAssetFileBytes},
      )
    : await embedDsl4PackagedRuntimeComponentInSb3(
        baseSb3Bytes,
        storyDocument,
        sourceDescriptor,
        runtimeArtifact,
        assetBundle,
        componentOptions,
      );

  const verified = await (
    buildFeatureFlags.dsl4RootBinaryEntryPackaging
      ? loadDsl4BinaryEntryRuntimeComponent
      : loadDsl4RuntimeComponent
  )(embedded.project, sourceFrontend, {
    maxSourceBytes: sourceLimits.maxPackagedSourceBytes,
    maxAssetFiles,
    maxAssetFileBytes,
    maxAssetBytes: maxTotalAssetBytes,
    historyNavigationAvailable,
    subtleCrypto,
  });
  if (!verified.ok) failDiagnostics(verified.diagnostics, 'dsl4-verify');
  return Object.freeze({
    bytes: Buffer.from(embedded.bytes),
    project: deepFreeze(embedded.project),
    runtimeComponent: verified,
  });
}
