import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {loadDsl4LocalAssetSnapshot} from '../src/builder/index.js';
import {createDsl4SourceFrontend} from '../src/dsl4/index.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const standardLimits = {maxFileBytes: 1024, maxFiles: 20, maxTotalBytes: 4096};

function parseStory(source) {
  const result = frontend.parse(source, {sourceId: 'local-asset-test'});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.storyDocument;
}

function sri(bytes) {
  return `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsl4-local-assets-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'assets'), {recursive: true});
  await mkdir(path.join(root, 'models', 'rescue', 'nested'), {recursive: true});
  const files = {
    ocean: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    hero: Buffer.from('fake-png'),
    sound: Buffer.from('fake-wav'),
    model: Buffer.from('{"model":"rescue"}'),
    metadata: Buffer.from('{"labels":["help"]}'),
    weights: Buffer.from([1, 2, 3, 4]),
  };
  await Promise.all([
    writeFile(path.join(root, 'assets', 'ocean.svg'), files.ocean),
    writeFile(path.join(root, 'assets', 'hero.png'), files.hero),
    writeFile(path.join(root, 'assets', 'effect.wav'), files.sound),
    writeFile(path.join(root, 'models', 'rescue', 'model.json'), files.model),
    writeFile(path.join(root, 'models', 'rescue', 'metadata.json'), files.metadata),
    writeFile(path.join(root, 'models', 'rescue', 'nested', 'weights.bin'), files.weights),
  ]);
  return {root, files};
}

function comprehensiveStory() {
  return parseStory(`
kamishibai: '4.0'
assets:
  ProjectBackdrop: backdrop
  NamedSound:
    kind: sound
    name: Existing Sound
    loading: lazy
  Ocean:
    kind: backdrop
    file: assets/ocean.svg
    loading: lazy
  Hero:
    kind: costume
    target: Actor
    file: assets/hero.png
    bitmapResolution: 2
  Effect:
    kind: sound
    file: assets/effect.wav
  RescuePose:
    kind: poseModel
    file: models/rescue
    loading: lazy
actors:
  Actor: Hero
scenes:
  opening:
    poseModel: RescuePose
    actions:
      - stage: Ocean
      - sound: Effect
`);
}

test('snapshots project refs, image, sound, and a poseModel directory deterministically', async (t) => {
  const fixture = await workspace(t);
  const storyDocument = comprehensiveStory();
  const originalStory = structuredClone(storyDocument);
  const snapshot = await loadDsl4LocalAssetSnapshot(fixture.root, storyDocument, {
    ...standardLimits,
    subtleCrypto: webcrypto.subtle,
  });

  assert.deepEqual(
    snapshot.manifest.assets.map(({id}) => id),
    ['Effect', 'Hero', 'NamedSound', 'Ocean', 'ProjectBackdrop', 'RescuePose'],
  );
  const byId = Object.fromEntries(snapshot.manifest.assets.map((asset) => [asset.id, asset]));
  assert.deepEqual(byId.ProjectBackdrop.source, {type: 'project', name: 'ProjectBackdrop'});
  assert.deepEqual(byId.NamedSound.source, {type: 'project', name: 'Existing Sound'});
  assert.equal(byId.Hero.bitmapResolution, 2);
  assert.deepEqual(byId.Ocean.source, {
    type: 'file',
    inputPath: 'assets/ocean.svg',
    mode: 'file',
    files: [
      {path: 'ocean.svg', size: fixture.files.ocean.length, integrity: sri(fixture.files.ocean)},
    ],
  });
  assert.deepEqual(
    byId.RescuePose.source.files.map(({path: filePath}) => filePath),
    ['metadata.json', 'model.json', 'nested/weights.bin'],
  );
  assert.deepEqual(
    byId.RescuePose.source.files.map(({integrity}) => integrity),
    [sri(fixture.files.metadata), sri(fixture.files.model), sri(fixture.files.weights)],
  );
  assert.equal(JSON.stringify(snapshot.manifest).includes(fixture.root), false);
  assert.equal(Object.isFrozen(snapshot.manifest), true);
  assert.equal(Object.isFrozen(snapshot.manifest.assets), true);
  assert.equal(Object.isFrozen(byId.RescuePose.source.files), true);
  assert.deepEqual(storyDocument, originalStory);

  const first = snapshot.getFile('Ocean', 'ocean.svg');
  first[0] ^= 0xff;
  assert.deepEqual(snapshot.getFile('Ocean', 'ocean.svg'), fixture.files.ocean);
  assert.throws(
    () => snapshot.getFile('Ocean', 'missing.svg'),
    (error) => error.code === 'K4-ASSET-LOOKUP-001' && error.stage === 'dsl4-local-assets',
  );
});

test('records remote metadata without reading or embedding remote bytes', async (t) => {
  const fixture = await workspace(t);
  const storyDocument = parseStory(`
kamishibai: '4.0'
assets:
  Remote:
    kind: backdrop
    delivery: remote
    loading: lazy
    source:
      url: https://cdn.example.com/remote.svg
      integrity: sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      contentType: image/svg+xml
      size: 123456
scenes:
  opening:
    - stage: Remote
`);
  const snapshot = await loadDsl4LocalAssetSnapshot(fixture.root, storyDocument, {
    ...standardLimits,
    subtleCrypto: webcrypto.subtle,
  });
  assert.deepEqual(snapshot.manifest.assets, [
    {
      id: 'Remote',
      kind: 'backdrop',
      loading: 'lazy',
      bitmapResolution: 1,
      source: {
        type: 'remote',
        url: 'https://cdn.example.com/remote.svg',
        integrity: 'sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        contentType: 'image/svg+xml',
        size: 123456,
      },
    },
  ]);
  assert.throws(
    () => snapshot.getFile('Remote', 'remote.svg'),
    (error) => error.code === 'K4-ASSET-LOOKUP-001',
  );
});

test('snapshots a target-independent image file without a Scratch target', async (t) => {
  const fixture = await workspace(t);
  const storyDocument = parseStory(`
kamishibai: '4.0'
assets:
  ControlIcon:
    kind: image
    file: assets/ocean.svg
scenes:
  opening: []
`);
  const snapshot = await loadDsl4LocalAssetSnapshot(fixture.root, storyDocument, {
    ...standardLimits,
    subtleCrypto: webcrypto.subtle,
  });
  assert.equal(snapshot.manifest.assets[0].kind, 'image');
  assert.equal('target' in snapshot.manifest.assets[0], false);
  assert.deepEqual(snapshot.manifest.assets[0].source, {
    type: 'file',
    inputPath: 'assets/ocean.svg',
    mode: 'file',
    files: [
      {path: 'ocean.svg', size: fixture.files.ocean.length, integrity: sri(fixture.files.ocean)},
    ],
  });
});

test('rejects non-normalized and non-local locators before filesystem access', async (t) => {
  const fixture = await workspace(t);
  const base = comprehensiveStory();
  for (const locator of [
    '/absolute.svg',
    'C:/absolute.svg',
    'https://example.com/asset.svg',
    '../escape.svg',
    './asset.svg',
    'assets//ocean.svg',
    'assets\\ocean.svg',
  ]) {
    const story = structuredClone(base);
    story.assets.Ocean.file = locator;
    await assert.rejects(
      loadDsl4LocalAssetSnapshot(fixture.root, story, {
        ...standardLimits,
        subtleCrypto: webcrypto.subtle,
      }),
      (error) => error.code === 'K4-ASSET-PATH-001' && error.stage === 'dsl4-local-assets',
    );
  }
});

test('rejects root escape, asset symlinks, nested symlinks, and wrong file kinds', async (t) => {
  const fixture = await workspace(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'dsl4-local-assets-outside-'));
  t.after(() => rm(outside, {recursive: true, force: true}));
  await writeFile(path.join(outside, 'outside.svg'), 'outside');
  await symlink(path.join(outside, 'outside.svg'), path.join(fixture.root, 'assets', 'link.svg'));
  await symlink(outside, path.join(fixture.root, 'assets', 'escape'));
  await symlink(
    path.join(outside, 'outside.svg'),
    path.join(fixture.root, 'models', 'rescue', 'nested-link'),
  );

  const cases = [
    ['assets/link.svg', 'backdrop', 'K4-ASSET-SYMLINK-001'],
    ['assets/escape/outside.svg', 'backdrop', 'K4-ASSET-PATH-001'],
    ['models/rescue', 'poseModel', 'K4-ASSET-SYMLINK-001'],
    ['models/rescue', 'backdrop', 'K4-ASSET-FILE-001'],
  ];
  for (const [file, kind, code] of cases) {
    const story = parseStory(`
kamishibai: '4.0'
assets:
  Unsafe:
    kind: ${kind}
    file: ${file}
scenes:
  opening: []
`);
    await assert.rejects(
      loadDsl4LocalAssetSnapshot(fixture.root, story, {
        ...standardLimits,
        subtleCrypto: webcrypto.subtle,
      }),
      (error) => error.code === code,
    );
  }
});

test('enforces explicit file, count, and total byte limits', async (t) => {
  const fixture = await workspace(t);
  const story = comprehensiveStory();
  for (const [limits, code] of [
    [{...standardLimits, maxFileBytes: 3}, 'K4-ASSET-SIZE-001'],
    [{...standardLimits, maxFiles: 2}, 'K4-ASSET-COUNT-001'],
    [{...standardLimits, maxTotalBytes: 10}, 'K4-ASSET-TOTAL-SIZE-001'],
  ]) {
    await assert.rejects(
      loadDsl4LocalAssetSnapshot(fixture.root, story, {
        ...limits,
        subtleCrypto: webcrypto.subtle,
      }),
      (error) => error.code === code,
    );
  }
  for (const [name, value] of [
    ['maxFileBytes', 0],
    ['maxFiles', undefined],
    ['maxTotalBytes', Number.POSITIVE_INFINITY],
  ]) {
    const limits = {...standardLimits, [name]: value};
    await assert.rejects(
      loadDsl4LocalAssetSnapshot(fixture.root, story, limits),
      new RegExp(`${name} must be a positive safe integer`, 'u'),
    );
  }
});

test('fails closed when bytes or a poseModel directory changes during snapshot', async (t) => {
  const fixture = await workspace(t);
  const story = parseStory(`
kamishibai: '4.0'
assets:
  Ocean:
    kind: backdrop
    file: assets/ocean.svg
scenes:
  opening: []
`);
  let reads = 0;
  await assert.rejects(
    loadDsl4LocalAssetSnapshot(fixture.root, story, {
      ...standardLimits,
      subtleCrypto: webcrypto.subtle,
      async readFile(filePath) {
        reads += 1;
        const bytes = await readFile(filePath);
        return reads === 1 ? bytes : Buffer.from('changed-without-state-change');
      },
    }),
    (error) => error.code === 'K4-ASSET-UNSTABLE-001',
  );

  const poseStory = parseStory(`
kamishibai: '4.0'
assets:
  Pose:
    kind: poseModel
    file: models/rescue
scenes:
  opening: []
`);
  let added = false;
  await assert.rejects(
    loadDsl4LocalAssetSnapshot(fixture.root, poseStory, {
      ...standardLimits,
      subtleCrypto: webcrypto.subtle,
      async readFile(filePath) {
        const bytes = await readFile(filePath);
        if (!added) {
          added = true;
          await writeFile(path.join(fixture.root, 'models', 'rescue', 'added.json'), '{}');
        }
        return bytes;
      },
    }),
    (error) => error.code === 'K4-ASSET-UNSTABLE-001',
  );
});
