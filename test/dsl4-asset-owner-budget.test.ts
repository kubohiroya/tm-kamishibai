import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {test} from 'vitest';

import {
  createDsl4EmbeddedAssetBundle,
  validateDsl4EmbeddedAssetBundle,
} from '../src/dsl4/asset-bundle-descriptor.js';
import {createDsl4AssetGroupLifecycle} from '../src/dsl4/asset-group-lifecycle.js';
import {
  createDsl4EmbeddedAssetLifecycle,
  type Dsl4MaterializationRetention,
} from '../src/dsl4/embedded-asset-lifecycle.js';
import {createDsl4PublicationAssetLoader} from '../src/dsl4/publication-asset-loader.js';
import {createDsl4PlatformAssetAdapter} from '../src/dsl4/platform/asset-adapter-router.js';
import {createDsl4AssetManagerAdapter} from '../src/dsl4/platform/asset-manager-adapter.js';
import {createDsl4ObjectUrlOwner} from '../src/dsl4/platform/object-url-owner.js';
import {createDsl4VideoAssetAdapter} from '../src/dsl4/platform/video-asset-adapter.js';
import {dsl4TestSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';

const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]);
const sri = (bytes: Uint8Array) => 'sha256-' + createHash('sha256').update(bytes).digest('base64');
const text = (value: string) => new TextEncoder().encode(value);

/** One fixture file per asset; recognition models are directories of two files. */
type FixtureAsset = {
  id: string;
  kind: string;
  target?: string;
  files: Record<string, Uint8Array>;
};

async function component(source: string, assets: readonly FixtureAsset[]) {
  const parsed = frontend.parse(source);
  assert(parsed.ok, JSON.stringify(parsed.diagnostics));
  const options = {maxFiles: 64, maxTotalBytes: 1 << 20, subtleCrypto: webcrypto.subtle};
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const declared = parsed.storyDocument.assets as Record<string, {loading?: string}>;
  const descriptor = await createDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    {
      manifest: {
        formatVersion: 1,
        // Bundles require the canonical asset ID order.
        assets: [...assets]
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map((asset) => {
            const paths = Object.keys(asset.files);
            const directory = asset.kind === 'recognitionModel';
            return {
              id: asset.id,
              kind: asset.kind,
              ...(asset.target ? {target: asset.target} : {}),
              loading: declared[asset.id]?.loading ?? 'eager',
              source: {
                type: 'file',
                mode: directory ? 'directory' : 'file',
                inputPath: directory ? `pose-models/${asset.id}` : paths[0],
                files: paths.map((path) => ({
                  path,
                  size: asset.files[path]!.length,
                  integrity: sri(asset.files[path]!),
                })),
              },
            };
          }),
      },
      getFile: (id: string, path: string) => new Uint8Array(byId.get(id)!.files[path]!),
    },
    options,
  );
  const validated = await validateDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    descriptor,
    options,
  );
  return {
    storyDocument: parsed.storyDocument,
    assetBundle: validated.descriptor,
    getAssetFile: validated.getFile,
  };
}

/**
 * Fake platform owners that record what each real kind would hold: renderer skins (GPU texture)
 * for costumes and backdrops, decoded AudioBuffers for sounds, registered pose models, and
 * Object URLs. The routing, leases and lifecycle around them are the production modules.
 */
function platformOwners(
  objectUrls = createDsl4ObjectUrlOwner(urlFunctions()),
  videoAdapter = createDsl4VideoAssetAdapter({objectUrlOwner: objectUrls}),
) {
  const skins = new Set<string>();
  const audioBuffers = new Set<string>();
  const poseModels = new Set<string>();
  const composition = {
    registerProjectAsset() {
      throw new Error('project assets are not used here');
    },
    registerEmbeddedAsset(input: {name: string; sourceName: string}) {
      const audio = input.sourceName.endsWith('.wav');
      (audio ? audioBuffers : skins).add(input.name);
      return {name: input.name, mimeType: audio ? 'audio/wav' : 'image/svg+xml'};
    },
    releaseAsset(name: string) {
      skins.delete(name);
      audioBuffers.delete(name);
    },
  };
  const adapter = createDsl4PlatformAssetAdapter({
    mediaAdapter: createDsl4AssetManagerAdapter({composition, objectUrlOwner: objectUrls}),
    poseAdapter: {
      prepare(payload: {asset: {id: string}}) {
        poseModels.add(payload.asset.id);
        return {pose: payload.asset.id};
      },
      release(resource: {pose: string}) {
        poseModels.delete(resource.pose);
      },
    },
    videoAdapter,
  });
  return {adapter, objectUrls, skins, audioBuffers, poseModels};
}

