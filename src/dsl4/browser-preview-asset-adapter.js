import {validateDsl4AssetCandidate} from './asset-candidate-validator.js';
import {classifyDsl4AssetReload, createDsl4AssetReloadSnapshot} from './asset-reload-policy.js';
import {createDsl4AssetSnapshotWatch} from './asset-snapshot-watch.js';
import {computeDsl4Sha256Integrity} from './source-descriptor.js';
import {deepFreeze} from './story-document.js';
import {extractDsl4PoseArchive} from './pose-archive-extractor.js';
import {isDsl4PoseArchivePath} from './pose-archive-locator.js';

const sha256SRI = /^sha256-[A-Za-z0-9+/]{43}=$/u;

export const dsl4BrowserPreviewAssetDefaults = deepFreeze({
  maxFiles: 128,
  maxFileBytes: 20_971_520,
  maxTotalBytes: 67_108_864,
  maxImagePixels: 16_777_216,
  maxAudioDurationSeconds: 1_800,
  maxAudioChannels: 8,
  maxAudioSampleRate: 192_000,
  maxConcurrentDecodes: 2,
});

export class Dsl4BrowserPreviewAssetError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'Dsl4BrowserPreviewAssetError';
    this.code = code;
  }
}

/** @param {string} code @param {string} message @param {unknown} [cause] @returns {never} */
function fail(code, message, cause) {
  throw new Dsl4BrowserPreviewAssetError(code, message, cause);
}

function abortError() {
  const error = new Dsl4BrowserPreviewAssetError(
    'K4-ASSET-PREPARE-001',
    'Asset read was cancelled',
  );
  error.name = 'AbortError';
  return error;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name */
function positiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} name */
function integrity(value, name) {
  if (typeof value !== 'string' || !sha256SRI.test(value)) {
    throw new TypeError(`${name} must be a canonical SHA-256 SRI value`);
  }
  return value;
}

/** @param {unknown} value */
function directoryHandle(value) {
  if (
    !isRecord(value) ||
    value.kind !== 'directory' ||
    typeof value.getDirectoryHandle !== 'function' ||
    typeof value.getFileHandle !== 'function' ||
    typeof value.queryPermission !== 'function'
  ) {
    throw new TypeError('asset adapter requires a read-only FileSystemDirectoryHandle');
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value */
function sourceContext(value) {
  if (
    !isRecord(value) ||
    !isRecord(value.sourceResult) ||
    value.sourceResult.ok !== true ||
    !isRecord(value.sourceResult.storyDocument) ||
    !isRecord(value.sourceResult.sourceSnapshot)
  ) {
    throw new TypeError('asset adapter requires one valid source frontend result');
  }
  const storyDocument = value.sourceResult.storyDocument;
  if (storyDocument.kind !== 'StoryDocument' || storyDocument.version !== '4.0') {
    throw new TypeError('asset adapter source result must contain a DSL 4.0 StoryDocument');
  }
  const sourceIntegrity = integrity(value.sourceResult.sourceSnapshot.integrity, 'sourceIntegrity');
  const structuralFingerprint = integrity(value.structuralFingerprint, 'structuralFingerprint');
  return Object.freeze({
    sourceResult: value.sourceResult,
    storyDocument,
    sourceIntegrity,
    structuralFingerprint,
  });
}

/** @param {string} value @param {string} name */
function relativePath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
    fail('K4-ASSET-PATH-001', `${name} must be a non-empty relative path`);
  }
  const segments = value.split('/');
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    fail('K4-ASSET-PATH-001', `${name} must stay inside the selected project root`);
  }
  return segments;
}

/** @param {unknown} error */
function mapFileError(error) {
  if (error instanceof Dsl4BrowserPreviewAssetError) return error;
  const name = isRecord(error) && typeof error.name === 'string' ? error.name : '';
  if (name === 'NotFoundError') {
    return new Dsl4BrowserPreviewAssetError(
      'K4-ASSET-MISSING',
      'Referenced asset is missing',
      error,
    );
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new Dsl4BrowserPreviewAssetError(
      'K4-ASSET-PERMISSION-001',
      'Asset read permission was denied or revoked',
      error,
    );
  }
  return new Dsl4BrowserPreviewAssetError(
    'K4-ASSET-PREPARE-001',
    'Asset snapshot could not be read',
    error,
  );
}

