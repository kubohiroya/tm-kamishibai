import assert from 'node:assert/strict';
import {test} from 'vitest';
import {createDsl4AssetPreloadCoordinator} from '../src/dsl4/asset-preload-coordinator.js';
import {releaseDsl4PlaybackAssets} from '../src/dsl4/platform/playback-asset-release.js';
import {createVideoAssetFixture as fixture} from './helpers/dsl4-video-asset-fixture.ts';
import {requireRecord} from './helpers/require-value.ts';

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
    assert(f.port.hasPendingCleanup());
    f.videos[0]!.loadFailure = null;
    f.setRevokeFailure(null);
    await f.lifecycle.releaseAssets({assetIds: ['Movie']});
    assert.equal(f.port.captureState().length, 1);
  } finally {
    f.setRevokeFailure(null);
    for (const video of f.videos) video.loadFailure = null;
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
