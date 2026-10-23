import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'vitest';
import {createDsl4PublicationAssetLoader} from '../src/dsl4/publication-asset-loader.js';
import {createDsl4VideoAssetAdapter} from '../src/dsl4/platform/video-asset-adapter.js';
import {dsl4TestSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';
import {createVideoAssetFixture} from './helpers/dsl4-video-asset-fixture.ts';
import {requireRecord} from './helpers/require-value.ts';

const source = `kamishibai: '4.0'
assets:
  Movie: {kind: video, file: movie.webm, loading: lazy, retention: scene}
  Shared: {kind: video, file: shared.webm, loading: lazy, retention: scene}
scenes:
  first:
    - video: {id: movie, asset: Movie, x: 0, y: 0, width: 160, height: 120}
    - video: {id: shared, asset: Shared, x: 0, y: 0, width: 160, height: 120}
  next:
    - video: {id: shared, asset: Shared, x: 0, y: 0, width: 160, height: 120}
`;

for (const failEntry of [false, true])
  test(`publication entry prepares eager scene assets and ${failEntry ? 'reports initial cleanup failure' : 'commits only entry requirements'}`, async () => {
    const text = `kamishibai: '4.0'
assets:
  First: {kind: backdrop, name: First, loading: eager, retention: scene}
  Later: {kind: backdrop, name: Later, loading: eager, retention: scene}
scenes:
  first:
    - stage: First
  next:
    - stage: Later
`;
    const bytes = new TextEncoder().encode(text);
    const live = new Set<string>();
    const prepared: string[][] = [];
    let fail = failEntry;
    const cleanupError = new Error('entry cleanup failed');
    const loader = createDsl4PublicationAssetLoader({
      manifest: {
        formatVersion: 1,
        id: 'eager',
        title: 'Eager scene assets',
        entrySegment: 'a',
        entryPoints: ['a'],
        segments: [
          {
            id: 'a',
            title: 'A',
            next: [],
            source: {
              entry: 'a.yaml',
              size: bytes.length,
              integrity: 'sha256-' + createHash('sha256').update(bytes).digest('hex'),
            },
          },
        ],
      },
      frontend,
      videoAssetAdapter: null,
      provider: {
        async read() {
          return text;
        },
      },
      async createSegmentSession() {
        return {
          value: null,
          lifecycle: {
            prepare({assetIds}) {
              prepared.push([...assetIds]);
              for (const id of assetIds) live.add(id);
            },
            releaseAssets({assetIds}) {
              if (fail && assetIds.includes('Later')) throw cleanupError;
              for (const id of assetIds) live.delete(id);
            },
          },
          dispose() {
            live.clear();
          },
        };
      },
    });
    try {
      const result = await loader.transition();
      assert.equal(result.current.segmentId, 'a');
      assert.equal(result.cleanupError, failEntry ? cleanupError : null);
      assert.deepEqual(prepared, [['First', 'Later']]);
      assert.deepEqual([...live], failEntry ? ['First', 'Later'] : ['First']);
      assert.deepEqual(
        result.current.prepared.value.groups.snapshot().pendingReleaseAssetIds,
        failEntry ? ['Later'] : [],
      );
      fail = false;
      await loader.getCurrent()!.prepared.value.enterScene('next', {
        signal: new AbortController().signal,
        generation: 1,
        sceneId: 'next',
      });
      assert.deepEqual(prepared, [['First', 'Later'], ['Later']]);
      assert.deepEqual([...live], ['Later']);
    } finally {
      await loader.dispose();
    }
    assert.equal(live.size, 0);
  });
async function fixture(count = 3) {
  const bytes = new TextEncoder().encode(source);
  const sessions: Awaited<ReturnType<typeof createVideoAssetFixture>>[] = [];
  const urls = new Set<string>(),
    revoked: string[] = [];
  let ordinal = 0,
    peakUrls = 0;
  let prepareFailure = false;
  let cancel: AbortController | null = null;
  const adapter = createDsl4VideoAssetAdapter({
    createObjectURL() {
      const url = `blob:publication-${++ordinal}`;
      urls.add(url);
      peakUrls = Math.max(peakUrls, urls.size);
      return url;
    },
    revokeObjectURL(url) {
      assert(
        !sessions.some((f) => f.videos.some((v) => v.src === url)),
        'Every referencing video must drop src before last URL release',
      );
      urls.delete(url);
      revoked.push(url);
    },
  });
  const loader = createDsl4PublicationAssetLoader({
    manifest: {
      formatVersion: 1,
      id: 'publication',
      title: '動画長編',
      entrySegment: 's0',
      entryPoints: ['s0'],
      segments: Array.from({length: count}, (_, i) => ({
        id: `s${i}`,
        title: `章${i}`,
        next: i + 1 < count ? [`s${i + 1}`] : [],
        source: {
          entry: `segments/${i}.yaml`,
          size: bytes.length,
          integrity: 'sha256-' + createHash('sha256').update(bytes).digest('hex'),
        },
      })),
    },
    frontend,
    videoAssetAdapter: adapter,
    maxCachedDocuments: 2,
    provider: {
      async read() {
        return source;
      },
    },
    async createSegmentSession(segment, document, _signal, owners) {
      const f = await createVideoAssetFixture({
        document,
        adapter: owners.video,
        movieMarker: 10 + Number(segment.id.slice(1)),
      });
      sessions.push(f);
      return {
        value: f,
        lifecycle: {
          ...f.lifecycle,
          async prepare(payload, context) {
            await f.lifecycle.prepare(payload, context);
            cancel?.abort();
            if (prepareFailure) throw new Error('candidate failed');
          },
        },
        async dispose() {
          try {
            await f.lifecycle.release({reason: 'session-dispose'});
          } finally {
            f.port.dispose();
          }
        },
      };
    },
  });
  async function showCurrent() {
    const f = loader.getCurrent()!.prepared.value.session;
    f.show('movie-front', 'Movie');
    f.show('movie-back', 'Movie', 'background');
    f.show('shared', 'Shared');
    for (const id of ['movie-front', 'movie-back', 'shared'])
      await f.port.videoControl({id, operation: 'loop'}, f.context);
    return f;
  }
  return {
    loader,
    sessions,
    urls,
    revoked,
    showCurrent,
    getPeak: () => peakUrls,
    failPrepare(value: boolean) {
      prepareFailure = value;
    },
    cancelPrepare(controller: AbortController | null) {
      cancel = controller;
    },
  };
}

test('generated scene groups cancel the released video wait and retain the still-referenced video', async () => {
  const f = await fixture();
  try {
    await f.loader.transition();
    const current = f.loader.getCurrent()!.prepared.value;
    const media = await f.showCurrent();
    const shared = media.base.getResource('Shared');
    const waiting = assert.rejects(
      Promise.resolve(
        media.port.videoControl({id: 'movie-front', operation: 'playUntilDone'}, media.context),
      ),
      {name: 'AbortError'},
    );
    await current.enterScene('next', {...media.context, sceneId: 'next'});
    await waiting;
    assert.equal(media.base.getResource('Movie'), null);
    assert.equal(media.base.getResource('Shared'), shared);
    assert.equal(f.urls.size, 1);
    assert.equal(media.videos[2]!.paused, false);
    assert.equal(media.skins.size, 0);
    assert.equal(media.drawables.size, 0);
    assert.equal(media.videos[1]!.frames.size, 0);
    assert(media.videos.slice(0, 2).every((v) => v.paused && v.src === ''));
  } finally {
    await f.loader.dispose();
  }
  assert.equal(f.urls.size, 0);
});

test('long publication transitions preserve shared video URLs and bound materializations independently of chapter count', async () => {
  const f = await fixture(24);
  try {
    let sharedUrl = '';
    for (let i = 0; i < 24; i++) {
      const result = await f.loader.transition(`s${i}`);
      assert.equal(result.cleanupError, null);
      const media = await f.showCurrent();
      const url = String(requireRecord(media.base.getResource('Shared'), 'shared').objectUrl);
      if (sharedUrl) assert.equal(url, sharedUrl);
      sharedUrl = url;
      assert.equal(f.urls.size, 2);
      assert(f.loader.getCachedSegmentIds().length <= 2);
      assert(
        f.sessions
          .slice(0, -1)
          .every(
            (old) =>
              old.videos.every((v) => v.paused && !v.src) &&
              old.skins.size === 0 &&
              old.drawables.size === 0 &&
              old.overlays.size === 0,
          ),
      );
    }
    assert.equal(f.getPeak(), 3, 'Current + candidate movie and one shared URL');
    assert(!f.revoked.includes(sharedUrl));
  } finally {
    await f.loader.dispose();
  }
  assert.equal(f.urls.size, 0);
});

test('candidate asset failure and cancellation preserve old playback, ownership, and shared materialization until retry', async () => {
  const f = await fixture();
  try {
    await f.loader.transition();
    const old = f.loader.getCurrent();
    const media = await f.showCurrent();
    const shared = media.base.getResource('Shared');
    f.failPrepare(true);
    await assert.rejects(f.loader.transition('s1'), /candidate failed/u);
    assert.equal(f.loader.getCurrent(), old);
    assert.equal(f.urls.size, 2);
    assert(media.videos.every((v) => !v.paused));
    assert.equal(media.base.getResource('Shared'), shared);
    f.failPrepare(false);
    const controller = new AbortController();
    f.cancelPrepare(controller);
    await assert.rejects(f.loader.transition('s1', {signal: controller.signal}), {
      name: 'AbortError',
    });
    assert.equal(f.loader.getCurrent(), old);
    assert.equal(f.urls.size, 2);
    assert(media.videos.every((v) => !v.paused));
    f.cancelPrepare(null);
    await f.loader.transition('s1');
    assert.equal(f.loader.getCurrent()?.segmentId, 's1');
    assert.equal(f.urls.size, 2);
    assert(media.videos.every((v) => v.paused && !v.src));
  } finally {
    await f.loader.dispose();
  }
  assert.equal(f.urls.size, 0);
});

test('old decoder cleanup failure does not masquerade as an uncommitted segment transition', async () => {
  const f = await fixture();
  try {
    await f.loader.transition();
    const media = await f.showCurrent();
    media.videos[0]!.loadFailure = new Error('decoder unload');
    const result = await f.loader.transition('s1');
    assert(result.cleanupError instanceof AggregateError);
    assert.equal(result.current.segmentId, 's1');
    assert(media.videos.every((v) => v.paused && !v.src));
    assert.equal(f.urls.size, 2);
    await f.loader.transition('s2');
    assert.equal(f.loader.getCurrent()?.segmentId, 's2');
  } finally {
    await f.loader.dispose();
  }
});
