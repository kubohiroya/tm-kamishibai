import {
  createDsl4EmbeddedAssetBundle,
  Dsl4AssetBundleError,
} from '../dsl4/asset-bundle-descriptor.js';
import {
  createDsl4BinaryEntryAssetBundle,
  Dsl4BinaryEntryError,
} from '../dsl4/binary-entry-provider.js';
import {createDsl4RuntimeArtifactDescriptor} from '../dsl4/runtime-artifact-descriptor.js';
import {
  loadDsl4BinaryEntryRuntimeComponent,
  loadDsl4RuntimeComponent,
} from '../dsl4/runtime-artifact-loader.js';
import {
  createDsl4EmbeddedSourceDescriptor,
  Dsl4SourceDescriptorError,
} from '../dsl4/source-descriptor.js';
import {createDsl4SourceGraphFrontend} from '../dsl4/source-graph-frontend.js';
import {deepFreeze} from '../dsl4/story-document.js';
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

export class Dsl4BuildError extends Sb3BuilderError {
  /**
   * @param {string} message
   * @param {{stage: string, code: string, diagnostics?: readonly unknown[], cause?: unknown}} details
   */
  constructor(message, details) {
    super(message, details);
    this.name = 'Dsl4BuildError';
    this.diagnostics = deepFreeze(structuredClone(details.diagnostics ?? []));
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name */
function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

/** @param {readonly Record<string, any>[]} diagnostics @param {string} stage @returns {never} */
function failDiagnostics(diagnostics, stage) {
  const first = diagnostics[0];
  throw new Dsl4BuildError(first?.message ?? 'DSL 4.0 build validation failed', {
    stage,
    code: first?.code ?? 'K4-BUILD-VALIDATION-001',
    diagnostics,
  });
}

/**
 * Build one complete, self-contained DSL 4.0 runtime component in memory.
 *
 * @param {object} options
 * @param {Buffer | Uint8Array} options.baseSb3Bytes
 * @param {string} options.projectRoot
 * @param {unknown} options.sourceManifest
 * @param {{parse(source: string, options?: {sourceId?: string}): Readonly<Record<string, any>>}} options.sourceFrontend
 * @param {string} options.controlProfile
 * @param {'bundled' | 'unbundled'} options.channel
 * @param {number} options.maxSourceBytes
 * @param {number} options.maxAssetFileBytes
 * @param {number} options.maxAssetFiles
 * @param {number} options.maxTotalAssetBytes
 * @param {unknown} [options.featureFlags]
 * @param {number} [options.maxSourceFiles]
 * @param {number} [options.maxTotalSourceBytes]
 * @param {number} [options.maxIncludeDepth]
 * @param {boolean} [options.historyNavigationAvailable]
 * @param {boolean} [options.replaceExisting]
 * @param {{digest: Function}} [options.subtleCrypto]
 * @param {{realpath: Function, lstat: Function, open: Function, readdir: Function}} [options.fileSystem]
 * @param {(filePath: string, limit: number) => Promise<Buffer | Uint8Array>} [options.readSource]
 * @param {(filePath: string, limit: number) => Promise<Buffer | Uint8Array>} [options.readAssetFile]
 * @param {string} [options.assetConfig]
 * @param {string} [options.assetLock]
 * @param {string} [options.assetProfile]
 * @param {number} [options.maxAssetConfigBytes]
 * @param {number} [options.maxAssetLockBytes]
 * @param {string} [options.runtimeExtensionSource]
 * @param {unknown} [options.poseNetBundle]
 */
export async function buildDsl4RuntimeComponent(options) {
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
  const sourceLimits = resolveDsl4BuildSourceLimits({
    sourceIncludesEnabled: featureFlags.dsl4SourceIncludes,
    maxSourceBytes,
    maxTotalSourceBytes,
  });

  const source = await loadDsl4ExternalSource(projectRoot, sourceManifest, {
    maxSourceBytes: sourceLimits.maxSourceFileBytes,
    subtleCrypto,
    fileSystem,
    readSource,
  });
  /** @type {Readonly<Record<string, any>>} */
  let parsed;
  let sourceDescriptor = source.descriptor;
  if (featureFlags.dsl4SourceIncludes) {
    const sourceGraph = await loadDsl4BuildSourceGraph(projectRoot, source, {
      limits: {
        maxSourceBytes: sourceLimits.maxSourceFileBytes,
        maxTotalSourceBytes: sourceLimits.maxSourceGraphBytes,
        ...(maxSourceFiles === undefined ? {} : {maxSourceFiles}),
        ...(maxIncludeDepth === undefined ? {} : {maxIncludeDepth}),
      },
      fileSystem,
      readSource,
    });
    const graphFrontend = createDsl4SourceGraphFrontend(sourceFrontend);
    parsed = /** @type {Readonly<Record<string, any>>} */ (
      graphFrontend.parse(sourceGraph, {
        featureFlags,
        sourceId: source.descriptor.sourceId,
        maxComposedSourceBytes: sourceLimits.maxComposedSourceBytes,
      })
    );
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
  let storyDocument = /** @type {Readonly<Record<string, unknown>>} */ (parsed.storyDocument);
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
    readFile: readAssetFile,
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
  const artifactSuccess = /** @type {{artifact: Readonly<Record<string, unknown>>}} */ (
    /** @type {unknown} */ (artifactResult)
  );
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
        /** @type {Awaited<ReturnType<typeof createDsl4BinaryEntryAssetBundle>>} */ (assetBundle),
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
