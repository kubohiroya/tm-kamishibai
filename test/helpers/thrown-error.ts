/**
 * The members this repository's thrown errors carry beyond `Error`'s own.
 *
 * `assert.throws` and `assert.rejects` hand their validator an `unknown`, and `catch` binds one, so
 * every suite that checks a diagnostic code would otherwise repeat the same narrowing at each site.
 * Declaring it once is the move that cleared two thirds of the `src/` burndown.
 */
export interface ThrownError {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
  /** `Sb3BuilderError` names the build stage it failed in. */
  readonly stage?: unknown;
  readonly cause?: unknown;
  /** Read when a case reports what actually failed. */
  readonly stack?: unknown;
  /** Source diagnostics name the source they were raised in, and the ones they relate to. */
  readonly sourceId?: unknown;
  readonly related?: unknown;
  /** A preview runtime failure carries the diagnostic code it wrapped. */
  readonly diagnosticCode?: unknown;
  /** An include cycle names the sources it ran through. */
  readonly cycle?: unknown;
  /** `AggregateError` carries the failures it gathered. */
  readonly errors?: unknown;
  /** Asset diagnostics name the file and the story path they were raised for. */
  readonly displayName?: unknown;
  readonly path?: unknown;
  readonly diagnostics?: unknown;
}

/**
 * Read a thrown value as the error shape this repository throws.
 *
 * A non-object reaching here is a real failure -- the code under test threw a bare string or a
 * number -- so it is reported rather than narrowed away.
 */
export function thrown(error: unknown): ThrownError {
  if (typeof error !== 'object' || error === null) {
    throw new TypeError(`Expected an object to be thrown, got ${typeof error}`);
  }
  return error as ThrownError;
}
