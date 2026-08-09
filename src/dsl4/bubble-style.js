/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {unknown} */
function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
}

/**
 * Merge one style fragment into an effective style. Objects merge recursively; arrays and scalar
 * values replace the earlier value as a whole.
 *
 * @param {Record<string, unknown>} target
 * @param {Readonly<Record<string, unknown>>} fragment
 */
function mergeFragment(target, fragment) {
  for (const [key, value] of Object.entries(fragment)) {
    const previous = target[key];
    if (isRecord(previous) && isRecord(value)) {
      mergeFragment(
        /** @type {Record<string, unknown>} */ (previous),
        /** @type {Readonly<Record<string, unknown>>} */ (value),
      );
    } else {
      target[key] = cloneValue(value);
    }
  }
}

/**
 * @param {string} styleId
 * @param {Readonly<Record<string, Readonly<Record<string, unknown>>>>} bubbleStyles
 * @param {string[]} stack
 * @returns {Record<string, unknown>}
 */
function resolveBubbleStyle(styleId, bubbleStyles, stack) {
  const cycleStart = stack.indexOf(styleId);
  if (cycleStart !== -1) {
    const cycle = [...stack.slice(cycleStart), styleId];
    const error = new Error(`Bubble style cycle: ${cycle.join(' -> ')}`);
    Object.defineProperties(error, {
      code: {value: 'K4-RUNTIME-SPEECH-STYLE-001'},
      reason: {value: 'cycle'},
      cycle: {value: cycle},
    });
    throw error;
  }

  const fragment = bubbleStyles[styleId];
  if (!isRecord(fragment)) {
    const error = new Error(`Bubble style is unavailable: ${styleId}`);
    Object.defineProperties(error, {
      code: {value: 'K4-RUNTIME-SPEECH-STYLE-001'},
      reason: {value: 'missing'},
      styleId: {value: styleId},
    });
    throw error;
  }

  const inheritedStyleIds = fragment.styles ?? [];
  if (
    !Array.isArray(inheritedStyleIds) ||
    inheritedStyleIds.some((inheritedStyleId) => typeof inheritedStyleId !== 'string') ||
    new Set(inheritedStyleIds).size !== inheritedStyleIds.length
  ) {
    const error = new Error(`Bubble style ${styleId}.styles must contain unique style names`);
    Object.defineProperties(error, {
      code: {value: 'K4-RUNTIME-SPEECH-STYLE-001'},
      reason: {value: 'invalid'},
      styleId: {value: styleId},
    });
    throw error;
  }

  const effectiveStyle = {};
  const nextStack = [...stack, styleId];
  for (const inheritedStyleId of inheritedStyleIds) {
    mergeFragment(effectiveStyle, resolveBubbleStyle(inheritedStyleId, bubbleStyles, nextStack));
  }
  mergeFragment(
    effectiveStyle,
    Object.fromEntries(Object.entries(fragment).filter(([key]) => key !== 'styles')),
  );
  return effectiveStyle;
}

/**
 * Compose named bubble style fragments in declaration order. Later fragments win.
 *
 * @param {ReadonlyArray<string>} styleIds
 * @param {Readonly<Record<string, Readonly<Record<string, unknown>>>>} bubbleStyles
 * @returns {Record<string, unknown>}
 */
export function composeBubbleStyles(styleIds, bubbleStyles) {
  const effectiveStyle = {};
  for (const styleId of styleIds) {
    mergeFragment(effectiveStyle, resolveBubbleStyle(styleId, bubbleStyles, []));
  }
  return effectiveStyle;
}

/** @param {ReadonlyArray<string>} styleIds */
export function bubbleStyleNameForStyleIds(styleIds) {
  return `\u0000dsl4:${JSON.stringify(styleIds)}`;
}
