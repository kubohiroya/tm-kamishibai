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
import {thrown} from './helpers/thrown-error.ts';
import {requireRecord, requireString} from './helpers/require-value.ts';
import {firstDiagnostic, okResult} from './helpers/result-outcome.ts';

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
    runtimeArtifact: okResult(created, 'the created runtime artifact').artifact,
  };
}

type InstallOptions = Parameters<typeof installDsl4RuntimeComponent>[4];

/** Read one project's runtime component storage, which the cases below rewrite on purpose. */
function runtimeStorage(project: {extensionStorage?: unknown}) {
  return requireRecord(
    requireRecord(project.extensionStorage, 'the extension storage').kubohiroyakamishibairuntime4,
    'the runtime component storage',
  );
}

/**
 * Build the install options one case uses.
 *
 * Some cases pass a channel the contract does not allow, to prove the installer refuses it, so the
 * channel arrives as `unknown` and the result is declared as what the installer expects.
 */
const options = (channel: unknown, extra: Record<string, unknown> = {}) =>
  ({
    channel,
    maxSourceBytes,
    subtleCrypto,
    ...extra,
  }) as unknown as InstallOptions;

async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof Sb3BuilderError, true);
    assert.equal(thrown(error).code, code);
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
    const component2 = okResult(loaded, 'the loaded runtime component');
    assert.equal(component2.channel, channel);
    assert.deepEqual(component2.sourceDescriptor, component.sourceDescriptor);
    assert.deepEqual(component2.runtimeArtifact, component.runtimeArtifact);
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(Object.isFrozen(component2.storyDocument), true);
  }
});

test('rejects partial, opposite-channel, and unauthorized existing storage', async () => {
  const component = await fixture();
  const partial = baseProject();
  requireRecord(partial.extensionStorage, 'the extension storage').kubohiroyakamishibairuntime4 = {
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
  const cases: [unknown, string][] = [];

  const missing = structuredClone(valid);
  delete runtimeStorage(missing).artifact;
  cases.push([missing, 'K4-ARTIFACT-CHANNEL-MISSING']);

  const mismatch = structuredClone(valid);
  requireRecord(mismatch.extensionStorage, 'the extension storage').kubohiroyakamishibai4 = {
    components: {
      kubohiroyakamishibairuntime4: {
        artifact: runtimeStorage(mismatch).artifact,
      },
    },
  };
  delete runtimeStorage(mismatch).artifact;
  cases.push([mismatch, 'K4-ARTIFACT-CHANNEL-MISMATCH']);

  const ambiguous = structuredClone(valid);
  requireRecord(ambiguous.extensionStorage, 'the extension storage').kubohiroyakamishibai4 = {
    components: {
      kubohiroyakamishibairuntime4: {
        artifact: runtimeStorage(ambiguous).artifact,
      },
    },
  };
  cases.push([ambiguous, 'K4-ARTIFACT-CHANNEL-AMBIGUOUS']);

  const tampered = structuredClone(valid);
  requireRecord(runtimeStorage(tampered).artifact, 'the stored artifact').sourceIntegrity =
    `sha256-${'A'.repeat(43)}=`;
  cases.push([tampered, 'K4-ARTIFACT-SOURCE-001']);

  for (const [project, code] of cases) {
    const loaded = await loadDsl4RuntimeArtifact(project, frontend, {
      maxSourceBytes,
      subtleCrypto,
    });
    assert.equal(loaded.ok, false);
    assert.equal(firstDiagnostic(loaded, 'the load result').code, code);
    assert.equal(Object.hasOwn(loaded, 'runtimeArtifact'), false);
  }

  const invalidSource = structuredClone(valid);
  const invalidDescriptor = await createDsl4EmbeddedSourceDescriptor('not: [valid', {
    sourceId: 'main',
    displayName: 'story.kamishibai.yaml',
    maxSourceBytes,
    subtleCrypto,
  });
  runtimeStorage(invalidSource).source = invalidDescriptor;
  const invalid = await loadDsl4RuntimeArtifact(invalidSource, frontend, {
    maxSourceBytes,
    subtleCrypto,
  });
  assert.equal(invalid.ok, false);
  assert.match(
    requireString(firstDiagnostic(invalid, 'the load result').code, 'the diagnostic code'),
    /^K4-/u,
  );
  assert.equal(Object.hasOwn(invalid, 'runtimeArtifact'), false);
});
