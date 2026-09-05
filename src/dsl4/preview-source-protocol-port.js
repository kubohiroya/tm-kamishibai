import {normalizeCapabilities} from '@kubohiroya/turbowarp-preview-runtime';

import {
  dsl4PreviewOptionalCapabilities,
  dsl4PreviewProtocolVersion,
  dsl4PreviewRequiredCapabilities,
} from './preview-protocol.js';
import {deepFreeze} from './story-document.js';

const restartChoices = new Set(['storyStart', 'currentScene', 'currentAction']);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function validateProtocol(value) {
  if (
    !isRecord(value) ||
    typeof value.handshake !== 'function' ||
    typeof value.stage !== 'function' ||
    typeof value.defer !== 'function' ||
    typeof value.commit !== 'function' ||
    typeof value.disconnect !== 'function' ||
    typeof value.getState !== 'function' ||
    typeof value.whenIdle !== 'function'
  ) {
    throw new TypeError('protocolSession must implement the DSL 4.0 preview protocol');
  }
  return /** @type {Record<string, Function>} */ (value);
}

/** @param {unknown} value */
function validateSessionId(value) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._-]+$/u.test(value)
  ) {
    throw new TypeError('sessionId must be 1-128 URL-safe characters');
  }
  return value;
}

/**
 * Delegate app-neutral capability token grammar, duplicate rejection, and ordering to the shared
 * preview runtime, then keep the DSL 4.0 required capability set as a local policy check.
 *
 * @param {unknown} value
 */
function validateCapabilities(value) {
  const capabilities = normalizeCapabilities(value, 'capabilities');
  for (const required of dsl4PreviewRequiredCapabilities) {
    if (!capabilities.includes(required)) {
      throw new TypeError(`capabilities is missing required capability ${required}`);
    }
  }
  return capabilities;
}

