import {expect, test, vi} from 'vitest';
import type {
  AssetManagerAudioPlayback,
  AssetManagerAudioPlayOptions,
  AssetManagerAudioStopOptions,
} from '@kubohiroya/turbowarp-asset-cache/composition';
import {createDsl4AudioActionPort} from '../src/dsl4/platform/audio-action-port.js';

function playback() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  let ended = Promise.resolve();
  const instance = {
    currentTime: 0,
    paused: true as boolean,
    loop: false as boolean,
    gain: 1,
    muted: false as boolean,
    playbackRate: 1,
    get ended() {
      return ended;
    },
    play: vi.fn(async (options: AssetManagerAudioPlayOptions = {}) => {
      if (options.signal?.aborted)
        throw Object.assign(new Error('cancelled'), {name: 'AbortError'});
      if (options.restart) instance.currentTime = 0;
      instance.loop = options.loop ?? false;
      instance.paused = false;
      ended = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      void ended.catch(() => {});
      options.signal?.addEventListener(
        'abort',
        () => {
          instance.paused = true;
          reject(Object.assign(new Error('cancelled'), {name: 'AbortError'}));
        },
        {once: true},
      );
    }),
    pause: vi.fn(() => {
      instance.paused = true;
      resolve?.();
    }),
    stop: vi.fn((_options?: AssetManagerAudioStopOptions): void | Promise<void> => {
      instance.paused = true;
      instance.currentTime = 0;
      instance.loop = false;
      resolve?.();
    }),
    seek: vi.fn(async (time: number) => {
      instance.currentTime = time;
    }),
    setGain: vi.fn((gain: number) => {
      instance.gain = gain;
    }),
    setMuted: vi.fn((muted: boolean) => {
      instance.muted = muted;
    }),
    setPlaybackRate: vi.fn((rate: number) => {
      instance.playbackRate = rate;
    }),
    dispose: vi.fn(() => {
      resolve?.();
    }),
  } satisfies AssetManagerAudioPlayback;
  return {instance, finish: () => resolve(), fail: (error: unknown) => reject(error)};
}

function fixture() {
  const made: ReturnType<typeof playback>[] = [];
  const errors: unknown[] = [];
  const create = vi.fn(async () => {
    const result = playback();
    made.push(result);
    return result.instance;
  });
  const port = createDsl4AudioActionPort({
    createAudioPlayback: create,
    getAssetResource: (id) => (id === 'Music' ? {kind: 'sound'} : {kind: 'video'}),
    onBackgroundError: (error) => {
      errors.push(error);
    },
  });
  const abort = new AbortController();
  const context = {signal: abort.signal};
  const prepare = (id = 'music') =>
    port.audio({id, asset: 'Music', volume: 35, muted: true, playbackRate: 1.5}, context);
  const control = (operation: string, extra = {}, id = 'music') =>
    port.audioControl({id, operation, ...extra}, context);
  return {made, errors, create, port, context, abort, prepare, control};
}

test('pause and stop finish an active end-wait while preserving a reusable instance', async () => {
  const f = fixture();
  await f.prepare();
  const first = f.control('playUntilDone');
  await Promise.resolve();
  await Promise.resolve();
  f.made[0]!.instance.currentTime = 2;
  await f.control('pause');
  await first;
  expect(f.made[0]!.instance.currentTime).toBe(2);
  const second = f.control('playUntilDone');
  await Promise.resolve();
  await Promise.resolve();
  await f.control('stop');
  await second;
  expect(f.made[0]!.instance.dispose).not.toHaveBeenCalled();
  f.port.dispose();
});

test('prepares independent instances without autoplay and delegates settings and controls', async () => {
  const f = fixture();
  await f.prepare();
  await f.prepare('second');
  expect(f.create).toHaveBeenCalledWith(
    {asset: 'Music'},
    {gain: 0.35, muted: true, playbackRate: 1.5},
  );
  const first = f.made[0]!.instance;
  const second = f.made[1]!.instance;
  expect(first.play).not.toHaveBeenCalled();
  await f.control('loop');
  expect(first.loop).toBe(true);
  first.currentTime = 2;
  await f.control('pause');
  expect(first.currentTime).toBe(2);
  await f.control('resume');
  expect(first.play).toHaveBeenLastCalledWith(
    expect.objectContaining({restart: false, loop: true}),
  );
  await f.control('seek', {seconds: 3});
  await f.control('setVolume', {volume: 0});
  await f.control('setMuted', {muted: false});
  await f.control('setPlaybackRate', {rate: 2});
  expect([first.currentTime, first.gain, first.muted, first.playbackRate]).toEqual([
    3,
    0,
    false,
    2,
  ]);
  await f.control('stop');
  expect(first.currentTime).toBe(0);
  expect(first.dispose).not.toHaveBeenCalled();
  expect(second.play).not.toHaveBeenCalled();
  await f.control('play');
  f.port.dispose();
  expect(first.dispose).toHaveBeenCalledOnce();
  expect(second.dispose).toHaveBeenCalledOnce();
});

test('waits for natural completion and cancels waiting playback on replacement, scene cleanup and abort', async () => {
  const f = fixture();
  await f.prepare();
  let done = false;
  const waiting = f.control('playUntilDone').then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  f.made[0]!.finish();
  await waiting;
  expect(done).toBe(true);
  const replaced = f.control('playUntilDone');
  await Promise.resolve();
  await f.prepare();
  await expect(replaced).rejects.toMatchObject({name: 'AbortError'});
  const cancelled = f.control('playUntilDone');
  await Promise.resolve();
  f.abort.abort();
  await expect(cancelled).rejects.toMatchObject({name: 'AbortError'});
  f.port.clear();
  expect(f.made.every(({instance}) => instance.dispose.mock.calls.length === 1)).toBe(true);
});

