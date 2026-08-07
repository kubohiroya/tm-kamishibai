import schema from '../../schema/dsl-4.schema.json' with {type: 'json'};

import {Buffer} from 'buffer';

import {loadDsl4BrowserTurboWarpPlatform} from '../dsl4/browser-turbowarp-platform.js';
import {createDsl4LocalPreviewBrowserClient} from './dsl4-local-preview-browser-client.js';
import {createDsl4ProductionSourceFrontend} from './dsl4-source-frontend.js';

/** @type {Record<string, any>} */ (globalThis).Buffer ??= Buffer;

const limits = Object.freeze({
  maxSourceBytes: 64 * 1024,
  maxAssetFiles: 64,
  maxAssetBytes: 64 * 1024 * 1024,
});

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
    /** @param {unknown} canvas */
    async createRenderer(canvas) {
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
    /** @param {unknown} renderer */
    async disposeRenderer(renderer) {
      return (await load()).disposeRenderer(renderer);
    },
    /** @param {unknown} audioEngine */
    async disposeAudioEngine(audioEngine) {
      return (await load()).disposeAudioEngine(audioEngine);
    },
    /** @param {unknown} storage */
    async disposeStorage(storage) {
      return (await load()).disposeStorage(storage);
    },
    /** @param {unknown} bitmapAdapter */
    async disposeBitmapAdapter(bitmapAdapter) {
      return (await load()).disposeBitmapAdapter(bitmapAdapter);
    },
  });
}

function resolveTMPoseRuntime() {
  const candidate = /** @type {Record<string, any>} */ (globalThis).tmPose;
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.Webcam === 'function' &&
    typeof candidate.loadFromFiles === 'function'
  ) {
    return candidate;
  }
  return Object.freeze({
    Webcam: class MissingTMPoseWebcam {},
    async loadFromFiles() {
      throw new Error('This preview requires the Teachable Machine Pose browser runtime.');
    },
  });
}

const runtimeOptions = {
  get tmPoseRuntime() {
    return resolveTMPoseRuntime();
  },
  setLoading() {},
};

const client = createDsl4LocalPreviewBrowserClient({
  document: globalThis.document,
  location: globalThis.location,
  history: globalThis.history,
  eventTarget: globalThis,
  fetch: globalThis.fetch.bind(globalThis),
  sourceFrontend: createDsl4ProductionSourceFrontend(schema),
  platform: createLazyTurboWarpPlatform(),
  runtimeOptions,
  sessionId: `browser-${globalThis.crypto.randomUUID()}`,
  featureFlags: {dsl4Runtime: true},
  ...limits,
  subtleCrypto: globalThis.crypto.subtle,
});

void client.start().catch(() => {
  // The client renders its bounded startup diagnostic and remains available for page cleanup.
});
