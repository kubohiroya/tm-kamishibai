import {deepFreeze} from './story-document.js';

export const dsl4DiagnosticTruncationCode = 'K4-DIAGNOSTICS-TRUNCATED';

const diagnosticKeys = new Set([
  'version',
  'code',
  'severity',
  'message',
  'sourceId',
  'range',
  'storyPath',
  'path',
  'related',
]);
const requiredDiagnosticKeys = new Set([...diagnosticKeys].filter((key) => key !== 'storyPath'));
const locationKeys = new Set(['message', 'sourceId', 'range', 'storyPath', 'path']);
const requiredLocationKeys = new Set([...locationKeys].filter((key) => key !== 'storyPath'));
const rangeKeys = new Set(['start', 'end']);
const positionKeys = new Set(['line', 'column', 'offset']);
const policyKeys = new Set(['maxDiagnostics', 'maxRelatedLocations']);
const diagnosticCodePattern = /^K4-[A-Z0-9]+(?:-[A-Z0-9]+)*$/u;

export class Dsl4DiagnosticPolicyError extends Error {
  code: string;
  path: string;

  constructor(code: string, message: string, path: string) {
    super(`${path}: ${message}`);
    this.name = 'Dsl4DiagnosticPolicyError';
    this.code = code;
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(code: string, message: string, path: string): never {
  throw new Dsl4DiagnosticPolicyError(code, message, path);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
  valuePath: string,
) {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    fail('K4-DIAGNOSTIC-POLICY-SCHEMA', 'symbol properties are not allowed', valuePath);
  }
  const keys = ownKeys as string[];
  const unknown = keys.filter((key) => !allowed.has(key));
  const missing = [...required].filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    fail(
      'K4-DIAGNOSTIC-POLICY-SCHEMA',
      `keys are invalid (unknown: ${unknown.sort().join(', ') || 'none'}; missing: ${missing.sort().join(', ') || 'none'})`,
      valuePath,
    );
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      fail('K4-DIAGNOSTIC-POLICY-SCHEMA', `property ${key} must be a data property`, valuePath);
    }
  }
}

function arrayValues(value: unknown[], valuePath: string) {
  const ownKeys = Reflect.ownKeys(value);
  const unknown = ownKeys.filter((key) => {
    if (key === 'length') return false;
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key)) return true;
    return Number(key) >= value.length;
  });
  if (unknown.length > 0) {
    fail('K4-DIAGNOSTIC-POLICY-SCHEMA', 'array has non-index properties', valuePath);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      fail(
        'K4-DIAGNOSTIC-POLICY-SCHEMA',
        'array must be dense and contain only data properties',
        `${valuePath}[${index}]`,
      );
    }
    result.push(descriptor.value);
  }
  return result;
}

function nonEmptyString(value: unknown, valuePath: string) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail('K4-DIAGNOSTIC-POLICY-SCHEMA', 'must be a non-empty string without NUL', valuePath);
  }
  return value;
}

function safeInteger(
  value: unknown,
  valuePath: string,
  minimum: number,
  code: 'K4-DIAGNOSTIC-POLICY-LIMIT' | 'K4-DIAGNOSTIC-POLICY-SCHEMA' = 'K4-DIAGNOSTIC-POLICY-LIMIT',
) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    fail(code, `must be a safe integer >= ${minimum}`, valuePath);
  }
  return Number(value);
}

function sourcePosition(value: unknown, valuePath: string) {
  if (!isRecord(value)) {
    fail('K4-DIAGNOSTIC-POLICY-SCHEMA', 'must be an object', valuePath);
  }
  exactKeys(value, positionKeys, positionKeys, valuePath);
  return {
    line: safeInteger(value.line, `${valuePath}.line`, 1, 'K4-DIAGNOSTIC-POLICY-SCHEMA'),
    column: safeInteger(value.column, `${valuePath}.column`, 1, 'K4-DIAGNOSTIC-POLICY-SCHEMA'),
    offset: safeInteger(value.offset, `${valuePath}.offset`, 0, 'K4-DIAGNOSTIC-POLICY-SCHEMA'),
  };
}

