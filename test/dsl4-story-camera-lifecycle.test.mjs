import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDsl4StoryCameraLifecycle,
  storyUsesPoseRecognition,
} from '../src/dsl4/platform/story-camera-lifecycle.js';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {promise, resolve};
}

function story(...commands) {
  return {
    kind: 'StoryDocument',
    version: '4.0',
    scenes: [{id: 'opening', actions: commands.map((command) => ({command, args: {}}))}],
  };
}

function cameraFixture({startGate = null} = {}) {
  const log = [];
  let cameraRunning = false;
  let previewVisible = true;
  let recognizing = false;
  return {
    log,
    composition: {
      async startCamera() {
        assert.equal(previewVisible, false, 'camera startup must not expose the default preview');
        log.push('camera.start');
        await startGate?.promise;
        cameraRunning = true;
      },
      stopCamera() {
        log.push('camera.stop');
        cameraRunning = false;
      },
      isCameraRunning: () => cameraRunning,
      hidePreview() {
        log.push('preview.hide');
        previewVisible = false;
      },
      isPreviewVisible: () => previewVisible,
      setPreviewOpacity(opacity) {
        log.push(`preview.opacity:${opacity}`);
      },
      setPreviewPosition(position) {
        log.push(`preview.position:${position}`);
      },
      stopRecognition() {
        log.push('recognition.stop');
        recognizing = false;
      },
      isRecognizing: () => recognizing,
    },
  };
}

test('detects only story actions that consume pose recognition', () => {
  assert.equal(storyUsesPoseRecognition(story('wait', 'pose')), true);
  assert.equal(storyUsesPoseRecognition(story('poseInputToChangeScene')), true);
  assert.equal(storyUsesPoseRecognition(story('wait', 'show')), false);
  assert.equal(
    storyUsesPoseRecognition({
      ...story('wait'),
      poseRecognition: {preview: {mirroring: 'mirrored'}},
    }),
    false,
  );
});

test('starts one camera without showing preview and keeps it across repeated claims', async () => {
  const fixture = cameraFixture();
  const busy = [];
  const lifecycle = createDsl4StoryCameraLifecycle({
    composition: fixture.composition,
    setBusy: (event) => busy.push(event.visible),
  });

  assert.equal(await lifecycle.start(), true);
  assert.equal(await lifecycle.start(), true);
  assert.deepEqual(fixture.log, [
    'preview.hide',
    'preview.opacity:0.2',
    'preview.position:full-stage',
    'camera.start',
  ]);
  assert.deepEqual(busy, [true, false]);

  assert.equal(await lifecycle.stop(), false);
  assert.deepEqual(fixture.log, [
    'preview.hide',
    'preview.opacity:0.2',
    'preview.position:full-stage',
    'camera.start',
    'camera.stop',
  ]);
});

test('stops a camera that finishes starting after the story has ended', async () => {
  const startGate = deferred();
  const fixture = cameraFixture({startGate});
  const lifecycle = createDsl4StoryCameraLifecycle({composition: fixture.composition});

  const starting = lifecycle.start();
  while (!fixture.log.includes('camera.start')) await Promise.resolve();
  assert.deepEqual(fixture.log, [
    'preview.hide',
    'preview.opacity:0.2',
    'preview.position:full-stage',
    'camera.start',
  ]);
  const stopping = lifecycle.stop();
  startGate.resolve();

  assert.equal(await starting, false);
  assert.equal(await stopping, false);
  assert.deepEqual(fixture.log, [
    'preview.hide',
    'preview.opacity:0.2',
    'preview.position:full-stage',
    'camera.start',
    'camera.stop',
  ]);
});

test('stops preview, recognition, and camera exactly once during disposal', async () => {
  const fixture = cameraFixture();
  let cameraRunning = true;
  let previewVisible = true;
  let recognizing = true;
  fixture.composition.isCameraRunning = () => cameraRunning;
  fixture.composition.isPreviewVisible = () => previewVisible;
  fixture.composition.isRecognizing = () => recognizing;
  fixture.composition.stopCamera = () => {
    fixture.log.push('camera.stop');
    cameraRunning = false;
  };
  fixture.composition.hidePreview = () => {
    fixture.log.push('preview.hide');
    previewVisible = false;
  };
  fixture.composition.stopRecognition = () => {
    fixture.log.push('recognition.stop');
    recognizing = false;
  };
  const lifecycle = createDsl4StoryCameraLifecycle({composition: fixture.composition});

  const first = lifecycle.dispose();
  const second = lifecycle.dispose();
  assert.strictEqual(second, first);
  assert.equal(await first, false);
  assert.deepEqual(fixture.log, ['preview.hide', 'recognition.stop', 'camera.stop']);
  await assert.rejects(lifecycle.start(), /disposed/u);
});
