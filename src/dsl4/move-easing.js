export const dsl4MoveEasingNames = Object.freeze(['linear', 'easeIn', 'easeOut', 'easeInOut']);

const moveEasingNames = new Set(dsl4MoveEasingNames);

/** @param {unknown} value @returns {value is (typeof dsl4MoveEasingNames)[number]} */
export function isDsl4MoveEasing(value) {
  return typeof value === 'string' && moveEasingNames.has(value);
}

/**
 * Apply a named DSL 4.0 movement curve to normalized elapsed time.
 *
 * @param {(typeof dsl4MoveEasingNames)[number]} easing
 * @param {number} progress
 */
export function applyDsl4MoveEasing(easing, progress) {
  if (!isDsl4MoveEasing(easing)) throw new TypeError(`Unknown move easing: ${String(easing)}`);
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new TypeError('Move easing progress must be a finite number from 0 through 1');
  }
  if (easing === 'easeIn') return progress * progress;
  if (easing === 'easeOut') return 1 - (1 - progress) * (1 - progress);
  if (easing === 'easeInOut') {
    return progress < 0.5
      ? 2 * progress * progress
      : 1 - ((-2 * progress + 2) * (-2 * progress + 2)) / 2;
  }
  return progress;
}
