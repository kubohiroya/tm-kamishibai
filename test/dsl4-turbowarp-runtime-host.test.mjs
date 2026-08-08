import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {installDsl4PackagedRuntimeComponent} from '../src/builder/index.js';
import {
  createDsl4EmbeddedAssetBundle,
  createDsl4EmbeddedSourceDescriptor,
  createDsl4RuntimeArtifactDescriptor,
  createDsl4SourceFrontend,
  loadDsl4RuntimeComponent,
} from '../src/dsl4/index.js';
import {
  createDsl4StandardAppShell,
  createDsl4TurboWarpPreviewSessionFactory,
  createDsl4TurboWarpRuntimeHost,
} from '../src/dsl4/platform/index.js';
import {createFakeDocument} from './helpers/fake-dom.mjs';
import {loadKamishibaiVm, turbowarpVmCommit} from './helpers/turbowarp-vm.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const subtleCrypto = webcrypto.subtle;
const limits = {maxSourceBytes: 16_384, maxAssetFiles: 20, maxAssetBytes: 16_384};
const waitStory = `
kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - wait: 0
`;
const speechStory = `
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
  Voice: sound
actors:
  Hero: HeroIdle
speechStyles:
  novel:
    characterIntervalSeconds: 60
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - Hero.think:
        text: どうしよう
        waitFor: advance
        style: novel
        startSound: Voice
    - wait: 0
`;
const posePreviewStory = `
kamishibai: '4.0'
assets:
  Tick: sound
  Charge: sound
poseRecognition:
  idleSound: Tick
  chargeSound: Charge
  preview:
    mirroring: unmirrored
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    posePreview:
      mirroring: mirrored
    actions: []
  reset: []
`;
const cameraPreviewControlsStory = `
kamishibai: '4.0'
assets:
  Tick: sound
  Charge: sound
  ShowMirrored:
    kind: image
    delivery: remote
    source:
      url: https://cdn.example.com/show-mirrored.svg
      integrity: sha256-0000000000000000000000000000000000000000000000000000000000000000
      contentType: image/svg+xml
      size: 6
  ShowUnmirrored:
    kind: image
    delivery: remote
    source:
      url: https://cdn.example.com/show-unmirrored.svg
      integrity: sha256-1111111111111111111111111111111111111111111111111111111111111111
      contentType: image/svg+xml
      size: 6
  CameraMenu:
    kind: image
    delivery: remote
    source:
      url: https://cdn.example.com/camera-menu.svg
      integrity: sha256-2222222222222222222222222222222222222222222222222222222222222222
      contentType: image/svg+xml
      size: 6
poseRecognition:
  idleSound: Tick
  chargeSound: Charge
  preview:
    mirroring: mirrored
    controls:
      mirroring:
        position: top-center
        assets:
          showMirrored: ShowMirrored
          showUnmirrored: ShowUnmirrored
      cameraMenu:
        position: bottom-center
        buttonAsset: CameraMenu
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    posePreview:
      mirroring: unmirrored
    actions:
      - wait: 3600
`;
const cameraPreviewControlsHistoryStory = cameraPreviewControlsStory.replace(
  '      Space: navigation.nextAction',
  '      Space: navigation.nextAction\n      ArrowLeft: history.previousAction',
);

function findByDataset(root, key, value) {
  if (root.dataset?.[key] === value) return root;
  for (const child of root.children ?? []) {
    const found = findByDataset(child, key, value);
    if (found) return found;
  }
  return null;
}

function baseProject() {
  return {extensionStorage: {}, targets: [], monitors: []};
}

function manualScheduler() {
  let currentTime = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    scheduler: {
      now: () => currentTime,
      setTimeout(callback, milliseconds) {
        const id = nextId;
        nextId += 1;
        timers.set(id, {callback, due: currentTime + milliseconds});
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    pendingCount: () => timers.size,
    advance(milliseconds) {
      const targetTime = currentTime + milliseconds;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.due <= targetTime)
          .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        currentTime = timer.due;
        timer.callback();
      }
      currentTime = targetTime;
    },
  };
}

async function packagedProject(
  sourceText = waitStory,
  {cacheIdentity, historyNavigationAvailable = false} = {},
) {
  const parsed = frontend.parse(sourceText, {sourceId: 'main', historyNavigationAvailable});
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const sourceDescriptor = await createDsl4EmbeddedSourceDescriptor(sourceText, {
    sourceId: 'main',
    displayName: 'story.kamishibai.yaml',
    maxSourceBytes: limits.maxSourceBytes,
    ...(cacheIdentity === undefined ? {} : {cacheIdentity}),
    subtleCrypto,
  });
  const artifactResult = await createDsl4RuntimeArtifactDescriptor(
    parsed.storyDocument,
    sourceDescriptor,
    'production',
    {maxSourceBytes: limits.maxSourceBytes, historyNavigationAvailable, subtleCrypto},
  );
  assert.equal(artifactResult.ok, true, JSON.stringify(artifactResult.diagnostics));
  const snapshotAssets = Object.values(parsed.storyDocument.assets)
    .map((asset) => {
      const source =
        asset.delivery === 'remote'
          ? {type: 'remote', ...asset.source}
          : {type: 'project', name: asset.name};
      return {
        id: asset.id,
        kind: asset.kind,
        loading: asset.loading,
        ...(typeof asset.target === 'string' ? {target: asset.target} : {}),
        source,
      };
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const assetBundle = await createDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    {manifest: {formatVersion: 1, assets: snapshotAssets}, getFile() {}},
    {maxFiles: limits.maxAssetFiles, maxTotalBytes: limits.maxAssetBytes, subtleCrypto},
  );
  return installDsl4PackagedRuntimeComponent(
    baseProject(),
    parsed.storyDocument,
    sourceDescriptor,
    artifactResult.artifact,
    assetBundle,
    {
      channel: 'unbundled',
      ...limits,
      historyNavigationAvailable,
      subtleCrypto,
    },
  );
}

async function packagedPoseProject(sourceText) {
  const parsed = frontend.parse(sourceText, {sourceId: 'main'});
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const sourceDescriptor = await createDsl4EmbeddedSourceDescriptor(sourceText, {
    sourceId: 'main',
    displayName: 'story.kamishibai.yaml',
    maxSourceBytes: limits.maxSourceBytes,
    subtleCrypto,
  });
  const artifactResult = await createDsl4RuntimeArtifactDescriptor(
    parsed.storyDocument,
    sourceDescriptor,
    'production',
    {maxSourceBytes: limits.maxSourceBytes, subtleCrypto},
  );
  assert.equal(artifactResult.ok, true, JSON.stringify(artifactResult.diagnostics));
  const poseFiles = new Map([
    ['metadata.json', new TextEncoder().encode('{"labels":["help"]}')],
    ['model.json', new TextEncoder().encode('{"modelTopology":{}}')],
    ['weights.bin', new Uint8Array([1])],
  ]);
  const poseSourceFiles = [...poseFiles].map(([filePath, bytes]) => ({
    path: filePath,
    size: bytes.byteLength,
    integrity: `sha256-${createHash('sha256').update(bytes).digest('base64')}`,
  }));
  const snapshotAssets = Object.values(parsed.storyDocument.assets)
    .map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      loading: asset.loading,
      ...(typeof asset.target === 'string' ? {target: asset.target} : {}),
      source:
        asset.kind === 'poseModel'
          ? {
              type: 'file',
              inputPath: asset.file,
              mode: 'directory',
              files: poseSourceFiles,
            }
          : {type: 'project', name: asset.name},
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const assetBundle = await createDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    {
      manifest: {formatVersion: 1, assets: snapshotAssets},
      getFile(assetId, filePath) {
        assert.equal(assetId, 'RescuePose');
        return new Uint8Array(poseFiles.get(filePath));
      },
    },
    {maxFiles: limits.maxAssetFiles, maxTotalBytes: limits.maxAssetBytes, subtleCrypto},
  );
  return installDsl4PackagedRuntimeComponent(
    baseProject(),
    parsed.storyDocument,
    sourceDescriptor,
    artifactResult.artifact,
    assetBundle,
    {channel: 'unbundled', ...limits, subtleCrypto},
  );
}

