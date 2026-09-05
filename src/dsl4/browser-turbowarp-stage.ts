import {createTurboWarpRuntimeHost} from '@kubohiroya/turbowarp-runtime-host';

import {deepFreeze} from './story-document.js';
import {dsl4BrowserPreviewArtifactLimits} from './browser-preview-artifact-limits.js';

export const dsl4BrowserTurboWarpStageDefaults = deepFreeze({
  maxProjectBytes: dsl4BrowserPreviewArtifactLimits.defaults.maxProjectBytes,
  stageWidth: 480,
  stageHeight: 360,
});

export const dsl4BrowserTurboWarpStageMaximumProjectBytes =
  dsl4BrowserPreviewArtifactLimits.absoluteMaximums.maxProjectBytes;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown, name: string, minimum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

function requiredFunction(value: unknown, name: string) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value as Function;
}

function validatePlatform(value: unknown) {
  if (!isRecord(value)) throw new TypeError('TurboWarp browser platform must be an object');
  const methods = [
    'createVm',
    'createRenderer',
    'createAudioEngine',
    'createStorage',
    'createBitmapAdapter',
    'disposeRenderer',
    'disposeAudioEngine',
    'disposeStorage',
    'disposeBitmapAdapter',
  ];
  return Object.freeze(
    Object.fromEntries(methods.map((name) => [name, requiredFunction(value[name], name)])),
  );
}

function validateVm(value: unknown) {
  if (!isRecord(value)) throw new TypeError('createVm must return a TurboWarp VM object');
  const methods = [
    'attachStorage',
    'attachRenderer',
    'attachAudioEngine',
    'attachV2BitmapAdapter',
    'setCompatibilityMode',
    'setTurboMode',
    'setCompilerOptions',
    'loadProject',
    'postIOData',
    'start',
    'clear',
    'quit',
  ];
  for (const name of methods) requiredFunction(value[name], `TurboWarp VM ${name}`);
  if (!isRecord(value.runtime) || !isRecord(value.securityManager)) {
    throw new TypeError('TurboWarp VM must expose runtime and securityManager');
  }
  return value as Record<string, any>;
}

function validateMount(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.appendChild !== 'function' ||
    typeof value.removeChild !== 'function'
  ) {
    throw new TypeError('mount must be a DOM element');
  }
  return value as Record<string, any>;
}

function validateDocument(value: unknown) {
  if (!isRecord(value) || typeof value.createElement !== 'function') {
    throw new TypeError('document must provide createElement');
  }
  return value as Record<string, any>;
}

function projectBytes(input: unknown, maximum: number) {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError('projectBytes must be a Uint8Array');
  }
  if (input.byteLength < 1 || input.byteLength > maximum) {
    throw new TypeError(`projectBytes must contain 1-${maximum} bytes`);
  }
  return new Uint8Array(input);
}

function pointerData(canvas: Record<string, any>, event: Record<string, any>) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: Number(event.clientX) - Number(bounds.left),
    y: Number(event.clientY) - Number(bounds.top),
    canvasWidth: Number(bounds.width),
    canvasHeight: Number(bounds.height),
  };
}

/**
 * Own one browser TurboWarp VM and visible stage for the lifetime of a local preview page.
 * Runtime sessions may use getRuntime after start; this owner never starts the green flag.
 */
