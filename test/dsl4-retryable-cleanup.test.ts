import assert from 'node:assert/strict';
import {test} from 'vitest';
import {createDsl4RetryableCleanup} from '../src/dsl4/retryable-cleanup.js';

for (const parallel of [false, true]) {
  test(`cleanup aggregates inspection and release failures and retries only unfinished work (parallel: ${parallel})`, async () => {
    const inspectionError = new Error('inspection unavailable');
    const releaseError = new Error('resource still owned');
    let inspectFails = true;
    let resourceOwned = true;
    let closed = false;
    let nested: Promise<void> | undefined;
    const calls = [0, 0, 0];
    const cleanup = createDsl4RetryableCleanup({
      parallel,
      message: 'cleanup failed',
      steps: [
        () => {
          closed = true;
          calls[0]!++;
        },
        {
          isPending() {
            assert.equal(closed, true, 'ordinary operations close before inspection');
            if (inspectFails) {
              nested = cleanup.run('');
              void nested.catch(() => {});
              throw inspectionError;
            }
            return resourceOwned;
          },
          run() {
            if (++calls[1]! === 1) throw releaseError;
            resourceOwned = false;
          },
        },
        () => {
          calls[2]!++;
        },
      ],
    });
    const first = cleanup.run();
    assert.strictEqual(cleanup.run(), first);
    await assert.rejects(
      first,
      (error) =>
        error instanceof AggregateError &&
        error.errors.includes(inspectionError) &&
        error.errors.includes(releaseError),
    );
    assert.strictEqual(nested, first);
    assert.equal(closed, true);
    assert.equal(cleanup.requested, true);
    assert.deepEqual(calls, [1, 1, 1]);
    assert.equal(cleanup.hasPendingCleanup(), true);
    // A successful release is retained even if its inspection is still unavailable.
    await assert.rejects(
      cleanup.run(),
      (error) =>
        error instanceof AggregateError &&
        error.errors.includes(inspectionError) &&
        !error.errors.includes(releaseError),
    );
    assert.deepEqual(calls, [1, 2, 1]);
    assert.equal(cleanup.hasPendingCleanup(), true);
    inspectFails = false;
    await cleanup.run();
    assert.deepEqual(calls, [1, 2, 1]);
    assert.equal(cleanup.hasPendingCleanup(), false);
    assert.equal(cleanup.requested, true);
    resourceOwned = true;
    await cleanup.run();
    assert.deepEqual(calls, [1, 3, 1]);
    assert.equal(cleanup.hasPendingCleanup(), false);
  });
}

test('a failed inspection after successful disposal retains the owner without repeating successful releases', async () => {
  let inspectFails = false;
  let resourceOwned = true;
  const failure = new Error('late inspection unavailable');
  let childReleases = 0;
  let otherReleases = 0;
  const cleanup = createDsl4RetryableCleanup({
    message: 'cleanup failed',
    steps: [
      {
        isPending() {
          if (inspectFails) throw failure;
          return resourceOwned;
        },
        run() {
          childReleases++;
          resourceOwned = false;
        },
      },
      () => {
        otherReleases++;
      },
    ],
  });
  await cleanup.run();
  resourceOwned = inspectFails = true;
  assert.equal(
    cleanup.hasPendingCleanup(),
    true,
    'failed observation must conservatively retain ownership',
  );
  await assert.rejects(
    cleanup.run(),
    (error) => error instanceof AggregateError && error.errors.includes(failure),
  );
  assert.equal(childReleases, 1);
  assert.equal(otherReleases, 1);
  inspectFails = false;
  await cleanup.run();
  assert.equal(childReleases, 2);
  assert.equal(otherReleases, 1);
  assert.equal(cleanup.hasPendingCleanup(), false);
});
