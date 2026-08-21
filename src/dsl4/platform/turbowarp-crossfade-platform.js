import {applyDsl4MoveEasing} from '../move-easing.js';

const defaultFrameMilliseconds = 1000 / 60;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} message */
function platformError(message) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: 'K4-CROSSFADE-PLATFORM-001'});
  return error;
}

function defaultScheduler() {
  return Object.freeze({
    now: () => performance.now(),
    /** @param {() => void} callback @param {number} milliseconds */
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    /** @param {unknown} handle */
    clearTimeout: (handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
  });
}

/** @param {Record<string, any>} renderer @param {number} drawableId */
function drawableGroup(renderer, drawableId) {
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

/** @param {Record<string, any>} renderer @param {Record<string, any>} target */
function createDrawableCopy(renderer, target) {
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

/**
 * TurboWarp renderer and Asset Manager implementation for visual and BGM crossfades.
 *
 * @param {object} options
 * @param {unknown} options.runtime
 * @param {unknown} [options.scheduler]
 * @param {number} [options.frameMilliseconds]
 * @param {(assetId: string, options: Readonly<{gain: number}>) => unknown | Promise<unknown>} [options.createAudioVoice]
 * @param {(canvas: HTMLCanvasElement) => Promise<ImageBitmap>} [options.createImageBitmap]
 * @param {(error: unknown) => unknown} [options.onBackgroundError]
 */
export function createDsl4TurboWarpCrossfadePlatform(options) {
  if (!isRecord(options) || !isRecord(options.runtime) || !isRecord(options.runtime.renderer)) {
    throw new TypeError('Crossfade platform requires a TurboWarp runtime renderer');
  }
  const runtime = /** @type {Record<string, any>} */ (options.runtime);
  const renderer = /** @type {Record<string, any>} */ (runtime.renderer);
  const scheduler = /** @type {Record<string, Function>} */ (
    options.scheduler ?? defaultScheduler()
  );
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
  const active = new Set();
  let disposed = false;
  /** @type {{assetId: string, voice: {ended: PromiseLike<unknown>, setGain: Function, stop: Function}} | null} */
  let currentVoice = null;
  /** @type {Readonly<{start: Function, finish: Function}> | null} */
  let currentBgmTransition = null;

  /** @param {number} duration @param {(progress: number) => void} update @param {() => void} complete */
  function timeline(duration, update, complete) {
    let state = 'idle';
    /** @type {unknown} */
    let timer;
    /** @type {(() => void) | undefined} */
    let resolveOperation;
    /** @type {((error: unknown) => void) | undefined} */
    let rejectOperation;
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

  /** @param {Record<string, any>} target @param {() => unknown | Promise<unknown>} apply @param {Record<string, any>} transition */
  async function crossfadeDrawable(target, apply, transition) {
    if (disposed) throw platformError('Crossfade platform is disposed');
    if (target.visible === false) return apply();
    const baseline = Math.max(0, Math.min(100, Number(target.effects?.ghost ?? 0)));
    const copy = createDrawableCopy(renderer, target);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      target.setEffect?.('ghost', baseline);
      renderer.destroyDrawable(copy.drawableId, copy.group);
      runtime.requestRedraw?.();
    };
    try {
      await apply();
      target.setEffect?.('ghost', 100);
      const duration = Number(transition.seconds) * 1000;
      const operation = timeline(
        duration,
        (progress) => {
          const eased = applyDsl4MoveEasing(String(transition.easing ?? 'easeInOut'), progress);
          target.setEffect?.('ghost', 100 + (baseline - 100) * eased);
          renderer.updateDrawableEffect(
            copy.drawableId,
            'ghost',
            baseline + (100 - baseline) * eased,
          );
          runtime.requestRedraw?.();
        },
        cleanup,
      );
      await operation.start();
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  /** @param {Record<string, any>} transition */
  async function createSceneCrossfade(transition) {
    if (disposed) throw platformError('Crossfade platform is disposed');
    if (typeof bitmapFactory !== 'function') {
      throw platformError('createImageBitmap is required for scene crossfade');
    }
    const canvas = renderer.canvas ?? renderer._gl?.canvas;
    if (!canvas) throw platformError('The renderer canvas is unavailable');
    const bitmap = await bitmapFactory(canvas);
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
      runtime.requestRedraw?.();
    };
    const operation = timeline(
      Number(transition.seconds) * 1000,
      (progress) => {
        const eased = applyDsl4MoveEasing(String(transition.easing ?? 'easeInOut'), progress);
        renderer.updateDrawableEffect(drawableId, 'ghost', eased * 100);
        runtime.requestRedraw?.();
      },
      cleanup,
    );
    active.add(operation);
    return operation;
  }

  /** @param {string} assetId @param {Record<string, any>} transition @param {{restart?: boolean, signal?: AbortSignal}} [options] */
  async function replaceBgm(assetId, transition, {restart = false, signal} = {}) {
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
    const voice = /** @type {{ended: PromiseLike<unknown>, setGain: Function, stop: Function}} */ (
      /** @type {unknown} */ (candidateVoice)
    );
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
    /** @param {() => unknown | Promise<unknown>} apply @param {Record<string, any>} transition */
    crossfadeStage(apply, transition) {
      const stage = runtime.targets?.find(
        /** @param {Record<string, any>} target */ (target) => target?.isStage === true,
      );
      if (!stage) throw platformError('The Stage target is unavailable');
      return crossfadeDrawable(stage, apply, transition);
    },
    /** @param {Record<string, any>} target @param {() => unknown | Promise<unknown>} apply @param {Record<string, any>} transition */
    crossfadeActorSkin(target, apply, transition) {
      return crossfadeDrawable(target, apply, transition);
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
