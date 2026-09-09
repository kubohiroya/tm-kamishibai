import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4MapBackend, createDsl4ObjectStore, isDsl4RefValue} from '../src/dsl4/index.js';
import {
  requireArray,
  requireDefined,
  requireRecord,
  requireString,
} from './helpers/require-value.ts';

type StoreOptions = NonNullable<Parameters<typeof createDsl4ObjectStore>[0]>;
type ObjectStore = ReturnType<typeof createDsl4ObjectStore>;

/** The knobs one case or another turns; every store leaves the rest at their defaults. */
interface StoreFixtureOptions {
  backend?: StoreOptions['backend'];
  nonceSource?: StoreOptions['nonceSource'];
  limits?: StoreOptions['limits'];
}

/**
 * Read the value one successful Store call produced.
 *
 * The result's two branches are not a discriminated union -- `ok` is a plain boolean on both -- and
 * a value is a handle string as often as a record, so it stays `unknown` until a case reads into it
 * through `okRecord`.
 */

function deterministicNonceSource(seed = 0) {
  let counter = seed;
  return (length: number) => {
    counter += 1;
    return Uint8Array.from({length}, (_, index) => (counter * 37 + index * 13) & 0xff);
  };
}

function createStore(options: StoreFixtureOptions = {}) {
  const backend = options.backend ?? createDsl4MapBackend();
  const store = createDsl4ObjectStore({
    backend,
    nonceSource: options.nonceSource ?? deterministicNonceSource(),
    ...(options.limits ? {limits: options.limits} : {}),
  });
  return {backend, store};
}

function ok(result: unknown): unknown {
  const record = requireRecord(result, 'the operation result');
  assert.equal(record.ok, true, JSON.stringify(record));
  return record.value;
}

/** Hand a constructor a value its own types forbid, to prove it refuses one. */
function outOfContract<T>(value: unknown): T {
  return value as T;
}

/** Read that value as the record whose members a case walks into. */
function okRecord(result: unknown, description: string): Record<string, unknown> {
  return requireRecord(ok(result), description);
}

function errorCode(result: unknown, code: string) {
  const record = requireRecord(result, 'the operation result');
  assert.equal(record.ok, false, JSON.stringify(record));
  assert.equal(requireRecord(record.error, 'its error').code, code);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.error), true);
}

function serializedSnapshot(store: ObjectStore) {
  return JSON.stringify(store.debugSnapshot());
}

function assertCountsConsistent(store: ObjectStore) {
  const snapshot = store.debugSnapshot();
  for (const node of snapshot.nodes) {
    assert.equal(node.incomingCount, node.computedIncomingCount);
    assert.ok(node.incomingCount >= 0);
  }
}

test('creates one isolated realm with a redacted immutable root snapshot', () => {
  const backend = createDsl4MapBackend();
  const store = createDsl4ObjectStore({backend, nonceSource: deterministicNonceSource()});
  const status = backend.debugStatus();
  const snapshot = store.debugSnapshot();

  assert.match(store.rootScopeRef, /^@os1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
  assert.equal(store.rootScopeRef.includes('scope'), false);
  assert.deepEqual(snapshot.counts, {
    scopes: 1,
    entries: 0,
    nodes: 0,
    leases: 0,
    handles: 1,
    tombstones: 0,
    referenceEdges: 0,
  });
  assert.equal(status.revision, 0);
  assert.equal(status.commitCount, 0);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.scopes), true);
  assert.equal(JSON.stringify(snapshot).includes('@os1.'), false);
  assert.equal(JSON.stringify(snapshot).includes('realmNonce'), false);

  assert.throws(() => createDsl4ObjectStore({backend}), /MapBackend must be unused/);
  // Deliberately out of contract: each case hands the constructor a value its types forbid, to
  // prove the runtime validation rejects it rather than trusting the declaration.
  assert.throws(() => createDsl4ObjectStore(outOfContract({backend: {}})), /MapBackend/);
  assert.throws(() => createDsl4ObjectStore({limits: {maxNodes: 0}}), /maxNodes/);
  assert.throws(() => createDsl4MapBackend(outOfContract({beforeCommit: true})), /beforeCommit/);
});

