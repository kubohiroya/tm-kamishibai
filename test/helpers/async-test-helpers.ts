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

/**
 * Fail with a name instead of with the suite's timeout.
 *
 * The waits in this file that already carry a deadline say what they were waiting for when they
 * give up. The ones that did not -- the DevTools socket opening, every CDP response, the preview
 * command exiting -- left the suite to notice sixty seconds later, with nothing to say about
 * where it stopped. A test that normally finishes in three seconds and then reports only
 * "timed out in 60000ms" costs a re-run to learn anything at all, which is how
 * #859 was found.
 */
export function withDeadline<T>(work: Promise<T>, label: string, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`)),
        timeoutMs,
      );
      // Never hold the process open for a deadline that is only there to explain a hang.
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}
