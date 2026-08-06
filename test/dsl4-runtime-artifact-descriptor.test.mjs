import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  createDsl4EmbeddedSourceDescriptor,
  createDsl4RuntimeArtifactDescriptor,
  createDsl4SourceFrontend,
  validateDsl4RuntimeArtifactDescriptor,
} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const subtleCrypto = webcrypto.subtle;
const maxSourceBytes = 4096;
const source = `
kamishibai: '4.0'
controls:
  keymaps:
    development:
      ArrowUp: history.previousScene
      Space: navigation.nextAction
    production:
      Space: navigation.nextAction
scenes:
  opening: []
`;

async function fixture(sourceId = 'main') {
  const parsed = frontend.parse(source, {sourceId});
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const sourceDescriptor = await createDsl4EmbeddedSourceDescriptor(source, {
    sourceId,
    displayName: 'story.kamishibai.yaml',
    maxSourceBytes,
    subtleCrypto,
  });
  return {storyDocument: parsed.storyDocument, sourceDescriptor};
}

const options = (historyNavigationAvailable = false) => ({
  historyNavigationAvailable,
  maxSourceBytes,
  subtleCrypto,
});

function sri(value) {
  return `sha256-${createHash('sha256').update(value).digest('base64')}`;
}

test('binds a selected production profile and canonical keymap to source integrity', async () => {
  const {storyDocument, sourceDescriptor} = await fixture();
  const created = await createDsl4RuntimeArtifactDescriptor(
    storyDocument,
    sourceDescriptor,
    'production',
    options(),
  );
  assert.equal(created.ok, true, JSON.stringify(created.diagnostics));
  assert.deepEqual(created.artifact, {
    formatVersion: 1,
    sourceIntegrity: sourceDescriptor.integrity,
    controlProfile: 'production',
    resolvedKeymap: {Space: 'navigation.nextAction'},
    resolvedKeymapIntegrity: sri('{"Space":"navigation.nextAction"}'),
    historyNavigationEnabled: false,
  });
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.artifact), true);
  assert.equal(Object.isFrozen(created.artifact.resolvedKeymap), true);
});

test('uses existing profile diagnostics and fails closed on unavailable history', async () => {
  const {storyDocument, sourceDescriptor} = await fixture();
  for (const [profile, code] of [
    [undefined, 'K4-KEYMAP-PROFILE-REQUIRED'],
    ['unknown', 'K4-KEYMAP-PROFILE-UNKNOWN'],
    ['development', 'K4-KEYMAP-HISTORY-UNAVAILABLE'],
  ]) {
    const result = await createDsl4RuntimeArtifactDescriptor(
      storyDocument,
      sourceDescriptor,
      profile,
      options(),
    );
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0].code, code);
  }
  const available = await createDsl4RuntimeArtifactDescriptor(
    storyDocument,
    sourceDescriptor,
    'development',
    options(true),
  );
  assert.equal(available.ok, true);
  assert.equal(available.artifact.historyNavigationEnabled, true);
});

test('rejects a sourceId mismatch after validating the source descriptor', async () => {
  const {storyDocument} = await fixture('story-a');
  const {sourceDescriptor} = await fixture('story-b');
  const result = await createDsl4RuntimeArtifactDescriptor(
    storyDocument,
    sourceDescriptor,
    'production',
    options(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, 'K4-ARTIFACT-SOURCE-001');
});

test('accepts reordered keymap keys and returns the canonical expected artifact', async () => {
  const {storyDocument, sourceDescriptor} = await fixture();
  const created = await createDsl4RuntimeArtifactDescriptor(
    storyDocument,
    sourceDescriptor,
    'development',
    options(true),
  );
  assert.equal(created.ok, true);
  const reordered = {
    ...created.artifact,
    resolvedKeymap: {
      Space: 'navigation.nextAction',
      ArrowUp: 'history.previousScene',
    },
  };
  const validated = await validateDsl4RuntimeArtifactDescriptor(
    storyDocument,
    sourceDescriptor,
    reordered,
    options(true),
  );
  assert.equal(validated.ok, true, JSON.stringify(validated.diagnostics));
  assert.deepEqual(validated.artifact, created.artifact);
  assert.notStrictEqual(validated.artifact, reordered);
});

test('rejects structure, source, keymap, integrity, and history mutations', async () => {
  const {storyDocument, sourceDescriptor} = await fixture();
  const created = await createDsl4RuntimeArtifactDescriptor(
    storyDocument,
    sourceDescriptor,
    'production',
    options(),
  );
  assert.equal(created.ok, true);
  const artifact = created.artifact;
  const missing = {...artifact};
  delete missing.controlProfile;
  const cases = [
    [{...artifact, extra: true}, 'K4-ARTIFACT-DESCRIPTOR-001'],
    [missing, 'K4-ARTIFACT-DESCRIPTOR-001'],
    [{...artifact, sourceIntegrity: sri('other')}, 'K4-ARTIFACT-SOURCE-001'],
    [{...artifact, controlProfile: 'development'}, 'K4-KEYMAP-HISTORY-UNAVAILABLE'],
    [{...artifact, resolvedKeymap: {Enter: 'navigation.nextAction'}}, 'K4-ARTIFACT-KEYMAP-001'],
    [{...artifact, resolvedKeymapIntegrity: sri('other')}, 'K4-ARTIFACT-KEYMAP-INTEGRITY-001'],
    [{...artifact, historyNavigationEnabled: true}, 'K4-ARTIFACT-HISTORY-001'],
  ];
  for (const [candidate, code] of cases) {
    const result = await validateDsl4RuntimeArtifactDescriptor(
      storyDocument,
      sourceDescriptor,
      candidate,
      options(),
    );
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0].code, code);
  }
});
