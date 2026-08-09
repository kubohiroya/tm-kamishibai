import {
  Dsl4AssetBundleError,
  validateDsl4EmbeddedAssetBundle,
} from '../dsl4/asset-bundle-descriptor.js';
import {
  Dsl4BinaryEntryError,
  validateDsl4BinaryEntryAssetBundle,
} from '../dsl4/binary-entry-provider.js';
import {validateDsl4RuntimeArtifactDescriptor} from '../dsl4/runtime-artifact-descriptor.js';
import {
  Dsl4SourceDescriptorError,
  validateDsl4EmbeddedSourceDescriptor,
} from '../dsl4/source-descriptor.js';
import {applyDsl4SourceOrigins, Dsl4SourceOriginError} from '../dsl4/source-origin-descriptor.js';
import {Sb3BuilderError} from './errors.js';
import {readSb3, serializeSb3} from './sb3.js';

const channels = new Set(['bundled', 'unbundled']);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} message @param {string} code @param {unknown} [cause] @returns {never} */
function fail(message, code, cause) {
  throw new Sb3BuilderError(message, {stage: 'dsl4-source', code, cause});
}

/**
 * @param {Record<string, unknown>} parent
 * @param {string} key
 * @returns {Record<string, unknown>}
 */
function objectProperty(parent, key) {
  const existing = parent[key];
  if (existing === undefined) {
    /** @type {Record<string, unknown>} */
    const created = {};
    parent[key] = created;
    return created;
  }
  if (!isRecord(existing)) {
    fail(`Cannot install DSL 4.0 source because ${key} is not an object`, 'K4-SOURCE-STORAGE-001');
  }
  return existing;
}

/**
 * @param {Record<string, unknown> | null} parent
 * @param {string} key
 * @returns {Record<string, unknown> | null}
 */
function optionalObjectProperty(parent, key) {
  if (!parent || parent[key] === undefined) return null;
  if (!isRecord(parent[key])) {
    fail(`Cannot inspect DSL 4.0 source because ${key} is not an object`, 'K4-SOURCE-STORAGE-001');
  }
  return parent[key];
}

/**
 * @param {Record<string, unknown>} extensionStorage
 * @param {'bundled' | 'unbundled'} channel
 */
function sourceContainers(extensionStorage, channel) {
  const existingUnbundled = optionalObjectProperty(
    extensionStorage,
    'kubohiroyakamishibairuntime4',
  );
  const existingBundle = optionalObjectProperty(extensionStorage, 'kubohiroyakamishibai4');
  const existingComponents = optionalObjectProperty(existingBundle, 'components');
  const existingBundled = optionalObjectProperty(
    existingComponents,
    'kubohiroyakamishibairuntime4',
  );

  if (channel === 'unbundled') {
    return {
      selected:
        existingUnbundled ?? objectProperty(extensionStorage, 'kubohiroyakamishibairuntime4'),
      opposite: existingBundled,
    };
  }
  const bundle = existingBundle ?? objectProperty(extensionStorage, 'kubohiroyakamishibai4');
  const components = existingComponents ?? objectProperty(bundle, 'components');
  return {
    selected: existingBundled ?? objectProperty(components, 'kubohiroyakamishibairuntime4'),
    opposite: existingUnbundled,
  };
}

/**
 * Install a validated source descriptor into a cloned project.
 *
 * @param {unknown} project
 * @param {unknown} descriptor
 * @param {object} options
 * @param {'bundled' | 'unbundled'} options.channel
 * @param {number} options.maxSourceBytes
 * @param {boolean} [options.replaceExisting]
 * @param {{digest: Function}} [options.subtleCrypto]
 */