test('stores an immutable JSON-like tree and rolls validation failures back byte-for-byte', () => {
  const {backend, store} = createStore();
  const input = {actor: {name: 'Hero'}, positions: [0, 10], ready: true, note: null};
  const owner = ok(store.newEntry(input, 'fixture.actor'));
  input.actor.name = 'Changed';
  input.positions.push(20);
  assert.deepEqual(ok(store.readValue(owner)), {
    typeTag: 'fixture.actor',
    value: {actor: {name: 'Hero'}, note: null, positions: [0, 10], ready: true},
  });
  assert.equal(Object.isFrozen(okRecord(store.readValue(owner), 'the stored value').value), true);
  assert.equal(serializedSnapshot(store).includes('Hero'), false);
  assert.equal(serializedSnapshot(store).includes('fixture.actor'), false);

  const cycle: {self?: unknown} = {};
  cycle.self = cycle;
  const shared = {};
  const dangerous = {};
  Object.defineProperty(dangerous, '__proto__', {value: 1, enumerable: true});
  const accessor = {};
  Object.defineProperty(accessor, 'value', {get: () => 1, enumerable: true});
  const invalidValues: [unknown, string][] = [
    [cycle, 'STORE-VALUE-CYCLE'],
    [{left: shared, right: shared}, 'STORE-VALUE-INVALID'],
    [dangerous, 'STORE-VALUE-INVALID'],
    [accessor, 'STORE-VALUE-INVALID'],
    [{value: Infinity}, 'STORE-VALUE-INVALID'],
    [Object.freeze({value: 1n}), 'STORE-VALUE-INVALID'],
  ];
  for (const [value, code] of invalidValues) {
    const before = serializedSnapshot(store);
    const status = backend.debugStatus();
    errorCode(store.newEntry(value, 'invalid'), code);
    assert.equal(serializedSnapshot(store), before);
    assert.equal(backend.debugStatus().revision, status.revision);
    assert.strictEqual(backend.debugStatus().rootIdentity, status.rootIdentity);
  }
});

test('counts independent leases while treating copied handle strings as aliases', () => {
  const {backend, store} = createStore();
  const owner = ok(store.newEntry({actor: {name: 'Hero'}}, 'fixture'));
  const lease = ok(store.createReference(owner, '$.actor'));
  const alias = `${lease}`;
  const afterLease = backend.debugStatus();
  assert.equal(alias, lease);
  assert.strictEqual(backend.debugStatus().rootIdentity, afterLease.rootIdentity);
  assert.equal(
    store.debugSnapshot().nodes.find((node) => node.incomingCount === 1)?.kind,
    'object',
  );

  const duplicate = ok(store.duplicateReference(alias));
  assert.notEqual(duplicate, lease);
  assert.equal(
    store.debugSnapshot().nodes.find((node) => node.incomingCount === 2)?.kind,
    'object',
  );
  errorCode(store.free(owner), 'STORE-OBJECT-IN-USE');
  ok(store.releaseReference(lease));
  errorCode(store.releaseReference(alias), 'STORE-REFERENCE-RELEASED');
  ok(store.releaseReference(duplicate));
  ok(store.free(owner));
  errorCode(store.free(owner), 'STORE-REFERENCE-STALE');

  const replacement = ok(store.newEntry({actor: 'new'}, 'fixture'));
  assert.notEqual(replacement, owner);
  errorCode(store.readValue(owner), 'STORE-REFERENCE-STALE');
  assertCountsConsistent(store);
});

test('distinguishes malformed, foreign, unknown, stale, released, and wrong-kind handles', () => {
  const first = createStore({nonceSource: deterministicNonceSource(10)}).store;
  const second = createStore({nonceSource: deterministicNonceSource(20)}).store;
  const owner = ok(first.newEntry({value: 1}, 'fixture'));
  const lease = ok(first.createReference(owner));

  errorCode(first.free(first.rootScopeRef), 'STORE-HANDLE-KIND');
  errorCode(first.releaseReference(owner), 'STORE-HANDLE-KIND');
  errorCode(first.readValue(second.rootScopeRef), 'STORE-REALM-MISMATCH');
  errorCode(first.readValue('not-a-handle'), 'STORE-REFERENCE-INVALID');
  const [, realmNonce] = requireDefined(
    /^@os1\.([^.]+)\./u.exec(requireString(first.rootScopeRef, 'the root scope handle')),
    'the realm nonce match',
  );
  errorCode(
    first.readValue(`@os1.${realmNonce}.AAAAAAAAAAAAAAAAAAAAAA`),
    'STORE-REFERENCE-INVALID',
  );

  ok(first.releaseReference(lease));
  errorCode(first.readValue(lease), 'STORE-REFERENCE-RELEASED');
  ok(first.free(owner));
  errorCode(first.readValue(owner), 'STORE-REFERENCE-STALE');
});

