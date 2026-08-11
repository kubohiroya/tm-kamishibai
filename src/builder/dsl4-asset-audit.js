import {lstat, open, realpath} from 'node:fs/promises';
import path from 'node:path';

import {
  Dsl4AssetDistributionError,
  resolveDsl4AssetDistributionProfile,
  validateDsl4AssetDistributionConfig,
  validateDsl4AssetDistributionLock,
} from '../dsl4/asset-distribution-profile.js';
import {createDsl4AssetDependencyIndex} from '../dsl4/asset-dependency-index.js';
import {createDsl4SourceGraphFrontend} from '../dsl4/source-graph-frontend.js';
import {deepFreeze} from '../dsl4/story-document.js';
import {
  loadDsl4ExternalSource,
  validateDsl4ExternalSourceManifest,
} from './dsl4-external-source.js';
import {loadDsl4BuildSourceGraph} from './dsl4-source-graph.js';
import {resolveDsl4BuildSourceLimits} from './dsl4-source-limits.js';
import {Sb3BuilderError} from './errors.js';

const defaultFileSystem = Object.freeze({lstat, open, realpath});
const textDecoder = new TextDecoder('utf-8', {fatal: true});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} message @param {string} code @param {unknown} [cause] @returns {never} */
function fail(message, code, cause) {
  throw new Sb3BuilderError(message, {stage: 'dsl4-asset-audit', code, cause});
}

/** @param {unknown} value @param {string} name */
function positiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

/** @param {unknown} value */
function validateFileSystem(value) {
  if (
    !isRecord(value) ||
    typeof value.realpath !== 'function' ||
    typeof value.lstat !== 'function' ||
    typeof value.open !== 'function'
  ) {
    throw new TypeError('fileSystem must provide realpath, lstat, and open');
  }
  return /** @type {{realpath: Function, lstat: Function, open: Function}} */ (value);
}

