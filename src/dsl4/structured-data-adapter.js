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

/** @param {number} byteLength */
function defaultNonceSource(byteLength) {
  if (!globalThis.crypto?.getRandomValues)
    throw new TypeError('A cryptographic nonce source is required');
  return globalThis.crypto.getRandomValues(new Uint8Array(byteLength));
}

/** @param {Uint8Array} bytes */
function encodeBase64Url(bytes) {
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

/** @param {(byteLength: number) => Uint8Array} nonceSource */
function createNonce(nonceSource) {
  const bytes = nonceSource(16);
  if (!(bytes instanceof Uint8Array) || bytes.length < 16 || bytes.length > 64) {
    throw new TypeError('nonceSource must return between 16 and 64 bytes');
  }
  return encodeBase64Url(bytes);
}

/** @param {unknown} input */
function normalizeLimits(input) {
  if (input === undefined) return dsl4StructuredDataAdapterDefaultLimits;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('limits must be an object');
  }
  const candidate = /** @type {Record<string, unknown>} */ (input);
  if (
    Object.keys(candidate).some(
      (key) => !Object.hasOwn(dsl4StructuredDataAdapterDefaultLimits, key),
    )
  ) {
    throw new TypeError('limits contain an unknown field');
  }
  const normalized = {...dsl4StructuredDataAdapterDefaultLimits, ...candidate};
  const defaults = /** @type {Readonly<Record<string, number>>} */ (
    dsl4StructuredDataAdapterDefaultLimits
  );
  for (const [name, value] of Object.entries(normalized)) {
    const maximum = defaults[name];
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
      throw new TypeError(`${name} must be a positive safe integer within the default`);
    }
  }
  return Object.freeze(normalized);
}

/** @param {unknown} store */
function validateStore(store) {
  if (typeof store !== 'object' || store === null) {
    throw new TypeError('store must be a DSL 4 Object Store');
  }
  const candidate = /** @type {Record<string, unknown>} */ (store);
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
    !Number.isSafeInteger(/** @type {any} */ (candidate.limits).maxStringLength)
  ) {
    throw new TypeError('store.limits.maxStringLength is required');
  }
  return /** @type {any} */ (store);
}

/** @param {unknown} composition */
function validateComposition(composition) {
  if (typeof composition !== 'object' || composition === null) {
    throw new TypeError('composition must be a DSL 4 Structured Data composition');
  }
  const candidate = /** @type {Record<string, unknown>} */ (composition);
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
  return /** @type {any} */ (composition);
}

/** @param {unknown} value */
function safeText(value) {
  return String(value ?? '').slice(0, safeDiagnosticLength);
}

/**
 * Create one Standalone adapter realm. The adapter owns the supplied Object Store realm.
 *
 * @param {object} [options]
 * @param {object} [options.store]
 * @param {object} [options.composition]
 * @param {object} [options.objectStoreOptions]
 * @param {object} [options.compositionOptions]
 * @param {(byteLength: number) => Uint8Array} [options.nonceSource]
 * @param {Partial<typeof dsl4StructuredDataAdapterDefaultLimits>} [options.limits]
 */
