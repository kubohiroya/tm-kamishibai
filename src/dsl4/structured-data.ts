import {createDsl4JsonPathEngine} from './jsonpath.js';

const collectionTypeTag = 'structured-data.query-collection.v1';
const iteratorTypeTag = 'structured-data.iterator.v1';

export const dsl4StructuredDataDefaultLimits = Object.freeze({
  maxActiveIterators: 1024,
});

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function success<T>(value: T): any {
  return deepFreeze({ok: true, value}) as Readonly<{ok: true; value: T}>;
}

function failure(code: string, operation: string, message: string, handleKind?: string): any {
  return deepFreeze({
    ok: false,
    error: {code, operation, message, ...(handleKind ? {handleKind} : {})},
  });
}

function forwardFailure(result: any, operation: string): any {
  return failure(result.error.code, operation, result.error.message, result.error.handleKind);
}

function normalizeLimits(input: unknown) {
  if (input === undefined) return dsl4StructuredDataDefaultLimits;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('limits must be an object');
  }
  const candidate = input as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !Object.hasOwn(dsl4StructuredDataDefaultLimits, key))) {
    throw new TypeError('limits contain an unknown field');
  }
  const normalized = {...dsl4StructuredDataDefaultLimits, ...candidate};
  if (
    !Number.isSafeInteger(normalized.maxActiveIterators) ||
    normalized.maxActiveIterators < 1 ||
    normalized.maxActiveIterators > dsl4StructuredDataDefaultLimits.maxActiveIterators
  ) {
    throw new TypeError('maxActiveIterators must be a positive safe integer within the default');
  }
  return Object.freeze(normalized);
}

function validateStore(store: unknown) {
  if (typeof store !== 'object' || store === null) {
    throw new TypeError('store must be a DSL 4 Object Store');
  }
  const candidate = store as Record<string, unknown>;
  for (const method of [
    'backendStatus',
    'createReference',
    'createScopeBundle',
    'duplicateReference',
    'readNodeView',
    'readValue',
    'releaseScope',
  ]) {
    if (typeof candidate[method] !== 'function') throw new TypeError(`store.${method} is required`);
  }
  return store as any;
}

function scalarKind(value: unknown) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  throw new TypeError('Object Store scalar is invalid');
}

