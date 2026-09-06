import assert from 'node:assert/strict';

/**
 * A promise with its settle functions handed back.
 *
 * The executor runs synchronously, so both are assigned before the constructor returns -- but the
 * compiler cannot see that through the callback, which is what the non-null assertions record.
 */
export function deferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void;
  let reject: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve: resolve!, reject: reject!};
}

export function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function waitUntil(
  predicate: () => unknown,
  {
    attempts = 100,
    message = 'condition was not reached',
  }: {attempts?: number; message?: string} = {},
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await flushMicrotasks();
  }
  assert.fail(message);
}
