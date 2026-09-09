import assert from 'node:assert/strict';
import {test} from 'vitest';

import {requireArray, requireRecord} from './helpers/require-value.ts';

import {
  createDsl4JsonPathEngine,
  createDsl4MapBackend,
  createDsl4ObjectStore,
  createDsl4StructuredDataComposition,
} from '../src/dsl4/index.js';

type BackendOptions = NonNullable<Parameters<typeof createDsl4MapBackend>[0]>;
type StoreOptions = NonNullable<Parameters<typeof createDsl4ObjectStore>[0]>;
type CompositionOptions = NonNullable<Parameters<typeof createDsl4StructuredDataComposition>[0]>;
type ObjectStore = ReturnType<typeof createDsl4ObjectStore>;

/** The knobs one case or another turns; every fixture leaves the rest at their defaults. */
interface FixtureOptions {
  beforeCommit?: BackendOptions['beforeCommit'];
  storeLimits?: StoreOptions['limits'];
  jsonPathLimits?: CompositionOptions['jsonPathLimits'];
  limits?: CompositionOptions['limits'];
}

/** The pure node view `readNodeView` hands back, whose adapter a case drives directly. */
interface NodeView {
  root: Record<string, unknown>;
  adapter: {classify(node: unknown): unknown};
}

function deterministicNonceSource(seed = 1) {
  let counter = seed;
  return (length: number) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = (counter + index * 29) & 0xff;
    }
    counter += 1;
    return bytes;
  };
}

function fixture({beforeCommit, storeLimits, jsonPathLimits, limits}: FixtureOptions = {}) {
  const backend = createDsl4MapBackend(beforeCommit === undefined ? {} : {beforeCommit});
  const store = createDsl4ObjectStore({
    backend,
    nonceSource: deterministicNonceSource(),
    ...(storeLimits === undefined ? {} : {limits: storeLimits}),
  });
  const data = createDsl4StructuredDataComposition({
    store,
    ...(jsonPathLimits === undefined ? {} : {jsonPathLimits}),
    ...(limits === undefined ? {} : {limits}),
  });
  return {backend, store, data};
}

/**
 * Read the value one successful Store or composition call produced.
 *
 * The two branches are not a discriminated union -- `ok` is a plain boolean on both -- and a value
 * is a handle as often as it is a record, so the value stays `unknown` until a case reads into it
 * through `okRecord` below.
 */
function ok(result: unknown): unknown {
  const record = requireRecord(result, 'the operation result');
  assert.equal(record.ok, true, JSON.stringify(record));
  return record.value;
}

/** Read that value as the record whose members a case walks into. */
function okRecord(result: unknown, description: string): Record<string, unknown> {
  return requireRecord(ok(result), description);
}

/** Read the pure node view one successful `readNodeView` produced. */
function okNodeView(result: unknown): NodeView {
  return okRecord(result, 'the node view') as unknown as NodeView;
}

function errorCode(result: unknown, code: string, operation?: string) {
  const record = requireRecord(result, 'the operation result');
  assert.equal(record.ok, false, JSON.stringify(record));
  const error = requireRecord(record.error, 'its error');
  assert.equal(error.code, code);
  if (operation) assert.equal(error.operation, operation);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.error), true);
}

function snapshot(store: ObjectStore) {
  return JSON.stringify(store.debugSnapshot());
}

function incomingCount(store: ObjectStore) {
  return store
    .debugSnapshot()
    .nodes.reduce((sum: number, node: {incomingCount: number}) => sum + node.incomingCount, 0);
}

