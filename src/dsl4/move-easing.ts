export const dsl4MoveEasingNames = Object.freeze([
  'linear',
  'easeIn',
  'easeOut',
  'easeInOut',
] as const);

export type Dsl4MoveEasing = (typeof dsl4MoveEasingNames)[number];

const moveEasingNames: ReadonlySet<string> = new Set(dsl4MoveEasingNames);

export function isDsl4MoveEasing(value: unknown): value is Dsl4MoveEasing {
  return typeof value === 'string' && moveEasingNames.has(value);
}

/** Apply a named DSL 4.0 movement curve to normalized elapsed time. */
export function applyDsl4MoveEasing(easing: Dsl4MoveEasing, progress: number): number {
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
