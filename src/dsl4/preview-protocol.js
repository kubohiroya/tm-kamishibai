import {normalizeCapabilities} from '@kubohiroya/turbowarp-preview-runtime';

import {deepFreeze} from './story-document.js';

const messageTypes = Object.freeze({
  handshake: 'preview.handshake',
  stage: 'preview.source.stage',
  defer: 'preview.source.defer',
  commit: 'preview.source.commit',
  disconnect: 'preview.disconnect',
});

const restartChoices = new Set(['storyStart', 'currentScene', 'currentAction']);

export const dsl4PreviewProtocolVersion = deepFreeze({major: 1, minor: 0});
export const dsl4PreviewRequiredCapabilities = deepFreeze([
  'diagnostics.v1',
  'restart.choice.v1',
  'source.commit.v1',
  'source.stage.v1',
]);
export const dsl4PreviewOptionalCapabilities = deepFreeze(['source.defer.v1']);

export class Dsl4PreviewProtocolError extends TypeError {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'Dsl4PreviewProtocolError';
    this.code = code;
  }
}

/** @param {string} code @param {string} message @returns {never} */
function fail(code, message) {
  throw new Dsl4PreviewProtocolError(code, message);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {Record<string, unknown>} value @param {ReadonlySet<string>} keys */
function rejectUnknownKeys(value, keys) {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) fail('K4-PREVIEW-PROTOCOL-SCHEMA', `Unknown protocol key: ${key}`);
  }
}

/** @param {unknown} value @param {string} expectedType */
function message(value, expectedType) {
  if (!isRecord(value)) fail('K4-PREVIEW-PROTOCOL-SCHEMA', 'Protocol message must be an object');
  if (value.type !== expectedType) {
    fail('K4-PREVIEW-PROTOCOL-SCHEMA', `Expected protocol message type ${expectedType}`);
  }
  return value;
}

/** @param {unknown} value */
function sessionId(value) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._-]+$/u.test(value)
  ) {
    fail('K4-PREVIEW-PROTOCOL-SESSION', 'sessionId must be 1-128 URL-safe characters');
  }
  return value;
}

/** @param {unknown} value @param {string} name */
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail('K4-PREVIEW-PROTOCOL-SCHEMA', `${name} must be a positive safe integer`);
  }
  return Number(value);
}

/**
 * Let the shared preview runtime own the capability token grammar, duplicate rejection, and
 * ordering, and restate its rejection as a DSL 4.0 protocol schema error so the wire contract keeps
 * reporting `K4-PREVIEW-PROTOCOL-SCHEMA`. Shared messages end with a period and DSL 4.0 protocol
 * messages do not.
 *
 * @param {unknown} value @param {string} name
 */
function capabilityList(value, name) {
  try {
    return normalizeCapabilities(value, name);
  } catch (error) {
    fail(
      'K4-PREVIEW-PROTOCOL-SCHEMA',
      error instanceof TypeError ? error.message.replace(/\.$/u, '') : `${name} is invalid`,
    );
  }
}

/** @param {unknown} value */
function protocolVersion(value) {
  if (!isRecord(value)) {
    fail('K4-PREVIEW-PROTOCOL-SCHEMA', 'protocolVersion must be an object');
  }
  rejectUnknownKeys(value, new Set(['major', 'minor']));
  if (!Number.isSafeInteger(value.major) || Number(value.major) < 0) {
    fail('K4-PREVIEW-PROTOCOL-SCHEMA', 'protocolVersion.major must be a non-negative integer');
  }
  if (!Number.isSafeInteger(value.minor) || Number(value.minor) < 0) {
    fail('K4-PREVIEW-PROTOCOL-SCHEMA', 'protocolVersion.minor must be a non-negative integer');
  }
  return {major: Number(value.major), minor: Number(value.minor)};
}

/** @param {unknown} value */
function validateLiveReloadSession(value) {
  if (
    !isRecord(value) ||
    typeof value.stage !== 'function' ||
    typeof value.defer !== 'function' ||
    typeof value.commit !== 'function' ||
    typeof value.discardCandidate !== 'function' ||
    typeof value.getState !== 'function' ||
    typeof value.whenIdle !== 'function'
  ) {
    throw new TypeError('liveReloadSession does not implement the preview protocol port');
  }
  return /** @type {Record<string, Function>} */ (value);
}

/** @param {Readonly<Record<string, any>>} state */
function currentSummary(state) {
  return deepFreeze({
    generation: state.generation,
    sourceId: state.current?.sourceId ?? null,
    integrity: state.current?.integrity ?? null,
  });
}

/** @param {unknown} result */
function stagedSourceIntegrity(result) {
  if (!isRecord(result) || typeof result.ok !== 'boolean' || !Array.isArray(result.diagnostics)) {
    fail('K4-PREVIEW-PROTOCOL-SCHEMA', 'result must be a source frontend result');
  }
  if (result.sourceSnapshot === undefined || result.sourceSnapshot === null) {
    return null;
  }
  if (!isRecord(result.sourceSnapshot) || typeof result.sourceSnapshot.integrity !== 'string') {
    fail('K4-PREVIEW-PROTOCOL-SCHEMA', 'sourceSnapshot.integrity must be a string');
  }
  return result.sourceSnapshot.integrity;
}

