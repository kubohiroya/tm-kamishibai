import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import test from 'node:test';

import {createVerifiedRemoteBinaryCache} from '@kubohiroya/turbowarp-asset-manager/composition';
import {IDBFactory} from 'fake-indexeddb';

const bytes = new TextEncoder().encode('<svg id="verified-cache"/>');
const input = Object.freeze({
  url: 'https://cdn.example.com/verified-cache.svg',
  integrity: `sha256-${createHash('sha256').update(bytes).digest('hex')}`,
  contentType: 'image/svg+xml',
  size: bytes.byteLength,
});

function identity(id) {
  return Object.freeze({
    id,
    label: 'story.kamishibai.yaml',
    databaseName: `tw-kamishibai-assets-v1--story--${id}`,
  });
}

function cache(indexedDB, id, extra = {}) {
  return createVerifiedRemoteBinaryCache({
    indexedDB,
    subtleCrypto: webcrypto.subtle,
    cacheIdentity: identity(id),
    estimateStorage: async () => ({quota: 64 * 1024 * 1024, usage: 0}),
    ...extra,
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => {};
  });
}

async function tamperFirstEntry(indexedDB, databaseName) {
  const database = await requestResult(indexedDB.open(databaseName));
  try {
    const transaction = database.transaction('entries', 'readwrite');
    const store = transaction.objectStore('entries');
    const cursor = await requestResult(store.openCursor());
    assert.ok(cursor);
    store.put({...cursor.value, data: new Uint8Array(bytes.byteLength).buffer});
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

function quotaOnceFactory(indexedDB) {
  let remainingFailures = 1;
  let entryPutCalls = 0;

  function property(target, key) {
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }

  function wrapStore(store, name) {
    return new Proxy(store, {
      get(target, key) {
        if (key !== 'put' || name !== 'entries') return property(target, key);
        return (value) => {
          entryPutCalls += 1;
          if (remainingFailures > 0) {
            remainingFailures -= 1;
            throw new DOMException('simulated quota exhaustion', 'QuotaExceededError');
          }
          return target.put(value);
        };
      },
    });
  }

  function wrapTransaction(transaction) {
    return new Proxy(transaction, {
      get(target, key) {
        if (key !== 'objectStore') return property(target, key);
        return (name) => wrapStore(target.objectStore(name), name);
      },
      set(target, key, value) {
        return Reflect.set(target, key, value, target);
      },
    });
  }

  function wrapDatabase(database) {
    return new Proxy(database, {
      get(target, key) {
        if (key !== 'transaction') return property(target, key);
        return (...args) => wrapTransaction(target.transaction(...args));
      },
    });
  }

  function wrapRequest(request) {
    return new Proxy(request, {
      get(target, key) {
        if (key === 'result') return wrapDatabase(Reflect.get(target, key, target));
        return property(target, key);
      },
      set(target, key, value) {
        return Reflect.set(target, key, value, target);
      },
    });
  }

  return {
    indexedDB: {
      open: (...args) => wrapRequest(indexedDB.open(...args)),
      deleteDatabase: (...args) => indexedDB.deleteDatabase(...args),
      cmp: (...args) => indexedDB.cmp(...args),
    },
    getEntryPutCalls: () => entryPutCalls,
  };
}

test('covers miss, hit, offline fallback, tamper recovery, and explicit cleanup', async () => {
  const indexedDB = new IDBFactory();
  const verifiedCache = cache(indexedDB, 'cacheflow0000001');
  let networkLoads = 0;
  const load = async () => {
    networkLoads += 1;
    return {bytes: Uint8Array.from(bytes), contentType: 'image/svg+xml'};
  };

  const miss = await verifiedCache.resolve(input, {load});
  assert.equal(miss.source, 'network');
  assert.equal(miss.cacheRead, 'miss');
  assert.equal(miss.cacheWrite, 'stored');
  assert.equal(networkLoads, 1);

  const hit = await verifiedCache.resolve(input, {
    load: async () => assert.fail('valid cached bytes must run offline'),
  });
  assert.equal(hit.source, 'indexeddb');
  assert.equal(hit.cacheRead, 'hit');
  assert.equal(networkLoads, 1);

  await tamperFirstEntry(indexedDB, identity('cacheflow0000001').databaseName);
  const recovered = await verifiedCache.resolve(input, {load});
  assert.equal(recovered.source, 'network');
  assert.equal(recovered.cacheRead, 'invalid');
  assert.equal(recovered.cacheWrite, 'stored');
  assert.equal(networkLoads, 2);
  assert.deepEqual(
    await verifiedCache.getStats().then(({entries, bytes: storedBytes}) => ({
      entries,
      bytes: storedBytes,
    })),
    {entries: 1, bytes: bytes.byteLength},
  );

  const cleared = await verifiedCache.clear();
  assert.equal(cleared.removedEntries, 1);
  assert.equal(cleared.remainingEntries, 0);
  assert.deepEqual(
    await verifiedCache.getStats().then(({entries, bytes: storedBytes}) => ({
      entries,
      bytes: storedBytes,
    })),
    {entries: 0, bytes: 0},
  );
  await verifiedCache.releaseStoryCacheLease();
});

test('retries once after QuotaExceeded and commits one bounded entry', async () => {
  const base = new IDBFactory();
  const quota = quotaOnceFactory(base);
  const verifiedCache = cache(quota.indexedDB, 'quotaflow0000001');
  const result = await verifiedCache.resolve(input, {
    load: async () => ({bytes: Uint8Array.from(bytes), contentType: 'image/svg+xml'}),
  });
  assert.equal(result.source, 'network');
  assert.equal(result.cacheWrite, 'stored');
  assert.equal(quota.getEntryPutCalls(), 2);
  const stats = await verifiedCache.getStats();
  assert.equal(stats.entries, 1);
  assert.equal(stats.bytes, bytes.byteLength);
  await verifiedCache.releaseStoryCacheLease();
});

test('Abort after loading prevents a stale cache commit', async () => {
  const indexedDB = new IDBFactory();
  const verifiedCache = cache(indexedDB, 'abortflow0000001');
  const controller = new AbortController();
  let finishLoad;
  const resolution = verifiedCache.resolve(input, {
    signal: controller.signal,
    load: () =>
      new Promise((resolve) => {
        finishLoad = () => resolve({bytes: Uint8Array.from(bytes), contentType: 'image/svg+xml'});
      }),
  });
  while (finishLoad === undefined) await new Promise((resolve) => setImmediate(resolve));
  controller.abort('scene-superseded');
  finishLoad();
  await assert.rejects(resolution, (error) => error.name === 'AbortError');
  const stats = await verifiedCache.getStats();
  assert.equal(stats.entries, 0);
  assert.equal(stats.bytes, 0);
  await verifiedCache.releaseStoryCacheLease();
});