/** Create the pure collection and Iterator composition over one Object Store realm. */
export function createDsl4StructuredDataComposition({
  store: inputStore,
  jsonPathLimits,
  limits: inputLimits,
}: {
  store?: unknown;
  jsonPathLimits?: object;
  limits?: Partial<typeof dsl4StructuredDataDefaultLimits>;
} = {}) {
  const store = validateStore(inputStore);
  const limits = normalizeLimits(inputLimits);
  const compiler = createDsl4JsonPathEngine({limits: jsonPathLimits});
  const collections = new Map();
  const iterators = new Map();
  let activeIteratorCount = 0;

  function requireScope(operation: string, ownerScopeRef: unknown) {
    if (ownerScopeRef === undefined) {
      return failure('STORE-VALUE-INVALID', operation, 'An owner scope is required');
    }
    return null;
  }

  function evaluateSource(
    source: unknown,
    path: unknown,
    singular: boolean,
    operation: string,
  ): any {
    const compiled = compiler.compile(path);
    if (!compiled.ok) return forwardFailure(compiled, operation);
    if (singular && !compiled.value.singular) {
      return failure(
        'SD-QUERY-NOT-SINGULAR',
        operation,
        'The JSONPath query is not syntactically singular',
      );
    }
    const view = store.readNodeView(source);
    if (!view.ok) return forwardFailure(view, operation);
    const engine = createDsl4JsonPathEngine({limits: jsonPathLimits, adapter: view.value.adapter});
    const evaluated = singular
      ? engine.querySingular(view.value.root, path)
      : engine.query(view.value.root, path);
    if (!evaluated.ok) return forwardFailure(evaluated, operation);
    return {ok: true, view: view.value, nodelist: evaluated.value};
  }

  function singularItem(evaluated: any, operation: string): any {
    if (evaluated.nodelist.nodes.length === 0) {
      return failure('SD-QUERY-NO-MATCH', operation, 'The singular JSONPath query matched no node');
    }
    const result = evaluated.nodelist.nodes[0];
    const kind = evaluated.view.adapter.classify(result.node);
    if (kind === 'scalar') {
      const value = evaluated.view.adapter.scalarValue(result.node);
      return {ok: true, item: {kind: scalarKind(value), value, path: result.path}};
    }
    return {ok: true, item: {kind: 'reference', path: result.path}};
  }

  function createSnapshot(evaluated: any, source: unknown): any {
    const references = [] as any[];
    const pendingItems = evaluated.nodelist.nodes.map((result: any) => {
      const kind = evaluated.view.adapter.classify(result.node);
      if (kind === 'scalar') {
        const value = evaluated.view.adapter.scalarValue(result.node);
        return Object.freeze({
          kind: scalarKind(value),
          value,
          normalizedPath: result.normalizedPath,
        });
      }
      const referenceIndex = references.length;
      references.push(Object.freeze({source, path: result.path}));
      return Object.freeze({
        kind: 'reference',
        referenceIndex,
        normalizedPath: result.normalizedPath,
      });
    });
    return {pendingItems, references};
  }

  function bindSnapshot(pendingItems: readonly any[], leases: readonly string[]) {
    return Object.freeze(
      pendingItems.map((item) =>
        item.kind === 'reference'
          ? Object.freeze({
              kind: 'reference',
              referenceLease: leases[item.referenceIndex],
              normalizedPath: item.normalizedPath,
            })
          : item,
      ),
    );
  }

  function storedSnapshot(items: readonly any[], kind: string) {
    return {
      kind,
      version: 1,
      length: items.length,
      items: items.map((item) =>
        item.kind === 'reference' ? {kind: 'reference'} : {kind: item.kind, value: item.value},
      ),
    };
  }

  function validateRecord(
    records: Map<any, any>,
    token: unknown,
    kind: 'collection' | 'iterator',
    operation: string,
  ): any {
    const record = records.get(token);
    const releasedCode = kind === 'collection' ? 'SD-COLLECTION-RELEASED' : 'SD-ITERATOR-RELEASED';
    if (!record) {
      const inspected = store.readValue(token);
      if (!inspected.ok) return forwardFailure(inspected, operation);
      return failure(
        'STORE-HANDLE-KIND',
        operation,
        `The handle is not a ${kind} owned by this composition`,
        'owner',
      );
    }
    if (record.lifecycle === 'released') {
      return failure(releasedCode, operation, `The ${kind} was released`);
    }
    const revision = store.backendStatus().revision;
    if (record.validatedRevision === revision) return {ok: true, record};
    const inspected = store.readValue(token);
    if (!inspected.ok) {
      if (
        inspected.error.code === 'STORE-REFERENCE-STALE' ||
        inspected.error.code === 'STORE-REFERENCE-RELEASED' ||
        inspected.error.code === 'STORE-SCOPE-RELEASED'
      ) {
        const cleanup = store.releaseScope(record.scopeRef);
        if (!cleanup.ok && cleanup.error.code !== 'STORE-SCOPE-RELEASED') {
          return forwardFailure(cleanup, operation);
        }
        record.lifecycle = 'released';
        if (kind === 'iterator') activeIteratorCount -= 1;
        return failure(releasedCode, operation, `The ${kind} was released`);
      }
      return forwardFailure(inspected, operation);
    }
    const expectedTypeTag = kind === 'collection' ? collectionTypeTag : iteratorTypeTag;
    if (inspected.value.typeTag !== expectedTypeTag) {
      return failure('STORE-HANDLE-KIND', operation, `The handle is not a ${kind}`, 'owner');
    }
    record.validatedRevision = revision;
    return {ok: true, record};
  }

  function ensureIteratorCapacity(operation: string) {
    if (activeIteratorCount < limits.maxActiveIterators) return null;
    for (const [token, record] of iterators) {
      if (record.lifecycle !== 'active') continue;
      validateRecord(iterators, token, 'iterator', operation);
    }
    return activeIteratorCount < limits.maxActiveIterators
      ? null
      : failure('STORE-LIMIT-EXCEEDED', operation, 'The active Iterator limit was exceeded');
  }

  function queryKind(source: unknown, path: unknown) {
    const operation = 'queryKind';
    const evaluated = evaluateSource(source, path, true, operation);
    if (!evaluated.ok) return evaluated;
    const selected = singularItem(evaluated, operation);
    return selected.ok ? success({kind: selected.item.kind}) : selected;
  }

  function queryScalar(source: unknown, path: unknown) {
    const operation = 'queryScalar';
    const evaluated = evaluateSource(source, path, true, operation);
    if (!evaluated.ok) return evaluated;
    const selected = singularItem(evaluated, operation);
    if (!selected.ok) return selected;
    if (selected.item.kind === 'reference') {
      return failure(
        'SD-QUERY-TYPE-MISMATCH',
        operation,
        'The selected JSONPath node is structured',
      );
    }
    return success({kind: 'scalar', value: selected.item.value});
  }

  function queryReference(source: unknown, path: unknown, ownerScopeRef: unknown) {
    const operation = 'queryReference';
    const missingScope = requireScope(operation, ownerScopeRef);
    if (missingScope) return missingScope;
    const evaluated = evaluateSource(source, path, true, operation);
    if (!evaluated.ok) return evaluated;
    const selected = singularItem(evaluated, operation);
    if (!selected.ok) return selected;
    if (selected.item.kind !== 'reference') {
      return failure('SD-QUERY-TYPE-MISMATCH', operation, 'The selected JSONPath node is scalar');
    }
    const created = store.createReference(source, selected.item.path, ownerScopeRef);
    return created.ok
      ? success({kind: 'reference', reference: created.value})
      : forwardFailure(created, operation);
  }

  function queryCollection(source: unknown, path: unknown, ownerScopeRef: unknown) {
    const operation = 'queryCollection';
    const missingScope = requireScope(operation, ownerScopeRef);
    if (missingScope) return missingScope;
    const evaluated = evaluateSource(source, path, false, operation);
    if (!evaluated.ok) return evaluated;
    const snapshot = createSnapshot(evaluated, source);
    const created = store.createScopeBundle({
      ownerScopeRef,
      label: 'structured-data.collection',
      typeTag: collectionTypeTag,
      value: storedSnapshot(snapshot.pendingItems, 'Dsl4QueryCollectionSnapshot'),
      references: snapshot.references,
    });
    if (!created.ok) return forwardFailure(created, operation);
    const items = bindSnapshot(snapshot.pendingItems, created.value.referenceLeases);
    collections.set(created.value.ownerRef, {
      lifecycle: 'active',
      scopeRef: created.value.scopeRef,
      items,
      validatedRevision: store.backendStatus().revision,
    });
    return success({
      kind: 'collection',
      collection: created.value.ownerRef,
      length: items.length,
    });
  }

  function newQueryIterator(source: unknown, path: unknown, ownerScopeRef: unknown) {
    const operation = 'newQueryIterator';
    const missingScope = requireScope(operation, ownerScopeRef);
    if (missingScope) return missingScope;
    const evaluated = evaluateSource(source, path, false, operation);
    if (!evaluated.ok) return evaluated;
    const capacity = ensureIteratorCapacity(operation);
    if (capacity) return capacity;
    const snapshot = createSnapshot(evaluated, source);
    const references = [Object.freeze({source, path: '$'}), ...snapshot.references];
    const created = store.createScopeBundle({
      ownerScopeRef,
      label: 'structured-data.iterator',
      typeTag: iteratorTypeTag,
      value: storedSnapshot(snapshot.pendingItems, 'Dsl4IteratorSnapshot'),
      references,
    });
    if (!created.ok) return forwardFailure(created, operation);
    const items = bindSnapshot(snapshot.pendingItems, created.value.referenceLeases.slice(1));
    iterators.set(created.value.ownerRef, {
      lifecycle: 'active',
      scopeRef: created.value.scopeRef,
      sourceLease: created.value.referenceLeases[0],
      items,
      position: -1,
      state: 'ready',
      validatedRevision: store.backendStatus().revision,
    });
    activeIteratorCount += 1;
    return success({kind: 'iterator', iterator: created.value.ownerRef, length: items.length});
  }

  function newCollectionIterator(collection: unknown, ownerScopeRef: unknown) {
    const operation = 'newCollectionIterator';
    const missingScope = requireScope(operation, ownerScopeRef);
    if (missingScope) return missingScope;
    const validated = validateRecord(collections, collection, 'collection', operation);
    if (!validated.ok) return validated;
    const capacity = ensureIteratorCapacity(operation);
    if (capacity) return capacity;
    const collectionRecord = validated.record;
    const references = [
      Object.freeze({source: collection, path: '$'}),
      ...collectionRecord.items
        .filter((item: any) => item.kind === 'reference')
        .map((item: any) => Object.freeze({source: item.referenceLease, path: '$'})),
    ];
    const created = store.createScopeBundle({
      ownerScopeRef,
      label: 'structured-data.iterator',
      typeTag: iteratorTypeTag,
      value: storedSnapshot(collectionRecord.items, 'Dsl4IteratorSnapshot'),
      references,
    });
    if (!created.ok) return forwardFailure(created, operation);
    let referenceIndex = 1;
    const items = Object.freeze(
      collectionRecord.items.map((item: any) =>
        item.kind === 'reference'
          ? Object.freeze({
              kind: 'reference',
              referenceLease: created.value.referenceLeases[referenceIndex++],
              normalizedPath: item.normalizedPath,
            })
          : item,
      ),
    );
    iterators.set(created.value.ownerRef, {
      lifecycle: 'active',
      scopeRef: created.value.scopeRef,
      sourceLease: created.value.referenceLeases[0],
      items,
      position: -1,
      state: 'ready',
      validatedRevision: store.backendStatus().revision,
    });
    activeIteratorCount += 1;
    return success({kind: 'iterator', iterator: created.value.ownerRef, length: items.length});
  }

  function iteratorNext(iterator: unknown) {
    const operation = 'iteratorNext';
    const validated = validateRecord(iterators, iterator, 'iterator', operation);
    if (!validated.ok) return validated;
    const record = validated.record;
    if (record.state === 'exhausted') return success({kind: 'iterator-step', status: 'done'});
    const nextPosition = record.position + 1;
    if (nextPosition >= record.items.length) {
      record.position = record.items.length;
      record.state = 'exhausted';
      return success({kind: 'iterator-step', status: 'done'});
    }
    record.position = nextPosition;
    record.state = 'positioned';
    return success({kind: 'iterator-step', status: 'item'});
  }

  function currentItem(iterator: unknown, operation: string): any {
    const validated = validateRecord(iterators, iterator, 'iterator', operation);
    if (!validated.ok) return validated;
    if (validated.record.state !== 'positioned') {
      return failure('SD-ITERATOR-NOT-POSITIONED', operation, 'The Iterator has no current item');
    }
    return {ok: true, item: validated.record.items[validated.record.position]};
  }

  function iteratorCurrentKind(iterator: unknown) {
    const operation = 'iteratorCurrentKind';
    const current = currentItem(iterator, operation);
    return current.ok ? success({kind: current.item.kind}) : current;
  }

  function iteratorCurrentScalar(iterator: unknown) {
    const operation = 'iteratorCurrentScalar';
    const current = currentItem(iterator, operation);
    if (!current.ok) return current;
    if (current.item.kind === 'reference') {
      return failure(
        'SD-QUERY-TYPE-MISMATCH',
        operation,
        'The current Iterator item is structured',
      );
    }
    return success({kind: 'scalar', value: current.item.value});
  }

  function iteratorCurrentReference(iterator: unknown, ownerScopeRef: unknown) {
    const operation = 'iteratorCurrentReference';
    const missingScope = requireScope(operation, ownerScopeRef);
    if (missingScope) return missingScope;
    const current = currentItem(iterator, operation);
    if (!current.ok) return current;
    if (current.item.kind !== 'reference') {
      return failure('SD-QUERY-TYPE-MISMATCH', operation, 'The current Iterator item is scalar');
    }
    const duplicated = store.duplicateReference(current.item.referenceLease, ownerScopeRef);
    return duplicated.ok
      ? success({kind: 'reference', reference: duplicated.value})
      : forwardFailure(duplicated, operation);
  }

  function releaseCollection(collection: unknown) {
    const operation = 'releaseCollection';
    const validated = validateRecord(collections, collection, 'collection', operation);
    if (!validated.ok) return validated;
    const released = store.releaseScope(validated.record.scopeRef);
    if (!released.ok) {
      if (released.error.code === 'STORE-SCOPE-RELEASED') {
        validated.record.lifecycle = 'released';
        return failure('SD-COLLECTION-RELEASED', operation, 'The collection was released');
      }
      return forwardFailure(released, operation);
    }
    validated.record.lifecycle = 'released';
    return success({released: true});
  }

  function releaseIterator(iterator: unknown) {
    const operation = 'releaseIterator';
    const validated = validateRecord(iterators, iterator, 'iterator', operation);
    if (!validated.ok) return validated;
    const released = store.releaseScope(validated.record.scopeRef);
    if (!released.ok) {
      if (released.error.code === 'STORE-SCOPE-RELEASED') {
        validated.record.lifecycle = 'released';
        activeIteratorCount -= 1;
        return failure('SD-ITERATOR-RELEASED', operation, 'The Iterator was released');
      }
      return forwardFailure(released, operation);
    }
    validated.record.lifecycle = 'released';
    activeIteratorCount -= 1;
    return success({released: true});
  }

  function debugNormalizedPath(resource: unknown, index: unknown) {
    const operation = 'debugNormalizedPath';
    const records = collections.has(resource) ? collections : iterators;
    const kind = records === collections ? 'collection' : 'iterator';
    const validated = validateRecord(records, resource, kind, operation);
    if (!validated.ok) return validated;
    if (
      !Number.isSafeInteger(index) ||
      Number(index) < 0 ||
      Number(index) >= validated.record.items.length
    ) {
      return failure('STORE-VALUE-INVALID', operation, 'The snapshot item index is invalid');
    }
    return success({normalizedPath: validated.record.items[Number(index)].normalizedPath});
  }

  return Object.freeze({
    limits,
    jsonPathLimits: compiler.limits,
    queryKind,
    queryScalar,
    queryReference,
    queryCollection,
    newQueryIterator,
    newCollectionIterator,
    iteratorNext,
    iteratorCurrentKind,
    iteratorCurrentScalar,
    iteratorCurrentReference,
    releaseCollection,
    releaseIterator,
    debugNormalizedPath,
  });
}
