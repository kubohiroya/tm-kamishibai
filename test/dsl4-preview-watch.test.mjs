import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {createDsl4PreviewSourceWatcher, dsl4PreviewWatchDefaults} from '../src/builder/index.js';
import {createDsl4LiveReloadSession, createDsl4SourceFrontend} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const manifest = Object.freeze({
  formatVersion: 1,
  mode: 'external',
  sourceId: 'main',
});
const validSource = "kamishibai: '4.0'\nscenes:\n  opening: []\n";

function createFakeClock() {
  let time = 0;
  let nextTimerId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(callback, milliseconds) {
      const id = nextTimerId++;
      timers.set(id, {at: time + milliseconds, callback});
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async sleep(milliseconds) {
      time += milliseconds;
    },
    advance(milliseconds) {
      time += milliseconds;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= time)
        .sort(([, left], [, right]) => left.at - right.at);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
    },
    pendingTimers: () => timers.size,
  };
}

function createFakeWatchFactory() {
  let listener = null;
  let errorListener = null;
  let directory = null;
  let closed = 0;
  return {
    factory(watchedDirectory, watchedListener) {
      directory = watchedDirectory;
      listener = watchedListener;
      return {
        close() {
          closed += 1;
        },
        on(type, callback) {
          if (type === 'error') errorListener = callback;
          return this;
        },
      };
    },
    emit(filename = 'story.kamishibai.yaml') {
      listener?.('change', filename);
    },
    emitError(error) {
      errorListener?.(error);
    },
    get directory() {
      return directory;
    },
    get closed() {
      return closed;
    },
  };
}

function descriptor(text, integrity) {
  return Object.freeze({sourceId: 'main', text, integrity});
}

function sourceError(code) {
  return Object.assign(new Error(code), {code});
}

function watcherOptions(overrides = {}) {
  const clock = createFakeClock();
  const watched = createFakeWatchFactory();
  const results = [];
  return {
    clock,
    watched,
    results,
    options: {
      projectRoot: '/project',
      manifest,
      sourceFrontend: frontend,
      maxSourceBytes: 4096,
      onResult(result) {
        results.push(result);
      },
      quietWindowMs: 100,
      retryIntervalMs: 10,
      stabilityTimeoutMs: 30,
      clock,
      watchFactory: watched.factory,
      ...overrides,
    },
  };
}

test('defines finite development defaults and has no side effects before start', async () => {
  assert.deepEqual(dsl4PreviewWatchDefaults, {
    quietWindowMs: 100,
    retryIntervalMs: 50,
    stabilityTimeoutMs: 2_000,
  });
  const setup = watcherOptions({
    loadSource: async () => ({descriptor: descriptor(validSource, 'sha256-initial')}),
  });
  const watcher = createDsl4PreviewSourceWatcher(setup.options);
  assert.deepEqual(watcher.getState(), {
    version: 1,
    status: 'idle',
    revision: 0,
    published: 0,
    lastPublication: null,
    started: false,
    disposed: false,
  });
  assert.equal(setup.watched.directory, null);

  const state = await watcher.start();
  assert.equal(state.status, 'watching');
  assert.equal(state.published, 1);
  assert.equal(setup.watched.directory, '/project');
  assert.equal(setup.results[0].ok, true);
  assert.equal(setup.results[0].sourceSnapshot.integrity, 'sha256-initial');
  assert.equal(Object.isFrozen(setup.results[0]), true);
  await watcher.dispose();
  assert.equal(setup.watched.closed, 1);
});

