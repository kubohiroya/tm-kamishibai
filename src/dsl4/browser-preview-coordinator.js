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
 * @param {{parse(source: string, options?: {sourceId?: string}): Readonly<Record<string, any>>}} options.sourceFrontend
 * @param {number} options.maxSourceBytes
 * @param {unknown} [options.featureFlags]
 * @param {number} [options.maxSourceFiles]
 * @param {number} [options.maxTotalSourceBytes]
 * @param {number} [options.maxIncludeDepth]
 * @param {ReadonlyArray<string>} [options.capabilities]
 * @param {Record<string, unknown>} [options.sourceOptions]
 * @param {(projectRoot: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.onProjectRoot]
 * @param {(result: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.onSourceResult]
 * @param {(result: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.beforeSourceStage]
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
    'featureFlags',
    'maxSourceFiles',
    'maxTotalSourceBytes',
    'maxIncludeDepth',
    'onResult',
    'onProjectRoot',
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
  if (options.beforeSourceStage !== undefined && typeof options.beforeSourceStage !== 'function') {
    throw new TypeError('beforeSourceStage must be a function');
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
  /** @type {Readonly<Record<string, unknown>> | null} */
  let latestValidSourceResult = null;
  const source = createDsl4BrowserPreviewSourceAdapter({
    ...sourceOptions,
    sourceFrontend: options.sourceFrontend,
    maxSourceBytes: options.maxSourceBytes,
    featureFlags: options.featureFlags,
    maxSourceFiles: options.maxSourceFiles,
    maxTotalSourceBytes: options.maxTotalSourceBytes,
    maxIncludeDepth: options.maxIncludeDepth,
    onProjectRoot: options.onProjectRoot,
    async onResult(result) {
      await options.beforeSourceStage?.(result);
      try {
        Promise.resolve(options.onSourceResult?.(result)).catch(reportError);
      } catch (error) {
        reportError(error);
      }
      await protocolReady;
      await protocol.stage(result);
      if (result.ok === true) latestValidSourceResult = result;
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
    latestValidSourceResult = null;
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
    /** @param {'storyStart' | 'currentScene' | 'currentAction'} choice */
    async restart(choice) {
      if (disposed) throw new TypeError('browser preview coordinator is disposed');
      if (!['storyStart', 'currentScene', 'currentAction'].includes(choice)) {
        throw new TypeError('preview restart choice is invalid');
      }
      if (!latestValidSourceResult) {
        throw new TypeError('browser preview coordinator has no validated source generation');
      }
      await protocol.stage(latestValidSourceResult);
      await protocol.whenIdle();
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