/**
 * Coordinate one transport connection at a time without owning network, authentication,
 * filesystem, or modal UI concerns.
 *
 * @param {object} options
 * @param {Record<string, Function>} options.liveReloadSession
 * @param {ReadonlyArray<string>} [options.runtimeCapabilities]
 */
export function createDsl4PreviewProtocolSession({liveReloadSession, runtimeCapabilities = []}) {
  const liveReload = validateLiveReloadSession(liveReloadSession);
  const extras = capabilityList(runtimeCapabilities, 'runtimeCapabilities');
  const availableCapabilities = Object.freeze(
    [
      ...new Set([
        ...dsl4PreviewRequiredCapabilities,
        ...dsl4PreviewOptionalCapabilities,
        ...extras,
      ]),
    ].sort(),
  );
  /** @type {{sessionId: string, capabilities: ReadonlySet<string>, latestRevision: number, candidate: {revision: number, id: number} | null} | null} */
  let connection = null;
  let operationQueue = Promise.resolve();
  const pendingStages = new Set();

  /** @param {() => unknown | Promise<unknown>} operation */
  function enqueue(operation) {
    const result = operationQueue.then(operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** @param {string} requestedSessionId */
  function requireConnection(requestedSessionId) {
    if (!connection) fail('K4-PREVIEW-PROTOCOL-DISCONNECTED', 'Preview session is disconnected');
    if (connection.sessionId !== requestedSessionId) {
      fail('K4-PREVIEW-PROTOCOL-SESSION', 'Protocol message belongs to a stale session');
    }
    return connection;
  }

  /** @param {unknown} input */
  function handshake(input) {
    return enqueue(async () => {
      const hello = message(input, messageTypes.handshake);
      rejectUnknownKeys(hello, new Set(['type', 'protocolVersion', 'sessionId', 'capabilities']));
      const requestedVersion = protocolVersion(hello.protocolVersion);
      const requestedSessionId = sessionId(hello.sessionId);
      const requestedCapabilities = capabilityList(hello.capabilities, 'capabilities');
      if (requestedVersion.major !== dsl4PreviewProtocolVersion.major) {
        fail(
          'K4-PREVIEW-PROTOCOL-VERSION',
          `Unsupported preview protocol major version: ${requestedVersion.major}`,
        );
      }
      const missing = dsl4PreviewRequiredCapabilities.filter(
        (capability) => !requestedCapabilities.includes(capability),
      );
      if (missing.length > 0) {
        fail(
          'K4-PREVIEW-PROTOCOL-CAPABILITY',
          `Missing required preview capabilities: ${missing.join(', ')}`,
        );
      }

      if (liveReload.getState().disposed) {
        fail('K4-PREVIEW-PROTOCOL-DISCONNECTED', 'Live reload runtime is disposed');
      }
      if (connection) await liveReload.discardCandidate();
      const negotiatedCapabilities = requestedCapabilities.filter((item) =>
        availableCapabilities.includes(item),
      );
      connection = {
        sessionId: requestedSessionId,
        capabilities: new Set(negotiatedCapabilities),
        latestRevision: 0,
        candidate: null,
      };
      const state = liveReload.getState();
      return deepFreeze({
        type: 'preview.handshake.ack',
        sessionId: requestedSessionId,
        protocolVersion: {
          major: dsl4PreviewProtocolVersion.major,
          minor: Math.min(requestedVersion.minor, dsl4PreviewProtocolVersion.minor),
        },
        capabilities: negotiatedCapabilities,
        requiredCapabilities: dsl4PreviewRequiredCapabilities,
        current: currentSummary(state),
      });
    });
  }

  /** @param {unknown} input */
  function stage(input) {
    const begun = enqueue(() => {
      const request = message(input, messageTypes.stage);
      rejectUnknownKeys(request, new Set(['type', 'sessionId', 'revision', 'result']));
      const requestedSessionId = sessionId(request.sessionId);
      const active = requireConnection(requestedSessionId);
      const revision = positiveInteger(request.revision, 'revision');
      if (revision <= active.latestRevision) {
        fail('K4-PREVIEW-PROTOCOL-REVISION', 'Preview source revision is stale');
      }
      const integrity = stagedSourceIntegrity(request.result);
      active.latestRevision = revision;
      active.candidate = null;
      const staged = liveReload.stage(request.result);
      return {active, requestedSessionId, revision, integrity, staged};
    });

    const completion = begun.then(async (begunInput) => {
      const {active, requestedSessionId, revision, integrity, staged} = /** @type {any} */ (
        begunInput
      );
      const state = await staged;
      return enqueue(() => {
        if (!connection || connection !== active || connection.sessionId !== requestedSessionId) {
          fail('K4-PREVIEW-PROTOCOL-SESSION', 'Preview source belongs to a stale session');
        }
        if (revision !== active.latestRevision && state.candidate) {
          fail('K4-PREVIEW-PROTOCOL-REVISION', 'Preview source revision was replaced');
        }
        const stagedCandidate = revision === active.latestRevision ? state.candidate : null;
        if (revision === active.latestRevision) {
          active.candidate = stagedCandidate ? {revision, id: stagedCandidate.id} : null;
        }
        return deepFreeze({
          type: 'preview.source.staged',
          sessionId: requestedSessionId,
          revision,
          sourceIntegrity: integrity,
          status: state.status,
          candidate: stagedCandidate
            ? {id: stagedCandidate.id, options: stagedCandidate.plan.options}
            : null,
          current: currentSummary(state),
          diagnostics: state.diagnostics,
        });
      });
    });
    const idleStage = completion.then(
      () => undefined,
      () => undefined,
    );
    pendingStages.add(idleStage);
    void idleStage.then(() => pendingStages.delete(idleStage));
    return completion;
  }

  /** @param {unknown} input */
  function defer(input) {
    return enqueue(async () => {
      const request = message(input, messageTypes.defer);
      rejectUnknownKeys(request, new Set(['type', 'sessionId', 'revision', 'candidateId']));
      const requestedSessionId = sessionId(request.sessionId);
      const active = requireConnection(requestedSessionId);
      if (!active.capabilities.has('source.defer.v1')) {
        fail('K4-PREVIEW-PROTOCOL-CAPABILITY', 'source.defer.v1 was not negotiated');
      }
      const revision = positiveInteger(request.revision, 'revision');
      const candidateId = positiveInteger(request.candidateId, 'candidateId');
      if (
        !active.candidate ||
        active.candidate.revision !== revision ||
        active.candidate.id !== candidateId
      ) {
        fail('K4-PREVIEW-PROTOCOL-CANDIDATE', 'Preview candidate is stale or missing');
      }
      const state = await liveReload.defer(candidateId);
      active.candidate = null;
      return deepFreeze({
        type: 'preview.source.deferred',
        sessionId: requestedSessionId,
        revision,
        candidateId,
        status: state.status,
        current: currentSummary(state),
      });
    });
  }

  /** @param {unknown} input */
  function commit(input) {
    return enqueue(async () => {
      const request = message(input, messageTypes.commit);
      rejectUnknownKeys(
        request,
        new Set(['type', 'sessionId', 'revision', 'candidateId', 'choice']),
      );
      const requestedSessionId = sessionId(request.sessionId);
      const active = requireConnection(requestedSessionId);
      const revision = positiveInteger(request.revision, 'revision');
      const candidateId = positiveInteger(request.candidateId, 'candidateId');
      if (
        !active.candidate ||
        active.candidate.revision !== revision ||
        active.candidate.id !== candidateId
      ) {
        fail('K4-PREVIEW-PROTOCOL-CANDIDATE', 'Preview candidate is stale or missing');
      }
      if (typeof request.choice !== 'string' || !restartChoices.has(request.choice)) {
        fail('K4-PREVIEW-PROTOCOL-SCHEMA', 'Unknown live reload restart choice');
      }
      const state = await liveReload.commit(candidateId, request.choice);
      active.candidate = null;
      return deepFreeze({
        type: 'preview.source.committed',
        sessionId: requestedSessionId,
        revision,
        candidateId,
        choice: request.choice,
        status: state.status,
        current: currentSummary(state),
      });
    });
  }

  /** @param {unknown} input */
  function disconnect(input) {
    return enqueue(async () => {
      const request = message(input, messageTypes.disconnect);
      rejectUnknownKeys(request, new Set(['type', 'sessionId']));
      const requestedSessionId = sessionId(request.sessionId);
      if (connection && connection.sessionId !== requestedSessionId) {
        fail('K4-PREVIEW-PROTOCOL-SESSION', 'Disconnect belongs to a stale session');
      }
      const state = connection ? await liveReload.discardCandidate() : liveReload.getState();
      connection = null;
      return deepFreeze({
        type: 'preview.disconnected',
        sessionId: requestedSessionId,
        current: currentSummary(state),
      });
    });
  }

  function snapshot() {
    const state = liveReload.getState();
    return deepFreeze({
      version: 1,
      connected: connection !== null,
      sessionId: connection?.sessionId ?? null,
      latestRevision: connection?.latestRevision ?? 0,
      candidate: connection?.candidate ?? null,
      current: currentSummary(state),
    });
  }

  return Object.freeze({
    handshake,
    stage,
    defer,
    commit,
    disconnect,
    getState: snapshot,
    async whenIdle() {
      await Promise.all([...pendingStages, operationQueue]);
      await operationQueue;
      return snapshot();
    },
  });
}