test('maintains RefValue counts, permits entry-local cycles, and rejects cross-owner cycles', () => {
  const {backend, store} = createStore();
  const ownerA = ok(store.newEntry({name: 'A'}, 'fixture'));
  const ownerB = ok(store.newEntry({name: 'B'}, 'fixture'));
  ok(store.setReferenceValue(ownerA, 'friend', ownerB));
  const valueA = requireRecord(
    okRecord(store.readValue(ownerA), 'the stored value').value,
    'its value',
  );
  assert.equal(isDsl4RefValue(valueA.friend), true);
  assert.deepEqual(Object.keys(requireRecord(valueA.friend, 'its friend')), ['kind']);
  errorCode(store.createReference(valueA.friend), 'STORE-HANDLE-KIND');
  errorCode(store.free(ownerB), 'STORE-OBJECT-IN-USE');

  const beforeCycle = serializedSnapshot(store);
  const beforeCycleStatus = backend.debugStatus();
  errorCode(store.setReferenceValue(ownerB, 'friend', ownerA), 'STORE-STRONG-CYCLE');
  assert.equal(serializedSnapshot(store), beforeCycle);
  assert.equal(backend.debugStatus().revision, beforeCycleStatus.revision);
  assert.strictEqual(backend.debugStatus().rootIdentity, beforeCycleStatus.rootIdentity);

  const beforeNoop = backend.debugStatus();
  assert.deepEqual(ok(store.setReferenceValue(ownerA, 'friend', ownerB)), {changed: false});
  assert.strictEqual(backend.debugStatus().rootIdentity, beforeNoop.rootIdentity);
  ok(store.free(ownerA));
  assert.equal(
    store.debugSnapshot().nodes.every((node) => node.incomingCount === 0),
    true,
  );
  ok(store.free(ownerB));

  const removableSource = ok(store.newEntry({}, 'fixture'));
  const removableTarget = ok(store.newEntry({}, 'fixture'));
  ok(store.setReferenceValue(removableSource, 'value', removableTarget));
  ok(store.deleteReferenceValue(removableSource, 'value'));
  ok(store.free(removableTarget));
  ok(store.free(removableSource));

  const self = ok(store.newEntry({name: 'Self'}, 'fixture'));
  ok(store.setReferenceValue(self, 'self', self));
  assert.equal(
    isDsl4RefValue(
      requireRecord(okRecord(store.readValue(self), 'the stored value').value, 'its value').self,
    ),
    true,
  );
  const selfLease = ok(store.createReference(self, '$.self'));
  ok(store.releaseReference(selfLease));
  ok(store.free(self));

  const structural = ok(store.newEntry({friend: null}, 'fixture'));
  const target = ok(store.newEntry({}, 'fixture'));
  errorCode(store.setReferenceValue(structural, 'friend', target), 'STORE-VALUE-INVALID');
  errorCode(store.setReferenceValue(structural, 'missing', undefined), 'STORE-REFERENCE-INVALID');

  const arrayOwner = ok(store.newEntry([], 'fixture'));
  errorCode(store.setReferenceValue(arrayOwner, 1, target), 'STORE-VALUE-INVALID');
  ok(store.setReferenceValue(arrayOwner, 0, target));
  assert.equal(
    isDsl4RefValue(
      requireArray(okRecord(store.readValue(arrayOwner), 'the stored value').value, 'its value')[0],
    ),
    true,
  );
  errorCode(store.setReferenceValue(arrayOwner, 2, target), 'STORE-VALUE-INVALID');
  ok(store.deleteReferenceValue(arrayOwner, 0));
  assertCountsConsistent(store);
});

