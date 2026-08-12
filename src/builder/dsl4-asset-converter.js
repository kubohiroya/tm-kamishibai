import {spawn} from 'node:child_process';
import {lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {zipSync} from 'fflate';
import {parseDocument} from 'yaml';

import {deepFreeze} from '../dsl4/story-document.js';
import {loadDsl4ProjectJson} from './dsl4-asset-audit.js';
import {fetchDsl4AssetRemote} from './dsl4-asset-lock.js';
import {
  loadDsl4ExternalSource,
  validateDsl4ExternalSourceManifest,
} from './dsl4-external-source.js';
import {loadDsl4LocalAssetSnapshot} from './dsl4-local-assets.js';
import {fixedZipTimestamp} from './constants.js';
import {Sb3BuilderError} from './errors.js';
import {md5, sha256} from './hash.js';
import {readSb3, serializeSb3} from './sb3.js';

const supportedTargets = new Set(['local', 'project', 'remote']);
const projectKinds = new Set(['backdrop', 'costume', 'sound']);
const sourceSuffixes = ['.kamishibai.yaml', '.kamishibai.yml', '.k4.yaml', '.k4.yml'];
const defaultRsyncSshPort = 22;
const maximumProcessDiagnosticBytes = 16 * 1024;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} message @param {string} code @param {unknown} [cause] @returns {never} */
function fail(message, code, cause) {
  throw new Sb3BuilderError(message, {stage: 'dsl4-asset-convert', code, cause});
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

/** @param {string} ancestor @param {string} candidate */
function isWithin(ancestor, candidate) {
  const relative = path.relative(ancestor, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/** @param {unknown} error */
function isMissing(error) {
  return isRecord(error) && error.code === 'ENOENT';
}

/** @param {unknown} value */
function normalizeAllowedHosts(value) {
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

/** @param {unknown} value */
function normalizeRsyncDestination(value) {
  if (typeof value !== 'string') {
    fail('rsyncDestination must be a string', 'K4-ASSET-CONVERT-RSYNC-CONFIG-001');
  }
  const match =
    /^(?:(?<user>[A-Za-z0-9][A-Za-z0-9._-]*)@)?(?<host>[A-Za-z0-9][A-Za-z0-9._-]*):(?<remotePath>\/[A-Za-z0-9._/-]*)$/u.exec(
      value,
    );
  if (!match?.groups) {
    fail(
      'rsyncDestination must use the safe [user@]host:/absolute/path form',
      'K4-ASSET-CONVERT-RSYNC-CONFIG-001',
    );
  }
  const remotePath = match.groups.remotePath;
  if (
    remotePath.includes('//') ||
    remotePath.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    fail(
      'rsyncDestination path must not contain empty, dot, or parent segments',
      'K4-ASSET-CONVERT-RSYNC-CONFIG-001',
    );
  }
  return value.endsWith('/') ? value : `${value}/`;
}

/** @param {unknown} value */
function normalizeRemoteBaseUrl(value) {
  if (typeof value !== 'string') {
    fail('remoteBaseUrl must be a string', 'K4-ASSET-CONVERT-RSYNC-CONFIG-001');
  }
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    fail('remoteBaseUrl is invalid', 'K4-ASSET-CONVERT-RSYNC-CONFIG-001', error);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith('/') ||
    url.href !== value
  ) {
    fail(
      'remoteBaseUrl must be a canonical HTTPS directory URL without credentials, query, or fragment',
      'K4-ASSET-CONVERT-RSYNC-CONFIG-001',
    );
  }
  return url;
}

/**
 * @param {{executable: string, arguments: string[], timeoutMs: number}} command
 */
async function runRsyncProcess(command) {
  await new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let diagnostic = '';
    const child = spawn(command.executable, command.arguments, {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    /** @param {unknown} [error] */
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(undefined);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, command.timeoutMs);
    timer.unref();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (diagnostic.length < maximumProcessDiagnosticBytes) {
        diagnostic += chunk.slice(0, maximumProcessDiagnosticBytes - diagnostic.length);
      }
    });
    child.once('error', (error) => {
      finish(
        new Sb3BuilderError('Cannot start rsync', {
          stage: 'dsl4-asset-convert',
          code: 'K4-ASSET-CONVERT-RSYNC-001',
          cause: error,
        }),
      );
    });
    child.once('close', (code, signal) => {
      if (timedOut) {
        finish(
          new Sb3BuilderError('rsync timed out', {
            stage: 'dsl4-asset-convert',
            code: 'K4-ASSET-CONVERT-RSYNC-TIMEOUT-001',
          }),
        );
      } else if (code !== 0) {
        const suffix = diagnostic.trim() ? `: ${diagnostic.trim()}` : '';
        finish(
          new Sb3BuilderError(
            `rsync failed with ${signal ? `signal ${signal}` : `exit ${code}`}${suffix}`,
            {
              stage: 'dsl4-asset-convert',
              code: 'K4-ASSET-CONVERT-RSYNC-001',
            },
          ),
        );
      } else {
        finish();
      }
    });
  });
}

