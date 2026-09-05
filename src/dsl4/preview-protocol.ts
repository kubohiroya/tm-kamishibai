import {
  createPreviewProtocolController,
  PreviewProtocolError,
  validatePreviewRevision,
} from '@kubohiroya/turbowarp-preview-runtime';

import {deepFreeze} from './story-document.js';

const messageTypes = Object.freeze({
  handshake: 'preview.handshake',
  handshakeAck: 'preview.handshake.ack',
  stage: 'preview.source.stage',
  defer: 'preview.source.defer',
  commit: 'preview.source.commit',
  disconnect: 'preview.disconnect',
  disconnectAck: 'preview.disconnected',
});

const restartChoices = new Set(['storyStart', 'currentScene', 'currentAction']);

/**
 * The shared preview runtime builds codes as `${prefix}-PROTOCOL-${suffix}`, so this prefix keeps
 * the DSL 4.0 wire contract reporting `K4-PREVIEW-PROTOCOL-*`.
 */
const errorCodePrefix = 'K4-PREVIEW';

export const dsl4PreviewProtocolVersion = deepFreeze({major: 1, minor: 0});
export const dsl4PreviewRequiredCapabilities = deepFreeze([
  'diagnostics.v1',
  'restart.choice.v1',
  'source.commit.v1',
  'source.stage.v1',
]);
export const dsl4PreviewOptionalCapabilities = deepFreeze(['source.defer.v1']);

export class Dsl4PreviewProtocolError extends PreviewProtocolError {
  constructor(code: string, message: string) {
    super(code as `${string}-PROTOCOL-SCHEMA`, message);
    this.name = 'Dsl4PreviewProtocolError';
  }
}

function fail(code: string, message: string): never {
  throw new Dsl4PreviewProtocolError(code, message);
}

/**
 * Restate a shared preview runtime rejection as a DSL 4.0 protocol error. The code already carries
 * the `K4-PREVIEW` prefix; shared messages end with a period and DSL 4.0 protocol messages do not.
 */
function asDsl4ProtocolError(error: unknown) {
  if (error instanceof PreviewProtocolError && !(error instanceof Dsl4PreviewProtocolError)) {
    return new Dsl4PreviewProtocolError(error.code, error.message.replace(/\.$/u, ''));
  }
  return error;
}

function withDsl4ProtocolErrors<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw asDsl4ProtocolError(error);
  }
}

