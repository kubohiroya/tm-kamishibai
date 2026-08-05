import {
  Dsl4SourceDescriptorError,
  validateDsl4EmbeddedSourceDescriptor,
} from '../dsl4/source-descriptor.js';
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
