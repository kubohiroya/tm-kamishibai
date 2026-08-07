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
const anchorGrid = /** @type {Readonly<Record<string, readonly [number, number]>>} */ (
  Object.freeze({
    'top-left': [0, 0],
    'top-center': [1, 0],
    'top-right': [2, 0],
    'right-center': [2, 1],
    'bottom-right': [2, 2],
    'bottom-center': [1, 2],
    'bottom-left': [0, 2],
    'left-center': [0, 1],
  })
);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name */
function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

/** @param {unknown} value @param {string} name */
function anchor(value, name) {
  if (typeof value !== 'string' || !anchorSet.has(value)) {
    throw new TypeError(`${name} is not one of the eight preview anchors`);
  }
  return value;
}

/** @param {unknown} value */
function viewport(value) {
  if (!isRecord(value)) throw new TypeError('viewport must be an object');
  const width = finite(value.width, 'viewport.width');
  const height = finite(value.height, 'viewport.height');
  if (width < 44 || height < 44) throw new TypeError('viewport must fit a 44px target');
  return {width, height};
}

/** @param {unknown} value */
function insets(value) {
  if (!isRecord(value)) throw new TypeError('safeArea must be an object');
  return {
    top: finite(value.top, 'safeArea.top'),
    right: finite(value.right, 'safeArea.right'),
    bottom: finite(value.bottom, 'safeArea.bottom'),
    left: finite(value.left, 'safeArea.left'),
  };
}

/** @param {unknown} value @param {string} name */
function rect(value, name) {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object`);
  return {
    x: finite(value.x, `${name}.x`),
    y: finite(value.y, `${name}.y`),
    width: finite(value.width, `${name}.width`),
    height: finite(value.height, `${name}.height`),
  };
}

/** @param {Readonly<Record<string, number>>} left @param {Readonly<Record<string, number>>} right */
function intersects(left, right) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

/** @param {Readonly<Record<string, number>>} candidate @param {{width: number, height: number}} size @param {{top: number, right: number, bottom: number, left: number}} safe */
function inside(candidate, size, safe) {
  return (
    candidate.x >= safe.left &&
    candidate.y >= safe.top &&
    candidate.x + candidate.width <= size.width - safe.right &&
    candidate.y + candidate.height <= size.height - safe.bottom
  );
}

/** @param {string} value @param {{width: number, height: number}} size @param {{top: number, right: number, bottom: number, left: number}} safe @param {number} targetSize @param {number} margin */
function anchorRect(value, size, safe, targetSize, margin) {
  const [horizontal, vertical] = anchorGrid[value];
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

/** @param {string} left @param {string} right */
function anchorDistance(left, right) {
  const [leftX, leftY] = anchorGrid[left];
  const [rightX, rightY] = anchorGrid[right];
  return (leftX - rightX) ** 2 + (leftY - rightY) ** 2;
}

/**
 * Resolve one deterministic, safe-area-contained button layout from explicit geometry only.
 *
 * @param {object} input
 * @param {string} input.preferredAnchor
 * @param {unknown} input.viewport
 * @param {unknown} input.safeArea
 * @param {ReadonlyArray<unknown>} [input.reservedRects]
 * @param {number} [input.targetSize]
 * @param {number} [input.margin]
 */
export function resolveDsl4PreviewReloadLayout({
  preferredAnchor,
  viewport: inputViewport,
  safeArea: inputSafeArea,
  reservedRects = [],
  targetSize: inputTargetSize = 44,
  margin: inputMargin = 8,
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
  for (const [offsetX, offsetY] of offsets) {
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

/**
 * Own registered preview-chrome rectangles and defer movement during an active interaction.
 *
 * @param {object} options
 * @param {unknown} options.viewport
 * @param {unknown} [options.safeArea]
 * @param {number} [options.targetSize]
 * @param {(layout: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.onChange]
 */
export function createDsl4PreviewLayoutCoordinator(options) {
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
  /** @type {Readonly<Record<string, any>> | null} */
  let currentLayout = null;

  /** @param {Readonly<Record<string, any>>} layout */
  function publish(layout) {
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

  /** @param {string} preferredAnchor */
  function resolve(preferredAnchor) {
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
    /** @param {string} owner @param {unknown} value */
    register(owner, value) {
      const name = safeOwner(owner);
      reserved.set(name, rect(value, `reserved.${name}`));
      return name;
    },
    /** @param {string} owner @param {unknown} value */
    update(owner, value) {
      const name = safeOwner(owner);
      if (!reserved.has(name)) throw new TypeError('reserved rectangle owner is not registered');
      reserved.set(name, rect(value, `reserved.${name}`));
    },
    /** @param {string} owner */
    unregister(owner) {
      reserved.delete(safeOwner(owner));
    },
    /** @param {unknown} value @param {unknown} [nextSafeArea] */
    updateViewport(value, nextSafeArea) {
      currentViewport = viewport(value);
      if (nextSafeArea !== undefined) safeArea = insets(nextSafeArea);
    },
    /** @param {unknown} value */
    setInteraction(value) {
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

/** @param {unknown} value */
function safeOwner(value) {
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
