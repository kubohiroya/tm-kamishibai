function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

/**
 * Resolve the authoring and packaged-source limits used by every build boundary.
 *
 * A single-source build uses maxSourceBytes throughout. An include build uses maxSourceBytes for
 * each graph node and maxTotalSourceBytes for both the graph-node byte total and composed canonical
 * source persisted in the package.
 */
export function resolveDsl4BuildSourceLimits({
  sourceIncludesEnabled,
  maxSourceBytes,
  maxTotalSourceBytes,
}: {
  sourceIncludesEnabled: boolean;
  maxSourceBytes: unknown;
  maxTotalSourceBytes?: unknown;
}): Readonly<{
  maxSourceFileBytes: number;
  maxSourceGraphBytes: number;
  maxComposedSourceBytes: number;
  maxPackagedSourceBytes: number;
}> {
  if (typeof sourceIncludesEnabled !== 'boolean') {
    throw new TypeError('sourceIncludesEnabled must be a boolean');
  }
  const maxSourceFileBytes = positiveSafeInteger(maxSourceBytes, 'maxSourceBytes');
  if (!sourceIncludesEnabled) {
    return Object.freeze({
      maxSourceFileBytes,
      maxSourceGraphBytes: maxSourceFileBytes,
      maxComposedSourceBytes: maxSourceFileBytes,
      maxPackagedSourceBytes: maxSourceFileBytes,
    });
  }
  const maxSourceGraphBytes = positiveSafeInteger(maxTotalSourceBytes, 'maxTotalSourceBytes');
  if (maxSourceGraphBytes < maxSourceFileBytes) {
    throw new TypeError('maxTotalSourceBytes must be greater than or equal to maxSourceBytes');
  }
  return Object.freeze({
    maxSourceFileBytes,
    maxSourceGraphBytes,
    maxComposedSourceBytes: maxSourceGraphBytes,
    maxPackagedSourceBytes: maxSourceGraphBytes,
  });
}
