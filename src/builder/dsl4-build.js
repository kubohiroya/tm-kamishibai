import {
  createDsl4EmbeddedAssetBundle,
  Dsl4AssetBundleError,
} from '../dsl4/asset-bundle-descriptor.js';
import {resolveDsl4FeatureFlags} from '../dsl4/feature-flags.js';
import {createDsl4RuntimeArtifactDescriptor} from '../dsl4/runtime-artifact-descriptor.js';
import {loadDsl4RuntimeComponent} from '../dsl4/runtime-artifact-loader.js';
import {
  createDsl4EmbeddedSourceDescriptor,
  Dsl4SourceDescriptorError,
} from '../dsl4/source-descriptor.js';
import {createDsl4SourceGraphFrontend} from '../dsl4/source-graph-frontend.js';
import {deepFreeze} from '../dsl4/story-document.js';
import {loadDsl4ExternalSource} from './dsl4-external-source.js';
import {loadDsl4LocalAssetSnapshot} from './dsl4-local-assets.js';
import {loadDsl4BuildSourceGraph} from './dsl4-source-graph.js';
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
  } = options;
  if (!(baseSb3Bytes instanceof Uint8Array)) {
    throw new TypeError('baseSb3Bytes must be a Buffer or Uint8Array');
  }
  if (!sourceFrontend || typeof sourceFrontend.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse');
  }
  nonEmptyString(controlProfile, 'controlProfile');
  nonEmptyString(channel, 'channel');
  const featureFlags = resolveDsl4FeatureFlags(inputFeatureFlags);

  const source = await loadDsl4ExternalSource(projectRoot, sourceManifest, {
    maxSourceBytes,
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
        maxSourceBytes,
        maxTotalSourceBytes: maxTotalSourceBytes ?? maxSourceBytes,
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
      })
    );
    if (parsed.ok) {
      try {
        sourceDescriptor = await createDsl4EmbeddedSourceDescriptor(parsed.canonicalSource, {
          sourceId: source.descriptor.sourceId,
          displayName: source.descriptor.displayName,
          maxSourceBytes,
          ...(source.descriptor.cacheIdentity
            ? {cacheIdentity: source.descriptor.cacheIdentity}
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
  const storyDocument = /** @type {Readonly<Record<string, unknown>>} */ (parsed.storyDocument);

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
    assetBundle = await createDsl4EmbeddedAssetBundle(storyDocument, snapshot, {
      maxFiles: maxAssetFiles,
      maxTotalBytes: maxTotalAssetBytes,
      subtleCrypto,
    });
  } catch (error) {
    if (error instanceof Dsl4AssetBundleError || error instanceof Dsl4SourceDescriptorError) {
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
    {maxSourceBytes, historyNavigationAvailable, subtleCrypto},
  );
  if (!artifactResult.ok) failDiagnostics(artifactResult.diagnostics, 'dsl4-artifact');
  const artifactSuccess = /** @type {{artifact: Readonly<Record<string, unknown>>}} */ (
    /** @type {unknown} */ (artifactResult)
  );
  const runtimeArtifact = artifactSuccess.artifact;
  const embedded = await embedDsl4PackagedRuntimeComponentInSb3(
    baseSb3Bytes,
    storyDocument,
    sourceDescriptor,
    runtimeArtifact,
    assetBundle,
    {
      channel,
      maxSourceBytes,
      maxAssetFiles,
      maxAssetBytes: maxTotalAssetBytes,
      historyNavigationAvailable,
      replaceExisting,
      subtleCrypto,
    },
  );

  const verified = await loadDsl4RuntimeComponent(embedded.project, sourceFrontend, {
    maxSourceBytes,
    maxAssetFiles,
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