test('watches an explicit root-level source basename without accepting other files', async () => {
  let loads = 0;
  const setup = watcherOptions({
    manifest: {...manifest, path: 'alternate.kamishibai.yaml'},
    loadSource: async () => {
      loads += 1;
      return {descriptor: descriptor(validSource, 'sha256-explicit')};
    },
  });
  const watcher = createDsl4PreviewSourceWatcher(setup.options);
  await watcher.start();
  assert.equal(setup.watched.directory, '/project');
  assert.equal(loads, 1);

  setup.watched.emit('story.kamishibai.yaml');
  assert.equal(setup.clock.pendingTimers(), 0);
  setup.watched.emit('alternate.kamishibai.yaml');
  assert.equal(setup.clock.pendingTimers(), 1);
  setup.clock.advance(100);
  await watcher.whenIdle();
  assert.equal(loads, 2);
  await watcher.dispose();
});

test('coalesces source events and publishes only changed stable integrity', async () => {
  let current = descriptor(validSource, 'sha256-initial');
  let loads = 0;
  const setup = watcherOptions({
    loadSource: async () => {
      loads += 1;
      return {descriptor: current};
    },
  });
  const watcher = createDsl4PreviewSourceWatcher(setup.options);
  await watcher.start();
  assert.equal(loads, 1);

  setup.watched.emit('unrelated.txt');
  assert.equal(setup.clock.pendingTimers(), 0);
  setup.watched.emit();
  setup.watched.emit();
  assert.equal(setup.clock.pendingTimers(), 1);
  setup.clock.advance(99);
  await watcher.whenIdle();
  assert.equal(loads, 1);
  setup.clock.advance(1);
  await watcher.whenIdle();
  assert.equal(loads, 2);
  assert.equal(setup.results.length, 1);

  current = descriptor(validSource.replace('opening', 'ending'), 'sha256-next');
  setup.watched.emit();
  setup.clock.advance(100);
  await watcher.whenIdle();
  assert.equal(loads, 3);
  assert.equal(setup.results.length, 2);
  assert.equal(setup.results[1].storyDocument.scenes[0].id, 'ending');
  assert.equal(watcher.getState().lastPublication.integrity, 'sha256-next');
  await watcher.dispose();
});

