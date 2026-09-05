import {createDsl4ObjectStore} from './object-store/index.js';
import {createDsl4StructuredDataComposition} from './structured-data.js';

const base64UrlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const collectionTypeTag = 'structured-data.query-collection.v1';
const iteratorTypeTag = 'structured-data.iterator.v1';
const safeDiagnosticLength = 512;
const exceptionReporterOperations = Object.freeze({
  code: 'exceptionCode',
  operation: 'exceptionOperation',
  message: 'exceptionMessage',
});

export const dsl4StructuredDataAdapterDefaultLimits = Object.freeze({
  maxActiveExceptions: 256,
  maxExceptionTombstones: 256,
  maxNonceAttempts: 8,
});

function defaultNonceSource(byteLength: number) {
  if (!globalThis.crypto?.getRandomValues)
    throw new TypeError('A cryptographic nonce source is required');
  return globalThis.crypto.getRandomValues(new Uint8Array(byteLength));
}

function encodeBase64Url(bytes: Uint8Array) {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const combined = (first << 16) | (second << 8) | third;
    encoded += base64UrlAlphabet[(combined >>> 18) & 63];
    encoded += base64UrlAlphabet[(combined >>> 12) & 63];
    if (index + 1 < bytes.length) encoded += base64UrlAlphabet[(combined >>> 6) & 63];
    if (index + 2 < bytes.length) encoded += base64UrlAlphabet[combined & 63];
  }
  return encoded;
}

function createNonce(nonceSource: (byteLength: number) => Uint8Array) {
  const bytes = nonceSource(16);
  if (!(bytes instanceof Uint8Array) || bytes.length < 16 || bytes.length > 64) {
    throw new TypeError('nonceSource must return between 16 and 64 bytes');
  }
  return encodeBase64Url(bytes);
}

function normalizeLimits(input: unknown) {
  if (input === undefined) return dsl4StructuredDataAdapterDefaultLimits;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('limits must be an object');
  }
  const candidate = input as Record<string, unknown>;
  if (
    Object.keys(candidate).some(
      (key) => !Object.hasOwn(dsl4StructuredDataAdapterDefaultLimits, key),
    )
  ) {
    throw new TypeError('limits contain an unknown field');
  }
  const normalized = {...dsl4StructuredDataAdapterDefaultLimits, ...candidate};
  const defaults = dsl4StructuredDataAdapterDefaultLimits as Readonly<Record<string, number>>;
  for (const [name, value] of Object.entries(normalized)) {
    const maximum = defaults[name];
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
      throw new TypeError(`${name} must be a positive safe integer within the default`);
    }
  }
  return Object.freeze(normalized);
}

function validateStore(store: unknown) {
  if (typeof store !== 'object' || store === null) {
    throw new TypeError('store must be a DSL 4 Object Store');
  }
  const candidate = store as Record<string, unknown>;
  for (const method of [
    'classifyHandle',
    'createScope',
    'debugSnapshot',
    'disposeRealm',
    'duplicateReference',
    'free',
    'newEntry',
    'releaseReference',
    'releaseScope',
  ]) {
    if (typeof candidate[method] !== 'function') throw new TypeError(`store.${method} is required`);
  }
  if (typeof candidate.rootScopeRef !== 'string') {
    throw new TypeError('store.rootScopeRef is required');
  }
  if (
    typeof candidate.limits !== 'object' ||
    candidate.limits === null ||
    !Number.isSafeInteger((candidate.limits as any).maxStringLength)
  ) {
    throw new TypeError('store.limits.maxStringLength is required');
  }
  return store as any;
}

function validateComposition(composition: unknown) {
  if (typeof composition !== 'object' || composition === null) {
    throw new TypeError('composition must be a DSL 4 Structured Data composition');
  }
  const candidate = composition as Record<string, unknown>;
  for (const method of [
    'debugNormalizedPath',
    'iteratorCurrentKind',
    'iteratorCurrentReference',
    'iteratorCurrentScalar',
    'iteratorNext',
    'newCollectionIterator',
    'newQueryIterator',
    'queryCollection',
    'queryKind',
    'queryReference',
    'queryScalar',
    'releaseCollection',
    'releaseIterator',
  ]) {
    if (typeof candidate[method] !== 'function') {
      throw new TypeError(`composition.${method} is required`);
    }
  }
  return composition as any;
}

function safeText(value: unknown) {
  return String(value ?? '').slice(0, safeDiagnosticLength);
}

/**
 * Create one Standalone adapter realm. The adapter owns the supplied Object Store realm.
 *
 */