/** @param {Record<string, any>} root @param {ReadonlyArray<string>} segments */
async function resolveParent(root, segments) {
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = await current.getDirectoryHandle(segment);
    if (!isRecord(current) || current.kind !== 'directory') {
      fail('K4-ASSET-PATH-001', 'Asset path does not resolve through directories');
    }
  }
  return current;
}

/** @param {Record<string, any>} handle @param {number} maxFileBytes @param {AbortSignal} signal */
async function readHandle(handle, maxFileBytes, signal) {
  if (!isRecord(handle) || handle.kind !== 'file' || typeof handle.getFile !== 'function') {
    fail('K4-ASSET-PREPARE-001', 'Asset entry is not a readable file');
  }
  if (signal.aborted) throw abortError();
  const file = await handle.getFile();
  if (!isRecord(file) || typeof file.arrayBuffer !== 'function') {
    fail('K4-ASSET-PREPARE-001', 'Asset file handle returned an invalid File');
  }
  if (typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0) {
    fail('K4-ASSET-PREPARE-001', 'Asset file size is invalid');
  }
  if (file.size > maxFileBytes) fail('K4-ASSET-LIMIT-001', 'Asset file exceeds maxFileBytes');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (signal.aborted) throw abortError();
  if (bytes.length !== file.size || bytes.length > maxFileBytes) {
    fail('K4-ASSET-UNSTABLE-001', 'Asset file changed while being read');
  }
  return bytes;
}

/** @param {Record<string, any>} root @param {string} filePath @param {number} limit @param {AbortSignal} signal */
async function readSingleFile(root, filePath, limit, signal) {
  const segments = relativePath(filePath, 'asset file');
  const fileName = /** @type {string} */ (segments.at(-1));
  try {
    const parent = await resolveParent(root, segments);
    const handle = await parent.getFileHandle(fileName);
    return [{path: fileName, bytes: await readHandle(handle, limit, signal)}];
  } catch (error) {
    throw mapFileError(error);
  }
}

/** @param {Record<string, any>} root @param {string} assetId @param {string} directoryPath @param {number} limit @param {number} totalLimit @param {{digest: Function}} subtleCrypto @param {AbortSignal} signal */
async function readPoseBundle(
  root,
  assetId,
  directoryPath,
  limit,
  totalLimit,
  subtleCrypto,
  signal,
) {
  if (isDsl4PoseArchivePath(directoryPath)) {
    const [archive] = await readSingleFile(root, directoryPath, limit, signal);
    const extracted = await extractDsl4PoseArchive(
      {
        assetId,
        bytes: archive.bytes,
        maxArchiveBytes: limit,
        maxFileBytes: limit,
        maxTotalBytes: totalLimit,
        subtleCrypto,
      },
      {signal},
    );
    return extracted.files.map((file) => ({path: file.path, bytes: file.bytes}));
  }
  const segments = relativePath(directoryPath, 'pose model directory');
  const directoryName = /** @type {string} */ (segments.at(-1));
  try {
    const parent = await resolveParent(root, segments);
    const bundle = await parent.getDirectoryHandle(directoryName);
    if (!isRecord(bundle) || bundle.kind !== 'directory' || typeof bundle.entries !== 'function') {
      fail('K4-ASSET-POSE-BUNDLE-001', 'Pose model is not an enumerable directory');
    }
    /** @type {Array<[string, Record<string, any>]>} */
    const entries = [];
    for await (const entry of bundle.entries()) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        fail('K4-ASSET-POSE-BUNDLE-001', 'Pose model directory entry is invalid');
      }
      const [name, handle] = entry;
      if (
        typeof name !== 'string' ||
        name.length === 0 ||
        name.includes('/') ||
        name.includes('\\') ||
        !isRecord(handle) ||
        handle.kind !== 'file'
      ) {
        fail('K4-ASSET-POSE-BUNDLE-001', 'Pose model contains an unsupported entry');
      }
      entries.push([name, /** @type {Record<string, any>} */ (handle)]);
    }
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    if (entries.length !== 3) {
      fail('K4-ASSET-POSE-BUNDLE-001', 'Pose model requires exactly three files');
    }
    /** @type {Array<{path: string, bytes: Uint8Array}>} */
    const files = [];
    for (const [name, handle] of entries) {
      files.push({path: name, bytes: await readHandle(handle, limit, signal)});
    }
    return files;
  } catch (error) {
    throw mapFileError(error);
  }
}

