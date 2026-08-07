import assert from 'node:assert/strict';
import test from 'node:test';

import {createDsl4BrowserTurboWarpPlatform} from '../src/dsl4/index.js';

test('TurboWarp browser platform wires exact constructors and releases browser resources', async () => {
  const created = [];
  class VirtualMachine {
    constructor() {
      created.push(['vm', []]);
    }
  }
  class Renderer {
    constructor(...args) {
      created.push(['renderer', args]);
    }
  }
  class AudioEngine {
    constructor() {
      created.push(['audio', []]);
    }
  }
  class Storage {
    constructor() {
      created.push(['storage', []]);
    }
  }
  class BitmapAdapter {
    constructor() {
      created.push(['bitmap', []]);
    }
  }
  const platform = createDsl4BrowserTurboWarpPlatform({
    VirtualMachine,
    Renderer,
    AudioEngine,
    Storage,
    BitmapAdapter,
  });
  const canvas = {};
  platform.createVm();
  platform.createRenderer(canvas);
  platform.createAudioEngine();
  platform.createStorage();
  platform.createBitmapAdapter();
  assert.deepEqual(created, [
    ['vm', []],
    ['renderer', [canvas]],
    ['audio', []],
    ['storage', []],
    ['bitmap', []],
  ]);

  let disconnected = 0;
  let audioClosed = 0;
  let contextLost = 0;
  await platform.disposeAudioEngine({
    inputNode: {disconnect: () => (disconnected += 1)},
    audioContext: {state: 'running', close: async () => (audioClosed += 1)},
  });
  platform.disposeRenderer({
    _gl: {getExtension: () => ({loseContext: () => (contextLost += 1)})},
  });
  assert.deepEqual(
    {disconnected, audioClosed, contextLost},
    {disconnected: 1, audioClosed: 1, contextLost: 1},
  );
});

test('TurboWarp browser platform validates every pinned component before allocation', () => {
  const components = {
    VirtualMachine: class {},
    Renderer: class {},
    AudioEngine: class {},
    Storage: class {},
    BitmapAdapter: class {},
  };
  for (const name of Object.keys(components)) {
    assert.throws(
      () => createDsl4BrowserTurboWarpPlatform({...components, [name]: null}),
      new RegExp(name.replace('VirtualMachine', 'VirtualMachine')),
    );
  }
});