/** @param {unknown} value @param {string} fallback */
function outputName(value, fallback) {
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

/** @param {string} filename */
function sourceStem(filename) {
  const suffix = sourceSuffixes.find((candidate) => filename.endsWith(candidate));
  const stem = suffix ? filename.slice(0, -suffix.length) : path.parse(filename).name;
  return stem || 'story';
}

/** @param {string} assetId */
function assetDirectoryName(assetId) {
  const readable = assetId
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);
  return `${readable || 'asset'}-${sha256(assetId).slice(0, 8)}`;
}

/** @param {string} contentType @param {string} kind */
function extensionFor(contentType, kind) {
  const known = /** @type {Record<string, string>} */ ({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
  });
  const knownExtension = known[contentType];
  if (knownExtension) return knownExtension;
  const subtype = contentType.split('/')[1]?.replace(/[^a-z0-9]+/gu, '-') || kind;
  return subtype || 'bin';
}

/** @param {Buffer} bytes @param {string} filePath @param {string} kind */
function contentTypeFor(bytes, filePath, kind) {
  if (kind === 'backdrop' || kind === 'costume' || kind === 'image') {
    if (
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      return 'image/png';
    }
    if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
    const signature = bytes.subarray(0, 6).toString('ascii');
    if (signature === 'GIF89a' || signature === 'GIF87a') return 'image/gif';
    if (
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
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
      // The diagnostic below is authoritative.
    }
  }
  if (kind === 'sound') {
    if (
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WAVE'
    ) {
      return 'audio/wav';
    }
    if (bytes.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
    if (
      bytes.subarray(0, 3).toString('ascii') === 'ID3' ||
      (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
    ) {
      return 'audio/mpeg';
    }
  }
  const extension = filePath.split('.').at(-1)?.toLowerCase() ?? '';
  const byExtension = /** @type {Record<string, string>} */ ({
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    png: 'image/png',
    svg: 'image/svg+xml',
    wav: 'audio/wav',
    wave: 'audio/wav',
    webp: 'image/webp',
  });
  const inferred = byExtension[extension];
  if (inferred) return inferred;
  fail(`Cannot determine the media type for asset file ${filePath}`, 'K4-ASSET-CONVERT-TYPE-001');
}

/**
 * @param {unknown} value
 * @param {{allowBare?: boolean, label?: string}} [options]
 * @returns {Readonly<{url: string, integrity?: string, contentType?: string, size?: number}>}
 */
function validateRemoteSource(value, {allowBare = false, label = 'Remote mapping entry'} = {}) {
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
  if (!verified) return Object.freeze({url: /** @type {string} */ (value.url)});
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
    url: /** @type {string} */ (value.url),
    integrity: /** @type {string} */ (value.integrity),
    contentType: /** @type {string} */ (value.contentType),
    size: Number(value.size),
  });
}

