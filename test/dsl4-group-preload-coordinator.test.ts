import assert from 'node:assert/strict';
import {test} from 'vitest';
import {createDsl4GroupPreloadCoordinator} from '../src/dsl4/group-preload-coordinator.js';
import {createVideoAssetFixture} from './helpers/dsl4-video-asset-fixture.ts';

test('group coordinator purges scene video only after commit and keeps shared video owned', async () => {
  const fixture = await createVideoAssetFixture();
  const owner = createDsl4GroupPreloadCoordinator({
    storyDocument: fixture.storyDocument,
    segmentId: 'a',
    lifecycle: fixture.lifecycle,
  });
  assert((await owner.prepareStartup(0)).ok);
  owner.beginScene('first', 1);
  assert((await owner.waitForScene('first')).ok);
  await owner.commitScene('first', 'start');
  await fixture.show('movie', 'Movie');
  await fixture.show('shared', 'Shared');
  const movie = fixture.videos[0]!;
  const shared = fixture.videos[1]!;
  owner.beginScene('next', 2);
  assert((await owner.waitForScene('next')).ok);
  assert(movie.src);
  assert(shared.src);
  assert.equal(fixture.revoked.length, 0);
  await owner.commitScene('next', 'next');
  assert.equal(movie.src, '');
  assert(shared.src);
  assert.equal(fixture.revoked.length, 1);
  assert.deepEqual(Object.keys(owner.snapshot().assetReferences), ['Shared']);
  await owner.release('stop');
  assert.equal(shared.src, '');
  assert.equal(fixture.liveUrls.size, 0);
  assert((await owner.prepareStartup(3)).ok);
  owner.beginScene('first', 3);
  assert((await owner.waitForScene('first')).ok);
  await owner.commitScene('first', 'restart');
  await owner.release('dispose');
  assert.equal(fixture.liveUrls.size, 0);
});

test('group coordinator holds committed resources on candidate failure and cancellation', async () => {
  const fixture = await createVideoAssetFixture();
  let fail = false;
  let gate: (() => void) | null = null;
  const owner = createDsl4GroupPreloadCoordinator({
    storyDocument: fixture.storyDocument,
    segmentId: 'b',
    lifecycle: {
      ...fixture.lifecycle,
      async prepare(payload, context) {
        if (fail) throw new Error('network unavailable');
        if (context.generation === 3)
          await new Promise<void>((resolve) => {
            gate = resolve;
          });
        await fixture.lifecycle.prepare(payload, context);
      },
    },
  });
  assert((await owner.prepareStartup(0)).ok);
  owner.beginScene('next', 1);
  assert((await owner.waitForScene('next')).ok);
  await owner.commitScene('next', 'start');
  await fixture.show('shared', 'Shared');
  const shared = fixture.videos[0]!;
  const before = owner.snapshot();
  const url = shared.src;
  fail = true;
  owner.beginScene('first', 2);
  const failed = await owner.waitForScene('first');
  assert(!failed.ok && !failed.cancelled);
  assert.deepEqual(owner.snapshot(), before);
  assert.equal(shared.src, url);
  fail = false;
  owner.beginScene('first', 3);
  while (!gate) await new Promise((resolve) => setTimeout(resolve, 1));
  owner.cancel('user');
  (gate as () => void)();
  owner.beginScene('next', 4);
  assert((await owner.waitForScene('next')).ok);
  await owner.commitScene('next', 'retry');
  assert.equal(shared.src, url);
  assert.deepEqual(owner.snapshot(), before);
  await owner.release('dispose');
  assert.equal(shared.src, '');
  assert.equal(fixture.liveUrls.size, 0);
});

test('controller-style unawaited cleanup is contained while explicit owners receive its failure', async () => {
  const fixture = await createVideoAssetFixture();
  const owner = createDsl4GroupPreloadCoordinator({
    storyDocument: fixture.storyDocument,
    segmentId: 'cleanup',
    lifecycle: {
      ...fixture.lifecycle,
      async release(payload) {
        await fixture.lifecycle.release(payload);
        throw new Error('base cleanup failed');
      },
    },
  });
  assert((await owner.prepareStartup(0)).ok);
  owner.beginScene('first', 1);
  assert((await owner.waitForScene('first')).ok);
  await owner.commitScene('first', 'start');
  await fixture.show('movie', 'Movie');
  const cleanup = owner.release('stop');
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(cleanup, /Asset group coordinator cleanup failed/);
  assert.equal(fixture.liveUrls.size, 0);
  assert(fixture.videos.every((video) => video.src === ''));
});