function sourceRange(value: unknown, valuePath: string) {
  if (!isRecord(value)) {
    fail('K4-DIAGNOSTIC-POLICY-SCHEMA', 'must be an object', valuePath);
  }
  exactKeys(value, rangeKeys, rangeKeys, valuePath);
  const start = sourcePosition(value.start, `${valuePath}.start`);
  const end = sourcePosition(value.end, `${valuePath}.end`);
  const positionReversed =
    end.offset < start.offset ||
    end.line < start.line ||
    (end.line === start.line && end.column < start.column) ||
    (end.offset === start.offset && (end.line !== start.line || end.column !== start.column));
  if (positionReversed) {
    fail(
      'K4-DIAGNOSTIC-POLICY-SCHEMA',
      'end must not precede start in canonical source order',
      valuePath,
    );
  }
  return {start, end};
}

function optionalStoryPath(value: unknown, valuePath: string) {
  return value === undefined ? undefined : nonEmptyString(value, valuePath);
}

function relatedLocation(value: unknown, valuePath: string) {
  if (!isRecord(value)) {
    fail('K4-DIAGNOSTIC-POLICY-SCHEMA', 'must be an object', valuePath);
  }
  exactKeys(value, locationKeys, requiredLocationKeys, valuePath);
  const storyPath = optionalStoryPath(
    Object.hasOwn(value, 'storyPath') ? value.storyPath : undefined,
    `${valuePath}.storyPath`,
  );
  return {
    message: nonEmptyString(value.message, `${valuePath}.message`),
    sourceId: nonEmptyString(value.sourceId, `${valuePath}.sourceId`),
    range: sourceRange(value.range, `${valuePath}.range`),
    ...(storyPath === undefined ? {} : {storyPath}),
    path: nonEmptyString(value.path, `${valuePath}.path`),
  };
}

function diagnostic(value: unknown, valuePath: string, maxRelatedLocations: number) {
  if (!isRecord(value)) {
    fail('K4-DIAGNOSTIC-POLICY-SCHEMA', 'must be an object', valuePath);
  }
  exactKeys(value, diagnosticKeys, requiredDiagnosticKeys, valuePath);
  if (value.version !== 1) {
    fail('K4-DIAGNOSTIC-POLICY-SCHEMA', 'version must be 1', `${valuePath}.version`);
  }
  const code = nonEmptyString(value.code, `${valuePath}.code`);
  if (!diagnosticCodePattern.test(code)) {
    fail(
      'K4-DIAGNOSTIC-POLICY-SCHEMA',
      'code must be a canonical K4 diagnostic code',
      `${valuePath}.code`,
    );
  }
  if (value.severity !== 'error' && value.severity !== 'warning') {
    fail(
      'K4-DIAGNOSTIC-POLICY-SCHEMA',
      'severity must be error or warning',
      `${valuePath}.severity`,
    );
  }
  if (!Array.isArray(value.related)) {
    fail('K4-DIAGNOSTIC-POLICY-SCHEMA', 'must be an array', `${valuePath}.related`);
  }
  if (value.related.length > maxRelatedLocations) {
    fail(
      'K4-DIAGNOSTIC-POLICY-LIMIT',
      `exceeds the explicit limit of ${maxRelatedLocations}`,
      `${valuePath}.related`,
    );
  }
  const related = arrayValues(value.related, `${valuePath}.related`);
  const storyPath = optionalStoryPath(
    Object.hasOwn(value, 'storyPath') ? value.storyPath : undefined,
    `${valuePath}.storyPath`,
  );
  return {
    version: 1 as const,
    code,
    severity: value.severity as 'error' | 'warning',
    message: nonEmptyString(value.message, `${valuePath}.message`),
    sourceId: nonEmptyString(value.sourceId, `${valuePath}.sourceId`),
    range: sourceRange(value.range, `${valuePath}.range`),
    ...(storyPath === undefined ? {} : {storyPath}),
    path: nonEmptyString(value.path, `${valuePath}.path`),
    related: related.map((item, index) => relatedLocation(item, `${valuePath}.related[${index}]`)),
  };
}

