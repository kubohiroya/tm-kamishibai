import assert from 'node:assert/strict';
import {test} from 'vitest';
import {
  Dsl4CreationFailure,
  getDsl4CreationCleanup,
  createDsl4CreationCleanup,
  cleanupDsl4FailedCreation,
  dsl4FailedCreationCleanupSteps,
} from '../src/dsl4/creation-cleanup.js';
import {deferred} from './helpers/async-test-helpers.ts';

for (const asynchronous of [false, true])
  test(`creation cleanup joins child failure, aggregates independent cleanup, and retries explicitly (async: ${asynchronous})`, async () => {
    const primary = new Error('factory rejected'),
      releaseError = new Error('release failed');
    let calls = 0,
      other = 0,
      nested: Promise<void> | null = null;
    let reenter = () => {};
    const child = createDsl4CreationCleanup(
      [
        () => {
          reenter();
          if (++calls < 3) {
            if (asynchronous) return Promise.reject(releaseError);
            throw releaseError;
          }
        },
      ],
      'child',
    );
    await assert.rejects(child.dispose(), AggregateError);
    const failure = new Dsl4CreationFailure(primary, child, 'child failed');
    const parent = createDsl4CreationCleanup(
      [
        ...dsl4FailedCreationCleanupSteps(failure),
        () => {
          other++;
        },
      ],
      'parent',
    );
    await assert.rejects(
      cleanupDsl4FailedCreation(failure, parent, 'creation-failed', 'parent failed'),
      (error) => {
        assert(error instanceof Dsl4CreationFailure);
        assert.equal(error.cause, failure);
        assert.equal(error.cleanup, parent);
        assert(
          error.errors.some(
            (item) => item instanceof AggregateError && item.errors.includes(releaseError),
          ),
        );
        return true;
      },
    );
    assert.equal(calls, 1, 'parent propagation must not retry a rejected initial attempt');
    reenter = () => {
      nested = parent.dispose();
    };
    const retry = parent.dispose();
    assert.equal(retry, parent.dispose());
    await assert.rejects(retry, AggregateError);
    assert.equal(nested, retry);
    assert.equal(calls, 2);
    assert.equal(other, 1);
    await parent.dispose();
    assert.equal(calls, 3);
    assert.equal(parent.hasPendingCleanup(), false);
    assert.equal(other, 1);
  });

test('creation cleanup keeps successful but late owners and an unfinished initial attempt reachable', async () => {
  const gate = deferred<void>();
  let pending = true,
    calls = 0;
  const child = createDsl4CreationCleanup(
    [
      {
        isPending: () => pending,
        async run() {
          if (++calls === 1) await gate.promise;
          else pending = false;
        },
      },
    ],
    'child',
  );
  const first = child.dispose();
  const failure = new Dsl4CreationFailure(new Error('prepare failed'), child, 'failed');
  const parent = createDsl4CreationCleanup(dsl4FailedCreationCleanupSteps(failure), 'parent');
  const join = parent.dispose();
  assert.equal(calls, 1);
  assert.equal(join, parent.dispose());
  gate.resolve();
  await first;
  await join;
  assert(parent.hasPendingCleanup());
  await parent.dispose();
  assert.equal(calls, 2);
  assert.equal(parent.hasPendingCleanup(), false);
});

test('cleanup handoff accepts the checked contract from another bundle and preserves opaque failures', async () => {
  let calls = 0;
  const cleanup = createDsl4CreationCleanup(
    [
      () => {
        calls++;
      },
    ],
    'foreign cleanup',
  );
  const foreign = {name: 'Dsl4CreationFailure', cleanup};
  assert.equal(getDsl4CreationCleanup(foreign), cleanup);
  const parent = createDsl4CreationCleanup(dsl4FailedCreationCleanupSteps(foreign), 'parent');
  await parent.dispose();
  assert.equal(calls, 1);
  for (const opaque of [
    null,
    new Error('ordinary'),
    {name: 'Dsl4CreationFailure', cleanup: {}},
    {
      name: 'Dsl4CreationFailure',
      get cleanup() {
        throw new Error('opaque getter');
      },
    },
  ])
    assert.equal(getDsl4CreationCleanup(opaque), null);
});
