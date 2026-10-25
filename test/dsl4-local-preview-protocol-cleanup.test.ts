import assert from 'node:assert/strict';
import {test, vi} from 'vitest';
import {deferred, withDeadline} from './helpers/async-test-helpers.ts';

const state = vi.hoisted(() => ({broken: true, releases: 0}));
vi.mock('../src/builder/dsl4-preview-shell.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/builder/dsl4-preview-shell.js')>()),
  createDsl4CliPreviewShell: () => ({
    async setReloadWatchState() {},
    hasPendingCleanup: () => state.broken,
    async dispose() {
      state.releases++;
      if (state.broken) throw new Error('protocol shell cleanup failed');
    },
  }),
}));

for (const failShell of [true, false]) {
  test(`protocol wrapper retries pagehide removal${failShell ? ' and failed shell cleanup' : ' without repeating successful shell cleanup'}`, async () => {
    vi.resetModules();
    state.broken = failShell;
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
