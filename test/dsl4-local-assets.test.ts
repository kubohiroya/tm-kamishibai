import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test, type TestContext} from 'vitest';
import {fileURLToPath} from 'node:url';

import {zipSync} from 'fflate';

import {loadDsl4LocalAssetSnapshot} from '../src/builder/index.js';
import {createDsl4SourceFrontend} from '../src/dsl4/index.js';
import {thrown} from './helpers/thrown-error.ts';
import {requireDefined, requireRecord} from './helpers/require-value.ts';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const standardLimits = {maxFileBytes: 1024, maxFiles: 20, maxTotalBytes: 4096};

/**
 * The story and manifest members this suite reads.
 *
 * The frontend and the loader both declare their documents opaquely, so the shapes the cases walk
 * into are named here once instead of being asserted away at every read.
 */
interface AssetStory extends Readonly<Record<string, unknown>> {
  assets: Record<string, {file?: string}>;
}

interface ManifestFile {
  path: string;
  size: number;
  integrity: string;
}

interface ManifestAssetSource {
  type: string;
  mode?: string;
  files: ManifestFile[];
}

interface ManifestAsset {
  id: string;
  kind: string;
  bitmapResolution?: number;
  source: ManifestAssetSource;
}

type LocalAssetSnapshot = Awaited<ReturnType<typeof loadDsl4LocalAssetSnapshot>>;

/** Read the manifest assets the loader publishes as opaque records. */
function manifestAssets(snapshot: LocalAssetSnapshot): ManifestAsset[] {
  return snapshot.manifest.assets as unknown as ManifestAsset[];
}

/** Read the one manifest asset a case expects the loader to have produced for an id. */
function manifestAsset(snapshot: LocalAssetSnapshot, id: string): ManifestAsset {
  return requireDefined(
    manifestAssets(snapshot).find((asset) => asset.id === id),
    `the manifest asset ${id}`,
  );
}

function parseStory(source: string): AssetStory {
  const result = frontend.parse(source, {sourceId: 'local-asset-test'});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return requireRecord(result.storyDocument, 'the story document') as unknown as AssetStory;
}

function sri(bytes: Uint8Array) {
  return `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
}

async function workspace(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsl4-local-assets-'));
  t.onTestFinished(() => rm(root, {recursive: true, force: true}));
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
    writeFile(
      path.join(root, 'models', 'rescue.ZIP'),
      zipSync({
        'metadata.json': files.metadata,
        'model.json': files.model,
        'weights.bin': files.weights,
      }),
    ),
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
    kind: recognitionModel
    file: models/rescue
    loading: lazy
actors:
  Actor: Hero
scenes:
  opening:
    recognitionModel: RescuePose
    actions:
      - stage: Ocean
      - sound: Effect
`);
}

