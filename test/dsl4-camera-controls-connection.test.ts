import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {test, vi} from 'vitest';
import {createDsl4RuntimeExtensionSource} from '../scripts/sb3/dsl4-downloadable-release.ts';
import {
  connectDsl4TitleCameraControls,
  readDsl4CameraControlsSource,
  type Dsl4CameraControlsSource,
} from '../src/dsl4/platform/camera-controls-connection.js';
import type {Dsl4CameraControlsController} from '../src/dsl4/platform/camera-preview-controls.js';
import {createFakeDocument, findByAttribute} from './helpers/fake-dom.ts';

const require = createRequire(import.meta.url);
const VirtualMachine = require('scratch-vm');
let entrySource: Promise<Buffer> | undefined;

function controls() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    refresh: vi.fn(),
    setMirroring: vi.fn(),
    dispose: vi.fn(),
  };
}

interface Entry {
  frontend: unknown;
  status: string;
  cameraControls: Dsl4CameraControlsController | null;
  cameraPermissionGate: unknown;
  ensureCameraPermissionGate(locale: 'ja' | 'en'): void;
  hideScratchTitle(): void;
  stop(reason: string): Promise<void>;
  cameraPreviewControlOptions(): {
    createControls?: (options: {
      port: unknown;
      labels: Record<string, string>;
      mirroring: string;
    }) => Dsl4CameraControlsController;
  };
}

async function createEntry({supported = true} = {}) {
  entrySource ??= createDsl4RuntimeExtensionSource({profile: 'playback'});
  const source = await entrySource;
  const vm = new VirtualMachine();
  const document = createFakeDocument();
  const microtasks: Array<() => void> = [];
  const registrations: Entry[] = [];
  const errors: unknown[] = [];
  const Scratch = {
    vm,
    BlockType: require('scratch-vm/src/extension-support/block-type'),
    ArgumentType: require('scratch-vm/src/extension-support/argument-type'),
    translate: Object.assign((text: unknown) => text, {language: 'ja'}),
    extensions: {unsandboxed: true, register: (entry: Entry) => registrations.push(entry)},
  };
  runInNewContext(source.toString(), {
    Scratch,
    document,
    queueMicrotask: (callback: () => void) => microtasks.push(callback),
    ...(supported ? {HTMLUserMediaElement: class {}} : {}),
    console: {
      warn: (...items: unknown[]) => errors.push(items),
      error: (...items: unknown[]) => errors.push(items),
    },
    TextEncoder,
    TextDecoder,
    URL,
    atob,
    btoa,
    setTimeout,
    clearTimeout,
  });
  const entry = registrations[0];
  assert(entry, 'the real runtime entry registers synchronously');
  // Isolate the camera policy from the parser; the real source frontend returns storyDocument.
  entry.frontend = {
    parse: () => ({
      ok: true,
      storyDocument: {scenes: [{id: 'pose', actions: [{command: 'pose'}]}]},
    }),
  };
  vm.runtime.extensionStorage = {
    kubohiroyakamishibairuntime4: {source: {text: 'camera policy fixture'}},
  };
  return {
    vm,
    document,
    entry,
    errors,
    flush: () => microtasks.splice(0).forEach((callback) => callback()),
  };
}

test('promotes an earlier permission fallback after the later static bundle member registers', async () => {
  const fixture = await createEntry();
  const controller = controls();
  const refreshedController = controls();
  const register = vi.fn(
    (_options: Parameters<Dsl4CameraControlsSource['registerCameraControls']>[0]) => controller,
  );
  try {
    fixture.entry.ensureCameraPermissionGate('ja');
    assert.equal(
      findByAttribute(fixture.document.body, 'data-dsl4-user-media-gate', 'true').length,
      1,
    );
    fixture.vm.runtime.ext_kubohiroyacamerasource = {registerCameraControls: register};
    fixture.flush();
    assert.equal(fixture.entry.cameraControls, controller);
    assert.equal(
      findByAttribute(fixture.document.body, 'data-dsl4-user-media-gate', 'true').length,
      0,
    );
    assert.deepEqual(
      {...register.mock.calls[0]?.[0]},
      {owner: 'kamishibai-title', cameraId: 'pose', locale: 'ja'},
    );
    fixture.entry.ensureCameraPermissionGate('en');
    assert.equal(
      register.mock.calls.length,
      1,
      'repeated title checks must not duplicate controls',
    );
    register.mockReturnValue(refreshedController);
    fixture.vm.runtime.emit('PROJECT_LOADED');
    assert.equal(controller.dispose.mock.calls.length, 1);
    assert.equal(
      fixture.entry.cameraControls,
      null,
      'the GUI has discarded the previous project handle',
    );
    fixture.flush();
    assert.equal(register.mock.calls.length, 2, 'the GUI project reset requires a fresh provider');
    assert.equal(fixture.entry.cameraControls, refreshedController);
    assert.equal(controller.start.mock.calls.length, 1);
    await fixture.entry.stop('test');
    assert.equal(refreshedController.dispose.mock.calls.length, 1);
    fixture.entry.status = 'title';
    fixture.entry.ensureCameraPermissionGate('en');
    assert.equal(register.mock.calls.length, 3, 'the next title can register after stopping');
  } finally {
    await fixture.entry.stop('test-cleanup');
    fixture.vm.quit();
  }
});

test('does not recreate camera UI when the title closes before the dependency retry', async () => {
  const fixture = await createEntry();
  const register = vi.fn(() => controls());
  try {
    fixture.entry.ensureCameraPermissionGate('ja');
    fixture.vm.runtime.emit('PROJECT_LOADED');
    fixture.entry.hideScratchTitle();
    fixture.vm.runtime.ext_kubohiroyacamerasource = {registerCameraControls: register};
    fixture.flush();
    assert.equal(register.mock.calls.length, 0);
    assert.equal(fixture.entry.cameraPermissionGate, null);
  } finally {
    fixture.vm.quit();
  }
});

