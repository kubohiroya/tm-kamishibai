import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {test} from 'vitest';

import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';

import {
  embedDsl4SourceInSb3,
  installDsl4EmbeddedSource,
  Sb3BuilderError,
} from '../src/builder/index.js';
import {createDsl4EmbeddedSourceDescriptor, resolveDsl4EmbeddedSource} from '../src/dsl4/index.js';

const subtleCrypto = webcrypto.subtle;
const maxSourceBytes = 4096;

function baseProject() {
  return {
    extensionStorage: {localstorage: {namespace: 'kamishibai'}},
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {score: ['score', 7]},
        lists: {},
        broadcasts: {},
        blocks: {
          start: {
            opcode: 'event_whenflagclicked',
            next: null,
            parent: null,
            inputs: {},
            fields: {},
            shadow: false,
            topLevel: true,
            x: 0,
            y: 0,
          },
        },
      },
    ],
    monitors: [],
    extensions: [],
    meta: {semver: '3.0.0'},
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

async function descriptor(source = "kamishibai: '4.0'\nscenes:\n  opening: []\n") {
  return createDsl4EmbeddedSourceDescriptor(source, {
    sourceId: 'main',
    displayName: 'story.kamishibai.yaml',
    maxSourceBytes,
    subtleCrypto,
  });
}

const storageOptions = (channel, extra = {}) => ({
  channel,
  maxSourceBytes,
  subtleCrypto,
  ...extra,
});

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof Sb3BuilderError, true);
    assert.equal(error.code, code);
    assert.equal(error.stage, 'dsl4-source');
    return true;
  });
}

test('installs each explicit source channel without changing the input project', async () => {
  const source = await descriptor();
  for (const channel of ['unbundled', 'bundled']) {
    const project = baseProject();
    const original = structuredClone(project);
    const output = await installDsl4EmbeddedSource(project, source, storageOptions(channel));
    assert.deepEqual(project, original);
    assert.deepEqual(output.targets, original.targets);
    assert.deepEqual(output.monitors, original.monitors);
    if (channel === 'unbundled') {
      assert.equal(Object.hasOwn(output.extensionStorage, 'kubohiroyakamishibai4'), false);
    } else {
      assert.equal(Object.hasOwn(output.extensionStorage, 'kubohiroyakamishibairuntime4'), false);
    }
    const resolved = await resolveDsl4EmbeddedSource(output, {
      maxSourceBytes,
      subtleCrypto,
    });
    assert.equal(resolved.channel, channel);
    assert.deepEqual(resolved.descriptor, source);
  }
});

test('requires an explicit known channel and validates descriptor integrity', async () => {
  const source = await descriptor();
  await rejectsCode(
    installDsl4EmbeddedSource(baseProject(), source, storageOptions(undefined)),
    'K4-SOURCE-CHANNEL-001',
  );
  await rejectsCode(
    installDsl4EmbeddedSource(baseProject(), source, storageOptions('automatic')),
    'K4-SOURCE-CHANNEL-001',
  );
  await rejectsCode(
    installDsl4EmbeddedSource(
      baseProject(),
      {...source, integrity: `sha256-${'A'.repeat(43)}=`},
      storageOptions('unbundled'),
    ),
    'K4-SOURCE-INTEGRITY-001',
  );
});

test('requires explicit replacement and rejects an opposite-channel source', async () => {
  const first = await descriptor();
  const second = await descriptor("kamishibai: '4.0'\nscenes:\n  replacement: []\n");
  const installed = await installDsl4EmbeddedSource(
    baseProject(),
    first,
    storageOptions('unbundled'),
  );
  await rejectsCode(
    installDsl4EmbeddedSource(installed, second, storageOptions('unbundled')),
    'K4-SOURCE-STORAGE-EXISTS',
  );
  const replaced = await installDsl4EmbeddedSource(
    installed,
    second,
    storageOptions('unbundled', {replaceExisting: true}),
  );
  const resolvedReplacement = await resolveDsl4EmbeddedSource(replaced, {
    maxSourceBytes,
    subtleCrypto,
  });
  assert.deepEqual(resolvedReplacement.descriptor, second);

  await rejectsCode(
    installDsl4EmbeddedSource(
      installed,
      second,
      storageOptions('bundled', {replaceExisting: true}),
    ),
    'K4-SOURCE-CHANNEL-AMBIGUOUS',
  );
});

test('embeds into a deterministic SB3 while preserving target graph and asset bytes', async () => {
  const source = await descriptor();
  const input = baseSb3();
  const inputCopy = Buffer.from(input);
  const first = await embedDsl4SourceInSb3(input, source, storageOptions('bundled'));
  const second = await embedDsl4SourceInSb3(input, source, storageOptions('bundled'));
  assert.deepEqual(input, inputCopy);
  assert.deepEqual(first.bytes, second.bytes);

  const inputArchive = unzipSync(new Uint8Array(input));
  const outputArchive = unzipSync(new Uint8Array(first.bytes));
  assert.deepEqual(outputArchive['asset.svg'], inputArchive['asset.svg']);
  assert.deepEqual(Object.keys(outputArchive).sort(), Object.keys(inputArchive).sort());
  const outputProject = JSON.parse(strFromU8(outputArchive['project.json']));
  assert.deepEqual(outputProject.targets, baseProject().targets);
  assert.deepEqual(outputProject.monitors, baseProject().monitors);
  const resolved = await resolveDsl4EmbeddedSource(outputProject, {
    maxSourceBytes,
    subtleCrypto,
  });
  assert.equal(resolved.channel, 'bundled');
  assert.deepEqual(resolved.descriptor, source);
});