test('snapshots project refs, image, sound, and a recognitionModel directory deterministically', async (t) => {
  const fixture = await workspace(t);
  const storyDocument = comprehensiveStory();
  const originalStory = structuredClone(storyDocument);
  const snapshot = await loadDsl4LocalAssetSnapshot(fixture.root, storyDocument, {
    ...standardLimits,
    subtleCrypto: webcrypto.subtle,
  });

  assert.deepEqual(
    manifestAssets(snapshot).map(({id}) => id),
    ['Effect', 'Hero', 'NamedSound', 'Ocean', 'ProjectBackdrop', 'RescuePose'],
  );
  assert.deepEqual(manifestAsset(snapshot, 'ProjectBackdrop').source, {
    type: 'project',
    name: 'ProjectBackdrop',
  });
  assert.deepEqual(manifestAsset(snapshot, 'NamedSound').source, {
    type: 'project',
    name: 'Existing Sound',
  });
  assert.equal(manifestAsset(snapshot, 'Hero').bitmapResolution, 2);
  assert.deepEqual(manifestAsset(snapshot, 'Ocean').source, {
    type: 'file',
    inputPath: 'assets/ocean.svg',
    mode: 'file',
    files: [
      {path: 'ocean.svg', size: fixture.files.ocean.length, integrity: sri(fixture.files.ocean)},
    ],
  });
  assert.deepEqual(
    manifestAsset(snapshot, 'RescuePose').source.files.map(({path: filePath}) => filePath),
    ['metadata.json', 'model.json', 'nested/weights.bin'],
  );
  assert.deepEqual(
    manifestAsset(snapshot, 'RescuePose').source.files.map(({integrity}) => integrity),
    [sri(fixture.files.metadata), sri(fixture.files.model), sri(fixture.files.weights)],
  );
  assert.equal(JSON.stringify(snapshot.manifest).includes(fixture.root), false);
  assert.equal(Object.isFrozen(snapshot.manifest), true);
  assert.equal(Object.isFrozen(snapshot.manifest.assets), true);
  assert.equal(Object.isFrozen(manifestAsset(snapshot, 'RescuePose').source.files), true);
  assert.deepEqual(storyDocument, originalStory);

  const first = snapshot.getFile('Ocean', 'ocean.svg');
  first[0] = requireDefined(first[0], 'the first byte of the copied asset') ^ 0xff;
  assert.deepEqual(snapshot.getFile('Ocean', 'ocean.svg'), fixture.files.ocean);
  assert.throws(
    () => snapshot.getFile('Ocean', 'missing.svg'),
    (error) =>
      thrown(error).code === 'K4-ASSET-LOOKUP-001' && thrown(error).stage === 'dsl4-local-assets',
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
  assert.deepEqual(manifestAssets(snapshot), [
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
    (error) => thrown(error).code === 'K4-ASSET-LOOKUP-001',
  );
});

test('extracts a local recognitionModel zip file into the embedded three-file bundle', async (t) => {
  const fixture = await workspace(t);
  const storyDocument = parseStory(`
kamishibai: '4.0'
assets:
  RescuePose:
    kind: recognitionModel
    file: models/rescue.ZIP
scenes:
  opening:
    recognitionModel: RescuePose
    actions: []
`);
  const snapshot = await loadDsl4LocalAssetSnapshot(fixture.root, storyDocument, {
    ...standardLimits,
    subtleCrypto: webcrypto.subtle,
  });
  const source = manifestAsset(snapshot, 'RescuePose').source;
  assert.equal(source.mode, 'archive');
  assert.deepEqual(
    source.files.map((file: ManifestFile) => file.path),
    ['metadata.json', 'model.json', 'weights.bin'],
  );
  assert.deepEqual(snapshot.getFile('RescuePose', 'metadata.json'), fixture.files.metadata);
  assert.deepEqual(snapshot.getFile('RescuePose', 'model.json'), fixture.files.model);
  assert.deepEqual(snapshot.getFile('RescuePose', 'weights.bin'), fixture.files.weights);
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
  assert.equal(manifestAsset(snapshot, 'ControlIcon').kind, 'image');
  assert.equal('target' in manifestAsset(snapshot, 'ControlIcon'), false);
  assert.deepEqual(manifestAsset(snapshot, 'ControlIcon').source, {
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
    requireDefined(story.assets.Ocean, 'the Ocean asset').file = locator;
    await assert.rejects(
      loadDsl4LocalAssetSnapshot(fixture.root, story, {
        ...standardLimits,
        subtleCrypto: webcrypto.subtle,
      }),
      (error) =>
        thrown(error).code === 'K4-ASSET-PATH-001' && thrown(error).stage === 'dsl4-local-assets',
    );
  }
});

test('rejects root escape, asset symlinks, nested symlinks, and wrong file kinds', async (t) => {
  const fixture = await workspace(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'dsl4-local-assets-outside-'));
  t.onTestFinished(() => rm(outside, {recursive: true, force: true}));
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
    ['models/rescue', 'recognitionModel', 'K4-ASSET-SYMLINK-001'],
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
      (error) => thrown(error).code === code,
    );
  }
});

test('enforces explicit file, count, and total byte limits', async (t) => {
  const fixture = await workspace(t);
  const story = comprehensiveStory();
  const limitCases: [typeof standardLimits, string][] = [
    [{...standardLimits, maxFileBytes: 3}, 'K4-ASSET-SIZE-001'],
    [{...standardLimits, maxFiles: 2}, 'K4-ASSET-COUNT-001'],
    [{...standardLimits, maxTotalBytes: 10}, 'K4-ASSET-TOTAL-SIZE-001'],
  ];
  for (const [limits, code] of limitCases) {
    await assert.rejects(
      loadDsl4LocalAssetSnapshot(fixture.root, story, {
        ...limits,
        subtleCrypto: webcrypto.subtle,
      }),
      (error) => thrown(error).code === code,
    );
  }
  const rejectedLimits: [string, number | undefined][] = [
    ['maxFileBytes', 0],
    ['maxFiles', undefined],
    ['maxTotalBytes', Number.POSITIVE_INFINITY],
  ];
  for (const [name, value] of rejectedLimits) {
    // Deliberately out of contract: each case hands the loader one limit its own types forbid, to
    // prove the runtime validation rejects it rather than trusting the declaration.
    const limits = {...standardLimits, [name]: value} as typeof standardLimits;
    await assert.rejects(
      loadDsl4LocalAssetSnapshot(fixture.root, story, limits),
      new RegExp(`${name} must be a positive safe integer`, 'u'),
    );
  }
});

test('fails closed when bytes or a recognitionModel directory changes during snapshot', async (t) => {
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
    (error) => thrown(error).code === 'K4-ASSET-UNSTABLE-001',
  );

  const poseStory = parseStory(`
kamishibai: '4.0'
assets:
  Pose:
    kind: recognitionModel
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
    (error) => thrown(error).code === 'K4-ASSET-UNSTABLE-001',
  );
});
