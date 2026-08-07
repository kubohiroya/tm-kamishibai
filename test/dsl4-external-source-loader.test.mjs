import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ensureDsl4ExternalSourceCacheIdentity,
  loadDsl4ExternalSource,
  Sb3BuilderError,
  validateDsl4ExternalSourceManifest,
} from '../src/builder/index.js';
import {
  dsl4RecommendedSourceFilenameSuffix,
  dsl4SourceFilenameSuffixes,
  hasDsl4SourceFilenameSuffix,
} from '../src/dsl4/source-filename.js';

const subtleCrypto = webcrypto.subtle;
const maxSourceBytes = 4096;
const validManifest = Object.freeze({
  formatVersion: 1,
  mode: 'external',
  sourceId: 'main',
  path: 'story.kamishibai.yaml',
});

test('defines the recommended and backward-compatible DSL 4 source suffixes', () => {
  assert.equal(dsl4RecommendedSourceFilenameSuffix, '.k4.yml');
  assert.deepEqual(dsl4SourceFilenameSuffixes, [
    '.k4.yml',
    '.k4.yaml',
    '.kamishibai.yml',
    '.kamishibai.yaml',
  ]);
  assert.equal(Object.isFrozen(dsl4SourceFilenameSuffixes), true);
  assert.equal(hasDsl4SourceFilenameSuffix('chapter.k4.yml'), true);
  assert.equal(hasDsl4SourceFilenameSuffix('chapter.yml'), false);
});

test('creates one stable cache identity and preserves its database name across renames', async () => {
  const created = ensureDsl4ExternalSourceCacheIdentity(validManifest, {
    createStableId: () => 'story000000000001',
  });
  assert.equal(created.created, true);
  assert.deepEqual(created.cacheIdentity, {
    id: 'story000000000001',
    label: 'story.kamishibai.yaml',
    databaseName: 'tw-kamishibai-assets-v1--story--story000000000001',
  });
  const renamed = ensureDsl4ExternalSourceCacheIdentity({
    ...created.manifest,
    path: 'renamed.kamishibai.yaml',
  });
  assert.equal(renamed.created, false);
  assert.equal(renamed.cacheIdentity.label, 'renamed.kamishibai.yaml');
  assert.equal(renamed.cacheIdentity.databaseName, created.cacheIdentity.databaseName);

  await withTemporaryDirectory(async (directory) => {
    await writeFile(
      path.join(directory, 'story.kamishibai.yaml'),
      "kamishibai: '4.0'\nscenes: {}\n",
    );
    const loaded = await loadDsl4ExternalSource(directory, created.manifest, {
      maxSourceBytes,
      subtleCrypto,
    });
    assert.deepEqual(loaded.descriptor.cacheIdentity, created.cacheIdentity);
  });
});

async function withTemporaryDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsl4-source-loader-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof Sb3BuilderError, true);
    assert.equal(error.code, code);
    assert.equal(error.stage, 'dsl4-external-source');
    return true;
  });
}

test('strictly validates the external manifest and returns an immutable copy', () => {
  const input = {...validManifest};
  const validated = validateDsl4ExternalSourceManifest(input);
  assert.deepEqual(validated, validManifest);
  assert.notStrictEqual(validated, input);
  assert.equal(Object.isFrozen(validated), true);
  assert.deepEqual(input, validManifest);

  const defaulted = validateDsl4ExternalSourceManifest({
    formatVersion: 1,
    mode: 'external',
    sourceId: 'main',
  });
  assert.deepEqual(defaulted, validManifest);

  for (const invalid of [
    {...validManifest, mode: 'embedded'},
    {...validManifest, extra: true},
    {formatVersion: 1, mode: 'external'},
    {...validManifest, cacheId: 'story000000000001'},
    {...validManifest, cacheDatabaseName: 'tw-kamishibai-assets-v1--story--story000000000001'},
  ]) {
    assert.throws(
      () => validateDsl4ExternalSourceManifest(invalid),
      (error) => error instanceof Sb3BuilderError && error.code === 'K4-SOURCE-MANIFEST-001',
    );
  }
});

test('accepts only a root-level source basename', () => {
  for (const sourcePath of [
    'story.k4.yml',
    'story.k4.yaml',
    'story.kamishibai.yml',
    'story.kamishibai.yaml',
  ]) {
    assert.equal(
      validateDsl4ExternalSourceManifest({...validManifest, path: sourcePath}).path,
      sourcePath,
    );
  }
  for (const sourcePath of [
    '',
    '/story.kamishibai.yaml',
    'C:/story.kamishibai.yaml',
    'https://example.com/story.kamishibai.yaml',
    'scripts/story.kamishibai.yaml',
    'scripts\\story.kamishibai.yaml',
    './story.kamishibai.yaml',
    'scripts/../story.kamishibai.yaml',
    'scripts//story.kamishibai.yaml',
    'story.yaml',
    'story.K4.YML',
  ]) {
    assert.throws(
      () => validateDsl4ExternalSourceManifest({...validManifest, path: sourcePath}),
      (error) => error instanceof Sb3BuilderError && error.code === 'K4-SOURCE-PATH-001',
      sourcePath,
    );
  }
});

