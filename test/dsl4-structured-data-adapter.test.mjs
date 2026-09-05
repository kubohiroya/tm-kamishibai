import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {test} from 'vitest';

import {resolveModulePath} from './helpers/module-path.mjs';

import {
  createDsl4ObjectStore,
  createDsl4StructuredDataAdapter,
  createDsl4StructuredDataComposition,
} from '../src/dsl4/index.js';

function deterministicNonceSource(seed = 1) {
  let counter = seed;
  return (length) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) bytes[index] = (counter + index * 17) & 0xff;
    counter += 1;
    return bytes;
  };
}

function fixture({limits, adapterNonceSource = deterministicNonceSource(101)} = {}) {
  const store = createDsl4ObjectStore({nonceSource: deterministicNonceSource(1)});
  const composition = createDsl4StructuredDataComposition({store});
  const adapter = createDsl4StructuredDataAdapter({
    store,
    composition,
    nonceSource: adapterNonceSource,
    limits,
  });
  return {store, composition, adapter};
}

function exception(adapter, value, code, operation) {
  assert.equal(adapter.isException(value), true);
  assert.match(value, /^@sdx1\.[A-Za-z0-9_-]{22,86}\.[A-Za-z0-9_-]{22,86}$/u);
  assert.equal(adapter.exceptionCode(value), code);
  if (operation) assert.equal(adapter.exceptionOperation(value), operation);
  assert.equal(typeof adapter.exceptionMessage(value), 'string');
  return value;
}

test('projects every typed operation through one Standalone facade', () => {
  const {store, adapter} = fixture();
  const defaultScope = adapter.defaultScope();
  const caller = adapter.createScope(defaultScope, 'caller');
  const source = adapter.newEntryFromJson(
    '{"nil":null,"empty":"","actors":[{"name":"A"},{"name":"B"}]}',
    'fixture',
    defaultScope,
  );

  assert.equal(adapter.isReference(defaultScope), true);
  assert.equal(adapter.isReference(source), true);
  assert.equal(adapter.isException(source), false);
  assert.equal(adapter.queryKind(source, '$.nil'), 'null');
  assert.equal(adapter.queryScalar(source, '$.nil'), '');
  assert.equal(adapter.queryKind(source, '$.empty'), 'string');
  assert.equal(adapter.queryScalar(source, '$.empty'), '');

  const reference = adapter.queryReference(source, '$.actors[0]', caller);
  assert.equal(adapter.isReference(reference), true);
  const duplicate = adapter.duplicateReference(reference, caller);
  assert.notEqual(duplicate, reference);
  assert.equal(adapter.releaseReference(reference), true);
  assert.equal(adapter.releaseReference(duplicate), true);

  const collection = adapter.queryCollection(source, '$.actors[0,0,1]', defaultScope);
  assert.equal(adapter.debugHandleKind(collection), 'collection');
  assert.equal(adapter.debugNormalizedPath(collection, 0), "$['actors'][0]");
  assert.equal(adapter.debugNormalizedPath(collection, 1), "$['actors'][0]");
  const iterator = adapter.newCollectionIterator(collection, defaultScope);
  assert.equal(adapter.debugHandleKind(iterator), 'iterator');
  assert.equal(adapter.iteratorNext(iterator), 'item');
  assert.equal(adapter.iteratorCurrentKind(iterator), 'reference');
  const current = adapter.iteratorCurrentReference(iterator, caller);
  assert.equal(adapter.isReference(current), true);
  assert.equal(adapter.releaseReference(current), true);
  assert.equal(adapter.iteratorNext(iterator), 'item');
  assert.equal(adapter.iteratorNext(iterator), 'item');
  assert.equal(adapter.iteratorNext(iterator), 'done');
  assert.equal(adapter.iteratorNext(iterator), 'done');
  assert.equal(adapter.releaseIterator(iterator), true);
  assert.equal(adapter.releaseCollection(collection), true);

  const scalarIterator = adapter.newQueryIterator(source, '$.nil', defaultScope);
  assert.equal(adapter.iteratorNext(scalarIterator), 'item');
  assert.equal(adapter.iteratorCurrentKind(scalarIterator), 'null');
  assert.equal(adapter.iteratorCurrentScalar(scalarIterator), '');
  assert.equal(adapter.releaseIterator(scalarIterator), true);

  assert.equal(adapter.debugHandleKind(defaultScope), 'scope');
  assert.equal(adapter.debugHandleKind(source), 'owner');
  assert.equal(adapter.debugAssertInvariants(), true);
  const debug = adapter.debugSnapshot();
  assert.equal(JSON.stringify(debug).includes('@os1.'), false);
  assert.equal(JSON.stringify(debug).includes('fixture'), false);
  assert.equal(JSON.stringify(adapter.debugLimits()).includes('maxActiveExceptions'), true);

  const protectedScope = exception(
    adapter,
    adapter.releaseScope(defaultScope),
    'SD-SCOPE-PROTECTED',
    'releaseScope',
  );
  assert.equal(adapter.releaseException(protectedScope), true);
  assert.equal(adapter.isException(protectedScope), true);
  const expired = adapter.exceptionCode(protectedScope);
  exception(adapter, expired, 'SD-EXCEPTION-EXPIRED', 'exceptionCode');

  const noMatch = adapter.queryScalar(source, '$.missing');
  exception(adapter, noMatch, 'SD-QUERY-NO-MATCH', 'queryScalar');
  assert.equal(adapter.exceptionMessage(noMatch).includes('$.missing'), false);
  assert.equal(adapter.exceptionMessage(noMatch).includes(source), false);
  const invalidJson = adapter.newEntryFromJson('{secret', 'secret-type', defaultScope);
  exception(adapter, invalidJson, 'STORE-VALUE-INVALID', 'newEntryFromJson');
  assert.equal(adapter.exceptionMessage(invalidJson).includes('secret'), false);

  assert.equal(adapter.exceptionCode('ordinary string'), '');
  assert.equal(adapter.releaseException('ordinary string'), true);
  assert.equal(adapter.freeEntry(source), true);
  assert.equal(adapter.releaseScope(caller), true);
  assert.equal(store.debugSnapshot().counts.entries, 0);
});

