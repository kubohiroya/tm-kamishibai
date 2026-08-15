import {lstat, open, readFile, readdir, realpath} from 'node:fs/promises';
import path from 'node:path';

import {
  createDsl4PoseArchiveExtractor,
  isDsl4PoseArchivePath,
} from '../dsl4/platform/pose-archive-extractor.js';
import {deepFreeze} from '../dsl4/story-document.js';
import {
  serializeDsl4AssetDistributionLock,
  validateDsl4AssetDistributionConfig,
  validateDsl4AssetDistributionLock,
} from '../dsl4/asset-distribution-profile.js';
import {createDsl4SourceGraphFrontend} from '../dsl4/source-graph-frontend.js';
import {validateDsl4ExternalSourceManifest} from './dsl4-external-source.js';
import {loadDsl4ExternalSource} from './dsl4-external-source.js';
import {loadDsl4BuildSourceGraph} from './dsl4-source-graph.js';
import {resolveDsl4BuildSourceLimits} from './dsl4-source-limits.js';
import {loadDsl4ProjectJson, loadDsl4ProjectSourceManifest} from './dsl4-asset-audit.js';
import {installBundleTransactionally} from './atomic-output.js';
import {Sb3BuilderError} from './errors.js';
import {sha256} from './hash.js';

const defaultFileSystem = Object.freeze({lstat, open, readdir, realpath});
const poseModelContentType = 'application/vnd.tmpose.pose-model';
const defaultMaxCompressionRatio = 100;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} message @param {string} code @param {unknown} [cause] @returns {never} */
function fail(message, code, cause) {
  throw new Sb3BuilderError(message, {stage: 'dsl4-asset-lock', code, cause});
}

/** @param {unknown} value @param {string} name */
function positiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} name */
function nonNegativeLimit(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return Number(value);
}

/** @param {unknown} value */
function validateFileSystem(value) {
  if (
    !isRecord(value) ||
    typeof value.realpath !== 'function' ||
    typeof value.lstat !== 'function' ||
    typeof value.open !== 'function' ||
    typeof value.readdir !== 'function'
  ) {
    throw new TypeError('fileSystem must provide realpath, lstat, open, and readdir');
  }
  return /** @type {{realpath: Function, lstat: Function, open: Function, readdir: Function}} */ (
    value
  );
}

/** @param {string} ancestor @param {string} candidate */
function isWithin(ancestor, candidate) {
  const relative = path.relative(ancestor, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/** @param {string} value @param {string} name */
function canonicalHost(value, name) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u0020/\\#?@]/u.test(value)) {
    throw new TypeError(`${name} must be a hostname without path or credentials`);
  }
  let parsed;
  try {
    parsed = new URL(`https://${value}`);
  } catch {
    throw new TypeError(`${name} must be a valid hostname`);
  }
  if (
    parsed.hostname !== value.toLowerCase() ||
    parsed.port ||
    parsed.username ||
    parsed.password
  ) {
    throw new TypeError(`${name} must be a canonical hostname without a port`);
  }
  return parsed.hostname;
}

/** @param {unknown} value */
function normalizeAllowedHosts(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('allowedHosts must contain at least one hostname');
  }
  return [...new Set(value.map((host) => canonicalHost(host, 'allowedHosts entry')))].sort();
}

