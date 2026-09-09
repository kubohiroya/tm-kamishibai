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

/** Take a value the case expects to be a JSON object, so a walk into it stays typed. */
export function requireRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Expected ${description} to be a record, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

/** Take a value the case expects to be an array, so a length or an index read stays honest. */
export function requireArray(value: unknown, description: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Expected ${description} to be an array, got ${typeof value}`);
  }
  return value;
}

/** Take a value the case expects to be a number, so arithmetic on it stays honest. */
export function requireNumber(value: unknown, description: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Expected ${description} to be a finite number, got ${String(value)}`);
  }
  return value;
}
