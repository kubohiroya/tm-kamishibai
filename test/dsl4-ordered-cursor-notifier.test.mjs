import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4OrderedCursorNotifier} from '../src/dsl4/platform/ordered-cursor-notifier.js';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {promise, resolve};
}

test('preserves synchronous cursor delivery and serializes asynchronous updates', async () => {
  const calls = [];
  const releaseFirst = deferred();
  const completed = deferred();
  const notify = createDsl4OrderedCursorNotifier(async (event) => {
    if (event.source === 'first') await releaseFirst.promise;
    calls.push(event.source);
    if (calls.length === 2) completed.resolve();
  });

  notify({visible: true, source: 'first', cursor: 'pointer'});
  notify({visible: false, source: 'second', cursor: 'pointer'});
  assert.deepEqual(calls, []);
  releaseFirst.resolve();
  await completed.promise;
  assert.deepEqual(calls, ['first', 'second']);

  const synchronous = [];
  const notifySynchronously = createDsl4OrderedCursorNotifier((event) => {
    synchronous.push(event.source);
  });
  notifySynchronously({visible: true, source: 'sync', cursor: 'pointer'});
  assert.deepEqual(synchronous, ['sync']);
});

test('contains observer failures and continues with the newest cursor state', async () => {
  const calls = [];
  const completed = deferred();
  const notify = createDsl4OrderedCursorNotifier((event) => {
    calls.push(event.source);
    if (event.source === 'throw') throw new Error('synchronous cursor failure');
    if (event.source === 'reject') return Promise.reject(new Error('async cursor failure'));
    completed.resolve();
    return undefined;
  });

  notify({visible: true, source: 'throw', cursor: 'pointer'});
  notify({visible: true, source: 'reject', cursor: 'pointer'});
  notify({visible: false, source: 'final', cursor: 'pointer'});
  await completed.promise;
  assert.deepEqual(calls, ['throw', 'reject', 'final']);
});
