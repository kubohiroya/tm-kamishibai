const indicatorGap = 4;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} message */
function indicatorError(message) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: 'K4-BUBBLE-INDICATOR-001'});
  return error;
}

function defaultCreateImage() {
  const ImageConstructor = globalThis.Image;
  if (typeof ImageConstructor !== 'function') {
    throw new TypeError('Image is required for bubble advance indicators');
  }
  return new ImageConstructor();
}

function defaultScheduler() {
  return Object.freeze({
    /** @param {() => void} callback @param {number} milliseconds */
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    /** @param {unknown} handle */
    clearTimeout: (handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
  });
}

/** @param {unknown} value */
function validateScheduler(value) {
  if (
    !isRecord(value) ||
    typeof value.setTimeout !== 'function' ||
    typeof value.clearTimeout !== 'function'
  ) {
    throw new TypeError(
      'Bubble advance indicator scheduler must provide setTimeout and clearTimeout',
    );
  }
  return /** @type {{setTimeout: (callback: () => void, milliseconds: number) => unknown, clearTimeout: (handle: unknown) => void}} */ (
    /** @type {unknown} */ (value)
  );
}

/**
 * Draw animated image frames at the end of TurboWarp's native say/think text.
 *
 * @param {object} options
 * @param {unknown} options.runtime
 * @param {(assetId: string) => unknown} options.getAssetResource
 * @param {() => unknown} [options.createImage]
 * @param {unknown} [options.scheduler]
 */
export function createDsl4BubbleAdvanceIndicatorPresenter(options) {
  if (!isRecord(options)) throw new TypeError('Bubble advance indicator options are required');
  if (!isRecord(options.runtime) || !isRecord(options.runtime.renderer)) {
    throw new TypeError('Bubble advance indicators require a TurboWarp renderer');
  }
  if (typeof options.getAssetResource !== 'function') {
    throw new TypeError('getAssetResource must be a function');
  }
  const runtime = /** @type {Record<string, any>} */ (options.runtime);
  const renderer = /** @type {Record<string, any>} */ (runtime.renderer);
  const getAssetResource = options.getAssetResource;
  const createImage = options.createImage ?? defaultCreateImage;
  if (typeof createImage !== 'function') throw new TypeError('createImage must be a function');
  const scheduler = validateScheduler(options.scheduler ?? defaultScheduler());
  const activeOperations = new Set();
  let disposed = false;

  /** @param {Record<string, any>} target @param {Record<string, any>} skin */
  function markChanged(target, skin) {
    skin._textDirty = true;
    skin._textureDirty = true;
    skin.emitWasAltered();
    target.onTargetVisualChange?.();
    runtime.requestRedraw?.();
  }

  /** @param {Record<string, any>} target @param {Record<string, any>} active */
  function installRenderer(target, active) {
    const bubbleState = target.getCustomState?.('Scratch.looks');
    const skinId = isRecord(bubbleState) ? bubbleState.skinId : null;
    const skin =
      typeof skinId === 'number' || typeof skinId === 'string'
        ? renderer._allSkins?.[skinId]
        : null;
    if (
      !isRecord(skin) ||
      typeof skin._reflowLines !== 'function' ||
      typeof skin._renderTextBubble !== 'function' ||
      !isRecord(skin._style) ||
      !isRecord(skin.measurementProvider) ||
      typeof skin.measurementProvider.measureText !== 'function' ||
      typeof skin.emitWasAltered !== 'function'
    ) {
      throw indicatorError('TurboWarp text bubble renderer is unavailable');
    }
    const originalReflow = skin._reflowLines;
    const originalRender = skin._renderTextBubble;

    /** @this {Record<string, any>} */
    const reflow = function () {
      originalReflow.call(this);
      const style = this._style;
      const iconSize = style.lineHeight;
      const lines = this._lines;
      const lastLineIndex = Math.max(0, lines.length - 1);
      const lastLine = lines[lastLineIndex] ?? '';
      const lastLineWidth = this.measurementProvider.measureText(lastLine);
      const requiredWidth = lastLineWidth + indicatorGap + iconSize;
      const newLine = requiredWidth > style.maxLineWidth;
      const lineIndex = newLine ? lines.length : lastLineIndex;
      if (newLine) lines.push('');
      const x = style.padding + (newLine ? 0 : lastLineWidth + indicatorGap);
      const y = style.padding + style.lineHeight * lineIndex;
      const contentWidth = newLine ? iconSize : requiredWidth;
      const paddedWidth = Math.max(this._textAreaSize.width, contentWidth + style.padding * 2);
      const paddedHeight = style.lineHeight * lines.length + style.padding * 2;
      this._textAreaSize.width = paddedWidth;
      this._textAreaSize.height = paddedHeight;
      this._size[0] = paddedWidth + style.strokeWidth;
      this._size[1] = paddedHeight + style.strokeWidth + style.tailHeight;
      active.layout = {x, y, size: iconSize};
    };
    /** @this {Record<string, any>} @param {number} scale */
    const render = function (scale) {
      originalRender.call(this, scale);
      const image = active.images[active.frameIndex];
      const layout = active.layout;
      if (!layout || !image || image.complete === false || Number(image.naturalWidth) <= 0) return;
      const context = this._canvas?.getContext?.('2d');
      if (!context) return;
      const naturalWidth = Number(image.naturalWidth) || 1;
      const naturalHeight = Number(image.naturalHeight) || 1;
      const ratio = naturalWidth / naturalHeight;
      const width = Math.min(layout.size, layout.size * ratio);
      const height = Math.min(layout.size, layout.size / ratio);
      const x = layout.x + (layout.size - width) / 2;
      const y = layout.y + (layout.size - height) / 2;
      context.save();
      context.drawImage(image, x, y, width, height);
      context.restore();
    };
    skin._reflowLines = reflow;
    skin._renderTextBubble = render;
    markChanged(target, skin);
    return () => {
      if (skin._reflowLines === reflow) skin._reflowLines = originalReflow;
      if (skin._renderTextBubble === render) skin._renderTextBubble = originalRender;
      markChanged(target, skin);
    };
  }

  return Object.freeze({
    /** @param {unknown} targetInput @param {unknown} indicatorInput */
    create(targetInput, indicatorInput) {
      if (disposed) throw indicatorError('Bubble advance indicator presenter is disposed');
      if (!isRecord(targetInput) || typeof targetInput.getCustomState !== 'function') {
        throw indicatorError('Bubble advance indicator target is invalid');
      }
      if (!isRecord(indicatorInput) || !Array.isArray(indicatorInput.frames)) {
        throw indicatorError('Bubble advance indicator specification is invalid');
      }
      const frameIntervalMilliseconds = Number(indicatorInput.frameIntervalSeconds) * 1000;
      if (!(frameIntervalMilliseconds > 0) || !Number.isFinite(frameIntervalMilliseconds)) {
        throw indicatorError('Bubble advance indicator interval is invalid');
      }
      const target = /** @type {Record<string, any>} */ (targetInput);
      const images = indicatorInput.frames.map((assetId) => {
        const resource = getAssetResource(String(assetId));
        if (
          !isRecord(resource) ||
          resource.kind !== 'image' ||
          typeof resource.objectUrl !== 'string'
        ) {
          throw indicatorError(`Bubble advance indicator image is unavailable: ${String(assetId)}`);
        }
        const image = /** @type {Record<string, any>} */ (createImage());
        if (!isRecord(image)) throw indicatorError('createImage returned an invalid image');
        image.src = resource.objectUrl;
        return image;
      });
      const active = {images, frameIndex: 0, layout: null};
      let state = 'idle';
      /** @type {unknown} */
      let timer;
      let uninstall = () => {};
      const operation = Object.freeze({
        start() {
          if (state !== 'idle') return;
          if (disposed) throw indicatorError('Bubble advance indicator presenter is disposed');
          state = 'running';
          uninstall = installRenderer(target, active);
          activeOperations.add(operation);
          const tick = () => {
            timer = undefined;
            if (state !== 'running') return;
            active.frameIndex = (active.frameIndex + 1) % images.length;
            const bubbleState = target.getCustomState('Scratch.looks');
            const skinId = isRecord(bubbleState) ? bubbleState.skinId : null;
            const skin =
              typeof skinId === 'number' || typeof skinId === 'string'
                ? renderer._allSkins?.[skinId]
                : null;
            if (isRecord(skin)) markChanged(target, skin);
            timer = scheduler.setTimeout(tick, frameIntervalMilliseconds);
          };
          timer = scheduler.setTimeout(tick, frameIntervalMilliseconds);
        },
        stop() {
          if (state === 'stopped') return;
          state = 'stopped';
          if (timer !== undefined) scheduler.clearTimeout(timer);
          timer = undefined;
          activeOperations.delete(operation);
          uninstall();
          uninstall = () => {};
        },
      });
      return operation;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const operation of [...activeOperations]) operation.stop();
    },
  });
}
