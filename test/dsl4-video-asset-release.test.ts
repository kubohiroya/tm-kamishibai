import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {test} from 'vitest';
import {
  createDsl4EmbeddedAssetBundle,
  validateDsl4EmbeddedAssetBundle,
} from '../src/dsl4/asset-bundle-descriptor.js';
import {createDsl4EmbeddedAssetLifecycle} from '../src/dsl4/embedded-asset-lifecycle.js';
import {createDsl4AssetPreloadCoordinator} from '../src/dsl4/asset-preload-coordinator.js';
import {createDsl4VideoAssetAdapter} from '../src/dsl4/platform/video-asset-adapter.js';
import {createDsl4VideoActionPort} from '../src/dsl4/platform/video-action-port.js';
import {releaseDsl4PlaybackAssets} from '../src/dsl4/platform/playback-asset-release.js';
import {dsl4TestSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';
import {requireRecord} from './helpers/require-value.ts';

/** Synthetic media/renderer resources; actual decoding remains covered by browser tests. */
class Video extends EventTarget {
  style: Record<string, string> = {};
  src = '';
  currentTime = 0;
  loop = false;
  muted = false;
  volume = 1;
  playbackRate = 1;
  readyState = 2;
  videoWidth = 160;
  videoHeight = 120;
  paused = true;
  ended = false;
  loads = 0;
  loadFailure: Error | null = null;
  frames = new Map<number, () => void>();
  nextFrame = 0;
  canvas = {
    width: 0,
    height: 0,
    getContext: () => ({fillStyle: '', fillRect() {}, drawImage() {}}),
  };
  ownerDocument = {defaultView: null, createElement: () => this.canvas};
  play() {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  load() {
    this.loads++;
    if (this.loadFailure) throw this.loadFailure;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  requestVideoFrameCallback(callback: () => void) {
    const id = ++this.nextFrame;
    this.frames.set(id, callback);
    return id;
  }
  cancelVideoFrameCallback(id: number) {
    this.frames.delete(id);
  }
}

async function fixture() {
  const parsed = frontend.parse(`kamishibai: '4.0'
assets:
  Movie: {kind: video, file: movie.webm, loading: lazy, retention: scene}
  Shared: {kind: video, file: shared.webm, loading: lazy, retention: scene}
scenes:
  first:
    - video: {id: first, asset: Movie, x: 0, y: 0, width: 160, height: 120}
    - video: {id: shared, asset: Shared, x: 0, y: 0, width: 160, height: 120}
  next:
    - video: {id: shared, asset: Shared, x: 0, y: 0, width: 160, height: 120}
`);
  assert(parsed.ok, JSON.stringify(parsed.diagnostics));
  const bytes = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]);
  const integrity = 'sha256-' + createHash('sha256').update(bytes).digest('base64');
  const options = {maxFiles: 4, maxTotalBytes: 1024, subtleCrypto: webcrypto.subtle};
  const descriptor = await createDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    {
      manifest: {
        formatVersion: 1,
        assets: ['Movie', 'Shared'].map((id) => ({
          id,
          kind: 'video',
          loading: 'lazy',
          source: {
            type: 'file',
            mode: 'file',
            inputPath: id.toLowerCase() + '.webm',
            files: [{path: id.toLowerCase() + '.webm', size: bytes.length, integrity}],
          },
        })),
      },
      getFile: () => new Uint8Array(bytes),
    },
    options,
  );
  const validated = await validateDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    descriptor,
    options,
  );
  const liveUrls = new Set<string>(),
    revoked: string[] = [],
    videos: Video[] = [],
    overlays = new Set<unknown>(),
    skins = new Set<number>(),
    drawables = new Set<number>(),
    order: string[] = [];
  let ordinal = 0;
  let revokeFailure: Error | null = null;
  const adapter = createDsl4VideoAssetAdapter({
    createObjectURL() {
      const url = 'blob:video-' + ++ordinal;
      liveUrls.add(url);
      return url;
    },
    revokeObjectURL(url) {
      assert(
        videos.filter((v) => v.src === url).every((v) => v.paused),
        'Playback must be stopped before URL release',
      );
      assert(
        !videos.some((v) => v.src === url),
        'Every matching element must drop src before URL release',
      );
      order.push('revoke:' + url);
      liveUrls.delete(url);
      revoked.push(url);
      if (revokeFailure) throw revokeFailure;
    },
  });
  const base = createDsl4EmbeddedAssetLifecycle({
    runtimeComponent: {
      storyDocument: parsed.storyDocument,
      assetBundle: validated.descriptor,
      getAssetFile: validated.getFile,
    },
    adapter,
    setLoading() {},
  });
  const port = createDsl4VideoActionPort({
    renderer: {
      addOverlay(element: unknown) {
        overlays.add(element);
        return {container: {style: {}}};
      },
      removeOverlay(element: unknown) {
        order.push('overlay-release');
        overlays.delete(element);
      },
      createBitmapSkin() {
        const id = ++ordinal;
        skins.add(id);
        return id;
      },
      createDrawable() {
        const id = ++ordinal;
        drawables.add(id);
        return id;
      },
      destroySkin(id: number) {
        order.push('skin-release');
        skins.delete(id);
      },
      destroyDrawable(id: number) {
        order.push('drawable-release');
        drawables.delete(id);
      },
      updateBitmapSkin() {},
      updateDrawableSkinId() {},
      updateDrawablePosition() {},
      updateDrawableScale() {},
      setDrawableOrder() {},
      updateDrawableVisible() {},
    },
    getAssetResource: base.getResource,
    createVideo() {
      const v = new Video();
      videos.push(v);
      return v as unknown as HTMLVideoElement;
    },
  });
  const audioCalls: unknown[] = [];
  const audio = {
    releaseAssets(ids: readonly string[]) {
      order.push('audio-release');
      audioCalls.push(ids);
    },
    clear() {
      order.push('audio-clear');
    },
  };
  const lifecycle = {
    prepare: base.prepare,
    setLoading: base.setLoading,
    releaseAssets(payload: Readonly<{assetIds: readonly string[]}>) {
      return releaseDsl4PlaybackAssets({
        videoPort: port,
        audioPort: audio,
        assetIds: payload.assetIds,
        releaseBase: () => base.releaseAssets(payload),
      });
    },
    release(payload: Readonly<Record<string, unknown>>) {
      return releaseDsl4PlaybackAssets({
        videoPort: port,
        audioPort: audio,
        assetIds: undefined,
        releaseBase: () => base.release(payload),
      });
    },
  };
  const context = {signal: new AbortController().signal, generation: 1, sceneId: 'first'};
  const show = (id: string, asset: string, plane = 'front') =>
    port.video({id, asset, plane, x: 0, y: 0, width: 160, height: 120}, context);
  return {
    base,
    port,
    lifecycle,
    context,
    show,
    liveUrls,
    revoked,
    videos,
    overlays,
    skins,
    drawables,
    order,
    audioCalls,
    storyDocument: parsed.storyDocument,
    validated,
    setRevokeFailure(error: Error | null) {
      revokeFailure = error;
    },
  };
}

