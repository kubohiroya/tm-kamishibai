import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'vitest';

import {classifyDsl4PreviewChange, createDsl4ArtifactFingerprint} from '../src/builder/index.js';
import {requireDefined, requireRecord} from './helpers/require-value.ts';
import {thrown} from './helpers/thrown-error.ts';

/** The fingerprint inputs the matrix fixture carries, as this suite reads and clones them. */
interface FingerprintInput {
  formatVersion: number;
  baseSb3Integrity: string;
  assetBundleIntegrity: string;
  appShell: {id: string; templateVersion: string; integrity: string};
  extensionBundle: {formatVersion: number; id: string; integrity: string};
  builder: {
    package: string;
    version: string;
    settings: {
      channel: string;
      maxSourceBytes: number;
      maxAssetFileBytes: number;
      maxAssetFiles: number;
      maxTotalAssetBytes: number;
      historyNavigationAvailable: boolean;
      replaceExisting: boolean;
    };
  };
  project: {
    sourceManifest: {
      formatVersion: number;
      mode: string;
      sourceId: string;
      path: string;
      cacheId?: string;
      cacheDatabaseName?: string;
    };
    controlProfile: string;
  };
}

/** One row of the reviewed change matrix. */
interface FingerprintChange {
  name: string;
  path: string | null;
  value: unknown;
  sourceChanged: boolean;
  expected: string;
}

interface FingerprintFixture {
  input: FingerprintInput;
  activeSourceIntegrity: string;
  candidateSourceIntegrity: string;
  changes: readonly FingerprintChange[];
}

interface ReleasePins {
  release: {package: string; version: string};
  artifactFingerprint: {expected: string};
}

/**
 * The members the fail-closed cases deliberately corrupt.
 *
 * Those cases hand the fingerprint a number where the contract wants a boolean, or delete a member
 * outright, so they cannot be typed against the contract they exist to break. This view says that
 * once, by name, instead of casting at each of the eight mutators.
 */
interface CorruptibleInput {
  appShell?: unknown;
  baseSb3Integrity: unknown;
  extensionBundle: {formatVersion: unknown};
  builder: {version: unknown; settings: {[setting: string]: unknown}};
  project: {controlProfile: unknown};
}

/** Read one valid input as the loosened view the fail-closed cases corrupt. */
function corruptible(input: FingerprintInput): CorruptibleInput {
  return input as unknown as CorruptibleInput;
}

const fixture: FingerprintFixture = JSON.parse(
  await readFile(
    new URL('fixtures/dsl4/artifact-fingerprint-matrix.json', import.meta.url),
    'utf8',
  ),
);
const releasePins: ReleasePins = JSON.parse(
  await readFile(new URL('fixtures/dsl4/release-pins.json', import.meta.url), 'utf8'),
);

function setPath(target: FingerprintInput, path: string, value: unknown) {
  const segments = path.split('.');
  const final = requireDefined(segments.pop(), `the last segment of ${path}`);
  let parent = requireRecord(target, 'the fingerprint input');
  for (const segment of segments) parent = requireRecord(parent[segment], `${path} at ${segment}`);
  parent[final] = value;
}

async function fingerprint(input: unknown = fixture.input) {
  return createDsl4ArtifactFingerprint(input, {subtleCrypto: webcrypto.subtle});
}

test('creates one deterministic deeply immutable structural fingerprint', async () => {
  const created = await fingerprint();
  const reordered = {
    project: {
      controlProfile: fixture.input.project.controlProfile,
      sourceManifest: {
        path: fixture.input.project.sourceManifest.path,
        sourceId: fixture.input.project.sourceManifest.sourceId,
        mode: 'external',
        formatVersion: 1,
      },
    },
    builder: {
      settings: {
        replaceExisting: false,
        historyNavigationAvailable: true,
        maxTotalAssetBytes: 67_108_864,
        maxAssetFiles: 128,
        maxAssetFileBytes: 20_971_520,
        maxSourceBytes: 1_048_576,
        channel: 'bundled',
      },
      version: releasePins.release.version,
      package: releasePins.release.package,
    },
    extensionBundle: {
      integrity: fixture.input.extensionBundle.integrity,
      id: 'kubohiroyakamishibai4',
      formatVersion: 1,
    },
    appShell: {
      integrity: fixture.input.appShell.integrity,
      templateVersion: releasePins.release.version,
      id: 'standard',
    },
    assetBundleIntegrity: fixture.input.assetBundleIntegrity,
    baseSb3Integrity: fixture.input.baseSb3Integrity,
    formatVersion: 1,
  };
  const reorderedResult = await fingerprint(reordered);

  assert.equal(created.formatVersion, 1);
  assert.equal(fixture.input.builder.package, releasePins.release.package);
  assert.equal(fixture.input.builder.version, releasePins.release.version);
  assert.equal(fixture.input.appShell.templateVersion, releasePins.release.version);
  assert.equal(created.integrity, releasePins.artifactFingerprint.expected);
  assert.equal(reorderedResult.integrity, created.integrity);
  assert.deepEqual(reorderedResult.inputs, created.inputs);
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.inputs), true);
  assert.equal(Object.isFrozen(created.inputs.builder.settings), true);
});

