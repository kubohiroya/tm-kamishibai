function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
}

/**
 * Merge one style fragment into an effective style. Objects merge recursively; arrays and scalar
 * values replace the earlier value as a whole.
 */
function mergeFragment(
  target: Record<string, unknown>,
  fragment: Readonly<Record<string, unknown>>,
) {
  for (const [key, value] of Object.entries(fragment)) {
    const previous = target[key];
    if (isRecord(previous) && isRecord(value)) {
      mergeFragment(
        previous as Record<string, unknown>,
        value as Readonly<Record<string, unknown>>,
      );
    } else {
      target[key] = cloneValue(value);
    }
  }
}

function resolveBubbleStyle(
  styleId: string,
  bubbleStyles: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  stack: string[],
): Record<string, unknown> {
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

  const effectiveStyle: Record<string, unknown> = {};
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

/** Compose named bubble style fragments in declaration order. Later fragments win. */
export function composeBubbleStyles(
  styleIds: ReadonlyArray<string>,
  bubbleStyles: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): Record<string, unknown> {
  const effectiveStyle: Record<string, unknown> = {};
  for (const styleId of styleIds) {
    mergeFragment(effectiveStyle, resolveBubbleStyle(styleId, bubbleStyles, []));
  }
  return effectiveStyle;
}

export function bubbleStyleNameForStyleIds(styleIds: ReadonlyArray<string>) {
  return `\u0000dsl4:${JSON.stringify(styleIds)}`;
}
