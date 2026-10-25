import assert from 'node:assert/strict';
import {test, vi} from 'vitest';
import {deferred, flushMicrotasks, withDeadline} from './helpers/async-test-helpers.ts';
import {failedFactory} from './helpers/failed-factory.ts';
import {getDsl4CreationCleanup} from '../src/dsl4/creation-cleanup.js';

const state = vi.hoisted(() => ({
  broken: true,
  releases: 0,
  factoryFailure: null as unknown,
  notify: null as null | (() => Promise<unknown>),
  closing: null as null | (() => Promise<unknown>),
}));
vi.mock('../src/builder/dsl4-preview-shell.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/builder/dsl4-preview-shell.js')>()),
  createDsl4CliPreviewShell: () => {
    if (state.factoryFailure) throw state.factoryFailure;
    return {
      async setReloadWatchState() {
        await state.notify?.();
      },
      hasPendingCleanup: () => state.broken,
      async dispose() {
        state.releases++;
        await state.closing?.();
        if (state.broken) throw new Error('protocol shell cleanup failed');
      },
    };
  },
}));

for (const failShell of [true, false]) {
  test(`protocol wrapper retries pagehide removal${failShell ? ' and failed shell cleanup' : ' without repeating successful shell cleanup'}`, async () => {
    vi.resetModules();
    state.broken = failShell;
    state.notify = state.closing = null;
    state.factoryFailure = null;
    state.releases = 0;
    let removeBroken = true;
    const entered = deferred();
    const listeners = new Map<string, unknown>();
    let removals = 0;
    vi.stubGlobal('document', {querySelector: () => ({appendChild() {}})});
    vi.stubGlobal('location', {hash: `#${'a'.repeat(43)}`, pathname: '/', search: ''});
    vi.stubGlobal('history', {replaceState() {}});
    vi.stubGlobal('addEventListener', (type: string, handler: unknown) =>
      listeners.set(type, handler),
    );
    vi.stubGlobal('removeEventListener', (type: string) => {
      removals++;
      if (removeBroken) throw new Error('listener removal failed');
      listeners.delete(type);
    });
    vi.stubGlobal('fetch', async (_url: string, init: {signal: AbortSignal}) => {
      entered.resolve();
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})),
          {once: true},
        ),
      );
    });
    try {
      const client = await import('../src/builder/dsl4-local-preview-client.js');
      await entered.promise;
      const attempt = client.disposeDsl4LocalPreviewProtocolClient();
      assert.strictEqual(client.disposeDsl4LocalPreviewProtocolClient(), attempt);
      await assert.rejects(withDeadline(attempt, 'protocol wrapper cleanup', 2000), AggregateError);
      assert.equal(state.releases, 1);
      assert.equal(removals, 1);
      state.broken = false;
      removeBroken = false;
      await client.disposeDsl4LocalPreviewProtocolClient();
      assert.equal(state.releases, failShell ? 2 : 1);
      assert.equal(removals, 2);
      assert.equal(listeners.size, 0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
}

for (const boundary of ['shell', 'listener', 'fetch'] as const) {
  test(`protocol wrapper retains ${boundary} failure before the child owner returns`, async () => {
    vi.resetModules();
    const child = failedFactory();
    state.broken = false;
    state.notify = state.closing = null;
    state.releases = 0;
    state.factoryFailure = boundary === 'shell' ? child.failure : null;
    let removed = 0;
    vi.stubGlobal('document', {
      querySelector: () => ({appendChild() {}}),
      createElement: () => ({setAttribute() {}, remove() {}, textContent: ''}),
    });
    vi.stubGlobal('location', {hash: `#${'a'.repeat(43)}`, pathname: '/', search: ''});
    vi.stubGlobal('history', {replaceState() {}});
    vi.stubGlobal('addEventListener', () => {
      if (boundary === 'listener') throw child.failure;
    });
    vi.stubGlobal('removeEventListener', () => {
      removed++;
    });
    vi.stubGlobal('fetch', async () => {
      throw child.failure;
    });
    try {
      let retry: () => Promise<unknown>, pending: () => boolean;
      if (boundary === 'fetch') {
        const client = await import('../src/builder/dsl4-local-preview-client.js');
        retry = client.disposeDsl4LocalPreviewProtocolClient;
        pending = client.hasPendingDsl4LocalPreviewProtocolCleanup;
        await assert.rejects(withDeadline(retry(), 'protocol factory cleanup', 2000));
      } else {
        const failure = await import('../src/builder/dsl4-local-preview-client.js').catch(
          (error: unknown) => error,
        );
        const cleanup = getDsl4CreationCleanup(failure);
        assert.ok(cleanup);
        await assert.rejects(cleanup.completion!);
        retry = cleanup.dispose;
        pending = cleanup.hasPendingCleanup;
      }
      assert.equal(pending(), true);
      assert.equal(child.release.mock.calls.length, 1);
      child.repair();
      await retry();
      assert.equal(child.release.mock.calls.length, 2);
      assert.equal(pending(), false);
      assert.equal(state.releases, boundary === 'shell' ? 0 : 1);
      assert.equal(removed, boundary === 'shell' ? 0 : 1);
    } finally {
      state.factoryFailure = null;
      vi.unstubAllGlobals();
    }
  });
}

for (const duringCleanup of [false, true]) {
  test(`protocol retains a detached notification failure ${duringCleanup ? 'during cleanup' : 'after disposal completes'}`, async () => {
    vi.resetModules();
    const child = failedFactory(),
      entered = deferred(),
      gate = deferred();
    const closing = deferred(),
      releaseClose = deferred();
    state.broken = false;
    state.factoryFailure = null;
    state.releases = 0;
    state.notify = async () => {
      entered.resolve();
      await gate.promise;
      throw child.failure;
    };
    state.closing = async () => {
      closing.resolve();
      await releaseClose.promise;
    };
    vi.stubGlobal('document', {querySelector: () => ({appendChild() {}})});
    vi.stubGlobal('location', {hash: `#${'a'.repeat(43)}`, pathname: '/', search: ''});
    vi.stubGlobal('history', {replaceState() {}});
    vi.stubGlobal('addEventListener', () => {});
    const remove = vi.fn();
    vi.stubGlobal('removeEventListener', remove);
    const fetch = vi.fn(async () => assert.fail('closed startup must not fetch'));
    vi.stubGlobal('fetch', fetch);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const client = await import('../src/builder/dsl4-local-preview-client.js');
      await entered.promise;
      const attempt = client.disposeDsl4LocalPreviewProtocolClient();
      const outcome = attempt.then(
        () => null,
        (error: unknown) => error,
      );
      await closing.promise;
      if (!duringCleanup) {
        releaseClose.resolve();
        assert.equal(
          await withDeadline(outcome, 'protocol close before late notification', 2000),
          null,
        );
      }
      gate.resolve();
      await flushMicrotasks();
      releaseClose.resolve();
      if (duringCleanup)
        assert.ok(
          (await withDeadline(outcome, 'protocol close with late notification', 2000)) instanceof
            AggregateError,
        );
      assert.ok(errors.mock.calls.some((call) => call.includes(child.failure)));
      assert.equal(child.release.mock.calls.length, 1);
      assert.equal(client.hasPendingDsl4LocalPreviewProtocolCleanup(), true);
      child.repair();
      await client.disposeDsl4LocalPreviewProtocolClient();
      assert.equal(child.release.mock.calls.length, 2);
      assert.equal(state.releases, 1);
      assert.equal(remove.mock.calls.length, 1);
      assert.equal(fetch.mock.calls.length, 0);
      assert.equal(client.hasPendingDsl4LocalPreviewProtocolCleanup(), false);
    } finally {
      gate.resolve();
      releaseClose.resolve();
      child.repair();
      state.notify = state.closing = null;
      errors.mockRestore();
      vi.unstubAllGlobals();
    }
  });
}
