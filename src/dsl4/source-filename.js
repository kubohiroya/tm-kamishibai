export const dsl4RecommendedSourceFilenameSuffix = '.k4.yml';

export const dsl4SourceFilenameSuffixes = Object.freeze([
  dsl4RecommendedSourceFilenameSuffix,
  '.k4.yaml',
  '.kamishibai.yml',
  '.kamishibai.yaml',
]);

/** @param {unknown} value @returns {value is string} */
export function hasDsl4SourceFilenameSuffix(value) {
  return (
    typeof value === 'string' && dsl4SourceFilenameSuffixes.some((suffix) => value.endsWith(suffix))
  );
}
