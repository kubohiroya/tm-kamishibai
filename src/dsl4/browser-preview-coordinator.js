import {createDsl4BrowserPreviewSourceAdapter} from './browser-preview-source-adapter.js';
import {createDsl4PreviewSourceProtocolPort} from './preview-source-protocol-port.js';
import {deepFreeze} from './story-document.js';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Compose the browser filesystem source with the transport-neutral preview protocol port.
 *
 * @param {object} options
 * @param {Record<string, Function>} options.protocolSession
 * @param {string} options.sessionId
 * @param {{parse: Function}} options.sourceFrontend
 * @param {number} options.maxSourceBytes
 * @param {ReadonlyArray<string>} [options.capabilities]
 * @param {Record<string, unknown>} [options.sourceOptions]
 * @param {(result: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.onSourceResult]
 * @param {(event: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.onProtocolEvent]
 * @param {(state: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.onSourceStatus]
 * @param {(diagnostic: Readonly<Record<string, unknown>> | null) => unknown | Promise<unknown>} [options.onSourceDiagnostic]
 * @param {(error: unknown) => unknown} [options.onError]
 */
export function createDsl4BrowserPreviewCoordinator(options) {
  if (!isRecord(options)) throw new TypeError('browser preview coordinator options are required');
  if (options.sourceOptions !== undefined && !isRecord(options.sourceOptions)) {
    throw new TypeError('sourceOptions must be an object');
  }
  const sourceOptions = options.sourceOptions ?? {};
  for (const reserved of [
    'sourceFrontend',
    'maxSourceBytes',
    'onResult',
    'onStatus',
    'onDiagnostic',
    'onError',
  ]) {
    if (Object.hasOwn(sourceOptions, reserved)) {
      throw new TypeError(`sourceOptions must not override ${reserved}`);
    }
  }
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new TypeError('onError must be a function');
  }
  if (options.onSourceResult !== undefined && typeof options.onSourceResult !== 'function') {
    throw new TypeError('onSourceResult must be a function');
  }
  /** @param {unknown} error */
  const reportError = (error) => {
    try {
      options.onError?.(error);
    } catch {
      // Error observers cannot change coordinator state.
    }
  };
  const protocol = createDsl4PreviewSourceProtocolPort({
    protocolSession: options.protocolSession,
    sessionId: options.sessionId,
    capabilities: options.capabilities,
    onEvent: options.onProtocolEvent,
    onError: reportError,
  });
  /** @type {Promise<unknown>} */
  let protocolReady = Promise.resolve(protocol.getState());
  const source = createDsl4BrowserPreviewSourceAdapter({
    ...sourceOptions,
    sourceFrontend: options.sourceFrontend,
    maxSourceBytes: options.maxSourceBytes,
    onResult(result) {
      try {
        Promise.resolve(options.onSourceResult?.(result)).catch(reportError);
      } catch (error) {
        reportError(error);
      }
      try {
        protocolReady.then(() => protocol.stage(result)).catch(reportError);
      } catch (error) {
        reportError(error);
      }
    },
    onStatus: options.onSourceStatus,
    onDiagnostic: options.onSourceDiagnostic,
    onError: reportError,
  });

  let disposed = false;
  /** @type {Promise<Readonly<Record<string, unknown>>> | null} */
  let disposePromise = null;

  function snapshot() {
    return deepFreeze({
      version: 1,
      disposed,
      source: source.getState(),
      protocol: protocol.getState(),
    });
  }

  /** @param {() => unknown | Promise<unknown>} operation */
  async function startSource(operation) {
    if (disposed) throw new TypeError('browser preview coordinator is disposed');
    protocolReady = protocol.connect();
    await protocolReady;
    await operation();
    await protocol.whenIdle();
    return snapshot();
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    if (disposed) return Promise.resolve(snapshot());
    disposed = true;
    source.dispose();
    disposePromise = protocol.dispose().then(snapshot);
    return disposePromise;
  }

  return Object.freeze({
    openProject() {
      if (disposed) throw new TypeError('browser preview coordinator is disposed');
      protocolReady = protocol.connect();
      const opening = source.openProject();
      return Promise.all([protocolReady, opening])
        .then(() => protocol.whenIdle())
        .then(snapshot);
    },
    /** @param {unknown} projectRoot */
    start(projectRoot) {
      return startSource(() => source.start(projectRoot));
    },
    async pollNow() {
      if (disposed) throw new TypeError('browser preview coordinator is disposed');
      await source.pollNow();
      await protocol.whenIdle();
      return snapshot();
    },
    /** @param {'storyStart' | 'currentScene' | 'currentAction'} choice */
    async commit(choice) {
      const result = await protocol.commit(choice);
      return deepFreeze({result, state: snapshot()});
    },
    async defer() {
      const result = await protocol.defer();
      return deepFreeze({result, state: snapshot()});
    },
    dispose,
    getState: snapshot,
    async whenIdle() {
      await source.whenIdle();
      await protocol.whenIdle();
      return snapshot();
    },
  });
}
