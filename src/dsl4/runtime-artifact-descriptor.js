import {resolveDsl4ControlProfile} from './control-profile-resolver.js';
import {
  computeDsl4Sha256Integrity,
  Dsl4SourceDescriptorError,
  validateDsl4EmbeddedSourceDescriptor,
} from './source-descriptor.js';
import {deepFreeze, sourceOriginForStoryPath} from './story-document.js';

const artifactKeys = new Set([
  'controlProfile',
  'formatVersion',
  'historyNavigationEnabled',
  'resolvedKeymap',
  'resolvedKeymapIntegrity',
  'sourceIntegrity',
]);

/**
 * @typedef {Readonly<{ok: true, profile: string, keymap: Readonly<Record<string, string>>, canonicalKeymap: string, historyEnabled: boolean, diagnostics: ReadonlyArray<never>}>} ResolvedControlProfile
 * @typedef {Readonly<{formatVersion: 1, sourceIntegrity: string, controlProfile: string, resolvedKeymap: Readonly<Record<string, string>>, resolvedKeymapIntegrity: string, historyNavigationEnabled: boolean}>} RuntimeArtifact
 * @typedef {Readonly<{ok: true, artifact: RuntimeArtifact, diagnostics: ReadonlyArray<never>}>} RuntimeArtifactSuccess
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {string} code
 * @param {string} message
 * @param {string} [path]
 */
function diagnostic(storyDocument, code, message, path = '$.artifact') {
  const origin = sourceOriginForStoryPath(storyDocument);
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

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {string} code
 * @param {string} message
 * @param {string} [path]
 */
function failure(storyDocument, code, message, path) {
  return deepFreeze({ok: false, diagnostics: [diagnostic(storyDocument, code, message, path)]});
}

/** @param {Readonly<Record<string, string>>} keymap */
function canonicalKeymap(keymap) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(keymap).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  );
}

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {unknown} sourceDescriptor
 * @param {string | undefined | null} controlProfile
 * @param {object} options
 * @param {number} options.maxSourceBytes
 * @param {boolean} [options.historyNavigationAvailable]
 * @param {{digest: Function}} [options.subtleCrypto]
 */
export async function createDsl4RuntimeArtifactDescriptor(
  storyDocument,
  sourceDescriptor,
  controlProfile,
  {maxSourceBytes, historyNavigationAvailable = false, subtleCrypto = globalThis.crypto?.subtle},
) {
  if (storyDocument.kind !== 'StoryDocument' || storyDocument.version !== '4.0') {
    throw new TypeError('DSL 4.0 runtime artifact requires a StoryDocument version 4.0');
  }
  let source;
  try {
    source = await validateDsl4EmbeddedSourceDescriptor(sourceDescriptor, {
      maxSourceBytes,
      subtleCrypto,
    });
  } catch (error) {
    if (error instanceof Dsl4SourceDescriptorError) {
      return failure(storyDocument, error.code, error.message, '$.source');
    }
    throw error;
  }
  const metadata = /** @type {Record<string, unknown>} */ (storyDocument.metadata ?? {});
  if (metadata.sourceId !== source.sourceId) {
    return failure(
      storyDocument,
      'K4-ARTIFACT-SOURCE-001',
      'StoryDocument and embedded source descriptor must have the same sourceId',
      '$.sourceId',
    );
  }

  const profileResult = resolveDsl4ControlProfile(storyDocument, controlProfile, {
    historyNavigationAvailable,
  });
  if (!profileResult.ok) return profileResult;
  const profile = /** @type {ResolvedControlProfile} */ (/** @type {unknown} */ (profileResult));
  let resolvedKeymapIntegrity;
  try {
    resolvedKeymapIntegrity = await computeDsl4Sha256Integrity(
      new TextEncoder().encode(profile.canonicalKeymap),
      subtleCrypto,
    );
  } catch (error) {
    if (error instanceof Dsl4SourceDescriptorError) {
      return failure(storyDocument, error.code, error.message, '$.resolvedKeymapIntegrity');
    }
    throw error;
  }
  const artifact = deepFreeze({
    formatVersion: 1,
    sourceIntegrity: source.integrity,
    controlProfile: profile.profile,
    resolvedKeymap: profile.keymap,
    resolvedKeymapIntegrity,
    historyNavigationEnabled: profile.historyEnabled,
  });
  return deepFreeze({ok: true, artifact, diagnostics: []});
}

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {unknown} sourceDescriptor
 * @param {unknown} inputArtifact
 * @param {object} options
 * @param {number} options.maxSourceBytes
 * @param {boolean} [options.historyNavigationAvailable]
 * @param {{digest: Function}} [options.subtleCrypto]
 */
