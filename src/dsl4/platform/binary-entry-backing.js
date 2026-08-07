/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} code @param {string} message @param {unknown} [cause] */
function backingError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : {cause});
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

/** @param {unknown} value */
function errorCode(value) {
  return isRecord(value) && typeof value.code === 'string' ? value.code : '';
}

/** @param {unknown} value */
function validateSignal(value) {
  if (
    value !== undefined &&
    (!isRecord(value) ||
      typeof value.aborted !== 'boolean' ||
      typeof value.addEventListener !== 'function' ||
      typeof value.removeEventListener !== 'function')
  ) {
    throw new TypeError('binary asset operation signal must be an AbortSignal');
  }
  return /** @type {AbortSignal | undefined} */ (/** @type {unknown} */ (value));
}

/** @param {AbortSignal | undefined} external @param {AbortSignal} internal */
function linkSignals(external, internal) {
  if (!external) return {signal: internal, cleanup() {}};
  const controller = new AbortController();
  const abort = () => controller.abort();
  external.addEventListener('abort', abort, {once: true});
  internal.addEventListener('abort', abort, {once: true});
  if (external.aborted || internal.aborted) abort();
  return {
    signal: controller.signal,
    cleanup() {
      external.removeEventListener('abort', abort);
      internal.removeEventListener('abort', abort);
    },
  };
}

/** @param {Readonly<Record<string, any>>} component */
function binaryAssets(component) {
  const descriptor = component.assetBundle;
  if (
    !isRecord(descriptor) ||
    typeof descriptor.integrity !== 'string' ||
    !Array.isArray(descriptor.files) ||
    !isRecord(descriptor.manifest) ||
    !Array.isArray(descriptor.manifest.assets)
  ) {
    throw new TypeError('binary runtime component must provide a validated binary asset bundle');
  }
  const assets = new Map();
  for (const asset of descriptor.manifest.assets) {
    if (!isRecord(asset) || typeof asset.id !== 'string') continue;
    const source = isRecord(asset.source) ? asset.source : null;
    if (source?.type !== 'file') continue;
    const files = descriptor.files.filter((file) => isRecord(file) && file.assetId === asset.id);
    if (files.length === 0) {
      throw backingError(
        'K4-BINARY-BACKING-DESCRIPTOR-001',
        `Binary descriptor contains no files for asset: ${asset.id}`,
      );
    }
    assets.set(asset.id, Object.freeze(files));
  }
  return {descriptor, assets};
}

/**
 * Ingest one validated binary-entry provider into Asset Manager's transactional store.
 *
 * The provider remains reachable while an ingest transaction is pending. It is released only
 * after every asset has committed, or later during explicit disposal after a failed ingest.
 *
 * @param {object} options
 * @param {Readonly<Record<string, any>>} options.runtimeComponent
 * @param {unknown} options.provider
 * @param {Readonly<Record<string, Function>>} options.composition
 * @param {string} options.namespace
 */
