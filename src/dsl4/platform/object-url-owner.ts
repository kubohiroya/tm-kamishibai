/** One counted Object URL lease. Distinct leases may share one URL when their bytes are equal. */
export interface Dsl4ObjectUrlLease {
  readonly objectUrl: string;
  readonly mimeType: string;
}

/**
 * Share Object URLs by MIME type and the SHA-256 of the owned bytes, across asset IDs and
 * sessions. The digest is computed here rather than trusting caller-supplied integrity metadata.
 * The URL is revoked when its last lease is released.
 */
export function createDsl4ObjectUrlOwner(
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
  let unkeyed = 0;
  function lease(key: string, bytes: Uint8Array, mimeType: string, signal?: AbortSignal | null) {
    let entry = entries.get(key);
    if (!entry) {
      const objectUrl = createUrl(new Blob([new Uint8Array(bytes).buffer], {type: mimeType}));
      if (typeof objectUrl !== 'string' || objectUrl.length === 0) {
        throw new TypeError('Object URL creation returned no URL');
      }
      if (signal?.aborted) {
        revokeUrl(objectUrl);
        throw new DOMException('Object URL preparation cancelled', 'AbortError');
      }
      entry = {objectUrl, references: 0};
      entries.set(key, entry);
    }
    const result: Dsl4ObjectUrlLease = Object.freeze({objectUrl: entry.objectUrl, mimeType});
    entry.references++;
    owned.set(result, {key, entry});
    return result;
  }
  return Object.freeze({
    /**
     * Lease synchronously by integrity the caller has already verified against these bytes,
     * e.g. a validated bundle or verified remote file. Without one, the URL is not shared.
     */
    acquireVerified(integrity: unknown, bytes: Uint8Array, mimeType: string) {
      const key =
        typeof integrity === 'string' && /^sha256-[A-Za-z0-9+/=_-]+$/u.test(integrity)
          ? `${mimeType}:${integrity}`
          : `${mimeType}:unshared:${++unkeyed}`;
      return lease(key, bytes, mimeType);
    },
    async acquire(
      input: Uint8Array,
      mimeType: string,
      signal?: AbortSignal | null,
    ): Promise<Dsl4ObjectUrlLease> {
      if (signal?.aborted) throw new DOMException('Object URL preparation cancelled', 'AbortError');
      const bytes = new Uint8Array(input);
      const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
      const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (signal?.aborted) throw new DOMException('Object URL preparation cancelled', 'AbortError');
      return lease(`${mimeType}:sha256:${hex}`, bytes, mimeType, signal);
    },
    owns(lease: unknown) {
      return typeof lease === 'object' && lease !== null && owned.has(lease);
    },
    release(lease: unknown) {
      if (typeof lease !== 'object' || lease === null || !owned.has(lease)) {
        throw new TypeError('Object URL lease is not owned by this owner');
      }
      if (released.has(lease)) return;
      const {key, entry} = owned.get(lease)!;
      if (entry.references === 1) {
        // A failed revoke may already have invalidated the URL. Never give it to a new lease.
        if (entries.get(key) === entry) entries.delete(key);
        revokeUrl(entry.objectUrl);
      }
      entry.references--;
      released.add(lease);
    },
    snapshot() {
      return Object.freeze({
        urls: entries.size,
        leases: [...entries.values()].reduce((total, entry) => total + entry.references, 0),
      });
    },
  });
}

export type Dsl4ObjectUrlOwner = ReturnType<typeof createDsl4ObjectUrlOwner>;