/** @param {string} ancestor @param {string} candidate */
function isWithin(ancestor, candidate) {
  const relative = path.relative(ancestor, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/** @param {Record<string, any>} left @param {Record<string, any>} right */
function sameFileState(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/**
 * @param {string} filePath
 * @param {number} limit
 * @param {{open: Function}} fileSystem
 */
async function readBoundedFile(filePath, limit, fileSystem) {
  const handle = await fileSystem.open(filePath, 'r');
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  try {
    while (size <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - size + 1));
      const result = await handle.read(chunk, 0, chunk.length, null);
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      size += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  if (size > limit) fail('Project JSON exceeds its finite byte limit', 'K4-ASSET-AUDIT-001');
  return Buffer.concat(chunks, size);
}

/**
 * @param {string} requestedRoot
 * @param {string} canonicalRoot
 * @param {string} inputPath
 * @param {object} options
 * @param {number} options.maxBytes
 * @param {string} options.label
 * @param {string} options.code
 * @param {{realpath: Function, lstat: Function, open: Function}} options.fileSystem
 * @param {(filePath: string, limit: number) => Promise<Buffer | Uint8Array>} options.readFile
 */
async function readStableProjectJson(
  requestedRoot,
  canonicalRoot,
  inputPath,
  {maxBytes, label, code, fileSystem, readFile},
) {
  if (typeof inputPath !== 'string' || inputPath.length === 0 || inputPath.includes('\0')) {
    throw new TypeError(`${label} path must be a non-empty string without NUL`);
  }
  const requestedPath = path.resolve(inputPath);
  if (!isWithin(requestedRoot, requestedPath) || path.extname(requestedPath) !== '.json') {
    fail(`${label} must be a project-local JSON file`, code);
  }
  let requestedState;
  let canonicalPath;
  try {
    requestedState = await fileSystem.lstat(requestedPath);
    if (requestedState.isSymbolicLink()) fail(`${label} must not be a symbolic link`, code);
    canonicalPath = await fileSystem.realpath(requestedPath);
  } catch (error) {
    if (error instanceof Sb3BuilderError) throw error;
    fail(`Cannot resolve ${label}`, code, error);
  }
  if (!isWithin(canonicalRoot, canonicalPath)) fail(`${label} escapes the project root`, code);
  if (!requestedState.isFile()) fail(`${label} is not a regular file`, code);
  if (requestedState.size > maxBytes) fail(`${label} exceeds its finite byte limit`, code);

  let before;
  let first;
  let middle;
  let second;
  let after;
  try {
    before = await fileSystem.lstat(canonicalPath);
    first = Buffer.from(await readFile(canonicalPath, maxBytes));
    middle = await fileSystem.lstat(canonicalPath);
    second = Buffer.from(await readFile(canonicalPath, maxBytes));
    after = await fileSystem.lstat(canonicalPath);
  } catch (error) {
    if (error instanceof Sb3BuilderError) throw error;
    fail(`Cannot read ${label}`, code, error);
  }
  if (first.length > maxBytes || second.length > maxBytes) {
    fail(`${label} exceeds its finite byte limit`, code);
  }
  if (!sameFileState(before, middle) || !sameFileState(middle, after) || !first.equals(second)) {
    fail(`${label} changed while it was being read`, code);
  }
  let decoded;
  try {
    decoded = textDecoder.decode(first);
  } catch (error) {
    fail(`${label} must be valid UTF-8`, code, error);
  }
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch (error) {
    fail(`${label} must contain valid JSON`, code, error);
  }
  if (!isRecord(parsed)) fail(`${label} JSON must contain one object`, code);
  return parsed;
}

/**
 * Read one project-local JSON file with the same bounded stable-snapshot contract used by audit.
 *
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {string} options.inputPath
 * @param {number} options.maxBytes
 * @param {string} options.label
 * @param {string} options.code
 * @param {{realpath: Function, lstat: Function, open: Function}} [options.fileSystem]
 * @param {(filePath: string, limit: number) => Promise<Buffer | Uint8Array>} [options.readFile]
 */
export async function loadDsl4ProjectJson({
  projectRoot,
  inputPath,
  maxBytes,
  label,
  code,
  fileSystem = defaultFileSystem,
  readFile,
}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('projectRoot must be a non-empty string');
  }
  const limit = positiveLimit(maxBytes, 'maxBytes');
  const fs = validateFileSystem(fileSystem);
  if (readFile !== undefined && typeof readFile !== 'function') {
    throw new TypeError('readFile must be a function');
  }
  const readSnapshot = readFile ?? ((filePath, maximum) => readBoundedFile(filePath, maximum, fs));
  const requestedRoot = path.resolve(projectRoot);
  let canonicalRoot;
  try {
    canonicalRoot = await fs.realpath(requestedRoot);
    const rootState = await fs.lstat(canonicalRoot);
    if (!rootState.isDirectory()) fail('Project root is not a directory', code);
  } catch (error) {
    if (error instanceof Sb3BuilderError) throw error;
    fail('Cannot resolve project root', code, error);
  }
  return readStableProjectJson(requestedRoot, canonicalRoot, inputPath, {
    maxBytes: limit,
    label,
    code,
    fileSystem: fs,
    readFile: readSnapshot,
  });
}

/**
 * Load one stable, bounded source manifest plus asset config and lock snapshot.
 *
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {string} options.sourceManifest
 * @param {string} options.assetConfig
 * @param {string} options.assetLock
 * @param {number} options.maxSourceManifestBytes
 * @param {number} options.maxAssetConfigBytes
 * @param {number} options.maxAssetLockBytes
 * @param {{realpath: Function, lstat: Function, open: Function}} [options.fileSystem]
 * @param {(filePath: string, limit: number) => Promise<Buffer | Uint8Array>} [options.readFile]
 */
export async function loadDsl4AssetAuditInputs({
  projectRoot,
  sourceManifest,
  assetConfig,
  assetLock,
  maxSourceManifestBytes,
  maxAssetConfigBytes,
  maxAssetLockBytes,
  fileSystem = defaultFileSystem,
  readFile,
}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('projectRoot must be a non-empty string');
  }
  const manifestLimit = positiveLimit(maxSourceManifestBytes, 'maxSourceManifestBytes');
  const configLimit = positiveLimit(maxAssetConfigBytes, 'maxAssetConfigBytes');
  const lockLimit = positiveLimit(maxAssetLockBytes, 'maxAssetLockBytes');
  const fs = validateFileSystem(fileSystem);
  if (readFile !== undefined && typeof readFile !== 'function') {
    throw new TypeError('readFile must be a function');
  }
  const readSnapshot = readFile ?? ((filePath, maximum) => readBoundedFile(filePath, maximum, fs));
  const requestedRoot = path.resolve(projectRoot);
  let canonicalRoot;
  try {
    canonicalRoot = await fs.realpath(requestedRoot);
    const rootState = await fs.lstat(canonicalRoot);
    if (!rootState.isDirectory()) fail('Project root is not a directory', 'K4-ASSET-AUDIT-001');
  } catch (error) {
    if (error instanceof Sb3BuilderError) throw error;
    fail('Cannot resolve project root', 'K4-ASSET-AUDIT-001', error);
  }
  const [manifestInput, configInput, lockInput] = await Promise.all([
    readStableProjectJson(requestedRoot, canonicalRoot, sourceManifest, {
      maxBytes: manifestLimit,
      label: 'source manifest',
      code: 'K4-SOURCE-MANIFEST-001',
      fileSystem: fs,
      readFile: readSnapshot,
    }),
    readStableProjectJson(requestedRoot, canonicalRoot, assetConfig, {
      maxBytes: configLimit,
      label: 'asset distribution config',
      code: 'K4-ASSET-PROFILE-001',
      fileSystem: fs,
      readFile: readSnapshot,
    }),
    readStableProjectJson(requestedRoot, canonicalRoot, assetLock, {
      maxBytes: lockLimit,
      label: 'asset distribution lock',
      code: 'K4-ASSET-LOCK-001',
      fileSystem: fs,
      readFile: readSnapshot,
    }),
  ]);
  try {
    return deepFreeze({
      sourceManifest: validateDsl4ExternalSourceManifest(manifestInput),
      config: validateDsl4AssetDistributionConfig(configInput),
      lock: validateDsl4AssetDistributionLock(lockInput),
    });
  } catch (error) {
    if (error instanceof Dsl4AssetDistributionError) fail(error.message, error.code, error);
    throw error;
  }
}

/** @param {ReadonlyArray<Readonly<Record<string, any>>>} assets */
function safeByteSum(assets) {
  let total = 0;
  for (const asset of assets) {
    total += Number(asset.logicalBytes);
    if (!Number.isSafeInteger(total))
      fail('Audit byte total is not a safe integer', 'K4-ASSET-AUDIT-001');
  }
  return total;
}

/** @param {ReadonlyArray<Readonly<Record<string, any>>>} assets */
function deliverySummary(assets) {
  const embedded = assets.filter(({delivery}) => delivery === 'embedded');
  const remote = assets.filter(({delivery}) => delivery === 'remote');
  let remoteTransportBytes = 0;
  for (const asset of remote) {
    remoteTransportBytes += Number(asset.transportBytes);
    if (!Number.isSafeInteger(remoteTransportBytes)) {
      fail('Audit remote byte total is not a safe integer', 'K4-ASSET-AUDIT-001');
    }
  }
  return {
    assets: assets.length,
    logicalBytes: safeByteSum(assets),
    embedded: {assets: embedded.length, logicalBytes: safeByteSum(embedded)},
    remote: {
      assets: remote.length,
      logicalBytes: safeByteSum(remote),
      transportBytes: remoteTransportBytes,
    },
  };
}

/**
 * Create one deterministic, redacted distribution audit without file or network access.
 *
 * @param {object} options
 * @param {Readonly<Record<string, unknown>>} options.storyDocument
 * @param {unknown} options.config
 * @param {unknown} options.lock
 * @param {string} options.profile
 */
export function createDsl4AssetDistributionAudit({storyDocument, config, lock, profile}) {
  const resolved = resolveDsl4AssetDistributionProfile(storyDocument, config, lock, profile);
  const dependencies = createDsl4AssetDependencyIndex(resolved.storyDocument);
  const resolvedStoryAssets =
    /** @type {Readonly<Record<string, Readonly<Record<string, any>>>>} */ (
      resolved.storyDocument.assets
    );
  const assets = resolved.assets.map((asset) => {
    const storyAsset = resolvedStoryAssets[asset.id];
    return {
      id: asset.id,
      kind: asset.kind,
      delivery: asset.delivery,
      loading: storyAsset.loading,
      retention: storyAsset.retention,
      contentIntegrity: asset.contentIntegrity,
      contentType: asset.contentType,
      logicalBytes: asset.size,
      transportBytes: asset.delivery === 'remote' ? asset.provider.size : asset.size,
    };
  });
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));

  /** @param {ReadonlyArray<string>} ids */
  const phase = (ids) => {
    const uniqueIds = [...new Set(ids)].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const phaseAssets = uniqueIds.map((assetId) => {
      const asset = assetsById.get(assetId);
      if (!asset) fail(`Dependency references unknown asset ${assetId}`, 'K4-ASSET-AUDIT-001');
      return asset;
    });
    return {...deliverySummary(phaseAssets), ids: uniqueIds};
  };

  const byKind = Object.fromEntries(
    [...new Set(assets.map(({kind}) => kind))]
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((kind) => [kind, deliverySummary(assets.filter((asset) => asset.kind === kind))]),
  );
  const eagerAssets = assets.filter(({loading}) => loading !== 'lazy');
  const lazyAssets = assets.filter(({loading}) => loading === 'lazy');
  const scenes = Object.fromEntries(
    Object.entries(dependencies.scenes).map(([sceneId, scene]) => [
      sceneId,
      {
        all: phase(scene.all),
        eager: phase(scene.eager),
        lazy: phase(scene.lazy),
        sceneRetained: phase(scene.sceneRetained),
      },
    ]),
  );

  /** @type {Map<string, Record<string, any>[]>} */
  const duplicateGroups = new Map();
  for (const asset of assets) {
    const group = duplicateGroups.get(asset.contentIntegrity) ?? [];
    group.push(asset);
    duplicateGroups.set(asset.contentIntegrity, group);
  }
  const duplicates = [...duplicateGroups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([contentIntegrity, group]) => ({
      contentIntegrity,
      assetIds: group.map(({id}) => id).sort(),
      logicalBytes: group[0].logicalBytes,
      savingsBytes: group[0].logicalBytes * (group.length - 1),
    }))
    .sort(({contentIntegrity: left}, {contentIntegrity: right}) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
  const duplicateSavingsBytes = duplicates.reduce((total, group) => {
    const next = total + group.savingsBytes;
    if (!Number.isSafeInteger(next)) fail('Duplicate byte total is not safe', 'K4-ASSET-AUDIT-001');
    return next;
  }, 0);
  const totals = deliverySummary(assets);
  return deepFreeze({
    formatVersion: 1,
    profile: resolved.profile,
    network: resolved.network,
    offlineReady: totals.remote.assets === 0,
    totals: {
      ...totals,
      eager: deliverySummary(eagerAssets),
      lazy: deliverySummary(lazyAssets),
    },
    byKind,
    preparation: {
      startup: phase(dependencies.startup),
      cover: phase(dependencies.cover),
      actors: phase(dependencies.actors),
      loading: phase(dependencies.loading),
      poseRecognition: phase(dependencies.poseRecognition),
      posePreviewControls: phase(dependencies.posePreviewControls),
    },
    scenes,
    duplicates: {groups: duplicates, savingsBytes: duplicateSavingsBytes},
    assets,
  });
}

