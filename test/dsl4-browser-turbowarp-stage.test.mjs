import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
  createDsl4BrowserTurboWarpStage,
  dsl4BrowserTurboWarpStageMaximumProjectBytes,
} from '../src/dsl4/index.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

function fakeDocument() {
  const mount = {
    children: [],
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index < 0) throw new TypeError('child is not mounted');
      this.children.splice(index, 1);
      child.parentNode = null;
    },
  };
  const document = {
    createElement(name) {
      assert.equal(name, 'canvas');
      const listeners = new Map();
      return {
        nodeName: 'CANVAS',
        dataset: {},
        style: {},
        attributes: {},
        parentNode: null,
        setAttribute(key, value) {
          this.attributes[key] = value;
        },
        addEventListener(type, listener) {
          const values = listeners.get(type) ?? [];
          values.push(listener);
          listeners.set(type, values);
        },
        removeEventListener(type, listener) {
          listeners.set(
            type,
            (listeners.get(type) ?? []).filter((value) => value !== listener),
          );
        },
        dispatch(type, event = {}) {
          for (const listener of listeners.get(type) ?? []) listener(event);
        },
        listenerCount() {
          return [...listeners.values()].flat().length;
        },
        getBoundingClientRect() {
          return {left: 10, top: 20, width: 480, height: 360};
        },
        focus() {
          this.focused = true;
        },
      };
    },
  };
  return {document, mount};
}

function platformFixture({loadGate, resetGate, failAudio = false, failReset = false} = {}) {
  const log = [];
  const runtime = {targets: []};
  const io = [];
  let loadCount = 0;
  const vm = {
    runtime,
    securityManager: {},
    attachStorage(value) {
      log.push(['attach.storage', value.name]);
    },
    attachRenderer(value) {
      log.push(['attach.renderer', value.name]);
    },
    attachAudioEngine(value) {
      log.push(['attach.audio', value.name]);
    },
    attachV2BitmapAdapter(value) {
      log.push(['attach.bitmap', value.name]);
    },
    setCompatibilityMode(value) {
      log.push(['compatibility', value]);
    },
    setTurboMode(value) {
      log.push(['turbo', value]);
    },
    setCompilerOptions(value) {
      log.push(['compiler', value.enabled]);
    },
    async loadProject(bytes) {
      loadCount += 1;
      log.push(['load', bytes.byteLength]);
      await (loadCount === 1 ? loadGate : resetGate)?.promise;
      if (loadCount > 1 && failReset) throw new Error('reset load failed');
      runtime.targets = [{isStage: true, name: 'Stage', loadCount}];
    },
    postIOData(device, data) {
      io.push([device, data]);
    },
    start() {
      log.push(['vm.start']);
    },
    clear() {
      log.push(['vm.clear']);
      runtime.targets = [];
    },
    quit() {
      log.push(['vm.quit']);
    },
  };
  const platform = {
    createStorage() {
      log.push(['create.storage']);
      return {name: 'storage'};
    },
    createRenderer() {
      log.push(['create.renderer']);
      return {name: 'renderer'};
    },
    createAudioEngine() {
      log.push(['create.audio']);
      if (failAudio) throw new Error('audio failed');
      return {name: 'audio'};
    },
    createBitmapAdapter() {
      log.push(['create.bitmap']);
      return {name: 'bitmap'};
    },
    createVm() {
      log.push(['create.vm']);
      return vm;
    },
    disposeBitmapAdapter(value, reason) {
      log.push(['dispose.bitmap', value.name, reason]);
    },
    disposeAudioEngine(value, reason) {
      log.push(['dispose.audio', value.name, reason]);
    },
    disposeRenderer(value, reason) {
      log.push(['dispose.renderer', value.name, reason]);
    },
    disposeStorage(value, reason) {
      log.push(['dispose.storage', value.name, reason]);
    },
  };
  return {platform, vm, runtime, log, io};
}

