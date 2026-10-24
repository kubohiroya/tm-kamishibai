import {dsl4VideoContentType} from '../video-source.js';
import {createDsl4ObjectUrlOwner, type Dsl4ObjectUrlOwner} from './object-url-owner.js';

/** Materialize video bytes without passing them to Scratch's image/audio decoder. */
export function createDsl4VideoAssetAdapter(
  options: {
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
    /** Shared across sessions and with image leases so one owner tracks every Object URL. */
    objectUrlOwner?: Dsl4ObjectUrlOwner;
  } = {},
) {
  if (
    options.objectUrlOwner !== undefined &&
    (options.createObjectURL !== undefined || options.revokeObjectURL !== undefined)
  ) {
    throw new TypeError('Provide either objectUrlOwner or Object URL functions, not both');
  }
  const urls =
    options.objectUrlOwner ??
    createDsl4ObjectUrlOwner({
      ...(options.createObjectURL === undefined ? {} : {createObjectURL: options.createObjectURL}),
      ...(options.revokeObjectURL === undefined ? {} : {revokeObjectURL: options.revokeObjectURL}),
    });
  const owned = new WeakMap<object, unknown>();
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
      const lease = await urls.acquire(input, mimeType, signal);
      const resource = Object.freeze({
        assetId: asset.id,
        kind: 'video',
        mimeType,
        objectUrl: lease.objectUrl,
      });
      owned.set(resource, lease);
      return resource;
    },
    release(resource: unknown) {
      if (typeof resource !== 'object' || resource === null || !owned.has(resource)) {
        throw new TypeError('Video resource is not owned by this adapter');
      }
      if (released.has(resource)) return;
      urls.release(owned.get(resource));
      released.add(resource);
    },
  });
}
