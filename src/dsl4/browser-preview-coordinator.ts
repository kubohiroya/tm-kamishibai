import {createDsl4BrowserPreviewSourceAdapter} from './browser-preview-source-adapter.js';
import {createDsl4PreviewSourceProtocolPort} from './preview-source-protocol-port.js';
import {deepFreeze} from './story-document.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Compose the browser filesystem source with the transport-neutral preview protocol port. */
export function createDsl4BrowserPreviewCoordinator(options: {
  protocolSession: Record<string, Function>;
  sessionId: string;
  sourceFrontend: {
    parse(source: string, options?: {sourceId?: string}): Readonly<Record<string, any>>;
  };
  maxSourceBytes: number;
  featureFlags?: unknown;
  maxSourceFiles?: number;
  maxTotalSourceBytes?: number;
  maxIncludeDepth?: number;
  capabilities?: ReadonlyArray<string>;
  sourceOptions?: Record<string, unknown>;
  onProjectRoot?: (projectRoot: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
  onSourceResult?: (result: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
  beforeSourceStage?: (result: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
  onProtocolEvent?: (event: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
  onSourceStatus?: (state: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
  onSourceDiagnostic?: (
    diagnostic: Readonly<Record<string, unknown>> | null,
  ) => unknown | Promise<unknown>;
  onError?: (error: unknown) => unknown;
}) {
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
  const reportError = (error: unknown) => {
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
  let protocolReady: Promise<unknown> = Promise.resolve(protocol.getState());
  let latestValidSourceResult: Readonly<Record<string, unknown>> | null = null;
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
  let disposePromise: Promise<Readonly<Record<string, unknown>>> | null = null;

  function snapshot() {
    return deepFreeze({
      version: 1,
      disposed,
      source: source.getState(),
      protocol: protocol.getState(),
    });
  }

  async function startSource(operation: () => unknown | Promise<unknown>) {
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
    start(projectRoot: unknown) {
      return startSource(() => source.start(projectRoot));
    },
    async pollNow() {
      if (disposed) throw new TypeError('browser preview coordinator is disposed');
      await source.pollNow();
      await protocol.whenIdle();
      return snapshot();
    },
    async commit(choice: 'storyStart' | 'currentScene' | 'currentAction') {
      const result = await protocol.commit(choice);
      return deepFreeze({result, state: snapshot()});
    },
    async restart(choice: 'storyStart' | 'currentScene' | 'currentAction') {
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
