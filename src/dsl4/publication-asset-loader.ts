import {createDsl4VideoAssetAdapter} from './platform/video-asset-adapter.js';
import {
  createDsl4DefaultAssetGroups,
  createDsl4AssetGroupLifecycle,
  type Dsl4GroupAssetLifecycle,
  type Dsl4GroupContext,
} from './asset-group-lifecycle.js';
import {createDsl4PublicationLoader} from './publication-loader.js';
import type {Dsl4PublicationSegment} from './publication-manifest.js';
import type {Dsl4SourceFrontend} from './source-frontend.js';

export interface Dsl4PublicationAssetSession<T> {
  readonly lifecycle: Dsl4GroupAssetLifecycle;
  readonly value: T;
  /** Dispose the session owner independently from group resource ownership. */
  dispose(): unknown;
}

/** Bind lazy publication transitions to generated retention groups and platform asset owners. */
export function createDsl4PublicationAssetLoader<T>({
  manifest,
  provider,
  frontend,
  createSegmentSession,
  maxCachedDocuments,
  videoAssetAdapter = createDsl4VideoAssetAdapter(),
}: {
  manifest: unknown;
  provider: {read(segment: Dsl4PublicationSegment, signal?: AbortSignal): Promise<string>};
  frontend: Dsl4SourceFrontend;
  createSegmentSession: (
    segment: Dsl4PublicationSegment,
    document: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    owners: Readonly<{video: ReturnType<typeof createDsl4VideoAssetAdapter>}>,
  ) => Promise<Dsl4PublicationAssetSession<T>>;
  maxCachedDocuments?: number;
  videoAssetAdapter?: ReturnType<typeof createDsl4VideoAssetAdapter>;
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
      const groups = createDsl4AssetGroupLifecycle({
        groups: definitions,
        lifecycle: session.lifecycle,
      });
      const retained = new Set<string>();
      const prefix = `segment:${segment.id}`;
      let closed = false;
      async function release() {
        if (closed) return;
        closed = true;
        await sceneQueue;
        const errors: unknown[] = [];
        try {
          await groups.dispose();
        } catch (error) {
          errors.push(error);
        }
        try {
          await session.dispose();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) throw new AggregateError(errors, 'Publication asset cleanup failed');
      }
      let sceneQueue = Promise.resolve();
      function enterScene(sceneId: string, context: Dsl4GroupContext) {
        const operation = sceneQueue.then(async () => {
          if (closed) throw new Error('Publication asset session is closed');
          if (!scenes.some((scene) => scene.id === sceneId))
            throw new TypeError('Unknown segment scene');
          const retainId = `${prefix}:retained:${sceneId}`;
          const result = await groups.replaceGroups(
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
      try {
        const first = scenes.find((scene) => scene.id === position.sceneId);
        if (!first) throw new TypeError('Segment contains no scenes');
        await enterScene(first.id, {
          signal: signal ?? new AbortController().signal,
          generation: 0,
          sceneId: first.id,
        });
      } catch (error) {
        try {
          await release();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Segment preparation and cleanup failed');
        }
        throw error;
      }
      return Object.freeze({
        value: Object.freeze({session: session.value, groups, enterScene}),
        release,
      });
    },
  });
}
