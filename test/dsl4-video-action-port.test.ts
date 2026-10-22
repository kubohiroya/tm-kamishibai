import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4VideoActionPort} from '../src/dsl4/platform/video-action-port.js';
import {createDsl4VideoAssetAdapter} from '../src/dsl4/platform/video-asset-adapter.js';
import {createDsl4RuntimeController} from '../src/dsl4/runtime-controller.js';
import {resolveDsl4FeatureFlags} from '../src/dsl4/feature-flags.js';
import {dsl4TestSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';

class Video extends EventTarget {
  style: Record<string, string> = {};
  src = '';
  currentTime = 0;
  loop = false;
  muted = false;
  volume = 1;
  playbackRate = 1;
  duration = 60;
  readyState = 1;
  paused = true;
  error: unknown = null;
  loads = 0;
  playFailure: Error | null = null;
  play() {
    if (this.playFailure) return Promise.reject(this.playFailure);
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {
    this.loads += 1;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
}

function fixture() {
  const videos: Video[] = [];
  const overlays = new Set<unknown>();
  const wrappers = new Map<unknown, {style: Record<string, string>}>();
  const errors: unknown[] = [];
  const port = createDsl4VideoActionPort({
    renderer: {
      addOverlay(element: unknown, mode: string) {
        assert.equal(mode, 'scale-centered');
        overlays.add(element);
        const container = {style: {}};
        wrappers.set(element, container);
        return {container};
      },
      removeOverlay(element: unknown) {
        overlays.delete(element);
        wrappers.delete(element);
      },
    },
    createVideo() {
      const video = new Video();
      videos.push(video);
      return video as unknown as HTMLVideoElement;
    },
    getAssetResource: (id) =>
      id === 'Movie'
        ? {kind: 'video', objectUrl: 'blob:movie'}
        : id === 'Shared'
          ? {kind: 'video', objectUrl: 'blob:shared'}
          : null,
    onBackgroundError: (error) => {
      errors.push(error);
    },
  });
  const controller = new AbortController();
  const context = {signal: controller.signal};
  const show = (id = 'movie', source = {asset: 'Movie'} as Record<string, unknown>) =>
    port.video({id, ...source, x: 20, y: 30, width: 320, height: 180}, context);
  return {port, videos, overlays, wrappers, errors, controller, context, show};
}

test('video is disabled by default and requires the runtime', () => {
  assert.equal(resolveDsl4FeatureFlags().dsl4Video, false);
  assert.throws(() => resolveDsl4FeatureFlags({dsl4Video: true}), /requires dsl4Runtime/u);
  assert.equal(resolveDsl4FeatureFlags({dsl4Runtime: true, dsl4Video: true}).dsl4Video, true);
});

test('shows independent named asset and URL rectangles without starting playback', () => {
  const f = fixture();
  f.show();
  f.show('second', {url: 'https://example.com/movie.webm'});
  assert.equal(f.overlays.size, 2);
  assert.equal(f.videos[0]?.src, 'blob:movie');
  assert.equal(f.videos[0]?.style.left, '-140px');
  assert.equal(f.videos[0]?.style.top, '-120px');
  assert.equal(f.videos[0]?.style.objectFit, 'contain');
  assert.equal(f.videos[0]?.paused, true);
  f.port.dispose();
  assert.equal(f.overlays.size, 0);
  assert.ok(f.videos.every((video) => video.src === '' && video.loads === 1));
});

test('orders native overlay wrappers by z-index, using display order for ties and replacements', () => {
  const f = fixture();
  f.show('high', {asset: 'Movie', zIndex: 20});
  f.show('default');
  f.show('behind', {asset: 'Movie', zIndex: -2});
  f.show('equal', {asset: 'Movie', plane: 'front', zIndex: 20});
  const order = () => f.videos.map((video) => f.wrappers.get(video)?.style.zIndex);
  assert.deepEqual(order(), ['2', '1', '0', '3']);
  f.show('high', {asset: 'Movie', zIndex: 20});
  assert.deepEqual(order(), [undefined, '1', '0', '2', '3']);
  assert.equal(f.overlays.size, 4);
  const saved = f.port.captureState();
  assert.equal(saved.at(-1)?.display.zIndex, 20);
  f.port.dispose();
  assert.equal(f.wrappers.size, 0);
});

test('rejects invalid planes and z-indices without replacing the current video', () => {
  const f = fixture();
  f.show();
  for (const settings of [
    {plane: 'sprite'},
    {plane: null},
    {zIndex: 0.5},
    {zIndex: '2'},
    {zIndex: NaN},
    {zIndex: Infinity},
    {zIndex: Number.MAX_SAFE_INTEGER + 1},
  ]) {
    assert.throws(() => f.show('movie', {asset: 'Movie', ...settings}), {
      code: 'K4-VIDEO-ARGUMENT',
    });
  }
  assert.equal(f.videos.length, 1);
  assert.equal(f.overlays.size, 1);
  f.port.dispose();
});

test('playUntilDone blocks until ended while loop continues and stop resets only its id', async () => {
  const f = fixture();
  f.show();
  f.show('second');
  let completed = false;
  const wait = Promise.resolve(
    f.port.videoControl({id: 'movie', operation: 'playUntilDone'}, f.context),
  ).then(() => {
    completed = true;
  });
  await Promise.resolve();
  assert.equal(completed, false);
  await f.port.videoControl({id: 'second', operation: 'loop'}, f.context);
  assert.equal(f.videos[1]?.loop, true);
  f.videos[0]?.dispatchEvent(new Event('ended'));
  await wait;
  assert.equal(completed, true);
  const second = f.videos[1]!;
  second.currentTime = 42;
  f.port.videoControl({id: 'second', operation: 'stop'}, f.context);
  assert.equal(second.paused, true);
  assert.equal(second.loop, false);
  assert.equal(second.currentTime, 0);
  f.port.dispose();
});

test('background play waits for start, returns before ended and preserves the final frame', async () => {
  const f = fixture();
  f.show();
  const video = f.videos[0]!;
  let start: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  video.play = () => {
    video.paused = false;
    return started;
  };
  let completed = false;
  const playing = Promise.resolve(
    f.port.videoControl({id: 'movie', operation: 'play'}, f.context),
  ).then(() => {
    completed = true;
  });
  await Promise.resolve();
  assert.equal(completed, false);
  start();
  await playing;
  assert.equal(completed, true);
  assert.equal(video.paused, false);
  assert.equal(video.loop, false);
  video.currentTime = 42;
  video.paused = true;
  video.dispatchEvent(new Event('ended'));
  assert.equal(video.currentTime, 42);
  assert.equal(f.overlays.size, 1);
  f.port.videoControl({id: 'movie', operation: 'stop'}, f.context);
  assert.equal(video.currentTime, 0);
  f.port.dispose();
});

test('pause, seek and resume preserve playback position and presentation settings', async () => {
  const f = fixture();
  f.show();
  const video = f.videos[0]!;
  const waiting = f.port.videoControl({id: 'movie', operation: 'playUntilDone'}, f.context);
  video.currentTime = 12;
  f.port.videoControl({id: 'movie', operation: 'pause'}, f.context);
  await waiting;
  assert.equal(video.paused, true);
  assert.equal(video.currentTime, 12);
  f.port.videoControl({id: 'movie', operation: 'seek', seconds: 25}, f.context);
  f.port.videoControl({id: 'movie', operation: 'setVolume', volume: 35}, f.context);
  f.port.videoControl({id: 'movie', operation: 'setMuted', muted: true}, f.context);
  f.port.videoControl({id: 'movie', operation: 'setPlaybackRate', rate: 1.5}, f.context);
  await f.port.videoControl({id: 'movie', operation: 'resume'}, f.context);
  assert.equal(video.currentTime, 25);
  assert.equal(video.volume, 0.35);
  assert.equal(video.muted, true);
  assert.equal(video.playbackRate, 1.5);
  assert.equal(video.paused, false);
  for (const args of [
    {operation: 'seek', seconds: -1},
    {operation: 'seek', seconds: 61},
    {operation: 'setVolume', volume: 101},
    {operation: 'setPlaybackRate', rate: 0},
    {operation: 'setMuted', muted: 'true'},
  ])
    assert.throws(() => f.port.videoControl({id: 'movie', ...args}, f.context));
  assert.equal(video.currentTime, 25);
  f.port.dispose();
});

test('stop releases a pending wait and abort rejects it without a dangling listener', async () => {
  const f = fixture();
  f.show();
  const stopped = f.port.videoControl({id: 'movie', operation: 'playUntilDone'}, f.context);
  f.port.videoControl({id: 'movie', operation: 'stop'}, f.context);
  await stopped;
  const aborted = f.port.videoControl({id: 'movie', operation: 'playUntilDone'}, f.context);
  f.controller.abort();
  await assert.rejects(Promise.resolve(aborted), {name: 'AbortError'});
  assert.equal(f.videos[0]?.paused, true);
  f.port.dispose();
});

test('replacement and selected asset release cancel playback and unload the old decoder', async () => {
  const f = fixture();
  f.show();
  const waiting = f.port.videoControl({id: 'movie', operation: 'playUntilDone'}, f.context);
  f.show();
  await assert.rejects(Promise.resolve(waiting), {name: 'AbortError'});
  assert.equal(f.videos[0]?.src, '');
  assert.equal(f.overlays.size, 1);
  f.port.releaseAssets(['other']);
  assert.equal(f.overlays.size, 1);
  f.port.releaseAssets(['Movie']);
  assert.equal(f.overlays.size, 0);
  assert.throws(() => f.port.videoControl({id: 'movie', operation: 'stop'}, f.context), {
    code: 'K4-VIDEO-ID',
  });
  f.port.dispose();
  f.port.dispose();
});

test('play rejection, decode errors and background playback failure have diagnostics', async () => {
  const f = fixture();
  f.show();
  f.videos[0]!.playFailure = new DOMException('User gesture required', 'NotAllowedError');
  await assert.rejects(
    Promise.resolve(f.port.videoControl({id: 'movie', operation: 'playUntilDone'}, f.context)),
    {code: 'K4-VIDEO-AUTOPLAY'},
  );
  await assert.rejects(
    Promise.resolve(f.port.videoControl({id: 'movie', operation: 'play'}, f.context)),
    {code: 'K4-VIDEO-AUTOPLAY'},
  );
  f.videos[0]!.playFailure = null;
  const wait = f.port.videoControl({id: 'movie', operation: 'playUntilDone'}, f.context);
  f.videos[0]!.dispatchEvent(new Event('error'));
  await assert.rejects(Promise.resolve(wait), {code: 'K4-VIDEO-MEDIA'});
  await f.port.videoControl({id: 'movie', operation: 'loop'}, f.context);
  f.videos[0]!.dispatchEvent(new Event('error'));
  assert.equal(f.errors.length, 1);
  assert.equal(f.videos[0]!.paused, true);
  await f.port.videoControl({id: 'movie', operation: 'play'}, f.context);
  f.videos[0]!.dispatchEvent(new Event('error'));
  assert.equal(f.errors.length, 2);
  assert.equal(f.videos[0]!.paused, true);
  f.port.dispose();
});

test('video state restore prepares a new presentation and preserves the current one on failure', async () => {
  const f = fixture();
  f.show();
  const original = f.videos[0]!;
  original.currentTime = 12;
  original.volume = 0.4;
  original.muted = true;
  original.playbackRate = 2;
  const state = f.port.captureState();
  assert.equal(Object.isFrozen(state), true);
  assert.equal(state[0]?.time, 12);
  assert.equal(state[0]?.volume, 40);
  const invalid = [{...state[0], display: {...state[0]!.display, asset: 'Missing'}}];
  await assert.rejects(f.port.restoreState(invalid, f.context), {code: 'K4-VIDEO-ASSET'});
  assert.equal(f.overlays.size, 1);
  assert.equal(original.src, 'blob:movie');
  await assert.rejects(f.port.restoreState([{...state[0], rate: 0}], f.context));
  await f.port.restoreState(state, f.context);
  const restored = f.videos[1]!;
  assert.equal(original.src, '');
  assert.equal(restored.currentTime, 12);
  assert.equal(restored.volume, 0.4);
  assert.equal(restored.playbackRate, 2);
  assert.equal(restored.muted, true);
  assert.equal(restored.paused, true);
  assert.equal(f.overlays.size, 1);
  f.port.dispose();
});

test('invalid sources and sizes do not replace an existing rectangle', () => {
  const f = fixture();
  f.show();
  for (const url of [
    'javascript:alert(1)',
    'https://user:pass@example.com/movie.mp4',
    'https://',
  ]) {
    assert.throws(() => f.show('movie', {url}));
  }
  assert.throws(() => f.show('movie', {asset: 'Missing'}), {code: 'K4-VIDEO-ASSET'});
  assert.throws(() =>
    f.port.video(
      {id: 'movie', url: 'https://example.com/movie.mp4', x: 0, y: 0, width: 0, height: 1},
      f.context,
    ),
  );
  assert.equal(f.overlays.size, 1);
  assert.equal(f.videos.length, 1);
  f.port.dispose();
});

test('video asset URLs are owned by the asset lifecycle and released once', async () => {
  const revoked: string[] = [];
  let blob: Blob | undefined;
  const adapter = createDsl4VideoAssetAdapter({
    createObjectURL(value) {
      blob = value;
      return 'blob:movie';
    },
    revokeObjectURL(value) {
      revoked.push(value);
    },
  });
  const resource = await adapter.prepare(
    {
      asset: {id: 'Movie', kind: 'video'},
      files: [{bytes: Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109])}],
    },
    {},
  );
  assert.equal(blob?.type, 'video/mp4');
  assert.equal(resource.objectUrl, 'blob:movie');
  adapter.release(resource);
  adapter.release(resource);
  assert.deepEqual(revoked, ['blob:movie']);
});

test.each(['playUntilDone', 'play'])(
  'parsed video %s honors completion through the runtime dispatcher',
  async (operation) => {
    const parsed = frontend.parse(
      `kamishibai: '4.0'\nscenes:\n  main:\n    - video: {id: movie, url: 'https://example.com/movie.webm', x: 0, y: 0, width: 320, height: 180}\n    - videoControl: {id: movie, operation: ${operation}}\n    - wait: 0\n`,
    );
    assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
    const f = fixture();
    const trace: string[] = [];
    const controller = createDsl4RuntimeController({
      storyDocument: parsed.storyDocument,
      port: {
        video: f.port.video,
        videoControl: f.port.videoControl,
        wait() {
          trace.push('after');
        },
      },
    });
    const running = controller.start();
    for (let index = 0; index < 50 && f.videos[0]?.paused !== false; index++)
      await Promise.resolve();
    assert.equal(f.videos[0]?.paused, false);
    if (operation === 'playUntilDone') {
      assert.deepEqual(trace, []);
      f.videos[0]!.dispatchEvent(new Event('ended'));
    }
    await running;
    assert.deepEqual(trace, ['after']);
    assert.equal(f.videos[0]!.loop, false);
    f.port.dispose();
  },
);

test('selected purge releases every matching region while preserving shared and URL playback', async () => {
  const f = fixture();
  try {
    f.show('first');
    f.show('second');
    f.show('shared', {asset: 'Shared'});
    f.show('direct', {url: 'https://example.com/direct.webm'});
    for (const id of ['first', 'second', 'shared', 'direct'])
      await f.port.videoControl({id, operation: 'loop'}, f.context);
    const waiting = f.port.videoControl({id: 'first', operation: 'playUntilDone'}, f.context);
    const cancelled = assert.rejects(Promise.resolve(waiting), {name: 'AbortError'});
    f.port.releaseAssets(['Movie', 'Movie']);
    await cancelled;
    assert(
      f.videos.slice(0, 2).every((video) => video.paused && video.src === '' && video.loads === 1),
    );
    assert(f.videos.slice(2).every((video) => !video.paused && video.src !== '' && video.loop));
    assert.equal(f.overlays.size, 2);
    f.port.releaseAssets(['Movie']);
    assert.equal(f.overlays.size, 2);
  } finally {
    f.port.dispose();
  }
});

test('selected purge continues through decoder unload failure and reports it after every match', async () => {
  const f = fixture();
  try {
    f.show('broken');
    f.show('remaining');
    f.show('shared', {asset: 'Shared'});
    for (const id of ['broken', 'remaining', 'shared'])
      await f.port.videoControl({id, operation: 'loop'}, f.context);
    const failure = new Error('decoder unload failed');
    f.videos[0]!.load = () => {
      f.videos[0]!.loads++;
      throw failure;
    };
    let reported: unknown;
    try {
      f.port.releaseAssets(['Movie']);
    } catch (error) {
      reported = error;
    }
    assert.equal(f.videos[1]!.src, '');
    assert.equal(f.videos[1]!.paused, true);
    assert.equal(f.overlays.size, 1);
    assert.equal(f.videos[2]!.src, 'blob:shared');
    assert.equal(f.videos[2]!.paused, false);
    assert(reported instanceof AggregateError);
    assert.deepEqual(reported.errors, [failure]);
  } finally {
    f.port.dispose();
  }
});
