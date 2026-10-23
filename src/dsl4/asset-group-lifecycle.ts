import {createDsl4AssetDependencyIndex} from './asset-dependency-index.js';
import {deepFreeze} from './story-document.js';

export interface Dsl4AssetGroup {
  readonly id: string;
  readonly scope: 'boot' | 'shared' | 'segment' | 'scene';
  readonly assetIds: readonly string[];
  readonly dependencies: readonly string[];
}
export interface Dsl4GroupContext extends Readonly<Record<string, unknown>> {
  readonly signal: AbortSignal;
  readonly generation: number;
  readonly sceneId: string | null;
}
export interface Dsl4GroupAssetLifecycle {
  prepare(payload: Readonly<{assetIds: readonly string[]}>, context: Dsl4GroupContext): unknown;
  releaseAssets(
    payload: Readonly<{assetIds: readonly string[]; reason: string; sceneId: string | null}>,
  ): unknown;
}
const sorted = (ids: Iterable<string>) => [...new Set(ids)].sort();
function checkSignal(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Asset group preparation cancelled', 'AbortError');
}

/** Generate retention groups independently of archive layout and source-loading groups. */
export function createDsl4DefaultAssetGroups(
  storyDocument: Readonly<Record<string, unknown>>,
  segmentId: string,
): readonly Dsl4AssetGroup[] {
  const index = createDsl4AssetDependencyIndex(storyDocument);
  const prefix = `segment:${segmentId}`;
  const shared = sorted([...index.loading, ...index.actors, ...index.posePreviewControls]);
  const boot = sorted([...index.startup, ...index.cover]).filter(
    (id) => !shared.includes(id) && !index.sceneRetained.includes(id),
  );
  // Lazy story-retained resources are acquired when first used, rather than at startup.
  const segmentAssets = new Set<string>();
  const definitions: Dsl4AssetGroup[] = [
    {id: `${prefix}:shared`, scope: 'shared', assetIds: shared, dependencies: []},
    {id: `${prefix}:boot`, scope: 'boot', assetIds: boot, dependencies: [`${prefix}:shared`]},
    {
      id: `${prefix}:startup`,
      scope: 'boot',
      assetIds: sorted([...index.startup, ...index.cover]).filter(
        (id) => index.sceneRetained.includes(id) && !shared.includes(id),
      ),
      dependencies: [`${prefix}:boot`],
    },
  ];
  for (const [sceneId, scene] of Object.entries(index.scenes)) {
    const persistent = scene.all.filter(
      (id) => !index.sceneRetained.includes(id) && !boot.includes(id) && !shared.includes(id),
    );
    for (const id of persistent) segmentAssets.add(id);
    definitions.push({
      id: `${prefix}:retained:${sceneId}`,
      scope: 'segment',
      assetIds: persistent,
      dependencies: [],
    });
    definitions.push({
      id: `${prefix}:scene:${sceneId}`,
      scope: 'scene',
      assetIds: scene.all,
      dependencies: [`${prefix}:boot`, `${prefix}:retained:${sceneId}`],
    });
  }
  // This descriptor is available for explicit whole-segment prewarming, not acquired implicitly.
  definitions.push({
    id: prefix,
    scope: 'segment',
    assetIds: sorted(segmentAssets),
    dependencies: [`${prefix}:boot`],
  });
  return deepFreeze(definitions);
}

