const motionNames = new Set([
  'fadeIn',
  'fadeOut',
  'floatIn',
  'floatOut',
  'zoomIn',
  'zoomOut',
  'riseUp',
  'sink',
  'shake',
  'explode',
  'animateBubbleShape',
]);
const easeNames = new Set(['linear', 'easeIn', 'easeOut', 'easeInOut']);
const visualStyleNames = new Set([
  'NORMAL',
  'THINKING',
  'DREAMING',
  'YELLING',
  'OFF_PANEL',
  'WAVY',
  'WHISPERING',
  'ANNOUNCEMENT',
  'NARRATION',
  'NO_BUBBLE',
]);
const motionFields = new Set([
  'name',
  'durationSeconds',
  'ease',
  'direction',
  'count',
  'relativeScale',
  'speed',
  'visualStyle',
]);

function isRecord(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteBoundedNumber(value: unknown, strictlyPositive = false) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (strictlyPositive ? value > 0 : value >= 0)
  );
}

/** Validate the platform boundary for DSL 4.0 Bubble handle animations. */
export function normalizeDsl4BubbleMotions(
  value: unknown,
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('Bubble motions must be a non-empty array');
  }
  return Object.freeze(
    value.map((motion) => {
      if (
        !isRecord(motion) ||
        Object.keys(motion).some((field) => !motionFields.has(field)) ||
        !motionNames.has(String(motion.name)) ||
        (motion.durationSeconds !== undefined && !isFiniteBoundedNumber(motion.durationSeconds)) ||
        (motion.ease !== undefined && !easeNames.has(String(motion.ease))) ||
        (motion.direction !== undefined &&
          !(typeof motion.direction === 'number' && Number.isFinite(motion.direction)) &&
          !(typeof motion.direction === 'string' && motion.direction.length > 0)) ||
        (motion.count !== undefined &&
          (!Number.isInteger(motion.count) || (motion.count as number) < 1)) ||
        (motion.relativeScale !== undefined && !isFiniteBoundedNumber(motion.relativeScale)) ||
        (motion.speed !== undefined && !isFiniteBoundedNumber(motion.speed)) ||
        (motion.visualStyle !== undefined && !visualStyleNames.has(String(motion.visualStyle)))
      ) {
        throw new TypeError('Bubble motion is invalid');
      }
      return Object.freeze({...motion});
    }),
  );
}