/** @param {unknown} value @param {string} name @returns {Function | undefined} */
function optionalCallback(value, name) {
  if (value !== undefined && typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

/** @param {unknown} value */
function validateSourceResult(value) {
  if (!isRecord(value) || typeof value.ok !== 'boolean' || !Array.isArray(value.diagnostics)) {
    throw new TypeError('stage requires a source frontend result');
  }
  return value;
}

/** @param {unknown} value @param {string} sessionId */
function validateHandshakeAck(value, sessionId) {
  if (
    !isRecord(value) ||
    value.type !== 'preview.handshake.ack' ||
    value.sessionId !== sessionId ||
    !Array.isArray(value.capabilities)
  ) {
    throw new TypeError('preview handshake returned an invalid acknowledgement');
  }
  return value;
}

/** @param {unknown} value @param {string} sessionId @param {number} revision */
function validateStageAck(value, sessionId, revision) {
  if (
    !isRecord(value) ||
    value.type !== 'preview.source.staged' ||
    value.sessionId !== sessionId ||
    value.revision !== revision ||
    (value.candidate !== null &&
      (!isRecord(value.candidate) ||
        !Number.isSafeInteger(value.candidate.id) ||
        Number(value.candidate.id) < 1 ||
        !isRecord(value.candidate.options)))
  ) {
    throw new TypeError('preview stage returned an invalid acknowledgement');
  }
  return value;
}

/**
 * Assign monotonic revisions and expose the same protocol operations to Node and browser sources.
 *
 * @param {object} options
 * @param {Record<string, Function>} options.protocolSession
 * @param {string} options.sessionId
 * @param {ReadonlyArray<string>} [options.capabilities]
 * @param {(event: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.onEvent]
 * @param {(error: unknown) => unknown} [options.onError]
 */
export function createDsl4PreviewSourceProtocolPort({
  protocolSession,
  sessionId: inputSessionId,
  capabilities: inputCapabilities = [
    ...dsl4PreviewRequiredCapabilities,
    ...dsl4PreviewOptionalCapabilities,
  ],
  onEvent,
  onError,
}) {
  const protocol = validateProtocol(protocolSession);
  const sessionId = validateSessionId(inputSessionId);
  const capabilities = validateCapabilities(inputCapabilities);
  const eventObserver = optionalCallback(onEvent, 'onEvent');
  const errorObserver = optionalCallback(onError, 'onError');

  let connected = false;
  let disposed = false;
  /** @type {'idle' | 'connecting' | 'connected' | 'staging' | 'candidate' | 'committing' | 'deferring' | 'disconnected' | 'failed' | 'disposed'} */
  let status = 'idle';
  let connectionGeneration = 0;
  let latestRevision = 0;
  let latestAcknowledgedRevision = 0;
  /** @type {Readonly<Record<string, any>> | null} */
  let candidate = null;
  /** @type {Readonly<Record<string, unknown>> | null} */
  let lastEvent = null;
  /** @type {Readonly<Record<string, unknown>> | null} */
  let current = null;
  /** @type {Promise<unknown> | null} */
  let connectPromise = null;
  /** @type {Promise<unknown> | null} */
  let disconnectPromise = null;
  let operationQueue = Promise.resolve();
  const pendingStages = new Set();

  function snapshot() {
    return deepFreeze({
      version: 1,
      status,
      connected,
      disposed,
      sessionId,
      connectionGeneration,
      latestRevision,
      latestAcknowledgedRevision,
      candidate,
      current,
      pendingStages: pendingStages.size,
      lastEvent,
    });
  }

  /** @param {unknown} error */
  function reportError(error) {
    try {
      errorObserver?.(error);
    } catch {
      // Error observers cannot change protocol state.
    }
  }

  /** @param {Readonly<Record<string, unknown>>} event */
  async function publishEvent(event) {
    lastEvent = event;
    if (!eventObserver) return;
    try {
      await eventObserver(event);
    } catch (error) {
      reportError(error);
    }
  }

  /** @param {() => unknown | Promise<unknown>} operation */
  function enqueue(operation) {
    const result = operationQueue.then(operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function connect() {
    if (disposed) throw new TypeError('preview source protocol port is disposed');
    if (connected) return Promise.resolve(snapshot());
    if (connectPromise) return connectPromise;
    if (status !== 'idle') throw new TypeError('preview source protocol port cannot reconnect');
    status = 'connecting';
    const requestedGeneration = ++connectionGeneration;
    connectPromise = Promise.resolve()
      .then(() =>
        protocol.handshake({
          type: 'preview.handshake',
          protocolVersion: dsl4PreviewProtocolVersion,
          sessionId,
          capabilities,
        }),
      )
      .then(
        async (input) => {
          const ack = validateHandshakeAck(input, sessionId);
          connectPromise = null;
          if (disposed || requestedGeneration !== connectionGeneration) return snapshot();
          connected = true;
          status = 'connected';
          current = /** @type {Readonly<Record<string, unknown>>} */ (ack.current ?? null);
          await publishEvent(ack);
          return snapshot();
        },
        (error) => {
          connectPromise = null;
          status = disposed ? 'disposed' : 'failed';
          reportError(error);
          throw error;
        },
      );
    return connectPromise;
  }

  /** @param {unknown} input */
  function stage(input) {
    if (disposed) throw new TypeError('preview source protocol port is disposed');
    if (!connected) throw new TypeError('preview source protocol port is not connected');
    const result = validateSourceResult(input);
    const revision = ++latestRevision;
    const requestedGeneration = connectionGeneration;
    candidate = null;
    status = 'staging';
    const completion = Promise.resolve()
      .then(() =>
        protocol.stage({
          type: 'preview.source.stage',
          sessionId,
          revision,
          result,
        }),
      )
      .then(
        async (inputAck) => {
          const ack = validateStageAck(inputAck, sessionId, revision);
          if (
            disposed ||
            !connected ||
            requestedGeneration !== connectionGeneration ||
            revision !== latestRevision
          ) {
            return ack;
          }
          latestAcknowledgedRevision = revision;
          current = /** @type {Readonly<Record<string, unknown>>} */ (ack.current ?? null);
          const acknowledgedCandidate = /** @type {Record<string, any> | null} */ (ack.candidate);
          candidate = acknowledgedCandidate
            ? deepFreeze({
                revision,
                id: acknowledgedCandidate.id,
                options: acknowledgedCandidate.options,
              })
            : null;
          status = candidate ? 'candidate' : 'connected';
          await publishEvent(ack);
          return ack;
        },
        (error) => {
          if (
            !disposed &&
            connected &&
            requestedGeneration === connectionGeneration &&
            revision === latestRevision
          ) {
            status = 'failed';
            candidate = null;
            reportError(error);
          }
          throw error;
        },
      );
    const observed = completion.then(
      () => undefined,
      () => undefined,
    );
    pendingStages.add(observed);
    void observed.then(() => pendingStages.delete(observed));
    return completion;
  }

  /** @param {'storyStart' | 'currentScene' | 'currentAction'} choice */
  function commit(choice) {
    return enqueue(async () => {
      if (disposed) throw new TypeError('preview source protocol port is disposed');
      if (!connected) throw new TypeError('preview source protocol port is not connected');
      if (typeof choice !== 'string' || !restartChoices.has(choice)) {
        throw new TypeError('preview restart choice is invalid');
      }
      if (!candidate) throw new TypeError('preview source protocol port has no candidate');
      const selected = candidate;
      candidate = null;
      status = 'committing';
      try {
        const ack = await protocol.commit({
          type: 'preview.source.commit',
          sessionId,
          revision: selected.revision,
          candidateId: selected.id,
          choice,
        });
        if (
          !isRecord(ack) ||
          ack.type !== 'preview.source.committed' ||
          ack.sessionId !== sessionId ||
          ack.revision !== selected.revision ||
          ack.candidateId !== selected.id ||
          ack.choice !== choice
        ) {
          throw new TypeError('preview commit returned an invalid acknowledgement');
        }
        current = /** @type {Readonly<Record<string, unknown>>} */ (ack.current ?? null);
        status = 'connected';
        await publishEvent(ack);
        return ack;
      } catch (error) {
        status = 'failed';
        reportError(error);
        throw error;
      }
    });
  }

  function defer() {
    return enqueue(async () => {
      if (disposed) throw new TypeError('preview source protocol port is disposed');
      if (!connected) throw new TypeError('preview source protocol port is not connected');
      if (!candidate) throw new TypeError('preview source protocol port has no candidate');
      const selected = candidate;
      candidate = null;
      status = 'deferring';
      try {
        const ack = await protocol.defer({
          type: 'preview.source.defer',
          sessionId,
          revision: selected.revision,
          candidateId: selected.id,
        });
        if (
          !isRecord(ack) ||
          ack.type !== 'preview.source.deferred' ||
          ack.sessionId !== sessionId ||
          ack.revision !== selected.revision ||
          ack.candidateId !== selected.id
        ) {
          throw new TypeError('preview defer returned an invalid acknowledgement');
        }
        current = /** @type {Readonly<Record<string, unknown>>} */ (ack.current ?? null);
        status = 'connected';
        await publishEvent(ack);
        return ack;
      } catch (error) {
        status = 'failed';
        reportError(error);
        throw error;
      }
    });
  }

  function disconnect() {
    if (disconnectPromise) return disconnectPromise;
    if (!connected) {
      if (status !== 'disposed') status = 'disconnected';
      return Promise.resolve(snapshot());
    }
    const requestedGeneration = ++connectionGeneration;
    connected = false;
    candidate = null;
    disconnectPromise = Promise.resolve()
      .then(() => protocol.disconnect({type: 'preview.disconnect', sessionId}))
      .then(
        async (input) => {
          if (
            !isRecord(input) ||
            input.type !== 'preview.disconnected' ||
            input.sessionId !== sessionId
          ) {
            throw new TypeError('preview disconnect returned an invalid acknowledgement');
          }
          if (requestedGeneration === connectionGeneration) {
            current = /** @type {Readonly<Record<string, unknown>>} */ (input.current ?? null);
            status = disposed ? 'disposed' : 'disconnected';
          }
          disconnectPromise = null;
          await publishEvent(input);
          return snapshot();
        },
        (error) => {
          disconnectPromise = null;
          status = disposed ? 'disposed' : 'failed';
          reportError(error);
          throw error;
        },
      );
    return disconnectPromise;
  }

  /** @type {Promise<Readonly<Record<string, unknown>>> | null} */
  let disposePromise = null;
  function dispose() {
    if (disposePromise) return disposePromise;
    if (disposed) return Promise.resolve(snapshot());
    disposed = true;
    disposePromise = (async () => {
      try {
        await disconnect();
      } finally {
        status = 'disposed';
        connected = false;
        candidate = null;
      }
      return snapshot();
    })();
    return disposePromise;
  }

  return Object.freeze({
    connect,
    stage,
    commit,
    defer,
    disconnect,
    dispose,
    getState: snapshot,
    async whenIdle() {
      await Promise.all([...pendingStages, connectPromise, disconnectPromise].filter(Boolean));
      await operationQueue;
      await protocol.whenIdle();
      return snapshot();
    },
  });
}
