import {createHash, randomBytes as cryptoRandomBytes} from 'node:crypto';
import {isIP} from 'node:net';
import path from 'node:path';

import {deepFreeze} from '../dsl4/story-document.js';
import {Sb3BuilderError} from './errors.js';
import {validateDsl4ExternalSourceManifest} from './dsl4-external-source.js';

export const dsl4PreviewTransportTokenBytes = 32;
export const dsl4PreviewTransportLimits = deepFreeze({
  maximumTokenTtlMs: 5 * 60 * 1_000,
  maximumTokenRecords: 64,
});

const bindHosts = new Set(['127.0.0.1', '::1']);
const disconnectReasons = new Set(['graceful-stop', 'host-crash', 'transport-close']);
const requestKeys = new Set(['origin', 'remoteAddress', 'token']);
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const maximumTokenAttempts = 8;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} message @param {string} code @param {unknown} [cause] @returns {never} */
function fail(message, code, cause) {
  throw new Sb3BuilderError(message, {stage: 'dsl4-preview-transport', code, cause});
}

/** @param {unknown} value @param {string} name */
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} name */
function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string without NUL`);
  }
  return value;
}

/** @param {unknown} value @param {string} name @param {string} code */
function requestString(value, name, code) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail(`Preview request ${name} is invalid`, code);
  }
  return value;
}

/** @param {Record<string, unknown>} value @param {ReadonlySet<string>} keys @param {string} name */
function exactKeys(value, keys, name) {
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.has(key));
  const missing = [...keys].filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    fail(
      `${name} keys are invalid (unknown: ${unknown.sort().join(', ') || 'none'}; missing: ${missing.sort().join(', ') || 'none'})`,
      'K4-PREVIEW-TRANSPORT-SCHEMA',
    );
  }
}

/** @param {string} address */
function isLoopbackAddress(address) {
  const lower = address.toLowerCase();
  if (isIP(lower) === 4) return lower.split('.')[0] === '127';
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  if (!lower.startsWith('::ffff:')) return false;
  const mapped = lower.slice('::ffff:'.length);
  return isIP(mapped) === 4 && mapped.split('.')[0] === '127';
}

/** @param {unknown} value */
function bindHost(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail('Preview bindHost is invalid', 'K4-PREVIEW-TRANSPORT-BIND');
  }
  const host = value;
  if (!bindHosts.has(host)) {
    fail(
      'Preview bindHost must be the literal 127.0.0.1 or ::1 loopback address',
      'K4-PREVIEW-TRANSPORT-BIND',
    );
  }
  return host;
}

/** @param {unknown} value @param {string} configuredHost @param {number} configuredPort */
function previewOrigin(value, configuredHost, configuredPort) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail('Preview origin is invalid', 'K4-PREVIEW-TRANSPORT-ORIGIN');
  }
  const input = value;
  let parsed;
  try {
    parsed = new URL(input);
  } catch (error) {
    fail('Preview origin is not a valid absolute origin', 'K4-PREVIEW-TRANSPORT-ORIGIN', error);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '');
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'http:'
      ? 80
      : parsed.protocol === 'https:'
        ? 443
        : 0;
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    input !== parsed.origin ||
    hostname !== configuredHost ||
    port !== configuredPort
  ) {
    fail(
      'Preview origin must exactly match the configured loopback host and port',
      'K4-PREVIEW-TRANSPORT-ORIGIN',
    );
  }
  return parsed.origin;
}

/** @param {unknown} value */
function absoluteProjectRoot(value) {
  const root = nonEmptyString(value, 'projectRoot');
  if (!path.isAbsolute(root) || path.normalize(root) !== root) {
    throw new TypeError('projectRoot must be a normalized absolute path');
  }
  if (path.parse(root).root === root) {
    throw new TypeError('projectRoot must not be a filesystem root');
  }
  return root;
}

/** @param {string} token */
function tokenDigest(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Create an in-memory authorization and disconnect policy for a local development preview host.
 *
 * The policy does not open a socket and is not connected to production artifacts. A host must
 * explicitly use it before forwarding any message or source read to the preview protocol.
 *
 * @param {object} options
 * @param {'127.0.0.1' | '::1'} options.bindHost
 * @param {number} options.port
 * @param {string} options.origin
 * @param {string} options.projectRoot
 * @param {unknown} options.sourceManifest
 * @param {number} options.tokenTtlMs
 * @param {number} options.maxTokenRecords
 * @param {(event: Readonly<{version: 1, reason: 'graceful-stop' | 'host-crash' | 'transport-close'}>) => unknown | Promise<unknown>} options.onDisconnect
 * @param {(size: number) => Uint8Array} [options.randomBytes]
 * @param {() => number} [options.now]
 */
export function createDsl4PreviewTransportPolicy({
  bindHost: inputBindHost,
  port: inputPort,
  origin: inputOrigin,
  projectRoot: inputProjectRoot,
  sourceManifest: inputSourceManifest,
  tokenTtlMs: inputTokenTtlMs,
  maxTokenRecords: inputMaxTokenRecords,
  onDisconnect,
  randomBytes = cryptoRandomBytes,
  now = Date.now,
}) {
  const host = bindHost(inputBindHost);
  const port = positiveInteger(inputPort, 'port');
  if (port > 65_535) throw new TypeError('port must be <= 65535');
  const origin = previewOrigin(inputOrigin, host, port);
  const projectRoot = absoluteProjectRoot(inputProjectRoot);
  const sourceManifest = validateDsl4ExternalSourceManifest(inputSourceManifest);
  const tokenTtlMs = positiveInteger(inputTokenTtlMs, 'tokenTtlMs');
  const maxTokenRecords = positiveInteger(inputMaxTokenRecords, 'maxTokenRecords');
  if (tokenTtlMs > dsl4PreviewTransportLimits.maximumTokenTtlMs) {
    throw new TypeError(`tokenTtlMs must be <= ${dsl4PreviewTransportLimits.maximumTokenTtlMs}`);
  }
  if (maxTokenRecords > dsl4PreviewTransportLimits.maximumTokenRecords) {
    throw new TypeError(
      `maxTokenRecords must be <= ${dsl4PreviewTransportLimits.maximumTokenRecords}`,
    );
  }
  if (typeof onDisconnect !== 'function') throw new TypeError('onDisconnect must be a function');
  if (typeof randomBytes !== 'function') throw new TypeError('randomBytes must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  /** @type {Map<string, {state: 'pending' | 'consumed', expiresAt: number}>} */
  const tokenRecords = new Map();
  /** @type {{connectedAt: number, disconnected: boolean, disconnectPromise: Promise<Readonly<Record<string, unknown>>> | null, lastReason: string | null} | null} */
  let activeConnection = null;
  /** @type {Set<Promise<Readonly<Record<string, unknown>>>>} */
  const inFlightDisconnects = new Set();
  let disposed = false;
  let disconnectFailed = false;
  /** @type {Promise<Readonly<Record<string, unknown>>> | null} */
  let disposePromise = null;
  let lastNow = -1;

  function currentTime() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || value < lastNow) {
      fail(
        'Preview transport clock must return monotonic non-negative safe integers',
        'K4-PREVIEW-TRANSPORT-CLOCK',
      );
    }
    lastNow = value;
    return value;
  }

  /** @param {number} timestamp */
  function purgeExpired(timestamp) {
    for (const [digest, record] of tokenRecords) {
      if (timestamp >= record.expiresAt) tokenRecords.delete(digest);
    }
  }

  function assertAvailable() {
    if (disposed) {
      fail('Preview transport policy is disposed', 'K4-PREVIEW-TRANSPORT-DISPOSED');
    }
  }

  function assertReady() {
    assertAvailable();
    if (disconnectFailed) {
      fail(
        'Preview transport policy cannot continue after a disconnect callback failure',
        'K4-PREVIEW-TRANSPORT-DISCONNECT',
      );
    }
    if (inFlightDisconnects.size > 0) {
      fail(
        'Preview transport is still completing a disconnect callback',
        'K4-PREVIEW-TRANSPORT-DISCONNECTING',
      );
    }
  }

  function snapshot() {
    let pendingTokens = 0;
    let consumedTokens = 0;
    for (const record of tokenRecords.values()) {
      if (record.state === 'pending') pendingTokens += 1;
      else consumedTokens += 1;
    }
    return deepFreeze({
      version: 1,
      connected: activeConnection !== null && !activeConnection.disconnected,
      connectedAt:
        activeConnection !== null && !activeConnection.disconnected
          ? activeConnection.connectedAt
          : null,
      pendingTokens,
      consumedTokens,
      disposed,
    });
  }

  /** @param {{connectedAt: number, disconnected: boolean, disconnectPromise: Promise<Readonly<Record<string, unknown>>> | null, lastReason: string | null}} record */
  function connectionSnapshot(record) {
    return deepFreeze({
      version: 1,
      connected: !record.disconnected,
      connectedAt: record.connectedAt,
      lastReason: record.lastReason,
    });
  }

  /**
   * @param {{connectedAt: number, disconnected: boolean, disconnectPromise: Promise<Readonly<Record<string, unknown>>> | null, lastReason: string | null}} record
   * @param {unknown} inputReason
   */
  function disconnectRecord(record, inputReason) {
    if (record.disconnectPromise) return record.disconnectPromise;
    if (typeof inputReason !== 'string' || !disconnectReasons.has(inputReason)) {
      fail('Preview disconnect reason is invalid', 'K4-PREVIEW-TRANSPORT-SCHEMA');
    }
    record.disconnected = true;
    const reason = /** @type {'graceful-stop' | 'host-crash' | 'transport-close'} */ (inputReason);
    record.lastReason = reason;
    if (activeConnection === record) activeConnection = null;
    const event = deepFreeze({version: /** @type {1} */ (1), reason});
    const disconnectPromise = Promise.resolve().then(async () => {
      try {
        await onDisconnect(event);
      } catch (error) {
        disconnectFailed = true;
        fail(
          'Preview protocol disconnect callback failed',
          'K4-PREVIEW-TRANSPORT-DISCONNECT',
          error,
        );
      }
      return connectionSnapshot(record);
    });
    record.disconnectPromise = disconnectPromise;
    inFlightDisconnects.add(disconnectPromise);
    disconnectPromise.then(
      () => inFlightDisconnects.delete(disconnectPromise),
      () => inFlightDisconnects.delete(disconnectPromise),
    );
    return disconnectPromise;
  }

  function issueToken() {
    assertReady();
    const issuedAt = currentTime();
    purgeExpired(issuedAt);
    if (tokenRecords.size >= maxTokenRecords) {
      fail('Preview transport token record limit was exceeded', 'K4-PREVIEW-TRANSPORT-TOKEN-LIMIT');
    }
    if (issuedAt > Number.MAX_SAFE_INTEGER - tokenTtlMs) {
      fail('Preview transport token expiry overflowed', 'K4-PREVIEW-TRANSPORT-CLOCK');
    }
    for (let attempt = 0; attempt < maximumTokenAttempts; attempt += 1) {
      let generated;
      try {
        generated = randomBytes(dsl4PreviewTransportTokenBytes);
      } catch (error) {
        fail('Preview transport token generation failed', 'K4-PREVIEW-TRANSPORT-TOKEN', error);
      }
      if (
        !(generated instanceof Uint8Array) ||
        generated.length !== dsl4PreviewTransportTokenBytes
      ) {
        fail('Preview transport randomBytes returned invalid data', 'K4-PREVIEW-TRANSPORT-TOKEN');
      }
      const token = Buffer.from(generated).toString('base64url');
      const digest = tokenDigest(token);
      if (tokenRecords.has(digest)) continue;
      const expiresAt = issuedAt + tokenTtlMs;
      tokenRecords.set(digest, {state: 'pending', expiresAt});
      return deepFreeze({version: 1, token, expiresAt});
    }
    fail(
      'Preview transport token generation exhausted its collision limit',
      'K4-PREVIEW-TRANSPORT-TOKEN-COLLISION',
    );
  }

  /** @param {unknown} input */
  function connect(input) {
    assertReady();
    if (activeConnection && !activeConnection.disconnected) {
      fail('Preview transport already has an active connection', 'K4-PREVIEW-TRANSPORT-ACTIVE');
    }
    if (!isRecord(input)) {
      fail('Preview transport request must be an object', 'K4-PREVIEW-TRANSPORT-SCHEMA');
    }
    exactKeys(input, requestKeys, 'preview transport request');
    if (input.origin !== origin) {
      fail('Preview request Origin is not allowed', 'K4-PREVIEW-TRANSPORT-ORIGIN');
    }
    const remoteAddress = requestString(
      input.remoteAddress,
      'remoteAddress',
      'K4-PREVIEW-TRANSPORT-REMOTE',
    );
    if (!isLoopbackAddress(remoteAddress)) {
      fail('Preview request is not from a loopback address', 'K4-PREVIEW-TRANSPORT-REMOTE');
    }
    const token = requestString(input.token, 'token', 'K4-PREVIEW-TRANSPORT-TOKEN');
    if (!tokenPattern.test(token)) {
      fail('Preview transport token is invalid', 'K4-PREVIEW-TRANSPORT-TOKEN');
    }
    const authorizedAt = currentTime();
    const digest = tokenDigest(token);
    const tokenRecord = tokenRecords.get(digest);
    if (!tokenRecord) {
      fail('Preview transport token is invalid', 'K4-PREVIEW-TRANSPORT-TOKEN');
    }
    if (authorizedAt >= tokenRecord.expiresAt) {
      tokenRecords.delete(digest);
      fail('Preview transport token expired', 'K4-PREVIEW-TRANSPORT-TOKEN-EXPIRED');
    }
    if (tokenRecord.state === 'consumed') {
      fail('Preview transport token was already consumed', 'K4-PREVIEW-TRANSPORT-TOKEN-REUSED');
    }
    tokenRecord.state = 'consumed';
    const record = {
      connectedAt: authorizedAt,
      disconnected: false,
      disconnectPromise: null,
      lastReason: null,
    };
    activeConnection = record;

    function requireConnection() {
      if (disposed || record.disconnected || activeConnection !== record) {
        fail('Preview transport connection is disconnected', 'K4-PREVIEW-TRANSPORT-DISCONNECTED');
      }
    }

    /** @param {unknown} requestedPath */
    function authorizeSourceRead(requestedPath) {
      requireConnection();
      if (requestedPath !== sourceManifest.path) {
        fail(
          'Preview source read is outside the manifest-authorized path',
          'K4-PREVIEW-TRANSPORT-PATH',
        );
      }
      return deepFreeze({projectRoot, manifest: sourceManifest});
    }

    /** @param {unknown} inputReason */
    function disconnect(inputReason) {
      return disconnectRecord(record, inputReason);
    }

    return Object.freeze({
      authorizeSourceRead,
      disconnect,
      getState: () => connectionSnapshot(record),
    });
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    disposed = true;
    const connection = activeConnection;
    activeConnection = null;
    tokenRecords.clear();
    disposePromise = (async () => {
      if (connection && !connection.disconnected) {
        disconnectRecord(connection, 'graceful-stop');
      }
      await Promise.all([...inFlightDisconnects]);
      return snapshot();
    })();
    return disposePromise;
  }

  return Object.freeze({issueToken, connect, dispose, getState: snapshot});
}
