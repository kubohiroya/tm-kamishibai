import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  createDsl4EmbeddedAssetBundle,
  createDsl4EmbeddedAssetLifecycle,
  createDsl4SourceFrontend,
  validateDsl4EmbeddedAssetBundle,
} from '../src/dsl4/index.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const subtleCrypto = webcrypto.subtle;
const bundleOptions = {maxFiles: 20, maxTotalBytes: 8192, subtleCrypto};

function sri(bytes) {
  return `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
}

async function runtimeComponent() {
  const parsed = frontend.parse(
    `
kamishibai: '4.0'
assets:
  ProjectBackdrop: backdrop
  OpeningImage:
    kind: backdrop
    file: assets/opening.svg
    loading: lazy
  HeroCostume:
    kind: costume
    target: Hero
    file: assets/hero.svg
  OpeningSound:
    kind: sound
    file: assets/opening.wav
    loading: lazy
  RescuePose:
    kind: poseModel
    file: pose-models/rescue
actors:
  Hero: HeroCostume
scenes:
  opening: []
`,
    {sourceId: 'asset-lifecycle-test'},
  );
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const blobs = new Map([
    ['HeroCostume\0hero.svg', new TextEncoder().encode('<svg id="hero"/>')],
    ['OpeningImage\0opening.svg', new TextEncoder().encode('<svg id="opening"/>')],
    ['OpeningSound\0opening.wav', new TextEncoder().encode('RIFF-wave')],
    ['RescuePose\0metadata.json', new TextEncoder().encode('{"labels":["rescue"]}')],
    ['RescuePose\0model.json', new TextEncoder().encode('{"model":true}')],
  ]);
  const file = (assetId, filePath) => ({
    path: filePath,
    size: blobs.get(`${assetId}\0${filePath}`).length,
    integrity: sri(blobs.get(`${assetId}\0${filePath}`)),
  });
  const snapshot = {
    manifest: {
      formatVersion: 1,
      assets: [
        {
          id: 'HeroCostume',
          kind: 'costume',
          target: 'Hero',
          loading: 'eager',
          source: {
            type: 'file',
            inputPath: 'assets/hero.svg',
            mode: 'file',
            files: [file('HeroCostume', 'hero.svg')],
          },
        },
        {
          id: 'OpeningImage',
          kind: 'backdrop',
          loading: 'lazy',
          source: {
            type: 'file',
            inputPath: 'assets/opening.svg',
            mode: 'file',
            files: [file('OpeningImage', 'opening.svg')],
          },
        },
        {
          id: 'OpeningSound',
          kind: 'sound',
          loading: 'lazy',
          source: {
            type: 'file',
            inputPath: 'assets/opening.wav',
            mode: 'file',
            files: [file('OpeningSound', 'opening.wav')],
          },
        },
        {
          id: 'ProjectBackdrop',
          kind: 'backdrop',
          loading: 'eager',
          source: {type: 'project', name: 'ProjectBackdrop'},
        },
        {
          id: 'RescuePose',
          kind: 'poseModel',
          loading: 'eager',
          source: {
            type: 'file',
            inputPath: 'pose-models/rescue',
            mode: 'directory',
            files: [file('RescuePose', 'metadata.json'), file('RescuePose', 'model.json')],
          },
        },
      ],
    },
    getFile(assetId, filePath) {
      return new Uint8Array(blobs.get(`${assetId}\0${filePath}`));
    },
  };
  const descriptor = await createDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    snapshot,
    bundleOptions,
  );
  const validated = await validateDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    descriptor,
    bundleOptions,
  );
  return {
    storyDocument: parsed.storyDocument,
    assetBundle: validated.descriptor,
    getAssetFile: validated.getFile,
    blobs,
  };
}

function context(controller = new AbortController(), generation = 1) {
  return Object.freeze({signal: controller.signal, generation, sceneId: 'opening'});
}

test('materializes every kind in stable order with project refs and file byte copies', async () => {
  const component = await runtimeComponent();
  const prepared = [];
  const released = [];
  const lifecycle = createDsl4EmbeddedAssetLifecycle({
    runtimeComponent: component,
    adapter: {
      prepare(payload) {
        prepared.push(payload);
        return {id: payload.asset.id};
      },
      release(resource, details) {
        released.push([resource.id, details.reason]);
      },
    },
    setLoading() {},
  });
  await lifecycle.prepare(
    {
      assetIds: [
        'RescuePose',
        'OpeningSound',
        'OpeningImage',
        'HeroCostume',
        'ProjectBackdrop',
        'OpeningImage',
      ],
    },
    context(),
  );
  assert.deepEqual(
    prepared.map(({asset}) => asset.id),
    ['HeroCostume', 'OpeningImage', 'OpeningSound', 'ProjectBackdrop', 'RescuePose'],
  );
  assert.deepEqual(
    prepared.map(({asset}) => [asset.kind, asset.loading, asset.target]),
    [
      ['costume', 'eager', 'Hero'],
      ['backdrop', 'lazy', undefined],
      ['sound', 'lazy', undefined],
      ['backdrop', 'eager', undefined],
      ['poseModel', 'eager', undefined],
    ],
  );
  assert.deepEqual(prepared[3].files, []);
  assert.deepEqual(
    prepared[4].files.map(({path: filePath}) => filePath),
    ['metadata.json', 'model.json'],
  );
  assert.match(prepared[1].files[0].integrity, /^sha256-/u);
  assert.equal(prepared[1].files[0].size, component.blobs.get('OpeningImage\0opening.svg').length);
  prepared[1].files[0].bytes[0] ^= 0xff;

  await lifecycle.release({reason: 'stop'});
  assert.deepEqual(
    released.map(([assetId]) => assetId),
    ['RescuePose', 'ProjectBackdrop', 'OpeningSound', 'OpeningImage', 'HeroCostume'],
  );
  await lifecycle.prepare({assetIds: ['OpeningImage']}, context(undefined, 2));
  assert.deepEqual(
    prepared.at(-1).files[0].bytes,
    component.blobs.get('OpeningImage\0opening.svg'),
  );
  await lifecycle.release({reason: 'dispose'});
});

test('deduplicates pending and ready preparation and caches failures until release', async () => {
  const component = await runtimeComponent();
  let resolvePending;
  let attempts = 0;
  let fail = false;
  const lifecycle = createDsl4EmbeddedAssetLifecycle({
    runtimeComponent: component,
    adapter: {
      prepare({asset}) {
        attempts += 1;
        if (fail) throw new Error(`failed ${asset.id}`);
        if (asset.id === 'OpeningImage' && resolvePending === undefined) {
          return new Promise((resolve) => {
            resolvePending = resolve;
          });
        }
        return {id: asset.id};
      },
      release() {},
    },
    setLoading() {},
  });
  const first = lifecycle.prepare({assetIds: ['OpeningImage']}, context());
  const second = lifecycle.prepare({assetIds: ['OpeningImage', 'OpeningImage']}, context());
  assert.equal(attempts, 1);
  resolvePending({id: 'OpeningImage'});
  await Promise.all([first, second]);
  await lifecycle.prepare({assetIds: ['OpeningImage']}, context());
  assert.equal(attempts, 1);

  fail = true;
  await assert.rejects(lifecycle.prepare({assetIds: ['OpeningSound']}, context()), /failed/u);
  await assert.rejects(lifecycle.prepare({assetIds: ['OpeningSound']}, context()), /failed/u);
  assert.equal(attempts, 2);
  await lifecycle.release({reason: 'reset'});
  fail = false;
  await lifecycle.prepare({assetIds: ['OpeningSound']}, context(undefined, 2));
  assert.equal(attempts, 3);
  await lifecycle.release({reason: 'dispose'});
});

test('selectively releases one resource and serializes its next preparation', async () => {
  const component = await runtimeComponent();
  const attempts = new Map();
  const releases = [];
  let finishSelectiveRelease;
  const lifecycle = createDsl4EmbeddedAssetLifecycle({
    runtimeComponent: component,
    adapter: {
      prepare({asset}) {
        attempts.set(asset.id, (attempts.get(asset.id) ?? 0) + 1);
        return {id: asset.id};
      },
      release(resource, details) {
        releases.push([resource.id, details.reason]);
        if (resource.id === 'OpeningImage' && details.reason === 'scene-transition') {
          return new Promise((resolve) => {
            finishSelectiveRelease = resolve;
          });
        }
      },
    },
    setLoading() {},
  });
  await lifecycle.prepare({assetIds: ['OpeningImage', 'OpeningSound']}, context());

  const selectiveRelease = lifecycle.releaseAssets({
    assetIds: ['OpeningImage'],
    reason: 'scene-transition',
  });
  while (finishSelectiveRelease === undefined)
    await new Promise((resolve) => setImmediate(resolve));
  const retry = lifecycle.prepare({assetIds: ['OpeningImage']}, context(undefined, 2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts.get('OpeningImage'), 1);
  assert.equal(attempts.get('OpeningSound'), 1);

  finishSelectiveRelease();
  await Promise.all([selectiveRelease, retry]);
  assert.equal(attempts.get('OpeningImage'), 2);
  await lifecycle.prepare({assetIds: ['OpeningSound']}, context(undefined, 2));
  assert.equal(attempts.get('OpeningSound'), 1);

  await lifecycle.release({reason: 'dispose'});
  assert.deepEqual(releases, [
    ['OpeningImage', 'scene-transition'],
    ['OpeningImage', 'dispose'],
    ['OpeningSound', 'dispose'],
  ]);
});

test('joins concurrent full releases so every adapter resource finishes releasing once', async () => {
  const component = await runtimeComponent();
  const released = [];
  let finishFirstRelease;
  const lifecycle = createDsl4EmbeddedAssetLifecycle({
    runtimeComponent: component,
    adapter: {
      prepare({asset}) {
        return {id: asset.id};
      },
      release(resource) {
        released.push(resource.id);
        if (released.length === 1) {
          return new Promise((resolve) => {
            finishFirstRelease = resolve;
          });
        }
      },
    },
    setLoading() {},
  });
  await lifecycle.prepare({assetIds: ['OpeningImage', 'OpeningSound']}, context());
  const first = lifecycle.release({reason: 'stop'});
  while (finishFirstRelease === undefined) await new Promise((resolve) => setImmediate(resolve));
  const second = lifecycle.release({reason: 'dispose'});
  assert.strictEqual(second, first);
  finishFirstRelease();
  await Promise.all([first, second]);
  assert.deepEqual(released, ['OpeningSound', 'OpeningImage']);
});

test('releases a late stale resource after Abort and permits a clean retry', async () => {
  const component = await runtimeComponent();
  const pending = [];
  const released = [];
  const lifecycle = createDsl4EmbeddedAssetLifecycle({
    runtimeComponent: component,
    adapter: {
      prepare({asset}) {
        return new Promise((resolve) => pending.push(() => resolve({id: asset.id})));
      },
      release(resource, details) {
        released.push([resource.id, details.reason]);
      },
    },
    setLoading() {},
  });
  const controller = new AbortController();
  const first = lifecycle.prepare({assetIds: ['OpeningImage']}, context(controller));
  controller.abort('scene-superseded');
  pending.shift()();
  await assert.rejects(first, (error) => error.name === 'AbortError');
  assert.deepEqual(released, [['OpeningImage', 'stale']]);

  const retry = lifecycle.prepare({assetIds: ['OpeningImage']}, context(undefined, 2));
  pending.shift()();
  await retry;
  await lifecycle.release({reason: 'stop'});
  assert.deepEqual(released, [
    ['OpeningImage', 'stale'],
    ['OpeningImage', 'stop'],
  ]);
});

test('waits for pending resources on release and aggregates every release failure', async () => {
  const component = await runtimeComponent();
  let resolvePending;
  const released = [];
  const pendingLifecycle = createDsl4EmbeddedAssetLifecycle({
    runtimeComponent: component,
    adapter: {
      prepare({asset}) {
        return new Promise((resolve) => {
          resolvePending = () => resolve({id: asset.id});
        });
      },
      release(resource, details) {
        released.push([resource.id, details.reason]);
      },
    },
    setLoading() {},
  });
  const preparation = pendingLifecycle.prepare({assetIds: ['OpeningImage']}, context());
  const release = pendingLifecycle.release({reason: 'dispose'});
  resolvePending();
  await assert.rejects(preparation, (error) => error.name === 'AbortError');
  await release;
  assert.deepEqual(released, [['OpeningImage', 'stale']]);

  const attempted = [];
  const failingLifecycle = createDsl4EmbeddedAssetLifecycle({
    runtimeComponent: component,
    adapter: {
      prepare({asset}) {
        return {id: asset.id};
      },
      release(resource) {
        attempted.push(resource.id);
        throw new Error(`release ${resource.id}`);
      },
    },
    setLoading() {},
  });
  await failingLifecycle.prepare({assetIds: ['OpeningImage', 'OpeningSound']}, context());
  await assert.rejects(failingLifecycle.release({reason: 'stop'}), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.equal(error.errors.length, 2);
    return true;
  });
  assert.deepEqual(attempted, ['OpeningSound', 'OpeningImage']);
  await failingLifecycle.release({reason: 'again'});
});

test('forwards Loading calls and rejects invalid contracts before adapter side effects', async () => {
  const component = await runtimeComponent();
  const loadingCalls = [];
  let preparations = 0;
  const lifecycle = createDsl4EmbeddedAssetLifecycle({
    runtimeComponent: component,
    adapter: {
      prepare() {
        preparations += 1;
      },
      release() {},
    },
    setLoading(payload, callContext) {
      loadingCalls.push([payload, callContext]);
      return 'shown';
    },
  });
  const payload = Object.freeze({visible: true, sceneId: 'opening'});
  const callContext = context();
  assert.equal(await lifecycle.setLoading(payload, callContext), 'shown');
  assert.strictEqual(loadingCalls[0][0], payload);
  assert.strictEqual(loadingCalls[0][1], callContext);
  await assert.rejects(
    lifecycle.prepare({assetIds: ['Missing', 'OpeningImage']}, callContext),
    /Unknown embedded asset/u,
  );
  assert.equal(preparations, 0);

  assert.throws(
    () => createDsl4EmbeddedAssetLifecycle({runtimeComponent: {}, adapter: {}, setLoading() {}}),
    TypeError,
  );
  assert.throws(
    () =>
      createDsl4EmbeddedAssetLifecycle({runtimeComponent: component, adapter: {}, setLoading() {}}),
    TypeError,
  );
});
