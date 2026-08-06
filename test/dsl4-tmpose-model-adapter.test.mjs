import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDsl4PlatformAssetAdapter,
  createDsl4TMPoseModelAdapter,
  createDsl4TMPosePlatform,
} from '../src/dsl4/platform/index.js';

function poseModel(
  id = 'RescuePose',
  files = [
    {path: 'metadata.json', bytes: new TextEncoder().encode('{"labels":["rescue"]}')},
    {path: 'model.json', bytes: new TextEncoder().encode('{"model":true}')},
    {path: 'weights.bin', bytes: new Uint8Array([1, 2, 3])},
  ],
) {
  return {
    asset: {id, kind: 'poseModel', loading: 'lazy', source: {type: 'file'}},
    files,
  };
}

function fakeComposition(overrides = {}) {
  const calls = {register: [], release: []};
  return {
    calls,
    composition: Object.freeze({
      async registerPoseModel(input) {
        calls.register.push(input);
        return Object.freeze({name: input.name, labels: Object.freeze(['idle', 'rescue'])});
      },
      async releasePoseModel(name) {
        calls.release.push(name);
      },
      ...overrides,
    }),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {promise, resolve};
}

test('registers one embedded Teachable Machine pose model and returns immutable metadata', async () => {
  const fake = fakeComposition();
  const adapter = createDsl4TMPoseModelAdapter({composition: fake.composition});
  const payload = poseModel();
  const resource = await adapter.prepare(payload);

  assert.equal(fake.calls.register.length, 1);
  assert.equal(fake.calls.register[0].name, 'RescuePose');
  assert.deepEqual(
    fake.calls.register[0].files.map(({path: filePath}) => filePath),
    ['metadata.json', 'model.json', 'weights.bin'],
  );
  assert.strictEqual(fake.calls.register[0].files[0].bytes, payload.files[0].bytes);
  assert.deepEqual(resource, {
    adapter: 'tmpose',
    assetId: 'RescuePose',
    kind: 'poseModel',
    name: 'RescuePose',
    labels: ['idle', 'rescue'],
  });
  assert.equal(Object.isFrozen(resource), true);
  assert.equal(Object.isFrozen(resource.labels), true);
  assert.deepEqual(adapter.getPoseModelLabels('RescuePose'), ['idle', 'rescue']);

  await adapter.release(resource);
  await adapter.release(resource);
  assert.deepEqual(fake.calls.release, ['RescuePose']);
  assert.equal(adapter.getPoseModelLabels('RescuePose'), null);
});

test('registers an extracted verified remote pose model through the same owner', async () => {
  const fake = fakeComposition();
  const adapter = createDsl4TMPoseModelAdapter({composition: fake.composition});
  const payload = poseModel();
  payload.asset.source = {type: 'remote', url: 'https://cdn.example.com/pose.zip'};
  const resource = await adapter.prepare(payload);
  assert.equal(resource.adapter, 'tmpose');
  assert.deepEqual(
    fake.calls.register[0].files.map(({path: filePath}) => filePath),
    ['metadata.json', 'model.json', 'weights.bin'],
  );
  await adapter.release(resource);
});

test('rejects malformed pose model bundles before TMPose registration', async () => {
  const fake = fakeComposition();
  const adapter = createDsl4TMPoseModelAdapter({composition: fake.composition});
  const validFiles = poseModel().files;
  const invalid = [
    {},
    {asset: {id: '', kind: 'poseModel', source: {type: 'file'}}, files: validFiles},
    {asset: {id: 'Image', kind: 'backdrop', source: {type: 'file'}}, files: validFiles},
    {asset: {id: 'ProjectPose', kind: 'poseModel', source: {type: 'project'}}, files: []},
    poseModel('MissingFile', validFiles.slice(0, 2)),
    poseModel('ExtraFile', [...validFiles, {path: 'extra.bin', bytes: new Uint8Array([4])}]),
    poseModel('DuplicateFile', [validFiles[0], validFiles[0], validFiles[2]]),
    poseModel('NestedFile', [
      {...validFiles[0], path: 'model/metadata.json'},
      validFiles[1],
      validFiles[2],
    ]),
    poseModel('MissingWeights', [
      validFiles[0],
      validFiles[1],
      {path: 'weights.dat', bytes: new Uint8Array([1])},
    ]),
    poseModel('EmptyBytes', [
      validFiles[0],
      validFiles[1],
      {...validFiles[2], bytes: new Uint8Array()},
    ]),
  ];
  for (const payload of invalid) {
    await assert.rejects(adapter.prepare(payload), (error) => typeof error.code === 'string');
  }
  await assert.rejects(adapter.prepare(poseModel(), {signal: {}}), /signal is invalid/u);
  assert.deepEqual(fake.calls, {register: [], release: []});
});

test('releases invalid or aborted registrations without publishing a resource', async () => {
  const registration = deferred();
  const fake = fakeComposition({
    registerPoseModel(input) {
      fake.calls.register.push(input);
      return registration.promise;
    },
  });
  const adapter = createDsl4TMPoseModelAdapter({composition: fake.composition});
  const controller = new AbortController();
  const pending = adapter.prepare(poseModel(), {signal: controller.signal});
  controller.abort('scene-superseded');
  registration.resolve({name: 'RescuePose', labels: ['rescue']});

  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.deepEqual(fake.calls.release, ['RescuePose']);

  const malformed = fakeComposition({
    async registerPoseModel(input) {
      fake.calls.register.push(input);
      return {name: input.name, labels: [42]};
    },
  });
  const malformedAdapter = createDsl4TMPoseModelAdapter({composition: malformed.composition});
  await assert.rejects(malformedAdapter.prepare(poseModel()), /invalid registration/u);
  assert.deepEqual(malformed.calls.release, ['RescuePose']);
});

test('creates an app-shell-scoped TMPose composition and adapter pair', async () => {
  const fake = fakeComposition();
  const runtime = {Webcam: class {}, loadFromFiles() {}};
  const createFile = () => ({name: 'file'});
  const calls = [];
  const platform = createDsl4TMPosePlatform({
    runtime,
    createFile,
    createComposition(options) {
      calls.push(options);
      return fake.composition;
    },
  });

  assert.deepEqual(calls, [{runtime, createFile}]);
  assert.strictEqual(platform.composition, fake.composition);
  assert.equal(Object.isFrozen(platform), true);
  const resource = await platform.adapter.prepare(poseModel());
  await platform.adapter.release(resource);
  assert.deepEqual(fake.calls.release, ['RescuePose']);
});

test('routes media and pose assets to their owners and preserves release ownership', async () => {
  const calls = [];
  const mediaAdapter = {
    async prepare({asset}) {
      calls.push(['prepare-media', asset.kind]);
      return {owner: 'media', kind: asset.kind};
    },
    async release(resource) {
      calls.push(['release-media', resource.kind]);
    },
  };
  const poseAdapter = {
    async prepare({asset}) {
      calls.push(['prepare-pose', asset.kind]);
      return {owner: 'pose', kind: asset.kind};
    },
    async release(resource) {
      calls.push(['release-pose', resource.kind]);
    },
  };
  const router = createDsl4PlatformAssetAdapter({mediaAdapter, poseAdapter});
  const resources = [];
  for (const kind of ['backdrop', 'costume', 'sound', 'poseModel']) {
    resources.push(await router.prepare({asset: {kind}}));
  }
  assert.deepEqual(calls.slice(0, 4), [
    ['prepare-media', 'backdrop'],
    ['prepare-media', 'costume'],
    ['prepare-media', 'sound'],
    ['prepare-pose', 'poseModel'],
  ]);

  for (const resource of resources) await router.release(resource);
  await router.release(resources[3]);
  assert.deepEqual(calls.slice(4), [
    ['release-media', 'backdrop'],
    ['release-media', 'costume'],
    ['release-media', 'sound'],
    ['release-pose', 'poseModel'],
  ]);
  await assert.rejects(router.prepare({asset: {kind: 'video'}}), /Unsupported/u);
  const otherRouter = createDsl4PlatformAssetAdapter({mediaAdapter, poseAdapter});
  await assert.rejects(otherRouter.release(resources[0]), /not owned/u);
});