test('selective lifecycle release unloads regions and GPU resources before URL revoke, preserving shared assets', async () => {
  const f = await fixture();
  try {
    await f.lifecycle.prepare({assetIds: ['Movie', 'Shared']}, f.context);
    const shared = f.base.getResource('Shared');
    const movie = requireRecord(f.base.getResource('Movie'), 'Movie');
    f.show('front', 'Movie');
    f.show('back', 'Movie', 'background');
    f.show('shared', 'Shared');
    for (const id of ['front', 'back', 'shared'])
      await f.port.videoControl({id, operation: 'loop'}, f.context);
    const waiting = Promise.resolve(
      f.port.videoControl({id: 'front', operation: 'playUntilDone'}, f.context),
    );
    const cancelled = assert.rejects(waiting, {name: 'AbortError'});
    assert.equal(f.skins.size, 1);
    assert.equal(f.drawables.size, 1);
    assert.equal(f.videos[1]!.frames.size, 1);
    await f.lifecycle.releaseAssets({assetIds: ['Movie']});
    await cancelled;
    assert.equal(f.base.getResource('Movie'), null);
    assert.equal(f.base.getResource('Shared'), shared);
    assert.deepEqual(f.revoked, [movie.objectUrl]);
    assert.equal(f.liveUrls.size, 1);
    assert.equal(f.overlays.size, 1);
    assert.equal(f.skins.size, 0);
    assert.equal(f.drawables.size, 0);
    assert.equal(f.videos[1]!.frames.size, 0);
    assert.equal(f.videos[2]!.paused, false);
    assert(f.order.indexOf('skin-release') < f.order.indexOf('revoke:' + movie.objectUrl));
    assert.deepEqual(f.audioCalls, [['Movie']]);
    await f.lifecycle.releaseAssets({assetIds: ['Movie']});
    assert.equal(f.revoked.length, 1);
    assert.deepEqual(
      f.validated.getFile('Movie', 'movie.webm'),
      Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]),
      'Original bundle bytes have their own lifetime',
    );
  } finally {
    await f.lifecycle.release({reason: 'test-cleanup'});
  }
});