test('owns one visible TurboWarp stage, forwards bounded input, and disposes once', async () => {
  const dom = fakeDocument();
  const fixture = platformFixture();
  const stage = createDsl4BrowserTurboWarpStage({
    ...dom,
    projectBytes: new Uint8Array([1, 2, 3]),
    platform: fixture.platform,
    prepareVm(vm) {
      assert.equal(vm, fixture.vm);
      fixture.log.push(['prepare']);
    },
  });

  const ready = await stage.start();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.targetCount, 1);
  assert.equal(ready.hasStage, true);
  assert.equal(stage.getRuntime(), fixture.runtime);
  const canvas = stage.getCanvas();
  assert.equal(canvas.dataset.dsl4TurboWarpStage, 'true');
  assert.equal(canvas.attributes['aria-label'], 'TurboWarp project stage');
  assert.equal(dom.mount.children[0], canvas);
  assert.equal(canvas.listenerCount(), 6);
  assert.equal(
    fixture.vm.securityManager.canLoadExtensionFromProject('https://example.com'),
    false,
  );

  let prevented = 0;
  canvas.dispatch('pointerdown', {
    button: 0,
    clientX: 250,
    clientY: 200,
    preventDefault() {
      prevented += 1;
    },
  });
  canvas.dispatch('pointerup', {button: 0, clientX: 250, clientY: 200});
  canvas.dispatch('keydown', {key: 'ArrowRight'});
  canvas.dispatch('keyup', {key: 'ArrowRight'});
  assert.equal(prevented, 1);
  assert.equal(canvas.focused, true);
  assert.deepEqual(fixture.io, [
    ['mouse', {x: 240, y: 180, canvasWidth: 480, canvasHeight: 360, isDown: true}],
    ['mouse', {x: 240, y: 180, canvasWidth: 480, canvasHeight: 360, isDown: false}],
    ['keyboard', {key: 'ArrowRight', isDown: true}],
    ['keyboard', {key: 'ArrowRight', isDown: false}],
  ]);

  assert.deepEqual(await stage.dispose(), await stage.dispose());
  assert.equal(stage.getState().status, 'disposed');
  assert.equal(canvas.listenerCount(), 0);
  assert.equal(dom.mount.children.length, 0);
  assert.deepEqual(
    fixture.log.filter(([operation]) => operation.startsWith('dispose.')),
    [
      ['dispose.bitmap', 'bitmap', 'dispose'],
      ['dispose.audio', 'audio', 'dispose'],
      ['dispose.renderer', 'renderer', 'dispose'],
      ['dispose.storage', 'storage', 'dispose'],
    ],
  );
  assert.equal(fixture.log.filter(([operation]) => operation === 'vm.clear').length, 1);
  assert.equal(fixture.log.filter(([operation]) => operation === 'vm.quit').length, 1);
});

test('cleans partial platform resources when startup fails', async () => {
  const dom = fakeDocument();
  const fixture = platformFixture({failAudio: true});
  const stage = createDsl4BrowserTurboWarpStage({
    ...dom,
    projectBytes: new Uint8Array([1]),
    platform: fixture.platform,
  });
  await assert.rejects(() => stage.start(), /audio failed/u);
  assert.equal(stage.getState().status, 'failed');
  assert.equal(dom.mount.children.length, 0);
  assert.deepEqual(
    fixture.log.filter(([operation]) => operation.startsWith('dispose.')),
    [
      ['dispose.renderer', 'renderer', 'start-failed'],
      ['dispose.storage', 'storage', 'start-failed'],
    ],
  );
  await stage.dispose();
  assert.equal(stage.getState().status, 'disposed');
});

test('reloads the retained base project to reset presentation without replacing the VM', async () => {
  const gate = deferred();
  const dom = fakeDocument();
  const fixture = platformFixture({resetGate: gate});
  const input = new Uint8Array([1, 2, 3]);
  const stage = createDsl4BrowserTurboWarpStage({
    ...dom,
    projectBytes: input,
    platform: fixture.platform,
  });
  input.fill(0);
  await stage.start();
  const runtime = stage.getRuntime();
  runtime.targets[0].name = 'Changed';
  const canvas = stage.getCanvas();
  const firstReset = stage.resetManagedPresentation();
  const secondReset = stage.resetManagedPresentation();

  assert.strictEqual(secondReset, firstReset);
  assert.equal(stage.getState().status, 'resetting');
  assert.equal(canvas.listenerCount(), 0);
  assert.throws(() => stage.getRuntime(), /not ready/u);
  gate.resolve();
  const resetState = await firstReset;
  assert.equal(resetState.status, 'ready');
  assert.strictEqual(stage.getRuntime(), runtime);
  assert.deepEqual(runtime.targets, [{isStage: true, name: 'Stage', loadCount: 2}]);
  assert.equal(canvas.listenerCount(), 6);
  assert.equal(fixture.log.filter(([operation]) => operation === 'load').length, 2);
  await stage.dispose();
});

