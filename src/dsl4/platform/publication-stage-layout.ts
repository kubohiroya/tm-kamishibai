/** Reserve a separate control row instead of painting controls over the chapter canvas. */
export function createDsl4PublicationLayout(document: Document) {
  const layout = document.createElement('div');
  layout.dataset.dsl4PublicationLayout = 'true';
  layout.style.cssText =
    'position:absolute;inset:0;display:grid;grid-template-rows:minmax(0,1fr) auto;background:white;';
  const stageMount = document.createElement('div');
  stageMount.dataset.dsl4PublicationViewport = 'true';
  stageMount.style.cssText = 'position:relative;min-width:0;min-height:0;overflow:hidden;';
  const controls = document.createElement('div');
  controls.dataset.dsl4Publication = 'true';
  controls.dataset.kamishibaiKeymapIgnore = 'true';
  controls.style.cssText =
    'position:relative;min-width:0;max-height:6em;overflow:auto;background:white;padding:6px;overflow-wrap:anywhere;';
  for (const type of ['keydown', 'keyup', 'pointerup']) {
    controls.addEventListener(type, (event) => event.stopPropagation());
  }
  layout.append(stageMount, controls);
  return {layout, stageMount, controls};
}

/** Keep the chapter canvas, overlays and pointer target in one fitted stage rectangle. */
export function fitDsl4PublicationStage({
  mount,
  element,
  canvas,
  width,
  height,
}: {
  mount: HTMLElement;
  element: HTMLElement;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}) {
  const layers = canvas.parentElement!;
  const window = mount.ownerDocument.defaultView;
  let disposed = false;
  // Scale the whole layer stack so native overlays and canvas pixels use the same transform.
  Object.assign(layers.style, {
    width: `${width}px`,
    height: `${height}px`,
    maxWidth: 'none',
    transformOrigin: '0 0',
  });
  Object.assign(canvas.style, {width: `${width}px`, height: `${height}px`, maxWidth: 'none'});
  element.style.inset = 'auto';
  function update() {
    if (disposed) return;
    const bounds = mount.getBoundingClientRect();
    // Computed sizes preserve fractional local pixels; client sizes can round upward and clip.
    const style = window?.getComputedStyle?.(mount);
    const availableWidth =
      Number.parseFloat(style?.width ?? '') || mount.clientWidth || bounds.width;
    const availableHeight =
      Number.parseFloat(style?.height ?? '') || mount.clientHeight || bounds.height;
    if (availableWidth <= 0 || availableHeight <= 0) return;
    const scale = Math.min(availableWidth / width, availableHeight / height);
    Object.assign(element.style, {
      left: `${(availableWidth - width * scale) / 2}px`,
      top: `${(availableHeight - height * scale) / 2}px`,
      width: `${width * scale}px`,
      height: `${height * scale}px`,
    });
    layers.style.transform = `scale(${scale})`;
  }
  const ResizeObserver = (window as (Window & typeof globalThis) | null)?.ResizeObserver;
  const observer = ResizeObserver ? new ResizeObserver(update) : null;
  observer?.observe(mount);
  window?.addEventListener('resize', update);
  update();
  return () => {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    window?.removeEventListener('resize', update);
  };
}
