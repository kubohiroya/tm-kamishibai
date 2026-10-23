import {createDsl4AssetDependencyIndex} from './asset-dependency-index.js';
import {
  createDsl4AssetGroupLifecycle,
  createDsl4DefaultAssetGroups,
} from './asset-group-lifecycle.js';
import type {Dsl4AssetPreloadLifecycle, Readiness} from './asset-preload-coordinator.js';

/** Give the controller timing authority while groups exclusively own materialized assets. */
export function createDsl4GroupPreloadCoordinator({
  storyDocument,
  segmentId,
  lifecycle,
  excludedStartupAssetIds = [],
  persistentAssetIds = [],
  onEvent = () => {},
}: {
  storyDocument: Readonly<Record<string, unknown>>;
  segmentId: string;
  excludedStartupAssetIds?: readonly string[];
  persistentAssetIds?: readonly string[];
  lifecycle: Dsl4AssetPreloadLifecycle;
  onEvent?: (type: string, details: Record<string, unknown>) => void;
}) {
  const prefix = `segment:${segmentId}`;
  const index = createDsl4AssetDependencyIndex(storyDocument);
  const definitions = createDsl4DefaultAssetGroups(storyDocument, segmentId).map((group) => ({
    ...group,
    assetIds:
      group.id === `${prefix}:shared`
        ? group.assetIds.filter((id) => !excludedStartupAssetIds.includes(id))
        : group.id.startsWith(`${prefix}:retained:`)
          ? [
              ...new Set([
                ...group.assetIds,
                ...(index.scenes[group.id.slice(`${prefix}:retained:`.length)]?.all.filter((id) =>
                  persistentAssetIds.includes(id),
                ) ?? []),
              ]),
            ]
          : group.assetIds,
  }));
  const loadingAssetIds = index.loading.filter((id) => !excludedStartupAssetIds.includes(id));
  definitions.push({
    id: `${prefix}:loading`,
    scope: 'shared',
    assetIds: [...loadingAssetIds],
    dependencies: [],
  });
  let groups = createDsl4AssetGroupLifecycle({groups: definitions, lifecycle});
  let committed = new Set<string>();
  type Preparation = {
    phase: 'startup' | 'scene';
    sceneId: string | null;
    abort: AbortController;
    promise: Promise<Readiness>;
  };
  let pending: Preparation | null = null;
  let cleanup = Promise.resolve();
  let releasing: Promise<void> | null = null;
  const context = (signal: AbortSignal, generation: number, sceneId: string | null) => ({
    signal,
    generation,
    sceneId,
  });
  const freshContext = () => context(new AbortController().signal, 0, null);
  function cancel(reason: string) {
    const previous = pending;
    if (!previous) return;
    previous.abort.abort(reason);
    pending = null;
    cleanup = cleanup.then(async () => {
      await previous.promise;
      const result = await groups.replaceGroups([...committed], freshContext());
      if (result.cleanupError) throw result.cleanupError;
    });
    void cleanup.catch(() => {});
  }
  async function withLoading<T>(
    operation: () => Promise<T>,
    ctx: ReturnType<typeof context>,
    loading = storyDocument.loading ?? null,
  ): Promise<T> {
    try {
      await lifecycle.setLoading({visible: true, sceneId: ctx.sceneId, loading}, ctx);
      onEvent('assets.loading.show', {sceneId: ctx.sceneId});
      return await operation();
    } finally {
      await lifecycle.setLoading({visible: false, sceneId: ctx.sceneId, loading}, ctx);
      onEvent('assets.loading.hide', {sceneId: ctx.sceneId});
    }
  }
  return Object.freeze({
    prepareStartup(generation: number): Promise<Readiness> {
      cancel('startup-replaced');
      const abort = new AbortController();
      const candidate: Preparation = {
        phase: 'startup',
        sceneId: null,
        abort,
        promise: Promise.resolve({ok: true, prepared: false}),
      };
      pending = candidate;
      candidate.promise = (async (): Promise<Readiness> => {
        try {
          await releasing;
          await cleanup;
          if (abort.signal.aborted) return {ok: false, cancelled: true};
          const ctx = context(abort.signal, generation, null);
          // Bootstrap loading artwork before asking the presenter to use its URLs.
          if (loadingAssetIds.length) {
            await withLoading(() => groups.prepareGroup(`${prefix}:loading`, ctx), ctx, null);
          }
          const result = await withLoading(
            () => groups.replaceGroups([...committed, `${prefix}:boot`], ctx),
            ctx,
          );
          if (result.cleanupError) throw result.cleanupError;
          if (abort.signal.aborted) return {ok: false, cancelled: true};
          committed.add(`${prefix}:boot`);
          if (pending === candidate) pending = null;
          onEvent('assets.startup.ready', {});
          return {ok: true, prepared: true};
        } catch (error) {
          return abort.signal.aborted
            ? {ok: false, cancelled: true}
            : {ok: false, cancelled: false, error};
        }
      })();
      return candidate.promise;
    },
    beginScene(sceneId: string, generation: number) {
      cancel('scene-superseded');
      const abort = new AbortController();
      const candidate: Preparation = {
        phase: 'scene',
        sceneId,
        abort,
        promise: Promise.resolve<Readiness>({ok: true, prepared: false}),
      };
      pending = candidate;
      candidate.promise = (async (): Promise<Readiness> => {
        try {
          await cleanup;
          const ctx = context(abort.signal, generation, sceneId);
          if (abort.signal.aborted) return {ok: false, cancelled: true};
          const result = await withLoading(
            () =>
              groups.replaceGroups(
                [...committed, `${prefix}:retained:${sceneId}`, `${prefix}:scene:${sceneId}`],
                ctx,
              ),
            ctx,
          );
          if (result.cleanupError) throw result.cleanupError;
          if (abort.signal.aborted) return {ok: false, cancelled: true};
          onEvent('assets.scene.ready', {sceneId});
          return {ok: true, prepared: true};
        } catch (error) {
          return abort.signal.aborted
            ? {ok: false, cancelled: true}
            : {ok: false, cancelled: false, error};
        }
      })();
    },
    waitForScene(sceneId: string): Promise<Readiness> {
      return pending?.sceneId === sceneId
        ? pending.promise
        : Promise.resolve({ok: true, prepared: false});
    },
    async commitScene(sceneId: string, _reason: string) {
      if (!pending || pending.sceneId !== sceneId) throw new Error('No prepared asset group scene');
      const candidate = pending;
      const ready = await candidate.promise;
      if (!ready.ok || candidate !== pending) throw new Error('Asset group scene is not ready');
      const next = new Set([...committed].filter((id) => !id.startsWith(`${prefix}:scene:`)));
      next.add(`${prefix}:retained:${sceneId}`);
      next.add(`${prefix}:scene:${sceneId}`);
      const result = await groups.replaceGroups(
        [...next],
        context(candidate.abort.signal, 0, sceneId),
      );
      committed = next;
      pending = null;
      if (result.cleanupError) throw result.cleanupError;
    },
    cancel,
    snapshot: () => groups.snapshot(),
    release(reason: string) {
      if (releasing) return releasing;
      cancel(reason);
      releasing = (async () => {
        const errors: unknown[] = [];
        try {
          await cleanup;
        } catch (error) {
          errors.push(error);
        }
        try {
          await groups.dispose();
        } catch (error) {
          errors.push(error);
        }
        committed = new Set();
        groups = createDsl4AssetGroupLifecycle({groups: definitions, lifecycle});
        cleanup = Promise.resolve();
        try {
          await lifecycle.release({reason});
        } catch (error) {
          errors.push(error);
        }
        if (errors.length)
          throw new AggregateError(errors, 'Asset group coordinator cleanup failed');
      })().finally(() => {
        releasing = null;
      });
      // Controller stop/finish does not await cleanup; explicit owners still receive the rejection.
      void releasing.catch(() => {});
      return releasing;
    },
  });
}
