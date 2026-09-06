import {resolveDsl4ControlProfile} from './control-profile-resolver.js';
import {
  computeDsl4Sha256Integrity,
  Dsl4SourceDescriptorError,
  validateDsl4EmbeddedSourceDescriptor,
} from './source-descriptor.js';
import {deepFreeze, sourceOriginForStoryPath} from './story-document.js';
import type {Dsl4SubtleCrypto} from './subtle-crypto.js';

const artifactKeys = new Set([
  'controlProfile',
  'formatVersion',
  'historyNavigationEnabled',
  'resolvedKeymap',
  'resolvedKeymapIntegrity',
  'sourceIntegrity',
]);

export type ResolvedControlProfile = Readonly<{
  ok: true;
  profile: string;
  keymap: Readonly<Record<string, string>>;
  canonicalKeymap: string;
  historyEnabled: boolean;
  diagnostics: ReadonlyArray<never>;
}>;

export type RuntimeArtifact = Readonly<{
  formatVersion: 1;
  sourceIntegrity: string;
  controlProfile: string;
  resolvedKeymap: Readonly<Record<string, string>>;
  resolvedKeymapIntegrity: string;
  historyNavigationEnabled: boolean;
}>;

export type RuntimeArtifactSuccess = Readonly<{
  ok: true;
  artifact: RuntimeArtifact;
  diagnostics: ReadonlyArray<never>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diagnostic(
  storyDocument: Readonly<Record<string, unknown>>,
  code: string,
  message: string,
  path: string = '$.artifact',
) {
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

function failure(
  storyDocument: Readonly<Record<string, unknown>>,
  code: string,
  message: string,
  path?: string,
) {
  return deepFreeze({ok: false, diagnostics: [diagnostic(storyDocument, code, message, path)]});
}

function canonicalKeymap(keymap: Readonly<Record<string, string>>) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(keymap).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  );
}

export async function createDsl4RuntimeArtifactDescriptor(
  storyDocument: Readonly<Record<string, unknown>>,
  sourceDescriptor: unknown,
  controlProfile: string | undefined | null,
  {
    maxSourceBytes,
    historyNavigationAvailable = false,
    subtleCrypto = globalThis.crypto?.subtle,
  }: {
    maxSourceBytes: number;
    historyNavigationAvailable?: boolean;
    subtleCrypto?: Dsl4SubtleCrypto | undefined;
  },
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
  const metadata = (storyDocument.metadata ?? {}) as Record<string, unknown>;
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
  const profile = profileResult as unknown as ResolvedControlProfile;
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
 */
export async function validateDsl4RuntimeArtifactDescriptor(
  storyDocument: Readonly<Record<string, unknown>>,
  sourceDescriptor: unknown,
  inputArtifact: unknown,
  options: {
    maxSourceBytes: number;
    historyNavigationAvailable?: boolean;
    subtleCrypto?: Dsl4SubtleCrypto | undefined;
  },
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
  const expectedSuccess = expected as unknown as RuntimeArtifactSuccess;
  if (inputArtifact.sourceIntegrity !== expectedSuccess.artifact.sourceIntegrity) {
    return failure(
      storyDocument,
      'K4-ARTIFACT-SOURCE-001',
      'Runtime artifact source integrity does not match the embedded source',
      '$.sourceIntegrity',
    );
  }
  const inputCanonicalKeymap = canonicalKeymap(
    inputArtifact.resolvedKeymap as Record<string, string>,
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
