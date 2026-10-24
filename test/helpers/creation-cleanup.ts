import assert from 'node:assert/strict';

export interface CreationCleanup {
  readonly completion: Promise<void> | null;
  dispose(reason?: string): Promise<void>;
  hasPendingCleanup(): boolean;
}

export function creationCleanup(error: unknown): CreationCleanup {
  assert(error instanceof Error);
  const cleanup = (error as Error & {cleanup?: CreationCleanup}).cleanup;
  assert(cleanup, 'creation failure must retain a cleanup handle');
  assert.equal(typeof cleanup.dispose, 'function');
  return cleanup;
}