test('loads a canonical immutable descriptor without exposing or changing the source path', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = path.join(directory, 'story.kamishibai.yaml');
    const original = Buffer.from(
      "\uFEFFkamishibai: '4.0'\r\n# 日本語\rscenes:\r\n  opening: []\r\n",
    );
    await writeFile(sourcePath, original);
    const loaded = await loadDsl4ExternalSource(directory, validManifest, {
      maxSourceBytes,
      subtleCrypto,
    });
    assert.deepEqual(loaded.manifest, validManifest);
    assert.equal(loaded.descriptor.text.includes('\r'), false);
    assert.equal(loaded.descriptor.text.startsWith('\uFEFF'), false);
    assert.equal(loaded.descriptor.displayName, 'story.kamishibai.yaml');
    assert.equal(loaded.descriptor.sourceId, 'main');
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(Object.isFrozen(loaded.descriptor), true);
    assert.equal(JSON.stringify(loaded).includes(directory), false);
    assert.deepEqual(await readFile(sourcePath), original);
  });
});

test('rejects missing source, directories, root escape, and symlink escape', async () => {
  await withTemporaryDirectory(async (directory) => {
    await rejectsCode(
      loadDsl4ExternalSource(directory, validManifest, {maxSourceBytes, subtleCrypto}),
      'K4-SOURCE-MISSING',
    );

    const directorySource = path.join(directory, 'folder.kamishibai.yaml');
    await mkdir(directorySource);
    await rejectsCode(
      loadDsl4ExternalSource(
        directory,
        {...validManifest, path: 'folder.kamishibai.yaml'},
        {maxSourceBytes, subtleCrypto},
      ),
      'K4-SOURCE-FILE-001',
    );

    const outside = await mkdtemp(path.join(os.tmpdir(), 'dsl4-source-outside-'));
    try {
      const outsideSource = path.join(outside, 'story.kamishibai.yaml');
      await writeFile(outsideSource, "kamishibai: '4.0'\nscenes: {}\n");
      await symlink(outsideSource, path.join(directory, 'story.kamishibai.yaml'));
      await rejectsCode(
        loadDsl4ExternalSource(directory, validManifest, {maxSourceBytes, subtleCrypto}),
        'K4-SOURCE-PATH-001',
      );
    } finally {
      await rm(outside, {recursive: true, force: true});
    }
  });
});

test('rejects invalid UTF-8 and a canonical source over the explicit limit', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = path.join(directory, 'story.kamishibai.yaml');
    await writeFile(sourcePath, Buffer.from([0xc3, 0x28]));
    await rejectsCode(
      loadDsl4ExternalSource(directory, validManifest, {maxSourceBytes, subtleCrypto}),
      'K4-SOURCE-UTF8-001',
    );

    await writeFile(sourcePath, '12345');
    await rejectsCode(
      loadDsl4ExternalSource(directory, validManifest, {maxSourceBytes: 4, subtleCrypto}),
      'K4-SOURCE-SIZE-001',
    );

    await writeFile(sourcePath, '123456789012');
    await rejectsCode(
      loadDsl4ExternalSource(directory, validManifest, {maxSourceBytes: 4, subtleCrypto}),
      'K4-SOURCE-SIZE-001',
    );
  });
});

test('accepts bounded CRLF overhead but rejects bytes that change between reads', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourcePath = path.join(directory, 'story.kamishibai.yaml');
    await writeFile(sourcePath, 'a\r\nb\r\n');
    const loaded = await loadDsl4ExternalSource(directory, validManifest, {
      maxSourceBytes: 4,
      subtleCrypto,
    });
    assert.equal(loaded.descriptor.text, 'a\nb\n');

    let reads = 0;
    const changingReader = async (filePath) => {
      reads += 1;
      return reads === 1 ? readFile(filePath) : Buffer.from('changed');
    };
    await rejectsCode(
      loadDsl4ExternalSource(directory, validManifest, {
        maxSourceBytes,
        subtleCrypto,
        readSource: changingReader,
      }),
      'K4-PREVIEW-SOURCE-UNSTABLE',
    );
  });
});