function urlFunctions() {
  let ordinal = 0;
  const live = new Set<string>();
  return {
    live,
    createObjectURL() {
      const url = `blob:owner-${++ordinal}`;
      live.add(url);
      return url;
    },
    revokeObjectURL(url: string) {
      live.delete(url);
    },
  };
}

const context = (sceneId: string | null = null) =>
  Object.freeze({signal: new AbortController().signal, generation: 1, sceneId});

test('verified image integrity shares one Object URL across asset IDs until the last lease', () => {
  const urls = urlFunctions();
  const owner = createDsl4ObjectUrlOwner(urls);
  const bytes = text('<svg/>');
  const a = owner.acquireVerified(sri(bytes), bytes, 'image/svg+xml');
  const b = owner.acquireVerified(sri(bytes), bytes, 'image/svg+xml');
  const unverified = owner.acquireVerified(undefined, bytes, 'image/svg+xml');
  assert.equal(a.objectUrl, b.objectUrl);
  assert.notEqual(unverified.objectUrl, a.objectUrl);
  assert.deepEqual(owner.snapshot(), {urls: 2, leases: 3});
  owner.release(a);
  owner.release(a);
  assert.equal(urls.live.size, 2);
  owner.release(b);
  owner.release(unverified);
  assert.equal(urls.live.size, 0);
  assert.throws(() => createDsl4ObjectUrlOwner(urlFunctions()).release(a), /not owned/u);
});

test('two image assets with equal bytes keep one Object URL in the Asset Manager adapter', async () => {
  const urls = urlFunctions();
  const owners = platformOwners(createDsl4ObjectUrlOwner(urls));
  const bytes = text('<svg id="same"/>');
  const prepare = (id: string) =>
    owners.adapter.prepare(
      {
        asset: {id, kind: 'image', source: {type: 'file'}},
        files: [{path: `${id}.svg`, bytes, integrity: sri(bytes)}],
      },
      {},
    );
  const a = await prepare('A');
  const b = await prepare('B');
  assert.equal(a.objectUrl, b.objectUrl);
  assert.equal(urls.live.size, 1);
  await owners.adapter.release(a, {});
  assert.equal(urls.live.size, 1);
  await owners.adapter.release(b, {});
  assert.equal(urls.live.size, 0);
  assert.equal(owners.skins.size, 0);
});

const retentionSource = `kamishibai: '4.0'
assets:
  A: {kind: backdrop, file: a.svg, loading: lazy, retention: scene}
  B: {kind: backdrop, file: b.svg, loading: lazy, retention: scene}
  C: {kind: backdrop, file: c.svg, loading: lazy, retention: scene}
scenes:
  a:
    - stage: A
  b:
    - stage: B
  c:
    - stage: C
`;
const backdrop = (id: string, size: number) => ({
  id,
  kind: 'backdrop',
  files: {[`${id.toLowerCase()}.svg`]: text(`<svg>${'x'.repeat(size - 11)}</svg>`)},
});

