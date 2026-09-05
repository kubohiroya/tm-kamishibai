import {isMap, parseAllDocuments, stringify} from 'yaml';

import {validateDsl4CacheIdentity} from './cache-identity.js';
import {hasDsl4SourceFilenameSuffix} from './source-filename.js';
import {deepFreeze} from './story-document.js';

export const dsl4ProjectSourceFilenameSuffix = '.k4.yml';
export const dsl4ExternalSourceManifestFilenames = deepFreeze([
  'project.source.yml',
  'project.source.yaml',
  'project.source.json',
]);
export const dsl4DefaultExternalSourceManifestFilename = dsl4ExternalSourceManifestFilenames[0];
export const dsl4ExternalSourceManifestDefaults = deepFreeze({
  formatVersion: 1,
  mode: 'external',
  sourceId: 'main',
});

const manifestKeys = new Set([
  'formatVersion',
  'mode',
  'sourceId',
  'path',
  'cacheId',
  'cacheDatabaseName',
]);

export class Dsl4ExternalSourceManifestError extends TypeError {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'Dsl4ExternalSourceManifestError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new Dsl4ExternalSourceManifestError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function manifestFilename(value: unknown) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail('K4-SOURCE-MANIFEST-001', 'Source manifest filename must be a non-empty string');
  }
  const leaf = value.split(/[\\/]/u).at(-1);
  if (leaf?.endsWith('.yml') || leaf?.endsWith('.yaml')) return {filename: leaf, format: 'yaml'};
  if (leaf?.endsWith('.json')) return {filename: leaf, format: 'json'};
  fail('K4-SOURCE-MANIFEST-001', 'Source manifest filename must end in .yml, .yaml, or .json');
}

function parseYamlManifest(source: string) {
  const documents = parseAllDocuments(source, {
    prettyErrors: false,
    schema: 'core',
    strict: true,
    uniqueKeys: true,
  });
  const issue = documents.flatMap((document) => [...document.errors, ...document.warnings])[0];
  const empty = documents.length === 0 || documents.every((document) => document.contents === null);
  if (issue || (!empty && (documents.length !== 1 || !isMap(documents[0]?.contents)))) {
    fail(
      'K4-SOURCE-MANIFEST-YAML-001',
      issue?.message ?? 'Source manifest YAML must contain exactly one mapping document',
    );
  }
  if (empty) return {};
  try {
    const value = documents[0]?.toJS({mapAsMap: false, maxAliasCount: 0});
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

function parseJsonManifest(source: string) {
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

function nonEmptyString(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail('K4-SOURCE-MANIFEST-001', `${name} must be a non-empty string without NUL`);
  }
  return value;
}

function sourcePath(value: unknown) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail('K4-SOURCE-PATH-001', 'path must be a non-empty string without NUL');
  }
  const segments = value.split('/');
  if (
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ||
    segments.length !== 1 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    !hasDsl4SourceFilenameSuffix(value)
  ) {
    fail('K4-SOURCE-PATH-001', 'path must be a root-level DSL 4 source basename');
  }
  return value;
}

function sourceCandidates(value: unknown) {
  if (!Array.isArray(value)) {
    fail('K4-SOURCE-MANIFEST-001', 'sourcePaths must be an array');
  }
  const normalized = value.map((candidate) => sourcePath(candidate));
  if (new Set(normalized).size !== normalized.length) {
    fail('K4-SOURCE-MANIFEST-001', 'sourcePaths must not contain duplicates');
  }
  return normalized
    .filter((candidate) => candidate.endsWith(dsl4ProjectSourceFilenameSuffix))
    .sort();
}

function cacheIdentity(value: unknown, label: string) {
  try {
    return validateDsl4CacheIdentity({...(value as Record<string, unknown>), label});
  } catch (error) {
    fail(
      'K4-SOURCE-MANIFEST-001',
      error instanceof Error ? error.message : 'Cache identity is invalid',
    );
  }
}

