import {readFile, stat} from 'node:fs/promises';

import {canonicalizeDsl4Source} from '../dsl4/source-canonicalizer.js';
import {deepFreeze} from '../dsl4/story-document.js';

const textDecoder = new TextDecoder('utf-8', {fatal: true});
const textEncoder = new TextEncoder();

export class Dsl4ValidationInternalError extends Error {
  /** @param {string} message @param {{cause?: unknown}} [options] */
  constructor(message, options = {}) {
    super(message, {cause: options.cause});
    this.name = 'Dsl4ValidationInternalError';
    this.code = 'K4-VALIDATE-INTERNAL-001';
    this.exitCode = 2;
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {string} sourceId
 */
function sourceDiagnostic(code, message, sourceId) {
  return deepFreeze({
    version: 1,
    code,
    severity: 'error',
    message,
    sourceId,
    range: {
      start: {line: 1, column: 1, offset: 0},
      end: {line: 1, column: 1, offset: 0},
    },
    path: '$',
    related: [],
  });
}

/**
 * @param {string} sourceId
 * @param {ReturnType<typeof sourceDiagnostic>} diagnostic
 */
function sourceFailure(sourceId, diagnostic) {
  return deepFreeze({
    version: 1,
    ok: false,
    sourceId,
    byteLength: null,
    diagnostics: [diagnostic],
  });
}

/**
 * Validate one disk source through the production DSL 4.0 frontend.
 *
 * @param {object} options
 * @param {string | URL} options.input
 * @param {{parse(source: string, options?: {sourceId?: string}): any}} options.sourceFrontend
 * @param {number} options.maxSourceBytes
 * @param {string} [options.sourceId]
 */
export async function validateDsl4SourceFile({
  input,
  sourceFrontend,
  maxSourceBytes,
  sourceId = 'main',
}) {
  if (!(typeof input === 'string' || input instanceof URL)) {
    throw new TypeError('input must be a filesystem path or file URL');
  }
  if (!sourceFrontend || typeof sourceFrontend.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse');
  }
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1) {
    throw new TypeError('maxSourceBytes must be a positive safe integer');
  }
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    throw new TypeError('sourceId must be a non-empty string');
  }

  const maxRawBytes =
    maxSourceBytes > (Number.MAX_SAFE_INTEGER - 3) / 2
      ? Number.MAX_SAFE_INTEGER
      : maxSourceBytes * 2 + 3;
  let sourceState;
  try {
    sourceState = await stat(input);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return sourceFailure(
        sourceId,
        sourceDiagnostic('K4-SOURCE-MISSING', 'DSL 4.0 source is missing', sourceId),
      );
    }
    throw new Dsl4ValidationInternalError('Could not read the DSL 4.0 source', {cause: error});
  }
  if (!sourceState.isFile()) {
    throw new Dsl4ValidationInternalError('DSL 4.0 source is not a regular file');
  }

  // Canonicalization can remove at most one BOM and one byte per CRLF pair.
  if (sourceState.size > maxRawBytes) {
    return sourceFailure(
      sourceId,
      sourceDiagnostic(
        'K4-SOURCE-TOO-LARGE',
        `Canonical DSL 4.0 source exceeds ${maxSourceBytes} bytes`,
        sourceId,
      ),
    );
  }

  let bytes;
  try {
    bytes = await readFile(input);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return sourceFailure(
        sourceId,
        sourceDiagnostic('K4-SOURCE-MISSING', 'DSL 4.0 source is missing', sourceId),
      );
    }
    throw new Dsl4ValidationInternalError('Could not read the DSL 4.0 source', {cause: error});
  }
  if (bytes.byteLength > maxRawBytes) {
    return sourceFailure(
      sourceId,
      sourceDiagnostic(
        'K4-SOURCE-TOO-LARGE',
        `Canonical DSL 4.0 source exceeds ${maxSourceBytes} bytes`,
        sourceId,
      ),
    );
  }

  let decoded;
  try {
    decoded = textDecoder.decode(bytes);
  } catch {
    return sourceFailure(
      sourceId,
      sourceDiagnostic('K4-SOURCE-UTF8-001', 'DSL 4.0 source is not valid UTF-8', sourceId),
    );
  }
  const canonicalSource = canonicalizeDsl4Source(decoded);
  const byteLength = textEncoder.encode(canonicalSource).byteLength;
  if (byteLength > maxSourceBytes) {
    return sourceFailure(
      sourceId,
      sourceDiagnostic(
        'K4-SOURCE-TOO-LARGE',
        `Canonical DSL 4.0 source exceeds ${maxSourceBytes} bytes`,
        sourceId,
      ),
    );
  }

  let parsed;
  try {
    parsed = sourceFrontend.parse(canonicalSource, {sourceId});
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.ok !== 'boolean' ||
      !Array.isArray(parsed.diagnostics) ||
      (parsed.ok && (!parsed.storyDocument || typeof parsed.storyDocument !== 'object'))
    ) {
      throw new TypeError('source frontend returned an invalid result');
    }
  } catch (error) {
    throw new Dsl4ValidationInternalError('DSL 4.0 source validation failed internally', {
      cause: error,
    });
  }
  return deepFreeze({
    version: 1,
    ok: parsed.ok,
    sourceId,
    byteLength,
    canonicalSource,
    diagnostics: parsed.diagnostics,
    ...(parsed.ok ? {storyDocument: parsed.storyDocument} : {}),
  });
}

/** @param {Record<string, any>} diagnostic @param {string} displaySource */
export function formatDsl4Diagnostic(diagnostic, displaySource) {
  const line = Number(diagnostic.range?.start?.line ?? 1);
  const column = Number(diagnostic.range?.start?.column ?? 1);
  return `${displaySource}:${line}:${column}: ${diagnostic.severity} [${diagnostic.code}] ${diagnostic.message}`;
}

/** @param {Awaited<ReturnType<typeof validateDsl4SourceFile>>} result */
export function serializeDsl4ValidationResult(result) {
  return `${JSON.stringify({
    version: 1,
    ok: result.ok,
    sourceId: result.sourceId,
    byteLength: result.byteLength,
    diagnostics: result.diagnostics,
  })}\n`;
}
