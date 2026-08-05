import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {createDsl4PlatformAssetSession} from '../src/dsl4/platform/index.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function runtimeComponent() {
  const files = new Map([
    ['RescuePose\0metadata.json', new TextEncoder().encode('{"labels":["rescue"]}')],
    ['RescuePose\0model.json', new TextEncoder().encode('{"model":true}')],
    ['RescuePose\0weights.bin', new Uint8Array([1, 2, 3])],
  ]);
  return {
    storyDocument: {kind: 'StoryDocument', version: '4.0'},
    assetBundle: {
      manifest: {
        assets: [
          {
            id: 'Beach',
            kind: 'backdrop',
            loading: 'eager',
            source: {type: 'project', name: 'Beach'},
          },
          {
            id: 'RescuePose',
            kind: 'poseModel',
            loading: 'eager',
            source: {
              type: 'file',
              files: [
                {path: 'metadata.json', size: files.get('RescuePose\0metadata.json').length},
                {path: 'model.json', size: files.get('RescuePose\0model.json').length},
                {path: 'weights.bin', size: files.get('RescuePose\0weights.bin').length},
              ],
            },
          },
        ],
      },
    },
    getAssetFile(assetId, filePath) {
      return new Uint8Array(files.get(`${assetId}\0${filePath}`));
    },
  };
}

function factories(log, overrides = {}) {
  const assetManagerComposition = {
    async registerProjectAsset(input) {
      log.push(['media.register-project', input.name]);
      return {name: input.name, mimeType: 'image/svg+xml'};
    },
    async registerEmbeddedAsset(input) {
      log.push(['media.register-embedded', input.name]);
      return {name: input.name, mimeType: 'image/svg+xml'};
    },
    releaseAsset(name) {
      log.push(['media.release', name]);
    },
    releaseAll() {
      log.push(['media.release-all']);
    },
    isRegistered() {
      return true;
    },
    getMimeType() {
      return 'image/svg+xml';
    },
    async applyToStage() {},
    async applyToTarget() {},
    async playSound() {},
    stopSound() {},
    stopAllSounds() {},
    ...overrides.assetManager,
  };
  const tmposeComposition = {
    async registerPoseModel(input) {
      log.push(['pose.register', input.name]);
      return {name: input.name, labels: ['idle', 'rescue']};
    },
    async releasePoseModel(name) {
      log.push(['pose.release', name]);
    },
    async releaseAll() {
      log.push(['pose.release-all']);
    },
    activatePoseModel() {},
    isPoseModelRegistered() {
      return true;
    },
    getActivePoseModelName() {
      return null;
    },
    async startCamera() {},
    stopCamera() {},
    isCameraRunning() {
      return false;
    },
    async startRecognition() {},
    stopRecognition() {},
    isRecognizing() {
      return false;
    },
    currentPose() {
      return '';
    },
    confidence() {
      return 0;
    },
    confidenceOf() {
      return 0;
    },
    ...overrides.tmpose,
  };
  return {
    assetManagerComposition,
    tmposeComposition,
    createAssetManagerComposition() {
      log.push(['media.create']);
      return assetManagerComposition;
    },
    createTMPoseComposition(options) {
      log.push(['pose.create', options.runtime]);
      return tmposeComposition;
    },
  };
}

function options(component, log, overrides = {}) {
  const created = factories(log, overrides);
  const tmPoseRuntime = {Webcam: class {}, async loadFromFiles() {}};
  return {
    created,
    tmPoseRuntime,
    value: {
      runtimeComponent: component,
      tmPoseRuntime,
      setLoading(payload) {
        log.push(['loading', payload.visible]);
      },
      createAssetManagerComposition: created.createAssetManagerComposition,
      createTMPoseComposition: created.createTMPoseComposition,
    },
  };
}

function context() {
  return {signal: new AbortController().signal, generation: 1, sceneId: 'opening'};
}

test('creates one shared composition pair and routes a complete lifecycle through it', async () => {
  const log = [];
  const setup = options(runtimeComponent(), log);
  const session = createDsl4PlatformAssetSession(setup.value);

  assert.strictEqual(session.assetManagerComposition, setup.created.assetManagerComposition);
  assert.strictEqual(session.tmposeComposition, setup.created.tmposeComposition);
  assert.equal(Object.isFrozen(session), true);
  assert.equal(Object.isFrozen(session.lifecycle), true);
  await session.lifecycle.prepare({assetIds: ['RescuePose', 'Beach']}, context());
  await session.lifecycle.setLoading({visible: true}, context());

  assert.deepEqual(log.slice(0, 5), [
    ['media.create'],
    ['pose.create', setup.tmPoseRuntime],
    ['media.register-project', 'Beach'],
    ['pose.register', 'RescuePose'],
    ['loading', true],
  ]);
  const firstDispose = session.dispose('app-shell-dispose');
  const secondDispose = session.dispose('ignored-second-reason');
  assert.strictEqual(secondDispose, firstDispose);
  await firstDispose;
  assert.deepEqual(log.slice(5), [
    ['pose.release', 'RescuePose'],
    ['media.release', 'Beach'],
    ['pose.release-all'],
    ['media.release-all'],
  ]);
  await assert.rejects(
    async () => session.lifecycle.prepare({assetIds: ['Beach']}, context()),
    (error) => error.code === 'K4-PLATFORM-ASSET-SESSION-001',
  );
});

