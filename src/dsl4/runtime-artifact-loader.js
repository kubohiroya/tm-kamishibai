import {validateDsl4RuntimeArtifactDescriptor} from './runtime-artifact-descriptor.js';
import {Dsl4SourceDescriptorError, resolveDsl4EmbeddedSource} from './source-descriptor.js';
import {deepFreeze} from './story-document.js';

export const dsl4RuntimeArtifactStoragePaths = deepFreeze({
  bundled:
    'extensionStorage.kubohiroyakamishibai4.components.kubohiroyakamishibairuntime4.artifact',
  unbundled: 'extensionStorage.kubohiroyakamishibairuntime4.artifact',
});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {Readonly<Record<string, unknown>> | null} storyDocument
 * @param {string} sourceId
 * @param {string} code
 * @param {string} message
 * @param {string} [path]
 */
function diagnostic(storyDocument, sourceId, code, message, path = '$.artifact') {
  const sourceMap = /** @type {Record<string, unknown>} */ (storyDocument?.sourceMap ?? {});
  return deepFreeze({
    version: 1,
    code,
    severity: 'error',
    message,
    sourceId,
    range:
      sourceMap['/'] ??
      deepFreeze({
        start: {line: 1, column: 1, offset: 0},
        end: {line: 1, column: 1, offset: 0},
      }),
    path,
    related: [],
  });
}

/**
 * @param {Readonly<Record<string, unknown>> | null} storyDocument
 * @param {string} sourceId
 * @param {string} code
 * @param {string} message
 * @param {string} [path]
 */
function failure(storyDocument, sourceId, code, message, path) {
  return deepFreeze({
    ok: false,
    diagnostics: [diagnostic(storyDocument, sourceId, code, message, path)],
  });
}

/** @param {unknown} project */
function storedArtifacts(project) {
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

/**
 * Resolve, parse, and validate one immutable runtime component snapshot.
 *
 * @param {unknown} project
 * @param {{parse(source: string, options?: {sourceId?: string}): Readonly<Record<string, any>>}} sourceFrontend
 * @param {object} options
 * @param {number} options.maxSourceBytes
 * @param {boolean} [options.historyNavigationAvailable]
 * @param {{digest: Function}} [options.subtleCrypto]
 */
export async function loadDsl4RuntimeArtifact(
  project,
  sourceFrontend,
  {maxSourceBytes, historyNavigationAvailable = false, subtleCrypto = globalThis.crypto?.subtle},
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
  const storyDocument = /** @type {Readonly<Record<string, unknown>>} */ (parsed.storyDocument);
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
  const validated = await validateDsl4RuntimeArtifactDescriptor(
    storyDocument,
    source.descriptor,
    stored.artifact,
    {maxSourceBytes, historyNavigationAvailable, subtleCrypto},
  );
  if (!validated.ok) return validated;
  const validatedSuccess = /** @type {{artifact: Readonly<Record<string, unknown>>}} */ (
    /** @type {unknown} */ (validated)
  );
  return deepFreeze({
    ok: true,
    channel: source.channel,
    sourcePath: source.path,
    artifactPath: stored.path,
    sourceDescriptor: source.descriptor,
    runtimeArtifact: validatedSuccess.artifact,
    storyDocument,
    diagnostics: [],
  });
}