test('bounds active and tombstone ExceptionRefs with a reserved overflow record', () => {
  const {store, adapter} = fixture({
    limits: {maxActiveExceptions: 2, maxExceptionTombstones: 2, maxNonceAttempts: 2},
  });
  const countsBefore = store.debugSnapshot().counts;
  const statusBefore = store.backendStatus();

  const first = adapter.queryKind('invalid', '$');
  const second = adapter.queryKind('invalid', '$');
  const overflow = adapter.queryKind('invalid', '$');
  assert.notEqual(first, second);
  assert.notEqual(second, overflow);
  exception(adapter, first, 'STORE-REFERENCE-INVALID', 'queryKind');
  exception(adapter, second, 'STORE-REFERENCE-INVALID', 'queryKind');
  exception(adapter, overflow, 'SD-ADAPTER-EXCEPTION-LIMIT', 'exception');
  assert.equal(adapter.releaseException(overflow), true);
  assert.equal(adapter.isException(overflow), true);

  assert.equal(adapter.releaseException(first), true);
  const replacement = adapter.queryKind('invalid', '$');
  assert.notEqual(replacement, first);
  exception(adapter, replacement, 'STORE-REFERENCE-INVALID', 'queryKind');
  assert.equal(adapter.releaseException(second), true);
  assert.equal(adapter.releaseException(replacement), true);
  assert.equal(adapter.isException(first), false);
  assert.equal(adapter.isException(second), true);
  assert.equal(adapter.isException(replacement), true);

  assert.deepEqual(store.debugSnapshot().counts, countsBefore);
  assert.equal(store.backendStatus().revision, statusBefore.revision);
  assert.strictEqual(store.backendStatus().rootIdentity, statusBefore.rootIdentity);
});

test('falls back to the reserved ExceptionRef on nonce collision or nonce failure', () => {
  const values = [];
  const nonceSource = (length) => {
    if (values.length >= 2) throw new Error('injected nonce failure');
    const bytes = new Uint8Array(length).fill(values.length + 1);
    values.push(bytes);
    return bytes;
  };
  const {adapter} = fixture({adapterNonceSource: nonceSource});
  const result = adapter.queryKind('invalid', '$');
  exception(adapter, result, 'SD-ADAPTER-EXCEPTION-LIMIT', 'exception');

  const collisionAdapter = fixture({
    adapterNonceSource: (length) => new Uint8Array(length).fill(7),
    limits: {maxNonceAttempts: 2},
  }).adapter;
  const collision = collisionAdapter.queryKind('invalid', '$');
  exception(collisionAdapter, collision, 'SD-ADAPTER-EXCEPTION-LIMIT', 'exception');
  assert.equal(collisionAdapter.releaseException(collision), true);
  assert.equal(collisionAdapter.isException(collision), true);
});

test('expires ExceptionRefs without changing Core handles and destroys the table on dispose', () => {
  const {store, adapter} = fixture();
  const token = adapter.queryKind('invalid', '$');
  const defaultScope = adapter.defaultScope();
  assert.equal(adapter.expireExceptions(), true);
  assert.equal(adapter.isException(token), true);
  const expired = adapter.exceptionMessage(token);
  exception(adapter, expired, 'SD-EXCEPTION-EXPIRED', 'exceptionMessage');
  assert.equal(store.debugSnapshot().counts.handles, 2);
  assert.equal(adapter.dispose(), true);
  assert.equal(adapter.dispose(), true);
  assert.equal(adapter.isException(token), false);
  assert.equal(adapter.isException(expired), false);
  assert.equal(adapter.isReference(defaultScope), false);
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

test('keeps Adapter tables out of Object Store source and platform dependencies', async () => {
  const [adapterSource, storeSource] = await Promise.all(
    ['structured-data-adapter.js', 'object-store/store.js'].map(async (name) =>
      readFile(
        await resolveModulePath(fileURLToPath(new URL(`../src/dsl4/${name}`, import.meta.url))),
        'utf8',
      ),
    ),
  );
  assert.doesNotMatch(storeSource, /@sdx1|ExceptionRef|activeExceptions/);
  assert.doesNotMatch(
    adapterSource,
    /from\s+['"](?:node:|[^'"]*(?:scratch-vm|turbowarp|story-document))|window\.|document\.|fetch\(/i,
  );
  assert.doesNotMatch(adapterSource, /\b(?:eval|Function)\s*\(/);
});
