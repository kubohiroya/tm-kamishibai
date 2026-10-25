export interface Dsl4Viewport {
  readonly width: number;
  readonly height: number;
  readonly orientation: 'landscape' | 'portrait';
  readonly fit: 'contain' | 'cover';
}

/** One logical stage for canvas, renderer overlays, camera and input, independent of window size. */
export function resolveDsl4Viewport(input: unknown = undefined): Readonly<Dsl4Viewport> {
  if (input === undefined)
    return Object.freeze({width: 480, height: 360, orientation: 'landscape', fit: 'contain'});
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('viewport must be an object');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['width', 'height', 'orientation', 'fit'].includes(key)))
    throw new TypeError('Unknown viewport key');
  const {width, height} = value;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    Number(width) < 1 ||
    Number(height) < 1 ||
    Number(width) > 4096 ||
    Number(height) > 4096 ||
    Number(width) * Number(height) > 4_194_304
  )
    throw new TypeError(
      'viewport dimensions must be positive integers with at most 4194304 pixels',
    );
  const orientation =
    value.orientation ?? (Number(width) >= Number(height) ? 'landscape' : 'portrait');
  if (
    !['landscape', 'portrait'].includes(String(orientation)) ||
    (orientation === 'landscape' && Number(width) < Number(height)) ||
    (orientation === 'portrait' && Number(height) < Number(width))
  )
    throw new TypeError('viewport orientation must match its fixed logical dimensions');
  const fit = value.fit ?? 'contain';
  if (fit !== 'contain' && fit !== 'cover')
    throw new TypeError('viewport fit must be contain or cover');
  return Object.freeze({
    width: Number(width),
    height: Number(height),
    orientation,
    fit,
  }) as Readonly<Dsl4Viewport>;
}

/** CSS safe-area insets and crop/letterbox use the same centered affine transform in both directions. */
export function computeDsl4ViewportTransform(
  viewport: Dsl4Viewport,
  bounds: Readonly<{x?: number; y?: number; width: number; height: number}>,
  safeArea: Readonly<{top?: number; right?: number; bottom?: number; left?: number}> = {},
) {
  const definition = resolveDsl4Viewport(viewport);
  const {width, height} = bounds;
  if (
    ![bounds.x ?? 0, bounds.y ?? 0, width, height].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0
  )
    throw new TypeError('viewport bounds must be finite and positive');
  const top = safeArea.top ?? 0,
    right = safeArea.right ?? 0,
    bottom = safeArea.bottom ?? 0,
    left = safeArea.left ?? 0;
  if (
    ![top, right, bottom, left].every((value) => Number.isFinite(value) && value >= 0) ||
    left + right >= width ||
    top + bottom >= height
  )
    throw new TypeError('safe area must leave a positive viewport');
  const availableWidth = width - left - right,
    availableHeight = height - top - bottom;
  const scale = (definition.fit === 'cover' ? Math.max : Math.min)(
    availableWidth / definition.width,
    availableHeight / definition.height,
  );
  const x = (bounds.x ?? 0) + left + (availableWidth - definition.width * scale) / 2;
  const y = (bounds.y ?? 0) + top + (availableHeight - definition.height * scale) / 2;
  return Object.freeze({
    x,
    y,
    scale,
    width: definition.width * scale,
    height: definition.height * scale,
    toClient(stageX: number, stageY: number) {
      return {
        x: x + (stageX + definition.width / 2) * scale,
        y: y + (definition.height / 2 - stageY) * scale,
      };
    },
    toStage(clientX: number, clientY: number) {
      const localX = (clientX - x) / scale,
        localY = (clientY - y) / scale;
      return {
        x: localX - definition.width / 2,
        y: definition.height / 2 - localY,
        inside:
          localX >= 0 &&
          localY >= 0 &&
          localX <= definition.width &&
          localY <= definition.height &&
          clientX >= (bounds.x ?? 0) + left &&
          clientX <= (bounds.x ?? 0) + width - right &&
          clientY >= (bounds.y ?? 0) + top &&
          clientY <= (bounds.y ?? 0) + height - bottom,
      };
    },
  });
}

/** Use TurboWarp's native size so WebGL, DOM overlays and VM pointer conversion agree. */
export function applyDsl4Viewport(runtimeInput: unknown, input: unknown) {
  const viewport = resolveDsl4Viewport(input);
  const runtime = runtimeInput as {
    setStageSize?: (width: number, height: number) => unknown;
    renderer?: {setStageSize?: (...bounds: number[]) => unknown};
  };
  if (input !== undefined) {
    if (typeof runtime?.setStageSize !== 'function')
      throw new TypeError('Variable viewport requires native stage-size support');
    runtime.setStageSize(viewport.width, viewport.height);
  }
  return viewport;
}

interface ViewportRuntime {
  stageWidth?: number;
  stageHeight?: number;
  setStageSize?(width: number, height: number): unknown;
}
interface ViewportLease {
  runtime: ViewportRuntime;
  baseline: {width: number; height: number};
  owners: {viewport: Readonly<Dsl4Viewport>}[];
}
const viewportLeases = new WeakMap<object, ViewportLease>();
/** Nested preview owners release only their own lease; a newer session keeps its native size. */
export function createDsl4ViewportOwner(inputRuntime: unknown, input: unknown) {
  const runtime = inputRuntime as ViewportRuntime;
  const viewport = resolveDsl4Viewport(input);
  let lease: ViewportLease | undefined, entry: {viewport: Readonly<Dsl4Viewport>} | undefined;
  let closed = false;
  return Object.freeze({
    activate() {
      if (closed) throw new TypeError('Viewport owner is closed');
      if (entry) return;
      const existing = viewportLeases.get(runtime);
      if (input === undefined && !existing) return;
      if (typeof runtime.setStageSize !== 'function')
        throw new TypeError('Variable viewport requires native stage-size support');
      lease = existing ?? {
        runtime,
        baseline: {width: runtime.stageWidth ?? 480, height: runtime.stageHeight ?? 360},
        owners: [],
      };
      viewportLeases.set(runtime, lease);
      entry = {viewport};
      lease.owners.push(entry);
      runtime.setStageSize(viewport.width, viewport.height);
    },
    dispose() {
      closed = true;
      if (!entry || !lease) return;
      const index = lease.owners.indexOf(entry);
      if (index < 0) {
        entry = undefined;
        return;
      }
      if (index === lease.owners.length - 1) {
        const previous = lease.owners[index - 1]?.viewport ?? lease.baseline;
        runtime.setStageSize!(previous.width, previous.height);
      }
      lease.owners.splice(index, 1);
      entry = undefined;
      if (!lease.owners.length) viewportLeases.delete(runtime);
    },
  });
}
