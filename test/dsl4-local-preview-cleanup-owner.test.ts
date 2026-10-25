import assert from 'node:assert/strict';
import {test, vi} from 'vitest';
import {createDsl4PreviewSourceWatcher} from '../src/builder/dsl4-preview-watch.js';
import {createDsl4PreviewTransportPolicy} from '../src/builder/dsl4-preview-transport-policy.js';
import {createDsl4LocalPreviewBrowserClient} from '../src/builder/dsl4-local-preview-browser-client.js';
import {dsl4TestSourceFrontend} from './helpers/dsl4-test-frontend.ts';
import {deferred, withDeadline} from './helpers/async-test-helpers.ts';

const manifest = {formatVersion: 1, mode: 'external', sourceId: 'main', path: 'story.k4.yml'};
const source = "kamishibai: '4.0'\nscenes:\n  opening: []\n";
function watcherOptions() {
  return {
    projectRoot: '/project',
    manifest,
    sourceFrontend: dsl4TestSourceFrontend,
    maxSourceBytes: 4096,
    featureFlags: {dsl4SourceIncludes: false},
    loadSource: async () => ({descriptor: {sourceId: 'main', text: source, integrity: 'same'}}),
    onResult() {},
  };
}
for (const asynchronous of [false, true]) {
  test(`node watcher retains ${asynchronous ? 'async' : 'sync'} close failure independently from its timer`, async () => {
    let broken = true,
      tick = () => {},
      nested: unknown;
    const close = vi.fn(() => {
      nested = watcher.dispose();
      if (broken) {
        if (asynchronous) return Promise.reject(new Error('watch close failed'));
        throw new Error('watch close failed');
      }
    });
    const clear = vi.fn();
    const watcher = createDsl4PreviewSourceWatcher({
      ...watcherOptions(),
      quietWindowMs: 0,
      clock: {
        now: () => 0,
        sleep: async () => {},
        setTimeout(callback) {
          tick = callback;
          return 1;
        },
        clearTimeout: clear,
      },
      watchFactory: () => ({close, on() {}}),
    });
    await watcher.start();
    watcher.notifyChange();
    const attempt = watcher.dispose();
    assert.strictEqual(watcher.dispose(), attempt);
    await assert.rejects(attempt, AggregateError);
    assert.strictEqual(nested, attempt);
    assert.equal(close.mock.calls.length, 1);
    assert.equal(clear.mock.calls.length, 1);
    tick();
    assert.throws(() => watcher.notifyChange(), /not active/);
    broken = false;
    await watcher.dispose();
    assert.equal(close.mock.calls.length, 2);
    assert.equal(clear.mock.calls.length, 1);
    assert.equal(watcher.hasPendingCleanup(), false);
  });
}
test('node watcher closes result notification waits without accepting a late publication', async () => {
  const finished = deferred();
  const watcher = createDsl4PreviewSourceWatcher({
    ...watcherOptions(),
    quietWindowMs: 0,
    watchFactory: () => ({close() {}, on() {}}),
    async onResult() {
      await watcher.dispose();
      finished.resolve();
    },
  });
  await withDeadline(watcher.start(), 'watch observer start', 2000);
  await withDeadline(finished.promise, 'watch observer close', 2000);
  assert.equal(watcher.getState().published, 0);
  assert.equal(watcher.hasPendingCleanup(), false);
});
test('node watcher retries a failed timer without repeating a successful watch close', async () => {
  let broken = true,
    tick = () => {};
  const clear = vi.fn(() => {
    if (broken) throw new Error('timer stop failed');
  });
  const close = vi.fn();
  const watcher = createDsl4PreviewSourceWatcher({
    ...watcherOptions(),
    quietWindowMs: 0,
    clock: {
      now: () => 0,
      sleep: async () => {},
      setTimeout(callback) {
        tick = callback;
        return 1;
      },
      clearTimeout: clear,
    },
    watchFactory: () => ({close, on() {}}),
  });
  await watcher.start();
  watcher.notifyChange();
  await assert.rejects(watcher.dispose(), AggregateError);
  tick();
  assert.equal(close.mock.calls.length, 1);
  assert.equal(clear.mock.calls.length, 1);
  broken = false;
  await watcher.dispose();
  assert.equal(close.mock.calls.length, 1);
  assert.equal(clear.mock.calls.length, 2);
  assert.equal(watcher.hasPendingCleanup(), false);
});
test('transport retains an in-flight failed disconnect and joins parent disposal until explicit retry', async () => {
  let broken = true,
    nested: unknown;
  const entered = deferred(),
    gate = deferred();
  const disconnect = vi.fn(async () => {
    nested = policy.dispose();
    entered.resolve();
    await gate.promise;
    if (broken) throw new Error('disconnect failed');
  });
  const policy = createDsl4PreviewTransportPolicy({
    bindHost: '127.0.0.1',
    port: 4173,
    origin: 'http://127.0.0.1:4173',
    projectRoot: '/project',
    sourceManifest: manifest,
    tokenTtlMs: 1000,
    maxTokenRecords: 4,
    onDisconnect: disconnect,
  });
  const token = policy.issueToken().token;
  const connection = policy.connect({
    origin: 'http://127.0.0.1:4173',
    remoteAddress: '127.0.0.1',
    token,
  });
  const closing = connection.disconnect('host-crash');
  const rejected = assert.rejects(closing);
  await entered.promise;
  const attempt = policy.dispose();
  assert.strictEqual(nested, attempt);
  const rejectedDispose = assert.rejects(attempt);
  gate.resolve();
  await Promise.all([rejected, rejectedDispose]);
  assert.equal(disconnect.mock.calls.length, 1);
  assert.equal(policy.hasPendingCleanup(), true);
  assert.throws(() => policy.issueToken(), /disposed/);
  assert.throws(() => connection.authorizeSourceRead(manifest.path), /disconnected/);
  broken = false;
  await policy.dispose();
  assert.equal(disconnect.mock.calls.length, 2);
  assert.equal(policy.hasPendingCleanup(), false);
});

