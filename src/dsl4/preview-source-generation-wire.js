import {normalizeDsl4DiagnosticSequence} from './diagnostic-sequence-policy.js';
import {deepFreeze} from './story-document.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', {fatal: true});
const hardMaximumMessageBytes = 16 * 1024 * 1024;
const integrityPattern = /^sha256-[A-Za-z0-9+/]{43}=$/u;
const wireKeys = new Set(['formatVersion', 'type', 'revision', 'result']);
const resultKeys = new Set(['ok', 'sourceSnapshot', 'diagnostics', 'storyDocument']);
const snapshotKeys = new Set(['sourceId', 'byteLength', 'integrity']);

export const dsl4PreviewSourceGenerationWireDefaults = deepFreeze({
  maxMessageBytes: 4 * 1024 * 1024,
  maxDiagnostics: 100,
});

export class Dsl4PreviewSourceGenerationWireError extends TypeError {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message, {cause});
    this.name = 'Dsl4PreviewSourceGenerationWireError';
    this.code = code;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} code @param {string} message @param {unknown} [cause] @returns {never} */
function fail(code, message, cause) {
  throw new Dsl4PreviewSourceGenerationWireError(code, message, cause);
}

/** @param {unknown} value @param {string} name @param {number} minimum */
function safeInteger(value, name, minimum) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    fail('K4-PREVIEW-GENERATION-SCHEMA', `${name} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} name @param {number} maximum */
function boundedString(value, name, maximum) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(
      'K4-PREVIEW-GENERATION-SCHEMA',
      `${name} must be a bounded non-empty string without control characters`,
    );
  }
  return value;
}

/** @param {Record<string, unknown>} value @param {ReadonlySet<string>} keys @param {string} name */
function exactKeys(value, keys, name) {
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.has(key));
  const missing = [...keys].filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    fail(
      'K4-PREVIEW-GENERATION-SCHEMA',
      `${name} keys are invalid (unknown: ${unknown.sort().join(', ') || 'none'}; missing: ${missing.sort().join(', ') || 'none'})`,
    );
  }
}

/** @param {unknown} input */
function limits(input) {
  if (!isRecord(input)) {
    fail('K4-PREVIEW-GENERATION-LIMIT', 'preview generation limits must be an object');
  }
  const unknown = Object.keys(input).filter(
    (key) => !Object.hasOwn(dsl4PreviewSourceGenerationWireDefaults, key),
  );
  if (unknown.length > 0) {
    fail(
      'K4-PREVIEW-GENERATION-LIMIT',
      `Unknown preview generation limits: ${unknown.sort().join(', ')}`,
    );
  }
  const maxMessageBytes = safeInteger(
    input.maxMessageBytes ?? dsl4PreviewSourceGenerationWireDefaults.maxMessageBytes,
    'maxMessageBytes',
    1,
  );
  if (maxMessageBytes > hardMaximumMessageBytes) {
    fail('K4-PREVIEW-GENERATION-LIMIT', `maxMessageBytes must be <= ${hardMaximumMessageBytes}`);
  }
  const maxDiagnostics = safeInteger(
    input.maxDiagnostics ?? dsl4PreviewSourceGenerationWireDefaults.maxDiagnostics,
    'maxDiagnostics',
    0,
  );
  if (maxDiagnostics > dsl4PreviewSourceGenerationWireDefaults.maxDiagnostics) {
    fail(
      'K4-PREVIEW-GENERATION-LIMIT',
      `maxDiagnostics must be <= ${dsl4PreviewSourceGenerationWireDefaults.maxDiagnostics}`,
    );
  }
  return {maxMessageBytes, maxDiagnostics};
}

/** @param {unknown} value @param {string} name */
function jsonClone(value, name) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    fail('K4-PREVIEW-GENERATION-SCHEMA', `${name} must be JSON serializable`, error);
  }
  if (encoded === undefined) {
    fail('K4-PREVIEW-GENERATION-SCHEMA', `${name} must be JSON serializable`);
  }
  return JSON.parse(encoded);
}

/** @param {unknown} value */
function sourceSnapshot(value) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    fail('K4-PREVIEW-GENERATION-SCHEMA', 'sourceSnapshot must be an object or null');
  }
  const snapshot = /** @type {Record<string, unknown>} */ (value);
  const sourceId = boundedString(snapshot.sourceId, 'sourceSnapshot.sourceId', 256);
  const byteLength = safeInteger(snapshot.byteLength, 'sourceSnapshot.byteLength', 0);
  if (typeof snapshot.integrity !== 'string' || !integrityPattern.test(snapshot.integrity)) {
    fail('K4-PREVIEW-GENERATION-SCHEMA', 'sourceSnapshot.integrity must be canonical SHA-256 SRI');
  }
  return {sourceId, byteLength, integrity: snapshot.integrity};
}

/** @param {unknown} value */
function storyDocument(value) {
  if (!isRecord(value) || value.kind !== 'StoryDocument' || value.version !== '4.0') {
    fail(
      'K4-PREVIEW-GENERATION-SCHEMA',
      'valid preview generation must provide a DSL 4.0 StoryDocument',
    );
  }
  return jsonClone(value, 'storyDocument');
}

/** @param {unknown} value @param {number} maximum */
function diagnostics(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail(
      'K4-PREVIEW-GENERATION-SCHEMA',
      `diagnostics must be an array with at most ${maximum} entries`,
    );
  }
  let normalized;
  try {
    normalized = normalizeDsl4DiagnosticSequence(value, {
      maxDiagnostics: Math.max(1, maximum),
      maxRelatedLocations: 8,
    }).diagnostics;
  } catch (error) {
    fail(
      'K4-PREVIEW-GENERATION-SCHEMA',
      'diagnostics must use the canonical DSL 4 envelope',
      error,
    );
  }
  return normalized.map((diagnostic, index) => {
    boundedString(diagnostic.message, `diagnostics[${index}].message`, 1_000);
    boundedString(diagnostic.sourceId, `diagnostics[${index}].sourceId`, 256);
    for (const [relatedIndex, related] of diagnostic.related.entries()) {
      boundedString(
        related.message,
        `diagnostics[${index}].related[${relatedIndex}].message`,
        1_000,
      );
      boundedString(
        related.sourceId,
        `diagnostics[${index}].related[${relatedIndex}].sourceId`,
        256,
      );
    }
    return structuredClone(diagnostic);
  });
}

/**
 * Build the only source-generation payload accepted by the local browser runtime bridge.
 * Canonical YAML text and machine-local paths are intentionally omitted.
 *
 * @param {object} input
 * @param {number} input.revision
 * @param {unknown} input.result
 * @param {number} [input.maxMessageBytes]
 * @param {number} [input.maxDiagnostics]
 */
export function createDsl4PreviewSourceGenerationWire(input) {
  if (!isRecord(input)) {
    fail('K4-PREVIEW-GENERATION-SCHEMA', 'preview generation input must be an object');
  }
  const resolvedLimits = limits({
    maxMessageBytes: input.maxMessageBytes,
    maxDiagnostics: input.maxDiagnostics,
  });
  const revision = safeInteger(input.revision, 'revision', 1);
  if (!isRecord(input.result) || typeof input.result.ok !== 'boolean') {
    fail('K4-PREVIEW-GENERATION-SCHEMA', 'result must be a source frontend result');
  }
  const parsedDiagnostics = diagnostics(input.result.diagnostics, resolvedLimits.maxDiagnostics);
  const snapshot = sourceSnapshot(input.result.sourceSnapshot);
  const valid = input.result.ok;
  if (valid && snapshot === null) {
    fail('K4-PREVIEW-GENERATION-SCHEMA', 'valid preview generation must provide a source snapshot');
  }
  const generation = {
    formatVersion: 1,
    type: 'preview.source.generation',
    revision,
    result: {
      ok: valid,
      sourceSnapshot: snapshot,
      diagnostics: parsedDiagnostics,
      storyDocument: valid ? storyDocument(input.result.storyDocument) : null,
    },
  };
  const bytes = textEncoder.encode(JSON.stringify(generation));
  if (bytes.byteLength > resolvedLimits.maxMessageBytes) {
    fail(
      'K4-PREVIEW-GENERATION-LIMIT',
      `preview generation exceeds the ${resolvedLimits.maxMessageBytes}-byte message limit`,
    );
  }
  return deepFreeze(generation);
}

/**
 * Encode one validated generation as bounded UTF-8 JSON.
 *
 * @param {Parameters<typeof createDsl4PreviewSourceGenerationWire>[0]} input
 */
export function encodeDsl4PreviewSourceGenerationWire(input) {
  const generation = createDsl4PreviewSourceGenerationWire(input);
  return textEncoder.encode(JSON.stringify(generation));
}

/**
 * Decode and revalidate one authenticated generation before handing it to the browser runtime.
 *
 * @param {unknown} input
 * @param {{maxMessageBytes?: number, maxDiagnostics?: number}} [options]
 */
export function decodeDsl4PreviewSourceGenerationWire(input, options = {}) {
  const resolvedLimits = limits(options);
  if (!(input instanceof Uint8Array)) {
    fail('K4-PREVIEW-GENERATION-SCHEMA', 'preview generation bytes must be a Uint8Array');
  }
  if (input.byteLength === 0 || input.byteLength > resolvedLimits.maxMessageBytes) {
    fail(
      'K4-PREVIEW-GENERATION-LIMIT',
      `preview generation must contain 1-${resolvedLimits.maxMessageBytes} bytes`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(textDecoder.decode(input));
  } catch (error) {
    fail('K4-PREVIEW-GENERATION-JSON', 'preview generation must be valid UTF-8 JSON', error);
  }
  if (!isRecord(parsed)) {
    fail('K4-PREVIEW-GENERATION-SCHEMA', 'preview generation must be an object');
  }
  exactKeys(parsed, wireKeys, 'preview generation');
  if (parsed.formatVersion !== 1 || parsed.type !== 'preview.source.generation') {
    fail('K4-PREVIEW-GENERATION-SCHEMA', 'preview generation version or type is unsupported');
  }
  if (!isRecord(parsed.result)) {
    fail('K4-PREVIEW-GENERATION-SCHEMA', 'preview generation result must be an object');
  }
  exactKeys(parsed.result, resultKeys, 'preview generation result');
  if (parsed.result.sourceSnapshot !== null) {
    if (!isRecord(parsed.result.sourceSnapshot)) {
      fail('K4-PREVIEW-GENERATION-SCHEMA', 'sourceSnapshot must be an object or null');
    }
    exactKeys(parsed.result.sourceSnapshot, snapshotKeys, 'preview source snapshot');
  }
  return createDsl4PreviewSourceGenerationWire({
    revision: safeInteger(parsed.revision, 'revision', 1),
    result: parsed.result,
    ...resolvedLimits,
  });
}