test('returns typed singular scalar and reference results while preserving null and empty string', () => {
  const {store, data} = fixture();
  const source = ok(
    store.newEntry({nil: null, empty: '', flag: false, count: 3, actor: {name: 'Hero'}}, 'fixture'),
  );
  const caller = ok(store.createScope(store.rootScopeRef, 'caller'));

  assert.deepEqual(ok(data.queryKind(source, '$.nil')), {kind: 'null'});
  assert.deepEqual(ok(data.queryKind(source, '$.empty')), {kind: 'string'});
  assert.deepEqual(ok(data.queryKind(source, '$.flag')), {kind: 'boolean'});
  assert.deepEqual(ok(data.queryKind(source, '$.count')), {kind: 'number'});
  assert.deepEqual(ok(data.queryKind(source, '$.actor')), {kind: 'reference'});
  assert.deepEqual(ok(data.queryScalar(source, '$.nil')), {kind: 'scalar', value: null});
  assert.deepEqual(ok(data.queryScalar(source, '$.empty')), {kind: 'scalar', value: ''});

  const selected = okRecord(data.queryReference(source, '$.actor', caller), 'the selected result');
  assert.equal(selected.kind, 'reference');
  assert.deepEqual(ok(store.readValue(selected.reference)), {
    typeTag: 'fixture',
    value: {name: 'Hero'},
  });
  ok(store.releaseReference(selected.reference));

  errorCode(data.queryKind(source, '$.missing'), 'SD-QUERY-NO-MATCH', 'queryKind');
  errorCode(data.queryScalar(source, '$.actor'), 'SD-QUERY-TYPE-MISMATCH', 'queryScalar');
  errorCode(
    data.queryReference(source, '$.count', caller),
    'SD-QUERY-TYPE-MISMATCH',
    'queryReference',
  );
  // The owner scope is deliberately absent here: the case proves the query is refused without one.
  errorCode(
    data.queryReference(source, '$.actor', undefined),
    'STORE-VALUE-INVALID',
    'queryReference',
  );
  errorCode(data.queryKind('invalid', '$[*]'), 'SD-QUERY-NOT-SINGULAR', 'queryKind');
  errorCode(data.queryKind(source, '$..actor'), 'SD-JSONPATH-UNSUPPORTED', 'queryKind');
});

test('owns duplicate structured results as independent collection leases', () => {
  const {store, data} = fixture();
  const source = ok(
    store.newEntry({items: [null, '', {id: 'A'}, {id: 'B'}]}, 'fixture.collection'),
  );
  const caller = ok(store.createScope(store.rootScopeRef, 'caller'));
  const before = store.debugSnapshot();

  const collection = okRecord(
    data.queryCollection(source, '$.items[0,1,2,2,3]', caller),
    'the collection result',
  );
  assert.equal(collection.kind, 'collection');
  assert.equal(collection.length, 5);
  assert.equal(store.debugSnapshot().counts.scopes, before.counts.scopes + 1);
  assert.equal(store.debugSnapshot().counts.entries, before.counts.entries + 1);
  assert.equal(store.debugSnapshot().counts.leases, before.counts.leases + 3);
  assert.equal(incomingCount(store), 3);
  errorCode(store.free(source), 'STORE-OBJECT-IN-USE', 'free');

  const stored = okRecord(store.readValue(collection.collection), 'the stored result');
  assert.equal(stored.typeTag, 'structured-data.query-collection.v1');
  assert.deepEqual(requireRecord(stored.value, 'its value').items, [
    {kind: 'null', value: null},
    {kind: 'string', value: ''},
    {kind: 'reference'},
    {kind: 'reference'},
    {kind: 'reference'},
  ]);

  ok(data.releaseCollection(collection.collection));
  assert.equal(store.debugSnapshot().counts.leases, 0);
  assert.equal(incomingCount(store), 0);
  errorCode(
    data.releaseCollection(collection.collection),
    'SD-COLLECTION-RELEASED',
    'releaseCollection',
  );

  const empty = okRecord(data.queryCollection(source, '$.missing', caller), 'the empty result');
  assert.equal(empty.length, 0);
  assert.deepEqual(
    requireRecord(
      okRecord(store.readValue(empty.collection), 'the stored collection').value,
      'its value',
    ).items,
    [],
  );
  ok(data.releaseCollection(empty.collection));
  ok(store.free(source));
});

