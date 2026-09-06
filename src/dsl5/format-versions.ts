import {deepFreeze} from '../dsl4/story-document.js';

/**
 * The exact source version DSL 5.0 accepts.
 *
 * `kamishibai: "5.0"` is its own version, not a successor the 4.0 frontend falls back to. A 4.0
 * document reaching a 5.0 reader is a diagnostic, and a 5.0 document reaching the 4.0 reader is
 * rejected by `schema/dsl-4.schema.json`'s `{"const": "4.0"}` as it already is. Nothing in this
 * module widens either side.
 */
export const dsl5SourceVersion = '5.0';

/**
 * The five formats DSL 5.0 publishes, each versioned on its own.
 *
 * They travel separately -- a save file outlives the artifact it was written against, a publication
 * manifest is fetched before any segment, a sealed artifact is decrypted by a reader that never saw
 * the authoring source -- so a single shared version number would force unrelated formats to move
 * together. DSL 4.0 learned this the other way round: `formatVersion: 1` is written independently at
 * a dozen sites with no list saying which ones exist.
 */
export const dsl5FormatVersions = deepFreeze({
  /** The normalized story document one segment compiles to. */
  storyDocument: 1,
  /** The publication's segment index, read before any segment (#773). */
  publicationManifest: 1,
  /** One saved reading position and its runtime state (#771). */
  saveData: 1,
  /** The production artifact with the authoring source omitted (#781). */
  compiledArtifact: 1,
  /** The authenticated-encryption envelope around segments and asset groups (#781). */
  sealedArtifact: 1,
});

export type Dsl5FormatKind = keyof typeof dsl5FormatVersions;

/** A format that was refused. Carries the code so callers can map it to their own diagnostics. */
export class Dsl5FormatError extends Error {
  readonly code: string;
  readonly kind: Dsl5FormatKind;

  constructor(code: string, kind: Dsl5FormatKind, message: string) {
    super(message);
    this.name = 'Dsl5FormatError';
    this.code = code;
    this.kind = kind;
  }
}

/** What one format's envelope must carry, and what it may carry. */
export interface Dsl5EnvelopeSpec {
  readonly kind: Dsl5FormatKind;
  readonly requiredKeys: readonly string[];
  readonly optionalKeys?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read one format envelope, refusing anything this build does not already understand.
 *
 * Fail closed means all four of these, not just the version check: a non-record, a `formatVersion`
 * this build did not publish, a key the format does not declare, and a declared key that is absent.
 * An unknown key is the one worth spelling out -- accepting it is how a reader silently drops the
 * member a newer writer added, which is exactly the failure `validateStageAck` had in 4.0.
 *
 * Migration is deliberately not here. A save written against an older version is the caller's
 * business (#771); this decoder only says whether the bytes match the format this build declares.
 */
export function decodeDsl5Envelope(
  value: unknown,
  spec: Dsl5EnvelopeSpec,
): Readonly<Record<string, unknown>> {
  const {kind, requiredKeys, optionalKeys = []} = spec;
  if (!isRecord(value)) {
    throw new Dsl5FormatError('K5-FORMAT-SHAPE-001', kind, `${kind} must be an object`);
  }
  const expected = dsl5FormatVersions[kind];
  if (value.formatVersion !== expected) {
    throw new Dsl5FormatError(
      'K5-FORMAT-VERSION-001',
      kind,
      `${kind} formatVersion must be ${expected}, got ${JSON.stringify(value.formatVersion)}`,
    );
  }
  const declared = new Set(['formatVersion', ...requiredKeys, ...optionalKeys]);
  const unknown = Object.keys(value)
    .filter((key) => !declared.has(key))
    .sort();
  if (unknown.length > 0) {
    throw new Dsl5FormatError(
      'K5-FORMAT-UNKNOWN-KEY-001',
      kind,
      `${kind} carries keys this build does not declare: ${unknown.join(', ')}`,
    );
  }
  const missing = requiredKeys.filter((key) => !Object.hasOwn(value, key)).sort();
  if (missing.length > 0) {
    throw new Dsl5FormatError(
      'K5-FORMAT-MISSING-KEY-001',
      kind,
      `${kind} is missing required keys: ${missing.join(', ')}`,
    );
  }
  return value;
}

/**
 * Take a source version a 5.0 reader was handed.
 *
 * The 4.0 string is refused by name rather than by falling through to a generic message, because
 * "this is a 4.0 document, convert it" is what an author reaching this error actually needs (#782).
 */
export function requireDsl5SourceVersion(value: unknown): typeof dsl5SourceVersion {
  if (value === dsl5SourceVersion) return dsl5SourceVersion;
  const found = JSON.stringify(value);
  const hint =
    value === '4.0' ? ' -- convert the document to 5.0 rather than relying on a fallback' : '';
  throw new Dsl5FormatError(
    'K5-VERSION-001',
    'storyDocument',
    `DSL 5.0 requires kamishibai "${dsl5SourceVersion}", got ${found}${hint}`,
  );
}
