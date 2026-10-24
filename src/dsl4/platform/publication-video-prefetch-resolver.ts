import {createVerifiedRemoteBinaryCache} from '@kubohiroya/turbowarp-asset-cache/composition';

import {validateDsl4CacheIdentity} from '../cache-identity.js';
import type {Dsl4VideoPrefetchTarget} from '../publication-video-prefetch.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function prefetchError(code: string, message: string) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

/**
 * Store a segment's remote videos in the same verified IndexedDB cache its platform session
 * reads, so the later transition is a cache hit. Bytes are verified and then discarded here;
 * nothing is materialized and no Object URL is created.
 */
export function createDsl4VerifiedVideoPrefetchResolver({
  loadRemoteAsset,
  cacheIdentityFor,
  verifiedRemoteCacheOptions,
  createCache = createVerifiedRemoteBinaryCache,
}: {
  loadRemoteAsset: (
    payload: Readonly<Record<string, unknown>>,
    context: Readonly<Record<string, unknown>>,
  ) => unknown;
  /** The identity the segment's runtime host gives its platform session. */
  cacheIdentityFor: (segmentId: string) => unknown;
  verifiedRemoteCacheOptions?: Readonly<Record<string, unknown>> | undefined;
  createCache?: typeof createVerifiedRemoteBinaryCache;
}) {
  return async function resolveRemoteVideo(target: Dsl4VideoPrefetchTarget, signal: AbortSignal) {
    const identity = cacheIdentityFor(target.segmentId);
    if (identity === undefined || identity === null) {
      throw prefetchError(
        'K4-PUBLICATION-PREFETCH-001',
        `Segment ${target.segmentId} has no verified cache identity`,
      );
    }
    const cache = createCache({
      ...verifiedRemoteCacheOptions,
      cacheIdentity: validateDsl4CacheIdentity(identity),
    });
    try {
      const result = await cache.resolve(
        {
          url: target.url,
          integrity: target.integrity,
          size: target.size,
          contentType: target.contentType,
        },
        {
          signal,
          async load(input, context) {
            const loaded = await loadRemoteAsset(
              Object.freeze({assetId: target.assetId, ...input}),
              Object.freeze({signal: context.signal ?? signal}),
            );
            if (!isRecord(loaded) || !(loaded.bytes instanceof Uint8Array)) {
              throw new TypeError(`Remote video payload is invalid: ${target.assetId}`);
            }
            return {bytes: loaded.bytes, contentType: loaded.contentType};
          },
        },
      );
      if (result.source === 'network' && result.cacheWrite !== 'stored') {
        throw prefetchError(
          'K4-PUBLICATION-PREFETCH-002',
          `Remote video ${target.assetId} was verified but not stored (${result.cacheWrite})`,
        );
      }
      return Object.freeze({source: result.source, cacheWrite: result.cacheWrite});
    } finally {
      // Prefetch holds no runtime lease; the segment session acquires its own.
      await cache.releaseStoryCacheLease().catch(() => {});
    }
  };
}