export async function installDsl4EmbeddedSource(
  project,
  descriptor,
  {channel, maxSourceBytes, replaceExisting = false, subtleCrypto = globalThis.crypto?.subtle},
) {
  if (!isRecord(project)) {
    fail('SB3 project must be an object', 'K4-SOURCE-STORAGE-001');
  }
  if (!channels.has(channel)) {
    fail('DSL 4.0 source channel must be bundled or unbundled', 'K4-SOURCE-CHANNEL-001');
  }
  if (typeof replaceExisting !== 'boolean') {
    throw new TypeError('replaceExisting must be a boolean');
  }
  let validated;
  try {
    validated = await validateDsl4EmbeddedSourceDescriptor(descriptor, {
      maxSourceBytes,
      subtleCrypto,
    });
  } catch (error) {
    if (error instanceof Dsl4SourceDescriptorError) {
      fail(error.message, error.code, error);
    }
    throw error;
  }

  const output = /** @type {Record<string, unknown>} */ (structuredClone(project));
  const extensionStorage = objectProperty(output, 'extensionStorage');
  const {selected, opposite} = sourceContainers(
    extensionStorage,
    /** @type {'bundled' | 'unbundled'} */ (channel),
  );
  if (opposite?.source !== undefined) {
    fail(
      'DSL 4.0 source already exists in the opposite storage channel',
      'K4-SOURCE-CHANNEL-AMBIGUOUS',
    );
  }
  if (selected.source !== undefined && !replaceExisting) {
    fail(
      'DSL 4.0 source already exists; replacement requires explicit authorization',
      'K4-SOURCE-STORAGE-EXISTS',
    );
  }
  selected.source = structuredClone(validated);
  return output;
}

/**
 * Embed a DSL 4.0 source descriptor into an SB3 without changing its target graph or assets.
 *
 * @param {Buffer | Uint8Array} baseSb3Bytes
 * @param {unknown} descriptor
 * @param {Parameters<typeof installDsl4EmbeddedSource>[2]} options
 */
export async function embedDsl4SourceInSb3(baseSb3Bytes, descriptor, options) {
  const {archive, project} = readSb3(baseSb3Bytes);
  const outputProject = await installDsl4EmbeddedSource(project, descriptor, options);
  return {bytes: serializeSb3(archive, outputProject), project: outputProject};
}

/**
 * Atomically install a validated source and its runtime artifact into one component channel.
 *
 * @param {unknown} project
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {unknown} sourceDescriptor
 * @param {unknown} runtimeArtifact
 * @param {object} options
 * @param {'bundled' | 'unbundled'} options.channel
 * @param {number} options.maxSourceBytes
 * @param {boolean} [options.historyNavigationAvailable]
 * @param {boolean} [options.replaceExisting]
 * @param {unknown} [options.assetBundle]
 * @param {'embedded-base64' | 'binary-entry'} [options.assetBundleFormat]
 * @param {number} [options.maxAssetFiles]
 * @param {number} [options.maxAssetFileBytes]
 * @param {number} [options.maxAssetBytes]
 * @param {unknown} [options.assetDistribution]
 * @param {{digest: Function}} [options.subtleCrypto]
 */
