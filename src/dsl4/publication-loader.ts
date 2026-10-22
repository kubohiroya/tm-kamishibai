import type {Dsl4PublicationPosition} from './publication-manifest.js';
import type {Dsl4SourceFrontend} from './source-frontend.js';
import {
  createDsl4PublicationPosition,
  validateDsl4PublicationManifest,
  type Dsl4PublicationSegment,
} from './publication-manifest.js';

function checkSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Publication operation cancelled', 'AbortError');
}

async function verifySourceBytes(
  bytes: Uint8Array,
  segment: Dsl4PublicationSegment,
  subtleCrypto = globalThis.crypto.subtle,
) {
  if (bytes.byteLength !== segment.source.size) throw new TypeError('Segment size mismatch');
  const digest = new Uint8Array(await subtleCrypto.digest('SHA-256', new Uint8Array(bytes)));
  const integrity =
    'sha256-' + [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (integrity !== segment.source.integrity) throw new TypeError('Segment integrity mismatch');
}

/** Adapts an SB3/ZIP entry reader and/or HTTP sources without assuming the container layout. */
export function createDsl4PublicationSourceProvider({
  mode,
  readEntry,
  fetchSource = globalThis.fetch,
  subtleCrypto = globalThis.crypto.subtle,
}: {
  mode: 'online' | 'hybrid' | 'offline';
  readEntry?: (entry: string, signal?: AbortSignal) => Promise<Uint8Array | null>;
  fetchSource?: typeof globalThis.fetch;
  subtleCrypto?: SubtleCrypto;
}) {
  if (!['online', 'hybrid', 'offline'].includes(mode))
    throw new TypeError('Invalid publication distribution mode');
  async function verify(input: Uint8Array, segment: Dsl4PublicationSegment) {
    const bytes = new Uint8Array(input);
    await verifySourceBytes(bytes, segment, subtleCrypto);
    return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
  }
  return Object.freeze({
    async read(segment: Dsl4PublicationSegment, signal?: AbortSignal) {
      checkSignal(signal);
      let remoteFailure: unknown;
      if (mode !== 'offline' && segment.source.url) {
        try {
          const response = await fetchSource(segment.source.url, {
            signal: signal ?? null,
            credentials: 'omit',
          });
          if (!response.ok || !response.body) throw new Error('Segment source could not be read');
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let length = 0;
          try {
            for (;;) {
              checkSignal(signal);
              const {done, value} = await reader.read();
              if (done) break;
              length += value.byteLength;
              if (length > segment.source.size)
                throw new TypeError('Segment response exceeds declared size');
              chunks.push(value);
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          const source = await verify(bytes, segment);
          checkSignal(signal);
          return source;
        } catch (error) {
          checkSignal(signal);
          if (mode === 'online') throw error;
          remoteFailure = error;
        }
      }
      checkSignal(signal);
      const local = await readEntry?.(segment.source.entry, signal);
      checkSignal(signal);
      if (!local)
        throw new Error(
          'No verified offline segment source',
          remoteFailure === undefined ? undefined : {cause: remoteFailure},
        );
      const source = await verify(local, segment);
      checkSignal(signal);
      return source;
    },
  });
}

export interface Dsl4PreparedSegment<T> {
  readonly value: T;
  /** Must release only this candidate/committed segment's asset ownership. */
  release(): unknown;
}

/** Load and prepare a candidate before atomically publishing it as the current segment. */
export function createDsl4PublicationLoader<T>({
  manifest: input,
  provider,
  frontend,
  prepare,
  maxCachedDocuments = 2,
}: {
  manifest: unknown;
  provider: {read(segment: Dsl4PublicationSegment, signal?: AbortSignal): Promise<string>};
  frontend: Dsl4SourceFrontend;
  prepare: (
    segment: Dsl4PublicationSegment,
    document: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    position: Dsl4PublicationPosition,
  ) => Promise<Dsl4PreparedSegment<T>>;
  maxCachedDocuments?: number;
}) {
  const manifest = validateDsl4PublicationManifest(input);
  if (
    !Number.isSafeInteger(maxCachedDocuments) ||
    maxCachedDocuments < 1 ||
    maxCachedDocuments > 32
  )
    throw new TypeError('Document cache limit must be between 1 and 32');
  const cache = new Map<string, Readonly<Record<string, unknown>>>();
  let current: Readonly<{
    segmentId: string;
    document: Readonly<Record<string, unknown>>;
    prepared: Dsl4PreparedSegment<T>;
    position: ReturnType<typeof createDsl4PublicationPosition>;
  }> | null = null;
  let queue = Promise.resolve();
  let disposed = false;
  function serial<R>(operation: () => Promise<R>): Promise<R> {
    const result = queue.then(operation);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  function descriptor(segmentId: string) {
    const segment = manifest.segments.find((item) => item.id === segmentId);
    if (!segment) throw new TypeError('Unknown publication segment');
    return segment;
  }
  async function load(segment: Dsl4PublicationSegment, signal?: AbortSignal) {
    checkSignal(signal);
    if (disposed) throw new Error('Publication loader is disposed');
    const existing = cache.get(segment.id);
    if (existing) {
      cache.delete(segment.id);
      cache.set(segment.id, existing);
      return existing;
    }
    const source = await provider.read(segment, signal);
    checkSignal(signal);
    if (typeof source !== 'string' || source.length > segment.source.size)
      throw new TypeError('Segment source exceeds declared size');
    await verifySourceBytes(new TextEncoder().encode(source), segment);
    checkSignal(signal);
    const parsed = frontend.parse(source, {sourceId: segment.source.entry});
    if (!parsed.ok)
      throw new TypeError('Publication segment is not a valid complete DSL 4.0 document');
    cache.set(segment.id, parsed.storyDocument);
    while (cache.size > maxCachedDocuments) {
      const key = [...cache.keys()].find((id) => id !== current?.segmentId);
      if (key === undefined) break;
      cache.delete(key);
    }
    return parsed.storyDocument;
  }
  return Object.freeze({
    manifest,
    getCurrent() {
      return current;
    },
    getCachedSegmentIds() {
      return Object.freeze([...cache.keys()]);
    },
    prefetch(segmentId: string, signal?: AbortSignal) {
      return serial(async () => {
        await load(descriptor(segmentId), signal);
      });
    },
    transition(
      segmentId = manifest.entrySegment,
      options: {signal?: AbortSignal; sceneId?: string; actionPath?: string | null} = {},
    ) {
      return serial(async () => {
        const segment = descriptor(segmentId);
        checkSignal(options.signal);
        if (disposed) throw new Error('Publication loader is disposed');
        if (current && current.segmentId !== segmentId) {
          const previous = descriptor(current.segmentId);
          const offset = manifest.segments.findIndex((item) => item.id === current!.segmentId);
          const previousId = manifest.segments[offset - 1]?.id;
          if (
            !previous.next.includes(segmentId) &&
            previousId !== segmentId &&
            !manifest.entryPoints.includes(segmentId)
          )
            throw new TypeError('Segment is not a linked or public entry point');
        } else if (
          !current &&
          segmentId !== manifest.entrySegment &&
          !manifest.entryPoints.includes(segmentId)
        ) {
          throw new TypeError('Segment is not a public entry point');
        }
        const document = await load(segment, options.signal);
        const position = createDsl4PublicationPosition(
          segmentId,
          document,
          options.sceneId,
          options.actionPath ?? null,
        );
        const candidate = await prepare(segment, document, options.signal, position);
        try {
          checkSignal(options.signal);
        } catch (error) {
          try {
            await candidate.release();
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Cancelled segment cleanup failed');
          }
          throw error;
        }
        const previous = current;
        current = Object.freeze({segmentId, document, prepared: candidate, position});
        cache.delete(segmentId);
        cache.set(segmentId, document);
        while (cache.size > maxCachedDocuments) {
          const key = [...cache.keys()].find((id) => id !== segmentId)!;
          cache.delete(key);
        }
        // Cleanup cannot roll back an already-published transition; report it separately.
        let cleanupError: unknown = null;
        try {
          await previous?.prepared.release();
        } catch (error) {
          cleanupError = error;
        }
        return Object.freeze({current, cleanupError});
      });
    },
    dispose() {
      return serial(async () => {
        if (disposed) return;
        disposed = true;
        const previous = current;
        current = null;
        cache.clear();
        await previous?.prepared.release();
      });
    },
  });
}
