import {
  createDsl4CreationCleanup,
  cleanupDsl4FailedCreation,
  dsl4FailedCreationCleanupSteps,
} from './creation-cleanup.js';
import {
  createDsl4DefaultAssetGroups,
  createDsl4AssetGroupLifecycle,
  type Dsl4GroupAssetLifecycle,
  type Dsl4GroupContext,
} from './asset-group-lifecycle.js';
import {createDsl4RetryableCleanup} from './retryable-cleanup.js';
import {createDsl4PublicationLoader} from './publication-loader.js';
import type {Dsl4PublicationSegment} from './publication-manifest.js';
import type {Dsl4SourceFrontend} from './source-frontend.js';

export interface Dsl4PublicationAssetSession<T> {
  readonly lifecycle: Dsl4GroupAssetLifecycle;
  readonly value: T;
  /** Dispose the session owner independently from group resource ownership. */
  dispose(): unknown;
  hasPendingCleanup?(): boolean;
}

/** Bind lazy publication transitions to generated retention groups and platform asset owners. */
export function createDsl4PublicationAssetLoader<T, TVideoOwner>({
  manifest,
  provider,
  frontend,
  createSegmentSession,
  maxCachedDocuments,
  videoAssetAdapter,
}: {
  manifest: unknown;
  provider: {read(segment: Dsl4PublicationSegment, signal?: AbortSignal): Promise<string>};
  frontend: Dsl4SourceFrontend;
  createSegmentSession: (
    segment: Dsl4PublicationSegment,
    document: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    owners: Readonly<{video: TVideoOwner}>,
  ) => Promise<Dsl4PublicationAssetSession<T>>;
  maxCachedDocuments?: number;
  /** Opaque shared owner supplied by the platform, never imported by the core graph. */
  videoAssetAdapter: TVideoOwner;
}) {
  return createDsl4PublicationLoader({
    manifest,
    provider,
    frontend,
    ...(maxCachedDocuments === undefined ? {} : {maxCachedDocuments}),
    async prepare(segment, document, signal, position) {
      const definitions = createDsl4DefaultAssetGroups(document, segment.id);
      const scenes = document.scenes as readonly {id: string}[];
      const session = await createSegmentSession(
        segment,
        document,
        signal,
        Object.freeze({video: videoAssetAdapter}),
      );
      let groups: ReturnType<typeof createDsl4AssetGroupLifecycle> | null = null;
      const retained = new Set<string>();
      const prefix = `segment:${segment.id}`;
      let closed = false;
      let sceneQueue = Promise.resolve();
      const cleanup = createDsl4RetryableCleanup({
        message: 'Publication asset cleanup failed',
        steps: [
          async () => {
            await sceneQueue;
            await groups?.dispose();
          },
          {
            run: () => session.dispose(),
            isPending: () => session.hasPendingCleanup?.() ?? false,
          },
        ],
      });
      function release() {
        closed = true;
        return cleanup.run('publication-asset-release');
      }
      function enterScene(sceneId: string, context: Dsl4GroupContext) {
        const operation = sceneQueue.then(async () => {
          if (closed) throw new Error('Publication asset session is closed');
          if (!scenes.some((scene) => scene.id === sceneId))
            throw new TypeError('Unknown segment scene');
          const retainId = `${prefix}:retained:${sceneId}`;
          const result = await groups!.replaceGroups(
            [`${prefix}:boot`, ...retained, retainId, `${prefix}:scene:${sceneId}`],
            context,
          );
          retained.add(retainId);
          return result;
        });
        sceneQueue = operation.then(
          () => {},
          () => {},
        );
        return operation;
      }
      let cleanupError: unknown = null;
      try {
        groups = createDsl4AssetGroupLifecycle({groups: definitions, lifecycle: session.lifecycle});
        const first = scenes.find((scene) => scene.id === position.sceneId);
        if (!first) throw new TypeError('Segment contains no scenes');
        await groups.prepareGroup(`${prefix}:startup`, {
          signal: signal ?? new AbortController().signal,
          generation: 0,
          sceneId: null,
        });
        const entry = await enterScene(first.id, {
          signal: signal ?? new AbortController().signal,
          generation: 0,
          sceneId: first.id,
        });
        cleanupError = entry.cleanupError;
      } catch (error) {
        const failed = createDsl4CreationCleanup(
          [
            ...dsl4FailedCreationCleanupSteps(error),
            {run: release, isPending: cleanup.hasPendingCleanup},
          ],
          'Segment preparation cleanup failed',
        );
        await cleanupDsl4FailedCreation(
          error,
          failed,
          'segment-preparation-failed',
          'Segment preparation and cleanup failed',
        );
        throw error;
      }
      return Object.freeze({
        value: Object.freeze({session: session.value, groups: groups!, enterScene}),
        cleanupError,
        hasPendingCleanup: cleanup.hasPendingCleanup,
        release,
      });
    },
  });
}
