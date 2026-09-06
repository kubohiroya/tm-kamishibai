import type {LiveReloadRuntimeSession} from './live-reload-session.js';
import {createDsl4LiveReloadSession} from './live-reload-session.js';
import {createDsl4PreviewProtocolSession} from './preview-protocol.js';
import {
  decodeDsl4PreviewSourceGenerationWire,
  dsl4PreviewSourceGenerationWireDefaults,
  dsl4PreviewSourceGenerationWireMaximumMessageBytes,
} from './preview-source-generation-wire.js';
import {createDsl4PreviewSourceProtocolPort} from './preview-source-protocol-port.js';
import {deepFreeze} from './story-document.js';

const textEncoder = new TextEncoder();
const generationRecordKeys = new Set(['generation', 'sequence', 'type']);
const restartChoices = new Set(['storyStart', 'currentScene', 'currentAction']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function callback(value: unknown, name: string) {
  if (value !== undefined && typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
  return value as Function | undefined;
}

function safeInteger(value: unknown, name: string, minimum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

function generationRecord(value: unknown) {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('preview generation record must be a plain object');
  }
  const actualKeys = Object.keys(value);
  const unknown = actualKeys.filter((key) => !generationRecordKeys.has(key));
  const missing = [...generationRecordKeys].filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new TypeError(
      `preview generation record keys are invalid (unknown: ${unknown.sort().join(', ') || 'none'}; missing: ${missing.sort().join(', ') || 'none'})`,
    );
  }
  if (value.type !== 'local-preview.generation') {
    throw new TypeError('preview generation record type is invalid');
  }
  return {
    sequence: safeInteger(value.sequence, 'preview generation sequence', 1),
    generation: value.generation,
  };
}

function restartChoice(value: unknown) {
  if (typeof value !== 'string' || !restartChoices.has(value)) {
    throw new TypeError('preview restart choice is invalid');
  }
  return value as 'storyStart' | 'currentScene' | 'currentAction';
}

/**
 * Own the browser-side live reload and preview protocol boundary without owning transport or UI.
 * A concrete browser runtime supplies createSession; generation records are the only source input.
 */
export function createDsl4BrowserPreviewRuntimeBridge(options: {
  createSession: (
    context: Readonly<{
      storyDocument: Readonly<Record<string, unknown>>;
      previousSession: LiveReloadRuntimeSession | null;
      preserveManagedPresentation: boolean;
    }>,
  ) => LiveReloadRuntimeSession | Promise<LiveReloadRuntimeSession>;
  sessionId: string;
  maxGenerationMessageBytes?: number;
  isException?: (value: unknown) => boolean;
  onEvent?: (event: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
  onError?: (error: unknown) => unknown;
}) {
  if (!isRecord(options))
    throw new TypeError('browser preview runtime bridge options are required');
  if (typeof options.createSession !== 'function') {
    throw new TypeError('createSession must be a function');
  }
  const maxGenerationMessageBytes = safeInteger(
    options.maxGenerationMessageBytes ?? dsl4PreviewSourceGenerationWireDefaults.maxMessageBytes,
    'maxGenerationMessageBytes',
    1,
  );
  if (maxGenerationMessageBytes > dsl4PreviewSourceGenerationWireMaximumMessageBytes) {
    throw new TypeError(
      `maxGenerationMessageBytes must be <= ${dsl4PreviewSourceGenerationWireMaximumMessageBytes}`,
    );
  }
  const eventObserver = callback(options.onEvent, 'onEvent');
  const errorObserver = callback(options.onError, 'onError');
  if (options.isException !== undefined && typeof options.isException !== 'function') {
    throw new TypeError('isException must be a function');
  }

  let started = false;
  let disposed = false;
  let status = 'idle';
  let latestRecordSequence = 0;
  let latestGenerationRevision = 0;
  let latestValidGenerationRevision = 0;
  let latestValidResult: Readonly<Record<string, unknown>> | null = null;
  let lastAcknowledgement: Readonly<Record<string, unknown>> | null = null;
  let startPromise: Promise<Readonly<Record<string, unknown>>> | null = null;
  let disposePromise: Promise<Readonly<Record<string, unknown>>> | null = null;

  function reportError(error: unknown) {
    try {
      errorObserver?.(error);
    } catch {
      // Error observers cannot change browser runtime ownership.
    }
  }

  const liveReload = createDsl4LiveReloadSession({
    createSession: options.createSession,
    ...(options.isException === undefined ? {} : {isException: options.isException}),
    onRunError: reportError,
  });
  const protocol = createDsl4PreviewProtocolSession({liveReloadSession: liveReload});
  const port = createDsl4PreviewSourceProtocolPort({
    protocolSession: protocol,
    sessionId: options.sessionId,
    onError: reportError,
    async onEvent(event) {
      lastAcknowledgement = event;
      try {
        await eventObserver?.(event);
      } catch (error) {
        reportError(error);
      }
    },
  });

  function snapshot() {
    return deepFreeze({
      version: 1,
      status,
      started,
      disposed,
      latestRecordSequence,
      latestGenerationRevision,
      latestValidGenerationRevision,
      protocol: port.getState(),
      lastAcknowledgement,
    });
  }

  function ensureActive() {
    if (disposed) throw new TypeError('browser preview runtime bridge is disposed');
    if (!started) throw new TypeError('browser preview runtime bridge is not started');
  }

  function start() {
    if (disposed) throw new TypeError('browser preview runtime bridge is disposed');
    if (started) return Promise.resolve(snapshot());
    if (startPromise) return startPromise;
    status = 'connecting';
    startPromise = port.connect().then(
      () => {
        startPromise = null;
        if (disposed) return snapshot();
        started = true;
        status = 'waiting';
        return snapshot();
      },
      (error) => {
        status = 'failed';
        startPromise = null;
        throw error;
      },
    );
    return startPromise;
  }

  async function accept(input: unknown) {
    ensureActive();
    const record = generationRecord(input);
    if (record.sequence <= latestRecordSequence) {
      throw new TypeError('preview generation record sequence is stale');
    }
    let generationBytes;
    try {
      generationBytes = textEncoder.encode(JSON.stringify(record.generation));
    } catch (error) {
      throw new TypeError('preview generation record must be JSON serializable', {cause: error});
    }
    const generation = decodeDsl4PreviewSourceGenerationWire(generationBytes, {
      maxMessageBytes: maxGenerationMessageBytes,
    });
    if (generation.revision !== latestGenerationRevision + 1) {
      throw new TypeError('preview generation revision must be contiguous and monotonic');
    }

    latestRecordSequence = record.sequence;
    latestGenerationRevision = generation.revision;
    if (generation.result.ok) {
      latestValidResult = generation.result;
      latestValidGenerationRevision = generation.revision;
    }
    status = 'staging';
    try {
      const acknowledgement = await port.stage(generation.result);
      if (generation.revision === latestGenerationRevision) {
        status =
          acknowledgement.status === 'invalid'
            ? 'invalid'
            : acknowledgement.candidate
              ? 'candidate'
              : 'active';
      }
      return acknowledgement;
    } catch (error) {
      if (generation.revision === latestGenerationRevision) status = 'failed';
      throw error;
    }
  }

  async function commit(choice: unknown) {
    ensureActive();
    status = 'committing';
    try {
      const acknowledgement = await port.commit(restartChoice(choice));
      status = 'active';
      return acknowledgement;
    } catch (error) {
      status = 'failed';
      throw error;
    }
  }

  async function defer() {
    ensureActive();
    status = 'deferring';
    try {
      const acknowledgement = await port.defer();
      status = 'active';
      return acknowledgement;
    } catch (error) {
      status = 'failed';
      throw error;
    }
  }

  async function restart(choice: unknown) {
    ensureActive();
    if (!latestValidResult) {
      throw new TypeError('browser preview runtime bridge has no valid generation');
    }
    const selectedChoice = restartChoice(choice);
    status = 'staging';
    try {
      const staged = await port.stage(latestValidResult);
      if (!staged.candidate) {
        status = 'active';
        return staged;
      }
      status = 'committing';
      const acknowledgement = await port.commit(selectedChoice);
      status = 'active';
      return acknowledgement;
    } catch (error) {
      status = 'failed';
      throw error;
    }
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    if (disposed) return Promise.resolve(snapshot());
    disposed = true;
    status = 'disposing';
    disposePromise = (async () => {
      const errors = [];
      try {
        await port.dispose();
      } catch (error) {
        errors.push(error);
      }
      try {
        await liveReload.dispose();
      } catch (error) {
        errors.push(error);
      }
      latestValidResult = null;
      started = false;
      status = 'disposed';
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'browser preview runtime bridge disposal failed');
      }
      return snapshot();
    })();
    return disposePromise;
  }

  return Object.freeze({
    start,
    accept,
    commit,
    defer,
    restart,
    dispose,
    getState: snapshot,
    async whenIdle() {
      await Promise.all([startPromise, port.whenIdle()].filter(Boolean));
      await liveReload.whenIdle();
      return snapshot();
    },
  });
}
