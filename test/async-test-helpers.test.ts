import assert from 'node:assert/strict';
import {test} from 'vitest';

import {withDeadline} from './helpers/async-test-helpers.ts';

test('hands back what the work resolved, without waiting for its deadline', async () => {
  assert.equal(await withDeadline(Promise.resolve('done'), 'the work', 50), 'done');
});

test('lets the work fail on its own terms', async () => {
  const failure = new Error('the work itself failed');
  await assert.rejects(
    withDeadline(Promise.reject(failure), 'the work', 50),
    (error: unknown) => error === failure,
  );
});

test('says what it was waiting for when the work never settles', async () => {
  // The point of the helper: a wait that hangs names itself, instead of leaving the suite to
  // report its own timeout with nothing in it.
  await assert.rejects(
    withDeadline(new Promise(() => {}), 'the Chromium response to Runtime.enable', 10),
    /Timed out after 10ms waiting for the Chromium response to Runtime\.enable/u,
  );
});