test('retries transient missing and unstable reads before publishing one valid snapshot', async () => {
  const attempts = [
    sourceError('K4-SOURCE-MISSING'),
    sourceError('K4-PREVIEW-SOURCE-UNSTABLE'),
    {descriptor: descriptor(validSource, 'sha256-recovered')},
  ];
  const setup = watcherOptions({
    loadSource: async () => {
      const next = attempts.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
  const watcher = createDsl4PreviewSourceWatcher(setup.options);
  const state = await watcher.start();
  assert.equal(state.status, 'watching');
  assert.equal(setup.clock.now(), 20);
  assert.equal(setup.results.length, 1);
  assert.equal(setup.results[0].ok, true);
  assert.equal(setup.results[0].sourceSnapshot.integrity, 'sha256-recovered');
  await watcher.dispose();
});

for (const [code, severity] of [
  ['K4-SOURCE-MISSING', 'error'],
  ['K4-PREVIEW-SOURCE-UNSTABLE', 'warning'],
]) {
  test(`publishes bounded ${code} without source text or a machine path`, async () => {
    let attempts = 0;
    const setup = watcherOptions({
      loadSource: async () => {
        attempts += 1;
        throw sourceError(code);
      },
    });
    const watcher = createDsl4PreviewSourceWatcher(setup.options);
    const state = await watcher.start();
    assert.equal(attempts, 4);
    assert.equal(state.status, 'watching');
    assert.equal(state.published, 1);
    assert.equal(setup.results[0].ok, false);
    assert.equal(setup.results[0].diagnostics[0].code, code);
    assert.equal(setup.results[0].diagnostics[0].severity, severity);
    assert.doesNotMatch(JSON.stringify(setup.results[0]), /\/project|kamishibai:|'4\.0'/u);
    assert.doesNotMatch(JSON.stringify(state), /\/project|kamishibai:|'4\.0'/u);
    await watcher.dispose();
  });
}

test('keeps retry finite even when an injected clock does not advance', async () => {
  const stuckClock = createFakeClock();
  stuckClock.sleep = async () => {};
  let attempts = 0;
  const setup = watcherOptions({
    clock: stuckClock,
    loadSource: async () => {
      attempts += 1;
      throw sourceError('K4-SOURCE-MISSING');
    },
  });
  const watcher = createDsl4PreviewSourceWatcher(setup.options);
  await watcher.start();
  assert.equal(attempts, 4);
  assert.equal(setup.results[0].diagnostics[0].code, 'K4-SOURCE-MISSING');
  await watcher.dispose();
});

test('publishes stable source and frontend errors without retrying or replacing semantics', async () => {
  let loads = 0;
  const invalidSource = "kamishibai: '4.0'\nscenes: {}\n";
  const setup = watcherOptions({
    loadSource: async () => {
      loads += 1;
      return {descriptor: descriptor(invalidSource, 'sha256-invalid')};
    },
  });
  const watcher = createDsl4PreviewSourceWatcher(setup.options);
  await watcher.start();
  assert.equal(loads, 1);
  assert.equal(setup.results[0].ok, false);
  assert.equal(setup.results[0].sourceSnapshot.integrity, 'sha256-invalid');
  assert.deepEqual(
    setup.results[0].diagnostics,
    frontend.parse(invalidSource, {sourceId: 'main'}).diagnostics,
  );
  await watcher.dispose();

  const sourceFailureSetup = watcherOptions({
    loadSource: async () => {
      throw sourceError('K4-SOURCE-UTF8-001');
    },
  });
  const sourceFailureWatcher = createDsl4PreviewSourceWatcher(sourceFailureSetup.options);
  await sourceFailureWatcher.start();
  assert.equal(sourceFailureSetup.results[0].diagnostics[0].code, 'K4-SOURCE-UTF8-001');
  assert.equal(sourceFailureSetup.clock.now(), 0);
  await sourceFailureWatcher.dispose();
});

test('invalidates an in-flight read and closes exactly once on dispose', async () => {
  let resolveLoad;
  const loadPromise = new Promise((resolve) => {
    resolveLoad = resolve;
  });
  const setup = watcherOptions({loadSource: () => loadPromise});
  const watcher = createDsl4PreviewSourceWatcher(setup.options);
  const starting = watcher.start();
  await Promise.resolve();
  const disposing = watcher.dispose();
  resolveLoad({descriptor: descriptor(validSource, 'sha256-stale')});
  await Promise.all([starting, disposing]);
  assert.equal(setup.results.length, 0);
  assert.equal(watcher.getState().status, 'disposed');
  assert.equal(setup.watched.closed, 1);
  assert.equal(setup.clock.pendingTimers(), 0);
  assert.deepEqual(await watcher.dispose(), watcher.getState());
});

test('contains watcher observer failures and validates the lifecycle boundary', async () => {
  const errors = [];
  const setup = watcherOptions({
    loadSource: async () => ({descriptor: descriptor(validSource, 'sha256-initial')}),
    onError(error) {
      errors.push(error);
    },
  });
  const watcher = createDsl4PreviewSourceWatcher(setup.options);
  await watcher.start();
  const observerError = new Error('watch failed');
  setup.watched.emitError(observerError);
  assert.deepEqual(errors, [observerError]);
  assert.equal(watcher.getState().status, 'failed');
  await watcher.dispose();

  for (const overrides of [
    {projectRoot: ''},
    {maxSourceBytes: 0},
    {sourceFrontend: {}},
    {onResult: null},
    {quietWindowMs: -1},
    {retryIntervalMs: 0},
    {stabilityTimeoutMs: 9},
    {clock: {}},
  ]) {
    assert.throws(() => createDsl4PreviewSourceWatcher({...setup.options, ...overrides}));
  }
});

test('uses the authorized stable loader and shared frontend for real disk updates', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsl4-preview-watch-'));
  try {
    const sourcePath = path.join(directory, 'story.kamishibai.yaml');
    await writeFile(sourcePath, validSource);
    const clock = createFakeClock();
    const watched = createFakeWatchFactory();
    const results = [];
    const watcher = createDsl4PreviewSourceWatcher({
      projectRoot: directory,
      manifest,
      sourceFrontend: frontend,
      maxSourceBytes: 4096,
      onResult: (result) => results.push(result),
      subtleCrypto: webcrypto.subtle,
      quietWindowMs: 1,
      retryIntervalMs: 1,
      stabilityTimeoutMs: 3,
      clock,
      watchFactory: watched.factory,
    });
    await watcher.start();
    assert.equal(results[0].ok, true);

    await writeFile(sourcePath, "kamishibai: '4.0'\nscenes: {}\n");
    watcher.notifyChange();
    clock.advance(1);
    await watcher.whenIdle();
    assert.equal(results[1].ok, false);
    assert.ok(results[1].diagnostics.length > 0);

    await writeFile(sourcePath, validSource.replace('opening', 'recovered'));
    watcher.notifyChange();
    clock.advance(1);
    await watcher.whenIdle();
    assert.equal(results[2].ok, true);
    assert.equal(results[2].storyDocument.scenes[0].id, 'recovered');
    await watcher.dispose();
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('feeds initial, invalid, and recovered snapshots directly into live reload', async () => {
  const events = [];
  const reloadStates = [];
  const liveReload = createDsl4LiveReloadSession({
    createSession({storyDocument}) {
      let state = {
        status: 'idle',
        sceneId: 'opening',
        actionIndex: 0,
        actionPath: null,
        variables: storyDocument.variables,
      };
      let quiesceToken = null;
      return {
        start(options = {}) {
          events.push(['start', options]);
          state = {...state, status: 'running'};
          return Promise.resolve(state);
        },
        stop(reason) {
          events.push(['stop', reason]);
          state = {...state, status: 'stopped'};
          quiesceToken = null;
        },
        dispose(reason) {
          events.push(['dispose', reason]);
        },
        getState() {
          return {runtime: state};
        },
        quiesce({candidateId}) {
          quiesceToken = Object.freeze({
            kind: 'Dsl4QuiesceToken',
            version: 1,
            candidateId,
            runtimeGeneration: 1,
            storyPath: '/scenes/opening',
            actionSignature: null,
            sceneId: 'opening',
            actionIndex: 0,
            variables: {...state.variables},
            resumeMode: 'finished',
          });
          state = {...state, status: 'paused'};
          return quiesceToken;
        },
        resumeQuiesce(candidateId) {
          if (!quiesceToken || quiesceToken.candidateId !== candidateId) {
            throw new TypeError('stale quiesce candidate');
          }
          quiesceToken = null;
          state = {...state, status: 'running'};
          return state;
        },
      };
    },
  });
  let current = descriptor(validSource, 'sha256-initial');
  const setup = watcherOptions({
    loadSource: async () => ({descriptor: current}),
    async onResult(result) {
      reloadStates.push(await liveReload.stage(result));
    },
  });
  const watcher = createDsl4PreviewSourceWatcher(setup.options);
  await watcher.start();
  assert.equal(reloadStates[0].status, 'active');
  assert.deepEqual(events, [['start', {}]]);

  current = descriptor("kamishibai: '4.0'\nscenes: {}\n", 'sha256-invalid');
  watcher.notifyChange();
  setup.clock.advance(100);
  await watcher.whenIdle();
  assert.equal(reloadStates[1].status, 'invalid');
  assert.equal(reloadStates[1].hasCurrent, true);
  assert.deepEqual(events, [['start', {}]]);

  current = descriptor(
    validSource.replace('opening: []', 'opening:\n    - wait: 1'),
    'sha256-recovered',
  );
  watcher.notifyChange();
  setup.clock.advance(100);
  await watcher.whenIdle();
  assert.equal(reloadStates[2].status, 'pending');
  assert.equal(reloadStates[2].candidate.plan.options.storyStart.enabled, true);
  assert.deepEqual(events, [['start', {}]]);

  await watcher.dispose();
  await liveReload.dispose();
});
