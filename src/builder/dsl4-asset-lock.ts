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
import {loadDsl4ExternalSource} from './dsl4-external-source.js';
import {resolveDsl4ProjectSource} from './dsl4-project-source.js';
import {loadDsl4BuildSourceGraph} from './dsl4-source-graph.js';
import {resolveDsl4BuildSourceLimits} from './dsl4-source-limits.js';
import {loadDsl4ProjectJson} from './dsl4-asset-audit.js';
import {installBundleTransactionally} from './atomic-output.js';
import {Sb3BuilderError} from './errors.js';
import {sha256} from './hash.js';

const defaultFileSystem = Object.freeze({lstat, open, readdir, realpath});
const poseModelContentType = 'application/vnd.tm.pose-model';
const defaultMaxCompressionRatio = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string, code: string, cause?: unknown): never {
  throw new Sb3BuilderError(message, {stage: 'dsl4-asset-lock', code, cause});
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

function validateFileSystem(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.realpath !== 'function' ||
    typeof value.lstat !== 'function' ||
    typeof value.open !== 'function' ||
    typeof value.readdir !== 'function'
  ) {
    throw new TypeError('fileSystem must provide realpath, lstat, open, and readdir');
  }
  return value as {realpath: Function; lstat: Function; open: Function; readdir: Function};
}

function isWithin(ancestor: string, candidate: string) {
  const relative = path.relative(ancestor, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function canonicalHost(value: string, name: string) {
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

function normalizeAllowedHosts(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('allowedHosts must contain at least one hostname');
  }
  return [...new Set(value.map((host) => canonicalHost(host, 'allowedHosts entry')))].sort();
}

function httpsUrl(value: string, name: string) {
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

function normalizeContentType(contentType: string) {
  return contentType.split(';', 1)[0].trim().toLowerCase();
}

function assertAllowedHost(host: string, allowedHosts: ReadonlyArray<string>) {
  if (!allowedHosts.includes(host.toLowerCase())) {
    fail(`Remote host is not allowlisted: ${host.toLowerCase()}`, 'K4-ASSET-REMOTE-HOST-001');
  }
}

async function readResponseBody(response: Response, maximumBytes: number) {
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
  const chunks: Buffer[] = [];
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

/** Fetch one remote provider with host, redirect, timeout, and streaming limits. */
export async function fetchDsl4AssetRemote(inputUrl: string, options: any) {
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

function safeRelativePath(filePath: string, name: string) {
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

function localContentType(bytes: Buffer, filePath: string, kind: string) {
  if (kind === 'recognitionModel') return poseModelContentType;
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
  const extensionTypes = {
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
  } as Record<string, string>;
  const inferred = extensionTypes[extension];
  if (inferred) return inferred;
  fail(`Cannot determine Content-Type for local ${kind} asset`, 'K4-ASSET-TYPE-001');
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

function declaredProviders(
  assetId: string,
  asset: Readonly<Record<string, any>>,
  configured: Readonly<Record<string, any>> | undefined,
) {
  const result = {} as Record<string, any>;
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

async function readBoundedFile(filePath: string, limit: number, fileSystem: {open: Function}) {
  const handle = await fileSystem.open(filePath, 'r');
  const chunks: Buffer[] = [];
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

function sameFileState(left: Record<string, any>, right: Record<string, any>) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function readStableFile(
  filePath: string,
  limit: number,
  fileSystem: {lstat: Function; open: Function},
) {
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

async function enumerateLocalFiles(
  rootPath: string,
  assetId: string,
  fileSystem: {lstat: Function; readdir: Function},
) {
  const result: {path: string; absolutePath: string}[] = [];
  async function visit(directory: string, relativeDirectory: string) {
    const entries = await fileSystem.readdir(directory, {withFileTypes: true});
    const typedEntries: import('node:fs').Dirent[] = entries;
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

async function inspectLocalProvider(
  asset: Readonly<Record<string, any>>,
  provider: {file: string},
  options: Record<string, any>,
) {
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
  const recognitionModel = asset.kind === 'recognitionModel';
  if (!recognitionModel && !state.isFile())
    fail(`Asset ${asset.id} must be a regular file`, 'K4-ASSET-FILE-001');
  if (recognitionModel && !state.isFile() && !state.isDirectory())
    fail(`RecognitionModel ${asset.id} must be a file or directory`, 'K4-ASSET-FILE-001');
  if (recognitionModel && state.isFile() && isDsl4PoseArchivePath(inputPath)) {
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
    const files = extracted.files.map((file: any) => ({
      path: file.path,
      size: file.size,
      integrity: `sha256-${sha256(file.bytes)}`,
    }));
    return {provider: {file: inputPath}, logical: logicalBundle(files)};
  }
  const entries = state.isDirectory()
    ? await enumerateLocalFiles(canonicalPath, asset.id, options.fileSystem)
    : [{path: path.posix.basename(inputPath), absolutePath: canonicalPath}];
  if (entries.length === 0)
    fail(`RecognitionModel ${asset.id} directory is empty`, 'K4-ASSET-FILE-001');
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
  const logical = recognitionModel
    ? logicalBundle(files)
    : {
        contentIntegrity: files[0].integrity,
        contentType: localContentType(contentsByPath.get(files[0].path), files[0].path, asset.kind),
        size: files[0].size,
      };
  return {provider: {file: inputPath}, logical};
}

async function inspectRemoteProvider(
  asset: Readonly<Record<string, any>>,
  provider: {url: string},
  options: Record<string, any>,
) {
  const remote = await fetchDsl4AssetRemote(provider.url, options);
  options.totalBytes += remote.bytes.length;
  if (options.totalBytes > options.maxTotalBytes)
    fail('Asset lock exceeds maxTotalAssetBytes', 'K4-ASSET-TOTAL-SIZE-001');
  if (asset.kind === 'recognitionModel') {
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
    const files = extracted.files.map((file: any) => ({
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

async function inspectAssetProviders(
  asset: Readonly<Record<string, any>>,
  providers: Record<string, any>,
  options: Record<string, any>,
) {
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

export async function generateDsl4AssetDistributionLock(options: any) {
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
  const resolvedSource = await resolveDsl4ProjectSource({
    projectRoot: options.projectRoot,
    ...(options.sourceManifest === undefined ? {} : {sourceManifest: options.sourceManifest}),
    ...(options.source === undefined ? {} : {source: options.source}),
    ...(options.sourceId === undefined ? {} : {sourceId: options.sourceId}),
    maxSourceManifestBytes,
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
  const manifest = resolvedSource.manifest;
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
  const parseResult = parsed as Readonly<Record<string, any>>;
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
  const assets = {} as Record<string, any>;
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

export async function generateDsl4AssetDistributionLockFile(options: any) {
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