/** @param {Readonly<Record<string, any>>} asset @param {string} id */
function commonManifestAsset(asset, id) {
  return {
    id,
    kind: asset.kind,
    loading: asset.loading,
    ...(asset.target === undefined ? {} : {target: asset.target}),
  };
}

/**
 * Read only StoryDocument-allowlisted paths and publish stable immutable asset candidates.
 *
 * @param {object} options
 * @param {(bytes: Uint8Array, context: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} options.inspectImage
 * @param {(bytes: Uint8Array, context: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} options.inspectAudio
 * @param {(candidate: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} options.onCandidate
 * @param {(diagnostic: Readonly<Record<string, unknown>> | null) => unknown | Promise<unknown>} [options.onDiagnostic]
 * @param {(state: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.onStatus]
 * @param {(error: unknown) => unknown} [options.onError]
 * @param {Function} [options.createWatch]
 * @param {{digest: Function}} [options.subtleCrypto]
 * @param {number} [options.maxFiles]
 * @param {number} [options.maxFileBytes]
 * @param {number} [options.maxTotalBytes]
 * @param {number} [options.maxImagePixels]
 * @param {number} [options.maxAudioDurationSeconds]
 * @param {number} [options.maxAudioChannels]
 * @param {number} [options.maxAudioSampleRate]
 * @param {Record<string, unknown>} [options.watchOptions]
 */