export function createDsl4BrowserTurboWarpStage(options: {
  document: unknown;
  mount: unknown;
  projectBytes: Uint8Array;
  platform: unknown;
  maxProjectBytes?: number;
  stageWidth?: number;
  stageHeight?: number;
  prepareVm?: (vm: Record<string, any>) => unknown | Promise<unknown>;
}) {
  if (!isRecord(options)) throw new TypeError('TurboWarp browser stage options are required');
  const document = validateDocument(options.document);
  const mount = validateMount(options.mount);
  const platform = validatePlatform(options.platform);
  const maximum = safeInteger(
    options.maxProjectBytes ?? dsl4BrowserTurboWarpStageDefaults.maxProjectBytes,
    'maxProjectBytes',
    1,
  );
  if (maximum > dsl4BrowserTurboWarpStageMaximumProjectBytes) {
    throw new TypeError(
      `maxProjectBytes must be <= ${dsl4BrowserTurboWarpStageMaximumProjectBytes}`,
    );
  }
  const width = safeInteger(
    options.stageWidth ?? dsl4BrowserTurboWarpStageDefaults.stageWidth,
    'stageWidth',
    1,
  );
  const height = safeInteger(
    options.stageHeight ?? dsl4BrowserTurboWarpStageDefaults.stageHeight,
    'stageHeight',
    1,
  );
  if (width * height > 4_194_304) {
    throw new TypeError('stage dimensions must not exceed 4194304 pixels');
  }
  if (options.prepareVm !== undefined && typeof options.prepareVm !== 'function') {
    throw new TypeError('prepareVm must be a function');
  }
  let baseProjectBytes = projectBytes(options.projectBytes, maximum);

  const canvasCandidate = document.createElement('canvas');
  if (
    !isRecord(canvasCandidate) ||
    typeof canvasCandidate.addEventListener !== 'function' ||
    typeof canvasCandidate.removeEventListener !== 'function' ||
    typeof canvasCandidate.getBoundingClientRect !== 'function' ||
    typeof canvasCandidate.setAttribute !== 'function' ||
    !isRecord(canvasCandidate.dataset) ||
    !isRecord(canvasCandidate.style)
  ) {
    throw new TypeError('document.createElement must create a canvas-like element');
  }
  const canvas = canvasCandidate as Record<string, any>;
  canvas.width = width;
  canvas.height = height;
  canvas.tabIndex = 0;
  canvas.dataset.dsl4TurboWarpStage = 'true';
  canvas.setAttribute('aria-label', 'TurboWarp project stage');
  canvas.style.aspectRatio = `${width} / ${height}`;
  canvas.style.display = 'block';
  canvas.style.height = 'auto';
  canvas.style.maxWidth = '100%';
  canvas.style.width = `${width}px`;

  let status = 'idle';
  let disposed = false;
  let disposeRequested = false;
  let vm: Record<string, any> | null = null;
  let runtimeHost: ReturnType<typeof createTurboWarpRuntimeHost> | null = null;
  let renderer: unknown = null;
  let audioEngine: unknown = null;
  let storage: unknown = null;
  let bitmapAdapter: unknown = null;
  let mounted = false;
  let inputAttached = false;
  let startPromise: Promise<Readonly<Record<string, unknown>>> | null = null;
  let resetPromise: Promise<Readonly<Record<string, unknown>>> | null = null;
  let cleanupPromise: Promise<void> | null = null;
  let disposePromise: Promise<Readonly<Record<string, unknown>>> | null = null;

  function snapshot() {
    const targets = Array.isArray(vm?.runtime?.targets) ? vm.runtime.targets : [];
    return deepFreeze({
      version: 1,
      status,
      ready: status === 'ready',
      disposed,
      targetCount: targets.length,
      hasStage: targets.some((target: unknown) => isRecord(target) && target.isStage === true),
      dimensions: {width, height},
    });
  }

  function handlePointerMove(event: Record<string, any>) {
    if (!vm) return;
    vm.postIOData('mouse', pointerData(canvas, event));
  }

  function handlePointerDown(event: Record<string, any>) {
    if (!vm || Number(event.button ?? 0) !== 0) return;
    canvas.focus?.({preventScroll: true});
    vm.postIOData('mouse', {...pointerData(canvas, event), isDown: true});
    event.preventDefault?.();
  }

  function handlePointerUp(event: Record<string, any>) {
    if (!vm || Number(event.button ?? 0) !== 0) return;
    vm.postIOData('mouse', {...pointerData(canvas, event), isDown: false});
  }

  function handleKeyDown(event: Record<string, any>) {
    vm?.postIOData('keyboard', {key: String(event.key ?? ''), isDown: true});
  }

  function handleKeyUp(event: Record<string, any>) {
    vm?.postIOData('keyboard', {key: String(event.key ?? ''), isDown: false});
  }

  function attachInput() {
    if (inputAttached) return;
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointerup', handlePointerUp);
    canvas.addEventListener('pointercancel', handlePointerUp);
    canvas.addEventListener('keydown', handleKeyDown);
    canvas.addEventListener('keyup', handleKeyUp);
    inputAttached = true;
  }

  function detachInput() {
    if (!inputAttached) return;
    canvas.removeEventListener('pointermove', handlePointerMove);
    canvas.removeEventListener('pointerdown', handlePointerDown);
    canvas.removeEventListener('pointerup', handlePointerUp);
    canvas.removeEventListener('pointercancel', handlePointerUp);
    canvas.removeEventListener('keydown', handleKeyDown);
    canvas.removeEventListener('keyup', handleKeyUp);
    inputAttached = false;
  }

  function cleanup(reason: string) {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const errors = [];
      detachInput();
      for (const release of [
        () => vm?.clear(),
        () => vm?.quit(),
        () =>
          bitmapAdapter === null ? undefined : platform.disposeBitmapAdapter(bitmapAdapter, reason),
        () => (audioEngine === null ? undefined : platform.disposeAudioEngine(audioEngine, reason)),
        () => (renderer === null ? undefined : platform.disposeRenderer(renderer, reason)),
        () => (storage === null ? undefined : platform.disposeStorage(storage, reason)),
      ]) {
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      }
      if (mounted) {
        try {
          mount.removeChild(canvas);
        } catch (error) {
          errors.push(error);
        }
        mounted = false;
      }
      baseProjectBytes = new Uint8Array(0);
      vm = null;
      runtimeHost = null;
      renderer = null;
      audioEngine = null;
      storage = null;
      bitmapAdapter = null;
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'TurboWarp browser stage cleanup failed');
      }
    })();
    return cleanupPromise;
  }

  function start() {
    if (disposed || disposeRequested) throw new TypeError('TurboWarp browser stage is disposed');
    if (status === 'ready') return Promise.resolve(snapshot());
    if (resetPromise) return resetPromise;
    if (startPromise) return startPromise;
    if (status !== 'idle') {
      throw new TypeError(`TurboWarp browser stage cannot start from status ${status}`);
    }
    status = 'starting';
    startPromise = (async () => {
      try {
        mount.appendChild(canvas);
        mounted = true;
        storage = await platform.createStorage();
        renderer = await platform.createRenderer(canvas);
        audioEngine = await platform.createAudioEngine();
        bitmapAdapter = await platform.createBitmapAdapter();
        vm = validateVm(await platform.createVm());
        runtimeHost = createTurboWarpRuntimeHost({runtime: vm.runtime});
        vm.attachStorage(storage);
        vm.attachRenderer(renderer);
        vm.attachAudioEngine(audioEngine);
        vm.attachV2BitmapAdapter(bitmapAdapter);
        vm.setCompatibilityMode(false);
        vm.setTurboMode(false);
        vm.setCompilerOptions({enabled: false});
        vm.securityManager.canLoadExtensionFromProject = () => false;
        await options.prepareVm?.(vm);
        await vm.loadProject(baseProjectBytes);
        if (disposeRequested) {
          await cleanup('dispose-during-start');
          status = 'disposed';
          disposed = true;
          return snapshot();
        }
        vm.start();
        attachInput();
        status = 'ready';
        return snapshot();
      } catch (error) {
        status = 'failed';
        try {
          await cleanup('start-failed');
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'TurboWarp browser stage startup and cleanup failed',
          );
        }
        throw error;
      } finally {
        startPromise = null;
      }
    })();
    return startPromise;
  }

  function resetManagedPresentation() {
    if (disposed || disposeRequested) {
      throw new TypeError('TurboWarp browser stage is disposed');
    }
    if (resetPromise) return resetPromise;
    if (status !== 'ready' || !vm) {
      throw new TypeError('TurboWarp browser stage is not ready');
    }
    const activeVm = vm;
    status = 'resetting';
    detachInput();
    resetPromise = (async () => {
      try {
        await activeVm.loadProject(baseProjectBytes);
        if (!disposeRequested) {
          attachInput();
          status = 'ready';
        }
        return snapshot();
      } catch (error) {
        status = 'failed';
        try {
          await cleanup('reset-failed');
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'TurboWarp browser stage reset and cleanup failed',
          );
        }
        throw error;
      } finally {
        resetPromise = null;
      }
    })();
    return resetPromise;
  }

  function getRuntime() {
    if (status !== 'ready' || !runtimeHost) {
      throw new TypeError('TurboWarp browser stage is not ready');
    }
    return runtimeHost.runtime;
  }

  function getCanvas() {
    if (status !== 'ready') throw new TypeError('TurboWarp browser stage is not ready');
    return canvas;
  }

  function showApplicationMenu(locale: 'en' | 'ja') {
    if (status !== 'ready' || !runtimeHost) {
      throw new TypeError('TurboWarp browser stage is not ready');
    }
    const stage = runtimeHost.getStageTarget() as Record<string, any>;
    const costumeName = locale === 'ja' ? 'MenuRuntime' : 'Menu';
    const stageCostumes = stage?.sprite?.costumes ?? stage?.getCostumes?.() ?? [];
    const stageIndex = stageCostumes.findIndex(
      (costume: Record<string, any>) => costume?.name === costumeName,
    );
    if (stageIndex >= 0) stage.setCostume?.(stageIndex);
    canvas.style.cursor = 'pointer';
  }

  function showApplicationTitle(locale: 'en' | 'ja') {
    if (status !== 'ready' || !runtimeHost) {
      throw new TypeError('TurboWarp browser stage is not ready');
    }
    const stage = runtimeHost.getStageTarget() as Record<string, any>;
    const costumeName = locale === 'ja' ? 'TitleRuntime' : 'Title';
    const stageCostumes = stage?.sprite?.costumes ?? stage?.getCostumes?.() ?? [];
    const stageIndex = stageCostumes.findIndex(
      (costume: Record<string, any>) => costume?.name === costumeName,
    );
    if (stageIndex >= 0) stage.setCostume?.(stageIndex);
    canvas.style.cursor = 'pointer';
  }

  function hideApplicationOverlay() {
    if (status !== 'ready') throw new TypeError('TurboWarp browser stage is not ready');
    canvas.style.cursor = 'auto';
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    if (disposed) return Promise.resolve(snapshot());
    disposeRequested = true;
    status = 'disposing';
    disposePromise = (async () => {
      if (startPromise) {
        try {
          await startPromise;
        } catch {
          // The startup failure already performed cleanup.
        }
      }
      if (resetPromise) {
        try {
          await resetPromise;
        } catch {
          // The reset failure already performed cleanup.
        }
      }
      await cleanup('dispose');
      disposed = true;
      status = 'disposed';
      return snapshot();
    })();
    return disposePromise;
  }

  return Object.freeze({
    start,
    resetManagedPresentation,
    dispose,
    getRuntime,
    getCanvas,
    showApplicationMenu,
    showApplicationTitle,
    hideApplicationOverlay,
    getState: snapshot,
  });
}
