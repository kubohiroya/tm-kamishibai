import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
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
} from '../src/dsl4/index.js';
import {createDsl4TurboWarpRuntimeHost} from '../src/dsl4/platform/index.js';

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

function baseProject() {
  return {extensionStorage: {}, targets: [], monitors: []};
}

async function packagedProject(sourceText = waitStory, {cacheIdentity} = {}) {
  const parsed = frontend.parse(sourceText, {sourceId: 'main'});
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
    {maxSourceBytes: limits.maxSourceBytes, subtleCrypto},
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
      subtleCrypto,
    },
  );
}

function platformFixture(log) {
  const poseConfidence = {value: 0};
  const poseProgress = {value: 0};
  const stage = {
    id: 'stage-target',
    isStage: true,
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
  };
  const assetManagerComposition = {
    async registerProjectAsset(input) {
      log.push(['media.register', input.name]);
      return {
        name: input.name,
        mimeType: input.resourceId.startsWith('sound:') ? 'audio/wav' : 'image/svg+xml',
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
      return name === 'Bell' ? 'audio/wav' : 'image/svg+xml';
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
    getTargetForStage() {
      return stage;
    },
    ext_scratch3_looks: {
      _say(message) {
        log.push(['actor.say', message]);
      },
    },
  };
  return {
    runtime,
    poseConfidence,
    poseProgress,
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
  const scratch = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(scratchProject, scratchFixture, {
      featureFlags: {dsl4Runtime: true, dsl4PoseFeedbackModes: true},
    }),
  );
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
  const presenter = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(presenterProject, platformFixture([]), {
      featureFlags: {dsl4Runtime: true, dsl4PoseFeedbackModes: true},
      onPoseState() {},
    }),
  );
  assert.equal(presenter.ok, true, JSON.stringify(presenter.diagnostics));
  await presenter.host.dispose('presenter-feedback-enabled');
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
  let progress = 50;
  fixture.poseConfidence.value = 75;
  Object.defineProperty(fixture.poseProgress, 'value', {
    configurable: true,
    get() {
      return progress;
    },
    set(value) {
      if (value === 0) throw new Error('Scratch reset failed');
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

  await assert.rejects(result.host.dispose('reset-failure'), (error) => {
    assert.equal(error instanceof AggregateError, true);
    return true;
  });
  assert.equal(log.filter(([event]) => event === 'host-port.dispose').length, 1);
  assert.equal(log.filter(([event]) => event === 'svg.release-all').length, 1);
  assert.equal(log.filter(([event]) => event === 'pose.release-all').length, 1);
  assert.equal(log.filter(([event]) => event === 'media.release-all').length, 1);
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
    - Hero.moveTo:
        x: 40
        y: 50
        seconds: 0
    - Hero.say:
        text: hello
        seconds: 0
    - Hero.setSkin: HeroSkin
    - Hero.setText:
        text: title
        style: title
    - sound: Bell
    - wait: 0
`);
  const log = [];
  const result = await createDsl4TurboWarpRuntimeHost(
    enabledOptions(project, platformFixture(log)),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const finished = await result.host.start();
  assert.equal(finished.status, 'finished');
  for (const event of [
    ['media.stage', 'Beach'],
    ['media.play', 'Bell'],
    ['actor.size', 30],
    ['actor.visible', true],
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