function protocolOperation<T>(operation: () => Promise<T>): Promise<T> {
  return withDsl4ProtocolErrors(operation).catch((error: unknown) => {
    throw asDsl4ProtocolError(error);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The live reload session as the preview protocol drives it. */
interface PreviewProtocolLiveReloadPort {
  stage(...parameters: any[]): any;
  defer(...parameters: any[]): any;
  commit(...parameters: any[]): any;
  discardCandidate(...parameters: any[]): any;
  getState(): Readonly<Record<string, any>>;
  whenIdle(...parameters: any[]): any;
}

function validateLiveReloadSession(value: unknown) {
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
  return value as unknown as PreviewProtocolLiveReloadPort;
}

function currentSummary(state: Readonly<Record<string, any>>) {
  return deepFreeze({
    generation: state.generation,
    sourceId: state.current?.sourceId ?? null,
    integrity: state.current?.integrity ?? null,
  });
}

function stagedSourceIntegrity(result: unknown) {
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
 * Connection ownership, capability negotiation, revision ordering, candidate identity, and the
 * operation queue come from `@kubohiroya/turbowarp-preview-runtime`. What stays here is the DSL 4.0
 * wire contract: message names, ack payloads, source integrity projection, and restart choices.
 */
export function createDsl4PreviewProtocolSession({
  liveReloadSession,
  runtimeCapabilities = [],
}: {
  liveReloadSession: PreviewProtocolLiveReloadPort;
  runtimeCapabilities?: ReadonlyArray<string>;
}) {
  const liveReload = validateLiveReloadSession(liveReloadSession);
  // Construction validates the capability lists, so it reports DSL 4.0 codes like every operation.
  const controller = withDsl4ProtocolErrors(() =>
    createPreviewProtocolController({
      errorCodePrefix,
      protocolVersion: {...dsl4PreviewProtocolVersion},
      requiredCapabilities: dsl4PreviewRequiredCapabilities,
      optionalCapabilities: dsl4PreviewOptionalCapabilities,
      runtimeCapabilities,
      messageTypes: {
        handshake: messageTypes.handshake,
        handshakeAck: messageTypes.handshakeAck,
        disconnect: messageTypes.disconnect,
        disconnectAck: messageTypes.disconnectAck,
      },
      getState: () => currentSummary(liveReload.getState()),
      isDisposed: () => liveReload.getState().disposed === true,
      onDisconnect: async () => {
        await liveReload.discardCandidate();
      },
    }),
  );

  function handshake(input: unknown) {
    return protocolOperation(async () => {
      const ack = await controller.handshake(input);
      return deepFreeze({
        type: ack.type,
        sessionId: ack.sessionId,
        protocolVersion: ack.protocolVersion,
        capabilities: ack.capabilities,
        requiredCapabilities: dsl4PreviewRequiredCapabilities,
        current: ack.state,
      });
    });
  }

  function stage(input: unknown) {
    // Two phases: accept the revision without holding the queue for the staging work, then re-enter
    // the queue to acknowledge only if this revision and connection are still the current ones.
    const begun = controller.enqueue(() => {
      const request = controller.readMessage(input, messageTypes.stage, [
        'sessionId',
        'revision',
        'result',
      ]);
      const active = controller.requireConnection(request.sessionId);
      validatePreviewRevision(request.revision, active.latestRevision, 'revision', errorCodePrefix);
      const integrity = stagedSourceIntegrity(request.result);
      const accepted = controller.acceptRevision(request.sessionId, request.revision);
      return {accepted, integrity, staged: liveReload.stage(request.result)};
    });

    const completion = protocolOperation(async () => {
      const {accepted, integrity, staged} = await begun;
      const state = await staged;
      return controller.enqueue(() => {
        const current = controller.currentConnection();
        if (!current || current.connectionId !== accepted.connectionId) {
          fail('K4-PREVIEW-PROTOCOL-SESSION', 'Preview source belongs to a stale session');
        }
        if (accepted.revision !== current.latestRevision && state.candidate) {
          fail('K4-PREVIEW-PROTOCOL-REVISION', 'Preview source revision was replaced');
        }
        const stagedCandidate =
          accepted.revision === current.latestRevision ? state.candidate : null;
        if (accepted.revision === current.latestRevision) {
          if (stagedCandidate) {
            controller.acceptCandidate(accepted.sessionId, {
              id: stagedCandidate.id,
              revision: accepted.revision,
            });
          } else {
            controller.clearCandidate(accepted.sessionId);
          }
        }
        return deepFreeze({
          type: 'preview.source.staged',
          sessionId: accepted.sessionId,
          revision: accepted.revision,
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
    controller.track(completion);
    return completion;
  }

  function defer(input: unknown) {
    return protocolOperation(() =>
      controller.enqueue(async () => {
        const request = controller.readMessage(input, messageTypes.defer, [
          'sessionId',
          'revision',
          'candidateId',
        ]);
        const active = controller.requireCapability(request.sessionId, 'source.defer.v1');
        const candidate = controller.requireCandidate(
          active.sessionId,
          request.revision,
          request.candidateId,
        );
        const state = await liveReload.defer(candidate.id);
        controller.clearCandidate(active.sessionId);
        return deepFreeze({
          type: 'preview.source.deferred',
          sessionId: active.sessionId,
          revision: candidate.revision,
          candidateId: candidate.id,
          status: state.status,
          current: currentSummary(state),
        });
      }),
    );
  }

  function commit(input: unknown) {
    return protocolOperation(() =>
      controller.enqueue(async () => {
        const request = controller.readMessage(input, messageTypes.commit, [
          'sessionId',
          'revision',
          'candidateId',
          'choice',
        ]);
        const active = controller.requireConnection(request.sessionId);
        const candidate = controller.requireCandidate(
          active.sessionId,
          request.revision,
          request.candidateId,
        );
        if (typeof request.choice !== 'string' || !restartChoices.has(request.choice)) {
          fail('K4-PREVIEW-PROTOCOL-SCHEMA', 'Unknown live reload restart choice');
        }
        const state = await liveReload.commit(candidate.id, request.choice);
        controller.clearCandidate(active.sessionId);
        return deepFreeze({
          type: 'preview.source.committed',
          sessionId: active.sessionId,
          revision: candidate.revision,
          candidateId: candidate.id,
          choice: request.choice,
          status: state.status,
          current: currentSummary(state),
        });
      }),
    );
  }

  function disconnect(input: unknown) {
    return protocolOperation(async () => {
      const ack = await controller.disconnect(input);
      return deepFreeze({
        type: ack.type,
        sessionId: ack.sessionId,
        current: currentSummary(liveReload.getState()),
      });
    });
  }

  function snapshot() {
    const active = controller.currentConnection();
    return deepFreeze({
      version: 1,
      connected: active !== null,
      sessionId: active?.sessionId ?? null,
      latestRevision: active?.latestRevision ?? 0,
      candidate: active?.candidate ?? null,
      current: currentSummary(liveReload.getState()),
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
      await controller.whenIdle();
      return snapshot();
    },
  });
}
