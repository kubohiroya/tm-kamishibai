import {loadDsl4BrowserTurboWarpPlatform} from '../dsl4/browser-turbowarp-platform.js';
import {dsl4StandardProductionFeatureFlags} from '../dsl4/feature-flags.js';
import {dsl4BrowserPreviewArtifactLimits} from '../dsl4/browser-preview-artifact-limits.js';
import {deepFreeze} from '../dsl4/story-document.js';
import {dsl4CliDefaultLimits} from './dsl4-cli-default-limits.js';
import {createDsl4LocalPreviewBrowserClient} from './dsl4-local-preview-browser-client.js';

export const dsl4LocalPreviewBrowserBootstrapDefaults = deepFreeze({
  maxSourceBytes: dsl4CliDefaultLimits.maxSourceBytes,
  maxAssetFiles: 64,
  maxAssetBytes: dsl4BrowserPreviewArtifactLimits.defaults.maxAssetBytes,
});

export const dsl4LocalPreviewBrowserBootstrapMaximums = deepFreeze({
  maxSourceBytes: dsl4CliDefaultLimits.maxSourceBytes,
  maxAssetFiles: dsl4CliDefaultLimits.maxAssetFiles,
  maxAssetBytes: dsl4BrowserPreviewArtifactLimits.absoluteMaximums.maxAssetBytes,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createLazyTurboWarpPlatform() {
  let platformPromise = null;
  const load = () => {
    platformPromise ??= loadDsl4BrowserTurboWarpPlatform();
    return platformPromise;
  };
  return Object.freeze({
    async createVm() {
      return (await load()).createVm();
    },
    async createRenderer(canvas: unknown) {
      return (await load()).createRenderer(canvas);
    },
    async createAudioEngine() {
      return (await load()).createAudioEngine();
    },
    async createStorage() {
      return (await load()).createStorage();
    },
    async createBitmapAdapter() {
      return (await load()).createBitmapAdapter();
    },
    async disposeRenderer(renderer: unknown) {
      return (await load()).disposeRenderer(renderer);
    },
    async disposeAudioEngine(audioEngine: unknown) {
      return (await load()).disposeAudioEngine(audioEngine);
    },
    async disposeStorage(storage: unknown) {
      return (await load()).disposeStorage(storage);
    },
    async disposeBitmapAdapter(bitmapAdapter: unknown) {
      return (await load()).disposeBitmapAdapter(bitmapAdapter);
    },
  });
}

/** Compose the browser-owned local preview client from explicit browser and pose boundaries. */
export function createDsl4LocalPreviewBrowserBootstrap(optionsInput: object) {
  if (!isRecord(optionsInput)) {
    throw new TypeError('local preview browser bootstrap options are required');
  }
  const options = optionsInput as Record<string, any>;
  const globalObject = isRecord(options.globalObject)
    ? (options.globalObject as Record<string, any>)
    : (globalThis as Record<string, any>);
  if (!isRecord(options.sourceFrontend) || typeof options.sourceFrontend.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse');
  }
  const getTMRuntime =
    typeof options.getTMRuntime === 'function' ? options.getTMRuntime : () => options.tmPoseRuntime;
  if (
    typeof options.getTMRuntime !== 'function' &&
    (!isRecord(options.tmPoseRuntime) ||
      typeof options.tmPoseRuntime.Webcam !== 'function' ||
      typeof options.tmPoseRuntime.loadFromFiles !== 'function')
  ) {
    throw new TypeError('tmPoseRuntime must provide Webcam and loadFromFiles');
  }
  if (!isRecord(globalObject.crypto) || typeof globalObject.crypto.randomUUID !== 'function') {
    throw new TypeError('browser crypto.randomUUID is required');
  }
  const sessionId = options.sessionId ?? `browser-${globalObject.crypto.randomUUID()}`;
  return createDsl4LocalPreviewBrowserClient({
    document: globalObject.document,
    location: globalObject.location,
    history: globalObject.history,
    eventTarget: globalObject,
    fetch: globalObject.fetch.bind(globalObject),
    sourceFrontend: options.sourceFrontend,
    platform: createLazyTurboWarpPlatform(),
    runtimeOptions: {
      get tmPoseRuntime() {
        return getTMRuntime();
      },
      setLoading() {},
    },
    sessionId,
    featureFlags: {...dsl4StandardProductionFeatureFlags, ...(options.featureFlags ?? {})},
    maxProjectBytes: options.maxProjectBytes,
    maxProjectJsonBytes: options.maxProjectJsonBytes,
    maxSourceBytes:
      options.maxSourceBytes ?? dsl4LocalPreviewBrowserBootstrapDefaults.maxSourceBytes,
    maxAssetFiles: options.maxAssetFiles ?? dsl4LocalPreviewBrowserBootstrapDefaults.maxAssetFiles,
    maxAssetBytes: options.maxAssetBytes ?? dsl4LocalPreviewBrowserBootstrapDefaults.maxAssetBytes,
    subtleCrypto: globalObject.crypto.subtle,
    onApplicationOpen: options.onApplicationOpen,
    onRuntimeEvent: options.onRuntimeEvent,
    onError: options.onError,
  });
}