export function createDsl4BrowserPreviewAssetAdapter(options) {
  if (!isRecord(options)) throw new TypeError('browser preview asset options are required');
  if (
    typeof options.inspectImage !== 'function' ||
    typeof options.inspectAudio !== 'function' ||
    typeof options.onCandidate !== 'function'
  ) {
    throw new TypeError('browser preview assets require inspectors and onCandidate');
  }
  if (options.watchOptions !== undefined && !isRecord(options.watchOptions)) {
    throw new TypeError('watchOptions must be an object');
  }
  const createWatch = options.createWatch ?? createDsl4AssetSnapshotWatch;
  if (typeof createWatch !== 'function') throw new TypeError('createWatch must be a function');
  const subtleCrypto = options.subtleCrypto ?? globalThis.crypto?.subtle;
  const limits = {
    maxFiles: positiveLimit(
      options.maxFiles ?? dsl4BrowserPreviewAssetDefaults.maxFiles,
      'maxFiles',
    ),
    maxFileBytes: positiveLimit(
      options.maxFileBytes ?? dsl4BrowserPreviewAssetDefaults.maxFileBytes,
      'maxFileBytes',
    ),
    maxTotalBytes: positiveLimit(
      options.maxTotalBytes ?? dsl4BrowserPreviewAssetDefaults.maxTotalBytes,
      'maxTotalBytes',
    ),
    maxImagePixels: positiveLimit(
      options.maxImagePixels ?? dsl4BrowserPreviewAssetDefaults.maxImagePixels,
      'maxImagePixels',
    ),
    maxAudioDurationSeconds: positiveLimit(
      options.maxAudioDurationSeconds ?? dsl4BrowserPreviewAssetDefaults.maxAudioDurationSeconds,
      'maxAudioDurationSeconds',
    ),
    maxAudioChannels: positiveLimit(
      options.maxAudioChannels ?? dsl4BrowserPreviewAssetDefaults.maxAudioChannels,
      'maxAudioChannels',
    ),
    maxAudioSampleRate: positiveLimit(
      options.maxAudioSampleRate ?? dsl4BrowserPreviewAssetDefaults.maxAudioSampleRate,
      'maxAudioSampleRate',
    ),
  };

  /** @type {Record<string, any> | null} */
  let root = null;
  /** @type {Readonly<Record<string, any>> | null} */
  let activeSnapshot = null;
  /** @type {Readonly<Record<string, any>> | null} */
  let candidateValue = null;
  /** @type {string | null} */
  let activeProviderId = null;
  let nextProviderId = 1;
  const providers = new Map();

  /** @param {unknown} inputContext @param {{signal: AbortSignal, revision: number}} readOptions */
  async function read(inputContext, readOptions) {
    if (!root) throw new TypeError('asset adapter has no project root');
    const context = sourceContext(inputContext);
    let permission;
    try {
      permission = await root.queryPermission({mode: 'read'});
    } catch (error) {
      throw mapFileError(error);
    }
    if (permission !== 'granted') {
      fail('K4-ASSET-PERMISSION-001', 'Asset read permission was denied or revoked');
    }
    const manifestAssets = [];
    const blobs = new Map();
    const validations = [];
    /** @type {Function[]} */
    const releases = [];
    let fileCount = 0;
    let totalBytes = 0;
    let released = false;
    const providerId = `asset-provider-${nextProviderId++}`;

    async function release() {
      if (released) return;
      released = true;
      providers.delete(providerId);
      blobs.clear();
      const errors = [];
      for (const operation of releases.reverse()) {
        try {
          await operation();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Asset provider release failed');
    }

    try {
      const assets = /** @type {Readonly<Record<string, Readonly<Record<string, any>>>>} */ (
        context.storyDocument.assets ?? {}
      );
      for (const id of Object.keys(assets).sort()) {
        const asset = assets[id];
        const common = commonManifestAsset(asset, id);
        if (asset.delivery === 'remote') {
          manifestAssets.push({...common, source: {type: 'remote', ...asset.source}});
          continue;
        }
        if (typeof asset.file !== 'string') {
          manifestAssets.push({...common, source: {type: 'project', name: asset.name}});
          continue;
        }
        const files =
          asset.kind === 'poseModel'
            ? await readPoseBundle(
                root,
                id,
                asset.file,
                limits.maxFileBytes,
                limits.maxTotalBytes,
                subtleCrypto,
                readOptions.signal,
              )
            : await readSingleFile(root, asset.file, limits.maxFileBytes, readOptions.signal);
        fileCount += files.length;
        if (fileCount > limits.maxFiles)
          fail('K4-ASSET-LIMIT-001', 'Asset snapshot exceeds maxFiles');
        const metadata = [];
        for (const file of files) {
          totalBytes += file.bytes.length;
          if (totalBytes > limits.maxTotalBytes) {
            fail('K4-ASSET-LIMIT-001', 'Asset snapshot exceeds maxTotalBytes');
          }
          const fileIntegrity = await computeDsl4Sha256Integrity(file.bytes, subtleCrypto);
          metadata.push({path: file.path, size: file.bytes.length, integrity: fileIntegrity});
          blobs.set(`${id}\u0000${file.path}`, new Uint8Array(file.bytes));
        }
        const validation = await validateDsl4AssetCandidate({
          storyDocument: context.storyDocument,
          asset: {id, ...asset},
          files,
          signal: readOptions.signal,
          inspectImage: options.inspectImage,
          inspectAudio: options.inspectAudio,
          ...limits,
        });
        validations.push(validation.summary);
        releases.push(validation.release);
        manifestAssets.push({
          ...common,
          source: {
            type: 'file',
            inputPath: asset.file,
            mode:
              asset.kind === 'poseModel' && isDsl4PoseArchivePath(asset.file)
                ? 'archive'
                : asset.kind === 'poseModel'
                  ? 'directory'
                  : 'file',
            files: metadata,
          },
        });
      }
      const manifest = deepFreeze({formatVersion: 1, assets: manifestAssets});
      const snapshot = await createDsl4AssetReloadSnapshot({
        storyDocument: context.storyDocument,
        manifest,
        structuralFingerprint: context.structuralFingerprint,
        sourceIntegrity: context.sourceIntegrity,
        subtleCrypto,
      });
      providers.set(
        providerId,
        Object.freeze({
          providerId,
          manifest,
          /** @param {string} assetId @param {string} filePath */
          getFile(assetId, filePath) {
            const bytes = blobs.get(`${assetId}\u0000${filePath}`);
            if (!bytes) fail('K4-ASSET-MISSING', 'Asset provider file is missing');
            return new Uint8Array(bytes);
          },
        }),
      );
      return {
        key: `${snapshot.structuralFingerprint}:${snapshot.sourceIntegrity}:${snapshot.graphIntegrity}:${snapshot.contentIntegrity}`,
        value: deepFreeze({
          formatVersion: 1,
          providerId,
          storyDocument: context.storyDocument,
          manifest,
          snapshot,
          validations,
        }),
        release,
      };
    } catch (error) {
      try {
        await release();
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], 'Asset snapshot and cleanup failed');
      }
      throw error;
    }
  }

  const watchOptions = options.watchOptions ?? {};
  for (const reserved of ['read', 'onCandidate', 'onDiagnostic', 'onStatus', 'onError']) {
    if (Object.hasOwn(watchOptions, reserved)) {
      throw new TypeError(`watchOptions must not override ${reserved}`);
    }
  }
  const watch = createWatch({
    ...watchOptions,
    read,
    onDiagnostic: options.onDiagnostic,
    onStatus: options.onStatus,
    onError: options.onError,
    async onCandidate(/** @type {Readonly<Record<string, any>>} */ event) {
      const value = /** @type {Readonly<Record<string, any>>} */ (event.value);
      candidateValue = value;
      const classification = activeSnapshot
        ? classifyDsl4AssetReload({active: activeSnapshot, candidate: value.snapshot})
        : deepFreeze({formatVersion: 1, kind: 'initial', changedAssets: [], affectedScenes: []});
      try {
        await options.onCandidate(
          deepFreeze({
            formatVersion: 1,
            revision: event.revision,
            providerId: value.providerId,
            sourceIntegrity: value.snapshot.sourceIntegrity,
            graphIntegrity: value.snapshot.graphIntegrity,
            contentIntegrity: value.snapshot.contentIntegrity,
            classification,
            validations: value.validations,
          }),
        );
      } catch (error) {
        candidateValue = null;
        throw error;
      }
    },
  });

  return Object.freeze({
    /** @param {unknown} projectRoot @param {unknown} context */
    start(projectRoot, context) {
      root = directoryHandle(projectRoot);
      return watch.start(sourceContext(context));
    },
    /** @param {unknown} context */
    updateSource(context) {
      return watch.update(sourceContext(context));
    },
    pollNow: () => watch.pollNow(),
    setHidden: (/** @type {boolean} */ value) => watch.setHidden(value),
    async accept(/** @type {number} */ revision) {
      if (!candidateValue || watch.getState().candidate?.revision !== revision) {
        fail('K4-ASSET-STALE-001', 'Asset candidate is stale');
      }
      const state = await watch.accept(revision);
      activeSnapshot = candidateValue.snapshot;
      activeProviderId = candidateValue.providerId;
      candidateValue = null;
      return state;
    },
    async discard(/** @type {number} */ revision) {
      const state = await watch.discard(revision);
      candidateValue = null;
      return state;
    },
    /** @param {number} revision */
    getCandidateProvider(revision) {
      if (!candidateValue || watch.getState().candidate?.revision !== revision) {
        fail('K4-ASSET-STALE-001', 'Asset candidate is stale');
      }
      return providers.get(candidateValue.providerId) ?? null;
    },
    getActiveProvider() {
      return activeProviderId ? (providers.get(activeProviderId) ?? null) : null;
    },
    getState() {
      return deepFreeze({
        version: 1,
        watch: watch.getState(),
        activeProviderId,
        candidateProviderId: candidateValue?.providerId ?? null,
        providerCount: providers.size,
      });
    },
    async dispose() {
      const state = await watch.dispose();
      root = null;
      activeSnapshot = null;
      candidateValue = null;
      activeProviderId = null;
      providers.clear();
      return state;
    },
    whenIdle: () => watch.whenIdle(),
  });
}
