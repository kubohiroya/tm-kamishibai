import assert from 'node:assert/strict';
import {test} from 'vitest';
import {
  createDsl4AssetGroupLifecycle,
  createDsl4DefaultAssetGroups,
  type Dsl4AssetGroup,
} from '../src/dsl4/asset-group-lifecycle.js';
import {dsl4TestSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';

const context = () => ({signal: new AbortController().signal, generation: 1, sceneId: 'main'});
const groups: readonly Dsl4AssetGroup[] = [
  {id: 'shared', scope: 'shared', assetIds: ['Shared'], dependencies: []},
  {id: 'a', scope: 'scene', assetIds: ['A', 'Shared'], dependencies: ['shared']},
  {id: 'b', scope: 'scene', assetIds: ['B'], dependencies: ['shared']},
];
function fixture() {
  const live = new Set<string>(),
    prepared: string[][] = [],
    released: string[][] = [];
  let prepareFailure: Error | null = null,
    releaseFailure: Error | null = null;
  const lifecycle = {
    async prepare(payload: {assetIds: readonly string[]}, ctx: {signal: AbortSignal}) {
      prepared.push([...payload.assetIds]);
      for (const id of payload.assetIds) live.add(id);
      if (prepareFailure) throw prepareFailure;
      if (ctx.signal.aborted) throw new DOMException('cancel', 'AbortError');
    },
    releaseAssets(payload: {assetIds: readonly string[]}) {
      released.push([...payload.assetIds]);
      for (const id of payload.assetIds) live.delete(id);
      if (releaseFailure) throw releaseFailure;
    },
  };
  return {
    live,
    prepared,
    released,
    lifecycle,
    manager: createDsl4AssetGroupLifecycle({groups, lifecycle}),
    failPrepare(error: Error | null) {
      prepareFailure = error;
    },
    failRelease(error: Error | null) {
      releaseFailure = error;
    },
  };
}

test('DAG validation rejects duplicate groups, missing edges, and cycles before materialization', () => {
  const f = fixture();
  for (const invalid of [
    [...groups, groups[0]!],
    [{id: 'a', scope: 'scene' as const, assetIds: [], dependencies: ['missing']}],
    [
      {id: 'a', scope: 'scene' as const, assetIds: [], dependencies: ['b']},
      {id: 'b', scope: 'scene' as const, assetIds: [], dependencies: ['a']},
    ],
  ])
    assert.throws(() => createDsl4AssetGroupLifecycle({groups: invalid, lifecycle: f.lifecycle}));
  assert.deepEqual(f.prepared, []);
});

test('shared asset references survive release until the final group is gone', async () => {
  const f = fixture();
  await f.manager.prepareGroup('a', context());
  await f.manager.prepareGroup('b', context());
  await f.manager.prepareGroup('a', context());
  assert.deepEqual(f.manager.snapshot().assetReferences, {A: 1, Shared: 2, B: 1});
  assert.equal(f.prepared.length, 2);
  await f.manager.releaseGroup('a', context());
  assert.deepEqual([...f.live].sort(), ['B', 'Shared']);
  assert.deepEqual(f.released, [['A']]);
  await f.manager.releaseGroup('b', context());
  assert.equal(f.live.size, 0);
  await f.manager.dispose();
});

test('failed candidate preparation rolls back only new assets and preserves committed references', async () => {
  const f = fixture();
  await f.manager.prepareGroup('a', context());
  const previous = f.manager.snapshot();
  const failure = new Error('prepare');
  f.failPrepare(failure);
  await assert.rejects(f.manager.replaceGroups(['b'], context()), (error) => error === failure);
  assert.deepEqual(f.manager.snapshot(), previous);
  assert.deepEqual([...f.live].sort(), ['A', 'Shared']);
  assert.deepEqual(f.released, [['B']]);
  f.failPrepare(null);
  await f.manager.replaceGroups(['b'], context());
  assert.deepEqual([...f.live].sort(), ['B', 'Shared']);
  await f.manager.dispose();
});

test('cancellation during prepare rolls back candidates, and queued operations observe latest ownership', async () => {
  const f = fixture(),
    controller = new AbortController();
  const manager = createDsl4AssetGroupLifecycle({
    groups,
    lifecycle: {
      prepare(payload, ctx) {
        f.lifecycle.prepare(payload, ctx);
        controller.abort();
      },
      releaseAssets: f.lifecycle.releaseAssets,
    },
  });
  await assert.rejects(manager.prepareGroup('a', {...context(), signal: controller.signal}), {
    name: 'AbortError',
  });
  assert.equal(f.live.size, 0);
  assert.deepEqual(manager.snapshot().groupIds, []);
  await manager.dispose();
  await Promise.all([
    f.manager.prepareGroup('a', context()),
    f.manager.prepareGroup('b', context()),
    f.manager.releaseGroup('a', context()),
  ]);
  assert.deepEqual([...f.live].sort(), ['B', 'Shared']);
  await f.manager.dispose();
});

test('rollback failures report both errors while retaining old group ownership', async () => {
  const f = fixture();
  await f.manager.prepareGroup('a', context());
  f.failPrepare(new Error('prepare'));
  f.failRelease(new Error('rollback'));
  await assert.rejects(
    f.manager.replaceGroups(['b'], context()),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.deepEqual(f.manager.snapshot().groupIds, ['a']);
  f.failPrepare(null);
  f.failRelease(null);
  await f.manager.dispose();
});

test('cleanup failure is distinct from committed ownership and does not starve later operations', async () => {
  const f = fixture();
  await f.manager.prepareGroup('a', context());
  const failure = new Error('release');
  f.failRelease(failure);
  const result = await f.manager.replaceGroups(['b'], context());
  assert.equal(result.cleanupError, failure);
  assert.deepEqual(f.manager.snapshot().groupIds, ['b']);
  f.failRelease(null);
  await f.manager.dispose();
  await assert.rejects(f.manager.prepareGroup('a', context()), /disposed/u);
});

test('long group fixtures materialize only active roots rather than every defined segment', async () => {
  const live = new Set<string>();
  let peak = 0;
  const definitions = Array.from({length: 200}, (_, i) => ({
    id: `segment${i}`,
    scope: 'segment' as const,
    assetIds: [`Movie${i}`, 'Shared'],
    dependencies: [],
  }));
  const manager = createDsl4AssetGroupLifecycle({
    groups: definitions,
    lifecycle: {
      prepare({assetIds}) {
        for (const id of assetIds) live.add(id);
        peak = Math.max(peak, live.size);
      },
      releaseAssets({assetIds}) {
        for (const id of assetIds) live.delete(id);
      },
    },
  });
  for (const group of definitions) {
    await manager.replaceGroups([group.id], context());
    assert.equal(live.size, 2);
  }
  assert.equal(peak, 3);
  await manager.dispose();
  assert.equal(live.size, 0);
});

test('default groups separate lazy retention from boot and archive layout without source syntax changes', () => {
  const parsed = frontend.parse(
    "kamishibai: '4.0'\nassets:\n  Movie: {kind: video, file: movie.webm, loading: lazy, retention: scene}\n  Shared: {kind: video, file: shared.webm, loading: lazy}\nscenes:\n  a:\n    - video: {id: movie, asset: Movie, x: 0, y: 0, width: 20, height: 20}\n  b:\n    - video: {id: shared, asset: Shared, x: 0, y: 0, width: 20, height: 20}\n",
  );
  assert(parsed.ok);
  const definitions = createDsl4DefaultAssetGroups(parsed.storyDocument, 's0');
  assert(Object.isFrozen(definitions));
  assert.deepEqual(definitions.find((g) => g.id === 'segment:s0:boot')?.assetIds, []);
  assert.deepEqual(definitions.find((g) => g.id === 'segment:s0:scene:a')?.assetIds, ['Movie']);
  assert.deepEqual(definitions.find((g) => g.id === 'segment:s0:retained:b')?.assetIds, ['Shared']);
});
