import {encodeDsl4StoryPathSegment} from './story-path.js';
import {isDsl4RemotePoseArchiveUrl} from './pose-archive-locator.js';
import {
  dsl4RemotePoseFileUrl,
  parseDsl4RemotePoseJson,
  resolveDsl4RemotePoseWeightsPath,
} from './remote-pose-directory.js';
import type {Dsl4SubtleCrypto} from './subtle-crypto.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortedUnique(values: Iterable<string>) {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function abortError() {
  const error = new Error('Asset preparation was cancelled');
  error.name = 'AbortError';
  return error;
}

function assetError(assetId: string, code: string, message: string, cause?: unknown) {
  const error = new Error(message, cause === undefined ? undefined : {cause});
  Object.defineProperties(error, {
    code: {value: code},
    storyPath: {value: `/assets/${encodeDsl4StoryPathSegment(assetId)}`},
  });
  return error;
}

function mediaType(value: unknown) {
  return typeof value === 'string' ? (value.split(';', 1)[0]?.trim().toLowerCase() ?? '') : '';
}

function isVerifiedRemoteSource(source: Record<string, any>) {
  return (
    typeof source.integrity === 'string' &&
    typeof source.contentType === 'string' &&
    Number.isSafeInteger(source.size)
  );
}

async function sha256Hex(bytes: Uint8Array, subtleCrypto: Dsl4SubtleCrypto) {
  const digest = new Uint8Array(await subtleCrypto.digest('SHA-256', bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * Materialize validated embedded bytes and explicitly enabled remote bytes into a cached
 * platform lifecycle.
 */
export function createDsl4EmbeddedAssetLifecycle({
  runtimeComponent,
  adapter,
  setLoading,
  loadRemoteAsset,
  resolveVerifiedRemoteAsset,
  extractRemotePoseArchive,
  resolveEmbeddedAssetFiles,
  subtleCrypto = globalThis.crypto?.subtle,
}: {
  runtimeComponent: unknown;
  adapter: {prepare: Function; release: Function};
  setLoading: Function;
  loadRemoteAsset?: Function;
  resolveVerifiedRemoteAsset?: Function;
  extractRemotePoseArchive?: Function;
  resolveEmbeddedAssetFiles?: Function;
  subtleCrypto?: Dsl4SubtleCrypto | undefined;
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
    (typeof runtimeComponent.getAssetFile !== 'function' &&
      typeof resolveEmbeddedAssetFiles !== 'function')
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
  if (extractRemotePoseArchive !== undefined && typeof extractRemotePoseArchive !== 'function') {
    throw new TypeError('extractRemotePoseArchive must be a function');
  }
  if (resolveEmbeddedAssetFiles !== undefined && typeof resolveEmbeddedAssetFiles !== 'function') {
    throw new TypeError('resolveEmbeddedAssetFiles must be a function');
  }
  const remoteLoader = typeof loadRemoteAsset === 'function' ? loadRemoteAsset : null;
  const verifiedRemoteResolver =
    typeof resolveVerifiedRemoteAsset === 'function' ? resolveVerifiedRemoteAsset : null;
  const poseArchiveExtractor =
    typeof extractRemotePoseArchive === 'function' ? extractRemotePoseArchive : null;
  const getAssetFile =
    typeof runtimeComponent.getAssetFile === 'function'
      ? (runtimeComponent.getAssetFile as Function)
      : null;
  const embeddedFileResolver =
    typeof resolveEmbeddedAssetFiles === 'function' ? resolveEmbeddedAssetFiles : null;

  const manifest = new Map();
  for (const candidate of assetBundle.manifest.assets) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || manifest.has(candidate.id)) {
      throw new TypeError('asset bundle manifest must contain unique asset records');
    }
    manifest.set(candidate.id, candidate);
  }

  let epoch = 0;
  const cache: Map<string, Record<string, any>> = new Map();
  const releaseLocks: Map<string, Promise<void>> = new Map();
  let releaseAllLock: Promise<void> | null = null;

  async function materializePoseArchive(
    asset: Record<string, any>,
    bytes: Uint8Array,
    integrity: string,
    contentType: string,
    context: Readonly<Record<string, any>>,
  ) {
    if (!poseArchiveExtractor) {
      throw assetError(
        asset.id,
        'K4-ASSET-REMOTE-POSE-EXTRACTOR-001',
        `Remote pose model loading requires a trusted archive extractor: ${asset.id}`,
      );
    }
    let extracted;
    try {
      extracted = await poseArchiveExtractor(
        Object.freeze({
          assetId: asset.id,
          bytes,
          archiveIntegrity: integrity,
          contentType,
        }),
        context,
      );
    } catch (error) {
      if (context.signal?.aborted) throw abortError();
      if (isRecord(error) && typeof error.code === 'string') throw error;
      throw assetError(
        asset.id,
        'K4-ASSET-REMOTE-POSE-EXTRACTOR-002',
        `Remote pose archive extraction failed: ${asset.id}`,
        error,
      );
    }
    if (context.signal?.aborted) throw abortError();
    if (
      !isRecord(extracted) ||
      extracted.archiveIntegrity !== integrity ||
      typeof extracted.extractorFormat !== 'string' ||
      extracted.extractorFormat.length === 0 ||
      !Array.isArray(extracted.files) ||
      extracted.files.some(
        (file) =>
          !isRecord(file) ||
          !(file.bytes instanceof Uint8Array) ||
          file.archiveIntegrity !== integrity ||
          file.extractorFormat !== extracted.extractorFormat ||
          typeof file.integrity !== 'string',
      )
    ) {
      throw assetError(
        asset.id,
        'K4-ASSET-REMOTE-POSE-BINDING-001',
        `Remote pose archive extraction is not bound to the loaded archive: ${asset.id}`,
      );
    }
    return Object.freeze({
      asset,
      archiveBinding: Object.freeze({
        integrity,
        extractorFormat: extracted.extractorFormat,
      }),
      files: Object.freeze([...extracted.files]),
    });
  }

  function materialize(asset: Record<string, any>, context: Readonly<Record<string, any>>) {
    const source = asset.source as Record<string, any>;
    if (source.type === 'remote') {
      return (async () => {
        const verified = isVerifiedRemoteSource(source);
        const usesVerifiedResolver = verified && verifiedRemoteResolver !== null;
        const recognitionModel = asset.kind === 'recognitionModel';
        const archiveUrl = recognitionModel && isDsl4RemotePoseArchiveUrl(source.url);
        if (!usesVerifiedResolver && remoteLoader === null) {
          throw assetError(
            asset.id,
            'K4-ASSET-REMOTE-DISABLED',
            `Remote asset loading is not enabled: ${asset.id}`,
          );
        }
        if (
          ((verified && !usesVerifiedResolver) || (!verified && archiveUrl)) &&
          (!subtleCrypto || typeof subtleCrypto.digest !== 'function')
        ) {
          throw assetError(
            asset.id,
            'K4-ASSET-REMOTE-CRYPTO-001',
            'Web Crypto digest is required for remote asset verification',
          );
        }
        if (!verified) {
          const unverifiedRemoteLoader = remoteLoader as Function;
          if (!recognitionModel) {
            try {
              const loaded = await unverifiedRemoteLoader(
                Object.freeze({assetId: asset.id, url: source.url}),
                context,
              );
              if (
                !isRecord(loaded) ||
                !(loaded.bytes instanceof Uint8Array) ||
                loaded.bytes.byteLength === 0
              ) {
                throw new TypeError(`Remote asset payload is invalid: ${asset.id}`);
              }
              const contentType = mediaType(loaded.contentType);
              const requiredPrefix = asset.kind === 'sound' ? 'audio/' : 'image/';
              if (!contentType.startsWith(requiredPrefix)) {
                throw assetError(
                  asset.id,
                  'K4-ASSET-REMOTE-CONTENT-TYPE-001',
                  `Remote asset Content-Type does not match its kind: ${asset.id}`,
                );
              }
              if (context.signal?.aborted) throw abortError();
              const bytes = new Uint8Array(loaded.bytes);
              return Object.freeze({
                asset,
                files: Object.freeze([
                  Object.freeze({
                    path: source.url,
                    size: bytes.byteLength,
                    contentType,
                    bytes,
                  }),
                ]),
              });
            } catch (error) {
              if (
                context.signal?.aborted ||
                (error instanceof Error && error.name === 'AbortError')
              ) {
                throw abortError();
              }
              if (isRecord(error) && typeof error.code === 'string') throw error;
              throw assetError(
                asset.id,
                'K4-ASSET-REMOTE-LOAD-001',
                error instanceof Error && error.message
                  ? error.message
                  : `Remote asset loading failed: ${asset.id}`,
                error,
              );
            }
          }
          try {
            if (archiveUrl) {
              const loaded = await unverifiedRemoteLoader(
                Object.freeze({assetId: asset.id, url: source.url}),
                context,
              );
              if (!isRecord(loaded) || !(loaded.bytes instanceof Uint8Array)) {
                throw new TypeError('Remote pose archive payload is invalid');
              }
              const bytes = new Uint8Array(loaded.bytes);
              const integrity = `sha256-${await sha256Hex(bytes, subtleCrypto)}`;
              return await materializePoseArchive(
                asset,
                bytes,
                integrity,
                mediaType(loaded.contentType),
                context,
              );
            }
            const loadFile = async (path: string) => {
              const url = dsl4RemotePoseFileUrl(source.url, path);
              const loaded = await unverifiedRemoteLoader(
                Object.freeze({assetId: asset.id, url}),
                context,
              );
              if (!isRecord(loaded) || !(loaded.bytes instanceof Uint8Array)) {
                throw new TypeError(`Remote pose model file is invalid: ${path}`);
              }
              return Object.freeze({
                path,
                size: loaded.bytes.byteLength,
                contentType: mediaType(loaded.contentType),
                bytes: new Uint8Array(loaded.bytes),
              });
            };
            const [modelFile, metadataFile] = await Promise.all([
              loadFile('model.json'),
              loadFile('metadata.json'),
            ]);
            if (context.signal?.aborted) throw abortError();
            const model = parseDsl4RemotePoseJson(modelFile.bytes, 'model.json');
            const weightsPath = resolveDsl4RemotePoseWeightsPath(model);
            parseDsl4RemotePoseJson(metadataFile.bytes, 'metadata.json');
            const weightsFile = await loadFile(weightsPath);
            if (context.signal?.aborted) throw abortError();
            return Object.freeze({
              asset,
              files: Object.freeze([modelFile, metadataFile, weightsFile]),
            });
          } catch (error) {
            if (
              context.signal?.aborted ||
              (error instanceof Error && error.name === 'AbortError')
            ) {
              throw abortError();
            }
            const errorRecord = isRecord(error) ? error : {};
            throw assetError(
              asset.id,
              typeof errorRecord.code === 'string' ? errorRecord.code : 'K4-ASSET-REMOTE-LOAD-001',
              error instanceof Error && error.message
                ? error.message
                : `Remote pose model loading failed: ${asset.id}`,
              error,
            );
          }
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
        if (asset.kind === 'recognitionModel') {
          return materializePoseArchive(
            asset,
            bytes,
            String(integrity),
            String(source.contentType),
            context,
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
    const sourceFiles = (source.files ?? []) as Record<string, any>[];
    if (source.type === 'file' && embeddedFileResolver) {
      return (async () => {
        const resolved = await embeddedFileResolver(asset.id, context);
        if (!Array.isArray(resolved)) {
          throw assetError(
            asset.id,
            'K4-ASSET-EMBEDDED-RESOLVER-001',
            `Embedded asset resolver returned invalid files: ${asset.id}`,
          );
        }
        const expected = new Map(sourceFiles.map((file) => [file.path, file]));
        if (resolved.length !== expected.size) {
          throw assetError(
            asset.id,
            'K4-ASSET-EMBEDDED-RESOLVER-001',
            `Embedded asset resolver returned an incomplete asset: ${asset.id}`,
          );
        }
        const seen = new Set();
        const files = resolved.map((candidate) => {
          if (!isRecord(candidate) || !(candidate.bytes instanceof Uint8Array)) {
            throw assetError(
              asset.id,
              'K4-ASSET-EMBEDDED-RESOLVER-001',
              `Embedded asset resolver returned an invalid file: ${asset.id}`,
            );
          }
          const expectedFile = expected.get(candidate.path);
          if (
            !expectedFile ||
            seen.has(candidate.path) ||
            candidate.size !== expectedFile.size ||
            candidate.integrity !== expectedFile.integrity ||
            candidate.bytes.byteLength !== expectedFile.size
          ) {
            throw assetError(
              asset.id,
              'K4-ASSET-EMBEDDED-RESOLVER-001',
              `Embedded asset resolver file does not match the manifest: ${asset.id}`,
            );
          }
          seen.add(candidate.path);
          return Object.freeze({
            path: candidate.path,
            size: candidate.size,
            integrity: candidate.integrity,
            bytes: new Uint8Array(candidate.bytes),
          });
        });
        return Object.freeze({asset, files: Object.freeze(files)});
      })();
    }
    const files =
      source.type === 'file'
        ? sourceFiles.map((file) =>
            Object.freeze({
              path: file.path,
              size: file.size,
              integrity: file.integrity,
              bytes: new Uint8Array((getAssetFile as Function)(asset.id, file.path)),
            }),
          )
        : [];
    return Object.freeze({asset, files: Object.freeze(files)});
  }

  async function releaseEntry(entry: Record<string, any>, reason: string) {
    if (!entry.hasResource || entry.released) return;
    entry.released = true;
    try {
      await adapter.release(entry.resource, Object.freeze({asset: entry.asset, reason}));
    } catch (error) {
      entry.releaseError = error;
      throw error;
    }
  }

  function createEntry(assetId: string, context: Readonly<Record<string, any>>) {
    const asset = manifest.get(assetId) as Record<string, any>;
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

  async function prepare(
    payload: Readonly<Record<string, unknown>>,
    context: Readonly<Record<string, any>>,
  ) {
    if (!isRecord(payload) || !Array.isArray(payload.assetIds)) {
      throw new TypeError('asset prepare payload must provide assetIds');
    }
    if (!isRecord(context)) throw new TypeError('asset prepare context must be an object');
    const requested = payload.assetIds;
    if (requested.some((assetId) => typeof assetId !== 'string')) {
      throw new TypeError('assetIds must contain strings');
    }
    const assetIds = sortedUnique(requested as string[]);
    for (const assetId of assetIds) {
      if (!manifest.has(assetId)) throw new TypeError(`Unknown embedded asset: ${assetId}`);
    }
    const entries = await Promise.all(
      assetIds.map(async (assetId) => {
        const releaseLock = releaseLocks.get(assetId);
        if (releaseLock) await releaseLock;
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

  async function releaseAssets(payload: Readonly<Record<string, unknown>>) {
    if (!isRecord(payload) || !Array.isArray(payload.assetIds)) {
      throw new TypeError('asset release payload must provide assetIds');
    }
    const requested = payload.assetIds;
    if (requested.some((assetId) => typeof assetId !== 'string')) {
      throw new TypeError('release assetIds must contain strings');
    }
    const assetIds = sortedUnique(requested as string[]);
    for (const assetId of assetIds) {
      if (!manifest.has(assetId)) throw new TypeError(`Unknown embedded asset: ${assetId}`);
    }
    const reason = typeof payload.reason === 'string' ? payload.reason : 'asset-release';
    const errors: unknown[] = [];
    await Promise.all(
      assetIds.map(async (assetId) => {
        const existingLock = releaseLocks.get(assetId);
        if (existingLock) {
          try {
            await existingLock;
          } catch (error) {
            errors.push(error);
          }
          return;
        }
        const entry = cache.get(assetId);
        if (!entry) return;
        if (cache.get(assetId) === entry) cache.delete(assetId);
        const operation = Promise.resolve().then(async () => {
          await entry.promise.catch(() => {});
          if (!entry.released) await releaseEntry(entry, reason);
          if (entry.releaseError) throw entry.releaseError;
        });
        releaseLocks.set(assetId, operation);
        try {
          await operation;
        } catch (error) {
          errors.push(error);
        } finally {
          if (releaseLocks.get(assetId) === operation) releaseLocks.delete(assetId);
        }
      }),
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more selected assets could not be released');
    }
  }

  async function performRelease(payload: Readonly<Record<string, unknown>>) {
    const reason =
      isRecord(payload) && typeof payload.reason === 'string' ? payload.reason : 'release';
    epoch += 1;
    const entries = [...cache.values()].reverse();
    cache.clear();
    const errors = [];
    for (const operation of releaseLocks.values()) {
      try {
        await operation;
      } catch (error) {
        errors.push(error);
      }
    }
    releaseLocks.clear();
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

  function release(payload: Readonly<Record<string, unknown>>) {
    if (releaseAllLock) return releaseAllLock;
    const operation = performRelease(payload);
    releaseAllLock = operation;
    void operation
      .finally(() => {
        if (releaseAllLock === operation) releaseAllLock = null;
      })
      .catch(() => {});
    return operation;
  }

  function getResource(assetId: unknown) {
    if (typeof assetId !== 'string') throw new TypeError('assetId must be a string');
    const entry = cache.get(assetId);
    return entry?.status === 'ready' && !entry.released ? entry.resource : null;
  }

  return Object.freeze({
    prepare,
    getResource,
    setLoading(
      payload: Readonly<Record<string, unknown>>,
      context: Readonly<Record<string, unknown>>,
    ) {
      return setLoading(payload, context);
    },
    releaseAssets,
    release,
  });
}

/** Enable remote delivery through an explicitly injected loader. */
export function createDsl4RemoteAssetLifecycle(
  options: Parameters<typeof createDsl4EmbeddedAssetLifecycle>[0],
) {
  if (
    !options ||
    (typeof options.loadRemoteAsset !== 'function' &&
      typeof options.resolveVerifiedRemoteAsset !== 'function')
  ) {
    throw new TypeError('remote asset lifecycle requires a remote asset resolver');
  }
  return createDsl4EmbeddedAssetLifecycle(options);
}