test('iterates an immutable collection snapshot and releases source, item, and caller leases exactly', () => {
  const {backend, store, data} = fixture();
  const source = ok(store.newEntry({items: [null, '', {id: 'A'}, {id: 'B'}]}, 'fixture'));
  const ownerScope = ok(store.createScope(store.rootScopeRef, 'owner'));
  const callerScope = ok(store.createScope(store.rootScopeRef, 'caller'));
  const collection = okRecord(
    data.queryCollection(source, '$.items[0,1,2,2,3]', ownerScope),
    'the collection result',
  );
  const iterator = okRecord(
    data.newCollectionIterator(collection.collection, ownerScope),
    'the iterator result',
  );

  assert.equal(iterator.length, 5);
  assert.equal(store.debugSnapshot().counts.leases, 7);
  errorCode(
    data.iteratorCurrentKind(iterator.iterator),
    'SD-ITERATOR-NOT-POSITIONED',
    'iteratorCurrentKind',
  );
  const beforeBlockedRelease = snapshot(store);
  const beforeBlockedStatus = backend.debugStatus();
  errorCode(
    data.releaseCollection(collection.collection),
    'STORE-OBJECT-IN-USE',
    'releaseCollection',
  );
  assert.equal(snapshot(store), beforeBlockedRelease);
  assert.equal(backend.debugStatus().revision, beforeBlockedStatus.revision);
  assert.strictEqual(backend.debugStatus().rootIdentity, beforeBlockedStatus.rootIdentity);

  assert.deepEqual(ok(data.iteratorNext(iterator.iterator)), {
    kind: 'iterator-step',
    status: 'item',
  });
  assert.deepEqual(ok(data.iteratorCurrentKind(iterator.iterator)), {kind: 'null'});
  assert.deepEqual(ok(data.iteratorCurrentScalar(iterator.iterator)), {
    kind: 'scalar',
    value: null,
  });

  ok(data.iteratorNext(iterator.iterator));
  assert.deepEqual(ok(data.iteratorCurrentScalar(iterator.iterator)), {
    kind: 'scalar',
    value: '',
  });

  ok(data.iteratorNext(iterator.iterator));
  assert.deepEqual(ok(data.iteratorCurrentKind(iterator.iterator)), {kind: 'reference'});
  const firstCaller = okRecord(
    data.iteratorCurrentReference(iterator.iterator, callerScope),
    'the current reference',
  ).reference;
  const secondCaller = okRecord(
    data.iteratorCurrentReference(iterator.iterator, callerScope),
    'the current reference',
  ).reference;
  assert.notEqual(firstCaller, secondCaller);
  assert.deepEqual(okRecord(store.readValue(firstCaller), 'the stored value').value, {id: 'A'});
  errorCode(
    data.iteratorCurrentScalar(iterator.iterator),
    'SD-QUERY-TYPE-MISMATCH',
    'iteratorCurrentScalar',
  );

  ok(data.iteratorNext(iterator.iterator));
  const thirdCaller = okRecord(
    data.iteratorCurrentReference(iterator.iterator, callerScope),
    'the current reference',
  ).reference;
  assert.deepEqual(okRecord(store.readValue(thirdCaller), 'the stored value').value, {id: 'A'});
  assert.equal(store.debugSnapshot().counts.leases, 10);
  ok(data.iteratorNext(iterator.iterator));
  assert.deepEqual(ok(data.iteratorCurrentKind(iterator.iterator)), {kind: 'reference'});
  assert.deepEqual(ok(data.iteratorNext(iterator.iterator)), {
    kind: 'iterator-step',
    status: 'done',
  });
  errorCode(
    data.iteratorCurrentKind(iterator.iterator),
    'SD-ITERATOR-NOT-POSITIONED',
    'iteratorCurrentKind',
  );

  const exhaustedStatus = backend.debugStatus();
  const exhaustedCounts = store.debugSnapshot().counts;
  for (let count = 0; count < 5; count += 1) {
    assert.deepEqual(ok(data.iteratorNext(iterator.iterator)), {
      kind: 'iterator-step',
      status: 'done',
    });
  }
  assert.equal(backend.debugStatus().revision, exhaustedStatus.revision);
  assert.deepEqual(store.debugSnapshot().counts, exhaustedCounts);

  ok(data.releaseIterator(iterator.iterator));
  errorCode(data.iteratorNext(iterator.iterator), 'SD-ITERATOR-RELEASED', 'iteratorNext');
  ok(data.releaseCollection(collection.collection));
  errorCode(store.free(source), 'STORE-OBJECT-IN-USE', 'free');

  ok(store.releaseScope(callerScope));
  for (const handle of [firstCaller, secondCaller, thirdCaller]) {
    errorCode(store.readValue(handle), 'STORE-REFERENCE-RELEASED', 'readValue');
  }
  ok(store.free(source));
});

