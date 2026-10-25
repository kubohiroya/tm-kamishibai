import {createDsl4HistoryReducer} from '../src/dsl4/history-reducer.js';
import assert from 'node:assert/strict';
import {test} from 'vitest';
import {createDsl4NavigationSession} from '../src/dsl4/navigation-session.js';
import {dsl4TestSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';
import {createDsl4SessionSavePort} from '../src/dsl4/session-save.js';
import type {Dsl4SaveDataV1} from '../src/dsl4/save-data.js';
import {deferred} from './helpers/async-test-helpers.ts';
interface Session {
  start(options?: {
    variables?: Readonly<Record<string, string | number | boolean>>;
  }): Promise<unknown>;
  captureSave(): Promise<Readonly<Dsl4SaveDataV1>>;
  exportSave(): Promise<Blob>;
  restore(input: unknown): Promise<unknown>;
  dispose(): Promise<void>;
  getState(): {runtime: {status: unknown; variables: unknown}};
}
const identity = {storyId: 'save-story', sourceIntegrity: `sha256-${'a'.repeat(43)}=`};
function fixture(extra: Record<string, unknown> = {}) {
  const parsed = frontend.parse(`kamishibai: '4.0'
controls:
  keymaps:
    production: {Space: navigation.nextAction}
variables: {score: 1}
scenes:
  opening:
    - wait: 30
    - wait: 30
`);
  assert(parsed.ok, JSON.stringify(parsed.diagnostics));
  const waits: {signal: AbortSignal}[] = [];
  const events: Readonly<Record<string, unknown>>[] = [];
  const created = createDsl4NavigationSession({
    storyDocument: parsed.storyDocument,
    controlProfile: 'production',
    saveIdentity: identity,
    structuredDataIntegrationEnabled: true,
    onEvent: (event) => {
      events.push(event);
    },
    port: {
      wait(_payload: unknown, ctx: unknown) {
        const context = ctx as {signal: AbortSignal};
        waits.push(context);
        return new Promise<void>((resolve) =>
          context.signal.addEventListener('abort', () => resolve(), {once: true}),
        );
      },
      ...extra,
    },
  });
  assert('session' in created);
  return {session: created.session as Session, waits, events};
}
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
test('save Blob restores a fresh session at a live boundary with variables and history', async () => {
  const first = fixture();
  const running = first.session.start({variables: {score: 7}});
  await flush();
  const blob = await first.session.exportSave();
  const save = JSON.parse(await blob.text()) as Dsl4SaveDataV1;
  assert.equal(save.runtime.status, 'paused');
  assert.deepEqual(save.runtime.variables, {score: 7});
  assert.equal(first.session.getState().runtime.status, 'running');
  const fresh = fixture();
  await fresh.session.restore(blob);
  assert.equal(fresh.session.getState().runtime.status, 'paused');
  assert.deepEqual(fresh.session.getState().runtime.variables, {score: 7});
  const roundtrip = await fresh.session.captureSave();
  assert.deepEqual(roundtrip.runtime, save.runtime);
  await first.session.dispose();
  await fresh.session.dispose();
  await running;
});
test('invalid identity, history, position and variable types leave current execution unchanged', async () => {
  const first = fixture();
  void first.session.start();
  await flush();
  const save = await first.session.captureSave();
  await flush();
  const before = first.session.getState();
  for (const altered of [
    {...save, sourceIntegrity: `sha256-${'b'.repeat(43)}=`},
    {...save, runtime: {...save.runtime, actionIndex: 999}},
    {...save, runtime: {...save.runtime, variables: {score: 'x'}}},
    {...save, runtime: {...save.runtime, history: {}}},
  ]) {
    await assert.rejects(first.session.restore(altered));
    assert.deepEqual(first.session.getState(), before);
  }
  assert(
    first.events.some(
      (event) => event.type === 'save.diagnostic' && event.code === 'K4-SAVE-INCOMPATIBLE',
    ),
  );
  await first.session.dispose();
});
test('failed presentation preparation resumes old variables and execution without adopting save', async () => {
  const source = fixture();
  void source.session.start({variables: {score: 8}});
  await flush();
  const save = await source.session.captureSave();
  const target = fixture({
    prepareRestorePresentation() {
      throw new Error('asset missing');
    },
  });
  void target.session.start({variables: {score: 2}});
  await flush();
  await assert.rejects(target.session.restore(save), /asset missing/u);
  await flush();
  assert.equal(target.session.getState().runtime.status, 'running');
  assert.deepEqual(target.session.getState().runtime.variables, {score: 2});
  await source.session.dispose();
  await target.session.dispose();
});
test('finished empty and nonempty stories restore canonical terminal positions', async () => {
  for (const actions of ['[]', '[{wait: 0}]']) {
    const parsed = frontend.parse(
      `kamishibai: '4.0'\ncontrols: {keymaps: {production: {Space: navigation.nextAction}}}\nscenes: {opening: ${actions}}`,
    );
    assert(parsed.ok);
    const created = createDsl4NavigationSession({
      storyDocument: parsed.storyDocument,
      controlProfile: 'production',
      saveIdentity: identity,
      structuredDataIntegrationEnabled: true,
      port: {wait() {}},
    });
    assert('session' in created);
    const session = created.session as Session;
    await session.start();
    const save = await session.captureSave();
    assert.equal(save.runtime.status, 'finished');
    await session.restore(save);
    assert.equal(session.getState().runtime.status, 'finished');
    await session.dispose();
  }
});
function transactionFixture() {
  const wait = deferred<void>();
  let finalized = 0,
    rolledBack = 0,
    committed = 0,
    cleanupFails = true;
  const save = {
    formatVersion: 1,
    dslVersion: '4.0',
    ...identity,
    savedAt: '2026-10-25T00:00:00.000Z',
    runtime: {
      sceneId: 's',
      actionIndex: 0,
      variables: {},
      status: 'paused',
      history: createDsl4HistoryReducer({maxActionEntries: 10, maxSceneVisits: 10}).initialState(),
    },
    presentation: {},
  } as const;
  const api = createDsl4SessionSavePort({
    identity,
    quiesce: async () => {},
    resume() {},
    capture: () => save,
    validate() {},
    prepare: async () => ({
      commit: async () => {
        committed++;
      },
      cancel() {},
    }),
    preparePresentation: async () => {
      await wait.promise;
      return {
        commit() {},
        rollback() {
          rolledBack++;
        },
        finalize() {
          finalized++;
          if (cleanupFails) throw new Error('cleanup failed');
        },
      };
    },
    adopt() {},
    report() {},
  });
  return {
    api,
    save,
    wait,
    get: () => ({finalized, rolledBack, committed}),
    allowCleanup: () => {
      cleanupFails = false;
    },
  };
}
test('dispose waits for late preparation and rolls back instead of committing', async () => {
  const f = transactionFixture();
  const pending = f.api.restore(f.save);
  await flush();
  const disposal = f.api.dispose();
  f.wait.resolve();
  await assert.rejects(pending, /closed|cancelled/iu);
  await disposal;
  assert.deepEqual(f.get(), {finalized: 0, rolledBack: 1, committed: 0});
  assert.equal(f.api.hasPendingCleanup(), false);
});
test('post-commit cleanup failure retains explicit retry ownership and blocks new checkpoints', async () => {
  const f = transactionFixture();
  f.wait.resolve();
  await f.api.restore(f.save);
  assert.deepEqual(f.get(), {finalized: 1, rolledBack: 0, committed: 1});
  assert.equal(f.api.hasPendingCleanup(), true);
  assert.throws(() => f.api.restore(f.save), /cleanup is pending/u);
  f.allowCleanup();
  await f.api.retrySaveCleanup();
  assert.equal(f.api.hasPendingCleanup(), false);
  assert.equal(f.get().finalized, 2);
  await f.api.dispose();
});

test('an unfinished video wait times out a save without aborting or restarting its playback', async () => {
  const parsed = frontend.parse(
    `kamishibai: '4.0'\ncontrols: {keymaps: {production: {Space: navigation.nextAction}}}\nscenes:\n  opening:\n    - video: {id: movie, url: 'https://example.com/a.webm', x: 0, y: 0, width: 100, height: 100}\n    - videoControl: {id: movie, operation: playUntilDone}\n    - wait: 1\n`,
  );
  assert(parsed.ok);
  let timeout: () => void = () => {
    throw new Error('timeout not registered');
  };
  let aborted = false;
  const created = createDsl4NavigationSession({
    storyDocument: parsed.storyDocument,
    controlProfile: 'production',
    saveIdentity: identity,
    scheduleQuiesceTimeout(callback) {
      timeout = callback;
      return () => {};
    },
    port: {
      video() {},
      videoControl(_payload: unknown, ctx: unknown) {
        const {signal} = ctx as {signal: AbortSignal};
        return new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve();
            },
            {once: true},
          ),
        );
      },
      wait() {},
    },
  });
  assert('session' in created);
  const session = created.session as Session;
  void session.start();
  await flush();
  const save = session.captureSave();
  await flush();
  timeout();
  await assert.rejects(save, /timeout|exceeded/iu);
  assert.equal(aborted, false);
  assert.equal(session.getState().runtime.status, 'running');
  await session.dispose();
});