async function retentionFixture(
  retention?: Dsl4MaterializationRetention,
  releaseFailure?: (assetId: string) => boolean,
) {
  const runtimeComponent = await component(retentionSource, [
    backdrop('A', 40),
    backdrop('B', 40),
    backdrop('C', 40),
  ]);
  const prepared: string[] = [];
  const released: string[] = [];
  const live = new Set<string>();
  const lifecycle = createDsl4EmbeddedAssetLifecycle({
    runtimeComponent,
    setLoading() {},
    ...(retention === undefined ? {} : {retention}),
    adapter: {
      prepare(payload) {
        const id = (payload.asset as {id: string}).id;
        prepared.push(id);
        live.add(id);
        return {id};
      },
      release(resource) {
        const id = (resource as {id: string}).id;
        if (releaseFailure?.(id)) throw new Error(`release ${id} failed`);
        released.push(id);
        live.delete(id);
      },
    },
  });
  return {lifecycle, prepared, released, live};
}

test('without a retention budget a released handle is destroyed immediately', async () => {
  const f = await retentionFixture();
  await f.lifecycle.prepare({assetIds: ['A']}, context());
  await f.lifecycle.releaseAssets({assetIds: ['A'], reason: 'group-release'});
  assert.deepEqual(f.released, ['A']);
  assert.deepEqual(f.lifecycle.stats(), {
    activeEntries: 0,
    activeBytes: 0,
    idleEntries: 0,
    idleBytes: 0,
    retiredEntries: 0,
    maxIdleBytes: 0,
    maxIdleEntries: 0,
  });
});

test('retained handles are reused without rematerialization and evicted in LRU order', async () => {
  const f = await retentionFixture({maxIdleBytes: 80});
  await f.lifecycle.prepare({assetIds: ['A', 'B']}, context());
  assert.equal(f.lifecycle.stats().activeBytes, 80);
  await f.lifecycle.releaseAssets({assetIds: ['A'], reason: 'group-release'});
  await f.lifecycle.releaseAssets({assetIds: ['B'], reason: 'group-release'});
  assert.deepEqual(f.released, []);
  assert.equal(f.lifecycle.getResource('A'), null, 'idle handles have no owner');
  assert.deepEqual([f.lifecycle.stats().idleEntries, f.lifecycle.stats().idleBytes], [2, 80]);
  // Reuse A: it leaves the eviction order, so B becomes the least recently used.
  await f.lifecycle.prepare({assetIds: ['A']}, context());
  assert.deepEqual(f.prepared, ['A', 'B']);
  assert.deepEqual(f.lifecycle.getResource('A'), {id: 'A'});
  await f.lifecycle.prepare({assetIds: ['C']}, context());
  await f.lifecycle.releaseAssets({assetIds: ['C'], reason: 'group-release'});
  await f.lifecycle.releaseAssets({assetIds: ['A'], reason: 'group-release'});
  assert.deepEqual(f.released, ['B'], 'the least recently released handle is evicted first');
  assert.deepEqual([...f.live].sort(), ['A', 'C']);
  assert.equal(f.lifecycle.stats().idleBytes, 80);
  await f.lifecycle.prune();
  assert.deepEqual(f.live.size, 0);
  assert.equal(f.lifecycle.stats().idleEntries, 0);
});

test('entry limits, oversized handles and rollback never exceed the retention budget', async () => {
  const f = await retentionFixture({maxIdleBytes: 1000, maxIdleEntries: 1});
  await f.lifecycle.prepare({assetIds: ['A', 'B', 'C']}, context());
  await f.lifecycle.releaseAssets({assetIds: ['A', 'B'], reason: 'group-release'});
  assert.deepEqual(f.released, ['A']);
  await f.lifecycle.releaseAssets({assetIds: ['C'], reason: 'group-prepare-rollback'});
  assert.deepEqual(f.released, ['A', 'C'], 'rollback releases instead of retaining');
  const small = await retentionFixture({maxIdleBytes: 39});
  await small.lifecycle.prepare({assetIds: ['A']}, context());
  await small.lifecycle.releaseAssets({assetIds: ['A'], reason: 'group-release'});
  assert.deepEqual(small.released, ['A'], 'a handle larger than the budget is not retained');
});

