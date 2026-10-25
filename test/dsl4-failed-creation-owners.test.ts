import assert from 'node:assert/strict';
import {test} from 'vitest';
import {createDsl4FailedCreationOwners} from '../src/dsl4/failed-creation-owners.js';
import {failedFactory} from './helpers/failed-factory.ts';
import {deferred} from './helpers/async-test-helpers.ts';

test('deduplicates an unpublished child, joins its initial cleanup and retries only explicitly', async () => {
  const child = failedFactory();
  const owners = createDsl4FailedCreationOwners('Failed children');
  assert.equal(owners.retain(new Error('opaque failure')), null);
  const first = owners.retain(child.failure);
  assert.ok(first);
  assert.strictEqual(owners.retain({name: 'Dsl4CreationFailure', cleanup: child.cleanup}), first);
  await assert.rejects(owners.drain(), AggregateError);
  assert.equal(child.release.mock.calls.length, 1);
  assert.equal(owners.hasPendingCleanup(), true);
  child.repair();
  await owners.drain();
  assert.equal(child.release.mock.calls.length, 2);
  assert.equal(owners.hasPendingCleanup(), false);
  await owners.drain();
  assert.equal(child.release.mock.calls.length, 2);
});

test('repeated late notifications join the initial failure without implicitly retrying it', async () => {
  const child = failedFactory();
  const owners = createDsl4FailedCreationOwners('Late notifications');
  assert.equal(owners.joinLateFailure(new Error('ordinary notification')), null);
  const initial = owners.joinLateFailure(child.failure);
  assert.ok(initial);
  assert.strictEqual(owners.joinLateFailure(child.failure), initial);
  await assert.rejects(initial);
  await assert.rejects(owners.joinLateFailure(child.failure)!);
  assert.equal(child.release.mock.calls.length, 1);
  assert.equal(owners.hasPendingCleanup(), true);
  child.repair();
  await owners.drain();
  assert.equal(child.release.mock.calls.length, 2);
  assert.equal(owners.hasPendingCleanup(), false);
});

test('parent disposal joins an in-flight child release and includes a late factory failure', async () => {
  const first = failedFactory(),
    late = failedFactory();
  const gate = deferred();
  const owners = createDsl4FailedCreationOwners('Failed children');
  const retained = owners.retain(first.failure)!;
  const attempt = retained.release();
  const rejected = assert.rejects(attempt);
  owners.beginDispose();
  const pending = gate.promise.then(() => {
    owners.retain(late.failure);
    return owners.drain();
  });
  gate.resolve();
  await Promise.all([rejected, assert.rejects(pending)]);
  assert.equal(first.release.mock.calls.length, 1);
  assert.equal(late.release.mock.calls.length, 1);
  owners.endDispose();
  first.repair();
  late.repair();
  await owners.drain();
  assert.equal(first.release.mock.calls.length, 2);
  assert.equal(late.release.mock.calls.length, 2);
});

test('a pending inspector failure retains its owner while independent children finish cleanup', async () => {
  const child = failedFactory(),
    other = failedFactory();
  let broken = true;
  const owners = createDsl4FailedCreationOwners('Failed children');
  owners.retain({
    name: 'Dsl4CreationFailure',
    cleanup: {
      get completion() {
        return child.cleanup.completion;
      },
      dispose: child.cleanup.dispose,
      hasPendingCleanup() {
        if (broken) throw new Error('inspection failed');
        return child.cleanup.hasPendingCleanup();
      },
    },
  });
  owners.retain(other.failure);
  other.repair();
  await assert.rejects(owners.drain());
  await assert.rejects(owners.drain());
  assert.equal(other.release.mock.calls.length, 2);
  assert.equal(owners.hasPendingCleanup(), true);
  broken = false;
  child.repair();
  await owners.drain();
  assert.equal(other.release.mock.calls.length, 2);
  assert.equal(owners.hasPendingCleanup(), false);
});

test('a completed handle can hand off a newly reported pending resource without using a stale entry', async () => {
  let pending = false,
    releases = 0;
  const owners = createDsl4FailedCreationOwners('Failed children');
  const failure = {
    name: 'Dsl4CreationFailure',
    cleanup: {
      completion: null,
      async dispose() {
        releases++;
        pending = false;
      },
      hasPendingCleanup: () => pending,
    },
  };
  const previous = owners.retain(failure);
  await owners.drain();
  pending = true;
  assert.notStrictEqual(owners.retain(failure), previous);
  await owners.drain();
  assert.equal(releases, 2);
  assert.equal(owners.hasPendingCleanup(), false);
});