function clientFixture() {
  let broken = true;
  const read = deferred<{done: boolean; value?: string}>();
  const reader = {
    read: () => read.promise,
    cancel: vi.fn(async () => {
      if (broken) throw new Error('reader cancellation failed');
      read.resolve({done: true});
    }),
    releaseLock: vi.fn(),
  };
  const listeners = new Map<string, () => unknown>();
  const remove = vi.fn((type: string) => {
    if (broken) throw new Error('listener removal failed');
    listeners.delete(type);
  });
  const runtime = {
    start: async () => {},
    dispose: vi.fn(async () => {
      if (broken) throw new Error('runtime cleanup failed');
    }),
    getState: () => ({}),
  };
  const shell = {
    setReloadWatchState: async () => {},
    getSnapshot: () => ({}),
    dispose: vi.fn(async () => {}),
  };
  const client = createDsl4LocalPreviewBrowserClient({
    document: {querySelector: () => ({appendChild() {}})},
    location: {hash: `#${'a'.repeat(43)}`},
    history: {replaceState() {}},
    eventTarget: {
      addEventListener(type: string, handler: () => unknown) {
        listeners.set(type, handler);
      },
      removeEventListener: remove,
    },
    sourceFrontend: {parse() {}},
    platform: {},
    runtimeOptions: {},
    createRuntime: () => runtime,
    createShell: () => shell,
    fetch: async (url: string) => {
      if (url === '/api/events')
        return {
          ok: true,
          headers: new Headers({'content-type': 'application/x-ndjson'}),
          body: {pipeThrough: () => ({getReader: () => reader})},
        };
      if (url === '/api/runtime-project')
        return new Response(new Uint8Array([1, 2]), {headers: {'content-length': '2'}});
      return Response.json({events: []});
    },
  });
  return {
    client,
    reader,
    runtime,
    shell,
    remove,
    listeners,
    repair: () => {
      broken = false;
    },
  };
}
test('browser client retains failed reader, listener and runtime owners while releasing the shell', async () => {
  const {client, reader, runtime, shell, remove, listeners, repair} = clientFixture();
  await client.start();
  const latePageHide = listeners.get('pagehide')!;
  const attempt = client.dispose();
  assert.strictEqual(client.dispose(), attempt);
  await assert.rejects(withDeadline(attempt, 'client failed close', 2000), AggregateError);
  assert.equal(reader.cancel.mock.calls.length, 1);
  assert.equal(runtime.dispose.mock.calls.length, 1);
  assert.equal(shell.dispose.mock.calls.length, 1);
  assert.equal(client.hasPendingCleanup(), true);
  repair();
  await client.dispose();
  latePageHide();
  assert.equal(reader.cancel.mock.calls.length, 2);
  assert.equal(reader.releaseLock.mock.calls.length, 1);
  assert.equal(remove.mock.calls.length, 2);
  assert.equal(runtime.dispose.mock.calls.length, 2);
  assert.equal(shell.dispose.mock.calls.length, 1);
  assert.equal(client.hasPendingCleanup(), false);
});

test('browser client joins runtime cleanup that fails while startup is completing', async () => {
  const {client, runtime, shell, repair} = clientFixture();
  repair();
  const entered = deferred(),
    gate = deferred();
  runtime.start = async () => {
    entered.resolve();
    await gate.promise;
  };
  runtime.dispose.mockImplementation(async () => {
    gate.resolve();
    if (runtime.dispose.mock.calls.length === 1) throw new Error('startup runtime cleanup failed');
  });
  const starting = client.start();
  const rejectedStart = assert.rejects(starting, {name: 'AbortError'});
  await entered.promise;
  await assert.rejects(
    withDeadline(client.dispose(), 'startup client cleanup', 2000),
    AggregateError,
  );
  await rejectedStart;
  assert.equal(runtime.dispose.mock.calls.length, 1);
  assert.equal(shell.dispose.mock.calls.length, 1);
  await client.dispose();
  assert.equal(runtime.dispose.mock.calls.length, 2);
  assert.equal(shell.dispose.mock.calls.length, 1);
  assert.equal(client.hasPendingCleanup(), false);
});

test('browser client startup watch observer can await its own disposal', async () => {
  const {client, shell, repair} = clientFixture();
  repair();
  const finished = deferred();
  shell.setReloadWatchState = async () => {
    await client.dispose();
    finished.resolve();
  };
  await assert.rejects(withDeadline(client.start(), 'client observer startup', 2000), {
    name: 'AbortError',
  });
  await withDeadline(finished.promise, 'client observer disposal', 2000);
  assert.equal(client.hasPendingCleanup(), false);
});
