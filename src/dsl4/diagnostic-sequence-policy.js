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
  /** @param {string} code @param {string} message @param {string} path */
  constructor(code, message, path) {
    super(`${path}: ${message}`);
    this.name = 'Dsl4DiagnosticPolicyError';
    this.code = code;
    this.path = path;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {string} code @param {string} message @param {string} path @returns {never} */
function fail(code, message, path) {
  throw new Dsl4DiagnosticPolicyError(code, message, path);
}

/**
 * @param {Record<string, unknown>} value
 * @param {ReadonlySet<string>} allowed
 * @param {ReadonlySet<string>} required
 * @param {string} valuePath
 */
function exactKeys(value, allowed, required, valuePath) {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    fail('K4-DIAGNOSTIC-POLICY-SCHEMA', 'symbol properties are not allowed', valuePath);
  }
  const keys = /** @type {string[]} */ (ownKeys);
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

/** @param {unknown[]} value @param {string} valuePath */
function arrayValues(value, valuePath) {
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

/** @param {unknown} value @param {string} valuePath */
function nonEmptyString(value, valuePath) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail('K4-DIAGNOSTIC-POLICY-SCHEMA', 'must be a non-empty string without NUL', valuePath);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} valuePath
 * @param {number} minimum
 * @param {'K4-DIAGNOSTIC-POLICY-LIMIT' | 'K4-DIAGNOSTIC-POLICY-SCHEMA'} [code]
 */
function safeInteger(value, valuePath, minimum, code = 'K4-DIAGNOSTIC-POLICY-LIMIT') {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    fail(code, `must be a safe integer >= ${minimum}`, valuePath);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} valuePath */
function sourcePosition(value, valuePath) {
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

/** @param {unknown} value @param {string} valuePath */
function sourceRange(value, valuePath) {
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

/** @param {unknown} value @param {string} valuePath */
function optionalStoryPath(value, valuePath) {
  return value === undefined ? undefined : nonEmptyString(value, valuePath);
}

/** @param {unknown} value @param {string} valuePath */
function relatedLocation(value, valuePath) {
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

/**
 * @param {unknown} value
 * @param {string} valuePath
 * @param {number} maxRelatedLocations
 */
function diagnostic(value, valuePath, maxRelatedLocations) {
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
    version: /** @type {1} */ (1),
    code,
    severity: /** @type {'error' | 'warning'} */ (value.severity),
    message: nonEmptyString(value.message, `${valuePath}.message`),
    sourceId: nonEmptyString(value.sourceId, `${valuePath}.sourceId`),
    range: sourceRange(value.range, `${valuePath}.range`),
    ...(storyPath === undefined ? {} : {storyPath}),
    path: nonEmptyString(value.path, `${valuePath}.path`),
    related: related.map((item, index) => relatedLocation(item, `${valuePath}.related[${index}]`)),
  };
}

/** @param {string} left @param {string} right */
function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @param {Readonly<Record<string, any>>} left @param {Readonly<Record<string, any>>} right */
function compareDiagnostics(left, right) {
  return (
    left.range.start.offset - right.range.start.offset ||
    compareCodeUnits(left.code, right.code) ||
    compareCodeUnits(left.message, right.message)
  );
}

/** @param {Readonly<Record<string, any>>} item */
function diagnosticLocation(item) {
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
 *
 * @param {unknown} input
 * @param {unknown} policy
 */
export function normalizeDsl4DiagnosticSequence(input, policy) {
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

  if (sorted.length > maxDiagnostics) {
    const firstOmittedIndex = maxDiagnostics - 1;
    const omitted = sorted.slice(firstOmittedIndex);
    const omittedErrors = omitted.filter((item) => item.severity === 'error').length;
    const omittedWarnings = omitted.length - omittedErrors;
    const firstOmitted = omitted[0];
    const severity = /** @type {'error' | 'warning'} */ (omittedErrors > 0 ? 'error' : 'warning');
    const sentinel = {
      version: /** @type {1} */ (1),
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