test('keeps compositions, resources, and final disposal isolated between sessions', async () => {
  const firstLog = [];
  const secondLog = [];
  const first = createDsl4PlatformAssetSession(options(runtimeComponent(), firstLog).value);
  const second = createDsl4PlatformAssetSession(options(runtimeComponent(), secondLog).value);
  await first.lifecycle.prepare({assetIds: ['Beach']}, context());
  await second.lifecycle.prepare({assetIds: ['Beach']}, context());

  await first.dispose();
  assert.deepEqual(firstLog.slice(-2), [['pose.release-all'], ['media.release-all']]);
  assert.deepEqual(secondLog.slice(-1), [['media.register-project', 'Beach']]);
  await second.lifecycle.prepare({assetIds: ['Beach']}, context());
  await second.dispose();
  assert.deepEqual(secondLog.slice(-3), [
    ['media.release', 'Beach'],
    ['pose.release-all'],
    ['media.release-all'],
  ]);
});

test('attempts every final cleanup and aggregates lifecycle and composition failures', async () => {
  const log = [];
  const failure = new Error('release failed');
  const setup = options(runtimeComponent(), log, {
    assetManager: {
      releaseAsset(name) {
        log.push(['media.release', name]);
        throw failure;
      },
      releaseAll() {
        log.push(['media.release-all']);
        throw new Error('media releaseAll failed');
      },
    },
    tmpose: {
      async releasePoseModel(name) {
        log.push(['pose.release', name]);
        throw failure;
      },
      async releaseAll() {
        log.push(['pose.release-all']);
        throw new Error('pose releaseAll failed');
      },
    },
  });
  const session = createDsl4PlatformAssetSession(setup.value);
  await session.lifecycle.prepare({assetIds: ['Beach', 'RescuePose']}, context());

  await assert.rejects(session.dispose(), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.equal(error.errors.length, 3);
    assert.equal(error.errors[0] instanceof AggregateError, true);
    assert.equal(error.errors[0].errors.length, 2);
    return true;
  });
  assert.deepEqual(log.slice(-4), [
    ['pose.release', 'RescuePose'],
    ['media.release', 'Beach'],
    ['pose.release-all'],
    ['media.release-all'],
  ]);
});

test('rejects invalid input before factories and cleans an incomplete factory chain', () => {
  let factoryCalls = 0;
  const base = {
    runtimeComponent: runtimeComponent(),
    tmPoseRuntime: {Webcam: class {}, async loadFromFiles() {}},
    setLoading() {},
    createAssetManagerComposition() {
      factoryCalls += 1;
      return factories([]).assetManagerComposition;
    },
  };
  assert.throws(
    () => createDsl4PlatformAssetSession({...base, runtimeComponent: {}}),
    /validated StoryDocument/u,
  );
  assert.throws(
    () => createDsl4PlatformAssetSession({...base, tmPoseRuntime: {}}),
    /Webcam and loadFromFiles/u,
  );
  assert.equal(factoryCalls, 0);

  const log = [];
  const setup = options(runtimeComponent(), log);
  assert.throws(
    () =>
      createDsl4PlatformAssetSession({
        ...setup.value,
        createTMPoseComposition() {
          throw new Error('TMPose creation failed');
        },
      }),
    /TMPose creation failed/u,
  );
  assert.deepEqual(log, [['media.create'], ['media.release-all']]);

  const invalidLog = [];
  const invalid = factories(invalidLog);
  delete invalid.assetManagerComposition.applyToStage;
  assert.throws(
    () =>
      createDsl4PlatformAssetSession({
        ...base,
        createAssetManagerComposition: invalid.createAssetManagerComposition,
      }),
    /applyToStage/u,
  );
  assert.deepEqual(invalidLog, [['media.create'], ['media.release-all']]);
});

test('keeps the platform session outside the default-off core import graph', async () => {
  const [coreIndex, startup, platformSource] = await Promise.all([
    readFile(path.join(repositoryRoot, 'src', 'dsl4', 'index.js'), 'utf8'),
    readFile(path.join(repositoryRoot, 'src', 'dsl4', 'runtime-startup.js'), 'utf8'),
    readFile(
      path.join(repositoryRoot, 'src', 'dsl4', 'platform', 'platform-asset-session.js'),
      'utf8',
    ),
  ]);
  assert.doesNotMatch(coreIndex, /platform-asset-session|\.\/platform/u);
  assert.doesNotMatch(startup, /platform-asset-session|turbowarp-tmpose/u);
  assert.doesNotMatch(
    platformSource,
    /(?:node:fs|node:http|node:https|\bfetch\s*\(|\bScratch\b|indexedDB)/u,
  );
});