test('releases a complete scope atomically only after external incoming references are gone', () => {
  const {backend, store} = createStore();
  const outer = ok(store.createScope(store.rootScopeRef, 'outer'));
  const inner = ok(store.createScope(outer, 'inner'));
  const ownerA = ok(store.newEntry({name: 'A'}, 'fixture', outer));
  const ownerB = ok(store.newEntry({name: 'B'}, 'fixture', inner));
  ok(store.setReferenceValue(ownerA, 'friend', ownerB));
  const internalLease = ok(store.createReference(ownerA, '$.friend', inner));
  const externalLease = ok(store.createReference(ownerB, '$', store.rootScopeRef));

  const before = serializedSnapshot(store);
  const status = backend.debugStatus();
  errorCode(store.releaseScope(outer), 'STORE-OBJECT-IN-USE');
  assert.equal(serializedSnapshot(store), before);
  assert.equal(backend.debugStatus().revision, status.revision);
  assert.strictEqual(backend.debugStatus().rootIdentity, status.rootIdentity);

  ok(store.releaseReference(externalLease));
  ok(store.releaseScope(outer));
  errorCode(store.releaseScope(outer), 'STORE-SCOPE-RELEASED');
  errorCode(store.readValue(ownerA), 'STORE-REFERENCE-STALE');
  errorCode(store.releaseReference(internalLease), 'STORE-REFERENCE-RELEASED');
  assert.deepEqual(store.debugSnapshot().counts, {
    scopes: 1,
    entries: 0,
    nodes: 0,
    leases: 0,
    handles: 7,
    tombstones: 6,
    referenceEdges: 0,
  });
});

test('keeps the root and revision unchanged on injected conflict and backend failure', () => {
  let decision: 'conflict' | 'failure' | 'throw' | undefined;
  const backend = createDsl4MapBackend({
    beforeCommit() {
      const next = decision;
      decision = undefined;
      if (next === 'throw') throw new Error('injected');
      return next;
    },
  });
  const {store} = createStore({backend});

  const injectedCases: ['conflict' | 'failure' | 'throw', () => unknown, string][] = [
    ['conflict', () => store.newEntry({value: 1}, 'fixture'), 'STORE-CONFLICT'],
    ['failure', () => store.createScope(), 'STORE-BACKEND-FAILURE'],
    ['throw', () => store.newEntry({value: 2}, 'fixture'), 'STORE-BACKEND-FAILURE'],
  ];
  for (const [nextDecision, operation, code] of injectedCases) {
    const before = serializedSnapshot(store);
    const status = backend.debugStatus();
    decision = nextDecision;
    errorCode(operation(), code);
    assert.equal(serializedSnapshot(store), before);
    assert.equal(backend.debugStatus().revision, status.revision);
    assert.equal(backend.debugStatus().commitCount, status.commitCount);
    assert.strictEqual(backend.debugStatus().rootIdentity, status.rootIdentity);
  }

  ok(store.newEntry({value: 3}, 'fixture'));
  assert.equal(backend.debugStatus().revision, 1);
  assert.equal(backend.debugStatus().commitCount, 1);
});

test('enforces finite limits and fails closed on deterministic nonce collisions', () => {
  const limited = createStore({limits: {maxHandles: 1}});
  const beforeLimited = limited.backend.debugStatus();
  errorCode(limited.store.createScope(), 'STORE-LIMIT-EXCEEDED');
  assert.strictEqual(limited.backend.debugStatus().rootIdentity, beforeLimited.rootIdentity);

  const nodeLimited = createStore({limits: {maxNodes: 2}});
  errorCode(nodeLimited.store.newEntry({left: 1, right: 2}, 'fixture'), 'STORE-LIMIT-EXCEEDED');
  assert.equal(nodeLimited.store.debugSnapshot().counts.nodes, 0);

  const constantNonce = (length: number) => new Uint8Array(length).fill(7);
  const collision = createStore({nonceSource: constantNonce});
  const beforeCollision = collision.backend.debugStatus();
  errorCode(collision.store.createScope(), 'STORE-LIMIT-EXCEEDED');
  assert.strictEqual(collision.backend.debugStatus().rootIdentity, beforeCollision.rootIdentity);
  assert.equal(collision.store.debugSnapshot().counts.handles, 1);
});

