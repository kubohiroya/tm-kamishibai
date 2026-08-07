import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import test from 'node:test';

import {createVerifiedRemoteBinaryCache} from '@kubohiroya/turbowarp-asset-manager/composition';
import {IDBFactory} from 'fake-indexeddb';
import {strToU8, zipSync} from 'fflate';

import {createDsl4PlatformAssetSession} from '../src/dsl4/platform/index.js';

const cacheIdentity = Object.freeze({
  id: 'story001',
  label: 'story.kamishibai.yaml',
  databaseName: 'tw-kamishibai-assets-v1--story--story001',
});

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

function remoteRuntimeComponent(remoteBytes) {
  return {
    storyDocument: {kind: 'StoryDocument', version: '4.0'},
    assetBundle: {
      manifest: {
        assets: [
          {
            id: 'RemoteBeach',
            kind: 'backdrop',
            loading: 'lazy',
            source: {
              type: 'remote',
              url: 'https://cdn.example.com/beach.svg',
              integrity: `sha256-${createHash('sha256').update(remoteBytes).digest('hex')}`,
              contentType: 'image/svg+xml',
              size: remoteBytes.byteLength,
            },
          },
        ],
      },
    },
    getAssetFile() {
      assert.fail('remote platform session must not read embedded bytes');
    },
  };
}

function remotePoseRuntimeComponent(remoteBytes) {
  return {
    storyDocument: {kind: 'StoryDocument', version: '4.0'},
    assetBundle: {
      manifest: {
        assets: [
          {
            id: 'RemotePose',
            kind: 'poseModel',
            loading: 'lazy',
            source: {
              type: 'remote',
              url: 'https://cdn.example.com/pose.zip',
              integrity: `sha256-${createHash('sha256').update(remoteBytes).digest('hex')}`,
              contentType: 'application/zip',
              size: remoteBytes.byteLength,
            },
          },
        ],
      },
    },
    getAssetFile() {
      assert.fail('remote pose model must not read embedded bytes');
    },
  };
}

function poseArchiveLimits() {
  return {
    maxArchiveBytes: 64 * 1024,
    maxEntries: 3,
    maxCompressedEntryBytes: 32 * 1024,
    maxExpandedEntryBytes: 32 * 1024,
    maxTotalExpandedBytes: 64 * 1024,
    maxCompressionRatio: 100,
  };
}

