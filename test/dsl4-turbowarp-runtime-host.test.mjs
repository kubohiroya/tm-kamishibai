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

function baseProject() {
  return {extensionStorage: {}, targets: [], monitors: []};
}

async function packagedProject(sourceText = waitStory) {
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
  const snapshotAssets = Object.values(parsed.storyDocument.assets)
    .map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      loading: asset.loading,
      ...(typeof asset.target === 'string' ? {target: asset.target} : {}),
      source: {type: 'project', name: asset.name},
    }))
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
  };
  const runtime = {
    targets: [actor],
    ext_scratch3_looks: {
      _say(message) {
        log.push(['actor.say', message]);
      },
    },
  };
  return {
    runtime,
    tmPoseRuntime: {Webcam: class {}, loadFromFiles() {}},
    setLoading(payload) {
      log.push(['loading', payload.visible]);
    },
    createAssetManagerComposition() {
      log.push(['media.create']);
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
    enabledOptions(baseProject(), platformFixture(log)),
  );
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, 'K4-SOURCE-CHANNEL-MISSING');
  assert.equal(result.host, null);
  assert.deepEqual(log, []);
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
      createHostPort(context) {
        log.push(['story-input.create']);
        assert.strictEqual(context.runtime, fixture.runtime);
        assert.equal(Object.isFrozen(context), true);
        return {
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
  assert.equal(log.filter(([name]) => name === 'media.release-all-failed').length, 1);
  assert.equal(log.filter(([name]) => name === 'pose.release-all').length, 1);
});

test('keeps the host composition free of global Scratch, DOM, storage, and network access', async () => {
  const implementation = await readFile(
    path.join(repositoryRoot, 'src', 'dsl4', 'platform', 'turbowarp-runtime-host.js'),
    'utf8',
  );
  assert.doesNotMatch(
    implementation,
    /(?:\bScratch\b|globalThis\.(?:document|window)|\bindexedDB\b|\bfetch\s*\()/u,
  );
});