export function createDsl4StructuredDataAdapter(
  options: {
    store?: object;
    composition?: object;
    objectStoreOptions?: object;
    compositionOptions?: object;
    nonceSource?: (byteLength: number) => Uint8Array;
    limits?: Partial<typeof dsl4StructuredDataAdapterDefaultLimits>;
  } = {},
) {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('adapter options must be an object');
  }
  const limits = normalizeLimits(options.limits);
  const nonceSource = options.nonceSource ?? defaultNonceSource;
  if (typeof nonceSource !== 'function') throw new TypeError('nonceSource must be a function');
  const store = validateStore(
    options.store ?? createDsl4ObjectStore(options.objectStoreOptions as any),
  );
  const composition = validateComposition(
    options.composition ??
      createDsl4StructuredDataComposition({
        store,
        ...((options.compositionOptions ?? {}) as any),
      }),
  );
  const realmNonce = createNonce(nonceSource);
  const reservedToken = `@sdx1.${realmNonce}.${createNonce(nonceSource)}`;
  const active = new Map();
  const tombstones = new Map();
  let state = 'active';

  const defaultScopeResult = store.createScope(store.rootScopeRef, 'structured-data.default');
  if (!defaultScopeResult.ok) {
    throw new TypeError(
      `Structured Data default scope could not be created: ${defaultScopeResult.error.code}`,
    );
  }
  const defaultScopeRef = defaultScopeResult.value;
  const reservedRecord = Object.freeze({
    code: 'SD-ADAPTER-EXCEPTION-LIMIT',
    operation: 'exception',
    message: 'The active ExceptionRef limit was exceeded',
    state: 'active',
    owner: 'adapter-realm',
  });

  function addTombstone(token: string, terminalState: 'released' | 'expired') {
    tombstones.set(token, Object.freeze({state: terminalState}));
    while (tombstones.size > limits.maxExceptionTombstones) {
      tombstones.delete(tombstones.keys().next().value);
    }
  }

  function allocateException(record: Readonly<{code: string; operation: string; message: string}>) {
    if (active.size >= limits.maxActiveExceptions) return reservedToken;
    try {
      for (let attempt = 0; attempt < limits.maxNonceAttempts; attempt += 1) {
        const token = `@sdx1.${realmNonce}.${createNonce(nonceSource)}`;
        if (token === reservedToken || active.has(token) || tombstones.has(token)) continue;
        active.set(token, record);
        return token;
      }
    } catch {
      return reservedToken;
    }
    return reservedToken;
  }

  function exception(code: string, operation: string, message: string) {
    return allocateException(
      Object.freeze({
        code: safeText(code),
        operation: safeText(operation),
        message: safeText(message),
        state: 'active',
        owner: 'adapter-realm',
      }),
    );
  }

  function project(result: any, operation: string, project: (value: any) => unknown) {
    if (!result?.ok) {
      return exception(
        result?.error?.code ?? 'STORE-BACKEND-FAILURE',
        operation,
        result?.error?.message ?? 'The Structured Data operation failed',
      );
    }
    try {
      return project(result.value);
    } catch {
      return exception('STORE-BACKEND-FAILURE', operation, 'The result projection failed');
    }
  }

  function isException(value: unknown) {
    return (
      state === 'active' &&
      typeof value === 'string' &&
      (value === reservedToken || active.has(value) || tombstones.has(value))
    );
  }

  function exceptionField(value: unknown, field: 'code' | 'operation' | 'message') {
    if (state !== 'active' || typeof value !== 'string') return '';
    if (value === reservedToken) return reservedRecord[field];
    const record = active.get(value);
    if (record) return record[field];
    if (tombstones.has(value)) {
      return exception(
        'SD-EXCEPTION-EXPIRED',
        exceptionReporterOperations[field],
        'The ExceptionRef expired',
      );
    }
    return '';
  }

  function releaseException(value: unknown) {
    if (state !== 'active' || typeof value !== 'string') return true;
    if (value === reservedToken) return true;
    if (active.has(value)) {
      active.delete(value);
      addTombstone(value, 'released');
      return true;
    }
    if (tombstones.has(value)) {
      return exception('SD-EXCEPTION-EXPIRED', 'releaseException', 'The ExceptionRef expired');
    }
    return true;
  }

  function expireExceptions() {
    if (state !== 'active') return true;
    for (const token of active.keys()) addTombstone(token, 'expired');
    active.clear();
    return true;
  }

  function defaultScope() {
    return state === 'active' ? defaultScopeRef : '';
  }

  function createScope(parentScope: unknown, label: unknown) {
    return project(store.createScope(parentScope, label), 'createScope', (value) => value);
  }

  function newEntryFromJson(json: unknown, typeTag: unknown, ownerScope: unknown) {
    const operation = 'newEntryFromJson';
    if (typeof json !== 'string') {
      return exception('STORE-VALUE-INVALID', operation, 'The JSON text must be a string');
    }
    if (json.length > store.limits.maxStringLength) {
      return exception('STORE-LIMIT-EXCEEDED', operation, 'The JSON text limit was exceeded');
    }
    let value;
    try {
      value = JSON.parse(json);
    } catch {
      return exception('STORE-VALUE-INVALID', operation, 'The JSON text is invalid');
    }
    return project(store.newEntry(value, typeTag, ownerScope), operation, (created) => created);
  }

  function duplicateReference(reference: unknown, ownerScope: unknown) {
    return project(
      store.duplicateReference(reference, ownerScope),
      'duplicateReference',
      (value) => value,
    );
  }

  function queryKind(source: unknown, path: unknown) {
    return project(composition.queryKind(source, path), 'queryKind', (value) => value.kind);
  }

  function queryScalar(source: unknown, path: unknown) {
    return project(composition.queryScalar(source, path), 'queryScalar', (value) =>
      value.value === null ? '' : value.value,
    );
  }

  function queryReference(source: unknown, path: unknown, ownerScope: unknown) {
    return project(
      composition.queryReference(source, path, ownerScope),
      'queryReference',
      (value) => value.reference,
    );
  }

  function queryCollection(source: unknown, path: unknown, ownerScope: unknown) {
    return project(
      composition.queryCollection(source, path, ownerScope),
      'queryCollection',
      (value) => value.collection,
    );
  }

  function newQueryIterator(source: unknown, path: unknown, ownerScope: unknown) {
    return project(
      composition.newQueryIterator(source, path, ownerScope),
      'newQueryIterator',
      (value) => value.iterator,
    );
  }

  function newCollectionIterator(collection: unknown, ownerScope: unknown) {
    return project(
      composition.newCollectionIterator(collection, ownerScope),
      'newCollectionIterator',
      (value) => value.iterator,
    );
  }

  function iteratorNext(iterator: unknown) {
    return project(composition.iteratorNext(iterator), 'iteratorNext', (value) => value.status);
  }

  function iteratorCurrentKind(iterator: unknown) {
    return project(
      composition.iteratorCurrentKind(iterator),
      'iteratorCurrentKind',
      (value) => value.kind,
    );
  }

  function iteratorCurrentScalar(iterator: unknown) {
    return project(composition.iteratorCurrentScalar(iterator), 'iteratorCurrentScalar', (value) =>
      value.value === null ? '' : value.value,
    );
  }

  function iteratorCurrentReference(iterator: unknown, ownerScope: unknown) {
    return project(
      composition.iteratorCurrentReference(iterator, ownerScope),
      'iteratorCurrentReference',
      (value) => value.reference,
    );
  }

  function releaseReference(reference: unknown) {
    return project(store.releaseReference(reference), 'releaseReference', () => true);
  }

  function releaseCollection(collection: unknown) {
    return project(composition.releaseCollection(collection), 'releaseCollection', () => true);
  }

  function releaseIterator(iterator: unknown) {
    return project(composition.releaseIterator(iterator), 'releaseIterator', () => true);
  }

  function freeEntry(owner: unknown) {
    return project(store.free(owner), 'freeEntry', () => true);
  }

  function releaseScope(scope: unknown) {
    if (scope === defaultScopeRef) {
      return exception('SD-SCOPE-PROTECTED', 'releaseScope', 'The default scope is protected');
    }
    return project(store.releaseScope(scope), 'releaseScope', () => true);
  }

  function isReference(value: unknown) {
    const classified = store.classifyHandle(value);
    return classified.ok;
  }

  function debugSnapshot() {
    return store.debugSnapshot();
  }

  function debugAssertInvariants() {
    const snapshot = store.debugSnapshot();
    return snapshot.nodes.every((node: any) => node.incomingCount === node.computedIncomingCount)
      ? true
      : exception('STORE-REFERENCE-UNDERFLOW', 'debugAssertInvariants', 'A Store invariant failed');
  }

  function debugHandleKind(value: unknown) {
    return project(store.classifyHandle(value), 'debugHandleKind', (classified) => {
      if (classified.typeTag === collectionTypeTag) return 'collection';
      if (classified.typeTag === iteratorTypeTag) return 'iterator';
      return classified.kind;
    });
  }

  function debugNormalizedPath(resource: unknown, index: unknown) {
    return project(
      composition.debugNormalizedPath(resource, index),
      'debugNormalizedPath',
      (value) => value.normalizedPath,
    );
  }

  function debugLimits() {
    return Object.freeze({
      adapter: limits,
      objectStore: store.limits,
      structuredData: composition.limits,
      jsonPath: composition.jsonPathLimits,
    });
  }

  function dispose() {
    if (state === 'disposed') return true;
    const disposed = store.disposeRealm();
    if (!disposed.ok) {
      return exception(disposed.error.code, 'dispose', disposed.error.message);
    }
    state = 'disposed';
    active.clear();
    tombstones.clear();
    return true;
  }

  return Object.freeze({
    limits,
    defaultScope,
    createScope,
    newEntryFromJson,
    duplicateReference,
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
    releaseReference,
    releaseCollection,
    releaseIterator,
    freeEntry,
    releaseScope,
    isReference,
    isException,
    exceptionCode: (value: unknown) => exceptionField(value, 'code'),
    exceptionOperation: (value: unknown) => exceptionField(value, 'operation'),
    exceptionMessage: (value: unknown) => exceptionField(value, 'message'),
    releaseException,
    expireExceptions,
    debugSnapshot,
    debugAssertInvariants,
    debugHandleKind,
    debugNormalizedPath,
    debugLimits,
    dispose,
  });
}
