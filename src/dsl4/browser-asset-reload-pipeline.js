import {createDsl4AssetReloadProtocolSession} from './asset-reload-protocol.js';
import {createDsl4AssetReloadTransaction} from './asset-reload-transaction.js';
import {createDsl4BrowserPreviewAssetAdapter} from './browser-preview-asset-adapter.js';
import {deepFreeze} from './story-document.js';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Wire the browser filesystem adapter to the transport-neutral asset transaction and protocol.
 * The caller supplies the platform generation preparation at the existing runtime safe boundary.
 *
 * @param {object} options
 * @param {string} options.sessionId
 * @param {ReadonlyArray<string>} [options.negotiatedCapabilities]
 * @param {(input: Readonly<{summary: Readonly<Record<string, unknown>>, provider: Readonly<Record<string, unknown>>, signal: AbortSignal}>) => unknown | Promise<unknown>} options.prepareGeneration
 * @param {Record<string, unknown>} options.adapterOptions
 * @param {(event: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.onEvent]
 * @param {(diagnostic: Readonly<Record<string, unknown>> | null) => unknown | Promise<unknown>} [options.onDiagnostic]
 * @param {(state: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.onWatchStatus]
 * @param {(error: unknown) => unknown} [options.onError]
 * @param {Record<string, Function>} [options.reloadSurface]
 * @param {(request: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.restartGeneration]
 * @param {(event: Readonly<Record<string, unknown>>) => unknown} [options.resolveReloadAvailability]
 */
export function createDsl4BrowserAssetReloadPipeline(options) {
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

  /** @type {{submitCandidate: Function, setDiagnostic: Function, setWatchState: Function} | null} */
  let reloadSurface = null;
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

  /** @param {unknown} error */
  function reportError(error) {
    try {
      options.onError?.(error);
    } catch {
      // Error observers cannot change pipeline state.
    }
  }

  /** @param {Readonly<Record<string, any>>} event */
  function assetAvailability(event) {
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

  /** @param {Readonly<Record<string, any>>} event */
  function submitReloadCandidate(event) {
    if (!reloadSurface || event.type !== 'preview.asset.staged') return;
    const changedIds = Array.isArray(event.classification?.changedAssets)
      ? event.classification.changedAssets
          .map((/** @type {unknown} */ asset) => (isRecord(asset) ? asset.id : null))
          .filter((/** @type {unknown} */ id) => typeof id === 'string')
      : [];
    Promise.resolve(
      reloadSurface.submitCandidate({
        channel: 'asset',
        channelRevision: event.revision,
        availability: assetAvailability(event),
        changedIds,
        initiatingInputId: null,
        async apply(/** @type {Readonly<Record<string, any>>} */ request) {
          await /** @type {Record<string, Function>} */ (protocol).whenIdle();
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

  /** @type {Record<string, Function> | null} */
  let protocol = null;
  const adapter = createDsl4BrowserPreviewAssetAdapter({
    .../** @type {Record<string, any>} */ (options.adapterOptions),
    inspectImage:
      /** @type {(bytes: Uint8Array, context: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} */ (
        options.adapterOptions.inspectImage
      ),
    inspectAudio:
      /** @type {(bytes: Uint8Array, context: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} */ (
        options.adapterOptions.inspectAudio
      ),
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
  /** @type {Promise<Readonly<Record<string, unknown>>> | null} */
  let disposePromise = null;

  function snapshot() {
    return deepFreeze({
      version: 1,
      started,
      disposed,
      adapter: adapter.getState(),
      protocol: /** @type {Record<string, Function>} */ (protocol).getState(),
      transaction: transaction.getState(),
    });
  }

  /** @param {unknown} projectRoot @param {unknown} context */
  async function start(projectRoot, context) {
    if (started || disposed) throw new TypeError('browser asset pipeline can only start once');
    started = true;
    await adapter.start(projectRoot, context);
    await /** @type {Record<string, Function>} */ (protocol).whenIdle();
    return snapshot();
  }

  /** @param {unknown} context */
  async function updateSource(context) {
    if (!started || disposed) throw new TypeError('browser asset pipeline is not active');
    await adapter.updateSource(context);
    await /** @type {Record<string, Function>} */ (protocol).whenIdle();
    return snapshot();
  }

  async function pollNow() {
    if (!started || disposed) throw new TypeError('browser asset pipeline is not active');
    await adapter.pollNow();
    await /** @type {Record<string, Function>} */ (protocol).whenIdle();
    return snapshot();
  }

  /** @param {Readonly<Record<string, unknown>>} [request] */
  async function commit(request = {}) {
    if (!isRecord(request)) throw new TypeError('browser asset commit request must be an object');
    const revision = /** @type {Record<string, Function>} */ (protocol).getState()
      .candidateRevision;
    if (!Number.isSafeInteger(revision) || Number(revision) < 1) {
      throw new TypeError('browser asset pipeline has no candidate');
    }
    const result = await /** @type {Record<string, Function>} */ (protocol).commit({
      type: 'preview.asset.commit',
      sessionId: options.sessionId,
      revision,
      request,
    });
    return deepFreeze({result, state: snapshot()});
  }

  async function defer() {
    const revision = /** @type {Record<string, Function>} */ (protocol).getState()
      .candidateRevision;
    if (!Number.isSafeInteger(revision) || Number(revision) < 1) {
      throw new TypeError('browser asset pipeline has no candidate');
    }
    const result = await /** @type {Record<string, Function>} */ (protocol).defer({
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
      .then(() => /** @type {Record<string, Function>} */ (protocol).disconnect())
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
    setHidden: (/** @type {boolean} */ value) => adapter.setHidden(value),
    getState: snapshot,
    async whenIdle() {
      await adapter.whenIdle();
      await /** @type {Record<string, Function>} */ (protocol).whenIdle();
      await transaction.whenIdle();
      return snapshot();
    },
  });
}
