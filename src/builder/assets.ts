import {lstat, readFile, realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {defaultMaxAssetBytes, defaultMaxRedirects, defaultRequestTimeoutMs} from './constants.js';
import {Sb3BuilderError, toAssetError} from './errors.js';
import type {NormalizedAsset} from './manifest.js';
import {sha256} from './hash.js';

export interface ResolvedAsset {
  contents: Buffer;
  entry: NormalizedAsset;
  resolvedUri: string;
}

function isWithin(ancestor: string, candidate: string) {
  const relative = path.relative(ancestor, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function fileUriToPath(uri: string, baseDirectory: string) {
  if (uri.startsWith('file://')) {
    const parsed = new URL(uri);
    if (parsed.hostname && parsed.hostname !== 'localhost') {
      throw new Error(`Remote file URI hosts are not supported: ${parsed.hostname}`);
    }
    return fileURLToPath(parsed);
  }
  const encodedPath = uri.slice('file:'.length);
  if (!encodedPath) throw new Error('file: URI has no path.');
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch (error) {
    throw new Error(
      `file: URI has invalid percent encoding: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (decodedPath.includes('\0')) throw new Error('file: URI contains a NUL byte.');
  return path.resolve(baseDirectory, decodedPath);
}

function normalizeContentType(contentType: string) {
  return contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

async function readResponseBody(response: Response, maximumBytes: number) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isInteger(parsedLength) || parsedLength < 0) {
      throw new Error(`Invalid Content-Length response header: ${contentLength}`);
    }
    if (parsedLength > maximumBytes) {
      throw new Error(`Remote asset exceeds the ${maximumBytes} byte limit.`);
    }
  }
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel('asset size limit exceeded');
        throw new Error(`Remote asset exceeds the ${maximumBytes} byte limit.`);
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function fetchAsset(
  uri: string,
  options: {
    allowHttp: boolean;
    fetchImplementation: typeof fetch;
    maximumBytes: number;
    maxRedirects: number;
    timeoutMs: number;
  },
) {
  let currentUrl = new URL(uri);
  for (let redirects = 0; ; redirects += 1) {
    if (currentUrl.protocol === 'http:' && !options.allowHttp) {
      throw new Error(`Plain HTTP is disabled: ${currentUrl.href}`);
    }
    if (currentUrl.protocol !== 'https:' && currentUrl.protocol !== 'http:') {
      throw new Error(`Redirected to unsupported protocol: ${currentUrl.protocol}`);
    }
    let response;
    try {
      response = await options.fetchImplementation(currentUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      throw new Error(
        `Request failed for ${currentUrl.href}: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      if (redirects >= options.maxRedirects) {
        throw new Error(`Redirect limit exceeded (${options.maxRedirects}).`);
      }
      const location = response.headers.get('location');
      if (!location) throw new Error(`HTTP ${response.status} response has no Location header.`);
      currentUrl = new URL(location, currentUrl);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    return {
      contents: await readResponseBody(response, options.maximumBytes),
      contentType: normalizeContentType(response.headers.get('content-type') ?? ''),
      finalUri: currentUrl.href,
    };
  }
}

async function resolveAsset(
  entry: ReturnType<typeof import('./manifest.js').validateAssetManifest>['assets'][number],
  options: {
    allowedRoots: string[];
    allowHttp: boolean;
    baseDirectory: string;
    fetchImplementation: typeof fetch;
    maximumBytes: number;
    maxRedirects: number;
    timeoutMs: number;
  },
) {
  try {
    let contents;
    let actualContentType = entry.contentType;
    let resolvedUri = entry.uri;
    if (entry.uri.startsWith('file:')) {
      const requestedPath = fileUriToPath(entry.uri, options.baseDirectory);
      const canonicalPath = await realpath(requestedPath);
      if (!options.allowedRoots.some((root) => isWithin(root, canonicalPath))) {
        throw new Error(`file: path escapes every allowed root: ${requestedPath}`);
      }
      const stats = await lstat(canonicalPath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`file: asset is not a regular file: ${requestedPath}`);
      }
      if (stats.size > options.maximumBytes) {
        throw new Error(`File asset exceeds the ${options.maximumBytes} byte limit.`);
      }
      contents = await readFile(canonicalPath);
      resolvedUri = `file:${path.relative(options.baseDirectory, canonicalPath).split(path.sep).join('/')}`;
    } else {
      const fetched = await fetchAsset(entry.uri, options);
      contents = fetched.contents;
      actualContentType = fetched.contentType;
      resolvedUri = fetched.finalUri;
    }
    if (contents.length !== entry.size) {
      throw new Error(`Size mismatch: expected ${entry.size} bytes, received ${contents.length}.`);
    }
    if (actualContentType !== entry.contentType) {
      throw new Error(
        `Content-Type mismatch: expected ${entry.contentType}, received ${actualContentType || '(missing)'}.`,
      );
    }
    const actualSha256 = sha256(contents);
    if (actualSha256 !== entry.sha256) {
      throw new Error(`SHA-256 mismatch: expected ${entry.sha256}, received ${actualSha256}.`);
    }
    return {contents: Buffer.from(contents), entry, resolvedUri};
  } catch (error) {
    throw toAssetError(error, {assetName: entry.name, inputUri: entry.uri, stage: 'resolve'});
  }
}

export async function resolveAssets(
  manifest: ReturnType<typeof import('./manifest.js').validateAssetManifest>,
  baseDirectory: string,
  options: {
    allowedFileRoots?: string[];
    allowHttp?: boolean;
    fetchImplementation?: typeof fetch;
    maxAssetBytes?: number;
    maxRedirects?: number;
    requestTimeoutMs?: number;
  } = {},
) {
  const roots = options.allowedFileRoots?.length ? options.allowedFileRoots : [baseDirectory];
  const allowedRoots = await Promise.all(
    roots.map(async (root) => {
      const canonicalRoot = await realpath(path.resolve(root));
      const stats = await lstat(canonicalRoot);
      if (!stats.isDirectory()) {
        throw new Sb3BuilderError(`Allowed file root is not a directory: ${root}`, {
          stage: 'resolve',
        });
      }
      return canonicalRoot;
    }),
  );
  const maximumBytes = options.maxAssetBytes ?? defaultMaxAssetBytes;
  const timeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs;
  const maxRedirects = options.maxRedirects ?? defaultMaxRedirects;
  if (!Number.isInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Sb3BuilderError('maxAssetBytes must be a positive integer.', {stage: 'resolve'});
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Sb3BuilderError('requestTimeoutMs must be a positive integer.', {stage: 'resolve'});
  }
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new Sb3BuilderError('maxRedirects must be a non-negative integer.', {stage: 'resolve'});
  }
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw new Sb3BuilderError('No fetch implementation is available.', {stage: 'resolve'});
  }
  return Promise.all(
    manifest.assets.map((entry) =>
      resolveAsset(entry, {
        allowedRoots,
        allowHttp: options.allowHttp ?? false,
        baseDirectory,
        fetchImplementation,
        maximumBytes,
        maxRedirects,
        timeoutMs,
      }),
    ),
  ) as Promise<ResolvedAsset[]>;
}
