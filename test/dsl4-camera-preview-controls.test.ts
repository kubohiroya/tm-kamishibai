import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4CameraPreviewControls} from '../src/dsl4/platform/index.js';
import {createFakeDocument, type FakeElement} from './helpers/fake-dom.ts';
import {deferred} from './helpers/async-test-helpers.ts';
import {requireDefined, requireRecord, requireString} from './helpers/require-value.ts';
import {thrown} from './helpers/thrown-error.ts';

/** One camera device the fake port lists. */
interface CameraDevice {
  deviceId: string;
  label: string;
}

function findByDataset(root: FakeElement, key: string, value: string): FakeElement | null {
  if (root.dataset[key] === value) return root;
  for (const child of root.children) {
    const found = findByDataset(child, key, value);
    if (found) return found;
  }
  return null;
}

/** Take the control a case drives, failing by name when the tree does not carry it. */
function requireByDataset(root: FakeElement, key: string, value: string): FakeElement {
  return requireDefined(findByDataset(root, key, value), `the ${key}="${value}" control`);
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

function fixture(overrides: Record<string, unknown> = {}) {
  const document = createFakeDocument();
  let cameraRunning = false;
  let rect = {left: 20, top: 40, width: 320, height: 180, visible: true};
  let mirroring = 'mirrored';
  let cameraSelection: unknown = 'default';
  let activeCamera: CameraDevice | null = null;
  let cameraDevices: CameraDevice[] | Promise<CameraDevice[]> = [
    {deviceId: 'opaque-a', label: '<Camera A>'},
    {deviceId: 'opaque-b', label: ''},
  ];
  let failMirroring = false;
  let failCamera = false;
  let failCameraList = false;
  const calls: unknown[][] = [];
  const scheduled: (() => void)[] = [];
  const renderer = createDsl4CameraPreviewControls({
    container: document.body,
    preview: {
      mirroring: 'mirrored',
      controls: {
        mirroring: {
          position: 'top-center',
          opacity: 0.8,
          assets: {showMirrored: 'ShowMirrored', showUnmirrored: 'ShowUnmirrored'},
        },
        cameraMenu: {position: 'top-center', opacity: 0.6, buttonAsset: 'CameraMenu'},
      },
    },
    assetUrls: {
      ShowMirrored: 'blob:show-mirrored',
      ShowUnmirrored: 'blob:show-unmirrored',
      CameraMenu: 'blob:camera-menu',
    },
    port: {
      isCameraRunning: () => cameraRunning,
      async setPreviewMirroring(next: string) {
        calls.push(['mirror', next]);
        if (failMirroring) throw new Error('mirror failed');
        mirroring = next;
      },
      async listCameraDevices() {
        calls.push(['list']);
        if (failCameraList) throw new Error('camera list failed');
        return cameraDevices;
      },
      async selectCamera(next: unknown) {
        calls.push(['select', next]);
        if (failCamera) throw new Error('camera failed');
        cameraSelection = next;
      },
      getCameraSelection: () => cameraSelection,
      getActiveCamera: () => activeCamera,
    },
    getPreviewRect: () => rect,
    labels: {
      mirroring: '左右反転を切り替える',
      cameraMenu: 'カメラを選ぶ',
      default: '標準',
      front: '前面',
      back: '背面',
      detectedCamera: 'カメラ',
      currentCamera: '現在のカメラ',
    },
    schedule(callback: () => void) {
      scheduled.push(callback);
      return () => {
        const index = scheduled.indexOf(callback);
        if (index >= 0) scheduled.splice(index, 1);
      };
    },
    onError(error: unknown, context: Readonly<Record<string, string>>) {
      calls.push(['error', context.operation, requireString(thrown(error).message, 'its message')]);
    },
    ...overrides,
  });
  return {
    calls,
    document,
    renderer,
    setCameraRunning(value: boolean) {
      cameraRunning = value;
    },
    setRect(value: typeof rect) {
      rect = value;
    },
    setFailMirroring(value: boolean) {
      failMirroring = value;
    },
    setFailCamera(value: boolean) {
      failCamera = value;
    },
    setFailCameraList(value: boolean) {
      failCameraList = value;
    },
    setCameraDevices(value: CameraDevice[] | Promise<CameraDevice[]>) {
      cameraDevices = value;
    },
    setCameraSelection(value: unknown) {
      cameraSelection = value;
    },
    setActiveCamera(value: CameraDevice | null) {
      activeCamera = value;
    },
    get cameraSelection() {
      return cameraSelection;
    },
    get mirroring() {
      return mirroring;
    },
  };
}

test('anchors deterministic accessible controls and follows preview/camera/story lifecycle', () => {
  const setup = fixture();
  const group = requireByDataset(setup.document.body, 'dsl4PreviewControlAnchor', 'top-center');
  const mirror = requireByDataset(setup.document.body, 'dsl4PreviewControl', 'mirroring');
  const camera = requireByDataset(setup.document.body, 'dsl4PreviewControl', 'cameraMenu');
  assert.deepEqual(group.children.slice(0, 2), [mirror, camera]);
  assert.equal(mirror.getAttribute('aria-label'), '左右反転を切り替える');
  assert.equal(camera.getAttribute('aria-label'), 'カメラを選ぶ');
  assert.equal(mirror.type, 'button');
  assert.equal(mirror.style.opacity, '0.8');
  assert.equal(camera.style.opacity, '0.6');

  setup.renderer.start();
  assert.equal(group.style.display, 'none');
  assert.equal(mirror.listeners.get('click')?.length ?? 0, 0);
  setup.setCameraRunning(true);
  setup.renderer.refresh();
  assert.equal(group.style.display, 'flex');
  assert.equal(group.style.left, '180px');
  assert.equal(group.style.top, '40px');
  assert.equal(group.style.transform, 'translate(-50%, -100%)');
  assert.equal(requireDefined(mirror.listeners.get('click'), 'its click listeners').length, 1);
  setup.renderer.setMirroring('unmirrored');
  assert.equal(requireDefined(mirror.children[0], 'its icon').src, 'blob:show-mirrored');

  setup.setRect({left: 100, top: 80, width: 640, height: 360, visible: true});
  setup.renderer.refresh();
  assert.equal(group.style.left, '420px');
  assert.equal(group.style.top, '80px');

  setup.setCameraRunning(false);
  setup.renderer.refresh();
  assert.equal(group.style.display, 'none');
  assert.equal(mirror.listeners.get('click')?.length ?? 0, 0);
  setup.renderer.dispose();
  assert.equal(group.parentNode, null);
});

test('publishes and releases real camera-control geometry through the shared layout bridge', () => {
  const layoutCalls: unknown[][] = [];
  const setup = fixture({
    previewLayout: {
      registerReservedRect(owner: string, rect: unknown) {
        layoutCalls.push(['register', owner, rect]);
      },
      updateReservedRect(owner: string, rect: unknown) {
        layoutCalls.push(['update', owner, rect]);
      },
      unregisterReservedRect(owner: string) {
        layoutCalls.push(['unregister', owner]);
      },
    },
  });
  const group = requireByDataset(setup.document.body, 'dsl4PreviewControlAnchor', 'top-center');
  group.setBoundingClientRect({x: 588, y: 8, width: 96, height: 44});
  setup.setCameraRunning(true);
  setup.renderer.start();
  assert.deepEqual(layoutCalls[0], [
    'register',
    'camera-controls-top-center',
    {x: 588, y: 8, width: 96, height: 44},
  ]);

  group.setBoundingClientRect({x: 500, y: 12, width: 120, height: 44});
  setup.renderer.refresh();
  assert.deepEqual(layoutCalls[1], [
    'update',
    'camera-controls-top-center',
    {x: 500, y: 12, width: 120, height: 44},
  ]);
  setup.renderer.stop();
  assert.deepEqual(layoutCalls.at(-1), ['unregister', 'camera-controls-top-center']);
  setup.renderer.dispose();
});

test('stops fail-safe without consulting unavailable preview providers', () => {
  let previewReads = 0;
  const setup = fixture({
    getPreviewRect() {
      previewReads += 1;
      return {left: 20, top: 40, width: 320, height: 180, visible: true};
    },
    schedule() {
      return () => {
        throw new Error('schedule cancellation failed');
      };
    },
  });
  setup.setCameraRunning(true);
  const group = requireByDataset(setup.document.body, 'dsl4PreviewControlAnchor', 'top-center');
  const mirror = requireByDataset(setup.document.body, 'dsl4PreviewControl', 'mirroring');

  setup.renderer.start();
  assert.equal(previewReads, 1);
  assert.equal(group.style.display, 'flex');
  assert.equal(requireDefined(mirror.listeners.get('click'), 'its click listeners').length, 1);

  assert.throws(() => setup.renderer.stop(), /schedule cancellation failed/u);
  assert.equal(previewReads, 1);
  assert.equal(group.style.display, 'none');
  assert.equal(mirror.listeners.get('click')?.length ?? 0, 0);

  setup.renderer.dispose();
  assert.equal(group.parentNode, null);
});

test('commits target-state mirroring icon only after upstream success', async () => {
  const setup = fixture();
  setup.setCameraRunning(true);
  setup.renderer.start();
  const mirror = requireByDataset(setup.document.body, 'dsl4PreviewControl', 'mirroring');
  const image = requireDefined(mirror.children[0], 'its icon');
  assert.equal(image.src, 'blob:show-unmirrored');

  mirror.click();
  assert.equal(image.src, 'blob:show-unmirrored');
  await settle();
  assert.equal(setup.mirroring, 'unmirrored');
  assert.equal(image.src, 'blob:show-mirrored');

  setup.setFailMirroring(true);
  mirror.click();
  await settle();
  assert.equal(setup.mirroring, 'unmirrored');
  assert.equal(image.src, 'blob:show-mirrored');
  assert.ok(
    setup.calls.some((entry) => entry[0] === 'error' && entry[1] === 'setPreviewMirroring'),
  );
  setup.renderer.dispose();
});

test('re-enumerates each open, keeps device IDs session-only, and rolls UI selection back', async () => {
  const setup = fixture();
  setup.setCameraRunning(true);
  setup.renderer.start();
  const camera = requireByDataset(setup.document.body, 'dsl4PreviewControl', 'cameraMenu');
  const menu = requireByDataset(setup.document.body, 'dsl4PreviewCameraMenu', 'true');

  camera.click();
  await settle();
  assert.equal(menu.hidden, false);
  assert.deepEqual(
    menu.children.map(({value, textContent}) => [value, textContent]),
    [
      ['default', '標準'],
      ['front', '前面'],
      ['back', '背面'],
      ['device:1', '<Camera A>'],
      ['device:2', 'カメラ 2'],
    ],
  );
  assert.equal(
    menu.children.some(({value}) => value.includes('opaque-a')),
    false,
  );
  menu.value = 'device:1';
  menu.dispatch('change');
  await settle();
  assert.ok(
    setup.calls.some(
      (entry) =>
        entry[0] === 'select' &&
        requireRecord(entry[1], 'the selected camera').deviceId === 'opaque-a',
    ),
  );

  camera.click();
  await settle();
  assert.equal(setup.calls.filter(([name]) => name === 'list').length, 2);
  setup.setFailCamera(true);
  menu.value = 'back';
  menu.dispatch('change');
  await settle();
  assert.equal(menu.value, 'device:1');
  assert.ok(setup.calls.some((entry) => entry[0] === 'error' && entry[1] === 'selectCamera'));
  setup.renderer.dispose();
});

test('keeps a missing active physical camera selected and rolls back to it on switch failure', async () => {
  const setup = fixture();
  setup.setCameraSelection({deviceId: 'opaque-old'});
  setup.setActiveCamera({deviceId: 'opaque-old', label: 'Previously active'});
  setup.setCameraDevices([{deviceId: 'opaque-new', label: 'New camera'}]);
  setup.setCameraRunning(true);
  setup.renderer.start();
  const camera = requireByDataset(setup.document.body, 'dsl4PreviewControl', 'cameraMenu');
  const menu = requireByDataset(setup.document.body, 'dsl4PreviewCameraMenu', 'true');

  camera.click();
  await settle();
  assert.deepEqual(
    menu.children.map(({value, textContent}) => [value, textContent]),
    [
      ['default', '標準'],
      ['front', '前面'],
      ['back', '背面'],
      ['device:1', 'New camera'],
      ['device:current', 'Previously active'],
    ],
  );
  assert.equal(menu.value, 'device:current');
  assert.equal(
    menu.children.some(({value}) => value.includes('opaque-old')),
    false,
  );

  setup.setFailCamera(true);
  menu.value = 'back';
  menu.dispatch('change');
  await settle();
  assert.equal(menu.value, 'device:current');
  assert.deepEqual(setup.cameraSelection, {deviceId: 'opaque-old'});
  setup.renderer.dispose();
});

test('clears and hides stale camera choices before re-enumeration and after failure', async () => {
  const setup = fixture();
  setup.setCameraRunning(true);
  setup.renderer.start();
  const camera = requireByDataset(setup.document.body, 'dsl4PreviewControl', 'cameraMenu');
  const menu = requireByDataset(setup.document.body, 'dsl4PreviewCameraMenu', 'true');

  camera.click();
  await settle();
  assert.equal(menu.hidden, false);
  assert.equal(menu.children.length, 5);

  setup.setFailCameraList(true);
  const selectionCallCount = setup.calls.filter(([name]) => name === 'select').length;
  camera.click();
  assert.equal(menu.hidden, true);
  assert.equal(menu.children.length, 0);
  await settle();
  assert.equal(menu.hidden, true);
  assert.equal(menu.children.length, 0);
  assert.ok(setup.calls.some((entry) => entry[0] === 'error' && entry[1] === 'listCameraDevices'));

  menu.value = 'device:1';
  menu.dispatch('change');
  await settle();
  assert.equal(setup.calls.filter(([name]) => name === 'select').length, selectionCallCount);
  setup.renderer.dispose();
});

test('does not restore a pending camera menu after the camera lifecycle stops', async () => {
  const listing = deferred<CameraDevice[]>();
  const setup = fixture();
  setup.setCameraDevices(listing.promise);
  setup.setCameraRunning(true);
  setup.renderer.start();
  const camera = requireByDataset(setup.document.body, 'dsl4PreviewControl', 'cameraMenu');
  const menu = requireByDataset(setup.document.body, 'dsl4PreviewCameraMenu', 'true');

  camera.click();
  assert.equal(menu.hidden, true);
  setup.setCameraRunning(false);
  setup.renderer.refresh();
  listing.resolve([{deviceId: 'late-camera', label: 'Late camera'}]);
  await settle();
  assert.equal(menu.hidden, true);
  assert.equal(menu.children.length, 0);
  setup.renderer.dispose();
});
