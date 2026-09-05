function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function backingError(code: string, message: string, cause?: unknown) {
  const error = new Error(message, cause === undefined ? undefined : {cause});
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

function errorCode(value: unknown) {
  return isRecord(value) && typeof value.code === 'string' ? value.code : '';
}

function validateSignal(value: unknown) {
  if (
    value !== undefined &&
    (!isRecord(value) ||
      typeof value.aborted !== 'boolean' ||
      typeof value.addEventListener !== 'function' ||
      typeof value.removeEventListener !== 'function')
  ) {
    throw new TypeError('binary asset operation signal must be an AbortSignal');
  }
  return value as unknown as AbortSignal | undefined;
}

function linkSignals(external: AbortSignal | undefined, internal: AbortSignal) {
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

function binaryAssets(component: Readonly<Record<string, any>>) {
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
}: {
  runtimeComponent: Readonly<Record<string, any>>;
  provider: unknown;
  composition: Readonly<Record<'createSessionBinaryBacking', (...parameters: any[]) => any>>;
  namespace: string;
  policy: 'prefer' | 'required' | 'disabled';
  sessionId: string;
  onWarning?: (warning: Readonly<Record<string, unknown>>) => unknown;
  onFatalError?: (error: unknown) => unknown;
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

  let provider: Record<string, any> | null = providerCandidate as Record<string, any>;
  let sessionBacking: Record<string, any> | null = null;
  const controller = new AbortController();
  let state = 'establishing';
  let mode: 'session' | 'direct' | null = null;
  let disposed = false;
  let failure: unknown = null;
  let warning: Readonly<Record<string, unknown>> | null = null;
  let fatalNotified = false;
  let providerReadQueue = Promise.resolve();

  function enqueueProviderRead<T>(operation: () => Promise<T>): Promise<T> {
    const result = providerReadQueue.then(operation, operation);
    providerReadQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function key(assetId: string) {
    return Object.freeze({namespace, name: assetId, integrity: descriptor.integrity});
  }

  function notifyFatal(fatalError: unknown) {
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

  function validateStored(assetId: string, stored: unknown) {
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
    const expectedByPath = new Map<unknown, Record<string, any>>(
      expected.map((file: Record<string, any>) => [file.path, file]),
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
    return stored as Readonly<Record<string, any>>;
  }

  const source = Object.freeze({
    read(asset: Readonly<Record<string, any>>, readOptions: {signal?: AbortSignal} = {}) {
      return enqueueProviderRead(async () => {
        const activeProvider = provider;
        if (!activeProvider) {
          throw backingError(
            'K4-BINARY-BACKING-RELEASED-001',
            'Binary entry source has been released',
          );
        }
        const loaded = await (activeProvider.readAsset as Function)(asset.name, {
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
        if (activeProvider) await (activeProvider.release as Function)();
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
            files: (assets.get(assetId) as ReadonlyArray<Record<string, any>>).map((file) => ({
              path: file.path,
              size: file.size,
              integrity: file.integrity,
            })),
          })),
          source,
          onFatalError: notifyFatal,
        },
        {signal: controller.signal},
      );
      sessionBacking = established;
      mode = established.mode as 'session' | 'direct';
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

  async function getAssetFiles(assetId: string, operationOptions: {signal?: AbortSignal} = {}) {
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
          stored.files.map((file: Record<string, any>) =>
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
          (candidate: Record<string, any>) => candidate.path === file.path,
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
            existing.some((value: number, index: number) => value !== file.bytes[index]))
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
      getEntry(entryName: string) {
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

  let disposePromise: Promise<void> | null = null;
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
