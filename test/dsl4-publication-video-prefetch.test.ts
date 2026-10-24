import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'vitest';

import {createVerifiedRemoteBinaryCache} from '@kubohiroya/turbowarp-asset-cache/composition';
import {IDBFactory} from 'fake-indexeddb';

import {createDsl4EmbeddedAssetLifecycle} from '../src/dsl4/embedded-asset-lifecycle.js';
import {createDsl4PublicationAssetLoader} from '../src/dsl4/publication-asset-loader.js';
import {createDsl4PublicationSourceProvider} from '../src/dsl4/publication-loader.js';
import {validateDsl4PublicationManifest} from '../src/dsl4/publication-manifest.js';
import {
  createDsl4PublicationVideoPrefetch,
  dsl4SegmentVideoPrefetchTargets,
  type Dsl4VideoPrefetchResult,
} from '../src/dsl4/publication-video-prefetch.js';
import {createDsl4VerifiedVideoPrefetchResolver} from '../src/dsl4/platform/publication-video-prefetch-resolver.js';
import {createDsl4VideoAssetAdapter} from '../src/dsl4/platform/video-asset-adapter.js';
import {dsl4TestSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';

const hex = (bytes: Uint8Array | string) =>
  'sha256-' + createHash('sha256').update(bytes).digest('hex');
const sri = (bytes: Uint8Array) => 'sha256-' + createHash('sha256').update(bytes).digest('base64');
const movie = (marker: number) => Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, marker]);
const url = (marker: number) => `https://cdn.example.com/movie-${marker}.webm`;

function remoteVideo(id: string, marker: number, extra = '') {
  const bytes = movie(marker);
  return `  ${id}:
    kind: video
    delivery: remote
    loading: lazy
    retention: scene${extra}
    source: {url: '${url(marker)}', integrity: ${hex(bytes)}, contentType: video/webm, size: ${bytes.length}}
`;
}
const embeddedVideo = (id: string, marker: number) =>
  `  ${id}: {kind: video, file: movie-${marker}.webm, loading: lazy, retention: scene}\n`;
const show = (id: string, asset: string) =>
  `    - video: {id: ${id}, asset: ${asset}, x: 0, y: 0, width: 160, height: 120}\n`;

function parse(source: string) {
  const parsed = frontend.parse(source);
  assert(parsed.ok, JSON.stringify(parsed.diagnostics));
  return parsed.storyDocument;
}

test('prefetch targets are only verified remote videos the entry scene needs', () => {
  const document = parse(`kamishibai: '4.0'
assets:
${remoteVideo('EntryRemote', 1)}${embeddedVideo('EntryLocal', 2)}${remoteVideo('LaterRemote', 3)}  Picture:
    kind: backdrop
    delivery: remote
    loading: lazy
    source: {url: 'https://cdn.example.com/p.svg', integrity: ${hex('<svg/>')}, contentType: image/svg+xml, size: 6}
scenes:
  entry:
${show('a', 'EntryRemote')}${show('b', 'EntryLocal')}    - stage: Picture
  later:
${show('c', 'LaterRemote')}`);
  assert.deepEqual(dsl4SegmentVideoPrefetchTargets('s1', document), [
    {
      segmentId: 's1',
      assetId: 'EntryRemote',
      url: url(1),
      integrity: hex(movie(1)),
      size: 5,
      contentType: 'video/webm',
    },
  ]);
});

const manifest = (count: number, next: (i: number) => string[]) =>
  validateDsl4PublicationManifest({
    formatVersion: 1,
    id: 'prefetch',
    title: 'Prefetch',
    entrySegment: 's0',
    entryPoints: ['s0'],
    segments: Array.from({length: count}, (_, i) => ({
      id: `s${i}`,
      title: `S${i}`,
      next: next(i),
      source: {entry: `s${i}.yaml`, size: 1, integrity: hex(`s${i}`)},
    })),
  });

test('prefetch is advisory: failures are reported per asset and later segments still run', async () => {
  const documents = new Map([
    [
      's1',
      parse(
        `kamishibai: '4.0'\nassets:\n${remoteVideo('A', 1)}${remoteVideo('B', 2)}scenes:\n  first:\n${show('a', 'A')}${show('b', 'B')}`,
      ),
    ],
    [
      's2',
      parse(
        `kamishibai: '4.0'\nassets:\n${remoteVideo('C', 3)}scenes:\n  first:\n${show('c', 'C')}`,
      ),
    ],
  ]);
  const results: Dsl4VideoPrefetchResult[] = [];
  const prefetch = createDsl4PublicationVideoPrefetch({
    manifest: manifest(3, (i) => (i === 0 ? ['s1', 's2'] : [])),
    async loadDocument(segmentId) {
      return documents.get(segmentId)!;
    },
    async resolveRemoteVideo(target) {
      if (target.assetId === 'A') throw new Error('network down');
    },
    onResult(result) {
      results.push(result);
      throw new Error('observer failures are isolated');
    },
  });
  const summary = await prefetch.prefetchNext('s0');
  assert.deepEqual(
    summary.map(({segmentId, assetId, status}) => [segmentId, assetId, status]),
    [
      ['s1', 'A', 'failed'],
      ['s1', 'B', 'ready'],
      ['s2', 'C', 'ready'],
    ],
  );
  assert.match(String(summary[0]!.error), /network down/u);
  assert.equal(results.length, 3);
  assert.deepEqual(await prefetch.prefetchNext('s2'), [], 'a final segment has nothing to warm');
});

