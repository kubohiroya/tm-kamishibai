import {deepFreeze} from './story-document.js';

export const dsl4PreviewReloadAnchors = deepFreeze([
  'top-left',
  'top-center',
  'top-right',
  'right-center',
  'bottom-right',
  'bottom-center',
  'bottom-left',
  'left-center',
]);

const anchorSet = new Set(dsl4PreviewReloadAnchors);
const anchorGrid = Object.freeze({
  'top-left': [0, 0],
  'top-center': [1, 0],
  'top-right': [2, 0],
  'right-center': [2, 1],
  'bottom-right': [2, 2],
  'bottom-center': [1, 2],
  'bottom-left': [0, 2],
  'left-center': [0, 1],
}) as Readonly<Record<string, readonly [number, number]>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

function anchor(value: unknown, name: string) {
  if (typeof value !== 'string' || !anchorSet.has(value)) {
    throw new TypeError(`${name} is not one of the eight preview anchors`);
  }
  return value;
}

function viewport(value: unknown) {
  if (!isRecord(value)) throw new TypeError('viewport must be an object');
  const width = finite(value.width, 'viewport.width');
  const height = finite(value.height, 'viewport.height');
  if (width < 44 || height < 44) throw new TypeError('viewport must fit a 44px target');
  return {width, height};
}

function insets(value: unknown) {
  if (!isRecord(value)) throw new TypeError('safeArea must be an object');
  return {
    top: finite(value.top, 'safeArea.top'),
    right: finite(value.right, 'safeArea.right'),
    bottom: finite(value.bottom, 'safeArea.bottom'),
    left: finite(value.left, 'safeArea.left'),
  };
}

