import assert from 'node:assert/strict';

import {requireArray, requireRecord} from './require-value.ts';

/**
 * Readers for the `{ok, ...}` results this repository's validators return.
 *
 * The two branches are not a discriminated union -- the refusal branch carries `ok` as a plain
 * boolean -- so narrowing on `ok` does not reach the members a success carries. These readers assert
 * the outcome the case expects, which is the assertion the case used to make on its own line, and
 * hand the record back. The members stay `unknown`: `assert.equal` and `assert.deepEqual` take them
 * as they are, and `require-value.ts` says what a case expects when it reads deeper.
 */

/** Read one result the case expects to have succeeded, reporting the diagnostics when it did not. */
export function okResult(result: unknown, description: string): Record<string, unknown> {
  const record = requireRecord(result, description);
  assert.equal(record.ok, true, `${description} failed: ${JSON.stringify(record.diagnostics)}`);
  return record;
}

/** Read one result the case expects to have been refused. */
export function refusedResult(result: unknown, description: string): Record<string, unknown> {
  const record = requireRecord(result, description);
  assert.equal(record.ok, false, `${description} was expected to be refused`);
  return record;
}

/** Read the diagnostic a refusal is about. */
export function firstDiagnostic(result: unknown, description: string): Record<string, unknown> {
  const diagnostics = requireArray(
    refusedResult(result, description).diagnostics,
    `${description} diagnostics`,
  );
  return requireRecord(diagnostics[0], `the first ${description} diagnostic`);
}
