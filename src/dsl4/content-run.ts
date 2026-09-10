/**
 * Typed content runs for DSL 4.0 body text.
 *
 * The author writes either one plain string or an ordered list whose items are plain strings and
 * `{ruby: {base, reading}}` records. The frontend normalizes both forms into the same typed run
 * list so every consumer — renderer, backlog, read-aloud, accessibility — reads one shape.
 *
 * The run shape matches `SvgTextContentRun` from `@kubohiroya/turbowarp-svg-text`, so the runtime
 * hands the list to `setRichText` without a second translation.
 */

export interface Dsl4TextContentRun {
  readonly type: 'text';
  readonly text: string;
}

export interface Dsl4RubyContentRun {
  readonly type: 'ruby';
  readonly base: string;
  readonly reading: string;
}

export type Dsl4ContentRun = Dsl4RubyContentRun | Dsl4TextContentRun;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentRunError(message: string) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: 'K4-CONTENT-RUN-001'});
  return error;
}

function textRun(text: string): Dsl4TextContentRun {
  return Object.freeze({type: 'text', text});
}

function rubyRun(value: Readonly<Record<string, unknown>>): Dsl4RubyContentRun {
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'base' || keys[1] !== 'reading') {
    throw contentRunError('A ruby content run must provide exactly base and reading');
  }
  const {base, reading} = value;
  if (typeof base !== 'string' || base.length === 0) {
    throw contentRunError('A ruby content run base must be a non-empty string');
  }
  if (typeof reading !== 'string' || reading.length === 0) {
    throw contentRunError('A ruby content run reading must be a non-empty string');
  }
  return Object.freeze({type: 'ruby', base, reading});
}

/**
 * Normalize authored body text into typed content runs.
 *
 * A plain string becomes one text run. Adjacent authored strings stay separate runs so the source
 * order is preserved exactly; nothing is merged, trimmed, or reordered.
 */
export function normalizeDsl4ContentRuns(value: unknown): readonly Dsl4ContentRun[] {
  if (typeof value === 'string') return Object.freeze([textRun(value)]);
  if (!Array.isArray(value)) {
    throw contentRunError('Body text must be a string or a list of content runs');
  }
  if (value.length === 0) throw contentRunError('A content run list must not be empty');
  return Object.freeze(
    value.map((item) => {
      if (typeof item === 'string') return textRun(item);
      if (!isRecord(item)) {
        throw contentRunError('A content run item must be a string or a ruby record');
      }
      // Normalization is idempotent: an already-typed run list passes through unchanged, so the
      // YAML path and the block path can both hand their text to the same entry point.
      if (item.type === 'text') {
        if (typeof item.text !== 'string') {
          throw contentRunError('A text content run text must be a string');
        }
        return textRun(item.text);
      }
      if (item.type === 'ruby') {
        return rubyRun(Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'type')));
      }
      if (!Object.hasOwn(item, 'ruby') || Object.keys(item).length !== 1) {
        throw contentRunError('A content run item must be a string or a ruby record');
      }
      const ruby = item.ruby;
      if (!isRecord(ruby)) throw contentRunError('A ruby content run must be an object');
      return rubyRun(ruby);
    }),
  );
}

/**
 * Project typed content runs to plain text for backlog, read-aloud, and accessibility.
 *
 * A ruby run contributes only its `base`. The `reading` is a pronunciation aid for sighted readers
 * and is deliberately left out: a screen reader or backlog that replayed both would say the same
 * word twice. A consumer that wants the reading — a read-aloud voice choosing pronunciation, say —
 * reads the runs directly instead of this projection.
 *
 * The projection is deterministic: the same runs always produce the same string.
 */
export function dsl4PlainTextFromContentRuns(runs: readonly Dsl4ContentRun[]): string {
  if (!Array.isArray(runs)) throw contentRunError('Content runs must be an array');
  return runs
    .map((run) => {
      if (!isRecord(run)) throw contentRunError('A content run must be an object');
      if (run.type === 'ruby') return String(run.base);
      if (run.type === 'text') return String(run.text);
      throw contentRunError(`Unknown content run type: ${String(run.type)}`);
    })
    .join('');
}

/** Report whether a normalized run list needs the rich renderer rather than the plain one. */
export function dsl4ContentRunsNeedRichText(runs: readonly Dsl4ContentRun[]) {
  return runs.some((run) => run.type === 'ruby');
}