test('failed eviction is reported, keeps the owner and is retried by prune', async () => {
  let fail = true;
  const f = await retentionFixture({maxIdleBytes: 40}, (id) => fail && id === 'A');
  await f.lifecycle.prepare({assetIds: ['A', 'B']}, context());
  await f.lifecycle.releaseAssets({assetIds: ['A'], reason: 'group-release'});
  await assert.rejects(
    f.lifecycle.releaseAssets({assetIds: ['B'], reason: 'group-release'}),
    AggregateError,
  );
  assert.deepEqual(f.lifecycle.stats().retiredEntries, 1);
  assert(f.live.has('A'));
  fail = false;
  await f.lifecycle.prune();
  assert.deepEqual(f.live.size, 0);
  assert.deepEqual(f.lifecycle.stats(), {
    activeEntries: 0,
    activeBytes: 0,
    idleEntries: 0,
    idleBytes: 0,
    retiredEntries: 0,
    maxIdleBytes: 40,
    maxIdleEntries: 1024,
  });
});

test('full release destroys retained handles and invalid budgets are rejected', async () => {
  const f = await retentionFixture({maxIdleBytes: 1000});
  await f.lifecycle.prepare({assetIds: ['A']}, context());
  await f.lifecycle.releaseAssets({assetIds: ['A'], reason: 'group-release'});
  assert.equal(f.live.size, 1);
  await f.lifecycle.release({reason: 'dispose'});
  assert.equal(f.live.size, 0);
  assert.equal(f.lifecycle.stats().idleEntries, 0);
  await assert.rejects(retentionFixture({maxIdleBytes: -1}), /non-negative/u);
  await assert.rejects(retentionFixture({maxIdleBytes: 1.5}), /non-negative/u);
});

const allKindsSource = (marker: number) => `kamishibai: '4.0'
assets:
  Back: {kind: backdrop, file: back.svg, loading: lazy, retention: scene}
  HeroIdle: {kind: costume, target: Hero, file: hero.svg}
  Bell: {kind: sound, file: bell.wav, loading: lazy, retention: scene}
  Movie: {kind: video, file: movie.webm, loading: lazy, retention: scene}
  RescuePose: {kind: recognitionModel, file: pose-models/RescuePose}
actors:
  Hero: HeroIdle
scenes:
  first:
    - stage: Back
    - sound: Bell
    - video: {id: movie${marker}, asset: Movie, x: 0, y: 0, width: 160, height: 120}
  second:
    recognitionModel: RescuePose
    actions:
      - Hero.pose:
          steps:
            - pose: help
`;
const allKindsAssets = (marker: number): FixtureAsset[] => [
  {id: 'Back', kind: 'backdrop', files: {'back.svg': text(`<svg id="b${marker}"/>`)}},
  {id: 'HeroIdle', kind: 'costume', target: 'Hero', files: {'hero.svg': text('<svg id="h"/>')}},
  {id: 'Bell', kind: 'sound', files: {'bell.wav': text(`RIFF-${marker}`)}},
  {id: 'Movie', kind: 'video', files: {'movie.webm': Uint8Array.from([...webm, marker])}},
  {
    id: 'RescuePose',
    kind: 'recognitionModel',
    files: {
      'metadata.json': text('{"labels":["help"]}'),
      'model.json': text(`{"m":${marker}}`),
    },
  },
];

test('group release leaves no GPU skin, AudioBuffer, pose model or Object URL behind', async () => {
  const urls = urlFunctions();
  const owners = platformOwners(createDsl4ObjectUrlOwner(urls));
  const lifecycle = createDsl4EmbeddedAssetLifecycle({
    runtimeComponent: await component(allKindsSource(1), allKindsAssets(1)),
    adapter: owners.adapter,
    setLoading() {},
  });
  const groups = createDsl4AssetGroupLifecycle({
    groups: [
      {
        id: 'all',
        scope: 'scene',
        assetIds: ['Back', 'HeroIdle', 'Bell', 'Movie', 'RescuePose'],
        dependencies: [],
      },
    ],
    lifecycle,
  });
  await groups.prepareGroup('all', context('first'));
  assert.deepEqual(
    [owners.skins.size, owners.audioBuffers.size, owners.poseModels.size, urls.live.size],
    [2, 1, 1, 1],
  );
  const result = await groups.releaseGroup('all', context('first'));
  assert.equal(result.cleanupError, null);
  assert.deepEqual(
    [owners.skins.size, owners.audioBuffers.size, owners.poseModels.size, urls.live.size],
    [0, 0, 0, 0],
  );
  await groups.dispose();
});