test('preserves background playback after its initiating action and reports late decode errors once', async () => {
  const f = fixture();
  await f.prepare();
  await f.control('play');
  f.abort.abort();
  expect(f.made[0]!.instance.paused).toBe(false);
  f.made[0]!.fail(new Error('decode failed'));
  await Promise.resolve();
  expect(f.errors).toHaveLength(1);
  expect(f.errors[0]).toMatchObject({code: 'K4-AUDIO-PLAY'});
  expect(f.made[0]!.instance.dispose).toHaveBeenCalledOnce();
});

test('retains native autoplay refusal in diagnostics and disposes the failed instance', async () => {
  const f = fixture();
  await f.prepare();
  const denied = new DOMException('activation required', 'NotAllowedError');
  f.made[0]!.instance.play.mockRejectedValueOnce(new Error('Playback failed', {cause: denied}));
  await expect(f.control('play')).rejects.toMatchObject({code: 'K4-AUDIO-AUTOPLAY'});
  expect(f.made[0]!.instance.dispose).toHaveBeenCalledOnce();
});

test('disposes late preparation after selected asset release and keeps unrelated URL sources', async () => {
  const f = fixture();
  const late = playback();
  let resolve!: (value: typeof late.instance) => void;
  f.create.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const preparing = f.prepare();
  await f.port.audio({id: 'remote', url: 'https://example.com/music.mp3'}, f.context);
  f.port.releaseAssets(['Music']);
  resolve(late.instance);
  await expect(preparing).rejects.toMatchObject({name: 'AbortError'});
  expect(late.instance.dispose).toHaveBeenCalledOnce();
  expect(f.made[0]!.instance.dispose).not.toHaveBeenCalled();
  await f.control('play', {}, 'remote');
  f.port.clear();
  expect(f.made[0]!.instance.dispose).toHaveBeenCalledOnce();
});

test('rejects invalid sources, unprepared assets and unexpected control fields', async () => {
  const f = fixture();
  for (const args of [
    {id: 'music'},
    {id: 'music', asset: 'Movie'},
    {id: 'music', asset: 'Music', url: 'https://example.com/a'},
    {id: 'music', url: 'https://user:password@example.com/a.mp3'},
    {id: 'music', asset: 'Music', volume: -1},
  ]) {
    await expect(f.port.audio(args, f.context)).rejects.toThrow();
  }
  await f.prepare();
  for (const args of [
    {operation: 'stop', volume: 10},
    {operation: 'seek', seconds: -1},
    {operation: 'setMuted', muted: 'false'},
    {operation: 'unknown'},
  ]) {
    await expect(f.port.audioControl({id: 'music', ...args}, f.context)).rejects.toThrow();
  }
  f.port.dispose();
  await expect(f.prepare()).rejects.toMatchObject({code: 'K4-AUDIO-DISPOSED'});
});

test('forwards fade defaults and overrides and waits for the fade-out stop', async () => {
  const f = fixture();
  await f.port.audio({id: 'music', asset: 'Music', fadeIn: 1, fadeOut: 2}, f.context);
  expect(f.create).toHaveBeenCalledWith(
    {asset: 'Music'},
    expect.objectContaining({fadeIn: 1, fadeOut: 2}),
  );
  await f.control('play', {fadeIn: 0.5, fadeOut: 1.5});
  expect(f.made[0]!.instance.play).toHaveBeenLastCalledWith(
    expect.objectContaining({fadeIn: 0.5, fadeOut: 1.5}),
  );
  let resolve!: () => void;
  f.made[0]!.instance.stop.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  let stopped = false;
  const stopping = f.control('stop', {fadeOut: 0.25}).then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(f.made[0]!.instance.stop).toHaveBeenLastCalledWith({
    fadeOut: 0.25,
    signal: f.context.signal,
  });
  resolve();
  await stopping;
  for (const args of [
    {operation: 'play', fadeIn: -1},
    {operation: 'stop', fadeOut: null},
    {operation: 'pause', fadeOut: 1},
  ]) {
    await expect(f.port.audioControl({id: 'music', ...args}, f.context)).rejects.toThrow();
  }
  f.port.dispose();
});

test('defaults volume to 100 and accepts start-time volume with fades and later amplification', async () => {
  const f = fixture();
  await f.port.audio({id: 'music', asset: 'Music'}, f.context);
  expect(f.create).toHaveBeenCalledWith({asset: 'Music'}, expect.objectContaining({gain: 1}));
  await f.control('play', {fadeIn: 0.5, volume: 200, fadeOut: 1});
  expect(f.made[0]!.instance.play).toHaveBeenLastCalledWith(
    expect.objectContaining({gain: 2, fadeIn: 0.5, fadeOut: 1}),
  );
  await f.control('setVolume', {volume: 250});
  expect(f.made[0]!.instance.setGain).toHaveBeenLastCalledWith(2.5);
  await f.control('play', {volume: 0});
  expect(f.made[0]!.instance.play).toHaveBeenLastCalledWith(expect.objectContaining({gain: 0}));
  for (const volume of [-1, NaN, Infinity, null, '200']) {
    await expect(f.control('play', {volume})).rejects.toThrow();
    await expect(f.port.audio({id: 'other', asset: 'Music', volume}, f.context)).rejects.toThrow();
  }
  f.port.dispose();
});
