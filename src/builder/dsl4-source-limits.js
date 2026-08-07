/** @param {unknown} value @param {string} name */
function positiveSafeInteger(value, name) {
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
 *
 * @param {object} input
 * @param {boolean} input.sourceIncludesEnabled
 * @param {unknown} input.maxSourceBytes
 * @param {unknown} [input.maxTotalSourceBytes]
 */
export function resolveDsl4BuildSourceLimits({
  sourceIncludesEnabled,
  maxSourceBytes,
  maxTotalSourceBytes,
}) {
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
