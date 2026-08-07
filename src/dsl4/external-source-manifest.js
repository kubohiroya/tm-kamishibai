import {validateDsl4CacheIdentity} from './cache-identity.js';
import {hasDsl4SourceFilenameSuffix} from './source-filename.js';
import {deepFreeze} from './story-document.js';

export const dsl4DefaultExternalSourcePath = 'story.kamishibai.yaml';

const requiredManifestKeys = new Set(['formatVersion', 'mode', 'sourceId']);
const manifestKeys = new Set([...requiredManifestKeys, 'path', 'cacheId', 'cacheDatabaseName']);

export class Dsl4ExternalSourceManifestError extends TypeError {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'Dsl4ExternalSourceManifestError';
    this.code = code;
  }
}

/** @param {string} code @param {string} message @returns {never} */
function fail(code, message) {
  throw new Dsl4ExternalSourceManifestError(code, message);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name */
function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail('K4-SOURCE-MANIFEST-001', `${name} must be a non-empty string without NUL`);
  }
  return value;
}

/** @param {unknown} value */
function sourcePath(value) {
  const source = value === undefined ? dsl4DefaultExternalSourcePath : value;
  if (typeof source !== 'string' || source.length === 0 || source.includes('\0')) {
    fail('K4-SOURCE-PATH-001', 'path must be a non-empty string without NUL');
  }
  const segments = source.split('/');
  if (
    source.includes('\\') ||
    source.startsWith('/') ||
    /^[A-Za-z]:/u.test(source) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(source) ||
    segments.length !== 1 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    !hasDsl4SourceFilenameSuffix(source)
  ) {
    fail('K4-SOURCE-PATH-001', 'path must be a root-level DSL 4 source basename');
  }
  return source;
}

/** @param {unknown} value @param {string} label */
function cacheIdentity(value, label) {
  try {
    return validateDsl4CacheIdentity({.../** @type {Record<string, unknown>} */ (value), label});
  } catch (error) {
    fail(
      'K4-SOURCE-MANIFEST-001',
      error instanceof Error ? error.message : 'Cache identity is invalid',
    );
  }
}

/**
 * Validate the browser-safe, platform-independent external source manifest contract.
 *
 * @param {unknown} input
 */
export function validateDsl4ExternalSourceManifestContract(input) {
  if (!isRecord(input)) {
    fail('K4-SOURCE-MANIFEST-001', 'External source manifest must be an object');
  }
  const keys = Object.keys(input);
  const unknown = keys.filter((key) => !manifestKeys.has(key));
  const missing = [...requiredManifestKeys].filter((key) => !Object.hasOwn(input, key));
  if (unknown.length > 0 || missing.length > 0) {
    fail(
      'K4-SOURCE-MANIFEST-001',
      `External source manifest keys are invalid (unknown: ${unknown.sort().join(', ') || 'none'}; missing: ${missing.sort().join(', ') || 'none'})`,
    );
  }
  if (input.formatVersion !== 1 || input.mode !== 'external') {
    fail('K4-SOURCE-MANIFEST-001', 'External source manifest formatVersion or mode is invalid');
  }
  const source = sourcePath(input.path);
  const hasCacheId = Object.hasOwn(input, 'cacheId');
  const hasCacheDatabaseName = Object.hasOwn(input, 'cacheDatabaseName');
  if (hasCacheId !== hasCacheDatabaseName) {
    fail(
      'K4-SOURCE-MANIFEST-001',
      'cacheId and cacheDatabaseName must either both be present or both be absent',
    );
  }
  const label = source.split('/').at(-1);
  const cache = hasCacheId
    ? cacheIdentity(
        {id: input.cacheId, databaseName: input.cacheDatabaseName},
        /** @type {string} */ (label),
      )
    : null;
  return deepFreeze({
    formatVersion: 1,
    mode: 'external',
    sourceId: nonEmptyString(input.sourceId, 'sourceId'),
    path: source,
    ...(cache ? {cacheId: cache.id, cacheDatabaseName: cache.databaseName} : {}),
  });
}