test('cancelling or superseding a prefetch aborts its reads and reports them as cancelled', async () => {
  const document = parse(
    `kamishibai: '4.0'\nassets:\n${remoteVideo('A', 1)}${remoteVideo('B', 2)}scenes:\n  first:\n${show('a', 'A')}${show('b', 'B')}`,
  );
  const signals: AbortSignal[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const prefetch = createDsl4PublicationVideoPrefetch({
    manifest: manifest(2, (i) => (i === 0 ? ['s1'] : [])),
    async loadDocument() {
      return document;
    },
    async resolveRemoteVideo(_target, signal) {
      signals.push(signal);
      await blocked;
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    },
  });
  const first = prefetch.prefetchNext('s0');
  await new Promise((resolve) => setImmediate(resolve));
  const second = prefetch.prefetchNext('s0');
  assert.equal(signals[0]!.aborted, true, 'a new prefetch supersedes the previous one');
  await new Promise((resolve) => setImmediate(resolve));
  prefetch.cancel('transition');
  release();
  assert.deepEqual(
    (await first).map((result) => result.status),
    ['cancelled', 'cancelled'],
  );
  assert.deepEqual(
    (await second).map((result) => result.status),
    ['cancelled', 'cancelled'],
  );
  assert.throws(() => prefetch.prefetchNext('missing'), /Unknown publication segment/u);
});

const identity = (id: string) =>
  Object.freeze({id, label: 'story.yaml', databaseName: `tw-kamishibai-assets-v1--story--${id}`});
const cacheOptions = (indexedDB: IDBFactory) => ({
  indexedDB,
  subtleCrypto: globalThis.crypto.subtle,
  estimateStorage: async () => ({quota: 64 * 1024 * 1024, usage: 0}),
});

function fakeNetwork() {
  const network = {
    up: true,
    videoReads: 0,
    sourceReads: 0,
    files: new Map<string, Uint8Array>(),
    async loadRemoteAsset(payload: Readonly<Record<string, unknown>>) {
      network.videoReads++;
      if (!network.up) throw new Error('offline network');
      const bytes = network.files.get(String(payload.url));
      if (!bytes) throw new Error('not found');
      return {bytes: new Uint8Array(bytes), contentType: 'video/webm'};
    },
    async fetchSource(input: string | URL | Request) {
      network.sourceReads++;
      if (!network.up) throw new Error('offline network');
      const bytes = network.files.get(String(input));
      if (!bytes) return new Response(null, {status: 404});
      return new Response(new Uint8Array(bytes));
    },
  };
  for (const marker of [1, 2, 3, 4]) network.files.set(url(marker), movie(marker));
  return network;
}

test('prefetch stores verified bytes in the segment cache so a later read needs no network', async () => {
  const indexedDB = new IDBFactory();
  const network = fakeNetwork();
  const resolve = createDsl4VerifiedVideoPrefetchResolver({
    loadRemoteAsset: network.loadRemoteAsset,
    cacheIdentityFor: () => identity('segment-one'),
    verifiedRemoteCacheOptions: cacheOptions(indexedDB),
  });
  const target = {
    segmentId: 's1',
    assetId: 'A',
    url: url(1),
    integrity: hex(movie(1)),
    size: 5,
    contentType: 'video/webm',
  };
  assert.deepEqual(await resolve(target, new AbortController().signal), {
    source: 'network',
    cacheWrite: 'stored',
  });
  network.up = false;
  const session = createVerifiedRemoteBinaryCache({
    ...cacheOptions(indexedDB),
    cacheIdentity: identity('segment-one'),
  });
  const hit = await session.resolve(target, {
    load: () => Promise.reject(new Error('must not reach the network')),
  });
  assert.equal(hit.source, 'indexeddb');
  assert.deepEqual([...hit.bytes], [...movie(1)]);
  await session.releaseStoryCacheLease();
  // Tampered bytes never reach the cache.
  network.up = true;
  network.files.set(url(2), movie(99));
  await assert.rejects(
    resolve(
      {...target, assetId: 'B', url: url(2), integrity: hex(movie(2))},
      new AbortController().signal,
    ),
  );
  await assert.rejects(
    createDsl4VerifiedVideoPrefetchResolver({
      loadRemoteAsset: network.loadRemoteAsset,
      cacheIdentityFor: () => undefined,
    })(target, new AbortController().signal),
    {code: 'K4-PUBLICATION-PREFETCH-001'},
  );
});

/**
 * Two-chapter publications in each distribution mode. Chapter sources and remote videos come
 * from a fake network; embedded videos and archive entries are local. Media, renderer and
 * IndexedDB are not browser-native here; the loader, groups, lifecycle, verified cache and
 * video Object URL owner are the production modules.
 */
async function modeFixture(mode: 'online' | 'hybrid' | 'offline') {
  const indexedDB = new IDBFactory();
  const network = fakeNetwork();
  const remoteVideos = mode !== 'offline';
  const sources = [0, 1].map(
    (i) => `kamishibai: '4.0'
assets:
${remoteVideos ? remoteVideo('Movie', i + 1) : embeddedVideo('Movie', i + 1)}${mode === 'hybrid' ? embeddedVideo('Local', i + 3) : ''}scenes:
  first:
${show('movie', 'Movie')}${mode === 'hybrid' ? show('local', 'Local') : ''}`,
  );
  const entryUrl = (i: number) => `https://cdn.example.com/s${i}.yaml`;
  sources.forEach((source, i) => network.files.set(entryUrl(i), new TextEncoder().encode(source)));
  const publication = validateDsl4PublicationManifest({
    formatVersion: 1,
    id: `mode-${mode}`,
    title: mode,
    entrySegment: 's0',
    entryPoints: ['s0'],
    segments: sources.map((source, i) => ({
      id: `s${i}`,
      title: `S${i}`,
      next: i === 0 ? ['s1'] : [],
      source: {
        entry: `s${i}.yaml`,
        size: new TextEncoder().encode(source).length,
        integrity: hex(source),
        ...(mode === 'offline' ? {} : {url: entryUrl(i)}),
      },
    })),
  });
  const liveUrls = new Set<string>();
  let ordinal = 0;
  const video = createDsl4VideoAssetAdapter({
    createObjectURL() {
      const objectUrl = `blob:mode-${++ordinal}`;
      liveUrls.add(objectUrl);
      return objectUrl;
    },
    revokeObjectURL(objectUrl) {
      liveUrls.delete(objectUrl);
    },
  });
  const ids = ['segment-zero', 'segment-one'];
  let gate: Promise<void> | null = null;
  const provider = createDsl4PublicationSourceProvider({
    mode,
    fetchSource: network.fetchSource as typeof globalThis.fetch,
    async readEntry(entry) {
      // Hybrid falls back to the archive when the network fails; online never reads it.
      const index = Number(entry.slice(1, -5));
      return new TextEncoder().encode(sources[index]!);
    },
  });
  const loader = createDsl4PublicationAssetLoader({
    manifest: publication,
    provider,
    frontend,
    videoAssetAdapter: video,
    async createSegmentSession(segment, document, _signal, owners) {
      const index = Number(segment.id.slice(1));
      const assets = document.assets as Record<string, Record<string, unknown>>;
      const lifecycle = createDsl4EmbeddedAssetLifecycle({
        runtimeComponent: {
          storyDocument: document,
          assetBundle: {
            manifest: {
              formatVersion: 1,
              assets: Object.keys(assets)
                .sort()
                .map((id) => {
                  const asset = assets[id]!;
                  if (asset.delivery === 'remote')
                    return {
                      id,
                      kind: 'video',
                      loading: 'lazy',
                      source: {type: 'remote', ...(asset.source as object)},
                    };
                  const bytes = movie(Number(String(asset.file).match(/\d+/u)![0]));
                  return {
                    id,
                    kind: 'video',
                    loading: 'lazy',
                    source: {
                      type: 'file',
                      mode: 'file',
                      inputPath: asset.file,
                      files: [{path: asset.file, size: bytes.length, integrity: sri(bytes)}],
                    },
                  };
                }),
            },
          },
          getAssetFile: (_id: string, path: string) => movie(Number(path.match(/\d+/u)![0])),
        },
        adapter: owners.video,
        setLoading() {},
        async resolveVerifiedRemoteAsset(payload, context) {
          await gate;
          const cache = createVerifiedRemoteBinaryCache({
            ...cacheOptions(indexedDB),
            cacheIdentity: identity(ids[index]!),
          });
          try {
            return await cache.resolve(payload as never, {
              signal: context.signal as AbortSignal,
              load: (input) => network.loadRemoteAsset(input as never),
            });
          } finally {
            await cache.releaseStoryCacheLease();
          }
        },
      });
      return {
        value: lifecycle,
        lifecycle,
        dispose: () => lifecycle.release({reason: 'session-dispose'}),
      };
    },
  });
  const prefetch = createDsl4PublicationVideoPrefetch({
    manifest: publication,
    loadDocument: (segmentId, signal) => loader.prefetch(segmentId, signal),
    resolveRemoteVideo: createDsl4VerifiedVideoPrefetchResolver({
      loadRemoteAsset: network.loadRemoteAsset,
      cacheIdentityFor: (segmentId) => identity(ids[Number(segmentId.slice(1))]!),
      verifiedRemoteCacheOptions: cacheOptions(indexedDB),
    }),
  });
  return {
    loader,
    prefetch,
    network,
    liveUrls,
    hold() {
      let open!: () => void;
      gate = new Promise((resolve) => (open = resolve));
      return () => {
        gate = null;
        open();
      };
    },
  };
}

test('offline publications prepare and release chapter videos without any network read', async () => {
  const f = await modeFixture('offline');
  try {
    await f.loader.transition('s0');
    assert.equal(f.liveUrls.size, 1);
    assert.deepEqual(
      await f.prefetch.prefetchNext('s0'),
      [],
      'embedded videos are never prefetched',
    );
    await f.loader.transition('s1');
    assert.equal(f.liveUrls.size, 1, 'the previous chapter video was released');
  } finally {
    await f.loader.dispose();
  }
  assert.equal(f.liveUrls.size, 0);
  assert.deepEqual([f.network.sourceReads, f.network.videoReads], [0, 0]);
});

test('online prefetch lets the next chapter start after the network drops', async () => {
  const f = await modeFixture('online');
  try {
    await f.loader.transition('s0');
    const summary = await f.prefetch.prefetchNext('s0');
    assert.deepEqual(
      summary.map((result) => [result.assetId, result.status]),
      [['Movie', 'ready']],
    );
    const reads = f.network.videoReads;
    f.network.up = false;
    // The document is already cached and the video is a verified cache hit.
    await f.loader.transition('s1');
    assert.equal(f.network.videoReads, reads, 'the transition read no video from the network');
    assert.equal(f.liveUrls.size, 1);
  } finally {
    await f.loader.dispose();
  }
  assert.equal(f.liveUrls.size, 0);
});

test('online transition without prefetch fails while offline, keeps the playing chapter and retries', async () => {
  const f = await modeFixture('online');
  try {
    await f.loader.transition('s0');
    const playing = [...f.liveUrls];
    // Only the document is cached, so the failure comes from the remote video.
    await f.loader.prefetch('s1');
    f.network.up = false;
    const reads = f.network.videoReads;
    await assert.rejects(f.loader.transition('s1'), /offline network/u);
    assert.equal(f.network.videoReads, reads + 1);
    assert.equal(f.loader.getCurrent()!.segmentId, 's0');
    assert.deepEqual([...f.liveUrls], playing, 'the current chapter video is untouched');
    f.network.up = true;
    await f.loader.transition('s1');
    assert.equal(f.loader.getCurrent()!.segmentId, 's1');
    assert.equal(f.liveUrls.size, 1);
    assert.notDeepEqual([...f.liveUrls], playing);
  } finally {
    await f.loader.dispose();
  }
  assert.equal(f.liveUrls.size, 0);
});

test('hybrid falls back to archive sources, warms only remote videos and cancels cleanly', async () => {
  const f = await modeFixture('hybrid');
  try {
    f.network.up = false;
    await assert.rejects(f.loader.transition('s0'), 'remote videos still need their bytes');
    f.network.up = true;
    await f.loader.transition('s0');
    assert.equal(f.liveUrls.size, 2, 'one remote and one embedded video');
    const summary = await f.prefetch.prefetchNext('s0');
    assert.deepEqual(
      summary.map((result) => [result.assetId, result.status]),
      [['Movie', 'ready']],
      'embedded videos are not prefetch targets',
    );
    // A cancelled candidate is released and the current chapter keeps both videos.
    const open = f.hold();
    const controller = new AbortController();
    const pending = f.loader.transition('s1', {signal: controller.signal});
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    open();
    await assert.rejects(pending, {name: 'AbortError'});
    assert.equal(f.loader.getCurrent()!.segmentId, 's0');
    assert.equal(f.liveUrls.size, 2);
    f.network.up = false;
    await f.loader.transition('s1');
    assert.equal(f.liveUrls.size, 2);
  } finally {
    await f.loader.dispose();
  }
  assert.equal(f.liveUrls.size, 0);
});
