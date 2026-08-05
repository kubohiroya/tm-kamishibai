import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  createDsl4EmbeddedSourceDescriptor,
  Dsl4SourceDescriptorError,
  dsl4SourceStoragePaths,
  resolveDsl4EmbeddedSource,
  validateDsl4EmbeddedSourceDescriptor,
} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const subtleCrypto = webcrypto.subtle;
const options = {maxSourceBytes: 4096, subtleCrypto};

function sri(value) {
  return `sha256-${createHash('sha256').update(value).digest('base64')}`;
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof Dsl4SourceDescriptorError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test('creates a canonical immutable UTF-8 descriptor with SHA-256 SRI', async () => {
  const descriptor = await createDsl4EmbeddedSourceDescriptor(
    "\uFEFFkamishibai: '4.0'\r\n# 日本語\rscenes:\r\n  opening: []\r\n",
    {
      sourceId: 'main',
      displayName: 'story.kamishibai.yaml',
      ...options,
    },
  );
  const expectedText = "kamishibai: '4.0'\n# 日本語\nscenes:\n  opening: []\n";
  assert.deepEqual(descriptor, {
    formatVersion: 1,
    mode: 'embedded',
    sourceId: 'main',
    displayName: 'story.kamishibai.yaml',
    mediaType: 'application/yaml',
    encoding: 'utf-8',
    byteLength: new TextEncoder().encode(expectedText).length,
    integrity: sri(expectedText),
    text: expectedText,
  });
  assert.equal(Object.isFrozen(descriptor), true);
});

test('validates a JSON-round-tripped descriptor into a frozen copy', async () => {
  const created = await createDsl4EmbeddedSourceDescriptor("kamishibai: '4.0'\nscenes: {}\n", {
    sourceId: 'main',
    displayName: 'story.kamishibai.yaml',
    ...options,
  });
  const roundTripped = JSON.parse(JSON.stringify(created));
  const validated = await validateDsl4EmbeddedSourceDescriptor(roundTripped, options);
  assert.deepEqual(validated, created);
  assert.notStrictEqual(validated, roundTripped);
  assert.equal(Object.isFrozen(validated), true);
});

test('rejects non-canonical text, unknown keys, and mismatched metadata', async () => {
  const descriptor = await createDsl4EmbeddedSourceDescriptor("kamishibai: '4.0'\nscenes: {}\n", {
    sourceId: 'main',
    displayName: 'story.kamishibai.yaml',
    ...options,
  });
  await rejectsCode(
    validateDsl4EmbeddedSourceDescriptor(
      {...descriptor, text: descriptor.text.replaceAll('\n', '\r\n')},
      options,
    ),
    'K4-SOURCE-DESCRIPTOR-001',
  );
  await rejectsCode(
    validateDsl4EmbeddedSourceDescriptor({...descriptor, extra: true}, options),
    'K4-SOURCE-DESCRIPTOR-001',
  );
  const missingText = {...descriptor};
  delete missingText.text;
  await rejectsCode(
    validateDsl4EmbeddedSourceDescriptor(missingText, options),
    'K4-SOURCE-DESCRIPTOR-001',
  );
  await rejectsCode(
    validateDsl4EmbeddedSourceDescriptor(
      {...descriptor, byteLength: descriptor.byteLength + 1},
      options,
    ),
    'K4-SOURCE-DESCRIPTOR-001',
  );
  await rejectsCode(
    validateDsl4EmbeddedSourceDescriptor({...descriptor, integrity: sri('different')}, options),
    'K4-SOURCE-INTEGRITY-001',
  );
  await rejectsCode(
    validateDsl4EmbeddedSourceDescriptor(
      {...descriptor, displayName: '../story.kamishibai.yaml'},
      options,
    ),
    'K4-SOURCE-DESCRIPTOR-001',
  );
});

test('requires an explicit finite byte limit and rejects oversized canonical source', async () => {
  await assert.rejects(
    validateDsl4EmbeddedSourceDescriptor(
      {},
      {maxSourceBytes: Number.POSITIVE_INFINITY, subtleCrypto},
    ),
    /maxSourceBytes/u,
  );
  await rejectsCode(
    createDsl4EmbeddedSourceDescriptor('12345', {
      sourceId: 'main',
      displayName: 'story.kamishibai.yaml',
      maxSourceBytes: 4,
      subtleCrypto,
    }),
    'K4-SOURCE-SIZE-001',
  );
});

test('resolves unbundled and bundled storage without mutating the project', async () => {
  const descriptor = await createDsl4EmbeddedSourceDescriptor("kamishibai: '4.0'\nscenes: {}\n", {
    sourceId: 'main',
    displayName: 'story.kamishibai.yaml',
    ...options,
  });
  const unbundledProject = {
    extensionStorage: {
      kubohiroyakamishibairuntime4: {source: JSON.parse(JSON.stringify(descriptor))},
    },
  };
  const original = JSON.stringify(unbundledProject);
  const unbundled = await resolveDsl4EmbeddedSource(unbundledProject, options);
  assert.equal(unbundled.channel, 'unbundled');
  assert.equal(unbundled.path, dsl4SourceStoragePaths.unbundled);
  assert.deepEqual(unbundled.descriptor, descriptor);
  assert.equal(JSON.stringify(unbundledProject), original);

  const bundled = await resolveDsl4EmbeddedSource(
    {
      extensionStorage: {
        kubohiroyakamishibai4: {
          components: {kubohiroyakamishibairuntime4: {source: descriptor}},
        },
      },
    },
    options,
  );
  assert.equal(bundled.channel, 'bundled');
  assert.equal(bundled.path, dsl4SourceStoragePaths.bundled);
  assert.equal(Object.isFrozen(bundled), true);
  assert.equal(Object.isFrozen(bundled.descriptor), true);
});

test('fails closed when storage is missing or ambiguous', async () => {
  const descriptor = await createDsl4EmbeddedSourceDescriptor("kamishibai: '4.0'\nscenes: {}\n", {
    sourceId: 'main',
    displayName: 'story.kamishibai.yaml',
    ...options,
  });
  await rejectsCode(resolveDsl4EmbeddedSource({}, options), 'K4-SOURCE-CHANNEL-MISSING');
  await rejectsCode(
    resolveDsl4EmbeddedSource(
      {
        extensionStorage: {
          kubohiroyakamishibairuntime4: {source: descriptor},
          kubohiroyakamishibai4: {
            components: {kubohiroyakamishibairuntime4: {source: descriptor}},
          },
        },
      },
      options,
    ),
    'K4-SOURCE-CHANNEL-AMBIGUOUS',
  );
});

test('source descriptor core has no filesystem, network, DOM, VM, or Scratch dependency', async () => {
  const implementation = await readFile(
    path.join(projectRoot, 'src', 'dsl4', 'source-descriptor.js'),
    'utf8',
  );
  assert.doesNotMatch(implementation, /(?:node:fs|node:http|node:https|\bfetch\s*\()/u);
  assert.doesNotMatch(implementation, /(?:globalThis\.(?:document|window)|KeyboardEvent)/u);
  assert.doesNotMatch(implementation, /(?:\bScratch\b|scratch-vm|vm\.runtime|startHats)/u);
});
