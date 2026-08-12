import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {strToU8, zipSync} from 'fflate';

import {
  createDsl4EmbeddedAssetLifecycle,
  createDsl4RemoteAssetLifecycle,
  createDsl4SourceFrontend,
} from '../src/dsl4/index.js';
import {createDsl4PoseArchiveExtractor} from '../src/dsl4/platform/pose-archive-extractor.js';

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

function barePoseComponent(url = 'https://cdn.example.com/pose/') {
  const parsed = frontend.parse(
    `
kamishibai: '4.0'
assets:
  Remote:
    kind: poseModel
    delivery: remote
    loading: lazy
    source:
      url: ${url}
scenes:
  opening:
    poseModel: Remote
    actions: []
`,
    {sourceId: 'bare-remote-pose-lifecycle-test'},
  );
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  return {
    storyDocument: parsed.storyDocument,
    assetBundle: {
      manifest: {
        formatVersion: 1,
        assets: [
          {
            id: 'Remote',
            kind: 'poseModel',
            loading: 'lazy',
            source: {type: 'remote', url},
          },
        ],
      },
    },
    getAssetFile() {
      assert.fail('remote assets must not read an embedded payload');
    },
  };
}

function bareSingleFileComponent(kind, url) {
  const parsed = frontend.parse(
    `
kamishibai: '4.0'
assets:
  Remote:
    kind: ${kind}
    delivery: remote
    loading: lazy
    source:
      url: ${url}
scenes:
  opening: []
`,
    {sourceId: 'bare-remote-single-file-lifecycle-test'},
  );
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  return {
    storyDocument: parsed.storyDocument,
    assetBundle: {
      manifest: {
        formatVersion: 1,
        assets: [
          {
            id: 'Remote',
            kind,
            loading: 'lazy',
            source: {type: 'remote', url},
          },
        ],
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

test('loads an unpinned TMPose directory lazily without requiring integrity metadata', async () => {
  const encoder = new TextEncoder();
  const files = new Map([
    [
      'https://cdn.example.com/pose/model.json',
      encoder.encode('{"weightsManifest":[{"paths":["weights.bin"]}]}'),
    ],
    ['https://cdn.example.com/pose/metadata.json', encoder.encode('{"labels":["rescue"]}')],
    ['https://cdn.example.com/pose/weights.bin', new Uint8Array([1, 2, 3])],
  ]);
  const loads = [];
  const prepared = [];
  const lifecycle = createDsl4RemoteAssetLifecycle({
    runtimeComponent: barePoseComponent(),
    async loadRemoteAsset(payload) {
      loads.push(payload);
      return {bytes: files.get(payload.url), contentType: 'application/octet-stream'};
    },
    adapter: {
      prepare(payload) {
        prepared.push(payload);
        return {id: payload.asset.id};
      },
      release() {},
    },
    setLoading() {},
  });

  await lifecycle.prepare({assetIds: ['Remote']}, context());
  assert.deepEqual(loads.map(({url}) => url).sort(), [...files.keys()].sort());
  assert.deepEqual(
    prepared[0].files.map(({path: filePath}) => filePath),
    ['model.json', 'metadata.json', 'weights.bin'],
  );
  assert.equal(Object.hasOwn(loads[0], 'integrity'), false);
  await lifecycle.release({reason: 'stop'});
});

test('loads and extracts an unpinned TMPose zip URL as one bounded archive', async () => {
  const archive = zipSync({
    'metadata.json': strToU8('{"labels":["rescue"]}'),
    'model.json': strToU8('{"weightsManifest":[{"paths":["weights.bin"]}]}'),
    'weights.bin': new Uint8Array([1, 2, 3]),
  });
  const url = 'https://cdn.example.com/pose/Rescue.ZIP?download=1';
  const loads = [];
  const prepared = [];
  const lifecycle = createDsl4RemoteAssetLifecycle({
    runtimeComponent: barePoseComponent(url),
    async loadRemoteAsset(payload) {
      loads.push(payload);
      return {bytes: archive, contentType: 'application/zip'};
    },
    extractRemotePoseArchive(payload, extractContext) {
      return createDsl4PoseArchiveExtractor({
        limits: {
          maxArchiveBytes: 4096,
          maxEntries: 3,
          maxCompressedEntryBytes: 2048,
          maxExpandedEntryBytes: 2048,
          maxTotalExpandedBytes: 4096,
          maxCompressionRatio: 100,
        },
        subtleCrypto: webcrypto.subtle,
      })(payload, extractContext);
    },
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
  assert.deepEqual(loads, [{assetId: 'Remote', url}]);
  assert.deepEqual(
    prepared[0].files.map((file) => file.path),
    ['metadata.json', 'model.json', 'weights.bin'],
  );
  assert.equal(prepared[0].archiveBinding.extractorFormat, 'tmpose-zip-v1');
  await lifecycle.release({reason: 'stop'});
});

test('loads URL-only remote images and sounds without inventing verification metadata', async () => {
  const cases = [
    {
      kind: 'image',
      url: 'https://cdn.example.com/image.svg',
      bytes,
      contentType: 'image/svg+xml; charset=utf-8',
    },
    {
      kind: 'sound',
      url: 'https://cdn.example.com/sound.wav',
      bytes: new Uint8Array([82, 73, 70, 70]),
      contentType: 'audio/wav',
    },
  ];
  for (const fixture of cases) {
    const loads = [];
    const prepared = [];
    const lifecycle = createDsl4RemoteAssetLifecycle({
      runtimeComponent: bareSingleFileComponent(fixture.kind, fixture.url),
      async loadRemoteAsset(payload) {
        loads.push(payload);
        return {bytes: fixture.bytes, contentType: fixture.contentType};
      },
      adapter: {
        prepare(payload) {
          prepared.push(payload);
          return {id: payload.asset.id};
        },
        release() {},
      },
      setLoading() {},
    });
    await lifecycle.prepare({assetIds: ['Remote']}, context());
    assert.deepEqual(loads, [{assetId: 'Remote', url: fixture.url}]);
    assert.equal(prepared[0].files[0].contentType, fixture.contentType.split(';', 1)[0]);
    assert.equal(Object.hasOwn(prepared[0].files[0], 'integrity'), false);
    await lifecycle.release({reason: 'stop'});
  }
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
    /requires a remote asset resolver/u,
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

test('rejects remote pose files until a trusted archive extractor is connected', async () => {
  const archive = new TextEncoder().encode('verified-pose-archive');
  const files = [
    {path: 'metadata.json', bytes: new TextEncoder().encode('{"labels":["rescue"]}')},
    {path: 'model.json', bytes: new TextEncoder().encode('{"model":true}')},
    {path: 'weights.bin', bytes: new Uint8Array([1, 2, 3])},
  ];
  let prepared = 0;
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
      prepare() {
        prepared += 1;
      },
      release() {},
    },
    setLoading() {},
    subtleCrypto: webcrypto.subtle,
  });
  await assert.rejects(
    lifecycle.prepare({assetIds: ['Remote']}, context()),
    (error) => error.code === 'K4-ASSET-REMOTE-POSE-EXTRACTOR-001',
  );
  assert.equal(prepared, 0);
  await lifecycle.release({reason: 'stop'});
});

test('materializes remote pose files only from an archive-bound trusted extractor result', async () => {
  const archive = new TextEncoder().encode('verified-pose-archive');
  const archiveIntegrity = integrity(archive);
  const extractedFiles = [
    {path: 'metadata.json', bytes: new TextEncoder().encode('{"labels":["rescue"]}')},
    {path: 'model.json', bytes: new TextEncoder().encode('{"model":true}')},
    {path: 'weights.bin', bytes: new Uint8Array([1, 2, 3])},
  ].map((file) =>
    Object.freeze({
      ...file,
      size: file.bytes.byteLength,
      integrity: integrity(file.bytes),
      archiveIntegrity,
      extractorFormat: 'tmpose-zip-v1',
    }),
  );
  const extractions = [];
  const prepared = [];
  const lifecycle = createDsl4RemoteAssetLifecycle({
    runtimeComponent: component(
      {
        url: 'https://cdn.example.com/pose.zip',
        integrity: archiveIntegrity,
        contentType: 'application/zip',
        size: archive.byteLength,
      },
      'poseModel',
    ),
    loadRemoteAsset: async () => ({
      bytes: archive,
      contentType: 'application/zip',
      files: [{path: 'untrusted.bin', bytes: new Uint8Array([9])}],
    }),
    async extractRemotePoseArchive(payload, extractContext) {
      extractions.push({payload, signal: extractContext.signal});
      return {
        archiveIntegrity,
        extractorFormat: 'tmpose-zip-v1',
        files: extractedFiles,
      };
    },
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

  const prepareContext = context();
  await lifecycle.prepare({assetIds: ['Remote']}, prepareContext);
  assert.equal(extractions.length, 1);
  assert.deepEqual(Object.keys(extractions[0].payload).sort(), [
    'archiveIntegrity',
    'assetId',
    'bytes',
    'contentType',
  ]);
  assert.deepEqual(extractions[0].payload.bytes, archive);
  assert.strictEqual(extractions[0].signal, prepareContext.signal);
  assert.deepEqual(prepared[0].files, extractedFiles);
  assert.deepEqual(prepared[0].archiveBinding, {
    integrity: archiveIntegrity,
    extractorFormat: 'tmpose-zip-v1',
  });
  assert.equal(
    prepared[0].files.some((file) => file.path === 'untrusted.bin'),
    false,
  );
  await lifecycle.release({reason: 'stop'});
});

test('rejects extractor results not bound to the verified archive', async () => {
  const archive = new TextEncoder().encode('verified-pose-archive');
  const archiveIntegrity = integrity(archive);
  const lifecycle = createDsl4RemoteAssetLifecycle({
    runtimeComponent: component(
      {
        url: 'https://cdn.example.com/pose.zip',
        integrity: archiveIntegrity,
        contentType: 'application/zip',
        size: archive.byteLength,
      },
      'poseModel',
    ),
    loadRemoteAsset: async () => ({bytes: archive, contentType: 'application/zip'}),
    extractRemotePoseArchive: async () => ({
      archiveIntegrity: `sha256-${'0'.repeat(64)}`,
      extractorFormat: 'tmpose-zip-v1',
      files: [],
    }),
    adapter: {prepare() {}, release() {}},
    setLoading() {},
    subtleCrypto: webcrypto.subtle,
  });
  await assert.rejects(
    lifecycle.prepare({assetIds: ['Remote']}, context()),
    (error) => error.code === 'K4-ASSET-REMOTE-POSE-BINDING-001',
  );
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
