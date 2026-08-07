import {deepFreeze} from './story-document.js';

export const dsl4AssetReloadProtocolCapabilities = deepFreeze([
  'asset.commit.v1',
  'asset.defer.v1',
  'asset.diagnostics.v1',
  'asset.stage.v1',
]);

export class Dsl4AssetReloadProtocolError extends TypeError {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'Dsl4AssetReloadProtocolError';
    this.code = code;
  }
}

/** @param {string} code @param {string} message @returns {never} */
function fail(code, message) {
  throw new Dsl4AssetReloadProtocolError(code, message);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function validateTransaction(value) {
  if (
    !isRecord(value) ||
    typeof value.stage !== 'function' ||
    typeof value.failClosed !== 'function' ||
    typeof value.commit !== 'function' ||
    typeof value.defer !== 'function' ||
    typeof value.getState !== 'function' ||
    typeof value.whenIdle !== 'function'
  ) {
    throw new TypeError('asset protocol requires an asset reload transaction');
  }
  return /** @type {Record<string, Function>} */ (value);
}

/** @param {unknown} value */
function sessionId(value) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._-]+$/u.test(value)
  ) {
    throw new TypeError('asset protocol sessionId must be 1-128 URL-safe characters');
  }
  return value;
}

/** @param {unknown} value */
function capabilities(value) {
  if (!Array.isArray(value)) throw new TypeError('asset protocol capabilities must be an array');
  const result = value.map((capability) => {
    if (typeof capability !== 'string' || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(capability)) {
      throw new TypeError('asset protocol capability is invalid');
    }
    return capability;
  });
  if (new Set(result).size !== result.length) {
    throw new TypeError('asset protocol capabilities must not contain duplicates');
  }
  return new Set(result);
}

/** @param {unknown} value @param {string} type @param {ReadonlyArray<string>} keys */
function message(value, type, keys) {
  if (!isRecord(value) || value.type !== type) {
    fail('K4-ASSET-PROTOCOL-SCHEMA', `Expected ${type} message`);
  }
  const allowed = new Set(['type', ...keys]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail('K4-ASSET-PROTOCOL-SCHEMA', 'Asset protocol message has an unknown key');
  }
  return value;
}

/**
 * Bind optional asset stage/commit/defer messages to one preview session. Missing or partial
 * capability negotiation explicitly rejects the candidate into the full-rebuild path.
 *
 * @param {object} options
 * @param {Record<string, Function>} options.transaction
 * @param {string} options.sessionId
 * @param {ReadonlyArray<string>} [options.negotiatedCapabilities]
 */
export function createDsl4AssetReloadProtocolSession({
  transaction: inputTransaction,
  sessionId: inputSessionId,
  negotiatedCapabilities = [],
}) {
  const transaction = validateTransaction(inputTransaction);
  const expectedSessionId = sessionId(inputSessionId);
  const negotiated = capabilities(negotiatedCapabilities);
  const enabled = dsl4AssetReloadProtocolCapabilities.every((capability) =>
    negotiated.has(capability),
  );
  let connected = true;
  /** @type {number | null} */
  let candidateRevision = null;
  let operationQueue = Promise.resolve();

  /** @param {() => unknown | Promise<unknown>} operation */
  function enqueue(operation) {
    const result = operationQueue.then(operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** @param {unknown} value */
  function requireSession(value) {
    if (!connected) fail('K4-ASSET-PROTOCOL-DISCONNECTED', 'Asset protocol is disconnected');
    if (value !== expectedSessionId) {
      fail('K4-ASSET-PROTOCOL-SESSION', 'Asset message belongs to a stale preview session');
    }
  }

  /** @param {unknown} input */
  function stage(input) {
    return enqueue(async () => {
      const request = message(input, 'preview.asset.stage', ['sessionId', 'summary']);
      requireSession(request.sessionId);
      const state = enabled
        ? await transaction.stage(request.summary)
        : await transaction.failClosed(request.summary);
      candidateRevision = state.candidate?.revision ?? null;
      return deepFreeze({
        type: enabled ? 'preview.asset.staged' : 'preview.asset.fallback',
        sessionId: expectedSessionId,
        revision: state.latestRevision,
        status: state.status,
        candidate: state.candidate,
        diagnostic: state.diagnostic,
      });
    });
  }

  /** @param {unknown} input */
  function commit(input) {
    return enqueue(async () => {
      const request = message(input, 'preview.asset.commit', ['sessionId', 'revision', 'request']);
      requireSession(request.sessionId);
      if (!enabled) {
        fail('K4-ASSET-PROTOCOL-CAPABILITY', 'Asset commit capabilities were not negotiated');
      }
      if (request.revision !== candidateRevision) {
        fail('K4-ASSET-STALE-001', 'Asset protocol candidate is stale');
      }
      const state = await transaction.commit(request.revision, request.request ?? {});
      candidateRevision = null;
      return deepFreeze({
        type: state.status === 'active' ? 'preview.asset.committed' : 'preview.asset.failed',
        sessionId: expectedSessionId,
        revision: request.revision,
        status: state.status,
        active: state.active,
        diagnostic: state.diagnostic,
      });
    });
  }

  /** @param {unknown} input */
  function defer(input) {
    return enqueue(async () => {
      const request = message(input, 'preview.asset.defer', ['sessionId', 'revision']);
      requireSession(request.sessionId);
      if (!enabled || !negotiated.has('asset.defer.v1')) {
        fail('K4-ASSET-PROTOCOL-CAPABILITY', 'Asset defer capability was not negotiated');
      }
      if (request.revision !== candidateRevision) {
        fail('K4-ASSET-STALE-001', 'Asset protocol candidate is stale');
      }
      const state = await transaction.defer(request.revision);
      candidateRevision = null;
      return deepFreeze({
        type: 'preview.asset.deferred',
        sessionId: expectedSessionId,
        revision: request.revision,
        status: state.status,
      });
    });
  }

  function disconnect() {
    return enqueue(async () => {
      if (!connected) return snapshot();
      if (candidateRevision !== null) await transaction.defer(candidateRevision);
      candidateRevision = null;
      connected = false;
      return snapshot();
    });
  }

  function snapshot() {
    return deepFreeze({
      version: 1,
      connected,
      sessionId: expectedSessionId,
      enabled,
      capabilities: [...negotiated].sort(),
      candidateRevision,
      transaction: transaction.getState(),
    });
  }

  return Object.freeze({
    stage,
    commit,
    defer,
    disconnect,
    getState: snapshot,
    async whenIdle() {
      await operationQueue;
      await transaction.whenIdle();
      return snapshot();
    },
  });
}
