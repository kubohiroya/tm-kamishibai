import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import {chromium, type Browser} from 'playwright-core';
import {test} from 'vitest';
import {withDeadline} from '../helpers/async-test-helpers.ts';

// Bundle the installed npm export without a local-source alias.
test('native IDB deletion failure retries without losing other sessions', async () => {
  const source = fileURLToPath(
    import.meta.resolve('@kubohiroya/turbowarp-kvs/session-binary-backing'),
  );
  const bundled = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {entry: source, formats: ['es'], fileName: 'backing'},
    },
  });
  const bundle = Array.isArray(bundled) ? bundled[0]! : bundled;
  if (!('output' in bundle) || bundle.output[0]?.type !== 'chunk')
    throw new Error('KVS module build failed');
  const code = bundle.output[0].code;
  const server = createServer((request, response) => {
    if (request.url === '/backing.js')
      response.writeHead(200, {'content-type': 'text/javascript'}).end(code);
    else
      response
        .writeHead(200, {'content-type': 'text/html'})
        .end('<!doctype html><title>KVS cleanup contract</title>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      executablePath:
        process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
    });
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const address = server.address();
    assert(address && typeof address !== 'string');
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.addScriptTag({
      type: 'module',
      content: "globalThis.__retryKvs = await import('/backing.js');",
    });
    await page.waitForFunction(() => Reflect.has(globalThis, '__retryKvs'));
    const results = await withDeadline(
      page.evaluate(async () => {
        const {createSessionBinaryBacking} = Reflect.get(globalThis, '__retryKvs');
        const outcomes = [];
        for (const closeConnection of [false, true]) {
          const name = 'native-session-cleanup-retry-' + closeConnection;
          const bytes = new Uint8Array([3, 2, 1]);
          const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
          const integrity =
            'sha256-' + [...hash].map((n) => n.toString(16).padStart(2, '0')).join('');
          const asset = {
            namespace: 'story',
            name: 'video',
            integrity,
            files: [{path: 'file.bin', size: 3, integrity}],
          };
          let releases = 0;
          const create = (sessionId: string) =>
            createSessionBinaryBacking(
              {
                policy: 'required',
                sessionId,
                assets: [asset],
                source: {
                  read: async () => ({...asset, files: [{...asset.files[0], bytes}]}),
                  release() {
                    releases++;
                  },
                },
              },
              {indexedDB, databaseName: name, heartbeatIntervalMs: 60000},
            );
          const counts = async () => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const request = indexedDB.open(name);
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            try {
              return await Promise.all(
                ['sessions', 'sessionBinaryBundles'].map(
                  (store) =>
                    new Promise<number>((resolve, reject) => {
                      const tx = db.transaction(store);
                      const count = tx.objectStore(store).count();
                      tx.oncomplete = () => resolve(count.result);
                      tx.onabort = () => reject(tx.error);
                    }),
                ),
              );
            } finally {
              db.close();
            }
          };
          const first = await create('first'),
            second = await create('second');
          const held = await first.get(asset);
          const before = await counts();
          const transaction = IDBDatabase.prototype.transaction;
          let fail = true;
          IDBDatabase.prototype.transaction = function (...args) {
            const tx = transaction.apply(this, args);
            if (
              fail &&
              this.name === name &&
              args[1] === 'readwrite' &&
              tx.objectStoreNames.contains('sessionBinaryBundles')
            ) {
              fail = false;
              queueMicrotask(() => {
                tx.abort();
                if (closeConnection) this.close();
              });
            }
            return tx;
          };
          try {
            let failureCode: unknown;
            const pending = first.dispose();
            if (pending !== first.dispose()) throw new Error('concurrent disposal did not join');
            try {
              await pending;
            } catch (error) {
              failureCode = Reflect.get(error as object, 'code');
            }
            if (failureCode !== 'KVS_SESSION_BINARY_CLEANUP_FAILED')
              throw new Error('missing cleanup failure');
            const afterFailure = await counts();
            let readClosed = false;
            try {
              await first.get(asset);
            } catch (error) {
              readClosed = Reflect.get(error as object, 'code') === 'KVS_SESSION_BINARY_RELEASED';
            }
            if (!readClosed) throw new Error('failed cleanup reopened reads');
            await first.dispose();
            const afterRetry = await counts();
            const other = await second.get(asset);
            if (
              other.files[0].bytes.join() !== bytes.join() ||
              held.files[0].bytes.join() !== bytes.join()
            )
              throw new Error('other session or caller copy lost');
            await second.dispose();
            const final = await counts();
            if (
              before.join() !== '2,2' ||
              afterFailure.join() !== '2,2' ||
              afterRetry.join() !== '1,1' ||
              final.join() !== '0,0' ||
              releases !== 2
            )
              throw new Error('unexpected owner/record counts');
            outcomes.push({
              closeConnection,
              before,
              afterFailure,
              afterRetry,
              final,
              releases,
              readClosed,
              heldCopyPreserved: true,
            });
          } finally {
            IDBDatabase.prototype.transaction = transaction;
            await first.dispose();
            await second.dispose();
          }
        }
        return outcomes;
      }),
      'native IndexedDB cleanup retry',
      15000,
    );
    assert.equal(results.length, 2);
    assert.deepEqual(pageErrors, []);
    const report = {browser: await browser.version(), headless: true, results};
    await mkdir('tmp/session-cleanup-browser', {recursive: true});
    await writeFile(
      'tmp/session-cleanup-browser/result.json',
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log(JSON.stringify(report));
  } finally {
    try {
      await browser?.close();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
});
