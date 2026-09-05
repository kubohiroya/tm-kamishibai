import {hasDsl4SourceFilenameSuffix} from './source-filename.js';
import {deepFreeze} from './story-document.js';
import {isCanonicalDsl4StoryPath} from './story-path.js';

const descriptorKeys = new Set(['entries', 'formatVersion']);
const entryKeys = new Set(['range', 'sourceId', 'storyPath']);
const rangeKeys = new Set(['end', 'start']);
const positionKeys = new Set(['column', 'line', 'offset']);
const textEncoder = new TextEncoder();

export const dsl4SourceOriginDefaultLimits = deepFreeze({
  maxEntries: 20_000,
  maxDescriptorBytes: 4 * 1024 * 1024,
  maxSourceIdScalars: 1_024,
  maxStoryPathScalars: 4_096,
});

export class Dsl4SourceOriginError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'Dsl4SourceOriginError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new Dsl4SourceOriginError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, name: string) {
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.has(key));
  const missing = [...keys].filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    fail(
      'K4-SOURCE-ORIGIN-SCHEMA-001',
      `${name} keys are invalid (unknown: ${unknown.sort().join(', ') || 'none'}; missing: ${missing.sort().join(', ') || 'none'})`,
    );
  }
}

function positiveSafeInteger(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

function resolveLimits(input: unknown) {
  if (input !== undefined && !isRecord(input)) {
    throw new TypeError('sourceOriginLimits must be an object');
  }
  const overrides = (input ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(overrides).filter(
    (key) => !Object.hasOwn(dsl4SourceOriginDefaultLimits, key),
  );
  if (unknown.length > 0) {
    throw new TypeError(`Unknown source origin limit: ${unknown.sort().join(', ')}`);
  }
  return {
    maxEntries: positiveSafeInteger(
      overrides.maxEntries ?? dsl4SourceOriginDefaultLimits.maxEntries,
      'maxEntries',
    ),
    maxDescriptorBytes: positiveSafeInteger(
      overrides.maxDescriptorBytes ?? dsl4SourceOriginDefaultLimits.maxDescriptorBytes,
      'maxDescriptorBytes',
    ),
    maxSourceIdScalars: positiveSafeInteger(
      overrides.maxSourceIdScalars ?? dsl4SourceOriginDefaultLimits.maxSourceIdScalars,
      'maxSourceIdScalars',
    ),
    maxStoryPathScalars: positiveSafeInteger(
      overrides.maxStoryPathScalars ?? dsl4SourceOriginDefaultLimits.maxStoryPathScalars,
      'maxStoryPathScalars',
    ),
  };
}

function boundedString(value: unknown, name: string, maximum: number) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    [...value].length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(
      'K4-SOURCE-ORIGIN-SCHEMA-001',
      `${name} must be a bounded non-empty string without control characters`,
    );
  }
  return value;
}

function sourceId(value: unknown, limits: ReturnType<typeof resolveLimits>) {
  const result = boundedString(value, 'sourceId', limits.maxSourceIdScalars);
  if (
    result.includes('\\') ||
    result.startsWith('/') ||
    /^[A-Za-z]:/u.test(result) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(result) ||
    !hasDsl4SourceFilenameSuffix(result)
  ) {
    fail('K4-SOURCE-ORIGIN-SOURCE-ID-001', 'sourceId must be a project-relative DSL 4 source path');
  }
  const segments = result.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('K4-SOURCE-ORIGIN-SOURCE-ID-001', 'sourceId must be a normalized project-relative path');
  }
  return result;
}

function storyPath(value: unknown, limits: ReturnType<typeof resolveLimits>) {
  const result = boundedString(value, 'storyPath', limits.maxStoryPathScalars);
  if (!isCanonicalDsl4StoryPath(result)) {
    fail('K4-SOURCE-ORIGIN-STORY-PATH-001', 'storyPath must use canonical DSL 4.0 escaping');
  }
  return result;
}

function position(value: unknown, name: string) {
  if (!isRecord(value)) {
    fail('K4-SOURCE-ORIGIN-RANGE-001', `${name} must be an object`);
  }
  exactKeys(value, positionKeys, name);
  const line = Number(value.line);
  const column = Number(value.column);
  const offset = Number(value.offset);
  if (
    !Number.isSafeInteger(line) ||
    line < 1 ||
    !Number.isSafeInteger(column) ||
    column < 1 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    fail(
      'K4-SOURCE-ORIGIN-RANGE-001',
      `${name} line and column must be >= 1 and offset must be >= 0`,
    );
  }
  return {line, column, offset};
}

function sourceRange(value: unknown) {
  if (!isRecord(value)) {
    fail('K4-SOURCE-ORIGIN-RANGE-001', 'range must be an object');
  }
  exactKeys(value, rangeKeys, 'range');
  const start = position(value.start, 'range.start');
  const end = position(value.end, 'range.end');
  if (
    end.offset < start.offset ||
    end.line < start.line ||
    (end.line === start.line && end.column < start.column)
  ) {
    fail('K4-SOURCE-ORIGIN-RANGE-001', 'range.end must not precede range.start');
  }
  return {start, end};
}

function entry(value: unknown, limits: ReturnType<typeof resolveLimits>, name: string) {
  if (!isRecord(value)) {
    fail('K4-SOURCE-ORIGIN-SCHEMA-001', `${name} must be an object`);
  }
  exactKeys(value, entryKeys, name);
  return {
    storyPath: storyPath(value.storyPath, limits),
    sourceId: sourceId(value.sourceId, limits),
    range: sourceRange(value.range),
  };
}

