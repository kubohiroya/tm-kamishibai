import {applyDsl4MoveEasing, isDsl4MoveEasing} from '../move-easing.js';

const defaultFrameMilliseconds = 1000 / 60;

/** Transition easings arrive from parsed story sources, so they are validated before use. */
function transitionEasing(value: unknown): import('../move-easing.js').Dsl4MoveEasing {
  const easing = String(value ?? 'easeInOut');
  if (!isDsl4MoveEasing(easing)) throw new TypeError(`Unknown move easing: ${easing}`);
  return easing;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function platformError(message: string) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: 'K4-CROSSFADE-PLATFORM-001'});
  return error;
}

function abortError() {
  const error = new Error('DSL 4.0 crossfade was cancelled');
  error.name = 'AbortError';
  return error;
}

const completedOperation = Object.freeze({
  start: () => Promise.resolve(),
  finish() {},
});

function defaultScheduler() {
  return Object.freeze({
    now: () => performance.now(),
    setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
}

function drawableGroup(renderer: Record<string, any>, drawableId: number) {
  const order = renderer.getDrawableOrder(drawableId);
  for (const name of renderer._groupOrdering ?? []) {
    const group = renderer._layerGroups?.[name];
    if (!group) continue;
    const nextName = renderer._groupOrdering[group.groupIndex + 1];
    const end = nextName
      ? renderer._layerGroups[nextName].drawListOffset
      : renderer._drawList.length;
    if (order >= group.drawListOffset && order < end) return name;
  }
  throw platformError('The target drawable layer group is unavailable');
}

function createDrawableCopy(renderer: Record<string, any>, target: Record<string, any>) {
  const sourceId = target.drawableID;
  const source = renderer._allDrawables?.[sourceId];
  if (!source?.skin) throw platformError('The target drawable skin is unavailable');
  const group = drawableGroup(renderer, sourceId);
  const drawableId = renderer.createDrawable(group);
  if (!Number.isInteger(drawableId))
    throw platformError('A transition drawable could not be created');
  try {
    renderer.updateDrawableSkinId(drawableId, source.skin.id);
    renderer.updateDrawableProperties(drawableId, {
      position: [source._position[0], source._position[1]],
      direction: source._direction,
      scale: [source._scale[0], source._scale[1]],
      visible: source._visible,
      ...(isRecord(target.effects) ? target.effects : {}),
    });
    renderer.markDrawableAsNoninteractive?.(drawableId);
    const sourceOrder = renderer.getDrawableOrder(sourceId);
    renderer.setDrawableOrder(drawableId, sourceOrder + 1, group);
    return Object.freeze({drawableId, group});
  } catch (error) {
    renderer.destroyDrawable(drawableId, group);
    throw error;
  }
}

/** TurboWarp renderer and Asset Manager implementation for visual and BGM crossfades. */
export function createDsl4TurboWarpCrossfadePlatform(options: {
  /** Injected `@kubohiroya/turbowarp-runtime-host` adapter. */
  runtimeHost: unknown;
  scheduler?: unknown;
  frameMilliseconds?: number;
  createAudioVoice?: (
    assetId: string,
    options: Readonly<{gain: number}>,
  ) => unknown | Promise<unknown>;
  createImageBitmap?: (canvas: HTMLCanvasElement) => Promise<ImageBitmap>;
  onBackgroundError?: (error: unknown) => unknown;
}) {
  if (
    !isRecord(options) ||
    !isRecord(options.runtimeHost) ||
    typeof options.runtimeHost.getRenderer !== 'function' ||
    typeof options.runtimeHost.requestRedraw !== 'function' ||
    typeof options.runtimeHost.getStageTarget !== 'function'
  ) {
    throw new TypeError('Crossfade platform requires an injected TurboWarp runtime host');
  }
  const runtimeHost = options.runtimeHost as {
    getRenderer: () => unknown;
    requestRedraw: () => void;
    getStageTarget: () => unknown;
  };
  let renderer: Record<string, any>;
  try {
    renderer = runtimeHost.getRenderer() as Record<string, any>;
  } catch (error) {
    throw new TypeError('Crossfade platform requires a TurboWarp runtime renderer', {cause: error});
  }
  const scheduler = (options.scheduler ?? defaultScheduler()) as Record<string, Function>;
  if (['now', 'setTimeout', 'clearTimeout'].some((name) => typeof scheduler[name] !== 'function')) {
    throw new TypeError('Crossfade scheduler must provide now, setTimeout, and clearTimeout');
  }
  const frameMilliseconds = Number(options.frameMilliseconds ?? defaultFrameMilliseconds);
  if (!Number.isFinite(frameMilliseconds) || frameMilliseconds <= 0) {
    throw new TypeError('Crossfade frameMilliseconds must be positive');
  }
  const onBackgroundError = options.onBackgroundError ?? (() => {});
  if (typeof onBackgroundError !== 'function') {
    throw new TypeError('onBackgroundError must be a function');
  }
  const bitmapFactory = options.createImageBitmap ?? globalThis.createImageBitmap;
  const createAudioVoice = options.createAudioVoice;
  const active = new Set<{finish: () => void}>();
  let disposed = false;
  let currentVoice: {
    assetId: string;
    voice: {ended: PromiseLike<unknown>; setGain: Function; stop: Function};
  } | null = null;
  let currentBgmTransition: Readonly<{start: Function; finish: Function}> | null = null;

  function timeline(duration: number, update: (progress: number) => void, complete: () => void) {
    let state = 'idle';
    let timer: unknown;
    let resolveOperation: (() => void) | undefined;
    let rejectOperation: ((error: unknown) => void) | undefined;
    const operation = Object.freeze({
      start() {
        if (state !== 'idle') throw platformError('A crossfade operation can only start once');
        state = 'running';
        active.add(operation);
        const startTime = Number(scheduler.now());
        return new Promise((resolve, reject) => {
          resolveOperation = () => resolve(undefined);
          rejectOperation = reject;
          const tick = () => {
            timer = undefined;
            if (state !== 'running') return;
            try {
              const elapsed = Math.max(0, Number(scheduler.now()) - startTime);
              const progress = Math.min(elapsed / duration, 1);
              update(progress);
              if (progress >= 1) {
                operation.finish();
                return;
              }
              timer = scheduler.setTimeout(tick, Math.min(frameMilliseconds, duration - elapsed));
            } catch (error) {
              state = 'failed';
              active.delete(operation);
              try {
                complete();
              } catch (cleanupError) {
                reject(new AggregateError([error, cleanupError], 'Crossfade cleanup failed'));
                return;
              }
              reject(error);
            }
          };
          if (duration === 0) operation.finish();
          else timer = scheduler.setTimeout(tick, Math.min(frameMilliseconds, duration));
        });
      },
      finish() {
        if (state === 'completed') return;
        if (timer !== undefined) scheduler.clearTimeout(timer);
        timer = undefined;
        try {
          complete();
          state = 'completed';
          active.delete(operation);
          resolveOperation?.();
        } catch (error) {
          state = 'failed';
          active.delete(operation);
          rejectOperation?.(error);
          throw error;
        }
      },
    });
    return operation;
  }

  async function crossfadeDrawable(
    target: Record<string, any>,
    apply: () => unknown | Promise<unknown>,
    transition: Record<string, any>,
    signal?: AbortSignal,
  ) {
    if (disposed) throw platformError('Crossfade platform is disposed');
    if (signal?.aborted) throw abortError();
    if (target.visible === false) return apply();
    const baseline = Math.max(0, Math.min(100, Number(target.effects?.ghost ?? 0)));
    const copy = createDrawableCopy(renderer, target);
    let cleaned = false;
    let cancelled = false;
    let aborted = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      target.setEffect?.('ghost', baseline);
      renderer.destroyDrawable(copy.drawableId, copy.group);
      runtimeHost.requestRedraw();
    };
    let finishCurrent = cleanup;
    const preparation = Object.freeze({
      finish() {
        cancelled = true;
        active.delete(preparation);
        cleanup();
      },
    });
    const onAbort = () => {
      aborted = true;
      cancelled = true;
      finishCurrent();
    };
    active.add(preparation);
    signal?.addEventListener('abort', onAbort, {once: true});
    try {
      await apply();
      active.delete(preparation);
      if (cancelled || disposed) {
        if (aborted) throw abortError();
        return;
      }
      target.setEffect?.('ghost', 100);
      const duration = Number(transition.seconds) * 1000;
      const operation = timeline(
        duration,
        (progress) => {
          const eased = applyDsl4MoveEasing(transitionEasing(transition.easing), progress);
          target.setEffect?.('ghost', 100 + (baseline - 100) * eased);
          renderer.updateDrawableEffect(
            copy.drawableId,
            'ghost',
            baseline + (100 - baseline) * eased,
          );
          runtimeHost.requestRedraw();
        },
        cleanup,
      );
      finishCurrent = () => operation.finish();
      await operation.start();
      if (aborted) throw abortError();
    } catch (error) {
      cleanup();
      throw error;
    } finally {
      active.delete(preparation);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function createSceneCrossfade(transition: Record<string, any>) {
    if (disposed) throw platformError('Crossfade platform is disposed');
    if (typeof bitmapFactory !== 'function') {
      throw platformError('createImageBitmap is required for scene crossfade');
    }
    const canvas = renderer.canvas ?? renderer._gl?.canvas;
    if (!canvas) throw platformError('The renderer canvas is unavailable');
    let cancelled = false;
    const preparation = Object.freeze({
      finish() {
        cancelled = true;
        active.delete(preparation);
      },
    });
    active.add(preparation);
    let bitmap;
    try {
      bitmap = await bitmapFactory(canvas);
    } finally {
      active.delete(preparation);
    }
    if (disposed || cancelled) {
      bitmap.close?.();
      if (disposed) throw platformError('Crossfade platform is disposed');
      return completedOperation;
    }
    let skinId;
    try {
      skinId = renderer.createBitmapSkin(bitmap, 1);
    } finally {
      bitmap.close?.();
    }
    const group = renderer._groupOrdering?.at(-1);
    if (!group) {
      renderer.destroySkin(skinId);
      throw platformError('The renderer layer ordering is unavailable');
    }
    let drawableId;
    try {
      drawableId = renderer.createDrawable(group);
      if (!Number.isInteger(drawableId)) {
        throw platformError('A scene transition drawable could not be created');
      }
      renderer.updateDrawableSkinId(drawableId, skinId);
      const nativeSize = renderer.getNativeSize();
      renderer.updateDrawableProperties(drawableId, {
        position: [0, 0],
        direction: 90,
        scale: [
          (Number(nativeSize[0]) / Number(canvas.width)) * 100,
          (Number(nativeSize[1]) / Number(canvas.height)) * 100,
        ],
        visible: true,
        ghost: 0,
      });
      renderer.markDrawableAsNoninteractive?.(drawableId);
      renderer.setDrawableOrder(drawableId, Infinity, group);
    } catch (error) {
      if (Number.isInteger(drawableId)) renderer.destroyDrawable(drawableId, group);
      renderer.destroySkin(skinId);
      throw error;
    }
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      renderer.destroyDrawable(drawableId, group);
      renderer.destroySkin(skinId);
      runtimeHost.requestRedraw();
    };
    const operation = timeline(
      Number(transition.seconds) * 1000,
      (progress) => {
        const eased = applyDsl4MoveEasing(transitionEasing(transition.easing), progress);
        renderer.updateDrawableEffect(drawableId, 'ghost', eased * 100);
        runtimeHost.requestRedraw();
      },
      cleanup,
    );
    active.add(operation);
    return operation;
  }

  async function replaceBgm(
    assetId: string,
    transition: Record<string, any>,
    {restart = false, signal}: {restart?: boolean; signal?: AbortSignal} = {},
  ) {
    if (disposed) throw platformError('Crossfade platform is disposed');
    if (typeof createAudioVoice !== 'function') {
      throw platformError('Asset Manager audio voice handles are required for BGM crossfade');
    }
    if (!restart && currentVoice?.assetId === assetId) return;
    currentBgmTransition?.finish('replaced');
    currentBgmTransition = null;
    const outgoing = currentVoice;
    const crossfade = transition.effect === 'crossfade';
    const candidateVoice = await createAudioVoice(assetId, {gain: crossfade ? 0 : 1});
    if (
      !isRecord(candidateVoice) ||
      !isRecord(candidateVoice.ended) ||
      typeof candidateVoice.ended.then !== 'function' ||
      typeof candidateVoice.setGain !== 'function' ||
      typeof candidateVoice.stop !== 'function'
    ) {
      if (isRecord(candidateVoice) && typeof candidateVoice.stop === 'function') {
        candidateVoice.stop();
      }
      throw platformError('Audio voice factory returned an invalid voice handle');
    }
    const voice = candidateVoice as unknown as {
      ended: PromiseLike<unknown>;
      setGain: Function;
      stop: Function;
    };
    if (signal?.aborted) {
      voice.stop();
      const error = new Error('DSL 4.0 BGM replacement was cancelled');
      error.name = 'AbortError';
      throw error;
    }
    const next = {assetId, voice};
    currentVoice = next;
    void voice.ended.then(
      () => {
        if (currentVoice === next) currentVoice = null;
      },
      (error) => {
        if (currentVoice === next) currentVoice = null;
        onBackgroundError(error);
      },
    );
    if (!crossfade) {
      outgoing?.voice.stop();
      return;
    }
    const curve = String(transition.curve ?? 'equalPower');
    const operation = timeline(
      Number(transition.seconds) * 1000,
      (progress) => {
        const oldGain = curve === 'equalPower' ? Math.cos((Math.PI * progress) / 2) : 1 - progress;
        const newGain = curve === 'equalPower' ? Math.sin((Math.PI * progress) / 2) : progress;
        outgoing?.voice.setGain(oldGain);
        voice.setGain(newGain);
      },
      () => {
        outgoing?.voice.stop();
        voice.setGain(1);
        if (currentBgmTransition === operation) currentBgmTransition = null;
      },
    );
    currentBgmTransition = operation;
    void operation.start().catch(onBackgroundError);
  }

  return Object.freeze({
    crossfadeStage(
      apply: () => unknown | Promise<unknown>,
      transition: Record<string, any>,
      signal?: AbortSignal,
    ) {
      const stage = runtimeHost.getStageTarget() as Record<string, any> | null | undefined;
      if (!stage) throw platformError('The Stage target is unavailable');
      return crossfadeDrawable(stage, apply, transition, signal);
    },
    crossfadeActorSkin(
      target: Record<string, any>,
      apply: () => unknown | Promise<unknown>,
      transition: Record<string, any>,
      signal?: AbortSignal,
    ) {
      return crossfadeDrawable(target, apply, transition, signal);
    },
    createSceneCrossfade,
    replaceBgm,
    finishAll() {
      const errors = [];
      for (const operation of [...active]) {
        try {
          operation.finish();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Crossfade cleanup failed');
    },
    dispose() {
      if (disposed) return;
      this.finishAll();
      currentVoice?.voice.stop();
      currentVoice = null;
      disposed = true;
    },
  });
}