export async function installDsl4RuntimeComponent(
  project,
  storyDocument,
  sourceDescriptor,
  runtimeArtifact,
  {
    channel,
    maxSourceBytes,
    historyNavigationAvailable = false,
    replaceExisting = false,
    assetBundle,
    assetBundleFormat = 'embedded-base64',
    assetDistribution,
    maxAssetFiles,
    maxAssetFileBytes,
    maxAssetBytes,
    subtleCrypto = globalThis.crypto?.subtle,
  },
) {
  if (!isRecord(project)) {
    fail('SB3 project must be an object', 'K4-RUNTIME-COMPONENT-STORAGE-001');
  }
  if (!channels.has(channel)) {
    fail('DSL 4.0 runtime component channel must be bundled or unbundled', 'K4-SOURCE-CHANNEL-001');
  }
  if (typeof replaceExisting !== 'boolean') {
    throw new TypeError('replaceExisting must be a boolean');
  }
  let source;
  try {
    source = await validateDsl4EmbeddedSourceDescriptor(sourceDescriptor, {
      maxSourceBytes,
      subtleCrypto,
    });
  } catch (error) {
    if (error instanceof Dsl4SourceDescriptorError) fail(error.message, error.code, error);
    throw error;
  }
  let validatedStoryDocument = storyDocument;
  if (source.sourceOrigins !== undefined) {
    try {
      validatedStoryDocument = applyDsl4SourceOrigins(storyDocument, source.sourceOrigins);
    } catch (error) {
      if (error instanceof Dsl4SourceOriginError) fail(error.message, error.code, error);
      throw error;
    }
  }
  const validatedArtifact = await validateDsl4RuntimeArtifactDescriptor(
    validatedStoryDocument,
    source,
    runtimeArtifact,
    {maxSourceBytes, historyNavigationAvailable, subtleCrypto},
  );
  if (!validatedArtifact.ok) {
    const firstDiagnostic = validatedArtifact.diagnostics[0];
    fail(firstDiagnostic.message, firstDiagnostic.code);
  }
  const validatedArtifactSuccess = /** @type {{artifact: Readonly<Record<string, unknown>>}} */ (
    /** @type {unknown} */ (validatedArtifact)
  );
  let validatedAssets = null;
  if (assetBundle !== undefined) {
    if (maxAssetFiles === undefined || maxAssetBytes === undefined) {
      throw new TypeError('maxAssetFiles and maxAssetBytes are required with assetBundle');
    }
    try {
      if (assetBundleFormat === 'embedded-base64') {
        validatedAssets = await validateDsl4EmbeddedAssetBundle(
          validatedStoryDocument,
          assetBundle,
          {
            maxFiles: maxAssetFiles,
            maxTotalBytes: maxAssetBytes,
            subtleCrypto,
          },
        );
      } else if (assetBundleFormat === 'binary-entry') {
        if (maxAssetFileBytes === undefined) {
          throw new TypeError('maxAssetFileBytes is required with a binary-entry asset bundle');
        }
        validatedAssets = {
          descriptor: await validateDsl4BinaryEntryAssetBundle(
            validatedStoryDocument,
            assetBundle,
            {
              maxFiles: maxAssetFiles,
              maxFileBytes: maxAssetFileBytes,
              maxTotalBytes: maxAssetBytes,
              subtleCrypto,
            },
          ),
        };
      } else {
        throw new TypeError('assetBundleFormat must be embedded-base64 or binary-entry');
      }
    } catch (error) {
      if (error instanceof Dsl4AssetBundleError || error instanceof Dsl4BinaryEntryError) {
        fail(error.message, error.code, error);
      }
      throw error;
    }
  }

  const output = /** @type {Record<string, unknown>} */ (structuredClone(project));
  const extensionStorage = objectProperty(output, 'extensionStorage');
  const {selected, opposite} = sourceContainers(
    extensionStorage,
    /** @type {'bundled' | 'unbundled'} */ (channel),
  );
  if (
    opposite &&
    (opposite.source !== undefined ||
      opposite.artifact !== undefined ||
      opposite.assets !== undefined ||
      opposite.assetDistribution !== undefined)
  ) {
    fail(
      'DSL 4.0 runtime component already exists in the opposite storage channel',
      'K4-RUNTIME-COMPONENT-CHANNEL-AMBIGUOUS',
    );
  }
  const hasSource = selected.source !== undefined;
  const hasArtifact = selected.artifact !== undefined;
  const hasAssets = selected.assets !== undefined;
  const hasDistribution = selected.assetDistribution !== undefined;
  const packaged = validatedAssets !== null;
  if (
    hasSource !== hasArtifact ||
    (packaged && hasSource !== hasAssets) ||
    (hasDistribution && (!hasSource || !hasArtifact || (packaged && !hasAssets)))
  ) {
    fail(
      'Existing DSL 4.0 runtime component has only some of source, artifact, and assets',
      'K4-RUNTIME-COMPONENT-PARTIAL',
    );
  }
  if (!packaged && hasAssets) {
    fail(
      'Existing packaged DSL 4.0 component cannot be replaced without an asset bundle',
      'K4-RUNTIME-COMPONENT-ASSET-MODE-001',
    );
  }
  if (!packaged && hasDistribution) {
    fail(
      'Existing packaged DSL 4.0 component cannot be replaced without an asset distribution',
      'K4-RUNTIME-COMPONENT-ASSET-MODE-001',
    );
  }
  if (hasSource && !replaceExisting) {
    fail(
      'DSL 4.0 runtime component already exists; replacement requires explicit authorization',
      'K4-RUNTIME-COMPONENT-STORAGE-EXISTS',
    );
  }
  selected.source = structuredClone(source);
  selected.artifact = structuredClone(validatedArtifactSuccess.artifact);
  if (validatedAssets) selected.assets = structuredClone(validatedAssets.descriptor);
  if (assetDistribution !== undefined)
    selected.assetDistribution = structuredClone(assetDistribution);
  else delete selected.assetDistribution;
  return output;
}