/** Validate the browser-safe, platform-independent external source manifest contract. */
export function validateDsl4ExternalSourceManifestContract(input: unknown) {
  if (!isRecord(input)) {
    fail('K4-SOURCE-MANIFEST-001', 'External source manifest must be an object');
  }
  const keys = Object.keys(input);
  const unknown = keys.filter((key) => !manifestKeys.has(key));
  if (unknown.length > 0) {
    fail(
      'K4-SOURCE-MANIFEST-001',
      `External source manifest keys are invalid (unknown: ${unknown.sort().join(', ')})`,
    );
  }
  const formatVersion = input.formatVersion ?? dsl4ExternalSourceManifestDefaults.formatVersion;
  const mode = input.mode ?? dsl4ExternalSourceManifestDefaults.mode;
  const sourceId = input.sourceId ?? dsl4ExternalSourceManifestDefaults.sourceId;
  if (formatVersion !== 1 || mode !== 'external') {
    fail('K4-SOURCE-MANIFEST-001', 'External source manifest formatVersion or mode is invalid');
  }
  const source = input.path === undefined ? null : sourcePath(input.path);
  const hasCacheId = Object.hasOwn(input, 'cacheId');
  const hasCacheDatabaseName = Object.hasOwn(input, 'cacheDatabaseName');
  if (hasCacheId !== hasCacheDatabaseName) {
    fail(
      'K4-SOURCE-MANIFEST-001',
      'cacheId and cacheDatabaseName must either both be present or both be absent',
    );
  }
  const label = source?.split('/').at(-1) ?? 'source.k4.yml';
  const cache = hasCacheId
    ? cacheIdentity({id: input.cacheId, databaseName: input.cacheDatabaseName}, label as string)
    : null;
  return deepFreeze({
    formatVersion: 1,
    mode: 'external',
    sourceId: nonEmptyString(sourceId, 'sourceId'),
    ...(source === null ? {} : {path: source}),
    ...(cache ? {cacheId: cache.id, cacheDatabaseName: cache.databaseName} : {}),
  });
}

/** Resolve an optional manifest config to one unambiguous root-level entry source. */
export function resolveDsl4ExternalSourceManifestContract(
  input: unknown,
  {
    sourcePaths = [],
    sourcePath: inputSourcePath,
    sourceId: inputSourceId,
  }: {sourcePaths?: string[]; sourcePath?: string; sourceId?: string} = {},
) {
  const manifest = validateDsl4ExternalSourceManifestContract(input);
  const candidates = sourceCandidates(sourcePaths);
  let path = inputSourcePath === undefined ? manifest.path : sourcePath(inputSourcePath);
  if (path === undefined) {
    if (candidates.length === 0) {
      fail(
        'K4-SOURCE-MISSING',
        `Project root contains no ${dsl4ProjectSourceFilenameSuffix} entry source`,
      );
    }
    if (candidates.length > 1) {
      fail(
        'K4-SOURCE-AMBIGUOUS',
        `Project root contains multiple ${dsl4ProjectSourceFilenameSuffix} entry sources; select one explicitly`,
      );
    }
    [path] = candidates;
  }
  return deepFreeze({
    ...manifest,
    sourceId:
      inputSourceId === undefined ? manifest.sourceId : nonEmptyString(inputSourceId, 'sourceId'),
    path,
  });
}

/** Parse and validate one UTF-8-decoded source manifest while preserving JSON compatibility. */
export function parseDsl4ExternalSourceManifestSource(
  source: string,
  {filename = dsl4DefaultExternalSourceManifestFilename}: {filename?: string} = {},
) {
  if (typeof source !== 'string') {
    throw new TypeError('Source manifest source must be a string');
  }
  const descriptor = manifestFilename(filename);
  const input =
    descriptor.format === 'yaml' ? parseYamlManifest(source) : parseJsonManifest(source);
  return validateDsl4ExternalSourceManifestContract(input);
}

/** Serialize a validated source manifest in the format selected by its filename. */
export function serializeDsl4ExternalSourceManifestSource(
  input: unknown,
  {filename = dsl4DefaultExternalSourceManifestFilename}: {filename?: string} = {},
) {
  const manifest = validateDsl4ExternalSourceManifestContract(input);
  const descriptor = manifestFilename(filename);
  if (descriptor.format === 'json') return `${JSON.stringify(manifest, null, 2)}\n`;
  return stringify(manifest, {lineWidth: 0, sortMapEntries: false});
}