test('a query Iterator retains its source even when every result is scalar', () => {
  const {store, data} = fixture();
  const source = ok(store.newEntry({value: 1}, 'fixture'));
  const iterator = okRecord(
    data.newQueryIterator(source, '$.value', store.rootScopeRef),
    'the iterator result',
  );

  assert.equal(store.debugSnapshot().counts.leases, 1);
  errorCode(store.free(source), 'STORE-OBJECT-IN-USE', 'free');
  ok(data.iteratorNext(iterator.iterator));
  assert.deepEqual(ok(data.iteratorCurrentScalar(iterator.iterator)), {kind: 'scalar', value: 1});
  ok(data.releaseIterator(iterator.iterator));
  ok(store.free(source));
});

test('traverses attached RefValue edges and creates a lease for the selected target node', () => {
  const {store, data} = fixture();
  const source = ok(store.newEntry({}, 'fixture.source'));
  const target = ok(store.newEntry({name: 'Target'}, 'fixture.target'));
  ok(store.setReferenceValue(source, 'friend', target));

  assert.deepEqual(ok(data.queryScalar(source, '$.friend.name')), {
    kind: 'scalar',
    value: 'Target',
  });
  const selected = okRecord(
    data.queryReference(source, '$.friend', store.rootScopeRef),
    'the selected result',
  );
  assert.deepEqual(ok(store.readValue(selected.reference)), {
    typeTag: 'fixture.target',
    value: {name: 'Target'},
  });
  ok(store.releaseReference(selected.reference));
  ok(store.free(source));
  ok(store.free(target));
});

test('cleans private scopes after a bundle OwnerRef is freed directly through Core', () => {
  const {store, data} = fixture();
  const source = ok(store.newEntry([{id: 1}], 'fixture'));
  const collection = okRecord(
    data.queryCollection(source, '$[*]', store.rootScopeRef),
    'the collection result',
  );
  assert.equal(store.debugSnapshot().counts.leases, 1);

  ok(store.free(collection.collection));
  assert.equal(store.debugSnapshot().counts.leases, 1);
  errorCode(
    data.releaseCollection(collection.collection),
    'SD-COLLECTION-RELEASED',
    'releaseCollection',
  );
  assert.equal(store.debugSnapshot().counts.leases, 0);
  assert.equal(store.debugSnapshot().counts.scopes, 1);

  const iterator = okRecord(
    data.newQueryIterator(source, '$[*]', store.rootScopeRef),
    'the iterator result',
  );
  ok(store.free(iterator.iterator));
  errorCode(data.iteratorNext(iterator.iterator), 'SD-ITERATOR-RELEASED', 'iteratorNext');
  assert.equal(store.debugSnapshot().counts.leases, 0);
  assert.equal(store.debugSnapshot().counts.scopes, 1);
  ok(store.free(source));
});