export async function validateDsl4RuntimeArtifactDescriptor(
  storyDocument,
  sourceDescriptor,
  inputArtifact,
  options,
) {
  if (storyDocument.kind !== 'StoryDocument' || storyDocument.version !== '4.0') {
    throw new TypeError('DSL 4.0 runtime artifact requires a StoryDocument version 4.0');
  }
  if (!isRecord(inputArtifact)) {
    return failure(
      storyDocument,
      'K4-ARTIFACT-DESCRIPTOR-001',
      'Runtime artifact descriptor must be an object',
    );
  }
  const keys = Object.keys(inputArtifact);
  const unknown = keys.filter((key) => !artifactKeys.has(key));
  const missing = [...artifactKeys].filter((key) => !Object.hasOwn(inputArtifact, key));
  if (unknown.length > 0 || missing.length > 0) {
    return failure(
      storyDocument,
      'K4-ARTIFACT-DESCRIPTOR-001',
      `Runtime artifact descriptor keys are invalid (unknown: ${unknown.sort().join(', ') || 'none'}; missing: ${missing.sort().join(', ') || 'none'})`,
    );
  }
  if (
    inputArtifact.formatVersion !== 1 ||
    typeof inputArtifact.sourceIntegrity !== 'string' ||
    typeof inputArtifact.controlProfile !== 'string' ||
    typeof inputArtifact.resolvedKeymapIntegrity !== 'string' ||
    typeof inputArtifact.historyNavigationEnabled !== 'boolean' ||
    !isRecord(inputArtifact.resolvedKeymap) ||
    Object.values(inputArtifact.resolvedKeymap).some((command) => typeof command !== 'string')
  ) {
    return failure(
      storyDocument,
      'K4-ARTIFACT-DESCRIPTOR-001',
      'Runtime artifact descriptor fields have invalid types or values',
    );
  }

  const expected = await createDsl4RuntimeArtifactDescriptor(
    storyDocument,
    sourceDescriptor,
    inputArtifact.controlProfile,
    options,
  );
  if (!expected.ok) return expected;
  const expectedSuccess = /** @type {RuntimeArtifactSuccess} */ (/** @type {unknown} */ (expected));
  if (inputArtifact.sourceIntegrity !== expectedSuccess.artifact.sourceIntegrity) {
    return failure(
      storyDocument,
      'K4-ARTIFACT-SOURCE-001',
      'Runtime artifact source integrity does not match the embedded source',
      '$.sourceIntegrity',
    );
  }
  const inputCanonicalKeymap = canonicalKeymap(
    /** @type {Record<string, string>} */ (inputArtifact.resolvedKeymap),
  );
  const expectedCanonicalKeymap = canonicalKeymap(expectedSuccess.artifact.resolvedKeymap);
  if (inputCanonicalKeymap !== expectedCanonicalKeymap) {
    return failure(
      storyDocument,
      'K4-ARTIFACT-KEYMAP-001',
      'Runtime artifact resolved keymap does not match the selected profile',
      '$.resolvedKeymap',
    );
  }
  if (inputArtifact.resolvedKeymapIntegrity !== expectedSuccess.artifact.resolvedKeymapIntegrity) {
    return failure(
      storyDocument,
      'K4-ARTIFACT-KEYMAP-INTEGRITY-001',
      'Runtime artifact keymap integrity does not match the canonical resolved keymap',
      '$.resolvedKeymapIntegrity',
    );
  }
  if (
    inputArtifact.historyNavigationEnabled !== expectedSuccess.artifact.historyNavigationEnabled
  ) {
    return failure(
      storyDocument,
      'K4-ARTIFACT-HISTORY-001',
      'Runtime artifact history flag does not match the selected resolved keymap',
      '$.historyNavigationEnabled',
    );
  }
  return expectedSuccess;
}
