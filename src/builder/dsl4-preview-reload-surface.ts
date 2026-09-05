import {createDsl4PreviewLayoutCoordinator} from '../dsl4/preview-layout-coordinator.js';
import {createDsl4PreviewReloadPolicy} from '../dsl4/preview-reload-policy.js';
import {deepFreeze} from '../dsl4/story-document.js';
import {
  createDsl4PreviewReloadOverlay,
  dsl4PreviewReloadOverlayManifest,
} from './dsl4-preview-reload-overlay.js';

const channels = new Set(['source', 'asset']);
const watchStates = new Set(['watching', 'stabilizing', 'paused', 'disconnected']);
const watchPriority = Object.freeze(['stabilizing', 'paused', 'disconnected', 'watching']);

export const dsl4PreviewReloadSurfaceManifest = deepFreeze({
  formatVersion: 1,
  production: false,
  featureFlag: 'dsl4PreviewReloadOverlay',
  surfaces: dsl4PreviewReloadOverlayManifest.surfaces,
  candidateChannels: ['source', 'asset'],
  ownsGlobalRevisionOrder: true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function callback(value: unknown, name: string) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

function candidateInput(value: unknown) {
  if (!isRecord(value) || typeof value.channel !== 'string' || !channels.has(value.channel)) {
    throw new TypeError('reload surface candidate channel must be source or asset');
  }
  if (!Number.isSafeInteger(value.channelRevision) || Number(value.channelRevision) < 1) {
    throw new TypeError('reload surface channelRevision must be a positive safe integer');
  }
  return {
    channel: value.channel,
    channelRevision: Number(value.channelRevision),
    availability: value.availability,
    changedIds: value.changedIds,
    initiatingInputId: value.initiatingInputId,
    apply: callback(value.apply, 'candidate.apply'),
    restart: callback(value.restart, 'candidate.restart'),
  };
}

function diagnosticInput(value: unknown) {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string') {
    throw new TypeError('reload surface diagnostic is invalid');
  }
  return deepFreeze({
    code: value.code,
    severity: value.severity === 'warning' ? 'warning' : 'error',
    message: value.message,
  });
}

/**
 * Compose the shared policy, layout coordinator, and DOM overlay for Web and CLI browser hosts.
 * A surface-local revision order serializes source and asset candidates without combining them.
 */
export function createDsl4PreviewReloadSurface(options: {
  surface: 'web' | 'cli';
  environment: 'development';
  document: unknown;
  mount: unknown;
  viewport: unknown;
  safeArea?: unknown;
  debugExecution?: Parameters<typeof createDsl4PreviewReloadOverlay>[0]['debugExecution'];
  clock?: Parameters<typeof createDsl4PreviewReloadPolicy>[0]['clock'];
  storage?: Parameters<typeof createDsl4PreviewReloadOverlay>[0]['storage'];
  reducedMotion?: boolean;
  formatTime?: (timestamp: number) => string;
  onError?: (error: unknown) => unknown;
}) {
  if (!isRecord(options)) throw new TypeError('reload surface options are required');
  if (options.environment !== 'development') {
    throw new TypeError('reload surface is available only in the development environment');
  }
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new TypeError('onError must be a function');
  }

  let disposed = false;
  let globalRevision = 0;
  const drivers = new Map();
  const diagnostics = new Map();
  const channelWatchStates = new Map();

  function reportError(error: unknown) {
    try {
      options.onError?.(error);
    } catch {
      // Error observers cannot change shared reload state.
    }
  }

  async function runDriver(request: Readonly<Record<string, any>>, operation: 'apply' | 'restart') {
    const driver = drivers.get(request.revision);
    if (!driver) throw new TypeError('reload surface generation driver is stale or missing');
    await driver[operation](
      deepFreeze({
        ...request,
        channel: driver.channel,
        channelRevision: driver.channelRevision,
      }),
    );
    return deepFreeze({
      revision: request.revision,
      actualAnchor: request.actualAnchor,
      fallbackReason: request.fallbackReason,
    });
  }

  const policy = createDsl4PreviewReloadPolicy({
    clock: options.clock,
    applyGeneration: (request) => runDriver(request, 'apply'),
    restartGeneration: (request) => runDriver(request, 'restart'),
    onError: reportError,
  });
  const layoutCoordinator = createDsl4PreviewLayoutCoordinator({
    viewport: options.viewport,
    safeArea: options.safeArea,
  });
  const overlay = createDsl4PreviewReloadOverlay({
    surface: options.surface as 'web' | 'cli',
    document: options.document,
    mount: options.mount,
    policy,
    layoutCoordinator,
    debugExecution: options.debugExecution,
    ...(options.storage === undefined ? {} : {storage: options.storage}),
    ...(options.formatTime === undefined ? {} : {formatTime: options.formatTime}),
    ...(options.reducedMotion === undefined ? {} : {reducedMotion: options.reducedMotion}),
    onError: reportError,
  });
  const document = options.document as Record<string, any>;
  const browserWindow = isRecord(document.defaultView) ? document.defaultView : null;
  const geometryListenerCleanup: Array<() => void> = [];
  let resizeObserver: {disconnect: Function; observe?: Function} | null = null;

  function measuredViewport() {
    const fullscreen = isRecord(document.fullscreenElement) ? document.fullscreenElement : null;
    const documentElement = isRecord(document.documentElement) ? document.documentElement : null;
    const mount = isRecord(options.mount) ? options.mount : null;
    const previous = layoutCoordinator.getState().viewport;
    const width = [
      fullscreen?.clientWidth,
      documentElement?.clientWidth,
      browserWindow?.innerWidth,
      mount?.clientWidth,
      previous.width,
    ].find((value) => Number.isFinite(value) && Number(value) >= 44);
    const height = [
      fullscreen?.clientHeight,
      documentElement?.clientHeight,
      browserWindow?.innerHeight,
      mount?.clientHeight,
      previous.height,
    ].find((value) => Number.isFinite(value) && Number(value) >= 44);
    return {width: Number(width), height: Number(height)};
  }

  function refreshBrowserGeometry() {
    if (disposed) return;
    try {
      layoutCoordinator.updateViewport(measuredViewport());
      overlay.refreshLayout();
    } catch (error) {
      reportError(error);
    }
  }

  function listenGeometry(target: Record<string, any>, type: string) {
    if (typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, refreshBrowserGeometry);
    geometryListenerCleanup.push(() => target.removeEventListener(type, refreshBrowserGeometry));
  }
  if (browserWindow) {
    listenGeometry(browserWindow, 'resize');
    listenGeometry(browserWindow, 'orientationchange');
    if (typeof browserWindow.ResizeObserver === 'function') {
      const ResizeObserverConstructor = browserWindow.ResizeObserver as new (
        callback: Function,
      ) => {disconnect: Function; observe?: Function};
      const observer = new ResizeObserverConstructor(refreshBrowserGeometry);
      observer.observe?.(options.mount);
      resizeObserver = observer;
    }
  }
  listenGeometry(document, 'fullscreenchange');

  async function publishDiagnostic() {
    const ordered = [...diagnostics.entries()].sort(
      ([leftChannel, left], [rightChannel, right]) =>
        Number(right.severity === 'error') - Number(left.severity === 'error') ||
        leftChannel.localeCompare(rightChannel),
    );
    await policy.setDiagnostic(ordered[0]?.[1] ?? null);
  }

  async function publishWatchState() {
    const selected = watchPriority.find((state) =>
      [...channelWatchStates.values()].includes(state),
    );
    await policy.setWatchState(
      (selected ?? 'watching') as 'watching' | 'stabilizing' | 'paused' | 'disconnected',
    );
  }

  function snapshot() {
    return deepFreeze({
      version: 1,
      disposed,
      globalRevision,
      candidateChannels: [...drivers.entries()].map(([revision, driver]) => ({
        revision,
        channel: driver.channel,
        channelRevision: driver.channelRevision,
      })),
      diagnosticChannels: [...diagnostics.keys()].sort(),
      watchChannels: [...channelWatchStates.entries()]
        .map(([channel, status]) => ({channel, status}))
        .sort((left, right) => left.channel.localeCompare(right.channel)),
      overlay: overlay.getSnapshot(),
    });
  }

  return Object.freeze({
    enabled: true,
    element: overlay.element,
    policy,
    layoutCoordinator,
    async submitCandidate(input: unknown) {
      if (disposed) throw new TypeError('reload surface is disposed');
      const selected = candidateInput(input);
      const revision = ++globalRevision;
      drivers.set(revision, {
        channel: selected.channel,
        channelRevision: selected.channelRevision,
        apply: selected.apply,
        restart: selected.restart,
      });
      const result = (await policy.submitCandidate({
        revision,
        availability: selected.availability,
        summary: {
          category: selected.channel,
          changedIds: selected.changedIds,
        },
        initiatingInputId: selected.initiatingInputId,
      })) as Record<string, any>;
      for (const storedRevision of [...drivers.keys()]) {
        if (storedRevision < result.latestAppliedRevision) drivers.delete(storedRevision);
      }
      return snapshot();
    },
    async setDiagnostic(channel: 'source' | 'asset', value: unknown) {
      if (!channels.has(channel)) throw new TypeError('diagnostic channel must be source or asset');
      if (value === null) diagnostics.delete(channel);
      else diagnostics.set(channel, diagnosticInput(value));
      await publishDiagnostic();
      return snapshot();
    },
    async setWatchState(channel: 'source' | 'asset', value: unknown) {
      if (!channels.has(channel)) throw new TypeError('watch channel must be source or asset');
      if (typeof value !== 'string' || !watchStates.has(value)) {
        throw new TypeError('reload watch state is invalid');
      }
      channelWatchStates.set(channel, value);
      await publishWatchState();
      return snapshot();
    },
    acknowledgePreviewInput: overlay.acknowledgePreviewInput,
    registerReservedRect(owner: string, rect: unknown) {
      const registered = layoutCoordinator.register(owner, rect);
      overlay.refreshLayout();
      return registered;
    },
    updateReservedRect(owner: string, rect: unknown) {
      layoutCoordinator.update(owner, rect);
      overlay.refreshLayout();
    },
    unregisterReservedRect(owner: string) {
      layoutCoordinator.unregister(owner);
      overlay.refreshLayout();
    },
    updateViewport(value: unknown, safeArea?: unknown) {
      layoutCoordinator.updateViewport(value, safeArea);
      overlay.refreshLayout();
      return snapshot();
    },
    getSnapshot: snapshot,
    async whenIdle() {
      await overlay.whenIdle();
      await policy.whenIdle();
      return snapshot();
    },
    async dispose() {
      if (disposed) return snapshot();
      disposed = true;
      for (const remove of geometryListenerCleanup.splice(0).reverse()) remove();
      resizeObserver?.disconnect();
      resizeObserver = null;
      overlay.dispose();
      await policy.dispose();
      drivers.clear();
      diagnostics.clear();
      channelWatchStates.clear();
      return snapshot();
    },
  });
}
