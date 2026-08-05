/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {Iterable<string>} values */
function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function abortError() {
  const error = new Error('Asset preparation was cancelled');
  error.name = 'AbortError';
  return error;
}

/** @param {string} assetId @param {string} code @param {string} message @param {unknown} [cause] */
function assetError(assetId, code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : {cause});
  Object.defineProperties(error, {
    code: {value: code},
    storyPath: {value: `/assets/${assetId.replaceAll('~', '~0').replaceAll('/', '~1')}`},
  });
  return error;
}

/** @param {unknown} value */
function mediaType(value) {
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
}

/** @param {Uint8Array} bytes @param {{digest: Function}} subtleCrypto */
async function sha256Hex(bytes, subtleCrypto) {
  const digest = new Uint8Array(await subtleCrypto.digest('SHA-256', bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * Materialize validated embedded bytes and explicitly enabled remote bytes into a cached
 * platform lifecycle.
 *
 * @param {object} options
 * @param {unknown} options.runtimeComponent
 * @param {{prepare: Function, release: Function}} options.adapter
 * @param {(payload: Readonly<Record<string, unknown>>, context: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} options.setLoading
 * @param {(payload: Readonly<Record<string, unknown>>, context: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.loadRemoteAsset]
 * @param {(payload: Readonly<Record<string, unknown>>, context: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.resolveVerifiedRemoteAsset]
 * @param {{digest: Function}} [options.subtleCrypto]
 */
export function createDsl4EmbeddedAssetLifecycle({
  runtimeComponent,
  adapter,
  setLoading,
  loadRemoteAsset,
  resolveVerifiedRemoteAsset,
  subtleCrypto = globalThis.crypto?.subtle,
}) {
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
  if (loadRemoteAsset !== undefined && typeof loadRemoteAsset !== 'function') {
    throw new TypeError('loadRemoteAsset must be a function');
  }
  if (
    resolveVerifiedRemoteAsset !== undefined &&
    typeof resolveVerifiedRemoteAsset !== 'function'
  ) {
    throw new TypeError('resolveVerifiedRemoteAsset must be a function');
  }
  const remoteLoader = typeof loadRemoteAsset === 'function' ? loadRemoteAsset : null;
  const verifiedRemoteResolver =
    typeof resolveVerifiedRemoteAsset === 'function' ? resolveVerifiedRemoteAsset : null;
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

  /** @param {Record<string, any>} asset @param {Readonly<Record<string, any>>} context */
  function materialize(asset, context) {
    const source = /** @type {Record<string, any>} */ (asset.source);
    if (source.type === 'remote') {
      return (async () => {
        const usesVerifiedResolver = verifiedRemoteResolver !== null;
        if (!usesVerifiedResolver && remoteLoader === null) {
          throw assetError(
            asset.id,
            'K4-ASSET-REMOTE-DISABLED',
            `Remote asset loading is not enabled: ${asset.id}`,
          );
        }
        if (!usesVerifiedResolver && (!subtleCrypto || typeof subtleCrypto.digest !== 'function')) {
          throw assetError(
            asset.id,
            'K4-ASSET-REMOTE-CRYPTO-001',
            'Web Crypto digest is required for remote asset verification',
          );
        }
        let loaded;
        try {
          const payload = Object.freeze({
            assetId: asset.id,
            url: source.url,
            size: source.size,
            contentType: source.contentType,
            integrity: source.integrity,
          });
          if (verifiedRemoteResolver) {
            loaded = await verifiedRemoteResolver(payload, context);
          } else if (remoteLoader) {
            loaded = await remoteLoader(payload, context);
          }
        } catch (error) {
          if (context.signal?.aborted) throw abortError();
          const errorRecord = isRecord(error) ? error : {};
          throw assetError(
            asset.id,
            typeof errorRecord.code === 'string' ? errorRecord.code : 'K4-ASSET-REMOTE-LOAD-001',
            error instanceof Error && error.message
              ? error.message
              : `Remote asset loading failed: ${asset.id}`,
            error,
          );
        }
        if (context.signal?.aborted) throw abortError();
        if (!isRecord(loaded) || !(loaded.bytes instanceof Uint8Array)) {
          throw assetError(
            asset.id,
            'K4-ASSET-REMOTE-LOAD-001',
            `Remote asset loader returned an invalid payload: ${asset.id}`,
          );
        }
        const bytes = usesVerifiedResolver ? loaded.bytes : new Uint8Array(loaded.bytes);
        if (bytes.byteLength !== source.size) {
          throw assetError(
            asset.id,
            'K4-ASSET-REMOTE-SIZE-001',
            `Remote asset size does not match: ${asset.id}`,
          );
        }
        if (mediaType(loaded.contentType) !== source.contentType) {
          throw assetError(
            asset.id,
            'K4-ASSET-REMOTE-CONTENT-TYPE-001',
            `Remote asset Content-Type does not match: ${asset.id}`,
          );
        }
        const integrity = usesVerifiedResolver
          ? loaded.integrity
          : `sha256-${await sha256Hex(bytes, subtleCrypto)}`;
        if (integrity !== source.integrity) {
          throw assetError(
            asset.id,
            'K4-ASSET-REMOTE-INTEGRITY-001',
            `Remote asset integrity does not match: ${asset.id}`,
          );
        }
        if (asset.kind === 'poseModel') {
          throw assetError(
            asset.id,
            'K4-ASSET-REMOTE-POSE-EXTRACTOR-001',
            `Remote pose model loading requires a trusted archive extractor: ${asset.id}`,
          );
        }
        return Object.freeze({
          asset,
          files: Object.freeze([
            Object.freeze({
              path: source.url,
              size: bytes.byteLength,
              integrity,
              contentType: source.contentType,
              bytes,
            }),
          ]),
        });
      })();
    }
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
      const payload = materialize(asset, context);
      const resource =
        payload instanceof Promise
          ? await payload.then((value) => adapter.prepare(value, context))
          : await adapter.prepare(payload, context);
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
    const entries = await Promise.all(
      assetIds.map(async (assetId) => {
        let existing = cache.get(assetId);
        if (existing?.status === 'pending' && existing.signal?.aborted) {
          await existing.promise.catch(() => {});
          existing = cache.get(assetId);
        }
        return existing ?? createEntry(assetId, context);
      }),
    );
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

/**
 * Enable verified remote delivery through an explicitly injected loader.
 *
 * @param {Parameters<typeof createDsl4EmbeddedAssetLifecycle>[0]} options
 */
export function createDsl4RemoteAssetLifecycle(options) {
  if (
    !options ||
    (typeof options.loadRemoteAsset !== 'function' &&
      typeof options.resolveVerifiedRemoteAsset !== 'function')
  ) {
    throw new TypeError('remote asset lifecycle requires a remote asset resolver');
  }
  return createDsl4EmbeddedAssetLifecycle(options);
}