test('rolls every JSONPath, handle-limit, and backend failure back without partial Store state', () => {
  let failBundle = false;
  const setup = fixture({
    beforeCommit({operation}: {operation: string}) {
      if (operation === 'createScopeBundle' && failBundle) return 'failure';
    },
  });
  const source = ok(setup.store.newEntry({items: [{id: 1}, {id: 2}]}, 'fixture'));
  const beforeFailure = snapshot(setup.store);
  const beforeStatus = setup.backend.debugStatus();
  failBundle = true;
  errorCode(
    setup.data.queryCollection(source, '$.items[*]', setup.store.rootScopeRef),
    'STORE-BACKEND-FAILURE',
    'queryCollection',
  );
  assert.equal(snapshot(setup.store), beforeFailure);
  assert.equal(setup.backend.debugStatus().revision, beforeStatus.revision);
  assert.strictEqual(setup.backend.debugStatus().rootIdentity, beforeStatus.rootIdentity);

  const resultLimited = fixture({jsonPathLimits: {maxResults: 1}});
  const limitedSource = ok(resultLimited.store.newEntry([1, 2], 'fixture'));
  const beforeLimit = snapshot(resultLimited.store);
  errorCode(
    resultLimited.data.queryCollection(limitedSource, '$[*]', resultLimited.store.rootScopeRef),
    'SD-JSONPATH-EVALUATION-LIMIT',
    'queryCollection',
  );
  assert.equal(snapshot(resultLimited.store), beforeLimit);

  const handleLimited = fixture({storeLimits: {maxHandles: 3}});
  const handleSource = ok(handleLimited.store.newEntry([{id: 1}], 'fixture'));
  const beforeHandleLimit = snapshot(handleLimited.store);
  errorCode(
    handleLimited.data.queryCollection(handleSource, '$[*]', handleLimited.store.rootScopeRef),
    'STORE-LIMIT-EXCEEDED',
    'queryCollection',
  );
  assert.equal(snapshot(handleLimited.store), beforeHandleLimit);

  const invalidBundle = fixture();
  const invalidSource = ok(invalidBundle.store.newEntry({value: 1}, 'fixture'));
  const beforeInvalid = snapshot(invalidBundle.store);
  const sparseReferences = new Array(1);
  const accessorBundle = {value: {kind: 'test'}};
  Object.defineProperty(accessorBundle, 'references', {get: () => [], enumerable: true});
  for (const input of [
    {value: {}, references: sparseReferences},
    accessorBundle,
    {value: {}, references: [{source: invalidSource, unknown: true}]},
  ]) {
    errorCode(
      invalidBundle.store.createScopeBundle(input),
      'STORE-VALUE-INVALID',
      'createScopeBundle',
    );
    assert.equal(snapshot(invalidBundle.store), beforeInvalid);
  }
});

test('maps parent-scope release to terminal collection and Iterator states without orphans', () => {
  const {store, data} = fixture();
  const source = ok(store.newEntry({items: [1, 2]}, 'fixture'));
  const parent = ok(store.createScope(store.rootScopeRef, 'parent'));
  const collection = okRecord(
    data.queryCollection(source, '$.items[*]', parent),
    'the collection result',
  );
  const iterator = okRecord(
    data.newQueryIterator(source, '$.items[*]', parent),
    'the iterator result',
  );

  ok(store.releaseScope(parent));
  errorCode(
    data.releaseCollection(collection.collection),
    'SD-COLLECTION-RELEASED',
    'releaseCollection',
  );
  errorCode(data.iteratorNext(iterator.iterator), 'SD-ITERATOR-RELEASED', 'iteratorNext');
  assert.equal(store.debugSnapshot().counts.scopes, 1);
  assert.equal(store.debugSnapshot().counts.leases, 0);
  assert.equal(store.debugSnapshot().counts.entries, 1);

  const later = okRecord(
    data.newQueryIterator(source, '$.items[*]', store.rootScopeRef),
    'the later result',
  );
  store.disposeRealm();
  errorCode(data.iteratorNext(later.iterator), 'STORE-REALM-DISPOSED', 'iteratorNext');
  assert.deepEqual(store.debugSnapshot().counts, {
    scopes: 0,
    entries: 0,
    nodes: 0,
    leases: 0,
    handles: 0,
    tombstones: 0,
    referenceEdges: 0,
  });
});

test('enforces the active Iterator limit and reclaims capacity after wrapper or parent release', () => {
  const {store, data} = fixture({limits: {maxActiveIterators: 1}});
  const source = ok(store.newEntry([1], 'fixture'));
  const first = okRecord(
    data.newQueryIterator(source, '$[*]', store.rootScopeRef),
    'the first result',
  );
  const before = snapshot(store);
  errorCode(
    data.newQueryIterator(source, '$[*]', store.rootScopeRef),
    'STORE-LIMIT-EXCEEDED',
    'newQueryIterator',
  );
  assert.equal(snapshot(store), before);
  ok(data.releaseIterator(first.iterator));

  const parent = ok(store.createScope(store.rootScopeRef, 'parent'));
  ok(data.newQueryIterator(source, '$[*]', parent));
  ok(store.releaseScope(parent));
  const replacement = okRecord(
    data.newQueryIterator(source, '$[*]', store.rootScopeRef),
    'the replacement result',
  );
  ok(data.releaseIterator(replacement.iterator));
  ok(store.free(source));
});

