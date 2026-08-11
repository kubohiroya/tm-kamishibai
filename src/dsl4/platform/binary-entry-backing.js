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
 * Establish one startup-fixed Asset Manager session/direct backing for a binary-entry provider.
 *
 * The provider remains readable until Asset Manager releases it. Session mode releases it only
 * after sequential commit and read-back validation; direct mode retains it until disposal.
 *
 * @param {object} options
 * @param {Readonly<Record<string, any>>} options.runtimeComponent
 * @param {unknown} options.provider
 * @param {Readonly<Record<string, Function>>} options.composition
 * @param {string} options.namespace
 * @param {'prefer' | 'required' | 'disabled'} options.policy
 * @param {string} options.sessionId
 * @param {(warning: Readonly<Record<string, unknown>>) => unknown} [options.onWarning]
 * @param {(error: unknown) => unknown} [options.onFatalError]
 */
export function createDsl4BinaryEntryBacking({
  runtimeComponent,
  provider: providerCandidate,
  composition,
  namespace,
  policy,
  sessionId,
  onWarning,
  onFatalError,
}) {
  if (!isRecord(runtimeComponent)) throw new TypeError('runtimeComponent must be an object');
  if (!isRecord(providerCandidate)) throw new TypeError('binaryEntryProvider must be an object');
  if (
    !Array.isArray(providerCandidate.assetIds) ||
    providerCandidate.releaseAfterLastAsset !== false ||
    typeof providerCandidate.readAsset !== 'function' ||
    typeof providerCandidate.release !== 'function' ||
    !isRecord(providerCandidate.descriptor)
  ) {
    throw new TypeError(
      'binaryEntryProvider must be a validated replayable provider with deferred release',
    );
  }
  if (!isRecord(composition)) throw new TypeError('Asset Manager composition must be an object');
  if (typeof composition.createSessionBinaryBacking !== 'function') {
    throw new TypeError('Asset Manager composition must provide createSessionBinaryBacking');
  }
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new TypeError('binary asset namespace must be a non-empty string');
  }
  if (!['prefer', 'required', 'disabled'].includes(policy)) {
    throw new TypeError('session binary backing policy must be prefer, required, or disabled');
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('session binary backing ID must be a non-empty string');
  }
  if (onWarning !== undefined && typeof onWarning !== 'function') {
    throw new TypeError('session binary backing onWarning must be a function');
  }
  if (onFatalError !== undefined && typeof onFatalError !== 'function') {
    throw new TypeError('session binary backing onFatalError must be a function');
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
  /** @type {Record<string, any> | null} */
  let sessionBacking = null;
  const controller = new AbortController();
  let state = 'establishing';
  /** @type {'session' | 'direct' | null} */
  let mode = null;
  let disposed = false;
  /** @type {unknown} */
  let failure = null;
  /** @type {Readonly<Record<string, unknown>> | null} */
  let warning = null;
  let fatalNotified = false;
  let providerReadQueue = Promise.resolve();

  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  function enqueueProviderRead(operation) {
    const result = providerReadQueue.then(operation, operation);
    providerReadQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** @param {string} assetId */
  function key(assetId) {
    return Object.freeze({namespace, name: assetId, integrity: descriptor.integrity});
  }

  /** @param {unknown} fatalError */
  function notifyFatal(fatalError) {
    failure = fatalError;
    state = 'failed';
    if (fatalNotified) return;
    fatalNotified = true;
    try {
      onFatalError?.(fatalError);
    } catch {
      // A diagnostic observer cannot replace the authoritative backing failure.
    }
  }

  /** @param {string} assetId @param {unknown} stored */
  function validateStored(assetId, stored) {
    const expected = assets.get(assetId);
    if (!isRecord(stored) || !Array.isArray(stored.files) || !expected) {
      throw backingError(
        'K4-BINARY-BACKING-CORRUPT-001',
        `Binary backing returned an invalid asset: ${assetId}`,
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
        `Binary backing metadata does not match: ${assetId}`,
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
          `Binary backing file does not match: ${assetId}`,
        );
      }
    }
    return /** @type {Readonly<Record<string, any>>} */ (stored);
  }

  const source = Object.freeze({
    /** @param {Readonly<Record<string, any>>} asset @param {{signal?: AbortSignal}} [readOptions] */
    read(asset, readOptions = {}) {
      return enqueueProviderRead(async () => {
        const activeProvider = provider;
        if (!activeProvider) {
          throw backingError(
            'K4-BINARY-BACKING-RELEASED-001',
            'Binary entry source has been released',
          );
        }
        const loaded = await /** @type {Function} */ (activeProvider.readAsset)(asset.name, {
          signal: readOptions.signal,
        });
        if (!isRecord(loaded) || loaded.assetId !== asset.name || !Array.isArray(loaded.files)) {
          throw backingError(
            'K4-BINARY-BACKING-PROVIDER-001',
            `Binary provider returned an invalid asset: ${asset.name}`,
          );
        }
        return Object.freeze({...key(asset.name), files: loaded.files});
      });
    },
    release() {
      return enqueueProviderRead(async () => {
        const activeProvider = provider;
        provider = null;
        if (activeProvider) await /** @type {Function} */ (activeProvider.release)();
      });
    },
  });

  const ready = (async () => {
    try {
      const established = await composition.createSessionBinaryBacking(
        {
          policy,
          sessionId,
          assets: expectedAssetIds.map((assetId) => ({
            ...key(assetId),
            files: /** @type {ReadonlyArray<Record<string, any>>} */ (assets.get(assetId)).map(
              (file) => ({path: file.path, size: file.size, integrity: file.integrity}),
            ),
          })),
          source,
          onFatalError: notifyFatal,
        },
        {signal: controller.signal},
      );
      sessionBacking = established;
      mode = /** @type {'session' | 'direct'} */ (established.mode);
      if (isRecord(established.warning)) {
        const warningSnapshot = Object.freeze({...established.warning});
        warning = warningSnapshot;
        try {
          onWarning?.(warningSnapshot);
        } catch {
          // Warning presentation cannot change the fixed backing mode.
        }
      }
      if (state !== 'failed') state = 'ready';
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
      if (!sessionBacking) {
        throw backingError('K4-BINARY-BACKING-STATE-001', 'Binary backing is unavailable');
      }
      try {
        const stored = validateStored(
          assetId,
          await sessionBacking.get(key(assetId), {signal: linked.signal}),
        );
        return Object.freeze(
          stored.files.map(
            /** @param {Record<string, any>} file */ (file) =>
              Object.freeze({
                path: file.path,
                size: file.size,
                integrity: file.integrity,
                ...(file.contentType === undefined ? {} : {contentType: file.contentType}),
                bytes: new Uint8Array(file.bytes),
              }),
          ),
        );
      } catch (error) {
        if (mode === 'session') notifyFatal(error);
        throw error;
      }
    } finally {
      linked.cleanup();
    }
  }

  /** Materialize a temporary editor export. */
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
      if (sessionBacking) {
        try {
          await sessionBacking.dispose();
        } catch (error) {
          errors.push(error);
        }
        sessionBacking = null;
      }
      if (provider) {
        try {
          await source.release();
        } catch (error) {
          errors.push(error);
        }
      }
      if (state !== 'failed') state = 'disposed';
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
        mode,
        sessionId,
        disposed,
        providerRetained: provider !== null,
        warning,
        failureCode: failure === null ? null : errorCode(failure) || 'K4-BINARY-BACKING-UNKNOWN',
      });
    },
    dispose,
  });
}
