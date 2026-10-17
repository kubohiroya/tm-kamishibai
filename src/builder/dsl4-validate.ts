import {readFile, stat} from 'node:fs/promises';

import {canonicalizeDsl4Source} from '../dsl4/source-canonicalizer.js';
import {formatDsl4DiagnosticClipboard} from '../dsl4/diagnostic-projection.js';
import {deepFreeze} from '../dsl4/story-document.js';
import type {Dsl4SourceFrontend} from '../dsl4/source-frontend.js';

const textDecoder = new TextDecoder('utf-8', {fatal: true});
const textEncoder = new TextEncoder();

export class Dsl4ValidationInternalError extends Error {
  code: string;
  exitCode: number;

  constructor(message: string, options: {cause?: unknown} = {}) {
    super(message, {cause: options.cause});
    this.name = 'Dsl4ValidationInternalError';
    this.code = 'K4-VALIDATE-INTERNAL-001';
    this.exitCode = 2;
  }
}

function sourceDiagnostic(code: string, message: string, sourceId: string) {
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

function sourceFailure(sourceId: string, diagnostic: ReturnType<typeof sourceDiagnostic>) {
  return deepFreeze({
    version: 1,
    ok: false,
    sourceId,
    byteLength: null,
    diagnostics: [diagnostic],
  });
}

/** Validate one disk source through the production DSL 4.0 frontend. */
export async function validateDsl4SourceFile({
  input,
  sourceFrontend,
  maxSourceBytes,
  sourceId = 'main',
}: {
  input: string | URL;
  sourceFrontend: Dsl4SourceFrontend;
  maxSourceBytes: number;
  sourceId?: string;
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

export function formatDsl4Diagnostic(diagnostic: Record<string, unknown>, displaySource: string) {
  return formatDsl4DiagnosticClipboard({...diagnostic, displayName: displaySource});
}

/** One `{line, column, offset}` position, as the source map and every node range carry it. */
function isSourcePosition(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 3 && keys[0] === 'column' && keys[1] === 'line' && keys[2] === 'offset';
}

/**
 * One `{start, end}` range and nothing else. The shape is checked rather than the key name
 * alone, so a story that names an asset `sourceRange` keeps it.
 */
function isSourceRange(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length === 2 &&
    entries.every(([key, nested]) => (key === 'start' || key === 'end') && isSourcePosition(nested))
  );
}

/** The top-level `sourceMap`: every value is a range keyed by document path. */
function isSourceMap(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const values = Object.values(value);
  return values.length > 0 && values.every((nested) => isSourceRange(nested));
}

/**
 * Sort every mapping key at every depth and drop where the source sat. Array order is kept: an
 * action sequence and a scene order carry meaning in DSL 4.0, while mapping order does not.
 *
 * Positions are dropped because they are the one part of the document that moves with the text
 * rather than the meaning: a comment or a different key order shifts every line and offset, and
 * YAML exported from TurboWarp blocks is laid out differently from YAML written by hand.
 */
function canonicalizeForComparison(value: unknown, depth = 0): unknown {
  if (Array.isArray(value))
    return value.map((entry) => canonicalizeForComparison(entry, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(
          ([key, nested]) =>
            !(key === 'sourceRange' && isSourceRange(nested)) &&
            !(depth === 0 && key === 'sourceMap' && isSourceMap(nested)),
        )
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalizeForComparison(nested, depth + 1)]),
    );
  }
  return value;
}

/**
 * Serialize the canonical story document so that two source frontends which reach the same
 * meaning produce the same bytes. That is what makes it usable as the comparison form for a
 * round-trip check: YAML authored by hand and YAML exported from TurboWarp blocks differ in
 * comments, key order, and therefore in every source position, and none of that is semantic.
 *
 * The diagnostics envelope from `serializeDsl4ValidationResult` deliberately carries neither the
 * canonical source nor the document, so this output is a separate, explicit request.
 */
export function serializeDsl4CanonicalDocument(result: {ok: boolean; storyDocument?: unknown}) {
  const {storyDocument} = result;
  if (!result.ok || !storyDocument) {
    throw new TypeError('the canonical document is available only for a valid source');
  }
  return `${JSON.stringify({
    formatVersion: 1,
    storyDocument: canonicalizeForComparison(storyDocument),
  })}\n`;
}

export function serializeDsl4ValidationResult(
  result: Awaited<ReturnType<typeof validateDsl4SourceFile>>,
) {
  return `${JSON.stringify({
    version: 1,
    ok: result.ok,
    sourceId: result.sourceId,
    byteLength: result.byteLength,
    diagnostics: result.diagnostics,
  })}\n`;
}
