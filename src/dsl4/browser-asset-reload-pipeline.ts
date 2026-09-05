import {createDsl4AssetReloadProtocolSession} from './asset-reload-protocol.js';
import {createDsl4AssetReloadTransaction} from './asset-reload-transaction.js';
import {createDsl4BrowserPreviewAssetAdapter} from './browser-preview-asset-adapter.js';
import {deepFreeze} from './story-document.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Wire the browser filesystem adapter to the transport-neutral asset transaction and protocol.
 * The caller supplies the platform generation preparation at the existing runtime safe boundary.
 */
export function createDsl4BrowserAssetReloadPipeline(options: {
  sessionId: string;
  negotiatedCapabilities?: ReadonlyArray<string>;
  prepareGeneration: (
    input: Readonly<{
      summary: Readonly<Record<string, unknown>>;
      provider: Readonly<Record<string, unknown>>;
      signal: AbortSignal;
    }>,
  ) => unknown | Promise<unknown>;
  adapterOptions: Record<string, unknown>;
  onEvent?: (event: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
  onDiagnostic?: (
    diagnostic: Readonly<Record<string, unknown>> | null,
  ) => unknown | Promise<unknown>;
  onWatchStatus?: (state: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
  onError?: (error: unknown) => unknown;
  reloadSurface?: Record<string, Function>;
  restartGeneration?: (request: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
  resolveReloadAvailability?: (event: Readonly<Record<string, unknown>>) => unknown;
}) {
  if (!isRecord(options)) throw new TypeError('browser asset pipeline options are required');
  if (!isRecord(options.adapterOptions)) {
    throw new TypeError('browser asset pipeline adapterOptions are required');
  }
  if (
    typeof options.adapterOptions.inspectImage !== 'function' ||
    typeof options.adapterOptions.inspectAudio !== 'function'
  ) {
    throw new TypeError('adapterOptions must provide image and audio inspectors');
  }
  for (const reserved of ['onCandidate', 'onDiagnostic', 'onStatus', 'onError']) {
    if (Object.hasOwn(options.adapterOptions, reserved)) {
      throw new TypeError(`adapterOptions must not override ${reserved}`);
    }
  }
  if (options.onEvent !== undefined && typeof options.onEvent !== 'function') {
    throw new TypeError('onEvent must be a function');
  }
  if (options.onDiagnostic !== undefined && typeof options.onDiagnostic !== 'function') {
    throw new TypeError('onDiagnostic must be a function');
  }
  if (options.onWatchStatus !== undefined && typeof options.onWatchStatus !== 'function') {
    throw new TypeError('onWatchStatus must be a function');
  }
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new TypeError('onError must be a function');
  }
  if (options.restartGeneration !== undefined && typeof options.restartGeneration !== 'function') {
    throw new TypeError('restartGeneration must be a function');
  }
  if (
    options.resolveReloadAvailability !== undefined &&
    typeof options.resolveReloadAvailability !== 'function'
  ) {
    throw new TypeError('resolveReloadAvailability must be a function');
  }

  let reloadSurface: {
    submitCandidate: Function;
    setDiagnostic: Function;
    setWatchState: Function;
  } | null = null;
  if (options.reloadSurface !== undefined) {
    if (!isRecord(options.reloadSurface)) {
      throw new TypeError('reloadSurface must be an object');
    }
    const submitCandidate =
      options.reloadSurface.submitCandidate ?? options.reloadSurface.submitReloadCandidate;
    const setDiagnostic =
      options.reloadSurface.setDiagnostic ?? options.reloadSurface.setReloadDiagnostic;
    const setWatchState =
      options.reloadSurface.setWatchState ?? options.reloadSurface.setReloadWatchState;
    if (
      typeof submitCandidate !== 'function' ||
      typeof setDiagnostic !== 'function' ||
      typeof setWatchState !== 'function'
    ) {
      throw new TypeError('reloadSurface does not implement the shared reload bridge');
    }
    if (typeof options.restartGeneration !== 'function') {
      throw new TypeError('reloadSurface requires restartGeneration');
    }
    reloadSurface = {submitCandidate, setDiagnostic, setWatchState};
  }

  function reportError(error: unknown) {
    try {
      options.onError?.(error);
    } catch {
      // Error observers cannot change pipeline state.
    }
  }

  function assetAvailability(event: Readonly<Record<string, any>>) {
    if (options.resolveReloadAvailability) return options.resolveReloadAvailability(event);
    return deepFreeze({
      story: {available: true, reason: null},
      scene: {available: true, reason: null},
      action: {
        available: false,
        replaySafe: false,
        reason: 'The asset driver did not prove the current action replay-safe.',
      },
    });
  }

  function submitReloadCandidate(event: Readonly<Record<string, any>>) {
    if (!reloadSurface || event.type !== 'preview.asset.staged') return;
    const changedIds = Array.isArray(event.classification?.changedAssets)
      ? event.classification.changedAssets
          .map((asset: unknown) => (isRecord(asset) ? asset.id : null))
          .filter((id: unknown) => typeof id === 'string')
      : [];
    Promise.resolve(
      reloadSurface.submitCandidate({
        channel: 'asset',
        channelRevision: event.revision,
        availability: assetAvailability(event),
        changedIds,
        initiatingInputId: null,
        async apply(request: Readonly<Record<string, any>>) {
          await (protocol as Record<string, Function>).whenIdle();
          const committed = await commit({
            requestedPreference: request.requestedPreference,
            actualAnchor: request.actualAnchor,
            fallbackReason: request.fallbackReason,
          });
          if (committed.result.type !== 'preview.asset.committed') {
            throw new TypeError('asset generation commit was not acknowledged');
          }
        },
        restart: options.restartGeneration,
      }),
    ).catch(reportError);
  }

  let protocol: Record<string, Function> | null = null;
  const adapter = createDsl4BrowserPreviewAssetAdapter({
    ...(options.adapterOptions as Record<string, any>),
    inspectImage: options.adapterOptions.inspectImage as (
      bytes: Uint8Array,
      context: Readonly<Record<string, unknown>>,
    ) => unknown | Promise<unknown>,
    inspectAudio: options.adapterOptions.inspectAudio as (
      bytes: Uint8Array,
      context: Readonly<Record<string, unknown>>,
    ) => unknown | Promise<unknown>,
    async onDiagnostic(diagnostic) {
      await options.onDiagnostic?.(diagnostic);
      await reloadSurface?.setDiagnostic('asset', diagnostic);
    },
    async onStatus(state) {
      await options.onWatchStatus?.(state);
      if (!reloadSurface) return;
      const reloadStatus =
        state.status === 'stabilizing'
          ? 'stabilizing'
          : state.status === 'disposed'
            ? 'disconnected'
            : state.hidden === true
              ? 'paused'
              : 'watching';
      await reloadSurface.setWatchState('asset', reloadStatus);
    },
    onError: reportError,
    onCandidate(candidate) {
      if (!protocol) throw new TypeError('browser asset protocol is not initialized');
      return protocol.stage({
        type: 'preview.asset.stage',
        sessionId: options.sessionId,
        summary: candidate,
      });
    },
  });
  const transaction = createDsl4AssetReloadTransaction({
    assetAdapter: adapter,
    prepareGeneration: options.prepareGeneration,
    async onEvent(event) {
      submitReloadCandidate(event);
      await options.onEvent?.(event);
    },
    async onDiagnostic(diagnostic) {
      await options.onDiagnostic?.(diagnostic);
      await reloadSurface?.setDiagnostic('asset', diagnostic);
    },
    onError: reportError,
  });
  protocol = createDsl4AssetReloadProtocolSession({
    transaction,
    sessionId: options.sessionId,
    negotiatedCapabilities: options.negotiatedCapabilities,
  });

  let started = false;
  let disposed = false;
  let disposePromise: Promise<Readonly<Record<string, unknown>>> | null = null;

  function snapshot() {
    return deepFreeze({
      version: 1,
      started,
      disposed,
      adapter: adapter.getState(),
      protocol: (protocol as Record<string, Function>).getState(),
      transaction: transaction.getState(),
    });
  }

  async function start(projectRoot: unknown, context: unknown) {
    if (started || disposed) throw new TypeError('browser asset pipeline can only start once');
    started = true;
    await adapter.start(projectRoot, context);
    await (protocol as Record<string, Function>).whenIdle();
    return snapshot();
  }

  async function updateSource(context: unknown) {
    if (!started || disposed) throw new TypeError('browser asset pipeline is not active');
    await adapter.updateSource(context);
    await (protocol as Record<string, Function>).whenIdle();
    return snapshot();
  }

  async function pollNow() {
    if (!started || disposed) throw new TypeError('browser asset pipeline is not active');
    await adapter.pollNow();
    await (protocol as Record<string, Function>).whenIdle();
    return snapshot();
  }

  async function commit(request: Readonly<Record<string, unknown>> = {}) {
    if (!isRecord(request)) throw new TypeError('browser asset commit request must be an object');
    const revision = (protocol as Record<string, Function>).getState().candidateRevision;
    if (!Number.isSafeInteger(revision) || Number(revision) < 1) {
      throw new TypeError('browser asset pipeline has no candidate');
    }
    const result = await (protocol as Record<string, Function>).commit({
      type: 'preview.asset.commit',
      sessionId: options.sessionId,
      revision,
      request,
    });
    return deepFreeze({result, state: snapshot()});
  }

  async function defer() {
    const revision = (protocol as Record<string, Function>).getState().candidateRevision;
    if (!Number.isSafeInteger(revision) || Number(revision) < 1) {
      throw new TypeError('browser asset pipeline has no candidate');
    }
    const result = await (protocol as Record<string, Function>).defer({
      type: 'preview.asset.defer',
      sessionId: options.sessionId,
      revision,
    });
    return deepFreeze({result, state: snapshot()});
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    if (disposed) return Promise.resolve(snapshot());
    disposed = true;
    disposePromise = Promise.resolve()
      .then(() => (protocol as Record<string, Function>).disconnect())
      .then(() => transaction.dispose())
      .then(snapshot);
    return disposePromise;
  }

  return Object.freeze({
    start,
    updateSource,
    pollNow,
    commit,
    defer,
    dispose,
    setHidden: (value: boolean) => adapter.setHidden(value),
    getState: snapshot,
    async whenIdle() {
      await adapter.whenIdle();
      await (protocol as Record<string, Function>).whenIdle();
      await transaction.whenIdle();
      return snapshot();
    },
  });
}
