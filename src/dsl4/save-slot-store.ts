import {decodeDsl4SaveData, Dsl4SaveDataError, type Dsl4SaveDataV1} from './save-data.js';

/** Saves have their own database, store and ownership, independent of verified asset cache eviction. */
export function createDsl4SaveSlotStore({
  indexedDB = globalThis.indexedDB,
  databaseName = 'kamishibai-save-data-v1',
  maxSlots = 32,
}: {
  indexedDB?: IDBFactory;
  databaseName?: string;
  maxSlots?: number;
} = {}) {
  if (!indexedDB || typeof indexedDB.open !== 'function')
    throw new TypeError('IndexedDB is required for save slots');
  if (!databaseName || !Number.isSafeInteger(maxSlots) || maxSlots < 1 || maxSlots > 1024)
    throw new TypeError('Invalid save store configuration');
  let database: IDBDatabase | null = null;
  let opening: Promise<IDBDatabase> | null = null;
  let closing: Promise<void> | null = null;
  let closed = false;
  const operations = new Set<Promise<unknown>>();
  function active() {
    if (closed) throw new Dsl4SaveDataError('K4-SAVE-DISPOSED', 'Save slot store is closed');
  }
  function open() {
    active();
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    opening = Promise.resolve().then(
      () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(databaseName, 1);
          request.onupgradeneeded = () => {
            const store = request.result.createObjectStore('saveSlots', {keyPath: 'key'});
            store.createIndex('storyId', 'storyId');
          };
          request.onerror = () => reject(request.error ?? new Error('Save database open failed'));
          request.onsuccess = () => {
            const connection = request.result;
            database = connection;
            connection.onversionchange = () => {
              closed = true;
              // A failed close keeps the connection reachable for explicit dispose.
              try {
                connection.close();
                if (database === connection) database = null;
              } catch {
                /* Explicit dispose reports a persistent failure. */
              }
            };
            resolve(connection);
          };
        }),
    );
    const done = () => {
      opening = null;
    };
    void opening.then(done, done);
    return opening;
  }
  function identity(storyId: string, slot: string) {
    if (
      typeof storyId !== 'string' ||
      !storyId ||
      storyId.length > 256 ||
      typeof slot !== 'string' ||
      !slot ||
      slot.length > 128 ||
      storyId.includes('\0') ||
      slot.includes('\0')
    )
      throw new TypeError('Invalid story/slot ID');
    return JSON.stringify([storyId, slot]);
  }
  function operation<T>(task: () => Promise<T>): Promise<T> {
    active();
    const pending = Promise.resolve().then(task);
    operations.add(pending);
    const done = () => operations.delete(pending);
    void pending.then(done, done);
    return pending;
  }
  async function transaction<T>(
    mode: IDBTransactionMode,
    run: (
      store: IDBObjectStore,
      result: (value: T) => void,
      fail: (error: unknown) => void,
    ) => void,
  ): Promise<T> {
    const db = await open();
    active();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('saveSlots', mode);
      let value: T, failure: unknown;
      tx.oncomplete = () => {
        try {
          active();
          resolve(value);
        } catch (error) {
          reject(error);
        }
      };
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Save transaction aborted'));
      tx.onerror = () => {
        failure ??= tx.error;
      };
      const fail = (error: unknown) => {
        failure = error;
        try {
          tx.abort();
        } catch {
          reject(error);
        }
      };
      try {
        run(
          tx.objectStore('saveSlots'),
          (next) => {
            value = next;
          },
          fail,
        );
      } catch (error) {
        fail(error);
      }
    });
  }
  return Object.freeze({
    put(slot: string, input: unknown) {
      const save = decodeDsl4SaveData(input),
        key = identity(save.storyId, slot);
      return operation(() =>
        transaction<void>('readwrite', (store, result, fail) => {
          const existing = store.get(key);
          existing.onsuccess = () => {
            const count = store.index('storyId').count(save.storyId);
            count.onsuccess = () => {
              if (!existing.result && count.result >= maxSlots) {
                fail(new Dsl4SaveDataError('K4-SAVE-SLOT-LIMIT', 'Save slot limit exceeded'));
                return;
              }
              try {
                store.put({key, storyId: save.storyId, slot, json: JSON.stringify(save)});
                result(undefined);
              } catch (error) {
                fail(error);
              }
            };
          };
        }),
      );
    },
    get(storyId: string, slot: string) {
      const key = identity(storyId, slot);
      return operation(() =>
        transaction<Readonly<Dsl4SaveDataV1> | null>('readonly', (store, result, fail) => {
          const request = store.get(key);
          request.onsuccess = () => {
            try {
              if (request.result === undefined) {
                result(null);
                return;
              }
              const save = decodeDsl4SaveData(JSON.parse(request.result.json));
              if (save.storyId !== storyId)
                throw new Dsl4SaveDataError('K4-SAVE-INCOMPATIBLE', 'Save slot identity mismatch');
              result(save);
            } catch (error) {
              fail(error);
            }
          };
        }),
      );
    },
    delete(storyId: string, slot: string) {
      const key = identity(storyId, slot);
      return operation(() =>
        transaction<void>('readwrite', (store, result) => {
          store.delete(key);
          result(undefined);
        }),
      );
    },
    hasPendingCleanup: () => database !== null || opening !== null || operations.size > 0,
    dispose() {
      if (closing) return closing;
      closed = true;
      const pending = Promise.resolve().then(async () => {
        await Promise.allSettled([...operations]);
        if (opening) await opening.catch(() => {});
        if (database) {
          database.close();
          database = null;
        }
      });
      closing = pending;
      const done = () => {
        closing = null;
      };
      void pending.then(done, done);
      return pending;
    },
  });
}