/** One rectangle in stage pixels, as `rect()` normalizes it. */
interface LayoutRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function rect(value: unknown, name: string) {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object`);
  return {
    x: finite(value.x, `${name}.x`),
    y: finite(value.y, `${name}.y`),
    width: finite(value.width, `${name}.width`),
    height: finite(value.height, `${name}.height`),
  };
}

function intersects(left: LayoutRect, right: LayoutRect) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function inside(
  candidate: LayoutRect,
  size: {width: number; height: number},
  safe: {top: number; right: number; bottom: number; left: number},
) {
  return (
    candidate.x >= safe.left &&
    candidate.y >= safe.top &&
    candidate.x + candidate.width <= size.width - safe.right &&
    candidate.y + candidate.height <= size.height - safe.bottom
  );
}

function anchorRect(
  value: string,
  size: {width: number; height: number},
  safe: {top: number; right: number; bottom: number; left: number},
  targetSize: number,
  margin: number,
) {
  // `value` is validated against the anchor names before it reaches here.
  const [horizontal = 0, vertical = 0] = anchorGrid[value] ?? [];
  const horizontalMargin = Math.min(
    margin,
    Math.max(0, (size.width - safe.left - safe.right - targetSize) / 2),
  );
  const verticalMargin = Math.min(
    margin,
    Math.max(0, (size.height - safe.top - safe.bottom - targetSize) / 2),
  );
  const minimumX = safe.left + horizontalMargin;
  const maximumX = size.width - safe.right - horizontalMargin - targetSize;
  const minimumY = safe.top + verticalMargin;
  const maximumY = size.height - safe.bottom - verticalMargin - targetSize;
  return {
    x: horizontal === 0 ? minimumX : horizontal === 1 ? (minimumX + maximumX) / 2 : maximumX,
    y: vertical === 0 ? minimumY : vertical === 1 ? (minimumY + maximumY) / 2 : maximumY,
    width: targetSize,
    height: targetSize,
  };
}

function anchorDistance(left: string, right: string) {
  const [leftX = 0, leftY = 0] = anchorGrid[left] ?? [];
  const [rightX, rightY] = anchorGrid[right];
  return (leftX - rightX) ** 2 + (leftY - rightY) ** 2;
}

/** Resolve one deterministic, safe-area-contained button layout from explicit geometry only. */
export function resolveDsl4PreviewReloadLayout({
  preferredAnchor,
  viewport: inputViewport,
  safeArea: inputSafeArea,
  reservedRects = [],
  targetSize: inputTargetSize = 44,
  margin: inputMargin = 8,
}: {
  preferredAnchor: string;
  viewport: unknown;
  safeArea: unknown;
  reservedRects?: ReadonlyArray<unknown>;
  targetSize?: number;
  margin?: number;
}) {
  const preferred = anchor(preferredAnchor, 'preferredAnchor');
  const size = viewport(inputViewport);
  const safe = insets(inputSafeArea);
  const targetSize = finite(inputTargetSize, 'targetSize');
  const margin = finite(inputMargin, 'margin');
  if (targetSize < 44) throw new TypeError('targetSize must be at least 44 CSS pixels');
  if (!Array.isArray(reservedRects)) throw new TypeError('reservedRects must be an array');
  const reserved = reservedRects.map((value, index) => rect(value, `reservedRects[${index}]`));
  const order = [...dsl4PreviewReloadAnchors].sort(
    (left, right) =>
      anchorDistance(preferred, left) - anchorDistance(preferred, right) ||
      dsl4PreviewReloadAnchors.indexOf(left) - dsl4PreviewReloadAnchors.indexOf(right),
  );
  for (const resolvedAnchor of order) {
    const candidate = anchorRect(resolvedAnchor, size, safe, targetSize, margin);
    if (!inside(candidate, size, safe) || reserved.some((entry) => intersects(candidate, entry))) {
      continue;
    }
    return deepFreeze({
      preferredAnchor: preferred,
      resolvedAnchor,
      rect: candidate,
      stacked: false,
      collisionReason:
        resolvedAnchor === preferred
          ? null
          : 'The preferred anchor is occupied by preview controls.',
    });
  }

  const origin = anchorRect(preferred, size, safe, targetSize, margin);
  const step = targetSize + margin;
  const offsets = [];
  for (let radius = 1; radius <= 12; radius += 1) {
    offsets.push([0, step * radius], [0, -step * radius], [step * radius, 0], [-step * radius, 0]);
  }
  for (const [offsetX = 0, offsetY = 0] of offsets) {
    const candidate = {...origin, x: origin.x + offsetX, y: origin.y + offsetY};
    if (inside(candidate, size, safe) && !reserved.some((entry) => intersects(candidate, entry))) {
      return deepFreeze({
        preferredAnchor: preferred,
        resolvedAnchor: preferred,
        rect: candidate,
        stacked: true,
        collisionReason: 'Every anchor is occupied; controls are stacked without overlap.',
      });
    }
  }
  throw new TypeError('preview viewport has no non-overlapping 44px reload target position');
}

/** Own registered preview-chrome rectangles and defer movement during an active interaction. */
export function createDsl4PreviewLayoutCoordinator(options: {
  viewport: unknown;
  safeArea?: unknown;
  targetSize?: number;
  onChange?: (layout: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
}) {
  if (!isRecord(options)) throw new TypeError('layout coordinator options are required');
  let currentViewport = viewport(options.viewport);
  let safeArea = insets(options.safeArea ?? {top: 0, right: 0, bottom: 0, left: 0});
  const targetSize = finite(options.targetSize ?? 44, 'targetSize');
  if (targetSize < 44) throw new TypeError('targetSize must be at least 44 CSS pixels');
  if (options.onChange !== undefined && typeof options.onChange !== 'function') {
    throw new TypeError('onChange must be a function');
  }
  const reserved = new Map();
  let interaction = {pressed: false, pointerCaptured: false, focused: false};
  let currentLayout: Readonly<Record<string, any>> | null = null;

  function publish(layout: Readonly<Record<string, any>>) {
    if (
      currentLayout &&
      currentLayout.resolvedAnchor === layout.resolvedAnchor &&
      currentLayout.rect.x === layout.rect.x &&
      currentLayout.rect.y === layout.rect.y
    ) {
      currentLayout = layout;
      return;
    }
    currentLayout = layout;
    try {
      Promise.resolve(options.onChange?.(layout)).catch(() => {});
    } catch {
      // Layout observers cannot change resolution.
    }
  }

  function resolve(preferredAnchor: string) {
    const next = resolveDsl4PreviewReloadLayout({
      preferredAnchor,
      viewport: currentViewport,
      safeArea,
      reservedRects: [...reserved.values()],
      targetSize,
    });
    const interacting = interaction.pressed || interaction.pointerCaptured || interaction.focused;
    if (interacting && currentLayout && inside(currentLayout.rect, currentViewport, safeArea)) {
      const deferred = deepFreeze({
        ...currentLayout,
        preferredAnchor: anchor(preferredAnchor, 'preferredAnchor'),
        movementDeferred: true,
        collisionReason: 'Reload button movement is deferred until the interaction ends.',
      });
      publish(deferred);
      return deferred;
    }
    const committed = deepFreeze({...next, movementDeferred: false});
    publish(committed);
    return committed;
  }

  return Object.freeze({
    resolve,
    register(owner: string, value: unknown) {
      const name = safeOwner(owner);
      reserved.set(name, rect(value, `reserved.${name}`));
      return name;
    },
    update(owner: string, value: unknown) {
      const name = safeOwner(owner);
      if (!reserved.has(name)) throw new TypeError('reserved rectangle owner is not registered');
      reserved.set(name, rect(value, `reserved.${name}`));
    },
    unregister(owner: string) {
      reserved.delete(safeOwner(owner));
    },
    updateViewport(value: unknown, nextSafeArea?: unknown) {
      currentViewport = viewport(value);
      if (nextSafeArea !== undefined) safeArea = insets(nextSafeArea);
    },
    setInteraction(value: unknown) {
      if (
        !isRecord(value) ||
        typeof value.pressed !== 'boolean' ||
        typeof value.pointerCaptured !== 'boolean' ||
        typeof value.focused !== 'boolean'
      ) {
        throw new TypeError('layout interaction state is invalid');
      }
      interaction = {
        pressed: value.pressed,
        pointerCaptured: value.pointerCaptured,
        focused: value.focused,
      };
    },
    getState() {
      return deepFreeze({
        version: 1,
        viewport: currentViewport,
        safeArea,
        targetSize,
        reservedOwners: [...reserved.keys()].sort(),
        interaction,
        layout: currentLayout,
      });
    },
  });
}

function safeOwner(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 100 ||
    !/^[A-Za-z][A-Za-z0-9._-]*$/u.test(value)
  ) {
    throw new TypeError('reserved rectangle owner is invalid');
  }
  return value;
}