function platformFixture(log) {
  const poseConfidence = {
    id: 'pose-confidence',
    name: 'ポーズ認識',
    type: '',
    isCloud: false,
    value: 0,
  };
  const poseProgress = {
    id: 'pose-progress',
    name: 'チャージ',
    type: '',
    isCloud: false,
    value: 0,
  };
  const monitorRecords = new Map();
  const monitorBlocksById = new Map();
  for (const variable of [poseConfidence, poseProgress]) {
    monitorRecords.set(variable.id, {
      id: variable.id,
      opcode: 'data_variable',
      params: {VARIABLE: variable.name},
      targetId: null,
      spriteName: null,
      mode: 'slider',
      sliderMin: 0,
      sliderMax: 100,
      isDiscrete: true,
      visible: false,
      get(property) {
        return this[property];
      },
    });
    monitorBlocksById.set(variable.id, {
      id: variable.id,
      opcode: 'data_variable',
      fields: {VARIABLE: {id: variable.id, value: variable.name}},
      isMonitored: false,
    });
  }
  const monitorBlocks = {
    getBlock: (id) => monitorBlocksById.get(id),
    getScripts: () => [...monitorBlocksById.keys()],
    changeBlock({id, element, value}) {
      assert.equal(element, 'checkbox');
      const block = monitorBlocksById.get(id);
      const record = monitorRecords.get(id);
      if (!block || !record) return;
      block.isMonitored = value;
      record.visible = value;
    },
  };
  const monitorState = {
    has: (id) => monitorRecords.has(id),
    get: (id) => monitorRecords.get(id),
    valueSeq: () => monitorRecords.values(),
  };
  const stage = {
    id: 'stage-target',
    isStage: true,
    variables: {
      [poseConfidence.id]: poseConfidence,
      [poseProgress.id]: poseProgress,
    },
    lookupVariableByNameAndType(name, type) {
      assert.equal(type, '');
      if (name === 'ポーズ認識') return poseConfidence;
      if (name === 'チャージ') return poseProgress;
      return null;
    },
  };
  const actor = {
    id: 'actor-target',
    isStage: false,
    drawableID: 7,
    x: 0,
    y: 0,
    lookupVariableByNameAndType(name) {
      return name === 'actorName' ? {value: 'Hero'} : null;
    },
    setXY(x, y) {
      this.x = x;
      this.y = y;
      log.push(['actor.xy', x, y]);
    },
    setSize(size) {
      log.push(['actor.size', size]);
    },
    setVisible(visible) {
      log.push(['actor.visible', visible]);
    },
    setEffect(effect, value) {
      log.push(['actor.effect', effect, value]);
    },
    goToFront() {
      log.push(['actor.layer', 'front']);
    },
    goToBack() {
      log.push(['actor.layer', 'back']);
    },
    goForwardLayers(count) {
      log.push(['actor.layer', count]);
    },
    goBackwardLayers(count) {
      log.push(['actor.layer', -count]);
    },
  };
  const assetManagerComposition = {
    async registerProjectAsset(input) {
      log.push(['media.register', input.name]);
      return {
        name: input.name,
        mimeType: input.locator.kind === 'sound' ? 'audio/wav' : 'image/svg+xml',
      };
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
    getMimeType(name) {
      return name === 'Bell' || name === 'Tick' || name === 'Voice' ? 'audio/wav' : 'image/svg+xml';
    },
    applyToStage(name) {
      log.push(['media.stage', name]);
    },
    applyToTarget(name) {
      log.push(['media.target', name]);
    },
    playSound(name) {
      log.push(['media.play', name]);
    },
    stopSound(name) {
      log.push(['media.stop', name]);
    },
    stopAllSounds() {},
    async resolveVerifiedRemoteBinary(input, options) {
      const loaded = await options.load(input, {signal: options.signal});
      return {
        bytes: loaded.bytes,
        contentType: loaded.contentType,
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
    async renewVerifiedRemoteStoryCacheLease() {
      log.push(['cache.renew-lease']);
    },
    async releaseVerifiedRemoteStoryCacheLease() {
      log.push(['cache.release-lease']);
    },
  };
  const tmposeComposition = {
    registerPoseModel() {
      return {name: 'Pose', labels: ['pose']};
    },
    activatePoseModel() {},
    releasePoseModel() {},
    releaseAll() {
      log.push(['pose.release-all']);
    },
    isPoseModelRegistered() {
      return true;
    },
    getActivePoseModelName() {
      return null;
    },
    startCamera() {},
    stopCamera() {},
    isCameraRunning() {
      return false;
    },
    startRecognition() {},
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
    setPreviewMirroring(mode) {
      log.push(['pose.preview-mirroring', mode]);
    },
  };
  const runtime = {
    targets: [stage, actor],
    monitorBlocks,
    getMonitorState: () => monitorState,
    getTargetForStage() {
      return stage;
    },
    ext_scratch3_looks: {
      _say(message) {
        log.push(['actor.say', message]);
      },
      _think(message) {
        log.push(['actor.think', message]);
      },
    },
  };
  return {
    runtime,
    tmposeComposition,
    poseConfidence,
    poseProgress,
    monitorRecords,
    tmPoseRuntime: {Webcam: class {}, loadFromFiles() {}},
    setLoading(payload) {
      log.push(['loading', payload.visible]);
    },
    createAssetManagerComposition(...args) {
      log.push(['media.create', args[1]]);
      return assetManagerComposition;
    },
    createTMPoseComposition() {
      log.push(['pose.create']);
      return tmposeComposition;
    },
    createAsyncInputComposition() {
      log.push(['input.create']);
      return {
        waitForPoseCandidate() {
          return Promise.resolve('pose');
        },
        waitForKeyCandidate({candidates}) {
          return Promise.resolve(candidates[0]);
        },
        waitForActorTouchCandidate({candidates}) {
          return Promise.resolve(candidates[0]);
        },
        releaseAll() {
          log.push(['input.release-all']);
        },
      };
    },
    createSvgTextComposition() {
      log.push(['svg.create']);
      return {
        defineStyle() {},
        setText(input) {
          log.push(['svg.text', input.text, input.styleName]);
        },
        releaseTarget() {},
        releaseAll() {
          log.push(['svg.release-all']);
        },
      };
    },
  };
}

function enabledOptions(project, fixture, extra = {}) {
  return {
    featureFlags: {dsl4Runtime: true},
    project,
    sourceFrontend: frontend,
    ...limits,
    subtleCrypto,
    ...fixture,
    ...extra,
  };
}

test('defaults OFF without inspecting project or any TurboWarp dependency', async () => {
  let factoryCalls = 0;
  const failFactory = () => {
    factoryCalls += 1;
    assert.fail('platform factory must not be called');
  };
  const result = await createDsl4TurboWarpRuntimeHost({
    featureFlags: {dsl4Runtime: false},
    project: new Proxy({}, {get: () => assert.fail('project must not be read')}),
    sourceFrontend: new Proxy({}, {get: () => assert.fail('frontend must not be read')}),
    runtime: new Proxy({}, {get: () => assert.fail('runtime must not be read')}),
    tmPoseRuntime: new Proxy({}, {get: () => assert.fail('TMPose must not be read')}),
    createAssetManagerComposition: failFactory,
    createTMPoseComposition: failFactory,
    createSvgTextComposition: failFactory,
    createRuntimeExpressionComposition: failFactory,
    createHostPort: failFactory,
  });
  assert.equal(result.ok, true);
  assert.equal(result.enabled, false);
  assert.equal(result.host, null);
  assert.equal(factoryCalls, 0);
});

test('creates browser preview sessions from wire StoryDocuments without parsing source again', async () => {
  const project = await packagedProject();
  const runtimeComponent = await loadDsl4RuntimeComponent(project, frontend, {
    ...limits,
    subtleCrypto,
  });
  assert.equal(runtimeComponent.ok, true, JSON.stringify(runtimeComponent.diagnostics));
  const changed = frontend.parse(waitStory.replace('wait: 0', 'wait: 0.001'), {
    sourceId: 'main',
  });
  assert.equal(changed.ok, true, JSON.stringify(changed.diagnostics));

  const log = [];
  const resets = [];
  const createSession = createDsl4TurboWarpPreviewSessionFactory({
    featureFlags: {dsl4Runtime: true},
    runtimeComponent,
    ...platformFixture(log),
    resetManagedPresentation() {
      resets.push('reset');
    },
  });
  const first = await createSession({
    storyDocument: changed.storyDocument,
    previousSession: null,
    preserveManagedPresentation: false,
  });
  assert.equal(log.length, 0);
  await first.start();
  assert.deepEqual(resets, ['reset']);
  assert.equal(first.getState().runtime.status, 'finished');

  const second = await createSession({
    storyDocument: changed.storyDocument,
    previousSession: first,
    preserveManagedPresentation: true,
  });
  assert.equal(log.filter((entry) => entry[0] === 'media.create').length, 1);
  first.stop('preview-reload');
  await first.dispose('preview-replaced');
  await second.start();
  assert.deepEqual(resets, ['reset']);

  const third = await createSession({
    storyDocument: changed.storyDocument,
    previousSession: second,
    preserveManagedPresentation: false,
  });
  second.stop('preview-reload');
  await second.dispose('preview-replaced');
  await third.start();
  assert.deepEqual(resets, ['reset', 'reset']);
  await third.dispose('preview-test');
  assert.equal(log.filter((entry) => entry[0] === 'media.create').length, 3);
  assert.equal(log.filter((entry) => entry[0] === 'media.release-all').length, 3);
});

test('attaches browser preview key and stage pointer input for the owned session lifetime', async () => {
  const project = await packagedProject();
  const runtimeComponent = await loadDsl4RuntimeComponent(project, frontend, {
    ...limits,
    subtleCrypto,
  });
  assert.equal(runtimeComponent.ok, true, JSON.stringify(runtimeComponent.diagnostics));
  const listeners = new Map();
  const target = {
    addEventListener(type, listener) {
      const values = listeners.get(type) ?? new Set();
      values.add(listener);
      listeners.set(type, values);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
  const createSession = createDsl4TurboWarpPreviewSessionFactory({
    featureFlags: {dsl4Runtime: true, dsl4SpeechAdvanceTypewriter: true},
    runtimeComponent,
    ...platformFixture([]),
    inputTarget: target,
    stagePointerTarget: target,
    resetManagedPresentation() {},
  });
  const session = await createSession({
    storyDocument: runtimeComponent.storyDocument,
    previousSession: null,
    preserveManagedPresentation: false,
  });

  await session.start();
  assert.equal(listeners.get('keydown')?.size, 1);
  assert.equal(listeners.get('pointerup')?.size, 1);
  await session.dispose('input-owner-test');
  assert.equal(listeners.get('keydown')?.size, 0);
  assert.equal(listeners.get('pointerup')?.size, 0);
});

test('releases a preview environment when browser input attachment fails', async () => {
  const project = await packagedProject();
  const runtimeComponent = await loadDsl4RuntimeComponent(project, frontend, {
    ...limits,
    subtleCrypto,
  });
  assert.equal(runtimeComponent.ok, true, JSON.stringify(runtimeComponent.diagnostics));
  const log = [];
  const createSession = createDsl4TurboWarpPreviewSessionFactory({
    featureFlags: {dsl4Runtime: true},
    runtimeComponent,
    ...platformFixture(log),
    inputTarget: {},
    resetManagedPresentation() {},
  });
  const session = await createSession({
    storyDocument: runtimeComponent.storyDocument,
    previousSession: null,
    preserveManagedPresentation: false,
  });

  await assert.rejects(() => session.start(), /input target/u);
  assert.equal(log.filter((entry) => entry[0] === 'media.release-all').length, 1);
  assert.equal(log.filter((entry) => entry[0] === 'pose.release-all').length, 1);
});

test('fails closed before inspecting preview artifacts while the runtime flag is disabled', () => {
  assert.throws(
    () =>
      createDsl4TurboWarpPreviewSessionFactory({
        featureFlags: {dsl4Runtime: false},
        runtimeComponent: new Proxy({}, {get: () => assert.fail('component must not be read')}),
        resetManagedPresentation: new Proxy(() => {}, {
          get: () => assert.fail('reset callback must not be read'),
        }),
      }),
    /dsl4Runtime feature flag/u,
  );
});

test('releases a preview environment when the wire StoryDocument rejects navigation creation', async () => {
  const project = await packagedProject();
  const runtimeComponent = await loadDsl4RuntimeComponent(project, frontend, {
    ...limits,
    subtleCrypto,
  });
  assert.equal(runtimeComponent.ok, true, JSON.stringify(runtimeComponent.diagnostics));
  const incompatible = frontend.parse(waitStory.replace('production:', 'author-preview:'), {
    sourceId: 'main',
  });
  assert.equal(incompatible.ok, true, JSON.stringify(incompatible.diagnostics));
  const log = [];
  const createSession = createDsl4TurboWarpPreviewSessionFactory({
    featureFlags: {dsl4Runtime: true},
    runtimeComponent,
    ...platformFixture(log),
    resetManagedPresentation() {},
  });

  const rejected = await createSession({
    storyDocument: incompatible.storyDocument,
    previousSession: null,
    preserveManagedPresentation: false,
  });
  assert.equal(log.length, 0);
  await assert.rejects(() => rejected.start(), /incompatible with the base runtime/u);
  assert.equal(log.filter((entry) => entry[0] === 'media.create').length, 1);
  assert.equal(log.filter((entry) => entry[0] === 'media.release-all').length, 1);
  assert.equal(log.filter((entry) => entry[0] === 'pose.release-all').length, 1);
});

test('disposes an unstarted preview candidate without allocating platform resources', async () => {
  const project = await packagedProject();
  const runtimeComponent = await loadDsl4RuntimeComponent(project, frontend, {
    ...limits,
    subtleCrypto,
  });
  assert.equal(runtimeComponent.ok, true, JSON.stringify(runtimeComponent.diagnostics));
  const log = [];
  let resetCount = 0;
  const createSession = createDsl4TurboWarpPreviewSessionFactory({
    featureFlags: {dsl4Runtime: true},
    runtimeComponent,
    ...platformFixture(log),
    resetManagedPresentation() {
      resetCount += 1;
    },
  });
  const candidate = await createSession({
    storyDocument: runtimeComponent.storyDocument,
    previousSession: {},
    preserveManagedPresentation: false,
  });

  await candidate.dispose('deferred-candidate');
  assert.equal(resetCount, 0);
  assert.deepEqual(log, []);
  assert.equal(candidate.getState().disposed, true);
});

test('cancels preview initialization after reset without creating a late environment', async () => {
  const project = await packagedProject();
  const runtimeComponent = await loadDsl4RuntimeComponent(project, frontend, {
    ...limits,
    subtleCrypto,
  });
  assert.equal(runtimeComponent.ok, true, JSON.stringify(runtimeComponent.diagnostics));
  const log = [];
  let finishReset;
  const reset = new Promise((resolve) => {
    finishReset = resolve;
  });
  const createSession = createDsl4TurboWarpPreviewSessionFactory({
    featureFlags: {dsl4Runtime: true},
    runtimeComponent,
    ...platformFixture(log),
    resetManagedPresentation() {
      return reset;
    },
  });
  const candidate = await createSession({
    storyDocument: runtimeComponent.storyDocument,
    previousSession: null,
    preserveManagedPresentation: false,
  });
  const run = candidate.start();
  const disposal = candidate.dispose('page-close');
  finishReset();

  await assert.rejects(() => run, /disposed/u);
  await disposal;
  assert.deepEqual(log, []);
  assert.equal(candidate.getState().disposed, true);
});

test('withholds every platform dependency until the packaged component validates', async () => {
  const log = [];
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(baseProject(), platformFixture(log), {
      createRuntimeExpressionComposition() {
        log.push(['expression.create']);
        return {evaluateCondition() {}, releaseAll() {}};
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, 'K4-SOURCE-CHANNEL-MISSING');
  assert.equal(result.host, null);
  assert.deepEqual(log, []);
});

test('selects the startup-fixed Scratch consumer and reserves host observers for presenter mode', async () => {
  const project = await packagedProject();
  const disabledLog = [];
  const disabledOptions = enabledOptions(project, platformFixture(disabledLog));
  Object.defineProperty(disabledOptions, 'onPoseState', {
    get() {
      assert.fail('disabled pose feedback must not inspect its observer');
    },
  });
  Object.defineProperty(disabledOptions, 'poseFeedbackPresenter', {
    get() {
      assert.fail('disabled pose feedback must not inspect its presenter');
    },
  });
  const disabled = await createDsl4TurboWarpRuntimeHost(disabledOptions);
  assert.equal(disabled.ok, true, JSON.stringify(disabled.diagnostics));
  await disabled.host.dispose('feedback-disabled');

  const scratchBindingSource = `
kamishibai: '4.0'
assets:
  Tick: sound
  Charge: sound
poseRecognition:
  idleSound: Tick
  chargeSound: Charge
  feedback:
    mode: scratchBinding
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - wait: 0
`;
  const scratchProject = await packagedProject(scratchBindingSource);
  const scratchFixture = platformFixture([]);
  scratchFixture.poseConfidence.value = 75;
  scratchFixture.poseProgress.value = 50;
  const scratchOptions = enabledOptions(scratchProject, scratchFixture, {
    featureFlags: {dsl4Runtime: true, dsl4PoseFeedbackModes: true},
  });
  Object.defineProperty(scratchOptions, 'onPoseState', {
    get() {
      assert.fail('Scratch feedback must not inspect a presenter observer');
    },
  });
  Object.defineProperty(scratchOptions, 'poseFeedbackPresenter', {
    get() {
      assert.fail('Scratch feedback must not inspect DOM presenter options');
    },
  });
  const scratch = await createDsl4TurboWarpRuntimeHost(scratchOptions);
  assert.equal(scratch.ok, true, JSON.stringify(scratch.diagnostics));
  await scratch.host.dispose('scratch-feedback-enabled');
  assert.equal(scratchFixture.poseConfidence.value, 0);
  assert.equal(scratchFixture.poseProgress.value, 0);

  const presenterSource = `
kamishibai: '4.0'
assets:
  Tick: sound
  Charge: sound
poseRecognition:
  idleSound: Tick
  chargeSound: Charge
  feedback:
    mode: presenter
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - wait: 0
`;
  const presenterProject = await packagedProject(presenterSource);
  await assert.rejects(
    createDsl4TurboWarpRuntimeHost(
      enabledOptions(presenterProject, platformFixture([]), {
        featureFlags: {dsl4Runtime: true, dsl4PoseFeedbackModes: true},
      }),
    ),
    /onPoseState/u,
  );
  const presenterDocument = createFakeDocument();
  const presenter = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(presenterProject, platformFixture([]), {
      featureFlags: {dsl4Runtime: true, dsl4PoseFeedbackModes: true},
      poseFeedbackPresenter: {container: presenterDocument.body},
    }),
  );
  assert.equal(presenter.ok, true, JSON.stringify(presenter.diagnostics));
  assert.equal(findByDataset(presenterDocument.body, 'dsl4PoseFeedback', 'true').hidden, true);
  assert.ok(findByDataset(presenterDocument.body, 'dsl4PoseFeedbackStatus', 'true'));
  await presenter.host.dispose('presenter-feedback-enabled');
  assert.equal(presenterDocument.body.children.length, 0);
});

test('renders presenter pose lifecycle and isolates its additional developer observer', async () => {
  const project = await packagedPoseProject(`
kamishibai: '4.0'
assets:
  Tick: sound
  Charge: sound
  HeroIdle: costume:Hero
  RescuePose:
    kind: poseModel
    file: pose-models/rescue
actors:
  Hero: HeroIdle
poseRecognition:
  idleSound: Tick
  chargeSound: Charge
  sequence:
    confidenceThreshold: 0.5
    fullConfidenceHoldSeconds: 1
    idleChargePerSecond: 0
  feedback:
    mode: presenter
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  rescue:
    poseModel: RescuePose
    actions:
      - Hero.pose:
          steps:
            - pose: help
`);
  const fixture = platformFixture([]);
  const document = createFakeDocument();
  const phases = [];
  let confidence = 0;
  let now = 0;
  let scheduled = null;
  fixture.tmposeComposition.registerPoseModel = ({name}) => ({name, labels: ['help']});
  fixture.tmposeComposition.confidenceOf = () => confidence;
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, fixture, {
      featureFlags: {dsl4Runtime: true, dsl4PoseFeedbackModes: true},
      poseFeedbackPresenter: {container: document.body},
      onPoseState(event) {
        phases.push(event.phase);
        if (event.phase === 'charging') throw new Error('developer observer failed');
      },
      poseNow: () => now,
      poseSchedule(callback) {
        scheduled = callback;
        return () => {
          if (scheduled === callback) scheduled = null;
        };
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const root = findByDataset(document.body, 'dsl4PoseFeedback', 'true');
  const status = findByDataset(document.body, 'dsl4PoseFeedbackStatus', 'true');

  const run = result.host.start();
  for (let attempts = 0; attempts < 50 && scheduled === null; attempts += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(typeof scheduled, 'function');
  assert.equal(root.hidden, false);
  assert.equal(root.dataset.phase, 'waiting');
  assert.match(status.textContent, /Waiting for pose: Hero \/ help \/ Step 1/u);

  confidence = 1;
  now = 1000;
  scheduled();
  assert.equal((await run).status, 'finished');
  assert.deepEqual(phases, ['waiting', 'charging', 'completed']);
  assert.equal(root.hidden, true);
  assert.match(status.textContent, /Pose completed/u);

  confidence = 0;
  now = 2000;
  scheduled = null;
  const stoppedRun = result.host.start();
  for (let attempts = 0; attempts < 50 && scheduled === null; attempts += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(typeof scheduled, 'function');
  assert.equal(root.hidden, false);
  assert.equal(root.dataset.phase, 'waiting');
  assert.equal(result.host.stop('presenter-stop').status, 'stopped');
  await stoppedRun;
  assert.deepEqual(phases.slice(-2), ['waiting', 'cancelled']);
  assert.equal(root.hidden, true);
  assert.match(status.textContent, /Pose cancelled/u);
  for (const row of root.children.filter((child) => child.tagName === 'DIV')) {
    assert.equal(row.children[1].value, 0);
  }

  await result.host.dispose('presenter-lifecycle');
  assert.equal(document.body.children.length, 0);
});

test('keeps the Standard app shell inert when its startup flag is disabled', async () => {
  let runtimeHostCalls = 0;
  const options = {
    featureFlags: {dsl4Runtime: true, dsl4AppShell: false},
    createRuntimeHost() {
      runtimeHostCalls += 1;
      assert.fail('the disabled Standard app shell must not create a runtime host');
    },
  };
  for (const key of ['surface', 'document', 'mount', 'runtimeHostOptions']) {
    Object.defineProperty(options, key, {
      get() {
        assert.fail(`the disabled Standard app shell must not inspect ${key}`);
      },
    });
  }

  const shell = await createDsl4StandardAppShell(options);
  assert.equal(shell.ok, true);
  assert.equal(shell.enabled, false);
  assert.equal(shell.element, null);
  assert.equal(shell.runtimeHost, null);
  assert.equal(runtimeHostCalls, 0);
  assert.equal((await shell.dispose()).enabled, false);
});

test('shares one lazy pose feedback shell across every Standard delivery surface', async () => {
  const presenterProject = await packagedProject(`
kamishibai: '4.0'
assets:
  Tick: sound
  Charge: sound
poseRecognition:
  idleSound: Tick
  chargeSound: Charge
  feedback:
    mode: presenter
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - wait: 0
`);
  for (const surface of ['webPlayer', 'regularEditor', 'packager', 'developmentPreview']) {
    const document = createFakeDocument();
    const shell = await createDsl4StandardAppShell({
      featureFlags: {
        dsl4Runtime: true,
        dsl4AppShell: true,
        dsl4PoseFeedbackModes: true,
      },
      surface,
      document,
      mount: document.body,
      runtimeHostOptions: {
        project: presenterProject,
        sourceFrontend: frontend,
        ...limits,
        subtleCrypto,
        ...platformFixture([]),
      },
    });
    assert.equal(shell.ok, true, JSON.stringify(shell.diagnostics));
    assert.equal(shell.enabled, true);
    assert.equal(shell.surface, surface);
    assert.equal(shell.element.getAttribute('data-dsl4-app-shell'), 'standard');
    assert.equal(shell.element.getAttribute('data-dsl4-surface'), surface);
    assert.ok(findByDataset(shell.element, 'dsl4PoseFeedback', 'true'));
    assert.equal(shell.getSnapshot().poseFeedbackMounted, true);

    await shell.dispose(`surface-${surface}`);
    assert.equal(document.body.children.length, 0);
    assert.equal(shell.element, null);
    assert.equal(shell.getSnapshot().disposed, true);
  }
});

test('does not inspect or create Standard shell DOM for Scratch feedback mode', async () => {
  const project = await packagedProject();
  const options = {
    featureFlags: {
      dsl4Runtime: true,
      dsl4AppShell: true,
      dsl4PoseFeedbackModes: true,
    },
    surface: 'webPlayer',
    runtimeHostOptions: {
      project,
      sourceFrontend: frontend,
      ...limits,
      subtleCrypto,
      ...platformFixture([]),
    },
  };
  for (const key of ['document', 'mount', 'poseFeedbackLabels']) {
    Object.defineProperty(options, key, {
      get() {
        assert.fail(`Scratch feedback must not inspect Standard shell ${key}`);
      },
    });
  }

  const shell = await createDsl4StandardAppShell(options);
  assert.equal(shell.ok, true, JSON.stringify(shell.diagnostics));
  assert.equal(shell.element, null);
  assert.equal(shell.getSnapshot().poseFeedbackMounted, false);
  await shell.dispose('scratch-mode');
});

test('rejects malformed Standard runtime results and cleans partial host and DOM ownership', async () => {
  const document = createFakeDocument();
  const cleanupReasons = [];
  await assert.rejects(
    createDsl4StandardAppShell({
      featureFlags: {dsl4Runtime: true, dsl4AppShell: true},
      surface: 'webPlayer',
      document,
      mount: document.body,
      runtimeHostOptions: {},
      createRuntimeHost(options) {
        void options.poseFeedbackPresenter.container;
        return {
          ok: 'yes',
          enabled: true,
          host: {
            dispose(reason) {
              cleanupReasons.push(reason);
            },
          },
          diagnostics: [],
        };
      },
    }),
    /valid enabled runtime host result/u,
  );
  assert.deepEqual(cleanupReasons, ['invalid-standard-app-shell-result']);
  assert.equal(document.body.children.length, 0);

  await assert.rejects(
    createDsl4StandardAppShell({
      featureFlags: {dsl4Runtime: true, dsl4AppShell: true},
      surface: 'webPlayer',
      runtimeHostOptions: {featureFlags: {}},
    }),
    /cannot override Standard app-shell option: featureFlags/u,
  );
});

test('mounts and disposes the Standard presenter against the pinned TurboWarp VM runtime', async () => {
  assert.equal(turbowarpVmCommit, 'c4823421cb7c17d8d8a89878851ce1668c26a21f');
  const harness = await loadKamishibaiVm();
  try {
    const project = await packagedProject(`
kamishibai: '4.0'
assets:
  Tick: sound
  Charge: sound
poseRecognition:
  idleSound: Tick
  chargeSound: Charge
  feedback:
    mode: presenter
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - wait: 0
`);
    const document = createFakeDocument();
    const shell = await createDsl4StandardAppShell({
      featureFlags: {
        dsl4Runtime: true,
        dsl4AppShell: true,
        dsl4PoseFeedbackModes: true,
      },
      surface: 'regularEditor',
      document,
      mount: document.body,
      runtimeHostOptions: {
        project,
        sourceFrontend: frontend,
        ...limits,
        subtleCrypto,
        ...platformFixture([]),
        runtime: harness.vm.runtime,
      },
    });
    assert.equal(shell.ok, true, JSON.stringify(shell.diagnostics));
    assert.ok(findByDataset(shell.element, 'dsl4PoseFeedback', 'true'));
    assert.equal((await shell.runtimeHost.start()).status, 'finished');
    await shell.dispose('turbowarp-vm-fixture');
    assert.equal(document.body.children.length, 0);
  } finally {
    harness.quit();
  }
});

test('resets Scratch pose feedback before awaiting normal environment cleanup', async () => {
  const project = await packagedProject();
  const fixture = platformFixture([]);
  let finishHostPortCleanup = null;
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, fixture, {
      featureFlags: {dsl4Runtime: true, dsl4PoseFeedbackModes: true},
      createHostPort() {
        return {
          dispose() {
            return new Promise((resolve) => {
              finishHostPortCleanup = resolve;
            });
          },
        };
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  fixture.poseConfidence.value = 75;
  fixture.poseProgress.value = 50;

  const disposal = result.host.dispose('pending-environment-cleanup');
  while (!finishHostPortCleanup) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.poseConfidence.value, 0);
  assert.equal(fixture.poseProgress.value, 0);

  finishHostPortCleanup();
  await disposal;
});

test('resets Scratch pose feedback before awaiting partial-creation cleanup', async () => {
  const project = await packagedProject();
  const fixture = platformFixture([]);
  fixture.poseConfidence.value = 75;
  fixture.poseProgress.value = 50;
  let finishHostPortCleanup = null;
  const rejection = assert.rejects(
    createDsl4TurboWarpRuntimeHost(
      enabledOptions(project, fixture, {
        featureFlags: {dsl4Runtime: true, dsl4PoseFeedbackModes: true},
        createHostPort() {
          return {
            stage() {},
            dispose() {
              return new Promise((resolve) => {
                finishHostPortCleanup = resolve;
              });
            },
          };
        },
      }),
    ),
    (error) => error.code === 'K4-HOST-PORT-COLLISION',
  );

  while (!finishHostPortCleanup) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.poseConfidence.value, 0);
  assert.equal(fixture.poseProgress.value, 0);

  finishHostPortCleanup();
  await rejection;
});

test('continues environment cleanup and aggregates a Scratch reset failure', async () => {
  const project = await packagedProject();
  const log = [];
  const fixture = platformFixture(log);
  let progress = 0;
  let rejectReset = false;
  Object.defineProperty(fixture.poseProgress, 'value', {
    configurable: true,
    get() {
      return progress;
    },
    set(value) {
      if (rejectReset && value === 0) throw new Error('Scratch reset failed');
      progress = value;
    },
  });
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, fixture, {
      featureFlags: {dsl4Runtime: true, dsl4PoseFeedbackModes: true},
      createHostPort() {
        return {
          dispose() {
            log.push(['host-port.dispose']);
          },
        };
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  fixture.poseConfidence.value = 75;
  fixture.poseProgress.value = 50;
  rejectReset = true;

  await assert.rejects(result.host.dispose('reset-failure'), (error) => {
    assert.equal(error instanceof AggregateError, true);
    return true;
  });
  assert.equal(log.filter(([event]) => event === 'host-port.dispose').length, 1);
  assert.equal(log.filter(([event]) => event === 'svg.release-all').length, 1);
  assert.equal(log.filter(([event]) => event === 'pose.release-all').length, 1);
  assert.equal(log.filter(([event]) => event === 'media.release-all').length, 1);
});

test('resets Scratch pose feedback before awaiting a pending remote cache lease release', async () => {
  const cacheIdentity = {
    id: 'resetlease000001',
    label: 'story.kamishibai.yaml',
    databaseName: 'tw-kamishibai-assets-v1--story--resetlease000001',
  };
  const verifiedRemoteWaitStory = waitStory.replace(
    'controls:',
    `assets:
  CacheLeaseProbe:
    kind: sound
    delivery: remote
    source:
      url: https://cdn.example.com/cache-lease-probe.ogg
      integrity: sha256-0000000000000000000000000000000000000000000000000000000000000000
      contentType: audio/ogg
      size: 1
controls:`,
  );
  const project = await packagedProject(verifiedRemoteWaitStory, {cacheIdentity});
  const fixture = platformFixture([]);
  fixture.poseConfidence.value = 75;
  fixture.poseProgress.value = 50;
  const createAssetManagerComposition = fixture.createAssetManagerComposition;
  let releaseCalls = 0;
  let finishFirstRelease = null;
  fixture.createAssetManagerComposition = (...args) => {
    const composition = createAssetManagerComposition(...args);
    return {
      ...composition,
      releaseVerifiedRemoteStoryCacheLease() {
        releaseCalls += 1;
        if (releaseCalls > 1) return Promise.resolve();
        return new Promise((resolve) => {
          finishFirstRelease = resolve;
        });
      },
    };
  };
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, fixture, {
      featureFlags: {dsl4Runtime: true, dsl4PoseFeedbackModes: true},
      loadRemoteAsset: async () => assert.fail('unused remote asset must not load'),
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

  const disposal = result.host.dispose('pending-cache-release');
  while (!finishFirstRelease) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.poseConfidence.value, 0);
  assert.equal(fixture.poseProgress.value, 0);
  assert.equal(fixture.monitorRecords.get(fixture.poseConfidence.id).visible, false);
  assert.equal(fixture.monitorRecords.get(fixture.poseProgress.id).visible, false);

  finishFirstRelease();
  await disposal;
  assert.equal(releaseCalls, 2);
});

test('applies scene pose preview mirroring only through its startup-fixed feature gate', async () => {
  const project = await packagedProject(posePreviewStory);

  const disabledLog = [];
  const disabledFixture = platformFixture(disabledLog);
  const disabledCreateTMPose = disabledFixture.createTMPoseComposition;
  disabledFixture.createTMPoseComposition = (...args) => {
    const composition = disabledCreateTMPose(...args);
    delete composition.setPreviewMirroring;
    Object.defineProperty(composition, 'setPreviewMirroring', {
      get() {
        assert.fail('disabled host must not inspect the TMPose mirroring method');
      },
    });
    return composition;
  };
  const disabled = await createDsl4TurboWarpRuntimeHost(enabledOptions(project, disabledFixture));
  assert.equal(disabled.ok, true, JSON.stringify(disabled.diagnostics));
  assert.equal((await disabled.host.start()).status, 'finished');
  assert.equal(
    disabledLog.some(([event]) => event === 'pose.preview-mirroring'),
    false,
  );
  await disabled.host.dispose('pose-preview-disabled');

  const missingFixture = platformFixture([]);
  const missingCreateTMPose = missingFixture.createTMPoseComposition;
  missingFixture.createTMPoseComposition = (...args) => {
    const composition = missingCreateTMPose(...args);
    delete composition.setPreviewMirroring;
    return composition;
  };
  await assert.rejects(
    createDsl4TurboWarpRuntimeHost(
      enabledOptions(project, missingFixture, {
        featureFlags: {dsl4Runtime: true, dsl4PosePreviewMirroring: true},
      }),
    ),
    /setPreviewMirroring/u,
  );

  const enabledLog = [];
  const enabled = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, platformFixture(enabledLog), {
      featureFlags: {dsl4Runtime: true, dsl4PosePreviewMirroring: true},
    }),
  );
  assert.equal(enabled.ok, true, JSON.stringify(enabled.diagnostics));
  assert.equal((await enabled.host.start()).status, 'finished');
  assert.deepEqual(
    enabledLog.filter(([event]) => event === 'pose.preview-mirroring'),
    [
      ['pose.preview-mirroring', 'mirrored'],
      ['pose.preview-mirroring', 'unmirrored'],
    ],
  );
  await enabled.host.dispose('pose-preview-enabled');
});

test('connects camera preview controls, assets, and upstream methods only behind their flag', async () => {
  const cacheIdentity = {
    id: 'camera-controls',
    label: 'story.kamishibai.yaml',
    databaseName: 'tw-kamishibai-assets-v1--story--camera-controls',
  };
  const project = await packagedProject(cameraPreviewControlsStory, {cacheIdentity});

  const disabledLog = [];
  const disabledFixture = platformFixture(disabledLog);
  const disabledCreateTMPose = disabledFixture.createTMPoseComposition;
  disabledFixture.createTMPoseComposition = (...args) => {
    const composition = disabledCreateTMPose(...args);
    for (const method of [
      'setPreviewMirroring',
      'listCameraDevices',
      'selectCamera',
      'getCameraSelection',
      'getActiveCamera',
    ]) {
      delete composition[method];
      Object.defineProperty(composition, method, {
        get() {
          assert.fail(`disabled host must not inspect ${method}`);
        },
      });
    }
    return composition;
  };
  const disabledOptions = enabledOptions(project, disabledFixture);
  for (const option of ['cameraPreviewControls', 'createObjectURL', 'revokeObjectURL']) {
    Object.defineProperty(disabledOptions, option, {
      get() {
        assert.fail(`disabled host must not inspect ${option}`);
      },
    });
  }
  const disabled = await createDsl4TurboWarpRuntimeHost(disabledOptions);
  assert.equal(disabled.ok, true, JSON.stringify(disabled.diagnostics));
  const disabledRun = disabled.host.start();
  await Promise.resolve();
  disabled.host.stop('test-complete');
  await disabledRun;
  assert.equal(
    disabledLog.some(([event, id]) => event === 'media.register-embedded' && id !== undefined),
    false,
  );
  await disabled.host.dispose('camera-controls-disabled');

  const enabledLog = [];
  const enabledFixture = platformFixture(enabledLog);
  let selection = 'default';
  const enabledCreateTMPose = enabledFixture.createTMPoseComposition;
  enabledFixture.createTMPoseComposition = (...args) => {
    const composition = enabledCreateTMPose(...args);
    return {
      ...composition,
      isCameraRunning: () => true,
      async listCameraDevices() {
        enabledLog.push(['camera.list']);
        return [{deviceId: 'opaque-camera', label: 'External camera'}];
      },
      async selectCamera(next) {
        selection = next;
        enabledLog.push(['camera.select', next]);
      },
      getCameraSelection: () => selection,
      getActiveCamera: () => null,
    };
  };
  const document = createFakeDocument();
  const objectUrls = [];
  const revoked = [];
  const pendingSchedules = [];
  const enabled = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, enabledFixture, {
      featureFlags: {dsl4Runtime: true, dsl4CameraPreviewControls: true},
      async loadRemoteAsset() {
        return {bytes: new TextEncoder().encode('<svg/>'), contentType: 'image/svg+xml'};
      },
      cameraPreviewControls: {
        container: document.body,
        getPreviewRect: () => ({left: 0, top: 0, width: 320, height: 180}),
        schedule(callback) {
          pendingSchedules.push(callback);
          return () => {
            const index = pendingSchedules.indexOf(callback);
            if (index >= 0) pendingSchedules.splice(index, 1);
          };
        },
      },
      createObjectURL() {
        const value = `blob:control-${objectUrls.length + 1}`;
        objectUrls.push(value);
        return value;
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
    }),
  );
  assert.equal(enabled.ok, true, JSON.stringify(enabled.diagnostics));
  const enabledRun = enabled.host.start();
  for (let attempt = 0; attempt < 20 && document.body.children.length === 0; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(document.body.children.length, 2);
  assert.equal(objectUrls.length, 3);
  for (
    let attempt = 0;
    attempt < 20 && document.body.children[0].children[0].children[0].src !== 'blob:control-2';
    attempt += 1
  ) {
    await Promise.resolve();
  }
  assert.equal(document.body.children[0].children[0].children[0].src, 'blob:control-2');
  assert.equal(enabledLog.filter(([event]) => event === 'media.register-embedded').length, 3);
  enabled.host.stop('test-complete');
  await enabledRun;
  assert.equal(document.body.children.length, 0);
  await enabled.host.dispose('camera-controls-enabled');
  assert.deepEqual([...revoked].sort(), [...objectUrls].sort());
});

test('releases every control Object URL when renderer DOM disposal fails', async () => {
  const project = await packagedProject(cameraPreviewControlsStory, {
    cacheIdentity: {
      id: 'camera-controls-disposal-failure',
      label: 'story.kamishibai.yaml',
      databaseName: 'tw-kamishibai-assets-v1--story--camera-controls-disposal-failure',
    },
  });
  const log = [];
  const fixture = platformFixture(log);
  const createTMPoseComposition = fixture.createTMPoseComposition;
  fixture.createTMPoseComposition = (...args) => ({
    ...createTMPoseComposition(...args),
    isCameraRunning: () => true,
    async listCameraDevices() {
      return [];
    },
    async selectCamera() {},
    getCameraSelection: () => 'default',
    getActiveCamera: () => null,
  });
  const document = createFakeDocument();
  const objectUrls = [];
  const revoked = [];
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, fixture, {
      featureFlags: {dsl4Runtime: true, dsl4CameraPreviewControls: true},
      async loadRemoteAsset() {
        return {bytes: new TextEncoder().encode('<svg/>'), contentType: 'image/svg+xml'};
      },
      cameraPreviewControls: {
        container: document.body,
        getPreviewRect: () => ({left: 0, top: 0, width: 320, height: 180}),
        schedule: () => () => {},
      },
      createObjectURL() {
        const value = `blob:failing-control-${objectUrls.length + 1}`;
        objectUrls.push(value);
        return value;
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

  const run = result.host.start();
  for (let attempt = 0; attempt < 20 && document.body.children.length < 2; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(document.body.children.length, 2);
  assert.equal(objectUrls.length, 3);
  const failingGroup = document.body.children[0];
  const removeFailingGroup = failingGroup.remove.bind(failingGroup);
  failingGroup.remove = () => {
    throw new Error('control DOM removal failed');
  };

  result.host.stop('renderer-disposal-failure');
  await run;
  for (let attempt = 0; attempt < 20 && revoked.length < objectUrls.length; attempt += 1) {
    await Promise.resolve();
  }
  assert.deepEqual([...revoked].sort(), [...objectUrls].sort());
  assert.equal(document.body.children.length, 1);

  removeFailingGroup();
  await result.host.dispose('renderer-disposal-failure');
  assert.equal(document.body.children.length, 0);
});

test('suspends camera controls at natural finish and resumes the same leases for history', async () => {
  const project = await packagedProject(cameraPreviewControlsHistoryStory, {
    historyNavigationAvailable: true,
    cacheIdentity: {
      id: 'camera-controls-history',
      label: 'story.kamishibai.yaml',
      databaseName: 'tw-kamishibai-assets-v1--story--camera-controls-history',
    },
  });
  const log = [];
  const fixture = platformFixture(log);
  const createTMPoseComposition = fixture.createTMPoseComposition;
  fixture.createTMPoseComposition = (...args) => ({
    ...createTMPoseComposition(...args),
    isCameraRunning: () => true,
    async listCameraDevices() {
      return [];
    },
    async selectCamera() {},
    getCameraSelection: () => 'default',
    getActiveCamera: () => null,
  });
  const document = createFakeDocument();
  const objectUrls = [];
  const revoked = [];
  const pendingSchedules = [];
  const events = [];
  const pendingWaits = [];
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, fixture, {
      featureFlags: {dsl4Runtime: true, dsl4CameraPreviewControls: true},
      historyNavigationAvailable: true,
      historyLimits: {maxActionEntries: 8, maxSceneVisits: 8},
      async loadRemoteAsset() {
        return {bytes: new TextEncoder().encode('<svg/>'), contentType: 'image/svg+xml'};
      },
      cameraPreviewControls: {
        container: document.body,
        getPreviewRect: () => ({left: 0, top: 0, width: 320, height: 180}),
        schedule(callback) {
          pendingSchedules.push(callback);
          return () => {
            const index = pendingSchedules.indexOf(callback);
            if (index >= 0) pendingSchedules.splice(index, 1);
          };
        },
      },
      waitSchedule(callback) {
        pendingWaits.push(callback);
        return () => {
          const index = pendingWaits.indexOf(callback);
          if (index >= 0) pendingWaits.splice(index, 1);
        };
      },
      createObjectURL() {
        const value = `blob:history-control-${objectUrls.length + 1}`;
        objectUrls.push(value);
        return value;
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
      onEvent(event) {
        events.push(event.type);
        if (event.type === 'runtime.finish') throw new Error('consumer observer failed');
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

  const run = result.host.start();
  while (pendingWaits.length === 0) await Promise.resolve();
  const mirror = findByDataset(document.body, 'dsl4PreviewControl', 'mirroring');
  const camera = findByDataset(document.body, 'dsl4PreviewControl', 'cameraMenu');
  const menu = findByDataset(document.body, 'dsl4PreviewCameraMenu', 'true');
  assert.equal(mirror.listeners.get('click').length, 1);
  assert.equal(camera.listeners.get('click').length, 1);
  assert.equal(menu.listeners.get('change').length, 1);

  pendingWaits.shift()();
  const finished = await run;
  assert.equal(finished.status, 'finished');
  assert.equal(document.body.children.length, 2);
  assert.ok(document.body.children.every((group) => group.style.display === 'none'));
  assert.equal(pendingSchedules.length, 0);
  assert.equal(revoked.length, 0);
  assert.equal(mirror.listeners.get('click')?.length ?? 0, 0);
  assert.equal(camera.listeners.get('click')?.length ?? 0, 0);
  assert.equal(menu.listeners.get('change')?.length ?? 0, 0);

  const rewound = result.host.dispatchCommand('history.previousAction');
  assert.equal(rewound.ok, true, JSON.stringify(rewound.diagnostics));
  assert.equal(rewound.changed, true);
  assert.equal(result.host.getState().runtime.status, 'paused');
  assert.ok(document.body.children.every((group) => group.style.display === 'flex'));
  assert.equal(pendingSchedules.length, 1);
  assert.equal(mirror.listeners.get('click').length, 1);
  assert.equal(camera.listeners.get('click').length, 1);
  assert.equal(menu.listeners.get('change').length, 1);

  const resumed = result.host.dispatchCommand('navigation.nextAction');
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  while (pendingWaits.length === 0) await Promise.resolve();
  pendingWaits.shift()();
  await result.host.getRunPromise();
  assert.equal(result.host.getState().runtime.status, 'finished');
  assert.ok(document.body.children.every((group) => group.style.display === 'none'));
  assert.equal(pendingSchedules.length, 0);
  assert.equal(revoked.length, 0);
  assert.equal(mirror.listeners.get('click')?.length ?? 0, 0);
  assert.equal(camera.listeners.get('click')?.length ?? 0, 0);
  assert.equal(menu.listeners.get('change')?.length ?? 0, 0);
  assert.deepEqual(
    events.filter((type) =>
      ['runtime.finish', 'navigation.reposition', 'runtime.resume'].includes(type),
    ),
    ['runtime.finish', 'navigation.reposition', 'runtime.resume', 'runtime.finish'],
  );

  await result.host.dispose('history-camera-controls');
  assert.equal(document.body.children.length, 0);
  assert.deepEqual([...revoked].sort(), [...objectUrls].sort());
});

test('wires flagged think advance through the standard TurboWarp runtime host', async () => {
  const project = await packagedProject(speechStory);
  const log = [];
  const fixture = platformFixture(log);
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, fixture, {
      featureFlags: {dsl4Runtime: true, dsl4SpeechAdvanceTypewriter: true},
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const stageListeners = new Map();
  const stageTarget = {
    addEventListener(type, listener) {
      stageListeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (stageListeners.get(type) === listener) stageListeners.delete(type);
    },
  };
  result.host.attachStagePointer(stageTarget);
  assert.equal(stageListeners.has('pointerup'), true);
  const run = result.host.start();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (log.some(([name, message]) => name === 'actor.think' && message === 'ど')) break;
    await Promise.resolve();
  }
  assert.equal(
    log.some(([name, message]) => name === 'actor.think' && message === 'ど'),
    true,
    JSON.stringify(log),
  );
  assert.equal(log.filter(([name, sound]) => name === 'media.play' && sound === 'Voice').length, 1);
  assert.ok(
    log.findIndex(([name, message]) => name === 'actor.think' && message === 'ど') <
      log.findIndex(([name, sound]) => name === 'media.play' && sound === 'Voice'),
    JSON.stringify(log),
  );
  await Promise.resolve();
  const counters = {preventDefault: 0, stopPropagation: 0};
  const event = {
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    preventDefault() {
      counters.preventDefault += 1;
    },
    stopPropagation() {
      counters.stopPropagation += 1;
    },
  };
  assert.equal(stageListeners.get('pointerup')(event), true);
  assert.deepEqual(counters, {preventDefault: 1, stopPropagation: 1});
  assert.equal((await run).status, 'finished');
  assert.equal(
    log.filter(([name, message]) => name === 'actor.think' && message === 'どうしよう').length,
    1,
    JSON.stringify(log),
  );
  assert.equal(
    log.filter(([name, message]) => name === 'actor.think' && message === '').length,
    1,
    JSON.stringify(log),
  );
  assert.equal(log.filter(([name, sound]) => name === 'media.stop' && sound === 'Voice').length, 1);
  await result.host.dispose('test-complete');
  assert.equal(stageListeners.has('pointerup'), false);
});

test('creates an idle host, attaches explicitly, runs, and disposes every owned resource once', async () => {
  const project = await packagedProject();
  const log = [];
  const fixture = platformFixture(log);
  const target = {
    addEventListener(type) {
      log.push(['listener.add', type]);
    },
    removeEventListener(type) {
      log.push(['listener.remove', type]);
    },
  };
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, fixture, {
      featureFlags: {dsl4Runtime: true, structuredDataIntegrationEnabled: true},
      createRuntimeExpressionComposition() {
        log.push(['expression.create']);
        return {
          evaluateCondition() {
            return true;
          },
          releaseAll() {
            log.push(['expression.release-all']);
          },
        };
      },
      createHostPort(context) {
        log.push(['story-input.create']);
        assert.strictEqual(context.runtime, fixture.runtime);
        assert.equal(Object.isFrozen(context), true);
        return {
          wait(_payload, actionContext) {
            assert.match(actionContext.structuredData.actionScopeRef, /^@os1\./u);
            assert.match(actionContext.structuredData.actionViewRef, /^@os1\./u);
            assert.equal(Object.isFrozen(actionContext.structuredData), true);
          },
          dispose() {
            log.push(['story-input.dispose']);
          },
        };
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.host), true);
  assert.equal(Object.isFrozen(fixture.runtime), false);
  assert.equal(Object.isFrozen(fixture.runtime.targets[0]), false);
  assert.equal(result.host.getState().runtime.status, 'idle');
  assert.equal(
    log.some(([name]) => name === 'listener.add'),
    false,
  );

  result.host.attach(target);
  const finished = await result.host.start();
  assert.equal(finished.status, 'finished');
  const firstDispose = result.host.dispose('test-complete');
  const secondDispose = result.host.dispose('ignored');
  assert.strictEqual(secondDispose, firstDispose);
  await firstDispose;

  for (const event of [
    ['listener.add', 'keydown'],
    ['listener.remove', 'keydown'],
    ['story-input.dispose'],
    ['expression.release-all'],
    ['svg.release-all'],
    ['input.release-all'],
    ['pose.release-all'],
    ['media.release-all'],
  ]) {
    assert.equal(
      log.filter((entry) => JSON.stringify(entry) === JSON.stringify(event)).length,
      1,
      JSON.stringify(log),
    );
  }
  assert.throws(
    () => result.host.start(),
    (error) => error.code === 'K4-HOST-DISPOSED',
  );
});

test('renews the active story cache lease and cancels its heartbeat after execution', async () => {
  const cacheIdentity = {
    id: 'heartbeat0000001',
    label: 'story.kamishibai.yaml',
    databaseName: 'tw-kamishibai-assets-v1--story--heartbeat0000001',
  };
  const project = await packagedProject(
    `
kamishibai: '4.0'
assets:
  RemoteUnused:
    kind: backdrop
    delivery: remote
    loading: lazy
    source:
      url: https://cdn.example.com/unused.svg
      integrity: sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      contentType: image/svg+xml
      size: 12
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - wait: 0
`,
    {cacheIdentity},
  );
  const log = [];
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, platformFixture(log), {
      loadRemoteAsset: async () => assert.fail('unused remote asset must not load'),
      cacheLeaseHeartbeatMs: 1234,
      scheduleCacheLeaseHeartbeat(callback, milliseconds) {
        log.push(['cache.heartbeat-start', milliseconds]);
        callback();
        return () => log.push(['cache.heartbeat-stop']);
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal((await result.host.start()).status, 'finished');
  assert.equal(log.filter(([event]) => event === 'cache.renew-lease').length, 2);
  assert.deepEqual(
    log.filter(([event]) => event.startsWith('cache.heartbeat')),
    [['cache.heartbeat-start', 1234], ['cache.heartbeat-stop']],
  );
  assert.equal(result.host.verifiedRemoteCache.getHeartbeatError(), null);
  await result.host.dispose();
});

test('contains a cache heartbeat cancellation failure and still releases the lease', async () => {
  const cacheIdentity = {
    id: 'cancelerror00001',
    label: 'story.kamishibai.yaml',
    databaseName: 'tw-kamishibai-assets-v1--story--cancelerror00001',
  };
  const project = await packagedProject(
    `
kamishibai: '4.0'
assets:
  RemoteUnused:
    kind: backdrop
    delivery: remote
    loading: lazy
    source:
      url: https://cdn.example.com/unused.svg
      integrity: sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      contentType: image/svg+xml
      size: 12
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - wait: 0
`,
    {cacheIdentity},
  );
  const log = [];
  const cancellationFailure = new Error('heartbeat cancellation failed');
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, platformFixture(log), {
      loadRemoteAsset: async () => assert.fail('unused remote asset must not load'),
      scheduleCacheLeaseHeartbeat() {
        return () => {
          throw cancellationFailure;
        };
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal((await result.host.start()).status, 'finished');
  assert.strictEqual(result.host.verifiedRemoteCache.getHeartbeatError(), cancellationFailure);
  assert.equal(log.filter(([event]) => event === 'cache.release-lease').length, 1);
  await result.host.dispose();
});

test('a restarted run keeps the latest cache lease heartbeat active', async () => {
  const cacheIdentity = {
    id: 'restartheartbeat1',
    label: 'story.kamishibai.yaml',
    databaseName: 'tw-kamishibai-assets-v1--story--restartheartbeat1',
  };
  const project = await packagedProject(
    `
kamishibai: '4.0'
assets:
  RemoteUnused:
    kind: backdrop
    delivery: remote
    loading: lazy
    source:
      url: https://cdn.example.com/unused.svg
      integrity: sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      contentType: image/svg+xml
      size: 12
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - wait: 30
`,
    {cacheIdentity},
  );
  const log = [];
  const scheduledWaits = [];
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, platformFixture(log), {
      loadRemoteAsset: async () => assert.fail('unused remote asset must not load'),
      waitSchedule(callback) {
        const scheduled = {callback, cancelled: false};
        scheduledWaits.push(scheduled);
        return () => {
          scheduled.cancelled = true;
        };
      },
      scheduleCacheLeaseHeartbeat() {
        log.push(['cache.heartbeat-start']);
        return () => log.push(['cache.heartbeat-stop']);
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

  const firstRun = result.host.start();
  while (scheduledWaits.length < 1) await Promise.resolve();
  const restartedRun = result.host.start();
  while (scheduledWaits.length < 2) await Promise.resolve();
  await firstRun;
  assert.equal(scheduledWaits[0].cancelled, true);
  assert.equal(log.filter(([event]) => event === 'cache.heartbeat-stop').length, 0);
  assert.equal(log.filter(([event]) => event === 'cache.release-lease').length, 0);

  scheduledWaits[1].callback();
  assert.equal((await restartedRun).status, 'finished');
  assert.equal(log.filter(([event]) => event === 'cache.heartbeat-start').length, 1);
  assert.equal(log.filter(([event]) => event === 'cache.heartbeat-stop').length, 1);
  assert.equal(log.filter(([event]) => event === 'cache.release-lease').length, 1);
  await result.host.dispose();
});

test('uses the cache identity persisted in the packaged source for remote delivery', async () => {
  const cacheIdentity = {
    id: 'story000000000001',
    label: 'story.kamishibai.yaml',
    databaseName: 'tw-kamishibai-assets-v1--story--story000000000001',
  };
  const project = await packagedProject(
    `
kamishibai: '4.0'
assets:
  RemoteImage:
    kind: backdrop
    delivery: remote
    loading: lazy
    source:
      url: https://cdn.example.com/image.svg
      integrity: sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      contentType: image/svg+xml
      size: 12
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - stage: RemoteImage
`,
    {cacheIdentity},
  );
  const log = [];
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, platformFixture(log), {
      async loadRemoteAsset() {
        return {bytes: new Uint8Array(12), contentType: 'image/svg+xml'};
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.host.verifiedRemoteCache.identity, cacheIdentity);
  assert.deepEqual(log.find(([event]) => event === 'media.create')[1], {
    verifiedRemoteCache: {cacheIdentity},
  });
  await result.host.dispose();

  await assert.rejects(
    createDsl4TurboWarpRuntimeHost(
      enabledOptions(project, platformFixture([]), {
        loadRemoteAsset() {},
        cacheIdentity: {
          ...cacheIdentity,
          id: 'different0000001',
          databaseName: 'tw-kamishibai-assets-v1--story--different0000001',
        },
      }),
    ),
    (error) => error.code === 'K4-HOST-CACHE-IDENTITY-001',
  );
});

test('executes media, actor, SVG text, and wait actions through one composed runtime port', async () => {
  const project = await packagedProject(`
kamishibai: '4.0'
assets:
  Beach: backdrop
  HeroSkin: costume:Hero
  HeroSkin2: costume:Hero
  Bell: sound
actors:
  Hero: HeroSkin
textStyles:
  title:
    color: '#ffffff'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - stage: Beach
    - bgm: Bell
    - Hero.show:
        skin: HeroSkin
        x: 10
        y: 20
        scale: 30
    - Hero.hide: {}
    - Hero.show:
        skin: HeroSkin
        x: 10
        y: 20
        scale: 30
    - Hero.setLayer: back
    - Hero.loop:
        steps:
          - skin: HeroSkin
            seconds: 0.3
          - skin: HeroSkin2
            seconds: 0.3
    - Hero.setTransparency: 50
    - Hero.moveTo:
        x: 40
        y: 50
        seconds: 0
    - Hero.say:
        text: hello
        seconds: 0
    - Hero.setSkin:
        skin: HeroSkin
        scale: 45
    - Hero.setText:
        text: title
        style: title
    - sound: Bell
    - wait: 0
`);
  const log = [];
  const clock = manualScheduler();
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, platformFixture(log), {actorScheduler: clock.scheduler}),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const finished = await result.host.start();
  assert.equal(finished.status, 'finished');
  assert.equal(clock.pendingCount(), 0);
  for (const event of [
    ['media.stage', 'Beach'],
    ['media.play', 'Bell'],
    ['actor.size', 30],
    ['actor.visible', true],
    ['actor.visible', false],
    ['actor.layer', 'back'],
    ['actor.size', 45],
    ['actor.effect', 'ghost', 50],
    ['actor.xy', 40, 50],
    ['actor.say', 'hello'],
    ['svg.text', 'title', 'title'],
  ]) {
    assert.equal(
      log.some((entry) => JSON.stringify(entry) === JSON.stringify(event)),
      true,
      `${JSON.stringify(event)} not found in ${JSON.stringify(log)}`,
    );
  }
  await result.host.dispose();
});

test('foreground transparency waits and skip commits its final state before navigation', async () => {
  const project = await packagedProject(`
kamishibai: '4.0'
assets:
  HeroSkin: costume:Hero
actors:
  Hero: HeroSkin
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - Hero.setTransparency:
        from: 0
        to: 50
        seconds: 1
`);
  const log = [];
  const clock = manualScheduler();
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, platformFixture(log), {
      actorScheduler: clock.scheduler,
      actorFrameMilliseconds: 500,
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const run = result.host.start();
  while (clock.pendingCount() === 0) await Promise.resolve();
  clock.advance(500);
  assert.deepEqual(log.at(-1), ['actor.effect', 'ghost', 25]);

  const skipped = result.host.dispatchCommand('navigation.nextAction');
  assert.equal(skipped.ok, true);
  assert.equal(result.host.getState().runtime.status, 'finished');
  assert.deepEqual(log.at(-1), ['actor.effect', 'ghost', 50]);
  assert.equal(clock.pendingCount(), 0);
  await run;
  await result.host.dispose();
});

test('foreground transparency remains running after failed skip finalization and retries', async () => {
  const project = await packagedProject(`
kamishibai: '4.0'
assets:
  HeroSkin: costume:Hero
actors:
  Hero: HeroSkin
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - Hero.setTransparency:
        from: 0
        to: 50
        seconds: 1
`);
  const log = [];
  const fixture = platformFixture(log);
  const actor = fixture.runtime.targets.find((target) => target.isStage === false);
  const originalSetEffect = actor.setEffect.bind(actor);
  let finalizationFailures = 1;
  actor.setEffect = (effect, value) => {
    originalSetEffect(effect, value);
    if (value === 50 && finalizationFailures > 0) {
      finalizationFailures -= 1;
      throw new Error('finalization failed');
    }
  };
  const clock = manualScheduler();
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, fixture, {
      actorScheduler: clock.scheduler,
      actorFrameMilliseconds: 500,
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const run = result.host.start();
  while (clock.pendingCount() === 0) await Promise.resolve();

  assert.throws(
    () => result.host.dispatchCommand('navigation.nextAction'),
    /transparency transition cleanup failed/u,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.host.getState().runtime.status, 'running');
  assert.equal(clock.pendingCount(), 0);

  const skipped = result.host.dispatchCommand('navigation.nextAction');
  assert.equal(skipped.ok, true);
  assert.equal(result.host.getState().runtime.status, 'finished');
  assert.equal(
    log.filter(
      ([event, effect, value]) => event === 'actor.effect' && effect === 'ghost' && value === 50,
    ).length,
    2,
  );
  await run;
  await result.host.dispose();
});

test('background transparency runs with the next action and stop finalizes it before cancellation', async () => {
  const project = await packagedProject(`
kamishibai: '4.0'
assets:
  HeroSkin: costume:Hero
actors:
  Hero: HeroSkin
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - Hero.setTransparency:
        from: 0
        to: 50
        seconds: 1
        background: true
    - wait: 30
`);
  const log = [];
  const clock = manualScheduler();
  let waitScheduled = false;
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, platformFixture(log), {
      actorScheduler: clock.scheduler,
      actorFrameMilliseconds: 500,
      waitSchedule() {
        waitScheduled = true;
        return () => log.push(['wait.cancel']);
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const run = result.host.start();
  while (!waitScheduled) await Promise.resolve();
  clock.advance(500);
  assert.deepEqual(log.at(-1), ['actor.effect', 'ghost', 25]);

  const stopped = result.host.stop('test-stop');
  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(log.slice(-2), [['actor.effect', 'ghost', 50], ['wait.cancel']]);
  assert.equal(clock.pendingCount(), 0);
  await run;
  await result.host.dispose();
});

test('background transparency blocks skip until a failed final state can be retried', async () => {
  const project = await packagedProject(`
kamishibai: '4.0'
assets:
  HeroSkin: costume:Hero
actors:
  Hero: HeroSkin
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - Hero.setTransparency:
        from: 0
        to: 50
        seconds: 1
        background: true
    - wait: 30
`);
  const log = [];
  const fixture = platformFixture(log);
  const actor = fixture.runtime.targets.find((target) => target.isStage === false);
  const originalSetEffect = actor.setEffect.bind(actor);
  let interpolationFailures = 1;
  let finalizationFailures = 2;
  actor.setEffect = (effect, value) => {
    originalSetEffect(effect, value);
    if (value === 25 && interpolationFailures > 0) {
      interpolationFailures -= 1;
      throw new Error('interpolation failed');
    }
    if (value === 50 && finalizationFailures > 0) {
      finalizationFailures -= 1;
      throw new Error('finalization failed');
    }
  };
  const clock = manualScheduler();
  let waitScheduled = false;
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, fixture, {
      actorScheduler: clock.scheduler,
      actorFrameMilliseconds: 500,
      waitSchedule() {
        waitScheduled = true;
        return () => log.push(['wait.cancel']);
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const run = result.host.start();
  while (!waitScheduled) await Promise.resolve();
  clock.advance(500);
  await Promise.resolve();

  assert.throws(
    () => result.host.dispatchCommand('navigation.nextAction'),
    /transparency transition cleanup failed/u,
  );
  assert.equal(result.host.getState().runtime.status, 'running');
  assert.equal(
    log.some(([event]) => event === 'wait.cancel'),
    false,
  );

  const skipped = result.host.dispatchCommand('navigation.nextAction');
  assert.equal(skipped.ok, true);
  assert.equal(result.host.getState().runtime.status, 'finished');
  assert.deepEqual(log.slice(-2), [['actor.effect', 'ghost', 50], ['wait.cancel']]);
  await run;
  await result.host.dispose();
});

test('injects story input and transition capabilities without colliding with platform ports', async () => {
  const project = await packagedProject(`
kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - keyInputToChangeScene:
        Digit1: ending
  ending:
    - transition:
        effect: fadeOut
        seconds: 0
    - wait: 0
`);
  const log = [];
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, platformFixture(log), {
      createHostPort() {
        return {
          keyInputToChangeScene(payload) {
            log.push(['story.key', payload.codes]);
            return 'Digit1';
          },
          transition(payload) {
            log.push(['story.transition', payload.effect, payload.seconds]);
          },
        };
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const finished = await result.host.start();
  assert.equal(finished.status, 'finished');
  assert.deepEqual(
    log.filter(([name]) => name.startsWith('story.')),
    [
      ['story.key', ['Digit1']],
      ['story.transition', 'fadeOut', 0],
    ],
  );
  await result.host.dispose();
});

test('uses default Runtime Expression and one Async Input composition for key and touch routing', async () => {
  const project = await packagedProject(`
kamishibai: '4.0'
variables:
  score: 1
controls:
  keymaps:
    production:
      Space: navigation.nextAction
branches:
  chooseInput:
    - if: 'score === 1'
      goto: keyChoice
    - else: failed
scenes:
  opening:
    - branch: chooseInput
  keyChoice:
    - keyInputToChangeScene:
        ArrowRight: touchChoice
  touchChoice:
    - touchInputToChangeScene:
        Hero: ending
  failed:
    - wait: 0
  ending:
    - wait: 0
`);
  const log = [];
  let keyListener = null;
  let touchListener = null;
  const events = [];
  const keySource = {
    subscribeKeyCandidate(listener) {
      assert.equal(keyListener, null);
      keyListener = listener;
      return () => {
        if (keyListener === listener) keyListener = null;
      };
    },
  };
  const actorTouchSource = {
    subscribeActorTouchCandidate(listener) {
      assert.equal(touchListener, null);
      touchListener = listener;
      return () => {
        if (touchListener === listener) touchListener = null;
      };
    },
  };
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, platformFixture(log), {
      createAsyncInputComposition: undefined,
      keySource,
      actorTouchSource,
      onEvent(event) {
        events.push(event);
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

  const run = result.host.start();
  while (!keyListener) await new Promise((resolve) => setImmediate(resolve));
  keyListener({
    version: 1,
    code: 'ArrowRight',
    repeat: false,
    isComposing: false,
    hasModifier: false,
    interactiveTarget: false,
    timestamp: 1,
  });
  while (!touchListener) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(keyListener, null);
  touchListener({
    version: 1,
    actorId: 'Hero',
    primaryButton: true,
    topmost: true,
    actorNameUnique: true,
    timestamp: 2,
  });

  const finished = await run;
  assert.deepEqual(
    events.filter((event) => event.type === 'scene.transition').map((event) => event.details),
    [
      {from: null, to: 'opening', reason: 'start'},
      {from: 'opening', to: 'keyChoice', reason: 'branch'},
      {from: 'keyChoice', to: 'touchChoice', reason: 'keyInput'},
      {from: 'touchChoice', to: 'ending', reason: 'touchInput'},
    ],
  );
  assert.equal(finished.status, 'finished');
  assert.equal(finished.sceneId, 'ending');
  assert.equal(touchListener, null);
  await result.host.dispose();
});

test('fails closed for missing story input and injected built-in collisions, then cleans up', async () => {
  const inputStory = `
kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - keyInputToChangeScene:
        Digit1: ending
  ending:
    - wait: 0
`;
  const inputProject = await packagedProject(inputStory);
  const missingLog = [];
  await assert.rejects(
    createDsl4TurboWarpRuntimeHost(enabledOptions(inputProject, platformFixture(missingLog))),
    (error) => error.code === 'K4-HOST-PORT-MISSING',
  );
  assert.equal(missingLog.filter(([name]) => name === 'svg.release-all').length, 1);
  assert.equal(missingLog.filter(([name]) => name === 'media.release-all').length, 1);

  const waitProject = await packagedProject();
  const collisionLog = [];
  await assert.rejects(
    createDsl4TurboWarpRuntimeHost(
      enabledOptions(waitProject, platformFixture(collisionLog), {
        createHostPort() {
          return {
            stage() {},
            dispose() {
              collisionLog.push(['story-input.dispose']);
            },
          };
        },
      }),
    ),
    (error) => error.code === 'K4-HOST-PORT-COLLISION',
  );
  assert.equal(collisionLog.filter(([name]) => name === 'story-input.dispose').length, 1);
  assert.equal(collisionLog.filter(([name]) => name === 'media.release-all').length, 1);
});

test('releases an invalid Runtime Expression composition during partial creation', async () => {
  const project = await packagedProject();
  const log = [];
  await assert.rejects(
    createDsl4TurboWarpRuntimeHost(
      enabledOptions(project, platformFixture(log), {
        createRuntimeExpressionComposition() {
          log.push(['expression.create-invalid']);
          return {
            releaseAll() {
              log.push(['expression.release-all-invalid']);
            },
          };
        },
      }),
    ),
    /must provide evaluateCondition/u,
  );
  assert.equal(log.filter(([name]) => name === 'expression.release-all-invalid').length, 1);
  assert.equal(log.filter(([name]) => name === 'svg.release-all').length, 1);
  assert.equal(log.filter(([name]) => name === 'input.release-all').length, 1);
  assert.equal(log.filter(([name]) => name === 'media.release-all').length, 1);
});

test('stop cancels the default wait boundary and stale timer completion cannot resume execution', async () => {
  const project = await packagedProject(`
kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - wait: 30
    - wait: 0
`);
  const log = [];
  let scheduled;
  let cancellations = 0;
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, platformFixture(log), {
      waitSchedule(callback) {
        scheduled = callback;
        return () => {
          cancellations += 1;
        };
      },
    }),
  );
  assert.equal(result.ok, true);
  const run = result.host.start();
  while (!scheduled) await Promise.resolve();
  const stopped = result.host.stop('test-stop');
  assert.equal(stopped.status, 'stopped');
  await run;
  assert.equal(cancellations, 1);
  scheduled();
  await Promise.resolve();
  assert.equal(result.host.getState().runtime.status, 'stopped');
  await result.host.dispose();
});

test('dispose releases a host-owned pending input before awaiting runtime settlement', async () => {
  const project = await packagedProject(`
kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - keyInputToChangeScene:
        Digit1: ending
  ending:
    - wait: 0
`);
  const log = [];
  let settleInput;
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, platformFixture(log), {
      createHostPort() {
        return {
          keyInputToChangeScene() {
            log.push(['story-input.wait']);
            return new Promise((resolve) => {
              settleInput = resolve;
            });
          },
          dispose() {
            log.push(['story-input.dispose']);
            settleInput?.('Digit1');
          },
        };
      },
    }),
  );
  const run = result.host.start();
  while (!settleInput) await Promise.resolve();
  await result.host.dispose('pending-input-dispose');
  await run;
  assert.equal(log.filter(([name]) => name === 'story-input.dispose').length, 1);
  assert.equal(result.host.getState().runtime.status, 'stopped');
});

test('keeps resource ownership isolated across two host sessions', async () => {
  const project = await packagedProject();
  const firstLog = [];
  const secondLog = [];
  const first = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, platformFixture(firstLog)),
  );
  const second = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, platformFixture(secondLog)),
  );
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  await first.host.dispose('first');
  assert.equal(firstLog.filter(([name]) => name === 'media.release-all').length, 1);
  assert.equal(secondLog.filter(([name]) => name === 'media.release-all').length, 0);
  assert.equal(second.host.getState().runtime.status, 'idle');
  await second.host.dispose('second');
  assert.equal(secondLog.filter(([name]) => name === 'media.release-all').length, 1);
});

test('attempts every partial cleanup and aggregates creation plus cleanup failures', async () => {
  const project = await packagedProject();
  const log = [];
  const fixture = platformFixture(log);
  const createAssetManagerComposition = fixture.createAssetManagerComposition;
  const createSvgTextComposition = fixture.createSvgTextComposition;
  fixture.createAssetManagerComposition = () => {
    const composition = createAssetManagerComposition();
    return {
      ...composition,
      releaseAll() {
        log.push(['media.release-all-failed']);
        throw new Error('media cleanup failed');
      },
    };
  };
  fixture.createSvgTextComposition = () => {
    const composition = createSvgTextComposition();
    return {
      ...composition,
      releaseAll() {
        log.push(['svg.release-all-failed']);
        throw new Error('SVG cleanup failed');
      },
    };
  };

  await assert.rejects(
    createDsl4TurboWarpRuntimeHost(
      enabledOptions(project, fixture, {
        createRuntimeExpressionComposition() {
          return {
            evaluateCondition() {
              return true;
            },
            releaseAll() {
              log.push(['expression.release-all']);
            },
          };
        },
        createHostPort() {
          return {stage() {}};
        },
      }),
    ),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors[0].code, 'K4-HOST-PORT-COLLISION');
      assert.equal(error.errors.length, 3);
      return true;
    },
  );
  assert.equal(log.filter(([name]) => name === 'svg.release-all-failed').length, 1);
  assert.equal(log.filter(([name]) => name === 'expression.release-all').length, 1);
  assert.equal(log.filter(([name]) => name === 'media.release-all-failed').length, 1);
  assert.equal(log.filter(([name]) => name === 'pose.release-all').length, 1);
});