function enforceDescriptorBytes(
  descriptor: Record<string, unknown>,
  limits: ReturnType<typeof resolveLimits>,
) {
  const bytes = textEncoder.encode(JSON.stringify(descriptor)).byteLength;
  if (bytes > limits.maxDescriptorBytes) {
    fail(
      'K4-SOURCE-ORIGIN-LIMIT-001',
      `Source origin descriptor is ${bytes} bytes and exceeds the ${limits.maxDescriptorBytes} byte limit`,
    );
  }
}

/** Convert StoryDocument sourceOrigins into the persisted versioned descriptor. */
export function createDsl4SourceOriginDescriptor(
  input: unknown,
  limitOverrides?: Partial<typeof dsl4SourceOriginDefaultLimits>,
) {
  const limits = resolveLimits(limitOverrides);
  if (!isRecord(input)) {
    fail('K4-SOURCE-ORIGIN-SCHEMA-001', 'sourceOrigins must be an object');
  }
  const sourceEntries = Object.entries(input);
  if (sourceEntries.length === 0 || sourceEntries.length > limits.maxEntries) {
    fail(
      'K4-SOURCE-ORIGIN-LIMIT-001',
      `sourceOrigins must contain between 1 and ${limits.maxEntries} entries`,
    );
  }
  const entries = sourceEntries
    .map(([path, origin], index) =>
      entry(
        {
          ...(origin as Record<string, unknown>),
          storyPath: path,
        },
        limits,
        `sourceOrigins[${index}]`,
      ),
    )
    .sort((left, right) =>
      left.storyPath < right.storyPath ? -1 : left.storyPath > right.storyPath ? 1 : 0,
    );
  const descriptor = {formatVersion: 1, entries};
  enforceDescriptorBytes(descriptor, limits);
  return deepFreeze(descriptor);
}

export function validateDsl4SourceOriginDescriptor(
  input: unknown,
  limitOverrides?: Partial<typeof dsl4SourceOriginDefaultLimits>,
) {
  const limits = resolveLimits(limitOverrides);
  if (!isRecord(input)) {
    fail('K4-SOURCE-ORIGIN-SCHEMA-001', 'Source origin descriptor must be an object');
  }
  exactKeys(input, descriptorKeys, 'Source origin descriptor');
  if (input.formatVersion !== 1 || !Array.isArray(input.entries)) {
    fail('K4-SOURCE-ORIGIN-SCHEMA-001', 'Source origin descriptor format is invalid');
  }
  if (input.entries.length === 0 || input.entries.length > limits.maxEntries) {
    fail(
      'K4-SOURCE-ORIGIN-LIMIT-001',
      `Source origin descriptor must contain between 1 and ${limits.maxEntries} entries`,
    );
  }
  const entries = input.entries.map((value, index) =>
    entry(value, limits, `Source origin descriptor entry ${index}`),
  );
  for (let index = 1; index < entries.length; index += 1) {
    // The loop starts at one and stops at the length, so both entries are present.
    if ((entries[index - 1]?.storyPath ?? '') >= (entries[index]?.storyPath ?? '')) {
      fail(
        'K4-SOURCE-ORIGIN-ORDER-001',
        'Source origin entries must have unique storyPaths in canonical order',
      );
    }
  }
  const descriptor = {formatVersion: 1, entries};
  enforceDescriptorBytes(descriptor, limits);
  return deepFreeze(descriptor);
}

/** Restore included-source ranges after the composed canonical source is parsed at runtime. */
export function applyDsl4SourceOrigins(
  inputStoryDocument: unknown,
  inputDescriptor: unknown,
  limitOverrides?: Partial<typeof dsl4SourceOriginDefaultLimits>,
) {
  if (!isRecord(inputStoryDocument) || !isRecord(inputStoryDocument.sourceMap)) {
    throw new TypeError('A StoryDocument with sourceMap is required');
  }
  const storyDocument = inputStoryDocument as Readonly<Record<string, any>>;
  const descriptor = validateDsl4SourceOriginDescriptor(inputDescriptor, limitOverrides);
  const originsByPath = new Map(descriptor.entries.map((value) => [value.storyPath, value]));
  const storyPaths = Object.keys(storyDocument.sourceMap);
  const missing = storyPaths.filter((path) => !originsByPath.has(path));
  const unknown = descriptor.entries
    .map(({storyPath: path}) => path)
    .filter((path) => !Object.hasOwn(storyDocument.sourceMap, path));
  if (missing.length > 0 || unknown.length > 0) {
    fail(
      'K4-SOURCE-ORIGIN-COVERAGE-001',
      `Source origin coverage is invalid (missing: ${missing.sort().join(', ') || 'none'}; unknown: ${unknown.sort().join(', ') || 'none'})`,
    );
  }
  const sourceMap: Record<string, unknown> = {};
  const sourceOrigins: Record<string, unknown> = {};
  for (const path of storyPaths) {
    const origin = originsByPath.get(path) as Readonly<Record<string, any>>;
    sourceMap[path] = origin.range;
    sourceOrigins[path] = {sourceId: origin.sourceId, range: origin.range};
  }
  const scenes = (storyDocument.scenes as Readonly<Record<string, any>>[]).map((scene) => ({
    ...scene,
    actions: scene.actions.map((action: Readonly<Record<string, any>>) => ({
      ...action,
      sourceRange: sourceMap[action.id] ?? action.sourceRange,
    })),
  }));
  return deepFreeze({...storyDocument, scenes, sourceMap, sourceOrigins});
}
