/**
 * Readers for values the type system cannot prove are present.
 *
 * `noUncheckedIndexedAccess` makes every array index and record lookup possibly undefined, which is
 * correct -- the fakes really can hand back nothing. A test that reads one is asserting it exists,
 * so these say that out loud and fail with the name of what was missing, rather than asserting it
 * away with `!` and failing later on a `TypeError` that names nothing.
 */

/** Take a value the case requires the code under test to have produced. */
export function requireDefined<T>(value: T | undefined | null, description: string): T {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${description} to be present, got ${String(value)}`);
  }
  return value;
}

/** Take a member the case expects to be a string, so `assert.match` keeps refusing anything else. */
export function requireString(value: unknown, description: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`Expected ${description} to be a string, got ${typeof value}`);
  }
  return value;
}