test('removes the previous camera entry when the next project has no pose actions', async () => {
  const fixture = await createEntry();
  const controller = controls();
  const register = vi.fn(() => controller);
  try {
    fixture.vm.runtime.ext_kubohiroyacamerasource = {registerCameraControls: register};
    fixture.flush();
    assert.equal(register.mock.calls.length, 1);
    fixture.entry.frontend = {
      parse: () => ({
        ok: true,
        storyDocument: {scenes: [{id: 'plain', actions: [{command: 'wait'}]}]},
      }),
    };
    fixture.vm.runtime.emit('PROJECT_LOADED');
    fixture.flush();
    assert.equal(controller.dispose.mock.calls.length, 1);
    assert.equal(register.mock.calls.length, 1);
    assert.equal(fixture.entry.cameraControls, null);
    assert.equal(fixture.entry.cameraPermissionGate, null);
  } finally {
    fixture.vm.quit();
  }
});

test('lets current Camera Source controls describe an unsupported browser without the legacy gate', async () => {
  const fixture = await createEntry({supported: false});
  const controller = controls();
  try {
    fixture.vm.runtime.ext_kubohiroyacamerasource = {registerCameraControls: () => controller};
    fixture.flush();
    assert.equal(fixture.entry.cameraControls, controller);
    assert.equal(fixture.entry.cameraPermissionGate, null);
  } finally {
    await fixture.entry.stop('test-cleanup');
    fixture.vm.quit();
  }
});

test('retains fallback and ownership on absent/null/throwing controls and can retry', async () => {
  const fixture = await createEntry();
  const controller = controls();
  try {
    fixture.entry.ensureCameraPermissionGate('ja');
    const fallback = fixture.entry.cameraPermissionGate;
    assert(fallback);
    fixture.vm.runtime.ext_kubohiroyacamerasource = {registerCameraControls: () => null};
    fixture.flush();
    assert.equal(fixture.entry.cameraPermissionGate, fallback);
    fixture.vm.runtime.ext_kubohiroyacamerasource = {
      registerCameraControls: () => {
        throw new Error('not ready');
      },
    };
    fixture.entry.ensureCameraPermissionGate('ja');
    assert.equal(fixture.entry.cameraPermissionGate, fallback);
    fixture.vm.runtime.ext_kubohiroyacamerasource = {registerCameraControls: () => controller};
    fixture.entry.ensureCameraPermissionGate('ja');
    assert.equal(fixture.entry.cameraPermissionGate, null);
    const port = {isCameraRunning: () => true};
    const register = vi.fn(
      (_options: Parameters<Dsl4CameraControlsSource['registerCameraControls']>[0]) => controller,
    );
    fixture.vm.runtime.ext_kubohiroyacamerasource = {registerCameraControls: register};
    fixture.entry
      .cameraPreviewControlOptions()
      .createControls?.({port, labels: {}, mirroring: 'mirrored'});
    assert.equal(
      register.mock.calls[0]?.[0].port,
      port,
      'preview uses the same public source with its existing camera port',
    );
  } finally {
    await fixture.entry.stop('test-cleanup');
    fixture.vm.quit();
  }
});

test('cleans a failed replacement without disposing the fallback or acquiring a camera', () => {
  const controller = controls();
  controller.start.mockImplementation(() => {
    throw new Error('start failed');
  });
  const fallbackDispose = vi.fn();
  const onError = vi.fn();
  const source = {registerCameraControls: vi.fn(() => controller)};
  assert.equal(readDsl4CameraControlsSource({ext_kubohiroyacamerasource: source}), source);
  assert.equal(
    connectDsl4TitleCameraControls({
      source,
      locale: 'ja',
      disposeFallback: fallbackDispose,
      onError,
    }),
    null,
  );
  assert.equal(controller.dispose.mock.calls.length, 1);
  assert.equal(fallbackDispose.mock.calls.length, 0);
  assert.equal(onError.mock.calls.length, 1);
  assert.equal(readDsl4CameraControlsSource(null), null);
  assert.equal(readDsl4CameraControlsSource({ext_kubohiroyacamerasource: {}}), null);
});

test('contains throwing optional host getters and fallback cleanup without losing the new controller', () => {
  const runtime = Object.defineProperty({}, 'ext_kubohiroyacamerasource', {
    get() {
      throw new Error('host unavailable');
    },
  });
  assert.equal(readDsl4CameraControlsSource(runtime), null);
  const badSource = Object.defineProperty({}, 'registerCameraControls', {
    get() {
      throw new Error('host unavailable');
    },
  });
  assert.equal(readDsl4CameraControlsSource({ext_kubohiroyacamerasource: badSource}), null);
  const controller = controls();
  const onError = vi.fn();
  assert.equal(
    connectDsl4TitleCameraControls({
      source: {registerCameraControls: () => controller},
      locale: 'ja',
      disposeFallback() {
        throw new Error('fallback cleanup failed');
      },
      onError,
    }),
    null,
  );
  assert.equal(controller.dispose.mock.calls.length, 1);
  assert.equal(onError.mock.calls.length, 1);
});

test('contains a late fallback failure inside the queued dependency retry', async () => {
  const fixture = await createEntry();
  try {
    fixture.document.createElement = () => {
      throw new Error('detached host');
    };
    assert.doesNotThrow(() => fixture.flush());
    assert.equal(fixture.errors.length, 1);
  } finally {
    fixture.vm.quit();
  }
});
