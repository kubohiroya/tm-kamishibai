import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {createDsl4PoseArchiveExtractor} from '../dsl4/platform/pose-archive-extractor.js';
import {deepFreeze} from '../dsl4/story-document.js';
import {
  serializeDsl4AssetDistributionLock,
  validateDsl4AssetDistributionConfig,
  validateDsl4AssetDistributionLock,
} from '../dsl4/asset-distribution-profile.js';
import {loadDsl4ProjectJson} from './dsl4-asset-audit.js';
import {fetchDsl4AssetRemote} from './dsl4-asset-lock.js';
import {installBundleTransactionally} from './atomic-output.js';
import {Sb3BuilderError} from './errors.js';
import {sha256} from './hash.js';

const poseModelContentType = 'application/vnd.tm.pose-model';
const defaultVendorDirectory = '.kamishibai/vendor/dsl4-assets';
const defaultMaxCompressionRatio = 100;

function fail(message: string, code: string, cause?: unknown): never {
  throw new Sb3BuilderError(message, {stage: 'dsl4-asset-vendor', code, cause});
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

function safeRelativePath(value: string, name: string) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ||
    value.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new TypeError(`${name} must be a canonical project-relative POSIX path`);
  }
  return value;
}

function isWithin(ancestor: string, candidate: string) {
  const relative = path.relative(ancestor, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function normalizeAllowedHosts(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('allowedHosts must contain at least one hostname');
  }
  return [
    ...new Set(
      value.map((host) => {
        if (typeof host !== 'string' || host.length === 0 || /[\u0000-\u0020/\\#?@]/u.test(host)) {
          throw new TypeError('allowedHosts entry must be a hostname without path or credentials');
        }
        let parsed;
        try {
          parsed = new URL(`https://${host}`);
        } catch {
          throw new TypeError('allowedHosts entry must be a valid hostname');
        }
        if (
          parsed.hostname !== host.toLowerCase() ||
          parsed.port ||
          parsed.username ||
          parsed.password
        ) {
          throw new TypeError('allowedHosts entry must be a canonical hostname without a port');
        }
        return parsed.hostname;
      }),
    ),
  ].sort();
}

function extensionFor(contentType: string, kind: string) {
  const known = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
  } as Record<string, string>;
  const knownExtension = known[contentType];
  if (knownExtension) return `.${knownExtension}`;
  const subtype = contentType.split('/')[1]?.replace(/[^a-z0-9]+/gu, '-') || kind;
  return `.${subtype}`;
}

function logicalBundle(files: {path: string; size: number; integrity: string}[]) {
  const ordered = [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const canonical = JSON.stringify({formatVersion: 1, files: ordered});
  return {
    contentIntegrity: `sha256-${sha256(canonical)}`,
    contentType: poseModelContentType,
    size: ordered.reduce((total, file) => total + file.size, 0),
  };
}

async function collectMirrorFiles(relativePath: string, root: string, files: Map<string, Buffer>) {
  const directory = path.join(root, ...relativePath.split('/'));
  let entries;
  try {
    entries = await readdir(directory, {withFileTypes: true});
  } catch (error) {
    fail('Vendor mirror directory cannot be read', 'K4-ASSET-VENDOR-OUTPUT-001', error);
  }
  for (const entry of entries) {
    if (
      !entry.name ||
      entry.name === '.' ||
      entry.name === '..' ||
      entry.name.includes('/') ||
      entry.name.includes('\\')
    ) {
      fail('Vendor mirror contains an unsafe path', 'K4-ASSET-VENDOR-OUTPUT-001');
    }
    const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const childPath = path.join(root, ...childRelative.split('/'));
    const state = await lstat(childPath);
    if (state.isSymbolicLink())
      fail('Vendor mirror contains a symbolic link', 'K4-ASSET-VENDOR-OUTPUT-001');
    if (state.isDirectory()) {
      await collectMirrorFiles(childRelative, root, files);
    } else if (state.isFile()) {
      files.set(childRelative, await readFile(childPath));
    } else {
      fail('Vendor mirror contains a special file', 'K4-ASSET-VENDOR-OUTPUT-001');
    }
  }
}

async function verifyMirror(root: string, expected: Map<string, Buffer>) {
  const actual = new Map();
  await collectMirrorFiles('', root, actual);
  if (actual.size !== expected.size)
    fail('Existing vendor mirror has unexpected files', 'K4-ASSET-VENDOR-OUTPUT-001');
  for (const [relativePath, bytes] of expected) {
    const actualBytes = actual.get(relativePath);
    if (!actualBytes || !actualBytes.equals(bytes)) {
      fail(`Existing vendor mirror differs at ${relativePath}`, 'K4-ASSET-VENDOR-OUTPUT-001');
    }
  }
}

async function installMirrorAtomically(targetRoot: string, files: Map<string, Buffer>) {
  const parent = path.dirname(targetRoot);
  await mkdir(parent, {recursive: true});
  const parentState = await lstat(parent);
  if (!parentState.isDirectory() || parentState.isSymbolicLink()) {
    fail('Vendor mirror parent must be a regular directory', 'K4-ASSET-VENDOR-OUTPUT-001');
  }
  try {
    const targetState = await lstat(targetRoot);
    if (targetState.isSymbolicLink() || !targetState.isDirectory()) {
      fail('Vendor mirror target must be a regular directory', 'K4-ASSET-VENDOR-OUTPUT-001');
    }
    await verifyMirror(targetRoot, files);
    return false;
  } catch (error) {
    if (error instanceof Sb3BuilderError) throw error;
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  const candidate = await mkdtemp(path.join(parent, `.${path.basename(targetRoot)}.build-`));
  try {
    for (const [relativePath, bytes] of files) {
      const outputPath = path.join(candidate, ...relativePath.split('/'));
      await mkdir(path.dirname(outputPath), {recursive: true});
      await writeFile(outputPath, bytes, {flag: 'wx'});
    }
    await verifyMirror(candidate, files);
    await rename(candidate, targetRoot);
    return true;
  } catch (error) {
    throw error;
  } finally {
    await rm(candidate, {recursive: true, force: true});
  }
}

async function writeJsonAtomically(
  outputPath: string,
  contents: Buffer,
  validate: (candidate: string) => Promise<void>,
) {
  const resolved = path.resolve(outputPath);
  const outputDirectory = path.dirname(resolved);
  const outputName = path.basename(resolved);
  if (
    !outputName ||
    outputName === '.' ||
    outputName === '..' ||
    path.extname(outputName) !== '.json'
  ) {
    throw new TypeError('JSON output must name a .json file');
  }
  return installBundleTransactionally({
    outputDirectory,
    outputName,
    files: new Map([[outputName, contents]]),
    validateCandidate: async (candidateDirectory) =>
      validate(path.join(candidateDirectory, outputName)),
  });
}

function createVendoredConfig(
  config: Readonly<Record<string, any>>,
  embedded: Readonly<Record<string, string>>,
) {
  const providers = Object.fromEntries(
    Object.entries<Record<string, unknown>>(config.providers).map(([assetId, providerSet]) => [
      assetId,
      {...providerSet},
    ]),
  );
  for (const [assetId, file] of Object.entries(embedded)) {
    const providerSet = providers[assetId] ?? {};
    providers[assetId] = {...providerSet, embedded: {file}};
  }
  return validateDsl4AssetDistributionConfig({
    formatVersion: config.formatVersion,
    profiles: config.profiles,
    providers,
  });
}

function createVendoredLock(
  lock: Readonly<Record<string, any>>,
  embedded: Readonly<Record<string, string>>,
) {
  const assets = Object.fromEntries(
    Object.entries<Record<string, any>>(lock.assets).map(([assetId, asset]) => [
      assetId,
      embedded[assetId]
        ? {...asset, providers: {...asset.providers, embedded: {file: embedded[assetId]}}}
        : asset,
    ]),
  );
  return validateDsl4AssetDistributionLock({formatVersion: lock.formatVersion, assets});
}

export async function vendorDsl4AssetDistribution(options: any) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('vendor options are required');
  }
  if (typeof options.projectRoot !== 'string' || options.projectRoot.length === 0) {
    throw new TypeError('projectRoot must be a non-empty string');
  }
  if (typeof options.assetConfig !== 'string' || typeof options.assetLock !== 'string') {
    throw new TypeError('assetConfig and assetLock are required');
  }
  if (typeof options.outputConfig !== 'string' || typeof options.outputLock !== 'string') {
    throw new TypeError('outputConfig and outputLock are required');
  }
  const maxAssetConfigBytes = positiveLimit(options.maxAssetConfigBytes, 'maxAssetConfigBytes');
  const maxAssetLockBytes = positiveLimit(options.maxAssetLockBytes, 'maxAssetLockBytes');
  const maxFileBytes = positiveLimit(options.maxAssetFileBytes, 'maxAssetFileBytes');
  const maxFiles = positiveLimit(options.maxAssetFiles, 'maxAssetFiles');
  const maxTotalBytes = positiveLimit(options.maxTotalAssetBytes, 'maxTotalAssetBytes');
  const timeoutMs = positiveLimit(options.timeoutMs, 'timeoutMs');
  const maxRedirects = nonNegativeLimit(options.maxRedirects, 'maxRedirects');
  const allowedHosts = normalizeAllowedHosts(options.allowedHosts);
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function')
    throw new TypeError('fetchImplementation must be a function');

  let canonicalRoot;
  const requestedRoot = path.resolve(options.projectRoot);
  try {
    canonicalRoot = await realpath(path.resolve(options.projectRoot));
    const state = await lstat(canonicalRoot);
    if (!state.isDirectory()) fail('Project root is not a directory', 'K4-ASSET-VENDOR-ROOT-001');
  } catch (error) {
    if (error instanceof Sb3BuilderError) throw error;
    fail('Cannot resolve project root', 'K4-ASSET-VENDOR-ROOT-001', error);
  }

  const configInput = await loadDsl4ProjectJson({
    projectRoot: options.projectRoot,
    inputPath: options.assetConfig,
    maxBytes: maxAssetConfigBytes,
    label: 'asset distribution config',
    code: 'K4-ASSET-PROFILE-001',
  });
  const lockInput = await loadDsl4ProjectJson({
    projectRoot: options.projectRoot,
    inputPath: options.assetLock,
    maxBytes: maxAssetLockBytes,
    label: 'asset distribution lock',
    code: 'K4-ASSET-LOCK-001',
  });
  const config = validateDsl4AssetDistributionConfig(configInput);
  const lock = validateDsl4AssetDistributionLock(lockInput);
  const vendorDirectory = safeRelativePath(
    options.vendorDirectory ?? defaultVendorDirectory,
    'vendorDirectory',
  );
  const lockDigest = `sha256-${sha256(serializeDsl4AssetDistributionLock(lock))}`;
  const mirrorRelativeRoot = `${vendorDirectory}/${lockDigest}`;
  const mirrorRoot = path.resolve(canonicalRoot, ...mirrorRelativeRoot.split('/'));
  if (!isWithin(canonicalRoot, mirrorRoot))
    fail('Vendor mirror escapes the project root', 'K4-ASSET-VENDOR-PATH-001');
  const outputConfig = path.resolve(options.outputConfig);
  const outputLock = path.resolve(options.outputLock);
  if (!isWithin(requestedRoot, outputConfig) || !isWithin(requestedRoot, outputLock)) {
    fail('Vendor JSON outputs must remain inside the project root', 'K4-ASSET-VENDOR-PATH-001');
  }
  if (outputConfig === outputLock) throw new TypeError('outputConfig and outputLock must differ');

  const files = new Map();
  const embedded = {} as Record<string, string>;
  let totalBytes = 0;
  let fileCount = 0;
  const poseArchiveExtractor = createDsl4PoseArchiveExtractor({
    limits: {
      maxArchiveBytes: maxFileBytes,
      maxEntries: 16,
      maxCompressedEntryBytes: maxFileBytes,
      maxExpandedEntryBytes: maxFileBytes,
      maxTotalExpandedBytes: maxTotalBytes,
      maxCompressionRatio: defaultMaxCompressionRatio,
    },
    subtleCrypto: options.subtleCrypto,
  });
  const remoteOptions = {
    allowedHosts,
    timeoutMs,
    maxRedirects,
    maxBytes: maxFileBytes,
    fetchImplementation,
  };
  for (const assetId of Object.keys(lock.assets).sort()) {
    const asset = lock.assets[assetId];
    const remote = asset.providers.remote;
    if (!remote) continue;
    const configured = config.providers[assetId];
    if (configured?.remote && configured.remote.url !== remote.url) {
      fail(`Asset ${assetId} config remote URL is stale`, 'K4-ASSET-LOCK-001');
    }
    const response = await fetchDsl4AssetRemote(remote.url, remoteOptions);
    totalBytes += response.bytes.length;
    if (totalBytes > maxTotalBytes)
      fail('Vendor exceeds maxTotalAssetBytes', 'K4-ASSET-VENDOR-SIZE-001');
    const transportIntegrity = `sha256-${sha256(response.bytes)}`;
    if (
      transportIntegrity !== remote.transportIntegrity ||
      response.bytes.length !== remote.size ||
      response.contentType !== remote.contentType
    ) {
      fail(`Remote bytes do not match lock for ${assetId}`, 'K4-ASSET-VENDOR-INTEGRITY-001');
    }
    const assetRootRelative = asset.contentIntegrity;
    const embeddedRoot = `${mirrorRelativeRoot}/${asset.contentIntegrity}`;
    if (asset.kind === 'recognitionModel') {
      let extracted;
      try {
        extracted = await poseArchiveExtractor(
          {assetId, archiveIntegrity: transportIntegrity, bytes: new Uint8Array(response.bytes)},
          {},
        );
      } catch (error) {
        fail(`Remote pose archive failed validation for ${assetId}`, 'K4-ASSET-ARCHIVE-001', error);
      }
      fileCount += extracted.files.length;
      if (fileCount > maxFiles) fail('Vendor exceeds maxAssetFiles', 'K4-ASSET-VENDOR-COUNT-001');
      const logical = logicalBundle(
        extracted.files.map((file) => ({
          path: file.path,
          size: file.size,
          integrity: file.integrity,
        })),
      );
      if (
        logical.contentIntegrity !== asset.contentIntegrity ||
        logical.size !== asset.size ||
        asset.contentType !== poseModelContentType
      ) {
        fail(
          `Remote pose content does not match lock for ${assetId}`,
          'K4-ASSET-VENDOR-INTEGRITY-001',
        );
      }
      for (const file of extracted.files) {
        files.set(`${assetRootRelative}/${file.path}`, Buffer.from(file.bytes));
      }
      embedded[assetId] = embeddedRoot;
    } else {
      fileCount += 1;
      if (fileCount > maxFiles) fail('Vendor exceeds maxAssetFiles', 'K4-ASSET-VENDOR-COUNT-001');
      if (
        transportIntegrity !== asset.contentIntegrity ||
        response.bytes.length !== asset.size ||
        response.contentType !== asset.contentType
      ) {
        fail(`Remote content does not match lock for ${assetId}`, 'K4-ASSET-VENDOR-INTEGRITY-001');
      }
      const relativePath = `${assetRootRelative}${extensionFor(asset.contentType, asset.kind)}`;
      files.set(relativePath, response.bytes);
      embedded[assetId] = `${mirrorRelativeRoot}/${relativePath}`;
    }
  }
  await installMirrorAtomically(mirrorRoot, files);
  const outputLockValue = createVendoredLock(lock, embedded);
  const outputConfigValue = createVendoredConfig(config, embedded);
  const serializedLock = serializeDsl4AssetDistributionLock(outputLockValue);
  const serializedConfig = `${JSON.stringify(outputConfigValue, null, 2)}\n`;
  await writeJsonAtomically(
    outputConfig,
    Buffer.from(serializedConfig, 'utf8'),
    async (candidate) => {
      validateDsl4AssetDistributionConfig(JSON.parse(await readFile(candidate, 'utf8')));
    },
  );
  await writeJsonAtomically(outputLock, Buffer.from(serializedLock, 'utf8'), async (candidate) => {
    validateDsl4AssetDistributionLock(JSON.parse(await readFile(candidate, 'utf8')));
  });
  return deepFreeze({
    config: outputConfigValue,
    lock: outputLockValue,
    serializedConfig,
    serializedLock,
    outputConfig,
    outputLock,
    mirrorRoot,
    mirrorRelativeRoot,
    vendoredAssets: Object.keys(embedded).sort(),
  });
}
