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
