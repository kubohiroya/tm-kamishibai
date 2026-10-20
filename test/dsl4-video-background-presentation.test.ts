import assert from 'node:assert/strict';
import {test} from 'vitest';
import {createDsl4VideoBackgroundPresentation} from '../src/dsl4/platform/video-background-presentation.js';

test('background video owns a bounded texture below sprites and cancels frame callbacks on pause and disposal', () => {
  const frames = new Map<number, () => void>();
  const log: unknown[][] = [];
  let ordinal = 0;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      fillStyle: '',
      fillRect() {},
      drawImage(...args: unknown[]) {
        log.push(['frame', ...args.slice(1)]);
      },
    }),
  };
  const video = Object.assign(new EventTarget(), {
    paused: true,
    ended: false,
    readyState: 2,
    videoWidth: 640,
    videoHeight: 360,
    ownerDocument: {defaultView: null, createElement: () => canvas},
    requestVideoFrameCallback(callback: () => void) {
      const id = ++ordinal;
      frames.set(id, callback);
      return id;
    },
    cancelVideoFrameCallback(id: number) {
      frames.delete(id);
    },
  });
  const renderer = {
    createBitmapSkin: () => 1,
    createDrawable(group: string) {
      log.push(['group', group]);
      return 2;
    },
    updateBitmapSkin() {
      log.push(['upload']);
    },
    destroySkin(id: number) {
      log.push(['destroySkin', id]);
    },
    destroyDrawable(id: number, group: string) {
      log.push(['destroyDrawable', id, group]);
    },
    updateDrawableSkinId() {},
    updateDrawablePosition(_id: number, xy: unknown) {
      log.push(['position', xy]);
    },
    updateDrawableScale() {},
    updateDrawableVisible() {},
    setDrawableOrder() {},
    markDrawableAsNoninteractive() {},
  };
  const presentation = createDsl4VideoBackgroundPresentation({
    renderer,
    element: video as unknown as HTMLVideoElement,
    x: 12,
    y: -10,
    width: 4000,
    height: 3000,
    fit: 'contain',
    onError: (cause) => assert.fail(String(cause)),
  });
  assert.equal(canvas.width, 2048);
  assert.equal(canvas.height, 1536);
  assert.deepEqual(
    log.find(([op]) => op === 'group'),
    ['group', 'video'],
  );
  assert.deepEqual(
    log.find(([op]) => op === 'position'),
    ['position', [12, -10]],
  );
  video.paused = false;
  video.dispatchEvent(new Event('play'));
  assert.equal(frames.size, 1);
  video.dispatchEvent(new Event('seeked'));
  assert.equal(frames.size, 1);
  video.paused = true;
  video.dispatchEvent(new Event('pause'));
  assert.equal(frames.size, 0);
  video.paused = false;
  video.dispatchEvent(new Event('play'));
  presentation.dispose();
  presentation.dispose();
  assert.equal(frames.size, 0);
  assert.equal(log.filter(([op]) => op === 'destroySkin').length, 1);
  assert.equal(log.filter(([op]) => op === 'destroyDrawable').length, 1);
  assert.equal(canvas.width, 0);
  video.dispatchEvent(new Event('play'));
  assert.equal(frames.size, 0);
});
