import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {strToU8, zipSync} from 'fflate';

import {
  createDsl4LocalPreviewBrowserRuntime,
  createDsl4ProductionSourceFrontend,
  Dsl4LocalPreviewBrowserRuntimeError,
} from '../src/builder/index.js';
import {
  createDsl4PackagedRuntimeProject,
  dsl4TestSubtleCrypto,
} from './helpers/dsl4-runtime-fixtures.mjs';
import {createFakeDocument, findByAttribute} from './helpers/fake-dom.mjs';

const schema = JSON.parse(
  await readFile(new URL('../schema/dsl-4.schema.json', import.meta.url), 'utf8'),
);
const frontend = createDsl4ProductionSourceFrontend(schema);
const subtleCrypto = dsl4TestSubtleCrypto;
const limits = {maxSourceBytes: 16_384, maxAssetFiles: 16, maxAssetBytes: 65_536};
const source = `
kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening: []
`;

function baseProject() {
  return {
    extensionStorage: {},
    targets: [{isStage: true, name: 'Stage', blocks: {}}],
    monitors: [],
  };
}

/** @param {unknown} project */
function sb3(project) {
  return new Uint8Array(zipSync({'project.json': strToU8(JSON.stringify(project))}));
}

async function packagedProject() {
  return createDsl4PackagedRuntimeProject(source, {
    sourceFrontend: frontend,
    displayName: 'preview.k4.yml',
    limits,
    baseProject: baseProject(),
    subtleCrypto,
  });
}

function domFixture() {
  const document = createFakeDocument();
  const mount = document.createElement('div');
  mount.removeChild = function removeChild(child) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new TypeError('child is not mounted');
    this.children.splice(index, 1);
    child.parentNode = null;
  };
  return {
    document,
    mount,
    get children() {
      return mount.children;
    },
    listenerCount(type) {
      const canvas = mount.children.find((child) => child.dataset.dsl4TurboWarpStage === 'true');
      return canvas?.listeners.get(type)?.length ?? 0;
    },
  };
}

/** @param {unknown[]} log @param {Promise<void>} [loadGate] */
function platformFixture(log, loadGate = Promise.resolve()) {
  const stage = {
    isStage: true,
    currentCostume: 0,
    sprite: {
      costumes: ['Title', 'TitleRuntime', 'Menu', 'MenuRuntime'].map((name) => ({name})),
    },
    setCostume(index) {
      this.currentCostume = index;
    },
  };
  const runtime = {
    targets: [stage],
    securityManager: {},
    getTargetForStage() {
      return stage;
    },
  };
  const vm = {
    runtime,
    securityManager: runtime.securityManager,
    extensionManager: {
      addBuiltinExtension(id, Extension) {
        const info = new Extension().getInfo();
        assert.equal(info.id, id);
        assert.deepEqual(info.blocks, []);
        log.push(`vm.addBuiltinExtension:${id}`);
      },
    },
    attachStorage() {
      log.push('vm.attachStorage');
    },
    attachRenderer() {
      log.push('vm.attachRenderer');
    },
    attachAudioEngine() {
      log.push('vm.attachAudioEngine');
    },
    attachV2BitmapAdapter() {
      log.push('vm.attachBitmap');
    },
    setCompatibilityMode() {},
    setTurboMode() {},
    setCompilerOptions() {},
    async loadProject() {
      log.push('vm.loadProject');
      await loadGate;
    },
    postIOData() {},
    start() {
      log.push('vm.start');
    },
    clear() {
      log.push('vm.clear');
    },
    quit() {
      log.push('vm.quit');
    },
  };
  return {
    createVm() {
      log.push('platform.createVm');
      return vm;
    },
    createRenderer() {
      log.push('platform.createRenderer');
      return {};
    },
    createAudioEngine() {
      log.push('platform.createAudio');
      return {};
    },
    createStorage() {
      log.push('platform.createStorage');
      return {};
    },
    createBitmapAdapter() {
      log.push('platform.createBitmap');
      return {};
    },
    disposeRenderer() {
      log.push('platform.disposeRenderer');
    },
    disposeAudioEngine() {
      log.push('platform.disposeAudio');
    },
    disposeStorage() {
      log.push('platform.disposeStorage');
    },
    disposeBitmapAdapter() {
      log.push('platform.disposeBitmap');
    },
  };
}

/** @param {Uint8Array} projectBytes @param {Record<string, unknown>} extra */
function runtimeOptions(projectBytes, extra) {
  const dom = domFixture();
  return {
    projectBytes,
    sourceFrontend: frontend,
    document: dom.document,
    mount: dom.mount,
    sessionId: 'browser-runtime-owner-test',
    ...limits,
    subtleCrypto,
    runtimeOptions: {
      tmPoseRuntime: {Webcam: class {}, async loadFromFiles() {}},
      setLoading() {},
    },
    ...extra,
    dom,
  };
}

