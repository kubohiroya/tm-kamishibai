import assert from 'node:assert/strict';

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

export function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function waitUntil(
  predicate,
  {attempts = 100, message = 'condition was not reached'} = {},
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await flushMicrotasks();
  }
  assert.fail(message);
}
