import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  createDsl4EmbeddedAssetLifecycle,
  createDsl4RemoteAssetLifecycle,
  createDsl4SourceFrontend,
} from '../src/dsl4/index.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const bytes = new TextEncoder().encode('<svg id="remote"/>');

function integrity(value) {
  return `sha256-${createHash('sha256').update(value).digest('hex')}`;
}

function component(overrides = {}, kind = 'backdrop') {
  const source = {
    type: 'remote',
    url: 'https://cdn.example.com/remote.svg',
    integrity: integrity(bytes),
    contentType: 'image/svg+xml',
    size: bytes.byteLength,
    ...overrides,
  };
  const scene =
    kind === 'poseModel' ? '    poseModel: Remote\n    actions: []' : '    - stage: Remote';
  const parsed = frontend.parse(
    `
kamishibai: '4.0'
assets:
  Remote:
    kind: ${kind}
    delivery: remote
    loading: lazy
    source:
      url: ${source.url}
      integrity: ${source.integrity}
      contentType: ${source.contentType}
      size: ${source.size}
scenes:
  opening:
${scene}
`,
    {sourceId: 'remote-lifecycle-test'},
  );
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  return {
    storyDocument: parsed.storyDocument,
    assetBundle: {
      manifest: {
        formatVersion: 1,
        assets: [{id: 'Remote', kind, loading: 'lazy', source}],
      },
    },
    getAssetFile() {
      assert.fail('remote assets must not read an embedded payload');
    },
  };
}

function context(controller = new AbortController(), generation = 1) {
  return Object.freeze({signal: controller.signal, generation, sceneId: 'opening'});
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {promise, resolve};
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('Timed out while waiting for remote lifecycle state');
}

test('loads, verifies, registers, caches, and releases an explicitly enabled remote asset', async () => {
  const loads = [];
  const prepared = [];
  const released = [];
  const loading = [];
  const lifecycle = createDsl4RemoteAssetLifecycle({
    runtimeComponent: component(),
    async loadRemoteAsset(payload, loadContext) {
      loads.push({payload, signal: loadContext.signal});
      return {bytes, contentType: 'image/svg+xml; charset=utf-8'};
    },
    adapter: {
      prepare(payload) {
        prepared.push(payload);
        return {id: payload.asset.id};
      },
      release(resource, details) {
        released.push([resource.id, details.reason]);
      },
    },
    setLoading(payload) {
      loading.push(payload);
    },
    subtleCrypto: webcrypto.subtle,
  });

  await lifecycle.prepare({assetIds: ['Remote', 'Remote']}, context());
  await lifecycle.prepare({assetIds: ['Remote']}, context(undefined, 2));
  assert.equal(loads.length, 1);
  assert.deepEqual(loads[0].payload, {
    assetId: 'Remote',
    url: 'https://cdn.example.com/remote.svg',
    integrity: integrity(bytes),
    contentType: 'image/svg+xml',
    size: bytes.byteLength,
  });
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].asset.source.type, 'remote');
  assert.equal(prepared[0].files[0].contentType, 'image/svg+xml');
  assert.deepEqual(prepared[0].files[0].bytes, bytes);

  await lifecycle.setLoading({visible: true}, context());
  assert.deepEqual(loading, [{visible: true}]);
  await lifecycle.release({reason: 'stop'});
  assert.deepEqual(released, [['Remote', 'stop']]);
});

test('keeps remote loading disabled unless the host injects a loader', async () => {
  const lifecycle = createDsl4EmbeddedAssetLifecycle({
    runtimeComponent: component(),
    adapter: {prepare() {}, release() {}},
    setLoading() {},
  });
  await assert.rejects(lifecycle.prepare({assetIds: ['Remote']}, context()), (error) => {
    assert.equal(error.code, 'K4-ASSET-REMOTE-DISABLED');
    assert.equal(error.storyPath, '/assets/Remote');
    return true;
  });
  assert.throws(
    () =>
      createDsl4RemoteAssetLifecycle({
        runtimeComponent: component(),
        adapter: {prepare() {}, release() {}},
        setLoading() {},
      }),
    /requires loadRemoteAsset/u,
  );
});