test('starts one validated stage and bridge, then disposes bridge ownership before the VM', async () => {
  const project = structuredClone(await packagedProject());
  project.extensions = ['kubohiroyakamishibai4'];
  project.extensionURLs = {
    kubohiroyakamishibai4: 'data:text/javascript;base64,ZmFrZQ==',
  };
  const bytes = sb3(project);
  const log = [];
  let parseCount = 0;
  const previousScratch = {
    legacyHost: true,
    prefix: 'translate',
    Cast: {
      prefix: 'cast',
      toString(value) {
        return `${this.prefix}:${value}`;
      },
    },
    translate(value) {
      return `${this.prefix}:${value}`;
    },
  };
  const globalObject = {Scratch: previousScratch};
  const options = runtimeOptions(bytes, {platform: platformFixture(log), globalObject});
  options.sourceFrontend = {
    parse(text, parseOptions) {
      parseCount += 1;
      return frontend.parse(text, parseOptions);
    },
  };
  const runtime = createDsl4LocalPreviewBrowserRuntime(options);
  bytes.fill(0);

  assert.throws(() => runtime.accept({}), /not ready/u);
  const started = await runtime.start();
  assert.equal(started.ready, true);
  assert.equal(started.stage.hasStage, true);
  assert.equal(started.bridge.status, 'waiting');
  assert.equal(parseCount, 1);
  assert.equal(options.dom.children.length, 3);
  assert.equal(findByAttribute(options.dom.mount, 'data-dsl4-application-menu', 'true').length, 1);
  assert.equal(findByAttribute(options.dom.mount, 'data-dsl4-title-controls', 'true').length, 1);
  assert.equal(log.filter((entry) => entry === 'vm.loadProject').length, 1);
  assert.equal(
    log.filter((entry) => entry === 'vm.addBuiltinExtension:kubohiroyakamishibai4').length,
    1,
  );
  assert.equal(globalObject.Scratch.legacyHost, true);
  assert.equal(globalObject.Scratch.vm.runtime.targets.length, 1);
  assert.equal(globalObject.Scratch.vm.runtime.targets[0].isStage, true);
  assert.equal(globalObject.Scratch.Cast.toString('value'), 'cast:value');
  assert.equal(globalObject.Scratch.translate('value'), 'translate:value');

  const disposed = await runtime.dispose();
  assert.equal(disposed.status, 'disposed');
  assert.equal(options.dom.children.length, 0);
  assert.equal(log.filter((entry) => entry === 'vm.clear').length, 1);
  assert.equal(log.filter((entry) => entry === 'vm.quit').length, 1);
  assert.equal(log.filter((entry) => entry === 'platform.disposeRenderer').length, 1);
  assert.strictEqual(globalObject.Scratch, previousScratch);
});

test('rejects an invalid base component before allocating any TurboWarp platform resource', async () => {
  const options = runtimeOptions(sb3(baseProject()), {
    platform: new Proxy({}, {get: () => assert.fail('platform must not be inspected')}),
  });
  options.runtimeOptions = new Proxy(
    {},
    {get: () => assert.fail('runtime platform options must not be inspected')},
  );
  const runtime = createDsl4LocalPreviewBrowserRuntime(options);

  await assert.rejects(
    runtime.start(),
    (error) =>
      error instanceof Dsl4LocalPreviewBrowserRuntimeError &&
      error.code === 'K4-PREVIEW-RUNTIME-COMPONENT-001' &&
      error.diagnosticCode === 'K4-SOURCE-CHANNEL-MISSING',
  );
  assert.equal(runtime.getState().status, 'failed');
  assert.equal(JSON.stringify(runtime.getState()).includes('StoryDocument'), false);
  await runtime.dispose();
});

test('cancels startup after project load and releases the partial stage once', async () => {
  let finishLoad;
  const loadGate = new Promise((resolve) => {
    finishLoad = resolve;
  });
  const log = [];
  const options = runtimeOptions(sb3(await packagedProject()), {
    platform: platformFixture(log, loadGate),
  });
  const runtime = createDsl4LocalPreviewBrowserRuntime(options);
  const starting = runtime.start();
  while (!log.includes('vm.loadProject')) await new Promise((resolve) => setTimeout(resolve, 0));
  const disposing = runtime.dispose();
  finishLoad();

  await assert.rejects(
    starting,
    (error) =>
      error instanceof Dsl4LocalPreviewBrowserRuntimeError &&
      error.code === 'K4-PREVIEW-RUNTIME-DISPOSED',
  );
  const disposed = await disposing;
  assert.equal(disposed.status, 'disposed');
  assert.equal(log.filter((entry) => entry === 'vm.clear').length, 1);
  assert.equal(log.filter((entry) => entry === 'vm.quit').length, 1);
  assert.equal(options.dom.children.length, 0);
});

test('rejects an oversized retained project before copying or inspecting dependencies', () => {
  const options = runtimeOptions(Uint8Array.of(1, 2), {
    maxProjectBytes: 1,
    platform: new Proxy({}, {get: () => assert.fail('platform must not be inspected')}),
  });
  assert.throws(() => createDsl4LocalPreviewBrowserRuntime(options), /projectBytes must contain/u);
});