/**
 * Load project inputs and create one audit using the production source frontend.
 *
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {string} options.sourceManifest
 * @param {string} options.assetConfig
 * @param {string} options.assetLock
 * @param {string} options.assetProfile
 * @param {{parse(source: string, options?: {sourceId?: string}): Readonly<Record<string, any>>}} options.sourceFrontend
 * @param {number} options.maxSourceBytes
 * @param {number} options.maxSourceManifestBytes
 * @param {number} options.maxAssetConfigBytes
 * @param {number} options.maxAssetLockBytes
 * @param {boolean} [options.sourceIncludesEnabled]
 * @param {number} [options.maxSourceFiles]
 * @param {number} [options.maxTotalSourceBytes]
 * @param {number} [options.maxIncludeDepth]
 * @param {{realpath: Function, lstat: Function, open: Function}} [options.fileSystem]
 * @param {(filePath: string, limit: number) => Promise<Buffer | Uint8Array>} [options.readFile]
 */
export async function auditDsl4AssetDistribution(options) {
  if (!isRecord(options)) throw new TypeError('asset distribution audit options are required');
  if (!options.sourceFrontend || typeof options.sourceFrontend.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse');
  }
  const sourceIncludesEnabled = options.sourceIncludesEnabled ?? false;
  if (typeof sourceIncludesEnabled !== 'boolean') {
    throw new TypeError('sourceIncludesEnabled must be a boolean');
  }
  let sourceGraphLimits;
  if (sourceIncludesEnabled) {
    sourceGraphLimits = {
      maxSourceFiles: positiveLimit(options.maxSourceFiles, 'maxSourceFiles'),
      maxIncludeDepth: positiveLimit(options.maxIncludeDepth, 'maxIncludeDepth'),
    };
  } else {
    if (options.maxSourceFiles !== undefined) {
      throw new TypeError('maxSourceFiles requires sourceIncludesEnabled');
    }
    if (options.maxTotalSourceBytes !== undefined) {
      throw new TypeError('maxTotalSourceBytes requires sourceIncludesEnabled');
    }
    if (options.maxIncludeDepth !== undefined) {
      throw new TypeError('maxIncludeDepth requires sourceIncludesEnabled');
    }
  }
  const sourceLimits = resolveDsl4BuildSourceLimits({
    sourceIncludesEnabled,
    maxSourceBytes: options.maxSourceBytes,
    maxTotalSourceBytes: options.maxTotalSourceBytes,
  });
  const inputs = await loadDsl4AssetAuditInputs({
    projectRoot: options.projectRoot,
    sourceManifest: options.sourceManifest,
    assetConfig: options.assetConfig,
    assetLock: options.assetLock,
    maxSourceManifestBytes: options.maxSourceManifestBytes,
    maxAssetConfigBytes: options.maxAssetConfigBytes,
    maxAssetLockBytes: options.maxAssetLockBytes,
    ...(options.fileSystem === undefined ? {} : {fileSystem: options.fileSystem}),
    ...(options.readFile === undefined ? {} : {readFile: options.readFile}),
  });
  const source = await loadDsl4ExternalSource(options.projectRoot, inputs.sourceManifest, {
    maxSourceBytes: sourceLimits.maxSourceFileBytes,
    ...(options.fileSystem === undefined ? {} : {fileSystem: options.fileSystem}),
    ...(options.readFile === undefined ? {} : {readSource: options.readFile}),
  });
  let parsed;
  if (sourceIncludesEnabled) {
    const sourceGraph = await loadDsl4BuildSourceGraph(options.projectRoot, source, {
      limits: {
        maxSourceBytes: sourceLimits.maxSourceFileBytes,
        maxTotalSourceBytes: sourceLimits.maxSourceGraphBytes,
        ...sourceGraphLimits,
      },
      ...(options.fileSystem === undefined ? {} : {fileSystem: options.fileSystem}),
      ...(options.readFile === undefined ? {} : {readSource: options.readFile}),
    });
    parsed = createDsl4SourceGraphFrontend(options.sourceFrontend).parse(sourceGraph, {
      featureFlags: {dsl4Runtime: true, dsl4SourceIncludes: true},
      sourceId: source.descriptor.sourceId,
      maxComposedSourceBytes: sourceLimits.maxComposedSourceBytes,
    });
  } else {
    parsed = options.sourceFrontend.parse(source.descriptor.text, {
      sourceId: source.descriptor.sourceId,
    });
  }
  const parseResult = /** @type {Readonly<Record<string, any>>} */ (parsed);
  if (!parseResult.ok) {
    const first = parseResult.diagnostics?.[0];
    fail(first?.message ?? 'DSL 4.0 source validation failed', first?.code ?? 'K4-ASSET-AUDIT-001');
  }
  try {
    return createDsl4AssetDistributionAudit({
      storyDocument: parseResult.storyDocument,
      config: inputs.config,
      lock: inputs.lock,
      profile: options.assetProfile,
    });
  } catch (error) {
    if (error instanceof Dsl4AssetDistributionError) fail(error.message, error.code, error);
    throw error;
  }
}

