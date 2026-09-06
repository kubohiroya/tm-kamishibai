import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'vitest';
import {fileURLToPath} from 'node:url';

import {strToU8, unzipSync, zipSync} from 'fflate';

import {
  embedDsl4RuntimeComponentInSb3,
  installDsl4RuntimeComponent,
  Sb3BuilderError,
} from '../src/builder/index.js';
import {
  createDsl4EmbeddedSourceDescriptor,
  createDsl4RuntimeArtifactDescriptor,
  createDsl4SourceFrontend,
  loadDsl4RuntimeArtifact,
} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const subtleCrypto = webcrypto.subtle;
const maxSourceBytes = 4096;
const sourceText = `
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

function baseProject() {
  return {
    extensionStorage: {localstorage: {namespace: 'kamishibai'}},
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {start: {opcode: 'event_whenflagclicked', next: null, parent: null}},
      },
    ],
    monitors: [],
  };
}

function baseSb3(project = baseProject()) {
  return Buffer.from(
    zipSync({
      'project.json': strToU8(`${JSON.stringify(project)}\n`),
      'asset.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    }),
  );
}

async function fixture(profile = 'production', historyNavigationAvailable = false) {
  const parsed = frontend.parse(sourceText, {sourceId: 'main'});
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const sourceDescriptor = await createDsl4EmbeddedSourceDescriptor(sourceText, {
    sourceId: 'main',
    displayName: 'story.kamishibai.yaml',
    maxSourceBytes,
    subtleCrypto,
  });
  const created = await createDsl4RuntimeArtifactDescriptor(
    parsed.storyDocument,
    sourceDescriptor,
    profile,
    {maxSourceBytes, historyNavigationAvailable, subtleCrypto},
  );
  assert.equal(created.ok, true, JSON.stringify(created.diagnostics));
  return {
    storyDocument: parsed.storyDocument,
    sourceDescriptor,
    runtimeArtifact: created.artifact,
  };
}

const options = (channel, extra = {}) => ({
  channel,
  maxSourceBytes,
  subtleCrypto,
  ...extra,
});

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof Sb3BuilderError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test('atomically installs and loads a complete component in either channel', async () => {
  const component = await fixture();
  for (const channel of ['unbundled', 'bundled']) {
    const project = baseProject();
    const original = structuredClone(project);
    const installed = await installDsl4RuntimeComponent(
      project,
      component.storyDocument,
      component.sourceDescriptor,
      component.runtimeArtifact,
      options(channel),
    );
    assert.deepEqual(project, original);
    assert.deepEqual(installed.targets, original.targets);
    const loaded = await loadDsl4RuntimeArtifact(installed, frontend, {
      maxSourceBytes,
      subtleCrypto,
    });
    assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
    assert.equal(loaded.channel, channel);
    assert.deepEqual(loaded.sourceDescriptor, component.sourceDescriptor);
    assert.deepEqual(loaded.runtimeArtifact, component.runtimeArtifact);
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(Object.isFrozen(loaded.storyDocument), true);
  }
});

test('rejects partial, opposite-channel, and unauthorized existing storage', async () => {
  const component = await fixture();
  const partial = baseProject();
  partial.extensionStorage.kubohiroyakamishibairuntime4 = {
    source: component.sourceDescriptor,
  };
  await rejectsCode(
    installDsl4RuntimeComponent(
      partial,
      component.storyDocument,
      component.sourceDescriptor,
      component.runtimeArtifact,
      options('unbundled', {replaceExisting: true}),
    ),
    'K4-RUNTIME-COMPONENT-PARTIAL',
  );

  const installed = await installDsl4RuntimeComponent(
    baseProject(),
    component.storyDocument,
    component.sourceDescriptor,
    component.runtimeArtifact,
    options('unbundled'),
  );
  await rejectsCode(
    installDsl4RuntimeComponent(
      installed,
      component.storyDocument,
      component.sourceDescriptor,
      component.runtimeArtifact,
      options('unbundled'),
    ),
    'K4-RUNTIME-COMPONENT-STORAGE-EXISTS',
  );
  const replaced = await installDsl4RuntimeComponent(
    installed,
    component.storyDocument,
    component.sourceDescriptor,
    component.runtimeArtifact,
    options('unbundled', {replaceExisting: true}),
  );
  assert.deepEqual(replaced, installed);
  await rejectsCode(
    installDsl4RuntimeComponent(
      installed,
      component.storyDocument,
      component.sourceDescriptor,
      component.runtimeArtifact,
      options('bundled', {replaceExisting: true}),
    ),
    'K4-RUNTIME-COMPONENT-CHANNEL-AMBIGUOUS',
  );
});

test('embeds the pair deterministically without changing graph or other archive entries', async () => {
  const component = await fixture();
  const input = baseSb3();
  const inputCopy = Buffer.from(input);
  const first = await embedDsl4RuntimeComponentInSb3(
    input,
    component.storyDocument,
    component.sourceDescriptor,
    component.runtimeArtifact,
    options('bundled'),
  );
  const second = await embedDsl4RuntimeComponentInSb3(
    input,
    component.storyDocument,
    component.sourceDescriptor,
    component.runtimeArtifact,
    options('bundled'),
  );
  assert.deepEqual(input, inputCopy);
  assert.deepEqual(first.bytes, second.bytes);
  assert.deepEqual(first.project.targets, baseProject().targets);
  const inputArchive = unzipSync(input);
  const outputArchive = unzipSync(first.bytes);
  assert.deepEqual(outputArchive['asset.svg'], inputArchive['asset.svg']);
});

test('loader withholds artifacts on parse, missing, ambiguous, mismatch, and integrity errors', async () => {
  const component = await fixture();
  const valid = await installDsl4RuntimeComponent(
    baseProject(),
    component.storyDocument,
    component.sourceDescriptor,
    component.runtimeArtifact,
    options('unbundled'),
  );
  const cases = [];

  const missing = structuredClone(valid);
  delete missing.extensionStorage.kubohiroyakamishibairuntime4.artifact;
  cases.push([missing, 'K4-ARTIFACT-CHANNEL-MISSING']);

  const mismatch = structuredClone(valid);
  mismatch.extensionStorage.kubohiroyakamishibai4 = {
    components: {
      kubohiroyakamishibairuntime4: {
        artifact: mismatch.extensionStorage.kubohiroyakamishibairuntime4.artifact,
      },
    },
  };
  delete mismatch.extensionStorage.kubohiroyakamishibairuntime4.artifact;
  cases.push([mismatch, 'K4-ARTIFACT-CHANNEL-MISMATCH']);

  const ambiguous = structuredClone(valid);
  ambiguous.extensionStorage.kubohiroyakamishibai4 = {
    components: {
      kubohiroyakamishibairuntime4: {
        artifact: ambiguous.extensionStorage.kubohiroyakamishibairuntime4.artifact,
      },
    },
  };
  cases.push([ambiguous, 'K4-ARTIFACT-CHANNEL-AMBIGUOUS']);

  const tampered = structuredClone(valid);
  tampered.extensionStorage.kubohiroyakamishibairuntime4.artifact.sourceIntegrity = `sha256-${'A'.repeat(43)}=`;
  cases.push([tampered, 'K4-ARTIFACT-SOURCE-001']);

  for (const [project, code] of cases) {
    const loaded = await loadDsl4RuntimeArtifact(project, frontend, {
      maxSourceBytes,
      subtleCrypto,
    });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.diagnostics[0].code, code);
    assert.equal(Object.hasOwn(loaded, 'runtimeArtifact'), false);
  }

  const invalidSource = structuredClone(valid);
  const invalidDescriptor = await createDsl4EmbeddedSourceDescriptor('not: [valid', {
    sourceId: 'main',
    displayName: 'story.kamishibai.yaml',
    maxSourceBytes,
    subtleCrypto,
  });
  invalidSource.extensionStorage.kubohiroyakamishibairuntime4.source = invalidDescriptor;
  const invalid = await loadDsl4RuntimeArtifact(invalidSource, frontend, {
    maxSourceBytes,
    subtleCrypto,
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.diagnostics[0].code, /^K4-/u);
  assert.equal(Object.hasOwn(invalid, 'runtimeArtifact'), false);
});