/** Own only resources acquired through this manager; serialize prepare/commit/release transactions. */
export function createDsl4AssetGroupLifecycle({
  groups,
  lifecycle,
}: {
  groups: readonly Dsl4AssetGroup[];
  lifecycle: Dsl4GroupAssetLifecycle;
}) {
  const definitions = new Map<string, Dsl4AssetGroup>();
  if (!Array.isArray(groups) || groups.length > 16384)
    throw new TypeError('Invalid asset group definitions');
  for (const group of groups) {
    if (
      !group ||
      typeof group.id !== 'string' ||
      !group.id ||
      definitions.has(group.id) ||
      !['boot', 'shared', 'segment', 'scene'].includes(group.scope) ||
      !Array.isArray(group.assetIds) ||
      group.assetIds.some((id: unknown) => typeof id !== 'string' || !id) ||
      !Array.isArray(group.dependencies) ||
      group.dependencies.some((id: unknown) => typeof id !== 'string')
    )
      throw new TypeError('Invalid or duplicate asset group');
    definitions.set(
      group.id,
      deepFreeze({
        id: group.id,
        scope: group.scope,
        assetIds: sorted(group.assetIds),
        dependencies: sorted(group.dependencies),
      }),
    );
  }
  const closures = new Map<string, readonly string[]>();
  const visiting = new Set<string>();
  function assetsOf(id: string): readonly string[] {
    const cached = closures.get(id);
    if (cached) return cached;
    const group = definitions.get(id);
    if (!group) throw new TypeError(`Unknown asset group: ${id}`);
    if (visiting.has(id)) throw new TypeError('Asset group dependency cycle');
    if (visiting.size >= 256) throw new TypeError('Asset group dependency depth exceeds limit');
    visiting.add(id);
    const result = sorted([...group.assetIds, ...group.dependencies.flatMap(assetsOf)]);
    visiting.delete(id);
    closures.set(id, result);
    return result;
  }
  for (const id of definitions.keys()) assetsOf(id);
  let roots = new Set<string>();
  let references = new Map<string, number>();
  const pendingRelease = new Set<string>();
  let queue = Promise.resolve();
  let disposed = false;
  let disposalRequested = false;
  function serial<R>(operation: () => Promise<R>) {
    const result = queue.then(operation);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function releaseUnowned(
    assetIds: readonly string[],
    reason: string,
    sceneId: string | null,
  ) {
    for (const id of assetIds) pendingRelease.add(id);
    // Cleanup may have succeeded only partially. Retry idempotently, excluding active owners.
    for (const id of references.keys()) pendingRelease.delete(id);
    const selected = sorted(pendingRelease);
    if (!selected.length) return;
    await lifecycle.releaseAssets(
      Object.freeze({assetIds: Object.freeze(selected), reason, sceneId}),
    );
    for (const id of selected) pendingRelease.delete(id);
  }
  async function replace(next: Set<string>, context: Dsl4GroupContext, closing = false) {
    if (disposed || (disposalRequested && !closing))
      throw new Error('Asset group lifecycle is disposed');
    checkSignal(context.signal);
    const nextReferences = new Map<string, number>();
    for (const groupId of next)
      for (const id of assetsOf(groupId)) nextReferences.set(id, (nextReferences.get(id) ?? 0) + 1);
    const added = [...nextReferences.keys()].filter((id) => !references.has(id));
    try {
      if (added.length)
        await lifecycle.prepare(Object.freeze({assetIds: Object.freeze(added)}), context);
      checkSignal(context.signal);
    } catch (failure) {
      // Failed prepare may have materialized a subset. Release only candidate-owned assets.
      try {
        await releaseUnowned(added, 'group-prepare-rollback', context.sceneId);
      } catch (cleanupError) {
        throw new AggregateError(
          [failure, cleanupError],
          'Asset group preparation and rollback failed',
        );
      }
      throw failure;
    }
    const removed = [...references.keys()].filter((id) => !nextReferences.has(id));
    roots = next;
    references = nextReferences;
    let cleanupError: unknown = null;
    try {
      await releaseUnowned(removed, 'group-release', context.sceneId);
    } catch (error) {
      cleanupError = error;
    }
    return Object.freeze({groupIds: Object.freeze([...roots]), cleanupError});
  }
  return Object.freeze({
    replaceGroups(groupIds: readonly string[], context: Dsl4GroupContext) {
      const next = new Set(groupIds);
      return serial(() => replace(next, context));
    },
    prepareGroup(groupId: string, context: Dsl4GroupContext) {
      return serial(() => replace(new Set([...roots, groupId]), context));
    },
    releaseGroup(groupId: string, context: Dsl4GroupContext) {
      return serial(() => replace(new Set([...roots].filter((id) => id !== groupId)), context));
    },
    snapshot() {
      return deepFreeze({
        groupIds: [...roots],
        assetReferences: Object.fromEntries(references),
        pendingReleaseAssetIds: sorted(pendingRelease),
      });
    },
    dispose() {
      return serial(async () => {
        if (disposed) return;
        disposalRequested = true;
        const result = await replace(
          new Set(),
          {signal: new AbortController().signal, generation: 0, sceneId: null},
          true,
        );
        if (result.cleanupError) throw result.cleanupError;
        disposed = true;
      });
    },
  });
}
