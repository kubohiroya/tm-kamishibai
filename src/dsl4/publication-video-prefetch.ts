import {createDsl4AssetDependencyIndex} from './asset-dependency-index.js';
import type {Dsl4PublicationManifestV1} from './publication-manifest.js';
import {deepFreeze} from './story-document.js';

/** One integrity-pinned remote video that a segment's entry scene needs. */
export interface Dsl4VideoPrefetchTarget {
  readonly segmentId: string;
  readonly assetId: string;
  readonly url: string;
  readonly integrity: string;
  readonly size: number;
  readonly contentType: string;
}

export interface Dsl4VideoPrefetchResult {
  readonly segmentId: string;
  readonly assetId: string | null;
  readonly status: 'ready' | 'failed' | 'cancelled';
  readonly error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Remote videos with a verified source that the segment's entry scene and startup need.
 * Embedded videos are already local, so they are never prefetch targets.
 */
export function dsl4SegmentVideoPrefetchTargets(
  segmentId: string,
  storyDocument: Readonly<Record<string, unknown>>,
): readonly Dsl4VideoPrefetchTarget[] {
  const scenes = storyDocument.scenes as readonly {id: string}[];
  const entry = scenes[0];
  if (!entry) return Object.freeze([]);
  const index = createDsl4AssetDependencyIndex(storyDocument);
  const assets = isRecord(storyDocument.assets) ? storyDocument.assets : {};
  const ids = [...new Set([...index.startup, ...(index.scenes[entry.id]?.all ?? [])])].sort();
  const targets: Dsl4VideoPrefetchTarget[] = [];
  for (const assetId of ids) {
    const asset = assets[assetId];
    if (!isRecord(asset) || asset.kind !== 'video' || asset.delivery !== 'remote') continue;
    const source = asset.source;
    if (
      !isRecord(source) ||
      typeof source.url !== 'string' ||
      typeof source.integrity !== 'string' ||
      !Number.isSafeInteger(source.size) ||
      typeof source.contentType !== 'string'
    )
      continue;
    targets.push({
      segmentId,
      assetId,
      url: source.url,
      integrity: source.integrity,
      size: source.size as number,
      contentType: source.contentType,
    });
  }
  return deepFreeze(targets);
}

/**
 * Warm the verified store for the segments the current one links to, without materializing.
 * Prefetch is advisory: failures are reported, never thrown, and a later transition resolves
 * each asset again. Starting a new prefetch or cancelling aborts the previous one.
 */
export function createDsl4PublicationVideoPrefetch({
  manifest,
  loadDocument,
  resolveRemoteVideo,
  onResult,
}: {
  manifest: Readonly<Dsl4PublicationManifestV1>;
  /** Load and validate the complete segment document, e.g. the publication loader's prefetch. */
  loadDocument: (
    segmentId: string,
    signal: AbortSignal,
  ) => Promise<Readonly<Record<string, unknown>>>;
  /** Verify and store the bytes in the cache the segment session reads; discard the result. */
  resolveRemoteVideo: (target: Dsl4VideoPrefetchTarget, signal: AbortSignal) => Promise<unknown>;
  onResult?: (result: Dsl4VideoPrefetchResult) => void;
}) {
  let controller: AbortController | null = null;
  function report(results: Dsl4VideoPrefetchResult[], result: Dsl4VideoPrefetchResult) {
    const frozen = Object.freeze(result);
    results.push(frozen);
    try {
      onResult?.(frozen);
    } catch {
      // Observers are diagnostic only and cannot affect prefetching.
    }
  }
  async function run(segmentIds: readonly string[], signal: AbortSignal) {
    const results: Dsl4VideoPrefetchResult[] = [];
    for (const segmentId of segmentIds) {
      if (signal.aborted) {
        report(results, {segmentId, assetId: null, status: 'cancelled'});
        continue;
      }
      let targets: readonly Dsl4VideoPrefetchTarget[];
      try {
        targets = dsl4SegmentVideoPrefetchTargets(segmentId, await loadDocument(segmentId, signal));
      } catch (error) {
        report(results, {
          segmentId,
          assetId: null,
          status: signal.aborted ? 'cancelled' : 'failed',
          ...(signal.aborted ? {} : {error: String(error)}),
        });
        continue;
      }
      for (const target of targets) {
        if (signal.aborted) {
          report(results, {segmentId, assetId: target.assetId, status: 'cancelled'});
          continue;
        }
        try {
          await resolveRemoteVideo(target, signal);
          report(results, {segmentId, assetId: target.assetId, status: 'ready'});
        } catch (error) {
          report(results, {
            segmentId,
            assetId: target.assetId,
            status: signal.aborted ? 'cancelled' : 'failed',
            ...(signal.aborted ? {} : {error: String(error)}),
          });
        }
      }
    }
    return Object.freeze(results);
  }
  return Object.freeze({
    /** Prefetch every segment that `segmentId` links to through `next`. */
    prefetchNext(segmentId: string) {
      const segment = manifest.segments.find((item) => item.id === segmentId);
      if (!segment) throw new TypeError('Unknown publication segment');
      controller?.abort('publication-prefetch-superseded');
      const current = new AbortController();
      controller = current;
      return run(segment.next, current.signal).finally(() => {
        if (controller === current) controller = null;
      });
    },
    cancel(reason: string = 'publication-prefetch-cancelled') {
      controller?.abort(reason);
      controller = null;
    },
  });
}
