import {lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {zipSync} from 'fflate';
import {parseDocument} from 'yaml';

import {isDsl4RemotePoseArchiveUrl} from '../dsl4/pose-archive-locator.js';
import {
  dsl4RemotePoseFileUrl,
  parseDsl4RemotePoseJson,
  resolveDsl4RemotePoseWeightsPath,
} from '../dsl4/remote-pose-directory.js';
import type {Dsl4SourceFrontend} from '../dsl4/source-frontend.js';
import {deepFreeze} from '../dsl4/story-document.js';
import type {Dsl4SubtleCrypto} from '../dsl4/subtle-crypto.js';
import {loadDsl4ProjectJson, loadDsl4ProjectSourceManifest} from './dsl4-asset-audit.js';
import {fetchDsl4AssetRemote} from './dsl4-asset-lock.js';
import {contentTypeFor, extensionFor} from './dsl4-asset-media.js';
import {
  addProjectAsset,
  projectTarget,
  projectTargetName,
  readProjectMaterial,
  removeProjectAsset,
} from './dsl4-asset-project-material.js';
import {
  defaultRsyncSshPort,
  normalizeRemoteBaseUrl,
  normalizeRsyncDestination,
  runRsyncProcess,
} from './dsl4-asset-rsync.js';
import {
  loadDsl4ExternalSource,
  serializeDsl4ExternalSourceManifest,
  validateDsl4ExternalSourceManifest,
} from './dsl4-external-source.js';
import {resolveDsl4ProjectSource} from './dsl4-project-source.js';
import {loadDsl4LocalAssetSnapshot} from './dsl4-local-assets.js';
import {fixedZipTimestamp} from './constants.js';
import {Sb3BuilderError} from './errors.js';
import {sha256} from './hash.js';
import {readSb3, serializeSb3} from './sb3.js';

const supportedTargets = new Set(['local', 'project', 'remote']);
const sourceSuffixes = ['.kamishibai.yaml', '.kamishibai.yml', '.k4.yaml', '.k4.yml'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string, code: string, cause?: unknown): never {
  throw new Sb3BuilderError(message, {stage: 'dsl4-asset-convert', code, cause});
}

function positiveLimit(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

function nonNegativeLimit(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return Number(value);
}

function isWithin(ancestor: string, candidate: string) {
  const relative = path.relative(ancestor, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function isMissing(error: unknown) {
  return isRecord(error) && error.code === 'ENOENT';
}

function normalizeAllowedHosts(value: unknown) {
  if (!Array.isArray(value)) throw new TypeError('allowedHosts must be an array');
  return Object.freeze(
    [...new Set(value)].map((host) => {
      if (typeof host !== 'string' || host.length === 0 || /[\u0000-\u0020/\\#?@]/u.test(host)) {
        throw new TypeError('allowedHosts entries must be hostnames without paths or credentials');
      }
      let parsed;
      try {
        parsed = new URL(`https://${host}`);
      } catch (error) {
        throw new TypeError('allowedHosts entries must be valid hostnames', {cause: error});
      }
      if (parsed.hostname !== host.toLowerCase() || parsed.port) {
        throw new TypeError('allowedHosts entries must be canonical hostnames without ports');
      }
      return parsed.hostname;
    }),
  );
}

function outputName(value: unknown, fallback: string) {
  const candidate = value ?? fallback;
  if (
    typeof candidate !== 'string' ||
    candidate.length === 0 ||
    candidate === '.' ||
    candidate === '..' ||
    candidate.startsWith('.') ||
    candidate.includes('\0') ||
    candidate.includes('/') ||
    candidate.includes('\\')
  ) {
    throw new TypeError('outputName must be a visible filename stem without path separators');
  }
  return candidate;
}

function sourceStem(filename: string) {
  const suffix = sourceSuffixes.find((candidate) => filename.endsWith(candidate));
  const stem = suffix ? filename.slice(0, -suffix.length) : path.parse(filename).name;
  return stem || 'story';
}

function assetDirectoryName(assetId: string) {
  const readable = assetId
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);
  return `${readable || 'asset'}-${sha256(assetId).slice(0, 8)}`;
}

function validateRemoteSource(
  value: unknown,
  {allowBare = false, label = 'Remote mapping entry'}: {allowBare?: boolean; label?: string} = {},
): Readonly<{url: string; integrity?: string; contentType?: string; size?: number}> {
  if (!isRecord(value)) {
    fail(`${label} must be an object`, 'K4-ASSET-CONVERT-MAP-001');
  }
  const keys = Object.keys(value);
  const metadataKeys = ['contentType', 'integrity', 'size'];
  const presentMetadata = metadataKeys.filter((key) => Object.hasOwn(value, key));
  if (keys.some((key) => ![...metadataKeys, 'url'].includes(key))) {
    fail(`${label} contains an unsupported key`, 'K4-ASSET-CONVERT-MAP-001');
  }
  const verified = presentMetadata.length === metadataKeys.length;
  if (
    !Object.hasOwn(value, 'url') ||
    (presentMetadata.length > 0 && !verified) ||
    (!verified && !allowBare) ||
    keys.length !== (verified ? 4 : 1)
  ) {
    fail(
      `${label} must contain a URL and either all or none of integrity, contentType, and size`,
      'K4-ASSET-CONVERT-MAP-001',
    );
  }
  let url;
  try {
    url = new URL(String(value.url));
  } catch (error) {
    fail('Remote mapping URL is invalid', 'K4-ASSET-CONVERT-MAP-001', error);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.href !== value.url
  ) {
    fail(
      'Remote mapping URL must be canonical HTTPS without credentials or fragment',
      'K4-ASSET-CONVERT-MAP-001',
    );
  }
  if (!verified) return Object.freeze({url: value.url as string});
  if (typeof value.integrity !== 'string' || !/^sha256-[0-9a-f]{64}$/u.test(value.integrity)) {
    fail('Remote mapping integrity must be canonical SHA-256', 'K4-ASSET-CONVERT-MAP-001');
  }
  if (
    typeof value.contentType !== 'string' ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(value.contentType)
  ) {
    fail('Remote mapping Content-Type is invalid', 'K4-ASSET-CONVERT-MAP-001');
  }
  if (!Number.isSafeInteger(value.size) || Number(value.size) < 1) {
    fail('Remote mapping size must be a positive safe integer', 'K4-ASSET-CONVERT-MAP-001');
  }
  return Object.freeze({
    url: value.url as string,
    integrity: value.integrity as string,
    contentType: value.contentType as string,
    size: Number(value.size),
  });
}

function validateRemoteMap(value: unknown, assets: Readonly<Record<string, unknown>>) {
  if (!isRecord(value)) fail('Remote map must contain one object', 'K4-ASSET-CONVERT-MAP-001');
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([assetId, source]) => {
        if (!Object.hasOwn(assets, assetId)) {
          fail(`Remote map names an unknown asset: ${assetId}`, 'K4-ASSET-CONVERT-MAP-001');
        }
        return [assetId, validateRemoteSource(source)];
      }),
    ),
  );
}

function readLocalMaterial(
  snapshot: Readonly<Record<string, any>>,
  assetId: string,
  asset: Readonly<Record<string, any>>,
) {
  const manifestAssets = snapshot.manifest.assets as Readonly<Record<string, any>>[];
  const manifestAsset = manifestAssets.find((candidate) => candidate.id === assetId);
  if (!manifestAsset || manifestAsset.source.type !== 'file') {
    fail(`Local asset snapshot is missing ${assetId}`, 'K4-ASSET-CONVERT-LOCAL-001');
  }
  const sourceFiles = manifestAsset.source.files as Readonly<Record<string, any>>[];
  const recognitionModel = asset.kind === 'recognitionModel';
  const opaquePoseArchive = recognitionModel && manifestAsset.source.mode === 'archive';
  if (opaquePoseArchive) {
    return Object.freeze({
      opaquePoseArchive: true,
      files: Object.freeze([
        Object.freeze({
          path: path.posix.basename(manifestAsset.source.inputPath),
          bytes: snapshot.getPoseArchive(assetId),
          contentType: 'application/zip',
        }),
      ]),
    });
  }
  const files = sourceFiles.map((file) => {
    const bytes = snapshot.getFile(assetId, file.path);
    return Object.freeze({
      path: file.path,
      bytes,
      ...(recognitionModel ? {} : {contentType: contentTypeFor(bytes, file.path, asset.kind)}),
    });
  });
  return Object.freeze({files: Object.freeze(files)});
}

function assertSameMaterial(
  left: Readonly<Record<string, any>>,
  right: Readonly<Record<string, any>>,
  assetId: string,
  kind: string,
) {
  if (kind === 'recognitionModel') {
    const leftBytes = createRemotePayload(assetId, {kind}, left).bytes;
    const rightBytes = createRemotePayload(assetId, {kind}, right).bytes;
    if (!leftBytes.equals(rightBytes)) {
      fail(
        `Remote destination bytes do not match the current logical content for ${assetId}`,
        'K4-ASSET-CONVERT-CONTENT-MISMATCH-001',
      );
    }
    return;
  }
  const byPath = (material: Readonly<Record<string, any>>) =>
    [...material.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const leftFiles = byPath(left);
  const rightFiles = byPath(right);
  if (
    leftFiles.length !== rightFiles.length ||
    leftFiles.some(
      (file, index) => !Buffer.from(file.bytes).equals(Buffer.from(rightFiles[index].bytes)),
    )
  ) {
    fail(
      `Remote destination bytes do not match the current logical content for ${assetId}`,
      'K4-ASSET-CONVERT-CONTENT-MISMATCH-001',
    );
  }
}

function createRemotePayload(
  assetId: string,
  asset: Readonly<Record<string, any>>,
  material: Readonly<Record<string, any>>,
) {
  let bytes;
  let contentType;
  let extension;
  if (asset.kind === 'recognitionModel') {
    if (material.opaquePoseArchive === true) {
      if (material.files.length !== 1) {
        fail(
          `Opaque pose archive ${assetId} must materialize one file`,
          'K4-ASSET-CONVERT-REMOTE-001',
        );
      }
      const file = material.files[0];
      bytes = Buffer.from(file.bytes);
      contentType = file.contentType ?? 'application/zip';
    } else {
      const entries: Record<string, Uint8Array> = {};
      for (const file of [...material.files].sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      )) {
        entries[file.path] = new Uint8Array(file.bytes);
      }
      bytes = Buffer.from(zipSync(entries, {level: 6, mtime: fixedZipTimestamp}));
      contentType = 'application/zip';
    }
    extension = 'zip';
  } else {
    if (material.files.length !== 1) {
      fail(`Remote asset ${assetId} must materialize one file`, 'K4-ASSET-CONVERT-REMOTE-001');
    }
    const file = material.files[0];
    bytes = Buffer.from(file.bytes);
    contentType = file.contentType ?? contentTypeFor(bytes, file.path, asset.kind);
    extension = extensionFor(contentType, asset.kind);
  }
  const digest = sha256(bytes);
  return Object.freeze({
    bytes,
    contentType,
    filename: `${assetDirectoryName(assetId)}-${digest}.${extension}`,
    integrity: `sha256-${digest}`,
    size: bytes.length,
  });
}

function editableAsset(rawAsset: unknown, asset: Readonly<Record<string, any>>) {
  const result = (isRecord(rawAsset) ? structuredClone(rawAsset) : {kind: asset.kind}) as Record<
    string,
    any
  >;
  result.kind = asset.kind;
  if (asset.kind === 'costume') result.target = asset.target;
  for (const key of ['delivery', 'file', 'name', 'source']) delete result[key];
  return result;
}

function addOutputFile(files: Map<string, Buffer>, relativePath: string, bytes: Buffer) {
  if (
    relativePath.length === 0 ||
    relativePath.includes('\\') ||
    relativePath.startsWith('/') ||
    relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    fail('Generated output path is unsafe', 'K4-ASSET-CONVERT-OUTPUT-001');
  }
  if (files.has(relativePath)) {
    fail(`Generated output path collides: ${relativePath}`, 'K4-ASSET-CONVERT-OUTPUT-001');
  }
  files.set(relativePath, Buffer.from(bytes));
}

function addSharedOutputFile(files: Map<string, Buffer>, relativePath: string, bytes: Buffer) {
  const existing = files.get(relativePath);
  if (!existing) {
    addOutputFile(files, relativePath, bytes);
    return;
  }
  if (!existing.equals(bytes)) {
    fail(`Generated output path collides: ${relativePath}`, 'K4-ASSET-CONVERT-OUTPUT-001');
  }
}

async function installOutputDirectory(
  projectRoot: string,
  outputDirectory: string,
  files: Map<string, Buffer>,
  validate: (candidateDirectory: string) => Promise<void>,
  beforeCommit?: ((candidateDirectory: string) => Promise<void>) | undefined,
) {
  const parent = path.dirname(outputDirectory);
  let canonicalParent;
  try {
    const requestedParentState = await lstat(parent);
    if (!requestedParentState.isDirectory() || requestedParentState.isSymbolicLink()) {
      fail('Output parent must be a regular directory', 'K4-ASSET-CONVERT-OUTPUT-001');
    }
    canonicalParent = await realpath(parent);
  } catch (error) {
    if (error instanceof Sb3BuilderError) throw error;
    fail('Output parent must already exist', 'K4-ASSET-CONVERT-OUTPUT-001', error);
  }
  if (!isWithin(projectRoot, canonicalParent)) {
    fail('Output parent escapes the project root', 'K4-ASSET-CONVERT-OUTPUT-001');
  }
  try {
    await lstat(outputDirectory);
    fail('Output directory already exists', 'K4-ASSET-CONVERT-OUTPUT-EXISTS-001');
  } catch (error) {
    if (error instanceof Sb3BuilderError) throw error;
    if (!isMissing(error)) throw error;
  }
  const candidate = await mkdtemp(
    path.join(canonicalParent, `.${path.basename(outputDirectory)}.build-`),
  );
  try {
    for (const [relativePath, bytes] of files) {
      const target = path.join(candidate, ...relativePath.split('/'));
      await mkdir(path.dirname(target), {recursive: true});
      await writeFile(target, bytes, {flag: 'wx'});
    }
    await validate(candidate);
    if (beforeCommit) await beforeCommit(candidate);
    try {
      await lstat(outputDirectory);
      fail('Output directory appeared during conversion', 'K4-ASSET-CONVERT-OUTPUT-EXISTS-001');
    } catch (error) {
      if (error instanceof Sb3BuilderError) throw error;
      if (!isMissing(error)) throw error;
    }
    await rename(candidate, outputDirectory);
  } finally {
    await rm(candidate, {recursive: true, force: true});
  }
}

/** Convert selected authoring assets and save a new YAML/SB3 working pair. */
export async function convertDsl4ProjectAssets(options: {
  projectRoot: string;
  sourceManifest?: string;
  source?: string;
  sourceId?: string;
  baseSb3: string;
  outputDirectory: string;
  to: 'local' | 'project' | 'remote';
  assets?: string[];
  remoteMap?: string;
  rsyncDestination?: string;
  remoteBaseUrl?: string;
  rsyncSshPort?: number;
  rsyncTimeoutMs?: number;
  outputName?: string;
  sourceFrontend: Dsl4SourceFrontend;
  maxSourceBytes: number;
  maxSourceManifestBytes: number;
  maxRemoteMapBytes: number;
  maxBaseSb3Bytes: number;
  maxAssetFileBytes: number;
  maxAssetFiles: number;
  maxTotalAssetBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  allowedHosts: string[];
  fetchImplementation?: typeof fetch;
  subtleCrypto?: Dsl4SubtleCrypto | undefined;
  runRsync?: (command: {
    executable: string;
    arguments: string[];
    timeoutMs: number;
  }) => Promise<void>;
}) {
  if (!isRecord(options)) throw new TypeError('asset conversion options are required');
  if (!supportedTargets.has(options.to as string)) {
    throw new TypeError('to must be local, project, or remote');
  }
  if (!options.sourceFrontend || typeof options.sourceFrontend.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse');
  }
  const maxSourceBytes = positiveLimit(options.maxSourceBytes, 'maxSourceBytes');
  const maxSourceManifestBytes = positiveLimit(
    options.maxSourceManifestBytes,
    'maxSourceManifestBytes',
  );
  const maxRemoteMapBytes = positiveLimit(options.maxRemoteMapBytes, 'maxRemoteMapBytes');
  const maxBaseSb3Bytes = positiveLimit(options.maxBaseSb3Bytes, 'maxBaseSb3Bytes');
  const maxAssetFileBytes = positiveLimit(options.maxAssetFileBytes, 'maxAssetFileBytes');
  const maxAssetFiles = positiveLimit(options.maxAssetFiles, 'maxAssetFiles');
  const maxTotalAssetBytes = positiveLimit(options.maxTotalAssetBytes, 'maxTotalAssetBytes');
  const timeoutMs = positiveLimit(options.timeoutMs, 'timeoutMs');
  const maxRedirects = nonNegativeLimit(options.maxRedirects, 'maxRedirects');
  if (maxAssetFileBytes > maxTotalAssetBytes) {
    throw new TypeError('maxAssetFileBytes must be <= maxTotalAssetBytes');
  }
  const allowedHosts = normalizeAllowedHosts(options.allowedHosts);
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('fetchImplementation must be a function');
  }
  const hasRsyncDestination = options.rsyncDestination !== undefined;
  const hasRemoteBaseUrl = options.remoteBaseUrl !== undefined;
  const hasRsyncConfiguration = hasRsyncDestination && hasRemoteBaseUrl;
  if (hasRsyncDestination !== hasRemoteBaseUrl) {
    fail(
      'rsyncDestination and remoteBaseUrl must be specified together',
      'K4-ASSET-CONVERT-RSYNC-CONFIG-001',
    );
  }
  if (
    !hasRsyncConfiguration &&
    (options.rsyncSshPort !== undefined || options.rsyncTimeoutMs !== undefined)
  ) {
    fail(
      'rsync SSH options require rsyncDestination and remoteBaseUrl',
      'K4-ASSET-CONVERT-RSYNC-CONFIG-001',
    );
  }
  if (hasRsyncConfiguration && options.to !== 'remote') {
    fail(
      'rsync synchronization is available only for remote conversion',
      'K4-ASSET-CONVERT-RSYNC-CONFIG-001',
    );
  }
  if (hasRsyncConfiguration && options.remoteMap !== undefined) {
    fail(
      'remoteMap and rsync synchronization are mutually exclusive',
      'K4-ASSET-CONVERT-RSYNC-CONFIG-001',
    );
  }
  const rsyncDestination = hasRsyncConfiguration
    ? normalizeRsyncDestination(options.rsyncDestination)
    : null;
  const remoteBaseUrl = hasRsyncConfiguration
    ? normalizeRemoteBaseUrl(options.remoteBaseUrl)
    : null;
  const rsyncSshPort = positiveLimit(options.rsyncSshPort ?? defaultRsyncSshPort, 'rsyncSshPort');
  if (rsyncSshPort > 65_535) throw new TypeError('rsyncSshPort must be <= 65535');
  const rsyncTimeoutMs = positiveLimit(options.rsyncTimeoutMs ?? timeoutMs, 'rsyncTimeoutMs');
  const runRsync = options.runRsync ?? runRsyncProcess;
  if (typeof runRsync !== 'function') throw new TypeError('runRsync must be a function');
  if (remoteBaseUrl && !allowedHosts.includes(remoteBaseUrl.hostname)) {
    fail('remoteBaseUrl hostname must be included in allowedHosts', 'K4-ASSET-REMOTE-HOST-001');
  }

  const requestedRoot = path.resolve(String(options.projectRoot));
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(requestedRoot);
    const rootState = await lstat(canonicalRoot);
    if (!rootState.isDirectory())
      fail('Project root is not a directory', 'K4-ASSET-CONVERT-ROOT-001');
  } catch (error) {
    if (error instanceof Sb3BuilderError) throw error;
    fail('Cannot resolve project root', 'K4-ASSET-CONVERT-ROOT-001', error);
  }
  const canonicalProjectPath = (inputPath: string, label: string) => {
    const requestedPath = path.resolve(inputPath);
    if (!isWithin(requestedRoot, requestedPath)) {
      fail(`${label} must remain inside the project root`, 'K4-ASSET-CONVERT-PATH-001');
    }
    return path.resolve(canonicalRoot, path.relative(requestedRoot, requestedPath));
  };
  const baseSb3Path = path.resolve(String(options.baseSb3));
  const requestedOutputPath = path.resolve(String(options.outputDirectory));
  if (!isWithin(requestedRoot, requestedOutputPath) || requestedOutputPath === requestedRoot) {
    fail('Output directory must be a new child of the project root', 'K4-ASSET-CONVERT-OUTPUT-001');
  }
  const requestedOutput = path.resolve(
    canonicalRoot,
    path.relative(requestedRoot, requestedOutputPath),
  );
  if (requestedOutput.split(path.sep).includes('.git')) {
    fail('Output directory cannot be inside .git', 'K4-ASSET-CONVERT-OUTPUT-001');
  }

  const resolvedSource = await resolveDsl4ProjectSource({
    projectRoot: canonicalRoot,
    ...(options.sourceManifest === undefined
      ? {}
      : {sourceManifest: canonicalProjectPath(options.sourceManifest, 'sourceManifest')}),
    ...(options.source === undefined ? {} : {source: options.source}),
    ...(options.sourceId === undefined ? {} : {sourceId: options.sourceId}),
    maxSourceManifestBytes,
  });
  const inputSourceManifest = validateDsl4ExternalSourceManifest(resolvedSource.manifest);
  const source = await loadDsl4ExternalSource(canonicalRoot, inputSourceManifest, {
    maxSourceBytes,
    subtleCrypto: options.subtleCrypto,
  });
  const parsed = options.sourceFrontend.parse(source.descriptor.text, {
    sourceId: source.descriptor.sourceId,
  });
  if (!parsed.ok) {
    const first = parsed.diagnostics[0];
    fail(first?.message ?? 'DSL 4 source is invalid', first?.code ?? 'K4-ASSET-CONVERT-SOURCE-001');
  }
  const storyDocument = parsed.storyDocument as Readonly<Record<string, any>>;
  const storyAssets = (storyDocument.assets ?? {}) as Readonly<
    Record<string, Readonly<Record<string, any>>>
  >;
  const assetIds = Object.keys(storyAssets).sort();
  if (assetIds.length === 0)
    fail('Story has no assets to convert', 'K4-ASSET-CONVERT-SELECTION-001');
  const requestedAssets = options.assets ?? [];
  if (
    !Array.isArray(requestedAssets) ||
    requestedAssets.some((value) => typeof value !== 'string')
  ) {
    throw new TypeError('assets must be an array of asset IDs');
  }
  if (new Set(requestedAssets).size !== requestedAssets.length) {
    fail('Asset selection contains a duplicate ID', 'K4-ASSET-CONVERT-SELECTION-001');
  }
  const selectedIds = requestedAssets.length > 0 ? [...requestedAssets] : assetIds;
  for (const assetId of selectedIds) {
    if (!Object.hasOwn(storyAssets, assetId)) {
      fail(`Unknown selected asset: ${assetId}`, 'K4-ASSET-CONVERT-SELECTION-001');
    }
  }
  selectedIds.sort();

  let remoteMap: Readonly<Record<string, Readonly<Record<string, any>>>> = Object.freeze({});
  if (options.remoteMap !== undefined) {
    const value = await loadDsl4ProjectJson({
      projectRoot: canonicalRoot,
      inputPath: canonicalProjectPath(options.remoteMap, 'remoteMap'),
      maxBytes: maxRemoteMapBytes,
      label: 'remote map',
      code: 'K4-ASSET-CONVERT-MAP-001',
    });
    remoteMap = validateRemoteMap(value, storyAssets);
  }
  if (options.to === 'remote') {
    for (const assetId of selectedIds) {
      const asset = storyAssets[assetId];
      if (
        !hasRsyncConfiguration &&
        asset.delivery !== 'remote' &&
        !Object.hasOwn(remoteMap, assetId)
      ) {
        fail(
          `Remote mapping is required for non-remote asset ${assetId}`,
          'K4-ASSET-CONVERT-MAP-001',
        );
      }
    }
  }

  let baseState;
  try {
    baseState = await lstat(baseSb3Path);
    if (!baseState.isFile() || baseState.isSymbolicLink()) {
      fail('Base SB3 must be a regular non-symbolic file', 'K4-ASSET-CONVERT-SB3-001');
    }
    if (baseState.size > maxBaseSb3Bytes) {
      fail('Base SB3 exceeds maxBaseSb3Bytes', 'K4-ASSET-CONVERT-SB3-001');
    }
  } catch (error) {
    if (error instanceof Sb3BuilderError) throw error;
    fail('Cannot inspect base SB3', 'K4-ASSET-CONVERT-SB3-001', error);
  }
  const baseBytes = await readFile(baseSb3Path);
  if (baseBytes.length > maxBaseSb3Bytes) {
    fail('Base SB3 exceeds maxBaseSb3Bytes', 'K4-ASSET-CONVERT-SB3-001');
  }
  const {archive, project} = readSb3(baseBytes);

  const localSnapshot = await loadDsl4LocalAssetSnapshot(canonicalRoot, storyDocument, {
    maxFileBytes: maxAssetFileBytes,
    maxFiles: maxAssetFiles,
    maxTotalBytes: maxTotalAssetBytes,
    subtleCrypto: options.subtleCrypto,
    retainPoseArchives: true,
  });
  let downloadedBytes = 0;
  let inspectedFiles = 0;
  let inspectedBytes = 0;
  let materializedFiles = 0;
  let materializedBytes = 0;
  const accountedMaterials = new WeakSet();
  function accountMaterial(material: Readonly<Record<string, any>>) {
    if (accountedMaterials.has(material)) return material;
    accountedMaterials.add(material);
    for (const file of material.files) {
      const size = Buffer.from(file.bytes).length;
      if (size > maxAssetFileBytes) {
        fail('Converted asset file exceeds maxAssetFileBytes', 'K4-ASSET-CONVERT-SIZE-001');
      }
      inspectedFiles += 1;
      inspectedBytes += size;
    }
    if (inspectedFiles > maxAssetFiles) {
      fail('Conversion exceeds maxAssetFiles', 'K4-ASSET-CONVERT-COUNT-001');
    }
    if (inspectedBytes > maxTotalAssetBytes) {
      fail('Conversion exceeds maxTotalAssetBytes', 'K4-ASSET-CONVERT-SIZE-001');
    }
    return material;
  }
  const remoteMaterials: Map<string, Promise<Readonly<Record<string, any>>>> = new Map();
  async function readRemoteMaterial(
    assetId: string,
    asset: Readonly<Record<string, any>>,
    remote: Readonly<Record<string, any>>,
  ) {
    const sourceValue = validateRemoteSource(remote, {
      allowBare: true,
      label: `Remote asset ${assetId} source`,
    });
    const cacheKey = `${asset.kind}\0${JSON.stringify(sourceValue)}`;
    let promise = remoteMaterials.get(cacheKey);
    if (!promise) {
      promise = (async () => {
        if (allowedHosts.length === 0) {
          fail(
            'At least one allowed host is required for network conversion',
            'K4-ASSET-REMOTE-HOST-001',
          );
        }
        const fetchFile = async (url: string) => {
          const response = await fetchDsl4AssetRemote(url, {
            allowedHosts,
            timeoutMs,
            maxRedirects,
            maxBytes: maxAssetFileBytes,
            fetchImplementation,
          });
          downloadedBytes += response.bytes.length;
          if (downloadedBytes > maxTotalAssetBytes) {
            fail('Remote conversion exceeds maxTotalAssetBytes', 'K4-ASSET-CONVERT-SIZE-001');
          }
          return response;
        };
        const verified = sourceValue.integrity !== undefined;
        const poseArchive =
          asset.kind === 'recognitionModel' &&
          (verified || isDsl4RemotePoseArchiveUrl(sourceValue.url));
        if (asset.kind === 'recognitionModel' && !poseArchive) {
          try {
            const [modelResponse, metadataResponse] = await Promise.all([
              fetchFile(dsl4RemotePoseFileUrl(sourceValue.url, 'model.json')),
              fetchFile(dsl4RemotePoseFileUrl(sourceValue.url, 'metadata.json')),
            ]);
            const model = parseDsl4RemotePoseJson(modelResponse.bytes, 'model.json');
            const weightsPath = resolveDsl4RemotePoseWeightsPath(model);
            parseDsl4RemotePoseJson(metadataResponse.bytes, 'metadata.json');
            const weightsResponse = await fetchFile(
              dsl4RemotePoseFileUrl(sourceValue.url, weightsPath),
            );
            return Object.freeze({
              files: Object.freeze([
                Object.freeze({path: 'model.json', bytes: modelResponse.bytes}),
                Object.freeze({path: 'metadata.json', bytes: metadataResponse.bytes}),
                Object.freeze({path: weightsPath, bytes: weightsResponse.bytes}),
              ]),
            });
          } catch (error) {
            if (error instanceof Sb3BuilderError) throw error;
            fail(
              `Remote pose directory is invalid for ${assetId}`,
              'K4-ASSET-CONVERT-REMOTE-POSE-001',
              error,
            );
          }
        }
        const response = await fetchFile(sourceValue.url);
        if (
          verified &&
          (`sha256-${sha256(response.bytes)}` !== sourceValue.integrity ||
            response.bytes.length !== sourceValue.size ||
            response.contentType !== sourceValue.contentType)
        ) {
          fail(
            `Remote bytes do not match declared metadata for ${assetId}`,
            'K4-ASSET-CONVERT-REMOTE-INTEGRITY-001',
          );
        }
        if (poseArchive) {
          return Object.freeze({
            opaquePoseArchive: true,
            files: Object.freeze([
              Object.freeze({
                path: path.posix.basename(new URL(response.finalUrl).pathname) || `${assetId}.zip`,
                bytes: response.bytes,
                contentType: response.contentType,
              }),
            ]),
          });
        }
        const detectedContentType = contentTypeFor(response.bytes, '', asset.kind);
        if (detectedContentType !== response.contentType) {
          fail(
            `Remote Content-Type does not match the media bytes for ${assetId}`,
            'K4-ASSET-CONVERT-REMOTE-TYPE-001',
          );
        }
        const filePath = path.posix.basename(new URL(response.finalUrl).pathname) || assetId;
        return Object.freeze({
          files: Object.freeze([
            Object.freeze({
              path: filePath,
              bytes: response.bytes,
              contentType: response.contentType,
            }),
          ]),
        });
      })();
      remoteMaterials.set(cacheKey, promise);
    }
    return promise;
  }

  const origins: Map<string, Readonly<Record<string, any>>> = new Map();
  async function originMaterial(assetId: string) {
    const cached = origins.get(assetId);
    if (cached) return cached;
    const asset = storyAssets[assetId];
    let material;
    if (asset.delivery === 'remote') {
      if (!isRecord(asset.source)) {
        fail(`Remote asset source is invalid: ${assetId}`, 'K4-ASSET-CONVERT-REMOTE-001');
      }
      material = await readRemoteMaterial(assetId, asset, asset.source);
    } else if (typeof asset.file === 'string') {
      material = readLocalMaterial(localSnapshot, assetId, asset);
    } else {
      material = readProjectMaterial(archive, project, assetId, asset);
    }
    const accounted = accountMaterial(material);
    origins.set(assetId, accounted);
    return accounted;
  }

  const document = parseDocument(source.descriptor.text, {prettyErrors: false, strict: true});
  if (document.errors.length > 0 || !isRecord(document.toJS())) {
    fail('DSL 4 source cannot be edited as one YAML document', 'K4-ASSET-CONVERT-SOURCE-001');
  }
  const raw = document.toJS() as Record<string, any>;
  const rawAssets = isRecord(raw.assets) ? raw.assets : {};
  const outputFiles = new Map();
  const remoteUploads: Map<string, Buffer> = new Map();
  const rsyncVerifications: {
    assetId: string;
    asset: Readonly<Record<string, any>>;
    origin: Readonly<Record<string, any>>;
    source: Readonly<Record<string, any>>;
  }[] = [];
  let remoteUploadBytes = 0;
  const selectedAssetIds = new Set(selectedIds);
  const converted: Record<string, string> = {};
  const preservedOriginals: Record<string, string> = {};
  const projectRemovals: Map<string, {assetId: string; asset: Readonly<Record<string, any>>}> =
    new Map();

  function scheduleProjectRemoval(assetId: string, asset: Readonly<Record<string, any>>) {
    const target = projectTarget(project, asset);
    const collection = asset.kind === 'sound' ? 'sounds' : 'costumes';
    const key = `${projectTargetName(target)}\0${collection}\0${String(asset.name ?? assetId)}`;
    projectRemovals.set(key, {assetId, asset});
  }

  function preserveProjectImageOrigin(
    assetId: string,
    asset: Readonly<Record<string, any>>,
    current: 'local' | 'remote',
    material: Readonly<Record<string, any>>,
  ) {
    if (asset.kind === 'sound') return;
    if (material.files.length !== 1) {
      fail(
        `Project image origin ${assetId} must contain exactly one file`,
        'K4-ASSET-CONVERT-PROJECT-001',
      );
    }
    const file = material.files[0];
    const bytes = Buffer.from(file.bytes);
    const contentType = file.contentType ?? contentTypeFor(bytes, file.path, asset.kind);
    const relativePath =
      current === 'local'
        ? asset.file
        : `assets/originals/${assetDirectoryName(assetId)}/${assetDirectoryName(assetId)}.${extensionFor(contentType, asset.kind)}`;
    if (typeof relativePath !== 'string') {
      fail(`Project image origin ${assetId} has no file path`, 'K4-ASSET-CONVERT-PROJECT-001');
    }
    addSharedOutputFile(outputFiles, relativePath, bytes);
    preservedOriginals[assetId] = relativePath;
  }

  for (const assetId of selectedIds) {
    const asset = storyAssets[assetId];
    const current =
      asset.delivery === 'remote' ? 'remote' : typeof asset.file === 'string' ? 'local' : 'project';
    const editable = editableAsset(rawAssets[assetId], asset);
    if (options.to === 'local') {
      const material = await originMaterial(assetId);
      const assetRoot = `assets/${assetDirectoryName(assetId)}`;
      if (asset.kind === 'recognitionModel') {
        if (material.opaquePoseArchive === true) {
          if (material.files.length !== 1) {
            fail(
              `Opaque pose archive ${assetId} must materialize one file`,
              'K4-ASSET-CONVERT-LOCAL-001',
            );
          }
          const relativePath = `${assetRoot}/${assetDirectoryName(assetId)}.zip`;
          addOutputFile(outputFiles, relativePath, Buffer.from(material.files[0].bytes));
          editable.file = relativePath;
        } else {
          for (const file of material.files) {
            addOutputFile(outputFiles, `${assetRoot}/${file.path}`, Buffer.from(file.bytes));
          }
          editable.file = assetRoot;
        }
      } else {
        if (material.files.length !== 1) {
          fail(`Asset ${assetId} must materialize one file`, 'K4-ASSET-CONVERT-LOCAL-001');
        }
        const file = material.files[0];
        const contentType = file.contentType ?? contentTypeFor(file.bytes, file.path, asset.kind);
        const relativePath = `${assetRoot}/${assetDirectoryName(assetId)}.${extensionFor(contentType, asset.kind)}`;
        addOutputFile(outputFiles, relativePath, Buffer.from(file.bytes));
        editable.file = relativePath;
      }
      editable.delivery = 'embedded';
      document.setIn(['assets', assetId], editable);
      if (current === 'project') scheduleProjectRemoval(assetId, asset);
      converted[assetId] = 'local';
    } else if (options.to === 'project') {
      if (current === 'project') {
        converted[assetId] = 'project';
        continue;
      }
      const material = await originMaterial(assetId);
      editable.name = addProjectAsset(archive, project, assetId, asset, material);
      preserveProjectImageOrigin(assetId, asset, current, material);
      editable.delivery = 'embedded';
      document.setIn(['assets', assetId], editable);
      converted[assetId] = 'project';
    } else {
      if (hasRsyncConfiguration) {
        const currentMaterial = await originMaterial(assetId);
        const payload = createRemotePayload(assetId, asset, currentMaterial);
        if (payload.bytes.length > maxAssetFileBytes) {
          fail('Generated remote file exceeds maxAssetFileBytes', 'K4-ASSET-CONVERT-SIZE-001');
        }
        remoteUploadBytes += payload.bytes.length;
        if (remoteUploadBytes > maxTotalAssetBytes) {
          fail('Generated remote files exceed maxTotalAssetBytes', 'K4-ASSET-CONVERT-SIZE-001');
        }
        const collision = remoteUploads.get(payload.filename);
        if (collision && !collision.equals(payload.bytes)) {
          fail(
            `Generated remote filename collides: ${payload.filename}`,
            'K4-ASSET-CONVERT-RSYNC-001',
          );
        }
        remoteUploads.set(payload.filename, payload.bytes);
        const remoteSource = validateRemoteSource({
          url: new URL(encodeURIComponent(payload.filename), remoteBaseUrl as URL).href,
          integrity: payload.integrity,
          contentType: payload.contentType,
          size: payload.size,
        });
        editable.delivery = 'remote';
        editable.source = remoteSource;
        document.setIn(['assets', assetId], editable);
        if (current === 'project') scheduleProjectRemoval(assetId, asset);
        rsyncVerifications.push({
          assetId,
          asset,
          origin: currentMaterial,
          source: remoteSource,
        });
        converted[assetId] = 'remote';
        continue;
      }
      const mapped = remoteMap[assetId];
      if (current === 'remote' && mapped === undefined) {
        converted[assetId] = 'remote';
        continue;
      }
      const currentMaterial = await originMaterial(assetId);
      const remoteSource = mapped as Readonly<Record<string, any>>;
      const destinationMaterial = await readRemoteMaterial(assetId, asset, remoteSource);
      assertSameMaterial(currentMaterial, destinationMaterial, assetId, asset.kind);
      editable.delivery = 'remote';
      editable.source = remoteSource;
      document.setIn(['assets', assetId], editable);
      if (current === 'project') scheduleProjectRemoval(assetId, asset);
      converted[assetId] = 'remote';
    }
  }

  for (const assetId of assetIds) {
    if (selectedAssetIds.has(assetId)) continue;
    const asset = storyAssets[assetId];
    if (typeof asset.file !== 'string') continue;
    const snapshotAsset = localSnapshot.manifest.assets.find(
      (candidate) => candidate.id === assetId,
    );
    const snapshotSource = snapshotAsset?.source;
    if (
      !isRecord(snapshotSource) ||
      snapshotSource.type !== 'file' ||
      !Array.isArray(snapshotSource.files)
    ) {
      fail(`Local asset snapshot is missing ${assetId}`, 'K4-ASSET-CONVERT-LOCAL-001');
    }
    const directoryMode = snapshotSource.mode === 'directory';
    if (snapshotSource.mode === 'archive') {
      addSharedOutputFile(outputFiles, asset.file, localSnapshot.getPoseArchive(assetId));
      continue;
    }
    for (const file of snapshotSource.files as Readonly<Record<string, any>>[]) {
      const relativePath = directoryMode ? `${asset.file}/${file.path}` : asset.file;
      addSharedOutputFile(outputFiles, relativePath, localSnapshot.getFile(assetId, file.path));
    }
  }

  for (const file of outputFiles.values()) {
    materializedFiles += 1;
    materializedBytes += file.length;
  }
  if (materializedFiles > maxAssetFiles) {
    fail('Converted output exceeds maxAssetFiles', 'K4-ASSET-CONVERT-COUNT-001');
  }
  if (materializedBytes > maxTotalAssetBytes) {
    fail('Converted output exceeds maxTotalAssetBytes', 'K4-ASSET-CONVERT-SIZE-001');
  }

  const serializedSource = `${document.toString({lineWidth: 0}).trimEnd()}\n`;
  if (Buffer.byteLength(serializedSource) > maxSourceBytes) {
    fail('Converted source exceeds maxSourceBytes', 'K4-ASSET-CONVERT-SOURCE-SIZE-001');
  }
  const verified = options.sourceFrontend.parse(serializedSource, {
    sourceId: source.descriptor.sourceId,
  });
  if (!verified.ok) {
    const first = verified.diagnostics[0];
    fail(
      first?.message ?? 'Converted DSL 4 source is invalid',
      first?.code ?? 'K4-ASSET-CONVERT-SOURCE-001',
    );
  }
  const verifiedAssets = (verified.storyDocument.assets ?? {}) as Readonly<
    Record<string, Readonly<Record<string, any>>>
  >;
  for (const {assetId, asset} of projectRemovals.values()) {
    const name = asset.name ?? assetId;
    const retained = Object.entries(verifiedAssets).some(([candidateId, candidate]) => {
      if (candidate.delivery === 'remote' || typeof candidate.file === 'string') return false;
      if (candidate.kind !== asset.kind || (candidate.name ?? candidateId) !== name) return false;
      return candidate.kind !== 'costume' || candidate.target === asset.target;
    });
    if (!retained) removeProjectAsset(archive, project, assetId, asset);
  }
  for (const [assetId, asset] of Object.entries(verifiedAssets)) {
    if (asset.delivery !== 'remote' && typeof asset.file !== 'string') {
      readProjectMaterial(archive, project, assetId, asset);
    }
  }
  const name = outputName(options.outputName, sourceStem(source.descriptor.displayName));
  const sourceFilename = `${name}.k4.yml`;
  const sb3Filename = `${name}.sb3`;
  const sourceManifestFilename = 'project.source.yml';
  const outputSourceManifest = validateDsl4ExternalSourceManifest({
    ...inputSourceManifest,
    path: sourceFilename,
  });
  const serializedSourceManifest = serializeDsl4ExternalSourceManifest(outputSourceManifest, {
    filename: sourceManifestFilename,
  });
  if (Buffer.byteLength(serializedSourceManifest) > maxSourceManifestBytes) {
    fail(
      'Converted source manifest exceeds maxSourceManifestBytes',
      'K4-ASSET-CONVERT-SOURCE-SIZE-001',
    );
  }
  addOutputFile(outputFiles, sourceFilename, Buffer.from(serializedSource, 'utf8'));
  addOutputFile(outputFiles, sb3Filename, serializeSb3(archive, project));
  addOutputFile(outputFiles, sourceManifestFilename, Buffer.from(serializedSourceManifest, 'utf8'));

  await installOutputDirectory(
    canonicalRoot,
    requestedOutput,
    outputFiles,
    async (candidateDirectory) => {
      const candidateManifest = await loadDsl4ProjectSourceManifest({
        projectRoot: candidateDirectory,
        inputPath: path.join(candidateDirectory, sourceManifestFilename),
        maxBytes: maxSourceManifestBytes,
        label: 'source manifest',
        code: 'K4-SOURCE-MANIFEST-001',
      });
      const candidateSource = await loadDsl4ExternalSource(candidateDirectory, candidateManifest, {
        maxSourceBytes,
        subtleCrypto: options.subtleCrypto,
      });
      const candidateResult = options.sourceFrontend.parse(candidateSource.descriptor.text, {
        sourceId: candidateSource.descriptor.sourceId,
      });
      if (!candidateResult.ok) {
        fail('Candidate converted source failed validation', 'K4-ASSET-CONVERT-OUTPUT-001');
      }
      await loadDsl4LocalAssetSnapshot(candidateDirectory, candidateResult.storyDocument, {
        maxFileBytes: maxAssetFileBytes,
        maxFiles: maxAssetFiles,
        maxTotalBytes: maxTotalAssetBytes,
        subtleCrypto: options.subtleCrypto,
      });
      readSb3(await readFile(path.join(candidateDirectory, sb3Filename)));
      for (const [relativePath, bytes] of outputFiles) {
        const installed = await readFile(path.join(candidateDirectory, ...relativePath.split('/')));
        if (!installed.equals(bytes)) {
          fail(`Candidate output changed: ${relativePath}`, 'K4-ASSET-CONVERT-OUTPUT-001');
        }
      }
    },
    hasRsyncConfiguration
      ? async (candidateDirectory) => {
          const stagingDirectory = path.join(candidateDirectory, '.rsync-assets');
          await mkdir(stagingDirectory);
          try {
            for (const [filename, bytes] of remoteUploads) {
              await writeFile(path.join(stagingDirectory, filename), bytes, {flag: 'wx'});
            }
            try {
              await runRsync({
                executable: 'rsync',
                arguments: [
                  '--archive',
                  '--checksum',
                  '--protect-args',
                  `--rsh=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -p ${rsyncSshPort}`,
                  '--',
                  `${stagingDirectory}${path.sep}`,
                  rsyncDestination as string,
                ],
                timeoutMs: rsyncTimeoutMs,
              });
            } catch (error) {
              if (error instanceof Sb3BuilderError) throw error;
              fail('rsync synchronization failed', 'K4-ASSET-CONVERT-RSYNC-001', error);
            }
          } finally {
            await rm(stagingDirectory, {recursive: true, force: true});
          }
          for (const verification of rsyncVerifications) {
            const destination = await readRemoteMaterial(
              verification.assetId,
              verification.asset,
              verification.source,
            );
            assertSameMaterial(
              verification.origin,
              destination,
              verification.assetId,
              verification.asset.kind,
            );
          }
        }
      : undefined,
  );

  return deepFreeze({
    outputDirectory: requestedOutput,
    sourceManifestPath: path.join(requestedOutput, sourceManifestFilename),
    sourcePath: path.join(requestedOutput, sourceFilename),
    sb3Path: path.join(requestedOutput, sb3Filename),
    assetsDirectory: [...outputFiles.keys()].some((relativePath) =>
      relativePath.startsWith('assets/'),
    )
      ? path.join(requestedOutput, 'assets')
      : null,
    converted,
    preservedOriginals,
  });
}