/** @param {unknown} value @param {Readonly<Record<string, unknown>>} assets */
function validateRemoteMap(value, assets) {
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

/** @param {Record<string, unknown>} target */
function projectTargetName(target) {
  return typeof target.name === 'string' ? target.name : '';
}

/** @param {Record<string, unknown>} target @param {string} actorId */
function projectActorVariableMatches(target, actorId) {
  const variables = isRecord(target.variables) ? target.variables : {};
  return Object.values(variables).some(
    (value) => Array.isArray(value) && value[0] === 'actorName' && value[1] === actorId,
  );
}

/** @param {Record<string, unknown>} project @param {Readonly<Record<string, any>>} asset */
function projectTarget(project, asset) {
  const targets = Array.isArray(project.targets)
    ? /** @type {Record<string, unknown>[]} */ (project.targets)
    : [];
  if (asset.kind === 'backdrop' || asset.kind === 'sound') {
    const matches = targets.filter((target) => target.isStage === true);
    if (matches.length !== 1) {
      fail('SB3 must contain exactly one Stage target', 'K4-ASSET-CONVERT-PROJECT-001');
    }
    return matches[0];
  }
  const named = targets.filter(
    (target) => target.isStage !== true && projectTargetName(target) === asset.target,
  );
  if (named.length === 1) return named[0];
  const logical = targets.filter(
    (target) => target.isStage !== true && projectActorVariableMatches(target, asset.target),
  );
  if (logical.length === 1) return logical[0];
  const templates = targets.filter(
    (target) => target.isStage !== true && projectActorVariableMatches(target, '_template_'),
  );
  if (templates.length === 1) return templates[0];
  fail(
    `Costume target cannot be resolved exactly once in the SB3: ${String(asset.target)}`,
    'K4-ASSET-CONVERT-PROJECT-001',
  );
}

/** @param {Record<string, unknown>} project @param {Readonly<Record<string, any>>} asset */
function projectAssetSlot(project, asset) {
  const target = projectTarget(project, asset);
  const collectionName = asset.kind === 'sound' ? 'sounds' : 'costumes';
  const collection = target[collectionName] ?? [];
  if (!Array.isArray(collection)) {
    fail(
      `SB3 target ${projectTargetName(target)} has an invalid ${collectionName} collection`,
      'K4-ASSET-CONVERT-PROJECT-001',
    );
  }
  return {target, collectionName, collection: /** @type {Record<string, any>[]} */ (collection)};
}

/** @param {Record<string, Uint8Array>} archive @param {Record<string, unknown>} project @param {string} assetId @param {Readonly<Record<string, any>>} asset */
function readProjectMaterial(archive, project, assetId, asset) {
  const {collection} = projectAssetSlot(project, asset);
  const name = asset.name ?? assetId;
  const matches = collection.filter((candidate) => candidate?.name === name);
  if (matches.length !== 1) {
    fail(
      `Project asset ${assetId} must resolve exactly once by name ${String(name)}`,
      'K4-ASSET-CONVERT-PROJECT-001',
    );
  }
  const descriptor = matches[0];
  const filename =
    typeof descriptor.md5ext === 'string'
      ? descriptor.md5ext
      : `${String(descriptor.assetId)}.${String(descriptor.dataFormat)}`;
  const bytes = archive[filename];
  if (!bytes) {
    fail(`SB3 archive entry is missing for ${assetId}`, 'K4-ASSET-CONVERT-PROJECT-001');
  }
  const contents = Buffer.from(bytes);
  return Object.freeze({
    files: Object.freeze([
      Object.freeze({
        path: filename,
        bytes: contents,
        contentType: contentTypeFor(contents, filename, asset.kind),
      }),
    ]),
  });
}

/** @param {Readonly<Record<string, any>>} snapshot @param {string} assetId @param {Readonly<Record<string, any>>} asset */
function readLocalMaterial(snapshot, assetId, asset) {
  const manifestAssets = /** @type {Readonly<Record<string, any>>[]} */ (snapshot.manifest.assets);
  const manifestAsset = manifestAssets.find((candidate) => candidate.id === assetId);
  if (!manifestAsset || manifestAsset.source.type !== 'file') {
    fail(`Local asset snapshot is missing ${assetId}`, 'K4-ASSET-CONVERT-LOCAL-001');
  }
  const sourceFiles = /** @type {Readonly<Record<string, any>>[]} */ (manifestAsset.source.files);
  const opaquePoseArchive = asset.kind === 'poseModel' && manifestAsset.source.mode === 'archive';
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
      ...(asset.kind === 'poseModel'
        ? {}
        : {contentType: contentTypeFor(bytes, file.path, asset.kind)}),
    });
  });
  return Object.freeze({files: Object.freeze(files)});
}

