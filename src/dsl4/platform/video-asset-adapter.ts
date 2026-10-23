import {dsl4VideoContentType} from '../video-source.js';

/** Materialize video bytes without passing them to Scratch's image/audio decoder. */
export function createDsl4VideoAssetAdapter(
  options: {
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
  } = {},
) {
  if ((options.createObjectURL === undefined) !== (options.revokeObjectURL === undefined)) {
    throw new TypeError('createObjectURL and revokeObjectURL must be provided together');
  }
  const createUrl = options.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeUrl = options.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
  const entries = new Map<string, {objectUrl: string; references: number}>();
  const owned = new WeakMap<
    object,
    {key: string; entry: {objectUrl: string; references: number}}
  >();
  const released = new WeakSet<object>();
  return Object.freeze({
    async prepare(payload: unknown, context: unknown) {
      const {asset, files} = payload as {
        asset: {id: string; kind: string};
        files: {bytes: Uint8Array}[];
      };
      const signal = (context as {signal?: AbortSignal}).signal;
      if (signal?.aborted) throw new DOMException('Video preparation cancelled', 'AbortError');
      const input = files[0]?.bytes;
      const mimeType = input instanceof Uint8Array ? dsl4VideoContentType(input) : null;
      if (asset.kind !== 'video' || files.length !== 1 || !mimeType || !input) {
        throw new TypeError(`Video ${asset.id} requires one MP4 or WebM file`);
      }
      // Hash owned bytes rather than trusting caller-supplied integrity metadata.
      const bytes = new Uint8Array(input);
      const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
      const key =
        mimeType + ':' + [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (signal?.aborted) throw new DOMException('Video preparation cancelled', 'AbortError');
      let entry = entries.get(key);
      if (!entry) {
        const objectUrl = createUrl(new Blob([bytes.buffer], {type: mimeType}));
        if (typeof objectUrl !== 'string' || objectUrl.length === 0) {
          throw new TypeError('Video Object URL creation returned no URL');
        }
        if (signal?.aborted) {
          revokeUrl(objectUrl);
          throw new DOMException('Video preparation cancelled', 'AbortError');
        }
        entry = {objectUrl, references: 0};
        entries.set(key, entry);
      }
      const resource = Object.freeze({
        assetId: asset.id,
        kind: 'video',
        mimeType,
        objectUrl: entry.objectUrl,
      });
      entry.references++;
      owned.set(resource, {key, entry});
      return resource;
    },
    release(resource: unknown) {
      if (typeof resource !== 'object' || resource === null || !owned.has(resource)) {
        throw new TypeError('Video resource is not owned by this adapter');
      }
      if (released.has(resource)) return;
      const {key, entry} = owned.get(resource)!;
      if (entry.references === 1) {
        // A failed revoke may already have invalidated the URL. Never give it to a new lease.
        if (entries.get(key) === entry) entries.delete(key);
        revokeUrl(entry.objectUrl);
      }
      entry.references--;
      released.add(resource);
    },
  });
}