test('rejects remote size, Content-Type, and integrity mismatches before registration', async () => {
  const cases = [
    [{bytes: bytes.subarray(1), contentType: 'image/svg+xml'}, 'K4-ASSET-REMOTE-SIZE-001'],
    [{bytes, contentType: 'text/plain'}, 'K4-ASSET-REMOTE-CONTENT-TYPE-001'],
    [
      {bytes: new Uint8Array(bytes.byteLength), contentType: 'image/svg+xml'},
      'K4-ASSET-REMOTE-INTEGRITY-001',
    ],
  ];
  for (const [loaded, code] of cases) {
    let registrations = 0;
    const lifecycle = createDsl4RemoteAssetLifecycle({
      runtimeComponent: component(),
      loadRemoteAsset: async () => loaded,
      adapter: {
        prepare() {
          registrations += 1;
        },
        release() {},
      },
      setLoading() {},
      subtleCrypto: webcrypto.subtle,
    });
    await assert.rejects(lifecycle.prepare({assetIds: ['Remote']}, context()), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.storyPath, '/assets/Remote');
      return true;
    });
    assert.equal(registrations, 0);
    await lifecycle.release({reason: 'test-cleanup'});
  }
});

test('verifies a remote pose archive before registering its extracted model files', async () => {
  const archive = new TextEncoder().encode('verified-pose-archive');
  const files = [
    {path: 'metadata.json', bytes: new TextEncoder().encode('{"labels":["rescue"]}')},
    {path: 'model.json', bytes: new TextEncoder().encode('{"model":true}')},
    {path: 'weights.bin', bytes: new Uint8Array([1, 2, 3])},
  ];
  const prepared = [];
  const lifecycle = createDsl4RemoteAssetLifecycle({
    runtimeComponent: component(
      {
        url: 'https://cdn.example.com/pose.zip',
        integrity: integrity(archive),
        contentType: 'application/zip',
        size: archive.byteLength,
      },
      'poseModel',
    ),
    loadRemoteAsset: async () => ({
      bytes: archive,
      contentType: 'application/zip',
      files,
    }),
    adapter: {
      prepare(payload) {
        prepared.push(payload);
        return {id: payload.asset.id};
      },
      release() {},
    },
    setLoading() {},
    subtleCrypto: webcrypto.subtle,
  });
  await lifecycle.prepare({assetIds: ['Remote']}, context());
  assert.equal(prepared[0].asset.source.type, 'remote');
  assert.deepEqual(
    prepared[0].files.map(({path: filePath}) => filePath),
    ['metadata.json', 'model.json', 'weights.bin'],
  );
  assert.notStrictEqual(prepared[0].files[0].bytes, files[0].bytes);
  await lifecycle.release({reason: 'stop'});
});

test('waits for an aborted preparation to settle before retrying the same asset', async () => {
  const pending = [deferred(), deferred()];
  let loads = 0;
  const lifecycle = createDsl4RemoteAssetLifecycle({
    runtimeComponent: component(),
    loadRemoteAsset() {
      const operation = pending[loads];
      loads += 1;
      return operation.promise;
    },
    adapter: {prepare: ({asset}) => ({id: asset.id}), release() {}},
    setLoading() {},
    subtleCrypto: webcrypto.subtle,
  });
  const firstController = new AbortController();
  const first = lifecycle.prepare({assetIds: ['Remote']}, context(firstController));
  await waitUntil(() => loads === 1);
  firstController.abort('scene-superseded');

  const second = lifecycle.prepare({assetIds: ['Remote']}, context(undefined, 2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 1);
  pending[0].resolve({bytes, contentType: 'image/svg+xml'});
  await assert.rejects(first, (error) => error.name === 'AbortError');
  await waitUntil(() => loads === 2);
  pending[1].resolve({bytes, contentType: 'image/svg+xml'});
  await second;
  await lifecycle.release({reason: 'stop'});
});

test('remote lifecycle core has no direct network, filesystem, DOM, VM, or Scratch dependency', async () => {
  const implementation = await readFile(
    path.join(repositoryRoot, 'src', 'dsl4', 'embedded-asset-lifecycle.js'),
    'utf8',
  );
  assert.doesNotMatch(implementation, /(?:node:fs|node:http|node:https|\bfetch\s*\()/u);
  assert.doesNotMatch(implementation, /(?:globalThis\.(?:document|window)|KeyboardEvent)/u);
  assert.doesNotMatch(implementation, /(?:\bScratch\b|scratch-vm|vm\.runtime|startHats)/u);
});