/** @param {Buffer} bytes */
function pngDimensions(bytes) {
  if (bytes.length < 24) return null;
  return {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
}

/** @param {Buffer} bytes */
function gifDimensions(bytes) {
  if (bytes.length < 10) return null;
  return {width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8)};
}

/** @param {Buffer} bytes */
function jpegDimensions(bytes) {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.length) break;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) break;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7)};
    }
    offset += 2 + length;
  }
  return null;
}

/** @param {Buffer} bytes */
function svgDimensions(bytes) {
  let source;
  try {
    source = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return null;
  }
  const opening = source.match(/<svg\b[^>]*>/iu)?.[0];
  if (!opening) return null;
  /** @param {string} name */
  const numeric = (name) => {
    const match = opening.match(new RegExp(`\\b${name}\\s*=\\s*["']([0-9]+(?:\\.[0-9]+)?)`, 'iu'));
    return match ? Number(match[1]) : null;
  };
  const width = numeric('width');
  const height = numeric('height');
  if (width && height) return {width, height};
  const viewBox = opening.match(/\bviewBox\s*=\s*["']([^"']+)["']/iu)?.[1];
  if (!viewBox) return null;
  const values = viewBox
    .trim()
    .split(/[\s,]+/u)
    .map(Number);
  return values.length === 4 && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0
    ? {width: values[2], height: values[3]}
    : null;
}

/** @param {Buffer} bytes @param {string} contentType */
function imageDimensions(bytes, contentType) {
  const dimensions =
    contentType === 'image/png'
      ? pngDimensions(bytes)
      : contentType === 'image/gif'
        ? gifDimensions(bytes)
        : contentType === 'image/jpeg'
          ? jpegDimensions(bytes)
          : contentType === 'image/svg+xml'
            ? svgDimensions(bytes)
            : null;
  if (
    !dimensions ||
    !Number.isFinite(dimensions.width) ||
    !Number.isFinite(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    fail(
      `Cannot determine image dimensions for project asset Content-Type ${contentType}`,
      'K4-ASSET-CONVERT-METADATA-001',
    );
  }
  return dimensions;
}

/** @param {Buffer} bytes */
function wavMetadata(bytes) {
  let offset = 12;
  let sampleRate = null;
  let blockAlign = null;
  let dataBytes = null;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.subarray(offset, offset + 4).toString('ascii');
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) break;
    if (kind === 'fmt ' && size >= 16) {
      sampleRate = bytes.readUInt32LE(start + 4);
      blockAlign = bytes.readUInt16LE(start + 12);
    } else if (kind === 'data') {
      dataBytes = size;
    }
    offset = start + size + (size % 2);
  }
  if (!sampleRate || !blockAlign || dataBytes === null) return null;
  return {rate: sampleRate, sampleCount: Math.floor(dataBytes / blockAlign)};
}

/** @param {Buffer} bytes */
function oggMetadata(bytes) {
  const identification = bytes.indexOf(Buffer.from([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]));
  if (identification < 0 || identification + 16 > bytes.length) return null;
  const rate = bytes.readUInt32LE(identification + 12);
  let offset = 0;
  let sampleCount = 0;
  while (offset + 27 <= bytes.length) {
    if (bytes.subarray(offset, offset + 4).toString('ascii') !== 'OggS') break;
    const segmentCount = bytes[offset + 26];
    if (offset + 27 + segmentCount > bytes.length) break;
    const bodySize = bytes
      .subarray(offset + 27, offset + 27 + segmentCount)
      .reduce((total, value) => total + value, 0);
    const granule = bytes.readBigUInt64LE(offset + 6);
    if (granule !== 0xffffffffffffffffn && granule <= BigInt(Number.MAX_SAFE_INTEGER)) {
      sampleCount = Number(granule);
    }
    offset += 27 + segmentCount + bodySize;
  }
  return rate > 0 && sampleCount > 0 ? {rate, sampleCount} : null;
}