test('classifies the reviewed YAML-only and structural change matrix', async () => {
  const activeFingerprint = await fingerprint();
  for (const change of fixture.changes) {
    const candidateInput = structuredClone(fixture.input);
    if (change.path) setPath(candidateInput, change.path, change.value);
    const candidateFingerprint = await fingerprint(candidateInput);
    const result = classifyDsl4PreviewChange({
      activeArtifactFingerprint: activeFingerprint.integrity,
      candidateArtifactFingerprint: candidateFingerprint.integrity,
      activeSourceIntegrity: fixture.activeSourceIntegrity,
      candidateSourceIntegrity: change.sourceChanged
        ? fixture.candidateSourceIntegrity
        : fixture.activeSourceIntegrity,
    });
    assert.equal(result.kind, change.expected, change.name);
    assert.equal(result.requiresFullRebuild, change.expected === 'full-rebuild', change.name);
    assert.equal(result.requiresNewPreviewSession, change.expected === 'full-rebuild', change.name);
    assert.equal(
      result.restartFrom,
      change.expected === 'full-rebuild'
        ? 'entrypoint'
        : change.expected === 'live-reload'
          ? 'author-choice'
          : 'unchanged',
      change.name,
    );
    assert.equal(Object.isFrozen(result), true);
  }
});

test('includes the stable source cache identity without accepting source text', async () => {
  const withoutCache = await fingerprint();
  const input = structuredClone(fixture.input);
  input.project.sourceManifest.cacheId = 'story-cache-01';
  input.project.sourceManifest.cacheDatabaseName = 'tw-kamishibai-assets-v1--story--story-cache-01';
  const withCache = await fingerprint(input);
  assert.notEqual(withCache.integrity, withoutCache.integrity);
  assert.deepEqual(withCache.inputs.project.sourceManifest, input.project.sourceManifest);
});

test('rejects source text, preview preferences, and session-only state as fingerprint inputs', async () => {
  const rejectedInputs: readonly [string, unknown][] = [
    ['sourceText', 'kamishibai: 4.0'],
    ['previewPreferences', {defaultChoice: 3}],
    ['sessionToken', 'secret'],
    ['candidateRevision', 2],
    ['restartChoice', 1],
  ];
  for (const [path, value] of rejectedInputs) {
    const input = requireRecord(structuredClone(fixture.input), 'the cloned fingerprint input');
    input[path] = value;
    await assert.rejects(fingerprint(input), /unknown/u);
  }
});

test('fails closed for incomplete, malformed, or unsafe fingerprint boundaries', async () => {
  const corruptions: readonly ((input: CorruptibleInput) => void)[] = [
    (input) => delete input.appShell,
    (input) => (input.baseSb3Integrity = 'sha256-invalid'),
    (input) => (input.extensionBundle.formatVersion = 2),
    (input) => (input.builder.settings.channel = 'automatic'),
    (input) => (input.builder.version = '3.2.4'),
    (input) => (input.builder.settings.maxSourceBytes = 0),
    (input) => (input.builder.settings.historyNavigationAvailable = 1),
    (input) => (input.project.controlProfile = ''),
  ];
  for (const mutate of corruptions) {
    const input = structuredClone(fixture.input);
    mutate(corruptible(input));
    await assert.rejects(fingerprint(input), TypeError);
  }

  const unsafePath = structuredClone(fixture.input);
  unsafePath.project.sourceManifest.path = '../story.kamishibai.yaml';
  await assert.rejects(
    fingerprint(unsafePath),
    (error) => thrown(error).code === 'K4-SOURCE-PATH-001',
  );

  assert.throws(
    () =>
      classifyDsl4PreviewChange({
        activeArtifactFingerprint: fixture.activeSourceIntegrity,
        candidateArtifactFingerprint: fixture.activeSourceIntegrity,
        activeSourceIntegrity: fixture.activeSourceIntegrity,
        candidateSourceIntegrity: fixture.activeSourceIntegrity,
        modalChoice: 2,
      }),
    /unknown/u,
  );
});
