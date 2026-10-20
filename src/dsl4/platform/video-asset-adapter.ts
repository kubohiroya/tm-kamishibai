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
  const owned = new WeakSet<object>();
  const released = new WeakSet<object>();
  return Object.freeze({
    prepare(payload: unknown, context: unknown) {
      const {asset, files} = payload as {
        asset: {id: string; kind: string};
        files: {bytes: Uint8Array}[];
      };
      const signal = (context as {signal?: AbortSignal}).signal;
      if (signal?.aborted) throw new DOMException('Video preparation cancelled', 'AbortError');
      const bytes = files[0]?.bytes;
      const mimeType = bytes instanceof Uint8Array ? dsl4VideoContentType(bytes) : null;
      if (asset.kind !== 'video' || files.length !== 1 || !mimeType || !bytes) {
        throw new TypeError(`Video ${asset.id} requires one MP4 or WebM file`);
      }
      const objectUrl = createUrl(new Blob([new Uint8Array(bytes).buffer], {type: mimeType}));
      if (typeof objectUrl !== 'string' || objectUrl.length === 0) {
        throw new TypeError('Video Object URL creation returned no URL');
      }
      if (signal?.aborted) {
        revokeUrl(objectUrl);
        throw new DOMException('Video preparation cancelled', 'AbortError');
      }
      const resource = Object.freeze({assetId: asset.id, kind: 'video', mimeType, objectUrl});
      owned.add(resource);
      return resource;
    },
    release(resource: unknown) {
      if (typeof resource !== 'object' || resource === null || !owned.has(resource)) {
        throw new TypeError('Video resource is not owned by this adapter');
      }
      if (released.has(resource)) return;
      released.add(resource);
      revokeUrl((resource as {objectUrl: string}).objectUrl);
    },
  });
}