/** @param {Buffer} bytes */
function mp3Metadata(bytes) {
  let offset = 0;
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3' && bytes.length >= 10) {
    const size =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f);
    offset = 10 + size;
  }
  const bitrates = /** @type {Record<string, number[]>} */ ({
    '1-1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    '1-3': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    '2-1': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  });
  const baseRates = [44_100, 48_000, 32_000];
  let rate = 0;
  let sampleCount = 0;
  while (offset + 4 <= bytes.length) {
    const header = bytes.readUInt32BE(offset);
    if ((header & 0xffe00000) !== 0xffe00000) {
      offset += 1;
      continue;
    }
    const versionBits = (header >>> 19) & 3;
    const layerBits = (header >>> 17) & 3;
    const bitrateIndex = (header >>> 12) & 15;
    const rateIndex = (header >>> 10) & 3;
    if (
      versionBits === 1 ||
      layerBits === 0 ||
      bitrateIndex === 0 ||
      bitrateIndex === 15 ||
      rateIndex === 3
    ) {
      offset += 1;
      continue;
    }
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
    const layer = 4 - layerBits;
    const rateDivisor = version === 1 ? 1 : version === 2 ? 2 : 4;
    const frameRate = baseRates[rateIndex] / rateDivisor;
    const tableVersion = version === 1 ? 1 : 2;
    const bitrate = bitrates[`${tableVersion}-${layer}`]?.[bitrateIndex];
    if (!bitrate) {
      offset += 1;
      continue;
    }
    const padding = (header >>> 9) & 1;
    const frameLength =
      layer === 1
        ? Math.floor(((12 * bitrate * 1000) / frameRate + padding) * 4)
        : Math.floor(
            ((layer === 3 && version !== 1 ? 72 : 144) * bitrate * 1000) / frameRate + padding,
          );
    if (frameLength < 4 || offset + frameLength > bytes.length) break;
    const samples = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
    rate ||= frameRate;
    sampleCount += samples;
    offset += frameLength;
  }
  return rate > 0 && sampleCount > 0 ? {rate, sampleCount} : null;
}

/** @param {Buffer} bytes @param {string} contentType */
function soundMetadata(bytes, contentType) {
  const metadata =
    contentType === 'audio/wav'
      ? wavMetadata(bytes)
      : contentType === 'audio/ogg'
        ? oggMetadata(bytes)
        : contentType === 'audio/mpeg'
          ? mp3Metadata(bytes)
          : null;
  if (!metadata) {
    fail(
      `Cannot determine sound metadata for project asset Content-Type ${contentType}`,
      'K4-ASSET-CONVERT-METADATA-001',
    );
  }
  return metadata;
}

/** @param {Record<string, Uint8Array>} archive @param {Record<string, unknown>} project @param {string} assetId @param {Readonly<Record<string, any>>} asset @param {Readonly<Record<string, any>>} material */
function addProjectAsset(archive, project, assetId, asset, material) {
  if (!projectKinds.has(asset.kind)) {
    fail(
      `Asset kind ${asset.kind} cannot be represented as an SB3 project asset: ${assetId}`,
      'K4-ASSET-CONVERT-UNSUPPORTED-001',
    );
  }
  if (material.files.length !== 1) {
    fail(`Project asset ${assetId} must contain exactly one file`, 'K4-ASSET-CONVERT-PROJECT-001');
  }
  const file = material.files[0];
  const bytes = Buffer.from(file.bytes);
  const contentType = file.contentType ?? contentTypeFor(bytes, file.path, asset.kind);
  const dataFormat = extensionFor(contentType, asset.kind);
  if (!['gif', 'jpeg', 'jpg', 'mp3', 'ogg', 'png', 'svg', 'wav'].includes(dataFormat)) {
    fail(
      `Content-Type ${contentType} is not supported by SB3 project assets`,
      'K4-ASSET-CONVERT-UNSUPPORTED-001',
    );
  }
  const {target, collectionName, collection} = projectAssetSlot(project, asset);
  const name = assetId;
  const existing = collection.filter((candidate) => candidate?.name === name);
  if (existing.length > 0) {
    fail(
      `SB3 project asset name already exists at ${projectTargetName(target)}/${collectionName}: ${name}`,
      'K4-ASSET-CONVERT-PROJECT-COLLISION-001',
    );
  }
  const digest = md5(bytes);
  const filename = `${digest}.${dataFormat}`;
  const archived = archive[filename];
  if (archived && !Buffer.from(archived).equals(bytes)) {
    fail(`SB3 archive filename collision: ${filename}`, 'K4-ASSET-CONVERT-PROJECT-COLLISION-001');
  }
  archive[filename] = new Uint8Array(bytes);
  if (asset.kind === 'sound') {
    const metadata = soundMetadata(bytes, contentType);
    collection.push({
      name,
      assetId: digest,
      dataFormat,
      format: '',
      rate: metadata.rate,
      sampleCount: metadata.sampleCount,
      md5ext: filename,
    });
  } else {
    const dimensions = imageDimensions(bytes, contentType);
    collection.push({
      name,
      bitmapResolution: asset.bitmapResolution ?? 1,
      dataFormat,
      assetId: digest,
      md5ext: filename,
      rotationCenterX: dimensions.width / 2,
      rotationCenterY: dimensions.height / 2,
    });
  }
  target[collectionName] = collection;
  return name;
}

/** @param {Record<string, Uint8Array>} archive @param {Record<string, unknown>} project @param {string} assetId @param {Readonly<Record<string, any>>} asset */
function removeProjectAsset(archive, project, assetId, asset) {
  const {target, collectionName, collection} = projectAssetSlot(project, asset);
  const name = asset.name ?? assetId;
  const matches = collection
    .map((candidate, index) => ({candidate, index}))
    .filter(({candidate}) => candidate?.name === name);
  if (matches.length !== 1) {
    fail(
      `Project asset ${assetId} must resolve exactly once before removal`,
      'K4-ASSET-CONVERT-PROJECT-001',
    );
  }
  const [{candidate, index}] = matches;
  collection.splice(index, 1);
  target[collectionName] = collection;
  const filename =
    typeof candidate.md5ext === 'string'
      ? candidate.md5ext
      : `${String(candidate.assetId)}.${String(candidate.dataFormat)}`;
  const stillReferenced = (Array.isArray(project.targets) ? project.targets : []).some(
    (projectTarget) =>
      ['costumes', 'sounds'].some(
        (key) =>
          Array.isArray(projectTarget?.[key]) &&
          projectTarget[key].some((entry) => {
            const reference =
              typeof entry?.md5ext === 'string'
                ? entry.md5ext
                : `${String(entry?.assetId)}.${String(entry?.dataFormat)}`;
            return reference === filename;
          }),
      ),
  );
  if (!stillReferenced) delete archive[filename];
}

/** @param {Readonly<Record<string, any>>} left @param {Readonly<Record<string, any>>} right @param {string} assetId @param {string} kind */
function assertSameMaterial(left, right, assetId, kind) {
  if (kind === 'poseModel') {
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
  /** @param {Readonly<Record<string, any>>} material */
  const byPath = (material) =>
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

/** @param {string} assetId @param {Readonly<Record<string, any>>} asset @param {Readonly<Record<string, any>>} material */
function createRemotePayload(assetId, asset, material) {
  let bytes;
  let contentType;
  let extension;
  if (asset.kind === 'poseModel') {
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
      /** @type {Record<string, Uint8Array>} */
      const entries = {};
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

/** @param {unknown} rawAsset @param {Readonly<Record<string, any>>} asset */
function editableAsset(rawAsset, asset) {
  const result = /** @type {Record<string, any>} */ (
    isRecord(rawAsset) ? structuredClone(rawAsset) : {kind: asset.kind}
  );
  result.kind = asset.kind;
  if (asset.kind === 'costume') result.target = asset.target;
  for (const key of ['delivery', 'file', 'name', 'source']) delete result[key];
  return result;
}

/** @param {Map<string, Buffer>} files @param {string} relativePath @param {Buffer} bytes */
function addOutputFile(files, relativePath, bytes) {
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

/** @param {Map<string, Buffer>} files @param {string} relativePath @param {Buffer} bytes */
function addSharedOutputFile(files, relativePath, bytes) {
  const existing = files.get(relativePath);
  if (!existing) {
    addOutputFile(files, relativePath, bytes);
    return;
  }
  if (!existing.equals(bytes)) {
    fail(`Generated output path collides: ${relativePath}`, 'K4-ASSET-CONVERT-OUTPUT-001');
  }
}

/** @param {string} projectRoot @param {string} outputDirectory @param {Map<string, Buffer>} files @param {(candidateDirectory: string) => Promise<void>} validate @param {((candidateDirectory: string) => Promise<void>) | undefined} [beforeCommit] */
async function installOutputDirectory(projectRoot, outputDirectory, files, validate, beforeCommit) {
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

/**
 * Convert selected authoring assets and save a new YAML/SB3 working pair.
 *
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {string} options.sourceManifest
 * @param {string} options.baseSb3
 * @param {string} options.outputDirectory
 * @param {'local' | 'project' | 'remote'} options.to
 * @param {string[]} [options.assets]
 * @param {string} [options.remoteMap]
 * @param {string} [options.rsyncDestination]
 * @param {string} [options.remoteBaseUrl]
 * @param {number} [options.rsyncSshPort]
 * @param {number} [options.rsyncTimeoutMs]
 * @param {string} [options.outputName]
 * @param {{parse(source: string, options?: {sourceId?: string}): Readonly<Record<string, any>>}} options.sourceFrontend
 * @param {number} options.maxSourceBytes
 * @param {number} options.maxSourceManifestBytes
 * @param {number} options.maxRemoteMapBytes
 * @param {number} options.maxBaseSb3Bytes
 * @param {number} options.maxAssetFileBytes
 * @param {number} options.maxAssetFiles
 * @param {number} options.maxTotalAssetBytes
 * @param {number} options.timeoutMs
 * @param {number} options.maxRedirects
 * @param {string[]} options.allowedHosts
 * @param {typeof fetch} [options.fetchImplementation]
 * @param {{digest: Function}} [options.subtleCrypto]
 * @param {(command: {executable: string, arguments: string[], timeoutMs: number}) => Promise<void>} [options.runRsync]
 */
export async function convertDsl4ProjectAssets(options) {
  if (!isRecord(options)) throw new TypeError('asset conversion options are required');
  if (!supportedTargets.has(/** @type {string} */ (options.to))) {
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
  /** @param {string} inputPath @param {string} label */
  const canonicalProjectPath = (inputPath, label) => {
    const requestedPath = path.resolve(inputPath);
    if (!isWithin(requestedRoot, requestedPath)) {
      fail(`${label} must remain inside the project root`, 'K4-ASSET-CONVERT-PATH-001');
    }
    return path.resolve(canonicalRoot, path.relative(requestedRoot, requestedPath));
  };
  const sourceManifestPath = canonicalProjectPath(String(options.sourceManifest), 'sourceManifest');
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

  const manifestInput = await loadDsl4ProjectJson({
    projectRoot: canonicalRoot,
    inputPath: sourceManifestPath,
    maxBytes: maxSourceManifestBytes,
    label: 'source manifest',
    code: 'K4-SOURCE-MANIFEST-001',
  });
  const inputSourceManifest = validateDsl4ExternalSourceManifest(manifestInput);
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
  const storyDocument = /** @type {Readonly<Record<string, any>>} */ (parsed.storyDocument);
  const storyAssets = /** @type {Readonly<Record<string, Readonly<Record<string, any>>>>} */ (
    storyDocument.assets ?? {}
  );
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

  /** @type {Readonly<Record<string, Readonly<Record<string, any>>>>} */
  let remoteMap = Object.freeze({});
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
  /** @param {Readonly<Record<string, any>>} material */
  function accountMaterial(material) {
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
  /** @type {Map<string, Promise<Readonly<Record<string, any>>>>} */
  const remoteMaterials = new Map();
  /** @param {string} assetId @param {Readonly<Record<string, any>>} asset @param {Readonly<Record<string, any>>} remote */
  async function readRemoteMaterial(assetId, asset, remote) {
    const sourceValue = validateRemoteSource(remote, {
      allowBare: asset.kind !== 'poseModel',
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
        const response = await fetchDsl4AssetRemote(sourceValue.url, {
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
        if (
          sourceValue.integrity !== undefined &&
          (`sha256-${sha256(response.bytes)}` !== sourceValue.integrity ||
            response.bytes.length !== sourceValue.size ||
            response.contentType !== sourceValue.contentType)
        ) {
          fail(
            `Remote bytes do not match declared metadata for ${assetId}`,
            'K4-ASSET-CONVERT-REMOTE-INTEGRITY-001',
          );
        }
        if (asset.kind === 'poseModel') {
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

  /** @type {Map<string, Readonly<Record<string, any>>>} */
  const origins = new Map();
  /** @param {string} assetId */
  async function originMaterial(assetId) {
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
  const raw = /** @type {Record<string, any>} */ (document.toJS());
  const rawAssets = isRecord(raw.assets) ? raw.assets : {};
  const outputFiles = new Map();
  /** @type {Map<string, Buffer>} */
  const remoteUploads = new Map();
  /** @type {{assetId: string, asset: Readonly<Record<string, any>>, origin: Readonly<Record<string, any>>, source: Readonly<Record<string, any>>}[]} */
  const rsyncVerifications = [];
  let remoteUploadBytes = 0;
  const selectedAssetIds = new Set(selectedIds);
  /** @type {Record<string, string>} */
  const converted = {};
  /** @type {Record<string, string>} */
  const preservedOriginals = {};
  /** @type {Map<string, {assetId: string, asset: Readonly<Record<string, any>>}>} */
  const projectRemovals = new Map();

  /** @param {string} assetId @param {Readonly<Record<string, any>>} asset */
  function scheduleProjectRemoval(assetId, asset) {
    const target = projectTarget(project, asset);
    const collection = asset.kind === 'sound' ? 'sounds' : 'costumes';
    const key = `${projectTargetName(target)}\0${collection}\0${String(asset.name ?? assetId)}`;
    projectRemovals.set(key, {assetId, asset});
  }

  /** @param {string} assetId @param {Readonly<Record<string, any>>} asset @param {'local' | 'remote'} current @param {Readonly<Record<string, any>>} material */
  function preserveProjectImageOrigin(assetId, asset, current, material) {
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
      if (asset.kind === 'poseModel') {
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
          url: new URL(encodeURIComponent(payload.filename), /** @type {URL} */ (remoteBaseUrl))
            .href,
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
      const remoteSource = /** @type {Readonly<Record<string, any>>} */ (mapped);
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
    for (const file of /** @type {Readonly<Record<string, any>>[]} */ (snapshotSource.files)) {
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
  const verifiedAssets = /** @type {Readonly<Record<string, Readonly<Record<string, any>>>>} */ (
    verified.storyDocument.assets ?? {}
  );
  for (const {assetId, asset} of projectRemovals.values()) {
    const name = asset.name ?? assetId;
    const retained = Object.entries(verifiedAssets).some(([candidateId, candidate]) => {
      if (candidate.delivery === 'remote' || typeof candidate.file === 'string') return false;
      if (candidate.kind !== asset.kind || (candidate.name ?? candidateId) !== name) return false;
      return candidate.kind !== 'costume' || candidate.target === asset.target;
    });
    if (!retained) removeProjectAsset(archive, project, assetId, asset);
  }
  const name = outputName(options.outputName, sourceStem(source.descriptor.displayName));
  const sourceFilename = `${name}.k4.yml`;
  const sb3Filename = `${name}.sb3`;
  const sourceManifestFilename = 'project.source.json';
  const outputSourceManifest = validateDsl4ExternalSourceManifest({
    ...inputSourceManifest,
    path: sourceFilename,
  });
  const serializedSourceManifest = `${JSON.stringify(outputSourceManifest, null, 2)}\n`;
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
      const candidateManifest = JSON.parse(
        await readFile(path.join(candidateDirectory, sourceManifestFilename), 'utf8'),
      );
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
                  /** @type {string} */ (rsyncDestination),
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