test('startup cancellation aborts the actual preparation signal and releases partially acquired boot assets', async () => {
  const {dsl4TestSourceFrontend: frontend} = await import('./helpers/dsl4-test-frontend.ts');
  const parsed = frontend.parse(
    "kamishibai: '4.0'\nassets:\n  Cover: {kind: backdrop, name: Cover}\ncover: {backdrop: Cover}\nscenes:\n  first:\n    - wait: 1\n",
    {sourceId: 'startup-cancel'},
  );
  assert(parsed.ok, JSON.stringify(parsed.diagnostics));
  let signal: AbortSignal | undefined;
  const released: string[] = [];
  const loading: boolean[] = [];
  const owner = createDsl4GroupPreloadCoordinator({
    storyDocument: parsed.storyDocument,
    segmentId: 'a',
    lifecycle: {
      async prepare(_payload, context) {
        signal = context.signal;
        await new Promise<void>((_resolve, reject) =>
          signal!.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled', 'AbortError')),
            {once: true},
          ),
        );
      },
      setLoading(payload) {
        loading.push(payload.visible === true);
      },
      releaseAssets(payload) {
        released.push(...payload.assetIds);
      },
      release() {},
    },
  });
  const startup = owner.prepareStartup(0);
  while (!signal) await new Promise((resolve) => setTimeout(resolve, 0));
  owner.cancel('stop');
  assert.equal(signal.aborted, true);
  assert.deepEqual(await startup, {ok: false, cancelled: true});
  await owner.release('dispose');
  assert.deepEqual(released, ['Cover']);
  assert.deepEqual(loading, [true, false]);
  assert.deepEqual(owner.snapshot().assetReferences, {});
});

test('group loading presentation brackets startup and scene waits, including failure and cancellation', async () => {
  const fixture = await createVideoAssetFixture();
  const loading: {visible: unknown; sceneId: unknown}[] = [];
  let fail = false;
  const owner = createDsl4GroupPreloadCoordinator({
    storyDocument: fixture.storyDocument,
    segmentId: 'a',
    lifecycle: {
      ...fixture.lifecycle,
      async prepare(payload, context) {
        if (fail) throw new Error('load failed');
        await fixture.lifecycle.prepare(payload, context);
      },
      setLoading(payload) {
        loading.push({visible: payload.visible, sceneId: payload.sceneId});
      },
    },
  });
  assert((await owner.prepareStartup(0)).ok);
  owner.beginScene('next', 1);
  assert((await owner.waitForScene('next')).ok);
  await owner.commitScene('next', 'start');
  fail = true;
  owner.beginScene('first', 2);
  assert.equal((await owner.waitForScene('first')).ok, false);
  assert.deepEqual(loading, [
    {visible: true, sceneId: null},
    {visible: false, sceneId: null},
    {visible: true, sceneId: 'next'},
    {visible: false, sceneId: 'next'},
    {visible: true, sceneId: 'first'},
    {visible: false, sceneId: 'first'},
  ]);
  await owner.release('dispose');
});

test('startup materializes loading artwork before presenting it while boot content is prepared', async () => {
  const {dsl4TestSourceFrontend: frontend} = await import('./helpers/dsl4-test-frontend.ts');
  const parsed = frontend.parse(
    "kamishibai: '4.0'\nassets:\n  Loading: {kind: backdrop, name: Loading}\n  Spinner: {kind: costume, target: Loader, name: Spinner}\n  Cover: {kind: backdrop, name: Cover}\ncover: {backdrop: Cover}\nloading: {backdrop: Loading, costumes: [Spinner]}\nscenes:\n  first:\n    - wait: 1\n",
    {sourceId: 'loading-bootstrap'},
  );
  assert(parsed.ok, JSON.stringify(parsed.diagnostics));
  const materialized = new Set<string>();
  const prepared: unknown[] = [];
  const owner = createDsl4GroupPreloadCoordinator({
    storyDocument: parsed.storyDocument,
    segmentId: 'a',
    lifecycle: {
      prepare(payload) {
        const ids = payload.assetIds as string[];
        prepared.push([...ids]);
        for (const id of ids) materialized.add(id);
      },
      setLoading(payload) {
        if (payload.visible && payload.loading) {
          assert(materialized.has('Loading'));
          assert(!materialized.has('Cover'));
        }
      },
      releaseAssets(payload) {
        for (const id of payload.assetIds) materialized.delete(id);
      },
      release() {},
    },
  });
  assert((await owner.prepareStartup(0)).ok);
  assert.deepEqual(prepared, [['Loading', 'Spinner'], ['Cover']]);
  await owner.release('dispose');
  assert.equal(materialized.size, 0);
});
