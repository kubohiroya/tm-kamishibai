interface VideoBitmapRenderer {
  createDrawable(group: string): number;
  destroyDrawable(id: number, group: string): void;
  createBitmapSkin(canvas: HTMLCanvasElement, resolution: number): number;
  updateBitmapSkin(id: number, canvas: HTMLCanvasElement, resolution: number): void;
  destroySkin(id: number): void;
  updateDrawableSkinId(id: number, skin: number): void;
  updateDrawablePosition(id: number, position: [number, number]): void;
  updateDrawableScale(id: number, scale: [number, number]): void;
  setDrawableOrder(id: number, order: number, group: string): unknown;
  updateDrawableVisible(id: number, visible: boolean): void;
  markDrawableAsNoninteractive?(id: number): void;
}

/** Place video above the stage backdrop and below sprites, without arbitrary sprite interleaving. */
export function createDsl4VideoBackgroundPresentation(options: {
  renderer: unknown;
  element: HTMLVideoElement;
  x: number;
  y: number;
  width: number;
  height: number;
  fit: 'contain' | 'cover';
  onError: (cause: unknown) => void;
}) {
  const renderer = options.renderer as VideoBitmapRenderer;
  for (const name of [
    'createDrawable',
    'destroyDrawable',
    'createBitmapSkin',
    'updateBitmapSkin',
    'destroySkin',
    'updateDrawableSkinId',
    'updateDrawablePosition',
    'updateDrawableScale',
    'setDrawableOrder',
    'updateDrawableVisible',
  ] as const) {
    if (typeof renderer?.[name] !== 'function')
      throw new TypeError(`Background video requires renderer.${name}`);
  }
  const video = options.element;
  const canvas = video.ownerDocument.createElement('canvas');
  // Bound texture memory independently from the requested logical stage rectangle.
  const ratio = Math.min(1, 2048 / options.width, 2048 / options.height);
  canvas.width = Math.max(1, Math.ceil(options.width * ratio));
  canvas.height = Math.max(1, Math.ceil(options.height * ratio));
  Object.defineProperty(canvas, 'reusable', {value: false});
  const context = canvas.getContext('2d');
  if (!context) throw new TypeError('Background video requires a 2D canvas context');
  const bitmapContext = context;
  let skin: number | null = null;
  let drawable: number | null = null;
  let disposed = false;
  let frame: number | null = null;
  let videoFrame = false;
  const window = video.ownerDocument.defaultView;

  function cancelFrame() {
    if (frame === null) return;
    if (videoFrame) video.cancelVideoFrameCallback(frame);
    else window?.cancelAnimationFrame(frame);
    frame = null;
  }

  function draw() {
    if (disposed) return;
    bitmapContext.fillStyle = 'black';
    bitmapContext.fillRect(0, 0, canvas.width, canvas.height);
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      const scale = (options.fit === 'cover' ? Math.max : Math.min)(
        canvas.width / video.videoWidth,
        canvas.height / video.videoHeight,
      );
      const width = video.videoWidth * scale;
      const height = video.videoHeight * scale;
      bitmapContext.drawImage(
        video,
        (canvas.width - width) / 2,
        (canvas.height - height) / 2,
        width,
        height,
      );
    }
    if (skin !== null) renderer.updateBitmapSkin(skin, canvas, 1);
  }

  function update() {
    cancelFrame();
    if (disposed) return;
    try {
      draw();
      if (!video.paused && !video.ended) schedule();
    } catch (error) {
      cancelFrame();
      options.onError(error);
    }
  }

  function schedule() {
    if (disposed || frame !== null) return;
    if (typeof video.requestVideoFrameCallback === 'function') {
      videoFrame = true;
      frame = video.requestVideoFrameCallback(update);
    } else if (window) {
      videoFrame = false;
      frame = window.requestAnimationFrame(update);
    }
  }
  function stopped() {
    cancelFrame();
    update();
  }
  const listeners: readonly [string, () => void][] = [
    ['loadeddata', update],
    ['seeked', update],
    ['resize', update],
    ['play', schedule],
    ['pause', stopped],
    ['ended', stopped],
  ];

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelFrame();
    for (const [event, listener] of listeners) video.removeEventListener(event, listener);
    const errors: unknown[] = [];
    if (drawable !== null) {
      try {
        renderer.destroyDrawable(drawable, 'video');
      } catch (error) {
        errors.push(error);
      }
    }
    if (skin !== null) {
      try {
        renderer.destroySkin(skin);
      } catch (error) {
        errors.push(error);
      }
    }
    canvas.width = 0;
    canvas.height = 0;
    if (errors.length) throw new AggregateError(errors, 'Background video cleanup failed');
  }

  try {
    draw();
    skin = renderer.createBitmapSkin(canvas, 1);
    drawable = renderer.createDrawable('video');
    if (!Number.isInteger(skin) || !Number.isInteger(drawable))
      throw new TypeError('Background video renderer returned an invalid resource id');
    renderer.updateDrawableSkinId(drawable, skin);
    renderer.updateDrawablePosition(drawable, [options.x, options.y]);
    renderer.updateDrawableScale(drawable, [
      (options.width / canvas.width) * 100,
      (options.height / canvas.height) * 100,
    ]);
    renderer.markDrawableAsNoninteractive?.(drawable);
    for (const [event, listener] of listeners) video.addEventListener(event, listener);
    return Object.freeze({
      dispose,
      moveToBack() {
        // The pinned renderer clamps +Infinity to the next group's first index.
        // Insert at the beginning of the video group to keep sprites above every video.
        if (!disposed && drawable !== null) renderer.setDrawableOrder(drawable, -Infinity, 'video');
      },
      setVisible(visible: boolean) {
        if (!disposed && drawable !== null) renderer.updateDrawableVisible(drawable, visible);
      },
    });
  } catch (error) {
    try {
      dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Background video creation failed');
    }
    throw error;
  }
}
