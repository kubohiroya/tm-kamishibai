/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {Iterable<string>} values */
function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function abortError() {
  const error = new Error('Embedded asset preparation was cancelled');
  error.name = 'AbortError';
  return error;
}

/**
 * Materialize validated embedded bytes into a cached platform lifecycle.
 *
 * @param {object} options
 * @param {unknown} options.runtimeComponent
 * @param {{prepare: Function, release: Function}} options.adapter
 * @param {(payload: Readonly<Record<string, unknown>>, context: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} options.setLoading
 */
export function createDsl4EmbeddedAssetLifecycle({runtimeComponent, adapter, setLoading}) {
  if (!isRecord(runtimeComponent)) throw new TypeError('runtimeComponent must be an object');
  const storyDocument = isRecord(runtimeComponent.storyDocument)
    ? runtimeComponent.storyDocument
    : null;
  const assetBundle = isRecord(runtimeComponent.assetBundle) ? runtimeComponent.assetBundle : null;
  if (
    storyDocument?.kind !== 'StoryDocument' ||
    storyDocument.version !== '4.0' ||
    !assetBundle ||
    !isRecord(assetBundle.manifest) ||
    !Array.isArray(assetBundle.manifest.assets) ||
    typeof runtimeComponent.getAssetFile !== 'function'
  ) {
    throw new TypeError('runtimeComponent must provide a validated StoryDocument and asset bundle');
  }
  if (
    !isRecord(adapter) ||
    typeof adapter.prepare !== 'function' ||
    typeof adapter.release !== 'function'
  ) {
    throw new TypeError('asset adapter must provide prepare and release');
  }
  if (typeof setLoading !== 'function') throw new TypeError('setLoading must be a function');
  const getAssetFile = /** @type {Function} */ (runtimeComponent.getAssetFile);

  const manifest = new Map();
  for (const candidate of assetBundle.manifest.assets) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || manifest.has(candidate.id)) {
      throw new TypeError('asset bundle manifest must contain unique asset records');
    }
    manifest.set(candidate.id, candidate);
  }

  let epoch = 0;
  /** @type {Map<string, Record<string, any>>} */
  const cache = new Map();

  /** @param {Record<string, any>} asset */
  function materialize(asset) {
    const source = /** @type {Record<string, any>} */ (asset.source);
    const sourceFiles = /** @type {Record<string, any>[]} */ (source.files ?? []);
    const files =
      source.type === 'file'
        ? sourceFiles.map((file) =>
            Object.freeze({
              path: file.path,
              size: file.size,
              integrity: file.integrity,
              bytes: new Uint8Array(getAssetFile(asset.id, file.path)),
            }),
          )
        : [];
    return Object.freeze({asset, files: Object.freeze(files)});
  }

  /** @param {Record<string, any>} entry @param {string} reason */
  async function releaseEntry(entry, reason) {
    if (!entry.hasResource || entry.released) return;
    entry.released = true;
    try {
      await adapter.release(entry.resource, Object.freeze({asset: entry.asset, reason}));
    } catch (error) {
      entry.releaseError = error;
      throw error;
    }
  }

  /** @param {string} assetId @param {Readonly<Record<string, any>>} context */
  function createEntry(assetId, context) {
    const asset = /** @type {Record<string, any>} */ (manifest.get(assetId));
    const entry = {
      asset,
      assetId,
      epoch,
      signal: context.signal,
      status: 'pending',
      promise: Promise.resolve(),
      hasResource: false,
      resource: undefined,
      released: false,
      releaseError: null,
      error: null,
    };
    cache.set(assetId, entry);
    entry.promise = (async () => {
      if (entry.signal?.aborted) throw abortError();
      const resource = await adapter.prepare(materialize(asset), context);
      entry.resource = resource;
      entry.hasResource = true;
      if (entry.epoch !== epoch || entry.signal?.aborted) {
        await releaseEntry(entry, 'stale');
        throw abortError();
      }
      entry.status = 'ready';
      return resource;
    })().catch((error) => {
      entry.status = 'failed';
      entry.error = error;
      if (error instanceof Error && error.name === 'AbortError' && cache.get(assetId) === entry) {
        cache.delete(assetId);
      }
      throw error;
    });
    void entry.promise.catch(() => {});
    return entry;
  }

  /**
   * @param {Readonly<Record<string, unknown>>} payload
   * @param {Readonly<Record<string, any>>} context
   */
  async function prepare(payload, context) {
    if (!isRecord(payload) || !Array.isArray(payload.assetIds)) {
      throw new TypeError('asset prepare payload must provide assetIds');
    }
    if (!isRecord(context)) throw new TypeError('asset prepare context must be an object');
    const requested = payload.assetIds;
    if (requested.some((assetId) => typeof assetId !== 'string')) {
      throw new TypeError('assetIds must contain strings');
    }
    const assetIds = sortedUnique(/** @type {string[]} */ (requested));
    for (const assetId of assetIds) {
      if (!manifest.has(assetId)) throw new TypeError(`Unknown embedded asset: ${assetId}`);
    }
    const entries = assetIds.map((assetId) => {
      const existing = cache.get(assetId);
      if (existing && !(existing.status === 'pending' && existing.signal?.aborted)) return existing;
      if (existing) cache.delete(assetId);
      return createEntry(assetId, context);
    });
    await Promise.all(entries.map(({promise}) => promise));
  }

  /** @param {Readonly<Record<string, unknown>>} payload */
  async function release(payload) {
    const reason =
      isRecord(payload) && typeof payload.reason === 'string' ? payload.reason : 'release';
    epoch += 1;
    const entries = [...cache.values()].reverse();
    cache.clear();
    const errors = [];
    for (const entry of entries) {
      await entry.promise.catch(() => {});
      if (!entry.released) {
        try {
          await releaseEntry(entry, reason);
        } catch {
          // Continue releasing every resource before reporting the aggregate.
        }
      }
      if (entry.releaseError) errors.push(entry.releaseError);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more embedded assets could not be released');
    }
  }

  return Object.freeze({
    prepare,
    /**
     * @param {Readonly<Record<string, unknown>>} payload
     * @param {Readonly<Record<string, unknown>>} context
     */
    setLoading(payload, context) {
      return setLoading(payload, context);
    },
    release,
  });
}