export function createDsl4StructuredDataAdapter(options = {}) {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('adapter options must be an object');
  }
  const limits = normalizeLimits(options.limits);
  const nonceSource = options.nonceSource ?? defaultNonceSource;
  if (typeof nonceSource !== 'function') throw new TypeError('nonceSource must be a function');
  const store = validateStore(
    options.store ?? createDsl4ObjectStore(/** @type {any} */ (options.objectStoreOptions)),
  );
  const composition = validateComposition(
    options.composition ??
      createDsl4StructuredDataComposition({
        store,
        .../** @type {any} */ (options.compositionOptions ?? {}),
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

  /** @param {string} token @param {'released' | 'expired'} terminalState */
  function addTombstone(token, terminalState) {
    tombstones.set(token, Object.freeze({state: terminalState}));
    while (tombstones.size > limits.maxExceptionTombstones) {
      tombstones.delete(tombstones.keys().next().value);
    }
  }

  /** @param {Readonly<{code: string, operation: string, message: string}>} record */
  function allocateException(record) {
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

  /** @param {string} code @param {string} operation @param {string} message */
  function exception(code, operation, message) {
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

  /** @param {any} result @param {string} operation @param {(value: any) => unknown} project */
  function project(result, operation, project) {
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

  /** @param {unknown} value */
  function isException(value) {
    return (
      state === 'active' &&
      typeof value === 'string' &&
      (value === reservedToken || active.has(value) || tombstones.has(value))
    );
  }

  /** @param {unknown} value @param {'code' | 'operation' | 'message'} field */
  function exceptionField(value, field) {
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

  /** @param {unknown} value */
  function releaseException(value) {
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

  /** @param {unknown} parentScope @param {unknown} label */
  function createScope(parentScope, label) {
    return project(store.createScope(parentScope, label), 'createScope', (value) => value);
  }

  /** @param {unknown} json @param {unknown} typeTag @param {unknown} ownerScope */
  function newEntryFromJson(json, typeTag, ownerScope) {
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

  /** @param {unknown} reference @param {unknown} ownerScope */
  function duplicateReference(reference, ownerScope) {
    return project(
      store.duplicateReference(reference, ownerScope),
      'duplicateReference',
      (value) => value,
    );
  }

  /** @param {unknown} source @param {unknown} path */
  function queryKind(source, path) {
    return project(composition.queryKind(source, path), 'queryKind', (value) => value.kind);
  }

  /** @param {unknown} source @param {unknown} path */
  function queryScalar(source, path) {
    return project(composition.queryScalar(source, path), 'queryScalar', (value) =>
      value.value === null ? '' : value.value,
    );
  }

  /** @param {unknown} source @param {unknown} path @param {unknown} ownerScope */
  function queryReference(source, path, ownerScope) {
    return project(
      composition.queryReference(source, path, ownerScope),
      'queryReference',
      (value) => value.reference,
    );
  }

  /** @param {unknown} source @param {unknown} path @param {unknown} ownerScope */
  function queryCollection(source, path, ownerScope) {
    return project(
      composition.queryCollection(source, path, ownerScope),
      'queryCollection',
      (value) => value.collection,
    );
  }

  /** @param {unknown} source @param {unknown} path @param {unknown} ownerScope */
  function newQueryIterator(source, path, ownerScope) {
    return project(
      composition.newQueryIterator(source, path, ownerScope),
      'newQueryIterator',
      (value) => value.iterator,
    );
  }

  /** @param {unknown} collection @param {unknown} ownerScope */
  function newCollectionIterator(collection, ownerScope) {
    return project(
      composition.newCollectionIterator(collection, ownerScope),
      'newCollectionIterator',
      (value) => value.iterator,
    );
  }

  /** @param {unknown} iterator */
  function iteratorNext(iterator) {
    return project(composition.iteratorNext(iterator), 'iteratorNext', (value) => value.status);
  }

  /** @param {unknown} iterator */
  function iteratorCurrentKind(iterator) {
    return project(
      composition.iteratorCurrentKind(iterator),
      'iteratorCurrentKind',
      (value) => value.kind,
    );
  }

  /** @param {unknown} iterator */
  function iteratorCurrentScalar(iterator) {
    return project(composition.iteratorCurrentScalar(iterator), 'iteratorCurrentScalar', (value) =>
      value.value === null ? '' : value.value,
    );
  }

  /** @param {unknown} iterator @param {unknown} ownerScope */
  function iteratorCurrentReference(iterator, ownerScope) {
    return project(
      composition.iteratorCurrentReference(iterator, ownerScope),
      'iteratorCurrentReference',
      (value) => value.reference,
    );
  }

  /** @param {unknown} reference */
  function releaseReference(reference) {
    return project(store.releaseReference(reference), 'releaseReference', () => true);
  }

  /** @param {unknown} collection */
  function releaseCollection(collection) {
    return project(composition.releaseCollection(collection), 'releaseCollection', () => true);
  }

  /** @param {unknown} iterator */
  function releaseIterator(iterator) {
    return project(composition.releaseIterator(iterator), 'releaseIterator', () => true);
  }

  /** @param {unknown} owner */
  function freeEntry(owner) {
    return project(store.free(owner), 'freeEntry', () => true);
  }

  /** @param {unknown} scope */
  function releaseScope(scope) {
    if (scope === defaultScopeRef) {
      return exception('SD-SCOPE-PROTECTED', 'releaseScope', 'The default scope is protected');
    }
    return project(store.releaseScope(scope), 'releaseScope', () => true);
  }

  /** @param {unknown} value */
  function isReference(value) {
    const classified = store.classifyHandle(value);
    return classified.ok;
  }

  function debugSnapshot() {
    return store.debugSnapshot();
  }

  function debugAssertInvariants() {
    const snapshot = store.debugSnapshot();
    return snapshot.nodes.every(
      (/** @type {any} */ node) => node.incomingCount === node.computedIncomingCount,
    )
      ? true
      : exception('STORE-REFERENCE-UNDERFLOW', 'debugAssertInvariants', 'A Store invariant failed');
  }

  /** @param {unknown} value */
  function debugHandleKind(value) {
    return project(store.classifyHandle(value), 'debugHandleKind', (classified) => {
      if (classified.typeTag === collectionTypeTag) return 'collection';
      if (classified.typeTag === iteratorTypeTag) return 'iterator';
      return classified.kind;
    });
  }

  /** @param {unknown} resource @param {unknown} index */
  function debugNormalizedPath(resource, index) {
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
    exceptionCode: (/** @type {unknown} */ value) => exceptionField(value, 'code'),
    exceptionOperation: (/** @type {unknown} */ value) => exceptionField(value, 'operation'),
    exceptionMessage: (/** @type {unknown} */ value) => exceptionField(value, 'message'),
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