function compareCodeUnits(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDiagnostics(
  left: Readonly<Record<string, any>>,
  right: Readonly<Record<string, any>>,
) {
  return (
    left.range.start.offset - right.range.start.offset ||
    compareCodeUnits(left.code, right.code) ||
    compareCodeUnits(left.message, right.message)
  );
}

function diagnosticLocation(item: Readonly<Record<string, any>>) {
  return {
    code: item.code,
    sourceId: item.sourceId,
    range: item.range,
    ...(item.storyPath === undefined ? {} : {storyPath: item.storyPath}),
    path: item.path,
  };
}

/**
 * Validate, deterministically order, and explicitly bound one canonical diagnostic sequence.
 *
 * No default limits are provided. The caller must select finite limits before accepting source.
 * This pure policy is not connected to the source frontend, runtime, preview, or production paths.
 */
export function normalizeDsl4DiagnosticSequence(input: unknown, policy: unknown) {
  if (!Array.isArray(input)) {
    fail('K4-DIAGNOSTIC-POLICY-SCHEMA', 'must be an array', 'diagnostics');
  }
  if (!isRecord(policy)) {
    fail('K4-DIAGNOSTIC-POLICY-LIMIT', 'must be an object', 'policy');
  }
  exactKeys(policy, policyKeys, policyKeys, 'policy');
  const maxDiagnostics = safeInteger(policy.maxDiagnostics, 'policy.maxDiagnostics', 1);
  const maxRelatedLocations = safeInteger(
    policy.maxRelatedLocations,
    'policy.maxRelatedLocations',
    0,
  );
  const values = arrayValues(input, 'diagnostics');
  const sorted = values
    .map((item, index) => diagnostic(item, `diagnostics[${index}]`, maxRelatedLocations))
    .sort(compareDiagnostics);
  const errorCount = sorted.filter((item) => item.severity === 'error').length;
  const warningCount = sorted.length - errorCount;
  let diagnostics = sorted;
  let truncation = null;

  const firstOmittedIndex = maxDiagnostics - 1;
  const omitted = sorted.slice(firstOmittedIndex);
  const [firstOmitted] = omitted;
  // The slice starts inside the sequence whenever it is longer than the limit.
  if (sorted.length > maxDiagnostics && firstOmitted) {
    const omittedErrors = omitted.filter((item) => item.severity === 'error').length;
    const omittedWarnings = omitted.length - omittedErrors;
    const severity = (omittedErrors > 0 ? 'error' : 'warning') as 'error' | 'warning';
    const sentinel = {
      version: 1 as const,
      code: dsl4DiagnosticTruncationCode,
      severity,
      message: `${omitted.length} diagnostics were omitted after the explicit limit`,
      sourceId: firstOmitted.sourceId,
      range: firstOmitted.range,
      ...(firstOmitted.storyPath === undefined ? {} : {storyPath: firstOmitted.storyPath}),
      path: firstOmitted.path,
      related: [],
    };
    diagnostics = [...sorted.slice(0, firstOmittedIndex), sentinel];
    truncation = {
      omittedDiagnostics: omitted.length,
      omittedErrors,
      omittedWarnings,
      firstOmitted: diagnosticLocation(firstOmitted),
    };
  }

  return deepFreeze({
    version: 1,
    canStage: errorCount === 0,
    counts: {
      total: sorted.length,
      errors: errorCount,
      warnings: warningCount,
      retained: diagnostics.length,
    },
    truncation,
    diagnostics,
  });
}