async function longPublication(count: number) {
  const urls = urlFunctions();
  const objectUrls = createDsl4ObjectUrlOwner(urls);
  const video = createDsl4VideoAssetAdapter({objectUrlOwner: objectUrls});
  const live = {skins: 0, audioBuffers: 0, poseModels: 0, urls: 0};
  const peak = {...live};
  const sessions: ReturnType<typeof platformOwners>[] = [];
  const sample = () => {
    live.skins = sessions.reduce((total, owner) => total + owner.skins.size, 0);
    live.audioBuffers = sessions.reduce((total, owner) => total + owner.audioBuffers.size, 0);
    live.poseModels = sessions.reduce((total, owner) => total + owner.poseModels.size, 0);
    live.urls = urls.live.size;
    for (const key of Object.keys(live) as (keyof typeof live)[])
      peak[key] = Math.max(peak[key], live[key]);
  };
  const documents = new Map<string, string>();
  const segments = Array.from({length: count}, (_, i) => {
    const source = allKindsSource(i);
    documents.set(`s${i}`, source);
    const bytes = text(source);
    return {
      id: `s${i}`,
      title: `章${i}`,
      next: i + 1 < count ? [`s${i + 1}`] : [],
      source: {
        entry: `segments/${i}.yaml`,
        size: bytes.length,
        integrity: 'sha256-' + createHash('sha256').update(bytes).digest('hex'),
      },
    };
  });
  const loader = createDsl4PublicationAssetLoader({
    manifest: {
      formatVersion: 1,
      id: 'long',
      title: '全資源の長編',
      entrySegment: 's0',
      entryPoints: ['s0'],
      segments,
    },
    frontend,
    videoAssetAdapter: video,
    maxCachedDocuments: 2,
    provider: {
      async read(segment) {
        return documents.get(segment.id)!;
      },
    },
    async createSegmentSession(segment, _document, _signal, shared) {
      const marker = Number(segment.id.slice(1));
      // Each chapter owns its own composition; the video owner is shared by the publication.
      const owners = platformOwners(objectUrls, shared.video);
      sessions.push(owners);
      const lifecycle = createDsl4EmbeddedAssetLifecycle({
        runtimeComponent: await component(allKindsSource(marker), allKindsAssets(marker)),
        adapter: owners.adapter,
        setLoading() {},
      });
      return {
        value: null,
        lifecycle: {
          async prepare(payload, ctx) {
            await lifecycle.prepare(payload, ctx);
            sample();
          },
          async releaseAssets(payload) {
            await lifecycle.releaseAssets(payload);
            sample();
          },
        },
        async dispose() {
          await lifecycle.release({reason: 'session-dispose'});
          sample();
        },
      };
    },
  });
  for (let i = 0; i < count; i++) {
    const result = await loader.transition(`s${i}`);
    assert.equal(result.cleanupError, null);
    const current = loader.getCurrent()!.prepared.value;
    await current.enterScene('second', context('second'));
    await current.enterScene('first', context('first'));
  }
  await loader.dispose();
  sample();
  return {peak, live};
}

test('long publications keep materialized resources bounded by two chapters, not by length', async () => {
  const short = await longPublication(4);
  const long = await longPublication(48);
  assert.deepEqual(long.peak, short.peak, 'peak residency does not grow with segment count');
  assert.deepEqual(
    Object.values(long.peak).map((value) => value > 0),
    [true, true, true, true],
    'every resource kind was materialized',
  );
  // At most the current chapter and the prepared candidate coexist.
  assert(long.peak.skins <= 4 && long.peak.audioBuffers <= 2 && long.peak.poseModels <= 2);
  assert(long.peak.urls <= 2);
  assert.deepEqual(long.live, {skins: 0, audioBuffers: 0, poseModels: 0, urls: 0});
});