test('preserves Object Store member insertion order through the pure node view', () => {
  const {store, data} = fixture();
  const source = ok(store.newEntry({z: 'first', a: 'second'}, 'fixture'));
  const view = okNodeView(store.readNodeView(source));
  assert.deepEqual(Object.keys(view.root), ['kind']);
  assert.equal(JSON.stringify(view).includes('first'), false);
  assert.throws(() => {
    const other = okNodeView(store.readNodeView(source));
    other.adapter.classify(view.root);
  }, /another view/);

  const iterator = okRecord(
    data.newQueryIterator(source, '$.*', store.rootScopeRef),
    'the iterator result',
  );
  const values: unknown[] = [];
  while (okRecord(data.iteratorNext(iterator.iterator), 'the iterator step').status === 'item') {
    values.push(
      okRecord(data.iteratorCurrentScalar(iterator.iterator), 'the current scalar').value,
    );
  }
  assert.deepEqual(values, ['first', 'second']);
  ok(data.releaseIterator(iterator.iterator));
  ok(store.free(source));

  const engine = createDsl4JsonPathEngine({adapter: view.adapter});
  assert.deepEqual(
    requireArray(
      okRecord(engine.query(view.root, '$.*'), 'the engine query result').nodes,
      'its nodes',
    ).map((node) => requireRecord(node, 'a nodelist entry').normalizedPath),
    ["$['z']", "$['a']"],
  );
});

test('matches a deterministic Iterator state and lease-count model', () => {
  const {store, data} = fixture();
  let randomState = 0x4d3c2b1a;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState;
  };

  for (let scenario = 0; scenario < 40; scenario += 1) {
    const values = Array.from({length: random() % 7}, (_, index) => {
      const choice = random() % 5;
      if (choice === 0) return null;
      if (choice === 1) return Boolean(random() & 1);
      if (choice === 2) return random() % 100;
      if (choice === 3) return `v${random() % 100}`;
      return {index};
    });
    const source = ok(store.newEntry(values, 'model'));
    const iterator = okRecord(
      data.newQueryIterator(source, '$[*]', store.rootScopeRef),
      'the iterator result',
    );
    const structuredCount = values.filter(
      (value) => typeof value === 'object' && value !== null,
    ).length;
    assert.equal(store.debugSnapshot().counts.leases, 1 + structuredCount);

    const callerLeases: unknown[] = [];
    for (let position = 0; position < values.length; position += 1) {
      assert.equal(
        okRecord(data.iteratorNext(iterator.iterator), 'the iterator step').status,
        'item',
      );
      const expected = values[position];
      if (typeof expected === 'object' && expected !== null) {
        assert.deepEqual(ok(data.iteratorCurrentKind(iterator.iterator)), {kind: 'reference'});
        if (random() & 1) {
          callerLeases.push(
            okRecord(
              data.iteratorCurrentReference(iterator.iterator, store.rootScopeRef),
              'the current reference',
            ).reference,
          );
        }
      } else {
        assert.deepEqual(
          okRecord(data.iteratorCurrentScalar(iterator.iterator), 'the current scalar').value,
          expected,
        );
      }
    }
    assert.equal(
      okRecord(data.iteratorNext(iterator.iterator), 'the iterator step').status,
      'done',
    );
    const beforeDone = store.debugSnapshot().counts;
    assert.equal(
      okRecord(data.iteratorNext(iterator.iterator), 'the iterator step').status,
      'done',
    );
    assert.deepEqual(store.debugSnapshot().counts, beforeDone);

    ok(data.releaseIterator(iterator.iterator));
    assert.equal(store.debugSnapshot().counts.leases, callerLeases.length);
    for (const lease of callerLeases) ok(store.releaseReference(lease));
    ok(store.free(source));
    assert.equal(store.debugSnapshot().counts.leases, 0);
  }
});
