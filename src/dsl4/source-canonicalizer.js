/**
 * Canonicalize DSL 4.0 source without importing the schema or YAML parser.
 *
 * @param {string} source
 * @returns {string}
 */
export function canonicalizeDsl4Source(source) {
  if (typeof source !== 'string') throw new TypeError('DSL 4.0 source must be a string');
  return source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}