/**
 * Atomically install source, control artifact, and embedded assets into one component channel.
 *
 * @param {unknown} project
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {unknown} sourceDescriptor
 * @param {unknown} runtimeArtifact
 * @param {unknown} assetBundle
 * @param {object} options
 * @param {'bundled' | 'unbundled'} options.channel
 * @param {number} options.maxSourceBytes
 * @param {number} options.maxAssetFiles
 * @param {number} options.maxAssetBytes
 * @param {boolean} [options.historyNavigationAvailable]
 * @param {boolean} [options.replaceExisting]
 * @param {{digest: Function}} [options.subtleCrypto]
 */
export function installDsl4PackagedRuntimeComponent(
  project,
  storyDocument,
  sourceDescriptor,
  runtimeArtifact,
  assetBundle,
  options,
) {
  return installDsl4RuntimeComponent(project, storyDocument, sourceDescriptor, runtimeArtifact, {
    ...options,
    assetBundle,
    assetBundleFormat: 'embedded-base64',
  });
}

/**
 * Atomically install source, control artifact, and a ZIP-entry asset descriptor.
 *
 * This explicit API keeps the binary-entry path opt-in while the Base64 package format remains
 * the default compatibility path.
 *
 * @param {unknown} project
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {unknown} sourceDescriptor
 * @param {unknown} runtimeArtifact
 * @param {unknown} assetBundle
 * @param {Parameters<typeof installDsl4RuntimeComponent>[4]} options
 */
export function installDsl4BinaryEntryRuntimeComponent(
  project,
  storyDocument,
  sourceDescriptor,
  runtimeArtifact,
  assetBundle,
  options,
) {
  return installDsl4RuntimeComponent(project, storyDocument, sourceDescriptor, runtimeArtifact, {
    ...options,
    assetBundle,
    assetBundleFormat: 'binary-entry',
  });
}

/**
 * Embed a complete DSL 4.0 runtime component without changing target graph or assets.
 *
 * @param {Buffer | Uint8Array} baseSb3Bytes
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {unknown} sourceDescriptor
 * @param {unknown} runtimeArtifact
 * @param {Parameters<typeof installDsl4RuntimeComponent>[4]} options
 */
export async function embedDsl4RuntimeComponentInSb3(
  baseSb3Bytes,
  storyDocument,
  sourceDescriptor,
  runtimeArtifact,
  options,
) {
  const {archive, project} = readSb3(baseSb3Bytes);
  const outputProject = await installDsl4RuntimeComponent(
    project,
    storyDocument,
    sourceDescriptor,
    runtimeArtifact,
    options,
  );
  return {bytes: serializeSb3(archive, outputProject), project: outputProject};
}

/**
 * Embed a source, control artifact, and asset bundle without changing targets or other entries.
 *
 * @param {Buffer | Uint8Array} baseSb3Bytes
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {unknown} sourceDescriptor
 * @param {unknown} runtimeArtifact
 * @param {unknown} assetBundle
 * @param {Parameters<typeof installDsl4PackagedRuntimeComponent>[5]} options
 */
export async function embedDsl4PackagedRuntimeComponentInSb3(
  baseSb3Bytes,
  storyDocument,
  sourceDescriptor,
  runtimeArtifact,
  assetBundle,
  options,
) {
  const {archive, project} = readSb3(baseSb3Bytes);
  const outputProject = await installDsl4PackagedRuntimeComponent(
    project,
    storyDocument,
    sourceDescriptor,
    runtimeArtifact,
    assetBundle,
    options,
  );
  return {bytes: serializeSb3(archive, outputProject), project: outputProject};
}