test('disposes the realm idempotently and preserves an active realm when disposal fails', () => {
  const {backend, store} = createStore();
  const owner = ok(store.newEntry({value: 1}, 'fixture'));
  const firstDispose = store.disposeRealm();
  const disposed = okRecord(firstDispose, 'the disposal report');
  assert.equal(disposed.realmState, 'disposed');
  assert.deepEqual(disposed.counts, {
    scopes: 0,
    entries: 0,
    nodes: 0,
    leases: 0,
    handles: 0,
    tombstones: 0,
    referenceEdges: 0,
  });
  assert.strictEqual(store.disposeRealm(), firstDispose);
  errorCode(store.readValue(owner), 'STORE-REALM-DISPOSED');
  errorCode(store.createScope(), 'STORE-REALM-DISPOSED');
  assert.equal(backend.debugStatus().revision, 2);

  let fail = true;
  const failingBackend = createDsl4MapBackend({
    beforeCommit({operation}: {operation: string}) {
      if (operation === 'disposeRealm' && fail) return 'failure';
    },
  });
  const failing = createStore({backend: failingBackend}).store;
  const before = serializedSnapshot(failing);
  errorCode(failing.disposeRealm(), 'STORE-BACKEND-FAILURE');
  assert.equal(serializedSnapshot(failing), before);
  assert.equal(failing.debugSnapshot().realmState, 'active');
  fail = false;
  okRecord(failing.disposeRealm(), 'the second disposal report');
});

test('matches a lease-count reference model across deterministic randomized operations', () => {
  const {store} = createStore({limits: {maxHandles: 512, maxNodes: 512}});
  const owners = new Map();
  const leases = new Map();
  let randomState = 0x5eed1234;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState;
  };
  const pick = <T>(values: T[]): T =>
    requireDefined(values[random() % values.length], 'a randomly picked entry');

  for (let step = 0; step < 300; step += 1) {
    const activeOwners = [...owners.entries()].filter(([, model]) => model.active);
    const activeLeases = [...leases.entries()].filter(([, model]) => model.active);
    const choice = random() % 6;
    if (choice === 0 && activeOwners.length < 40) {
      const owner = ok(store.newEntry({value: step}, 'model'));
      owners.set(owner, {active: true, count: 0});
    } else if (choice <= 2 && activeOwners.length > 0) {
      const [owner, model] = pick(activeOwners);
      const lease = ok(store.createReference(owner));
      model.count += 1;
      leases.set(lease, {active: true, owner});
    } else if (choice === 3 && activeLeases.length > 0) {
      const [source, sourceModel] = pick(activeLeases);
      const lease = ok(store.duplicateReference(source));
      owners.get(sourceModel.owner).count += 1;
      leases.set(lease, {active: true, owner: sourceModel.owner});
    } else if (choice === 4 && activeLeases.length > 0) {
      const [lease, model] = pick(activeLeases);
      ok(store.releaseReference(lease));
      model.active = false;
      owners.get(model.owner).count -= 1;
    } else if (activeOwners.length > 0) {
      const [owner, model] = pick(activeOwners);
      const result = store.free(owner);
      if (model.count === 0) {
        ok(result);
        model.active = false;
      } else {
        errorCode(result, 'STORE-OBJECT-IN-USE');
      }
    }

    const expectedIncoming = [...owners.values()].reduce(
      (sum, model) => sum + (model.active ? model.count : 0),
      0,
    );
    const actualIncoming = store
      .debugSnapshot()
      .nodes.reduce((sum, node) => sum + node.incomingCount, 0);
    assert.equal(actualIncoming, expectedIncoming);
    assertCountsConsistent(store);
  }

  for (const [lease, model] of leases) {
    if (!model.active) continue;
    ok(store.releaseReference(lease));
    model.active = false;
    owners.get(model.owner).count -= 1;
  }
  for (const [owner, model] of owners) {
    if (!model.active) continue;
    assert.equal(model.count, 0);
    ok(store.free(owner));
    model.active = false;
  }
  assert.equal(store.debugSnapshot().counts.entries, 0);
  assert.equal(store.debugSnapshot().counts.leases, 0);
});
