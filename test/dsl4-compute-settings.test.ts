import assert from 'node:assert/strict';
import {test} from 'vitest';
import {
  createDsl4ComputePreferences,
  requireDsl4ComputeMode,
} from '../src/dsl4/platform/compute-settings.js';
import {createDsl4TMPlatform} from '../src/dsl4/platform/tm-model-adapter.js';

test('uses a valid device override and rejects unknown modes before changing the preference', () => {
  const values = new Map([['kamishibai.recognition.computeMode', 'wasm']]);
  const globalObject = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    },
  };
  const preferences = createDsl4ComputePreferences({initialMode: 'webgpu', globalObject});
  assert.equal(preferences.getMode(), 'wasm');
  preferences.setMode('cpu');
  assert.equal(createDsl4ComputePreferences({globalObject}).getMode(), 'cpu');
  assert.throws(() => preferences.setMode('was'), /computeMode/);
  assert.equal(preferences.getMode(), 'cpu');
  values.set('kamishibai.recognition.computeMode', 'obsolete');
  assert.equal(
    createDsl4ComputePreferences({initialMode: 'webgpu', globalObject}).getMode(),
    'webgpu',
  );
  assert.throws(() => requireDsl4ComputeMode(null), /computeMode/);
});

test('keeps session selection working when storage access or writes are refused', () => {
  const blocked = createDsl4ComputePreferences({
    globalObject: {
      get localStorage(): Storage {
        throw new Error('storage blocked');
      },
    },
  });
  assert.equal(blocked.getMode(), 'auto');
  assert.equal(blocked.setMode('wasm'), 'wasm');
  const full = createDsl4ComputePreferences({
    globalObject: {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota exceeded');
        },
      },
    },
  });
  assert.equal(full.setMode('webgpu'), 'webgpu');
});

test('forwards the controller and requested mode without switching an existing model backend', () => {
  const selection = {
    mode: 'wasm',
    requested: 'wasm',
    backend: 'cpu',
    fallback: true,
    attempts: [],
  } as const;
  const calls: unknown[] = [];
  const compute = {
    select: async () => {
      calls.push('select');
      return selection;
    },
    getSelection: () => selection,
    getBackend: () => selection.backend,
  };
  let received: unknown;
  const platform = createDsl4TMPlatform({
    runtime: {Webcam: class {}, loadFromFiles() {}},
    compute,
    computeMode: 'wasm',
    createComposition(options: unknown) {
      received = options;
      return {registerPoseModel() {}, releasePoseModel() {}};
    },
  });
  assert.equal(typeof platform.adapter.prepare, 'function');
  assert.equal((received as {compute: unknown}).compute, compute);
  assert.equal((received as {computeMode: string}).computeMode, 'wasm');
  assert.deepEqual(calls, []);
});

test('opens from the stage-controls API without adding an entry to the artwork', async () => {
  const {createFakeDocument} = await import('./helpers/fake-dom.ts');
  const {createDsl4ComputeSettings} = await import('../src/dsl4/platform/compute-settings.js');
  const document = createFakeDocument();
  const artwork = document.createElement('div');
  document.body.appendChild(artwork);
  let click = () => {};
  let disposed = false;
  let placements = 0;
  let focused = 0;
  const state: Record<string, unknown> = {};
  const preferences = createDsl4ComputePreferences();
  const settings = createDsl4ComputeSettings({
    document: document as unknown as Document,
    stageControls: {
      addButton(options) {
        assert.equal(options.id, 'kamishibai-recognition-compute');
        assert.equal(options.text, 'Teachable Machine');
        assert.match(options.label, /Teachable Machine.*Auto/u);
        click = options.onClick;
        return {
          update(value) {
            Object.assign(state, value);
          },
          focus() {
            focused++;
          },
          dispose() {
            disposed = true;
          },
          placePanel() {
            placements++;
          },
        };
      },
    },
    getLocale: () => 'ja',
    preferences,
    getSelection: () => ({backend: 'cpu', fallback: true}),
    onApply: (mode) => {
      preferences.setMode(mode);
    },
    onClose() {},
  });
  assert.equal(state.visible, true);
  assert.equal(artwork.children.length, 0);
  click();
  assert.equal(state.expanded, true);
  assert.equal(placements, 1);
  const root = settings.element as unknown as import('./helpers/fake-dom.ts').FakeElement;
  assert.equal(root.parentNode, document.body);
  const descendants = (
    node: import('./helpers/fake-dom.ts').FakeElement,
  ): import('./helpers/fake-dom.ts').FakeElement[] => [node, ...node.children.flatMap(descendants)];
  const select = descendants(root).find((element) => element.tagName === 'SELECT');
  assert(select);
  assert.equal(select.value, 'auto');
  assert.deepEqual(
    select.children.map((option) => option.value),
    ['auto', 'webgpu', 'wasm', 'cpu'],
  );
  assert(descendants(root).some((element) => element.textContent.includes('代替方式')));
  select.value = 'wasm';
  const apply = descendants(root).find((element) => element.dataset.dsl4ComputeApply === 'true');
  assert(apply);
  apply.click();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(preferences.getMode(), 'wasm');
  assert.equal(state.expanded, false);
  assert.match(String(state.label), /WASM/u);
  assert.equal(root.style.display, 'none');
  assert.equal(focused, 1);
  settings.dispose();
  assert.equal(disposed, true);
  assert.equal(root.parentNode, null);
  assert.equal(document.listenerCount('fullscreenchange'), 0);
  assert.equal(document.listenerCount('pointerdown'), 0);
});
