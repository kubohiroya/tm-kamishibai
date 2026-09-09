import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'vitest';
import {fileURLToPath} from 'node:url';

import {strToU8, zipSync} from 'fflate';

import {
  createDsl4EmbeddedAssetLifecycle,
  createDsl4RemoteAssetLifecycle,
  createDsl4SourceFrontend,
} from '../src/dsl4/index.js';
import {createDsl4PoseArchiveExtractor} from '../src/dsl4/platform/pose-archive-extractor.js';
import {thrown} from './helpers/thrown-error.ts';
import {deferred, waitUntil} from './helpers/async-test-helpers.ts';
import {requireDefined, requireRecord} from './helpers/require-value.ts';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const bytes = new TextEncoder().encode('<svg id="remote"/>');

function integrity(value: string | Uint8Array) {
  return `sha256-${createHash('sha256').update(value).digest('hex')}`;
}

/**
 * The payloads the remote lifecycle hands its loader and adapter.
 *
 * The lifecycle declares both opaquely, so the members these cases read -- the requested URL, the
 * prepared asset, and the file bytes it verified -- are named here once.
 */
interface RemoteLoadPayload {
  assetId: string;
  url: string;
  integrity?: string;
}

interface PreparedFile {
  path: string;
  bytes: Uint8Array;
  contentType?: string;
}

interface PreparePayload {
  asset: {id: string; source: {type: string}};
  files: PreparedFile[];
  archiveBinding?: {extractorFormat: string};
}

/** Read one prepare payload as the shape the lifecycle hands the adapter. */
function preparePayload(payload: Readonly<Record<string, unknown>>): PreparePayload {
  return payload as unknown as PreparePayload;
}

/** Read one load payload as the shape the lifecycle hands the remote loader. */
function loadPayload(payload: Readonly<Record<string, unknown>>): RemoteLoadPayload {
  return payload as unknown as RemoteLoadPayload;
}

/** Read one resource the adapter itself produced, handed back opaquely on release. */
function preparedResource(resource: unknown): {id: string} {
  return requireRecord(resource, 'a prepared resource') as unknown as {id: string};
}