export function createDsl4BinaryEntryBacking({
  runtimeComponent,
  provider: providerCandidate,
  composition,
  namespace,
}) {
  if (!isRecord(runtimeComponent)) throw new TypeError('runtimeComponent must be an object');
  if (!isRecord(providerCandidate)) throw new TypeError('binaryEntryProvider must be an object');
  if (
    !Array.isArray(providerCandidate.assetIds) ||
    providerCandidate.releaseAfterLastAsset !== false ||
    typeof providerCandidate.consumeAsset !== 'function' ||
    typeof providerCandidate.release !== 'function' ||
    !isRecord(providerCandidate.descriptor)
  ) {
    throw new TypeError(
      'binaryEntryProvider must be a validated one-shot provider with deferred release',
    );
  }
  if (!isRecord(composition)) throw new TypeError('Asset Manager composition must be an object');
  for (const method of [
    'putBinaryBundle',
    'getBinaryBundle',
    'deleteBinaryBundle',
    'releaseBinaryStore',
  ]) {
    if (typeof composition[method] !== 'function') {
      throw new TypeError(`Asset Manager composition must provide ${method}`);
    }
  }
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new TypeError('binary asset namespace must be a non-empty string');
  }

  const {descriptor, assets} = binaryAssets(runtimeComponent);
  if (
    providerCandidate.descriptor.integrity !== descriptor.integrity ||
    JSON.stringify(providerCandidate.descriptor) !== JSON.stringify(descriptor)
  ) {
    throw backingError(
      'K4-BINARY-BACKING-DESCRIPTOR-001',
      'Binary provider descriptor does not match the runtime component',
    );
  }
  const providerAssetIds = [...providerCandidate.assetIds].sort();
  const expectedAssetIds = [...assets.keys()].sort();
  if (
    providerAssetIds.length !== expectedAssetIds.length ||
    providerAssetIds.some((assetId, index) => assetId !== expectedAssetIds[index])
  ) {
    throw backingError(
      'K4-BINARY-BACKING-DESCRIPTOR-001',
      'Binary provider assets do not match the runtime component',
    );
  }

  /** @type {Record<string, any> | null} */
  let provider = /** @type {Record<string, any>} */ (providerCandidate);
  const controller = new AbortController();
  let state = 'ingesting';
  let disposed = false;
  /** @type {unknown} */
  let failure = null;

  /** @param {string} assetId */
  function key(assetId) {
    return Object.freeze({namespace, name: assetId, integrity: descriptor.integrity});
  }

  /** @param {string} assetId @param {unknown} stored */
  function validateStored(assetId, stored) {
    const expected = assets.get(assetId);
    if (!isRecord(stored) || !Array.isArray(stored.files) || !expected) {
      throw backingError(
        'K4-BINARY-BACKING-CORRUPT-001',
        `Binary backing store returned an invalid asset: ${assetId}`,
      );
    }
    if (
      stored.namespace !== namespace ||
      stored.name !== assetId ||
      stored.integrity !== descriptor.integrity ||
      stored.files.length !== expected.length
    ) {
      throw backingError(
        'K4-BINARY-BACKING-CORRUPT-001',
        `Binary backing store metadata does not match: ${assetId}`,
      );
    }
    const expectedByPath = new Map(
      expected.map(/** @param {Record<string, any>} file */ (file) => [file.path, file]),
    );
    for (const file of stored.files) {
      const expectedFile = isRecord(file) ? expectedByPath.get(file.path) : null;
      if (
        !expectedFile ||
        file.size !== expectedFile.size ||
        file.integrity !== expectedFile.integrity ||
        !(file.bytes instanceof Uint8Array)
      ) {
        throw backingError(
          'K4-BINARY-BACKING-CORRUPT-001',
          `Binary backing store file does not match: ${assetId}`,
        );
      }
    }
    return /** @type {Readonly<Record<string, any>>} */ (stored);
  }

  const ready = (async () => {
    try {
      for (const assetId of expectedAssetIds) {
        if (controller.signal.aborted) {
          throw backingError('K4-BINARY-BACKING-ABORTED-001', 'Binary ingestion was aborted');
        }
        let cached = false;
        try {
          const stored = await composition.getBinaryBundle(key(assetId), {
            signal: controller.signal,
          });
          validateStored(assetId, stored);
          cached = true;
        } catch (error) {
          if (errorCode(error) !== 'ASSET_BINARY_BUNDLE_NOT_FOUND') throw error;
        }
        if (cached) continue;
        const source = await /** @type {Function} */ (provider.consumeAsset)(assetId, {
          signal: controller.signal,
        });
        if (!isRecord(source) || source.assetId !== assetId || !Array.isArray(source.files)) {
          throw backingError(
            'K4-BINARY-BACKING-PROVIDER-001',
            `Binary provider returned an invalid asset: ${assetId}`,
          );
        }
        // Keep `source` reachable until put resolves: put resolves only after transaction complete.
        await composition.putBinaryBundle(
          {
            ...key(assetId),
            files: source.files,
          },
          {signal: controller.signal},
        );
      }
      await /** @type {Function} */ (provider.release)();
      provider = null;
      state = 'ready';
    } catch (error) {
      failure = error;
      state = 'failed';
      throw error;
    }
  })();
  void ready.catch(() => {});

  /** @param {string} assetId @param {{signal?: AbortSignal}} [operationOptions] */
  async function getAssetFiles(assetId, operationOptions = {}) {
    if (typeof assetId !== 'string' || !assets.has(assetId)) {
      throw backingError('K4-BINARY-BACKING-LOOKUP-001', `Unknown binary asset: ${assetId}`);
    }
    const externalSignal = validateSignal(operationOptions.signal);
    const linked = linkSignals(externalSignal, controller.signal);
    try {
      await ready;
      const stored = validateStored(
        assetId,
        await composition.getBinaryBundle(key(assetId), {signal: linked.signal}),
      );
      return Object.freeze(
        stored.files.map(
          /** @param {Record<string, any>} file */ (file) =>
            Object.freeze({
              path: file.path,
              size: file.size,
              integrity: file.integrity,
              bytes: new Uint8Array(file.bytes),
            }),
        ),
      );
    } finally {
      linked.cleanup();
    }
  }

  /**
   * Materialize a temporary editor export. `releaseEntries` drops every application reference.
   */
  async function createExportBundle() {
    await ready;
    const entries = new Map();
    for (const assetId of expectedAssetIds) {
      const files = await getAssetFiles(assetId);
      const expected = assets.get(assetId) ?? [];
      for (const file of files) {
        const descriptorFile = expected.find(
          /** @param {Record<string, any>} candidate */ (candidate) => candidate.path === file.path,
        );
        if (!descriptorFile) {
          throw backingError(
            'K4-BINARY-BACKING-CORRUPT-001',
            `Cannot export an unknown binary file: ${assetId}/${file.path}`,
          );
        }
        const existing = entries.get(descriptorFile.entry);
        if (
          existing &&
          (existing.length !== file.bytes.length ||
            existing.some(
              /** @param {number} value @param {number} index */ (value, index) =>
                value !== file.bytes[index],
            ))
        ) {
          throw backingError(
            'K4-BINARY-BACKING-CORRUPT-001',
            `Content-addressed export collision: ${descriptorFile.entry}`,
          );
        }
        if (!existing) entries.set(descriptorFile.entry, new Uint8Array(file.bytes));
      }
    }
    const entryNames = Object.freeze([...entries.keys()].sort());
    let released = false;
    return Object.freeze({
      descriptor,
      entryNames,
      /** @param {string} entryName */
      getEntry(entryName) {
        if (released) {
          throw backingError('K4-BINARY-BACKING-RELEASED-001', 'Editor export was released');
        }
        const bytes = entries.get(entryName);
        if (!bytes) {
          throw backingError(
            'K4-BINARY-BACKING-LOOKUP-001',
            `Editor export entry was not found: ${entryName}`,
          );
        }
        return new Uint8Array(bytes);
      },
      releaseEntries() {
        if (released) return;
        released = true;
        entries.clear();
      },
    });
  }

  /** @type {Promise<void> | null} */
  let disposePromise = null;
  function dispose() {
    if (disposePromise) return disposePromise;
    disposed = true;
    controller.abort();
    disposePromise = (async () => {
      const errors = [];
      await ready.catch(() => {});
      if (provider) {
        try {
          await /** @type {Function} */ (provider.release)();
        } catch (error) {
          errors.push(error);
        }
        provider = null;
      }
      try {
        await composition.releaseBinaryStore();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'DSL 4.0 binary backing disposal failed');
      }
    })();
    return disposePromise;
  }

  return Object.freeze({
    ready,
    getAssetFiles,
    createExportBundle,
    getState() {
      return Object.freeze({
        state,
        disposed,
        providerRetained: provider !== null,
        failureCode: failure === null ? null : errorCode(failure) || 'K4-BINARY-BACKING-UNKNOWN',
      });
    },
    dispose,
  });
}
