import {
  dsl4PreviewOptionalCapabilities,
  dsl4PreviewProtocolVersion,
  dsl4PreviewRequiredCapabilities,
} from './preview-protocol.js';
import {deepFreeze} from './story-document.js';

const restartChoices = new Set(['storyStart', 'currentScene', 'currentAction']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The preview protocol session this port speaks to. */
interface PreviewProtocolSession {
  handshake(...parameters: any[]): any;
  stage(...parameters: any[]): any;
  defer(...parameters: any[]): any;
  commit(...parameters: any[]): any;
  disconnect(...parameters: any[]): any;
  getState(): Readonly<Record<string, any>>;
  whenIdle(...parameters: any[]): any;
}

function validateProtocol(value: unknown) {
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
  return value as unknown as PreviewProtocolSession;
}

function validateSessionId(value: unknown) {
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

function validateCapabilities(value: unknown) {
  if (!Array.isArray(value)) throw new TypeError('capabilities must be an array');
  const capabilities = value.map((capability) => {
    if (typeof capability !== 'string' || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(capability)) {
      throw new TypeError('capabilities contains an invalid capability');
    }
    return capability;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new TypeError('capabilities must not contain duplicates');
  }
  for (const required of dsl4PreviewRequiredCapabilities) {
    if (!capabilities.includes(required)) {
      throw new TypeError(`capabilities is missing required capability ${required}`);
    }
  }
  return Object.freeze([...capabilities].sort());
}

function optionalCallback(value: unknown, name: string): Function | undefined {
  if (value !== undefined && typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function validateSourceResult(value: unknown) {
  if (!isRecord(value) || typeof value.ok !== 'boolean' || !Array.isArray(value.diagnostics)) {
    throw new TypeError('stage requires a source frontend result');
  }
  return value;
}

function validateHandshakeAck(value: unknown, sessionId: string) {
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

function validateStageAck(value: unknown, sessionId: string, revision: number) {
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

/** Assign monotonic revisions and expose the same protocol operations to Node and browser sources. */
export function createDsl4PreviewSourceProtocolPort({
  protocolSession,
  sessionId: inputSessionId,
  capabilities: inputCapabilities = [
    ...dsl4PreviewRequiredCapabilities,
    ...dsl4PreviewOptionalCapabilities,
  ],
  onEvent,
  onError,
}: {
  protocolSession: Record<string, Function>;
  sessionId: string;
  capabilities?: ReadonlyArray<string> | undefined;
  onEvent?: (event: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
  onError?: (error: unknown) => unknown;
}) {
  const protocol = validateProtocol(protocolSession);
  const sessionId = validateSessionId(inputSessionId);
  const capabilities = validateCapabilities(inputCapabilities);
  const eventObserver = optionalCallback(onEvent, 'onEvent');
  const errorObserver = optionalCallback(onError, 'onError');

  let connected = false;
  let disposed = false;
  let status:
    | 'idle'
    | 'connecting'
    | 'connected'
    | 'staging'
    | 'candidate'
    | 'committing'
    | 'deferring'
    | 'disconnected'
    | 'failed'
    | 'disposed' = 'idle';
  let connectionGeneration = 0;
  let latestRevision = 0;
  let latestAcknowledgedRevision = 0;
  let candidate: Readonly<Record<string, any>> | null = null;
  let lastEvent: Readonly<Record<string, unknown>> | null = null;
  let current: Readonly<Record<string, unknown>> | null = null;
  let connectPromise: Promise<unknown> | null = null;
  let disconnectPromise: Promise<unknown> | null = null;
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

  function reportError(error: unknown) {
    try {
      errorObserver?.(error);
    } catch {
      // Error observers cannot change protocol state.
    }
  }

  async function publishEvent(event: Readonly<Record<string, unknown>>) {
    lastEvent = event;
    if (!eventObserver) return;
    try {
      await eventObserver(event);
    } catch (error) {
      reportError(error);
    }
  }

  function enqueue(operation: () => unknown | Promise<unknown>) {
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
          current = (ack.current ?? null) as Readonly<Record<string, unknown>>;
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

  function stage(input: unknown) {
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
          current = (ack.current ?? null) as Readonly<Record<string, unknown>>;
          const acknowledgedCandidate = ack.candidate as Record<string, any> | null;
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

  function commit(choice: 'storyStart' | 'currentScene' | 'currentAction') {
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
        current = (ack.current ?? null) as Readonly<Record<string, unknown>>;
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
        current = (ack.current ?? null) as Readonly<Record<string, unknown>>;
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
            current = (input.current ?? null) as Readonly<Record<string, unknown>>;
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

  let disposePromise: Promise<Readonly<Record<string, unknown>>> | null = null;
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