function component(overrides: Record<string, unknown> = {}, kind = 'backdrop') {
  const source = {
    type: 'remote',
    url: 'https://cdn.example.com/remote.svg',
    integrity: integrity(bytes),
    contentType: 'image/svg+xml',
    size: bytes.byteLength,
    ...overrides,
  };
  const scene =
    kind === 'recognitionModel'
      ? '    recognitionModel: Remote\n    actions: []'
      : '    - stage: Remote';
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
    kind: recognitionModel
    delivery: remote
    loading: lazy
    source:
      url: ${url}
scenes:
  opening:
    recognitionModel: Remote
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
            kind: 'recognitionModel',
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

function bareSingleFileComponent(kind: string, url: string) {
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

test('loads, verifies, registers, caches, and releases an explicitly enabled remote asset', async () => {
  const loads: unknown[] = [];
  const prepared: PreparePayload[] = [];
  const released: unknown[] = [];
  const loading: unknown[] = [];
  const lifecycle = createDsl4RemoteAssetLifecycle({
    runtimeComponent: component(),
    async loadRemoteAsset(
      payload: Readonly<Record<string, unknown>>,
      loadContext: Readonly<Record<string, unknown>>,
    ) {
      loads.push({payload, signal: requireRecord(loadContext, 'the load context').signal});
      return {bytes, contentType: 'image/svg+xml; charset=utf-8'};
    },
    adapter: {
      prepare(payload: Readonly<Record<string, unknown>>) {
        prepared.push(preparePayload(payload));
        return {id: preparePayload(payload).asset.id};
      },
      release(resource: unknown, details: Readonly<Record<string, unknown>>) {
        released.push([preparedResource(resource).id, details.reason]);
      },
    },
    setLoading(payload: unknown) {
      loading.push(payload);
    },
    subtleCrypto: webcrypto.subtle,
  });

  await lifecycle.prepare({assetIds: ['Remote', 'Remote']}, context());
  await lifecycle.prepare({assetIds: ['Remote']}, context(undefined, 2));
  assert.equal(loads.length, 1);
  assert.deepEqual(requireRecord(requireDefined(loads[0], 'load 0'), 'its record').payload, {
    assetId: 'Remote',
    url: 'https://cdn.example.com/remote.svg',
    integrity: integrity(bytes),
    contentType: 'image/svg+xml',
    size: bytes.byteLength,
  });
  assert.equal(prepared.length, 1);
  assert.equal(requireDefined(prepared[0], 'prepared asset 0').asset.source.type, 'remote');
  const preparedFile = requireDefined(
    requireDefined(prepared[0], 'prepared asset 0').files[0],
    'its first file',
  );
  assert.equal(preparedFile.contentType, 'image/svg+xml');
  assert.deepEqual(preparedFile.bytes, bytes);

  await lifecycle.setLoading({visible: true}, context());
  assert.deepEqual(loading, [{visible: true}]);
  await lifecycle.release({reason: 'stop'});
  assert.deepEqual(released, [['Remote', 'stop']]);
});

test('loads an unpinned TM directory lazily without requiring integrity metadata', async () => {
  const encoder = new TextEncoder();
  const files = new Map([
    [
      'https://cdn.example.com/pose/model.json',
      encoder.encode('{"weightsManifest":[{"paths":["weights.bin"]}]}'),
    ],
    ['https://cdn.example.com/pose/metadata.json', encoder.encode('{"labels":["rescue"]}')],
    ['https://cdn.example.com/pose/weights.bin', new Uint8Array([1, 2, 3])],
  ]);
  const loads: unknown[] = [];
  const prepared: PreparePayload[] = [];
  const lifecycle = createDsl4RemoteAssetLifecycle({
    runtimeComponent: barePoseComponent(),
    async loadRemoteAsset(payload: Readonly<Record<string, unknown>>) {
      const request = loadPayload(payload);
      loads.push(request);
      return {
        bytes: requireDefined(files.get(request.url), `the ${request.url} fixture bytes`),
        contentType: 'application/octet-stream',
      };
    },
    adapter: {
      prepare(payload: Readonly<Record<string, unknown>>) {
        prepared.push(preparePayload(payload));
        return {id: preparePayload(payload).asset.id};
      },
      release() {},
    },
    setLoading() {},
  });

  await lifecycle.prepare({assetIds: ['Remote']}, context());
  assert.deepEqual(
    loads.map((load) => loadPayload(requireRecord(load, 'a load payload')).url).sort(),
    [...files.keys()].sort(),
  );
  assert.deepEqual(
    requireDefined(prepared[0], 'prepared asset 0').files.map(({path: filePath}) => filePath),
    ['model.json', 'metadata.json', 'weights.bin'],
  );
  assert.equal(
    Object.hasOwn(requireRecord(requireDefined(loads[0], 'load 0'), 'its record'), 'integrity'),
    false,
  );
  await lifecycle.release({reason: 'stop'});
});

test('loads and extracts an unpinned TM zip URL as one bounded archive', async () => {
  const archive = zipSync({
    'metadata.json': strToU8('{"labels":["rescue"]}'),
    'model.json': strToU8('{"weightsManifest":[{"paths":["weights.bin"]}]}'),
    'weights.bin': new Uint8Array([1, 2, 3]),
  });
  const url = 'https://cdn.example.com/pose/Rescue.ZIP?download=1';
  const loads: unknown[] = [];
  const prepared: PreparePayload[] = [];
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
      prepare(payload: Readonly<Record<string, unknown>>) {
        prepared.push(preparePayload(payload));
        return {id: preparePayload(payload).asset.id};
      },
      release() {},
    },
    setLoading() {},
    subtleCrypto: webcrypto.subtle,
  });

  await lifecycle.prepare({assetIds: ['Remote']}, context());
  assert.deepEqual(loads, [{assetId: 'Remote', url}]);
  assert.deepEqual(
    requireDefined(prepared[0], 'prepared asset 0').files.map((file) => file.path),
    ['metadata.json', 'model.json', 'weights.bin'],
  );
  assert.equal(
    requireDefined(
      requireDefined(prepared[0], 'prepared asset 0').archiveBinding,
      'its archive binding',
    ).extractorFormat,
    'tm-zip-v1',
  );
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
    const loads: unknown[] = [];
    const prepared: PreparePayload[] = [];
    const lifecycle = createDsl4RemoteAssetLifecycle({
      runtimeComponent: bareSingleFileComponent(fixture.kind, fixture.url),
      async loadRemoteAsset(payload) {
        loads.push(payload);
        return {bytes: fixture.bytes, contentType: fixture.contentType};
      },
      adapter: {
        prepare(payload: Readonly<Record<string, unknown>>) {
          prepared.push(preparePayload(payload));
          return {id: preparePayload(payload).asset.id};
        },
        release() {},
      },
      setLoading() {},
    });
    await lifecycle.prepare({assetIds: ['Remote']}, context());
    assert.deepEqual(loads, [{assetId: 'Remote', url: fixture.url}]);
    const preparedFile = requireDefined(
      requireDefined(prepared[0], 'prepared asset 0').files[0],
      'its first file',
    );
    assert.equal(preparedFile.contentType, fixture.contentType.split(';', 1)[0]);
    assert.equal(Object.hasOwn(preparedFile, 'integrity'), false);
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
    assert.equal(thrown(error).code, 'K4-ASSET-REMOTE-DISABLED');
    assert.equal(thrown(error).storyPath, '/assets/Remote');
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
      assert.equal(thrown(error).code, code);
      assert.equal(thrown(error).storyPath, '/assets/Remote');
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
      'recognitionModel',
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
    (error) => thrown(error).code === 'K4-ASSET-REMOTE-POSE-EXTRACTOR-001',
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
      extractorFormat: 'tm-zip-v1',
    }),
  );
  const extractions: unknown[] = [];
  const prepared: PreparePayload[] = [];
  const lifecycle = createDsl4RemoteAssetLifecycle({
    runtimeComponent: component(
      {
        url: 'https://cdn.example.com/pose.zip',
        integrity: archiveIntegrity,
        contentType: 'application/zip',
        size: archive.byteLength,
      },
      'recognitionModel',
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
        extractorFormat: 'tm-zip-v1',
        files: extractedFiles,
      };
    },
    adapter: {
      prepare(payload: Readonly<Record<string, unknown>>) {
        prepared.push(preparePayload(payload));
        return {id: preparePayload(payload).asset.id};
      },
      release() {},
    },
    setLoading() {},
    subtleCrypto: webcrypto.subtle,
  });

  const prepareContext = context();
  await lifecycle.prepare({assetIds: ['Remote']}, prepareContext);
  assert.equal(extractions.length, 1);
  const extraction = requireRecord(requireDefined(extractions[0], 'the extraction'), 'its record');
  const extractionPayload = requireRecord(extraction.payload, 'its payload');
  assert.deepEqual(Object.keys(extractionPayload).sort(), [
    'archiveIntegrity',
    'assetId',
    'bytes',
    'contentType',
  ]);
  assert.deepEqual(extractionPayload.bytes, archive);
  assert.strictEqual(extraction.signal, prepareContext.signal);
  assert.deepEqual(requireDefined(prepared[0], 'prepared asset 0').files, extractedFiles);
  assert.deepEqual(requireDefined(prepared[0], 'prepared asset 0').archiveBinding, {
    integrity: archiveIntegrity,
    extractorFormat: 'tm-zip-v1',
  });
  assert.equal(
    requireDefined(prepared[0], 'prepared asset 0').files.some(
      (file) => file.path === 'untrusted.bin',
    ),
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
      'recognitionModel',
    ),
    loadRemoteAsset: async () => ({bytes: archive, contentType: 'application/zip'}),
    extractRemotePoseArchive: async () => ({
      archiveIntegrity: `sha256-${'0'.repeat(64)}`,
      extractorFormat: 'tm-zip-v1',
      files: [],
    }),
    adapter: {prepare() {}, release() {}},
    setLoading() {},
    subtleCrypto: webcrypto.subtle,
  });
  await assert.rejects(
    lifecycle.prepare({assetIds: ['Remote']}, context()),
    (error) => thrown(error).code === 'K4-ASSET-REMOTE-POSE-BINDING-001',
  );
  await lifecycle.release({reason: 'stop'});
});

test('waits for an aborted preparation to settle before retrying the same asset', async () => {
  const pending = [
    deferred<{bytes: Uint8Array; contentType: string}>(),
    deferred<{bytes: Uint8Array; contentType: string}>(),
  ];
  let loads = 0;
  const lifecycle = createDsl4RemoteAssetLifecycle({
    runtimeComponent: component(),
    loadRemoteAsset() {
      const operation = requireDefined(pending[loads], `the load ${loads} gate`);
      loads += 1;
      return operation.promise;
    },
    adapter: {
      prepare: (payload: Readonly<Record<string, unknown>>) => ({
        id: preparePayload(payload).asset.id,
      }),
      release() {},
    },
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
  requireDefined(pending[0], 'the load 0 gate').resolve({bytes, contentType: 'image/svg+xml'});
  await assert.rejects(first, (error) => thrown(error).name === 'AbortError');
  await waitUntil(() => loads === 2);
  requireDefined(pending[1], 'the load 1 gate').resolve({bytes, contentType: 'image/svg+xml'});
  await second;
  await lifecycle.release({reason: 'stop'});
});