function factories(log, overrides = {}) {
  const assetManagerCreateArguments = [];
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
    async resolveVerifiedRemoteBinary(input, resolveOptions) {
      const loaded = await resolveOptions.load(input, {signal: resolveOptions.signal});
      return {
        bytes:
          loaded.bytes instanceof Uint8Array
            ? loaded.bytes
            : new Uint8Array(/** @type {ArrayBuffer} */ (loaded.bytes)),
        contentType: String(loaded.contentType).split(';', 1)[0],
        integrity: input.integrity,
        source: 'network',
        cacheRead: 'miss',
        cacheWrite: 'stored',
        cacheWarnings: [],
      };
    },
    async getVerifiedRemoteCacheStats() {},
    async pruneVerifiedRemoteCache() {},
    async clearVerifiedRemoteCache() {},
    async listVerifiedRemoteStoryCaches() {
      return [];
    },
    async pruneVerifiedRemoteStoryCaches() {},
    async deleteVerifiedRemoteStoryCache() {},
    async renewVerifiedRemoteStoryCacheLease() {},
    async releaseVerifiedRemoteStoryCacheLease() {
      log.push(['cache.release-lease']);
    },
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
    configureAccumulatedPose() {},
    resetAccumulatedPose() {},
    subscribeAccumulatedPose() {
      return () => {};
    },
    ...overrides.tmpose,
  };
  return {
    assetManagerComposition,
    assetManagerCreateArguments,
    tmposeComposition,
    createAssetManagerComposition(...args) {
      assetManagerCreateArguments.push(args);
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
  assert.equal(typeof session.asyncInputComposition.waitForPoseCandidate, 'function');
  assert.equal(typeof session.asyncInputComposition.waitForKeyCandidate, 'function');
  assert.equal(typeof session.asyncInputComposition.waitForActorTouchCandidate, 'function');
  assert.equal(typeof session.poseActionPort.waitForPose, 'function');
  assert.equal(typeof session.poseActionPort.poseInputToChangeScene, 'function');
  assert.equal(session.posePreviewPort, null);
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

test('passes pose, key, and actor touch sources into one Async Input composition', async () => {
  const log = [];
  const setup = options(runtimeComponent(), log);
  const keySource = Object.freeze({kind: 'key-source'});
  const actorTouchSource = Object.freeze({kind: 'actor-touch-source'});
  let receivedOptions;
  let releaseCalls = 0;
  const session = createDsl4PlatformAssetSession({
    ...setup.value,
    keySource,
    actorTouchSource,
    createAsyncInputComposition(input) {
      receivedOptions = input;
      return {
        waitForPoseCandidate() {},
        waitForKeyCandidate() {},
        waitForActorTouchCandidate() {},
        releaseAll() {
          releaseCalls += 1;
        },
      };
    },
  });

  assert.strictEqual(receivedOptions.poseSource, setup.created.tmposeComposition);
  assert.strictEqual(receivedOptions.keySource, keySource);
  assert.strictEqual(receivedOptions.actorTouchSource, actorTouchSource);
  await session.dispose('source-forwarding-complete');
  assert.equal(releaseCalls, 1);
});

test('keeps pose feedback observer behind an explicit default-off session gate', async () => {
  const disabledLog = [];
  const disabledSetup = options(runtimeComponent(), disabledLog);
  Object.defineProperty(disabledSetup.value, 'onPoseState', {
    get() {
      assert.fail('disabled pose feedback must not inspect its observer');
    },
  });
  Object.defineProperty(disabledSetup.value, 'readPoseStateBinding', {
    get() {
      assert.fail('disabled pose feedback must not inspect its binding reader');
    },
  });
  const disabled = createDsl4PlatformAssetSession(disabledSetup.value);
  await disabled.dispose('feedback-disabled');

  const invalidLog = [];
  const invalidSetup = options(runtimeComponent(), invalidLog);
  assert.throws(
    () =>
      createDsl4PlatformAssetSession({
        ...invalidSetup.value,
        poseFeedbackEnabled: true,
      }),
    /onPoseState/u,
  );
  assert.deepEqual(invalidLog, []);
  assert.throws(
    () =>
      createDsl4PlatformAssetSession({
        ...invalidSetup.value,
        poseFeedbackEnabled: true,
        onPoseState() {},
        readPoseStateBinding: true,
      }),
    /readPoseStateBinding/u,
  );
  assert.deepEqual(invalidLog, []);

  const enabledLog = [];
  const enabledSetup = options(runtimeComponent(), enabledLog);
  const enabled = createDsl4PlatformAssetSession({
    ...enabledSetup.value,
    poseFeedbackEnabled: true,
    onPoseState() {},
    readPoseStateBinding() {
      return null;
    },
  });
  await enabled.dispose('feedback-enabled');
});

test('gates pose preview mirroring and uses one composition method before or during camera use', async () => {
  const disabledLog = [];
  const disabledSetup = options(runtimeComponent(), disabledLog);
  Object.defineProperty(disabledSetup.created.tmposeComposition, 'setPreviewMirroring', {
    get() {
      assert.fail('disabled pose preview mirroring must not inspect the TMPose method');
    },
  });
  const disabled = createDsl4PlatformAssetSession(disabledSetup.value);
  assert.equal(disabled.posePreviewPort, null);
  await disabled.dispose('pose-preview-disabled');

  const missingSetup = options(runtimeComponent(), []);
  assert.throws(
    () =>
      createDsl4PlatformAssetSession({
        ...missingSetup.value,
        posePreviewMirroringEnabled: true,
      }),
    /setPreviewMirroring/u,
  );

  let cameraRunning = false;
  const enabledLog = [];
  const enabledSetup = options(runtimeComponent(), enabledLog, {
    tmpose: {
      startCamera() {
        cameraRunning = true;
      },
      isCameraRunning() {
        return cameraRunning;
      },
      setPreviewMirroring(mode) {
        enabledLog.push(['pose.preview-mirroring', mode, cameraRunning]);
      },
    },
  });
  const enabled = createDsl4PlatformAssetSession({
    ...enabledSetup.value,
    posePreviewMirroringEnabled: true,
  });
  enabled.posePreviewPort.setPosePreviewMirroring('mirrored');
  await enabled.tmposeComposition.startCamera();
  enabled.posePreviewPort.setPosePreviewMirroring('unmirrored');
  assert.deepEqual(
    enabledLog.filter(([event]) => event === 'pose.preview-mirroring'),
    [
      ['pose.preview-mirroring', 'mirrored', false],
      ['pose.preview-mirroring', 'unmirrored', true],
    ],
  );
  assert.throws(() => enabled.posePreviewPort.setPosePreviewMirroring('reversed'), /invalid/u);
  await enabled.dispose('pose-preview-enabled');
  assert.throws(
    () => enabled.posePreviewPort.setPosePreviewMirroring('mirrored'),
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

test('enables verified remote loading only when the app shell injects a loader', async () => {
  const remoteBytes = new TextEncoder().encode('<svg id="remote-beach"/>');
  const component = remoteRuntimeComponent(remoteBytes);
  const disabledLog = [];
  const disabled = createDsl4PlatformAssetSession(options(component, disabledLog).value);
  await assert.rejects(
    disabled.lifecycle.prepare({assetIds: ['RemoteBeach']}, context()),
    (error) => error.code === 'K4-ASSET-REMOTE-DISABLED',
  );
  await disabled.dispose('disabled-cleanup');

  const enabledLog = [];
  const setup = options(component, enabledLog);
  const loads = [];
  const enabled = createDsl4PlatformAssetSession({
    ...setup.value,
    cacheIdentity,
    async loadRemoteAsset(payload, loadContext) {
      loads.push({payload, signal: loadContext.signal});
      return {bytes: remoteBytes, contentType: 'image/svg+xml'};
    },
  });
  await enabled.lifecycle.prepare({assetIds: ['RemoteBeach']}, context());
  assert.equal(loads.length, 1);
  assert.equal(loads[0].payload.url, 'https://cdn.example.com/beach.svg');
  assert.deepEqual(setup.created.assetManagerCreateArguments, [
    [undefined, {verifiedRemoteCache: {cacheIdentity}}],
  ]);
  assert.deepEqual(enabled.verifiedRemoteCache.identity, cacheIdentity);
  assert.deepEqual(enabled.verifiedRemoteCache.getWarnings(), []);
  assert.ok(
    enabledLog.some(([event, id]) => event === 'media.register-embedded' && id === 'RemoteBeach'),
  );
  await enabled.dispose('remote-cleanup');
  assert.ok(enabledLog.some(([event, id]) => event === 'media.release' && id === 'RemoteBeach'));
  assert.ok(enabledLog.some(([event]) => event === 'cache.release-lease'));
});

test('uses the story-scoped IndexedDB cache before calling the host loader', async () => {
  const remoteBytes = new TextEncoder().encode('<svg id="cached-beach"/>');
  const component = remoteRuntimeComponent(remoteBytes);
  const indexedDB = new IDBFactory();
  const log = [];
  let networkLoads = 0;

  function createSession(loader) {
    const setup = options(component, log);
    return createDsl4PlatformAssetSession({
      ...setup.value,
      cacheIdentity,
      verifiedRemoteCacheOptions: {
        indexedDB,
        subtleCrypto: webcrypto.subtle,
        estimateStorage: async () => ({quota: 64 * 1024 * 1024, usage: 0}),
      },
      loadRemoteAsset: loader,
      createAssetManagerComposition(_featureFlags, compositionOptions) {
        log.push(['media.create']);
        const cache = createVerifiedRemoteBinaryCache(compositionOptions.verifiedRemoteCache);
        return Object.freeze({
          ...setup.created.assetManagerComposition,
          resolveVerifiedRemoteBinary: (input, resolveOptions) =>
            cache.resolve(input, resolveOptions),
          getVerifiedRemoteCacheStats: () => cache.getStats(),
          pruneVerifiedRemoteCache: () => cache.prune(),
          clearVerifiedRemoteCache: () => cache.clear(),
          listVerifiedRemoteStoryCaches: () => cache.listStoryCaches(),
          pruneVerifiedRemoteStoryCaches: () => cache.pruneStoryCaches(),
          deleteVerifiedRemoteStoryCache: (databaseName) => cache.deleteStoryCache(databaseName),
          renewVerifiedRemoteStoryCacheLease: () => cache.renewStoryCacheLease(),
          releaseVerifiedRemoteStoryCacheLease: () => cache.releaseStoryCacheLease(),
        });
      },
    });
  }

  const first = createSession(async () => {
    networkLoads += 1;
    return {bytes: Uint8Array.from(remoteBytes), contentType: 'image/svg+xml'};
  });
  await first.lifecycle.prepare({assetIds: ['RemoteBeach']}, context());
  assert.equal(networkLoads, 1);
  assert.equal((await first.verifiedRemoteCache.getStats()).entries, 1);
  await first.dispose('first-session-complete');

  const second = createSession(async () => {
    networkLoads += 1;
    throw new Error('offline loader must not run for a valid cache hit');
  });
  await second.lifecycle.prepare({assetIds: ['RemoteBeach']}, context());
  assert.equal(networkLoads, 1);
  assert.deepEqual(second.verifiedRemoteCache.getWarnings(), []);
  await second.dispose('second-session-complete');
});

test('extracts a verified remote pose archive inside the platform boundary', async () => {
  const remoteBytes = zipSync({
    'metadata.json': strToU8('{"labels":["rescue"]}'),
    'model.json': strToU8('{"model":true}'),
    'weights.bin': Uint8Array.from([1, 2, 3]),
  });
  const component = remotePoseRuntimeComponent(remoteBytes);
  const log = [];
  let registration;
  const setup = options(component, log, {
    tmpose: {
      async registerPoseModel(input) {
        registration = input;
        log.push(['pose.register', input.name]);
        return {name: input.name, labels: ['rescue']};
      },
    },
  });
  const session = createDsl4PlatformAssetSession({
    ...setup.value,
    cacheIdentity,
    poseArchiveLimits: poseArchiveLimits(),
    subtleCrypto: webcrypto.subtle,
    async loadRemoteAsset() {
      return {bytes: remoteBytes, contentType: 'application/zip'};
    },
  });

  await session.lifecycle.prepare({assetIds: ['RemotePose']}, context());
  assert.equal(registration.name, 'RemotePose');
  assert.deepEqual(
    registration.files.map((file) => file.path),
    ['metadata.json', 'model.json', 'weights.bin'],
  );
  await session.dispose('remote-pose-complete');
  assert.ok(log.some(([event, name]) => event === 'pose.release' && name === 'RemotePose'));
});

test('bounds repeated remote pose materialization and persistent cache bytes', async () => {
  const remoteBytes = zipSync({
    'metadata.json': strToU8('{"labels":["rescue"]}'),
    'model.json': strToU8('{"model":true}'),
    'weights.bin': Uint8Array.from([1, 2, 3]),
  });
  const indexedDB = new IDBFactory();
  const component = remotePoseRuntimeComponent(remoteBytes);
  const log = [];
  let networkLoads = 0;
  let activeModels = 0;
  let maximumActiveModels = 0;
  let registrations = 0;
  let modelReleases = 0;
  const setup = options(component, log, {
    tmpose: {
      async registerPoseModel(input) {
        registrations += 1;
        activeModels += 1;
        maximumActiveModels = Math.max(maximumActiveModels, activeModels);
        return {name: input.name, labels: ['rescue']};
      },
      async releasePoseModel() {
        modelReleases += 1;
        activeModels -= 1;
      },
    },
  });
  const session = createDsl4PlatformAssetSession({
    ...setup.value,
    cacheIdentity,
    poseArchiveLimits: poseArchiveLimits(),
    subtleCrypto: webcrypto.subtle,
    verifiedRemoteCacheOptions: {
      indexedDB,
      subtleCrypto: webcrypto.subtle,
      estimateStorage: async () => ({quota: 64 * 1024 * 1024, usage: 0}),
    },
    async loadRemoteAsset() {
      networkLoads += 1;
      return {bytes: Uint8Array.from(remoteBytes), contentType: 'application/zip'};
    },
    createAssetManagerComposition(_featureFlags, compositionOptions) {
      const cache = createVerifiedRemoteBinaryCache(compositionOptions.verifiedRemoteCache);
      return Object.freeze({
        ...setup.created.assetManagerComposition,
        resolveVerifiedRemoteBinary: (input, resolveOptions) =>
          cache.resolve(input, resolveOptions),
        getVerifiedRemoteCacheStats: () => cache.getStats(),
        pruneVerifiedRemoteCache: () => cache.prune(),
        clearVerifiedRemoteCache: () => cache.clear(),
        listVerifiedRemoteStoryCaches: () => cache.listStoryCaches(),
        pruneVerifiedRemoteStoryCaches: () => cache.pruneStoryCaches(),
        deleteVerifiedRemoteStoryCache: (databaseName) => cache.deleteStoryCache(databaseName),
        renewVerifiedRemoteStoryCacheLease: () => cache.renewStoryCacheLease(),
        releaseVerifiedRemoteStoryCacheLease: () => cache.releaseStoryCacheLease(),
      });
    },
  });

  for (let visit = 0; visit < 12; visit += 1) {
    await session.lifecycle.prepare({assetIds: ['RemotePose']}, context());
    assert.equal(activeModels, 1);
    const stats = await session.verifiedRemoteCache.getStats();
    assert.equal(stats.entries, 1);
    assert.equal(stats.bytes, remoteBytes.byteLength);
    await session.lifecycle.releaseAssets({
      assetIds: ['RemotePose'],
      reason: 'scene-transition',
    });
    assert.equal(activeModels, 0);
  }

  assert.equal(networkLoads, 1);
  assert.equal(maximumActiveModels, 1);
  assert.equal(registrations, 12);
  assert.equal(modelReleases, 12);
  assert.deepEqual(
    await session.verifiedRemoteCache.getStats().then(({entries, bytes}) => ({entries, bytes})),
    {entries: 1, bytes: remoteBytes.byteLength},
  );
  await session.dispose('bounded-repetition-complete');
  assert.equal(activeModels, 0);
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
  assert.throws(
    () => createDsl4PlatformAssetSession({...base, loadRemoteAsset() {}}),
    /cacheIdentity must be an object/u,
  );
  assert.throws(
    () =>
      createDsl4PlatformAssetSession({
        ...base,
        runtimeComponent: remotePoseRuntimeComponent(new Uint8Array([1])),
        cacheIdentity,
        loadRemoteAsset() {},
      }),
    /pose archive limits/u,
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