test('does not reattach input when disposal races a presentation reset', async () => {
  const gate = deferred();
  const dom = fakeDocument();
  const fixture = platformFixture({resetGate: gate});
  const stage = createDsl4BrowserTurboWarpStage({
    ...dom,
    projectBytes: new Uint8Array([1, 2]),
    platform: fixture.platform,
  });
  await stage.start();
  const canvas = stage.getCanvas();
  const resetting = stage.resetManagedPresentation();
  const disposing = stage.dispose();
  assert.equal(stage.getState().status, 'disposing');
  assert.equal(canvas.listenerCount(), 0);
  gate.resolve();

  await Promise.all([resetting, disposing]);
  assert.equal(stage.getState().status, 'disposed');
  assert.equal(canvas.listenerCount(), 0);
  assert.equal(fixture.log.filter(([operation]) => operation === 'vm.clear').length, 1);
  assert.equal(fixture.log.filter(([operation]) => operation === 'vm.quit').length, 1);
});

test('cleans the whole stage after a base presentation reset fails', async () => {
  const dom = fakeDocument();
  const fixture = platformFixture({failReset: true});
  const stage = createDsl4BrowserTurboWarpStage({
    ...dom,
    projectBytes: new Uint8Array([1]),
    platform: fixture.platform,
  });
  await stage.start();
  const canvas = stage.getCanvas();

  await assert.rejects(() => stage.resetManagedPresentation(), /reset load failed/u);
  assert.equal(stage.getState().status, 'failed');
  assert.equal(canvas.listenerCount(), 0);
  assert.equal(dom.mount.children.length, 0);
  assert.equal(fixture.log.filter(([operation]) => operation === 'vm.clear').length, 1);
  await stage.dispose();
  assert.equal(stage.getState().status, 'disposed');
  assert.equal(fixture.log.filter(([operation]) => operation === 'vm.clear').length, 1);
});

test('does not start the VM when disposal races project loading', async () => {
  const gate = deferred();
  const dom = fakeDocument();
  const fixture = platformFixture({loadGate: gate});
  const stage = createDsl4BrowserTurboWarpStage({
    ...dom,
    projectBytes: new Uint8Array([1, 2]),
    platform: fixture.platform,
  });
  const starting = stage.start();
  const disposing = stage.dispose();
  gate.resolve();
  await Promise.all([starting, disposing]);
  assert.equal(stage.getState().status, 'disposed');
  assert.equal(
    fixture.log.some(([operation]) => operation === 'vm.start'),
    false,
  );
  assert.equal(fixture.log.filter(([operation]) => operation === 'vm.clear').length, 1);
  assert.equal(dom.mount.children.length, 0);
});

test('rejects unsafe project and stage limits before platform side effects', () => {
  const dom = fakeDocument();
  const fixture = platformFixture();
  const base = {...dom, projectBytes: new Uint8Array([1]), platform: fixture.platform};
  assert.throws(
    () =>
      createDsl4BrowserTurboWarpStage({
        ...base,
        maxProjectBytes: dsl4BrowserTurboWarpStageMaximumProjectBytes + 1,
      }),
    /maxProjectBytes/u,
  );
  assert.throws(
    () => createDsl4BrowserTurboWarpStage({...base, stageWidth: 4096, stageHeight: 4096}),
    /4194304/u,
  );
  assert.throws(
    () => createDsl4BrowserTurboWarpStage({...base, projectBytes: new Uint8Array()}),
    /projectBytes/u,
  );
  const stage = createDsl4BrowserTurboWarpStage(base);
  assert.throws(() => stage.resetManagedPresentation(), /not ready/u);
  assert.deepEqual(fixture.log, []);
});