/** @param {string} value @param {string} name */
function httpsUrl(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${name} must be an absolute HTTPS URL`, 'K4-ASSET-REMOTE-001');
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    fail(
      `${name} must be an absolute HTTPS URL without credentials or fragment`,
      'K4-ASSET-REMOTE-001',
    );
  }
  return parsed;
}

/** @param {string} contentType */
function normalizeContentType(contentType) {
  return contentType.split(';', 1)[0].trim().toLowerCase();
}

/** @param {string} host @param {ReadonlyArray<string>} allowedHosts */
function assertAllowedHost(host, allowedHosts) {
  if (!allowedHosts.includes(host.toLowerCase())) {
    fail(`Remote host is not allowlisted: ${host.toLowerCase()}`, 'K4-ASSET-REMOTE-HOST-001');
  }
}

/** @param {Response} response @param {number} maximumBytes */
async function readResponseBody(response, maximumBytes) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      fail('Remote response Content-Length is invalid', 'K4-ASSET-REMOTE-RESPONSE-001');
    }
    if (parsedLength > maximumBytes) {
      fail('Remote response exceeds the finite byte limit', 'K4-ASSET-REMOTE-SIZE-001');
    }
  }
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximumBytes) {
      fail('Remote response exceeds the finite byte limit', 'K4-ASSET-REMOTE-SIZE-001');
    }
    return bytes;
  }
  const reader = response.body.getReader();
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (!Number.isSafeInteger(size) || size > maximumBytes) {
        await reader.cancel('remote asset size limit exceeded');
        fail('Remote response exceeds the finite byte limit', 'K4-ASSET-REMOTE-SIZE-001');
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

/**
 * Fetch one remote provider with host, redirect, timeout, and streaming limits.
 *
 * @param {string} inputUrl
 * @param {any} options
 */
export async function fetchDsl4AssetRemote(inputUrl, options) {
  let currentUrl = httpsUrl(inputUrl, 'remote provider URL');
  for (let redirects = 0; ; redirects += 1) {
    assertAllowedHost(currentUrl.hostname, options.allowedHosts);
    let response;
    try {
      response = await options.fetchImplementation(currentUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      fail('Remote provider request failed', 'K4-ASSET-REMOTE-REQUEST-001', error);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      if (redirects >= options.maxRedirects) {
        fail('Remote provider redirect limit exceeded', 'K4-ASSET-REMOTE-REDIRECT-001');
      }
      const location = response.headers.get('location');
      if (!location)
        fail('Remote provider redirect has no Location', 'K4-ASSET-REMOTE-REDIRECT-001');
      const redirected = new URL(location, currentUrl);
      if (redirected.protocol !== 'https:') {
        fail('Remote provider redirect must remain HTTPS', 'K4-ASSET-REMOTE-REDIRECT-001');
      }
      currentUrl = redirected;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      fail('Remote provider returned an unsuccessful response', 'K4-ASSET-REMOTE-REQUEST-001');
    }
    const bytes = await readResponseBody(response, options.maxBytes);
    const contentType = normalizeContentType(response.headers.get('content-type') ?? '');
    if (!contentType)
      fail('Remote provider response has no Content-Type', 'K4-ASSET-REMOTE-TYPE-001');
    return {bytes, contentType, finalUrl: currentUrl.href};
  }
}

/** @param {string} filePath @param {string} name */
function safeRelativePath(filePath, name) {
  if (
    typeof filePath !== 'string' ||
    filePath.length === 0 ||
    filePath.includes('\\') ||
    filePath.startsWith('/') ||
    /^[A-Za-z]:/u.test(filePath) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(filePath) ||
    filePath
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new TypeError(`${name} must be a canonical project-relative POSIX path`);
  }
  return filePath;
}

/** @param {Buffer} bytes @param {string} filePath @param {string} kind */
function localContentType(bytes, filePath, kind) {
  if (kind === 'poseModel') return poseModelContentType;
  if (kind === 'backdrop' || kind === 'costume' || kind === 'image') {
    if (
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      return 'image/png';
    }
    if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
    if (
      bytes.subarray(0, 6).toString() === 'GIF89a' ||
      bytes.subarray(0, 6).toString() === 'GIF87a'
    ) {
      return 'image/gif';
    }
    if (
      bytes.subarray(0, 12).toString('ascii', 0, 4) === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'image/webp';
    }
    try {
      if (
        /^(?:\uFEFF)?\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|\/?>)/iu.test(
          new TextDecoder().decode(bytes.subarray(0, 4096)),
        )
      ) {
        return 'image/svg+xml';
      }
    } catch {
      // The unsupported type diagnostic below is authoritative.
    }
  }
  if (kind === 'sound') {
    if (
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WAVE'
    )
      return 'audio/wav';
    if (bytes.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
    if (
      bytes.subarray(0, 3).toString('ascii') === 'ID3' ||
      (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
    )
      return 'audio/mpeg';
  }
  const extension = filePath.split('.').at(-1)?.toLowerCase() ?? '';
  const extensionTypes = /** @type {Record<string, string>} */ ({
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    wave: 'audio/wav',
  });
  const inferred = extensionTypes[extension];
  if (inferred) return inferred;
  fail(`Cannot determine Content-Type for local ${kind} asset`, 'K4-ASSET-TYPE-001');
}

/** @param {{path: string, size: number, integrity: string}[]} files */
function logicalBundle(files) {
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

/** @param {string} assetId @param {Readonly<Record<string, any>>} asset @param {Readonly<Record<string, any>> | undefined} configured */
function declaredProviders(assetId, asset, configured) {
  const result = /** @type {Record<string, any>} */ ({});
  if (asset.delivery === 'embedded') {
    result.embedded =
      typeof asset.file === 'string' ? {file: asset.file} : {name: asset.name ?? assetId};
  } else if (isRecord(asset.source)) {
    result.remote = {url: asset.source.url};
  }
  for (const delivery of ['embedded', 'remote']) {
    if (!configured?.[delivery]) continue;
    if (
      result[delivery] &&
      JSON.stringify(result[delivery]) !== JSON.stringify(configured[delivery])
    ) {
      fail(`Asset ${assetId} has conflicting ${delivery} providers`, 'K4-ASSET-PROVIDER-001');
    }
    result[delivery] = configured[delivery];
  }
  return result;
}

/** @param {string} filePath @param {number} limit @param {{open: Function}} fileSystem */
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
      size += result.bytesRead;
      chunks.push(chunk.subarray(0, result.bytesRead));
    }
  } finally {
    await handle.close();
  }
  if (size > limit) fail('Local asset exceeds the finite byte limit', 'K4-ASSET-SIZE-001');
  return Buffer.concat(chunks, size);
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

/** @param {string} filePath @param {number} limit @param {{lstat: Function, open: Function}} fileSystem */
async function readStableFile(filePath, limit, fileSystem) {
  const before = await fileSystem.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink())
    fail('Local asset is not a regular file', 'K4-ASSET-FILE-001');
  if (before.size > limit) fail('Local asset exceeds the finite byte limit', 'K4-ASSET-SIZE-001');
  const first = await readBoundedFile(filePath, limit, fileSystem);
  const middle = await fileSystem.lstat(filePath);
  const second = await readBoundedFile(filePath, limit, fileSystem);
  const after = await fileSystem.lstat(filePath);
  if (!sameFileState(before, middle) || !sameFileState(middle, after) || !first.equals(second)) {
    fail('Local asset changed while it was being read', 'K4-ASSET-UNSTABLE-001');
  }
  return first;
}

/** @param {string} rootPath @param {string} assetId @param {{lstat: Function, readdir: Function}} fileSystem */
async function enumerateLocalFiles(rootPath, assetId, fileSystem) {
  /** @type {{path: string, absolutePath: string}[]} */
  const result = [];
  /** @param {string} directory @param {string} relativeDirectory */
  async function visit(directory, relativeDirectory) {
    const entries = await fileSystem.readdir(directory, {withFileTypes: true});
    /** @type {import('node:fs').Dirent[]} */
    const typedEntries = entries;
    typedEntries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of typedEntries) {
      if (
        !entry.name ||
        entry.name === '.' ||
        entry.name === '..' ||
        entry.name.includes('/') ||
        entry.name.includes('\\') ||
        entry.name.includes('\0')
      ) {
        fail(`PoseModel ${assetId} contains an unsafe entry name`, 'K4-ASSET-PATH-001');
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const state = await fileSystem.lstat(absolutePath);
      if (state.isSymbolicLink())
        fail(`PoseModel ${assetId} contains a symbolic link`, 'K4-ASSET-SYMLINK-001');
      if (state.isDirectory()) await visit(absolutePath, relativePath);
      else if (state.isFile()) result.push({path: relativePath, absolutePath});
      else fail(`PoseModel ${assetId} contains a special file`, 'K4-ASSET-FILE-001');
    }
  }
  await visit(rootPath, '');
  return result;
}

/** @param {Readonly<Record<string, any>>} asset @param {{file: string}} provider @param {Record<string, any>} options */
async function inspectLocalProvider(asset, provider, options) {
  const inputPath = safeRelativePath(provider.file, `Asset ${asset.id} embedded.file`);
  const requestedPath = path.resolve(options.canonicalRoot, ...inputPath.split('/'));
  let state;
  let canonicalPath;
  try {
    state = await options.fileSystem.lstat(requestedPath);
    if (state.isSymbolicLink())
      fail(`Asset ${asset.id} root is a symbolic link`, 'K4-ASSET-SYMLINK-001');
    canonicalPath = await options.fileSystem.realpath(requestedPath);
  } catch (error) {
    if (error instanceof Sb3BuilderError) throw error;
    fail(`Asset ${asset.id} local provider is missing`, 'K4-ASSET-MISSING', error);
  }
  if (!isWithin(options.canonicalRoot, canonicalPath))
    fail(`Asset ${asset.id} escapes the project root`, 'K4-ASSET-PATH-001');
  if (asset.kind !== 'poseModel' && !state.isFile())
    fail(`Asset ${asset.id} must be a regular file`, 'K4-ASSET-FILE-001');
  if (asset.kind === 'poseModel' && !state.isFile() && !state.isDirectory())
    fail(`PoseModel ${asset.id} must be a file or directory`, 'K4-ASSET-FILE-001');
  if (asset.kind === 'poseModel' && state.isFile() && isDsl4PoseArchivePath(inputPath)) {
    const archiveBytes = await readStableFile(
      canonicalPath,
      options.maxFileBytes,
      options.fileSystem,
    );
    options.totalBytes += archiveBytes.length;
    if (options.totalBytes > options.maxTotalBytes)
      fail('Asset lock exceeds maxTotalAssetBytes', 'K4-ASSET-TOTAL-SIZE-001');
    const archiveIntegrity = `sha256-${sha256(archiveBytes)}`;
    let extracted;
    try {
      extracted = await options.poseArchiveExtractor(
        {assetId: asset.id, archiveIntegrity, bytes: new Uint8Array(archiveBytes)},
        {},
      );
    } catch (error) {
      fail(`Local pose archive failed validation for ${asset.id}`, 'K4-ASSET-ARCHIVE-001', error);
    }
    options.fileCount += extracted.files.length;
    if (options.fileCount > options.maxFiles)
      fail('Asset lock exceeds maxAssetFiles', 'K4-ASSET-COUNT-001');
    const files = extracted.files.map((/** @type {any} */ file) => ({
      path: file.path,
      size: file.size,
      integrity: `sha256-${sha256(file.bytes)}`,
    }));
    return {provider: {file: inputPath}, logical: logicalBundle(files)};
  }
  const entries = state.isDirectory()
    ? await enumerateLocalFiles(canonicalPath, asset.id, options.fileSystem)
    : [{path: path.posix.basename(inputPath), absolutePath: canonicalPath}];
  if (entries.length === 0) fail(`PoseModel ${asset.id} directory is empty`, 'K4-ASSET-FILE-001');
  const files = [];
  const contentsByPath = new Map();
  for (const entry of entries) {
    if (++options.fileCount > options.maxFiles)
      fail('Asset lock exceeds maxAssetFiles', 'K4-ASSET-COUNT-001');
    const bytes = await readStableFile(
      entry.absolutePath,
      options.maxFileBytes,
      options.fileSystem,
    );
    options.totalBytes += bytes.length;
    if (options.totalBytes > options.maxTotalBytes)
      fail('Asset lock exceeds maxTotalAssetBytes', 'K4-ASSET-TOTAL-SIZE-001');
    files.push({path: entry.path, size: bytes.length, integrity: `sha256-${sha256(bytes)}`});
    contentsByPath.set(entry.path, bytes);
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const logical =
    asset.kind === 'poseModel'
      ? logicalBundle(files)
      : {
          contentIntegrity: files[0].integrity,
          contentType: localContentType(
            contentsByPath.get(files[0].path),
            files[0].path,
            asset.kind,
          ),
          size: files[0].size,
        };
  return {provider: {file: inputPath}, logical};
}

/** @param {Readonly<Record<string, any>>} asset @param {{url: string}} provider @param {Record<string, any>} options */
async function inspectRemoteProvider(asset, provider, options) {
  const remote = await fetchDsl4AssetRemote(provider.url, options);
  options.totalBytes += remote.bytes.length;
  if (options.totalBytes > options.maxTotalBytes)
    fail('Asset lock exceeds maxTotalAssetBytes', 'K4-ASSET-TOTAL-SIZE-001');
  if (asset.kind === 'poseModel') {
    const archiveIntegrity = `sha256-${sha256(remote.bytes)}`;
    let extracted;
    try {
      extracted = await options.poseArchiveExtractor(
        {assetId: asset.id, archiveIntegrity, bytes: new Uint8Array(remote.bytes)},
        {},
      );
    } catch (error) {
      fail(`Remote pose archive failed validation for ${asset.id}`, 'K4-ASSET-ARCHIVE-001', error);
    }
    options.fileCount += extracted.files.length;
    if (options.fileCount > options.maxFiles)
      fail('Asset lock exceeds maxAssetFiles', 'K4-ASSET-COUNT-001');
    const files = extracted.files.map((/** @type {any} */ file) => ({
      path: file.path,
      size: file.size,
      integrity: `sha256-${sha256(file.bytes)}`,
    }));
    return {
      provider: {
        url: provider.url,
        transportIntegrity: archiveIntegrity,
        contentType: remote.contentType,
        size: remote.bytes.length,
      },
      logical: logicalBundle(files),
    };
  }
  return {
    provider: {
      url: provider.url,
      transportIntegrity: `sha256-${sha256(remote.bytes)}`,
      contentType: remote.contentType,
      size: remote.bytes.length,
    },
    logical: {
      contentIntegrity: `sha256-${sha256(remote.bytes)}`,
      contentType: remote.contentType,
      size: remote.bytes.length,
    },
  };
}

/** @param {Readonly<Record<string, any>>} asset @param {Record<string, any>} providers @param {Record<string, any>} options */
async function inspectAssetProviders(asset, providers, options) {
  if (providers.embedded?.name && !providers.remote) {
    fail(
      `Asset ${asset.id} project provider has no bytes for lock generation`,
      'K4-ASSET-PROJECT-001',
    );
  }
  const embedded = providers.embedded?.file
    ? await inspectLocalProvider(asset, providers.embedded, options)
    : null;
  const remote = providers.remote
    ? await inspectRemoteProvider(asset, providers.remote, options)
    : null;
  const logical = embedded?.logical ?? remote?.logical;
  if (!logical) fail(`Asset ${asset.id} has no lockable provider`, 'K4-ASSET-PROVIDER-001');
  if (embedded && remote && JSON.stringify(embedded.logical) !== JSON.stringify(remote.logical)) {
    fail(
      `Asset ${asset.id} local and remote logical content differ`,
      'K4-ASSET-CONTENT-MISMATCH-001',
    );
  }
  return {
    kind: asset.kind,
    contentIntegrity: logical.contentIntegrity,
    contentType: logical.contentType,
    size: logical.size,
    providers: {
      ...(embedded
        ? {embedded: embedded.provider}
        : providers.embedded?.name
          ? {embedded: {name: providers.embedded.name}}
          : {}),
      ...(remote ? {remote: remote.provider} : {}),
    },
  };
}

/** @param {any} options */
export async function generateDsl4AssetDistributionLock(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('lock generation options are required');
  }
  if (typeof options.projectRoot !== 'string' || options.projectRoot.length === 0)
    throw new TypeError('projectRoot must be a non-empty string');
  if (!options.sourceFrontend || typeof options.sourceFrontend.parse !== 'function')
    throw new TypeError('sourceFrontend must provide parse');
  const sourceIncludesEnabled = options.sourceIncludesEnabled ?? false;
  if (typeof sourceIncludesEnabled !== 'boolean')
    throw new TypeError('sourceIncludesEnabled must be a boolean');
  const sourceLimits = resolveDsl4BuildSourceLimits({
    sourceIncludesEnabled,
    maxSourceBytes: options.maxSourceBytes,
    maxTotalSourceBytes: options.maxTotalSourceBytes,
  });
  const maxSourceManifestBytes = positiveLimit(
    options.maxSourceManifestBytes,
    'maxSourceManifestBytes',
  );
  const maxAssetConfigBytes = positiveLimit(options.maxAssetConfigBytes, 'maxAssetConfigBytes');
  const maxFileBytes = positiveLimit(options.maxAssetFileBytes, 'maxAssetFileBytes');
  const maxFiles = positiveLimit(options.maxAssetFiles, 'maxAssetFiles');
  const maxTotalBytes = positiveLimit(options.maxTotalAssetBytes, 'maxTotalAssetBytes');
  const timeoutMs = positiveLimit(options.timeoutMs, 'timeoutMs');
  const maxRedirects = nonNegativeLimit(options.maxRedirects, 'maxRedirects');
  const allowedHosts = normalizeAllowedHosts(options.allowedHosts);
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function')
    throw new TypeError('fetchImplementation must be a function');
  const fileSystem = validateFileSystem(options.fileSystem ?? defaultFileSystem);
  let canonicalRoot;
  try {
    canonicalRoot = await fileSystem.realpath(path.resolve(options.projectRoot));
    const rootState = await fileSystem.lstat(canonicalRoot);
    if (!rootState.isDirectory()) fail('Project root is not a directory', 'K4-ASSET-ROOT-001');
  } catch (error) {
    if (error instanceof Sb3BuilderError) throw error;
    fail('Cannot resolve project root', 'K4-ASSET-ROOT-001', error);
  }
  const manifestInput = await loadDsl4ProjectSourceManifest({
    projectRoot: options.projectRoot,
    inputPath: options.sourceManifest,
    maxBytes: maxSourceManifestBytes,
    label: 'source manifest',
    code: 'K4-SOURCE-MANIFEST-001',
    fileSystem,
    readFile: options.readFile,
  });
  const configInput = await loadDsl4ProjectJson({
    projectRoot: options.projectRoot,
    inputPath: options.assetConfig,
    maxBytes: maxAssetConfigBytes,
    label: 'asset distribution config',
    code: 'K4-ASSET-PROFILE-001',
    fileSystem,
    readFile: options.readFile,
  });
  const manifest = validateDsl4ExternalSourceManifest(manifestInput);
  const config = validateDsl4AssetDistributionConfig(configInput);
  const source = await loadDsl4ExternalSource(options.projectRoot, manifest, {
    maxSourceBytes: sourceLimits.maxSourceFileBytes,
    fileSystem,
    readSource: options.readFile,
  });
  let parsed;
  if (sourceIncludesEnabled) {
    const sourceGraph = await loadDsl4BuildSourceGraph(options.projectRoot, source, {
      limits: {
        maxSourceBytes: sourceLimits.maxSourceFileBytes,
        maxTotalSourceBytes: sourceLimits.maxSourceGraphBytes,
        maxSourceFiles: positiveLimit(options.maxSourceFiles, 'maxSourceFiles'),
        maxIncludeDepth: positiveLimit(options.maxIncludeDepth, 'maxIncludeDepth'),
      },
      fileSystem,
      readSource: options.readFile,
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
  if (!parseResult.ok)
    fail(
      parseResult.diagnostics?.[0]?.message ?? 'DSL 4.0 source validation failed',
      parseResult.diagnostics?.[0]?.code ?? 'K4-ASSET-LOCK-001',
    );
  const storyAssets = parseResult.storyDocument.assets ?? {};
  for (const assetId of Object.keys(config.providers))
    if (!Object.hasOwn(storyAssets, assetId))
      fail(`Provider configuration references unknown asset ${assetId}`, 'K4-ASSET-PROVIDER-001');
  for (const profile of Object.values(config.profiles))
    for (const assetId of Object.keys(profile.assets ?? {}))
      if (!Object.hasOwn(storyAssets, assetId))
        fail(`Profile references unknown asset ${assetId}`, 'K4-ASSET-PROFILE-001');
  const optionsForProviders = {
    projectRoot: options.projectRoot,
    canonicalRoot,
    fileSystem,
    maxFileBytes,
    maxFiles,
    maxTotalBytes,
    fileCount: 0,
    totalBytes: 0,
    allowedHosts,
    timeoutMs,
    maxRedirects,
    maxBytes: maxFileBytes,
    fetchImplementation,
    poseArchiveExtractor: createDsl4PoseArchiveExtractor({
      limits: {
        maxArchiveBytes: maxFileBytes,
        maxEntries: 16,
        maxCompressedEntryBytes: maxFileBytes,
        maxExpandedEntryBytes: maxFileBytes,
        maxTotalExpandedBytes: maxTotalBytes,
        maxCompressionRatio: defaultMaxCompressionRatio,
      },
      subtleCrypto: options.subtleCrypto,
    }),
  };
  const assets = /** @type {Record<string, any>} */ ({});
  for (const assetId of Object.keys(storyAssets).sort())
    assets[assetId] = await inspectAssetProviders(
      storyAssets[assetId],
      declaredProviders(assetId, storyAssets[assetId], config.providers[assetId]),
      optionsForProviders,
    );
  const lock = validateDsl4AssetDistributionLock({formatVersion: 1, assets});
  return deepFreeze({
    lock,
    serialized: serializeDsl4AssetDistributionLock(lock),
    sourceId: source.descriptor.sourceId,
  });
}

/** @param {any} options */
export async function generateDsl4AssetDistributionLockFile(options) {
  const result = await generateDsl4AssetDistributionLock(options);
  const outputPath = path.resolve(options.output);
  const outputDirectory = path.dirname(outputPath);
  const outputName = path.basename(outputPath);
  if (!outputName || outputName === '.' || outputName === '..')
    throw new TypeError('output must name a file');
  const installed = await installBundleTransactionally({
    outputDirectory,
    outputName,
    files: new Map([[outputName, Buffer.from(result.serialized, 'utf8')]]),
    validateCandidate: async (candidateDirectory) => {
      const candidate = JSON.parse(
        await readFile(path.join(candidateDirectory, outputName), 'utf8'),
      );
      validateDsl4AssetDistributionLock(candidate);
    },
  });
  return {...result, outputPath: installed[outputName]};
}