test('scene retention keeps a still-required video asset and repeated release does not accumulate materializations', async () => {
  const f = await fixture();
  const coordinator = createDsl4AssetPreloadCoordinator({
    storyDocument: f.storyDocument,
    lifecycle: f.lifecycle,
    onEvent() {},
  });
  try {
    await f.lifecycle.prepare({assetIds: ['Movie', 'Shared']}, f.context);
    const shared = f.base.getResource('Shared');
    for (let visit = 0; visit < 6; visit++) {
      await f.lifecycle.prepare({assetIds: ['Movie', 'Shared']}, f.context);
      f.show('movie', 'Movie');
      f.show('shared', 'Shared');
      await f.port.videoControl({id: 'shared', operation: 'loop'}, f.context);
      assert.equal(f.liveUrls.size, 2);
      await coordinator.commitScene('next', 'scene-transition');
      assert.equal(f.liveUrls.size, 1);
      assert.equal(f.base.getResource('Shared'), shared);
      assert.equal(f.base.getResource('Movie'), null);
      assert.equal(f.overlays.size, 1);
      assert.equal(f.port.captureState()[0]?.display.asset, 'Shared');
    }
    assert.equal(f.revoked.length, 6);
  } finally {
    await coordinator.release('test-cleanup');
  }
  assert.equal(f.liveUrls.size, 0);
  assert.equal(f.overlays.size, 0);
});

test('decoder and URL cleanup failures still attempt remaining playback, audio, and base release', async () => {
  const f = await fixture();
  try {
    await f.lifecycle.prepare({assetIds: ['Movie', 'Shared']}, f.context);
    const shared = f.base.getResource('Shared');
    f.show('broken', 'Movie');
    f.show('other', 'Movie');
    f.show('shared', 'Shared');
    await f.port.videoControl({id: 'shared', operation: 'loop'}, f.context);
    const decoderFailure = new Error('decoder unload failed');
    const urlFailure = new Error('URL release failed');
    f.videos[0]!.loadFailure = decoderFailure;
    f.setRevokeFailure(urlFailure);
    await assert.rejects(f.lifecycle.releaseAssets({assetIds: ['Movie']}), (error) => {
      assert(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert(error.errors[0] instanceof AggregateError);
      assert.deepEqual(error.errors[0].errors, [decoderFailure]);
      return true;
    });
    assert.equal(f.videos[1]!.src, '');
    assert.equal(f.base.getResource('Movie'), null);
    assert.equal(f.base.getResource('Shared'), shared);
    assert.equal(f.videos[2]!.paused, false);
    assert.equal(f.overlays.size, 1);
    assert.deepEqual(f.audioCalls, [['Movie']]);
    assert.equal(f.revoked.length, 1);
  } finally {
    f.setRevokeFailure(null);
    await f.lifecycle.release({reason: 'test-cleanup'});
  }
});

test('full release attempts audio and base cleanup even when both playback owners fail', async () => {
  const calls: string[] = [];
  const videoFailure = new Error('video'),
    audioFailure = new Error('audio'),
    baseFailure = new Error('base');
  await assert.rejects(
    releaseDsl4PlaybackAssets({
      videoPort: {
        clear() {
          calls.push('video');
          throw videoFailure;
        },
        releaseAssets() {
          assert.fail('full release must clear');
        },
      },
      audioPort: {
        clear() {
          calls.push('audio');
          throw audioFailure;
        },
        releaseAssets() {
          assert.fail('full release must clear');
        },
      },
      assetIds: undefined,
      releaseBase() {
        calls.push('base');
        throw baseFailure;
      },
    }),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [videoFailure, audioFailure, baseFailure]);
      return true;
    },
  );
  assert.deepEqual(calls, ['video', 'audio', 'base']);
});
