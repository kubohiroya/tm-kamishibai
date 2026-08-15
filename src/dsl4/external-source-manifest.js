import {isMap, parseAllDocuments, stringify} from 'yaml';

import {validateDsl4CacheIdentity} from './cache-identity.js';
import {hasDsl4SourceFilenameSuffix} from './source-filename.js';
import {deepFreeze} from './story-document.js';

export const dsl4DefaultExternalSourcePath = 'story.kamishibai.yaml';
export const dsl4ExternalSourceManifestFilenames = deepFreeze([
  'project.source.yaml',
  'project.source.json',
]);
export const dsl4DefaultExternalSourceManifestFilename = dsl4ExternalSourceManifestFilenames[0];

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

/** @param {unknown} value */
function manifestFilename(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail('K4-SOURCE-MANIFEST-001', 'Source manifest filename must be a non-empty string');
  }
  const leaf = value.split(/[\\/]/u).at(-1);
  if (leaf?.endsWith('.yaml')) return {filename: leaf, format: 'yaml'};
  if (leaf?.endsWith('.json')) return {filename: leaf, format: 'json'};
  fail('K4-SOURCE-MANIFEST-001', 'Source manifest filename must end in .yaml or .json');
}

/** @param {string} source */
function parseYamlManifest(source) {
  const documents = parseAllDocuments(source, {
    prettyErrors: false,
    schema: 'core',
    strict: true,
    uniqueKeys: true,
  });
  const issue = documents.flatMap((document) => [...document.errors, ...document.warnings])[0];
  if (issue || documents.length !== 1 || !isMap(documents[0]?.contents)) {
    fail(
      'K4-SOURCE-MANIFEST-YAML-001',
      issue?.message ?? 'Source manifest YAML must contain exactly one mapping document',
    );
  }
  try {
    const value = documents[0].toJS({mapAsMap: false, maxAliasCount: 0});
    if (!isRecord(value)) {
      fail('K4-SOURCE-MANIFEST-YAML-001', 'Source manifest YAML must contain one mapping');
    }
    return value;
  } catch (error) {
    if (error instanceof Dsl4ExternalSourceManifestError) throw error;
    fail(
      'K4-SOURCE-MANIFEST-YAML-001',
      error instanceof Error ? error.message : 'Source manifest YAML is invalid',
    );
  }
}

/** @param {string} source */
function parseJsonManifest(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    fail(
      'K4-SOURCE-MANIFEST-JSON-001',
      error instanceof Error ? error.message : 'Source manifest JSON is invalid',
    );
  }
  if (!isRecord(value)) {
    fail('K4-SOURCE-MANIFEST-JSON-001', 'Source manifest JSON must contain one object');
  }
  return value;
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

/**
 * Parse and validate one UTF-8-decoded source manifest while preserving JSON compatibility.
 *
 * @param {string} source
 * @param {object} [options]
 * @param {string} [options.filename]
 */
export function parseDsl4ExternalSourceManifestSource(
  source,
  {filename = dsl4DefaultExternalSourceManifestFilename} = {},
) {
  if (typeof source !== 'string') {
    throw new TypeError('Source manifest source must be a string');
  }
  const descriptor = manifestFilename(filename);
  const input =
    descriptor.format === 'yaml' ? parseYamlManifest(source) : parseJsonManifest(source);
  return validateDsl4ExternalSourceManifestContract(input);
}

/**
 * Serialize a validated source manifest in the format selected by its filename.
 *
 * @param {unknown} input
 * @param {object} [options]
 * @param {string} [options.filename]
 */
export function serializeDsl4ExternalSourceManifestSource(
  input,
  {filename = dsl4DefaultExternalSourceManifestFilename} = {},
) {
  const manifest = validateDsl4ExternalSourceManifestContract(input);
  const descriptor = manifestFilename(filename);
  if (descriptor.format === 'json') return `${JSON.stringify(manifest, null, 2)}\n`;
  return stringify(manifest, {lineWidth: 0, sortMapEntries: false});
}