/** @param {Readonly<Record<string, any>>} audit */
export function serializeDsl4AssetDistributionAudit(audit) {
  return `${JSON.stringify(audit)}\n`;
}

/** @param {Readonly<Record<string, any>>} audit */
export function formatDsl4AssetDistributionAudit(audit) {
  const lines = [
    `Asset profile: ${audit.profile}`,
    `Network: ${audit.network}`,
    `Offline ready: ${audit.offlineReady ? 'yes' : 'no'}`,
    `Assets: ${audit.totals.assets} (${audit.totals.logicalBytes} logical bytes)`,
    `Embedded: ${audit.totals.embedded.assets} (${audit.totals.embedded.logicalBytes} logical bytes)`,
    `Remote: ${audit.totals.remote.assets} (${audit.totals.remote.logicalBytes} logical bytes; ${audit.totals.remote.transportBytes} transport bytes)`,
    `Startup preparation: ${audit.preparation.startup.assets} (${audit.preparation.startup.logicalBytes} logical bytes)`,
    `Duplicate savings: ${audit.duplicates.savingsBytes} logical bytes`,
  ];
  for (const [kind, summary] of Object.entries(audit.byKind)) {
    lines.push(
      `Kind ${kind}: ${summary.assets} (${summary.logicalBytes} logical bytes; embedded ${summary.embedded.assets}; remote ${summary.remote.assets})`,
    );
  }
  for (const [sceneId, scene] of Object.entries(audit.scenes)) {
    lines.push(
      `Scene ${sceneId}: ${scene.all.assets} assets (${scene.all.logicalBytes} logical bytes; lazy ${scene.lazy.logicalBytes})`,
    );
  }
  return `${lines.join('\n')}\n`;
}
