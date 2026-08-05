import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  createDsl4NavigationSession,
  createDsl4RuntimeController,
  createDsl4SourceFrontend,
} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);

function parseStory(source) {
  const result = frontend.parse(source, {sourceId: 'asset-lifecycle-test'});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.storyDocument;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('Timed out while waiting for runtime lifecycle state');
}

const lifecycleStory = `
kamishibai: '4.0'
assets:
  AlwaysReady: backdrop
  LoadingBackdrop: backdrop
  LoadingCostume: costume:Loading
  CoverLazy:
    kind: backdrop
    name: CoverLazy
    loading: lazy
  HeroInitial:
    kind: costume
    target: Hero
    name: HeroInitial
    loading: lazy
  NextBackdrop:
    kind: backdrop
    name: NextBackdrop
    loading: lazy
  NextSound:
    kind: sound
    name: NextSound
    loading: lazy
actors:
  Hero: HeroInitial
cover:
  backdrop: CoverLazy
loading:
  backdrop: LoadingBackdrop
  costumes: [LoadingCostume]
scenes:
  opening:
    - goto: next
  next:
    - stage: NextBackdrop
    - sound: NextSound
`;

test('preloads the resolved target before transition and waits behind Loading', async () => {
  const pendingScene = deferred();
  const calls = [];
  const effects = [];
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(lifecycleStory),
    port: {
      stage: async () => effects.push('stage'),
      sound: async () => effects.push('sound'),
    },
    assetLifecycle: {
      prepare(payload, context) {
        calls.push({method: 'prepare', payload, signal: context.signal});
        return payload.phase === 'scene' && payload.sceneId === 'next'
          ? pendingScene.promise
          : Promise.resolve();
      },
      async setLoading(payload) {
        calls.push({method: 'setLoading', payload});
      },
      async release(payload) {
        calls.push({method: 'release', payload});
      },
    },
  });

  const run = controller.start();
  await waitUntil(() =>
    calls.some(({method, payload}) => method === 'setLoading' && payload.visible),
  );
  assert.deepEqual(calls[0].payload, {
    phase: 'startup',
    sceneId: null,
    assetIds: ['AlwaysReady', 'CoverLazy', 'HeroInitial', 'LoadingBackdrop', 'LoadingCostume'],
  });
  const nextPrepare = calls.find(
    ({method, payload}) => method === 'prepare' && payload.sceneId === 'next',
  );
  assert.deepEqual(nextPrepare.payload.assetIds, ['NextBackdrop', 'NextSound']);
  assert.deepEqual(effects, []);

  const traceBeforeReady = controller.getTrace();
  const preloadIndex = traceBeforeReady.findIndex(
    ({type, details}) => type === 'assets.preload.start' && details.sceneId === 'next',
  );
  const transitionIndex = traceBeforeReady.findIndex(
    ({type, details}) => type === 'scene.transition' && details.to === 'next',
  );
  const enterIndex = traceBeforeReady.findIndex(
    ({type, sceneId}) => type === 'scene.enter' && sceneId === 'next',
  );
  const loadingIndex = traceBeforeReady.findIndex(
    ({type, sceneId}) => type === 'assets.loading.show' && sceneId === 'next',
  );
  assert.ok(preloadIndex < transitionIndex);
  assert.ok(transitionIndex < enterIndex);
  assert.ok(enterIndex < loadingIndex);

  pendingScene.resolve();
  const state = await run;
  assert.equal(state.status, 'finished');
  assert.deepEqual(effects, ['stage', 'sound']);
  assert.deepEqual(
    calls.filter(({method}) => method === 'setLoading').map(({payload}) => payload.visible),
    [true, false],
  );
  const trace = controller.getTrace();
  assert.ok(
    trace.findIndex(({type}) => type === 'assets.loading.hide') <
      trace.findIndex(({type, sceneId}) => type === 'action.start' && sceneId === 'next'),
  );
  assert.ok(trace.every(({generation}) => Number.isInteger(generation)));
  controller.stop('finished-cleanup');
  await waitUntil(() =>
    calls.some(
      ({method, payload}) => method === 'release' && payload.reason === 'finished-cleanup',
    ),
  );
});

test('does not show Loading when scene preparation is already fulfilled', async () => {
  const loadingCalls = [];
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(lifecycleStory),
    port: {stage: async () => {}, sound: async () => {}},
    assetLifecycle: {
      async prepare() {},
      async setLoading(payload) {
        loadingCalls.push(payload);
      },
      async release() {},
    },
  });

  const state = await controller.start({sceneId: 'next'});
  assert.equal(state.status, 'finished');
  assert.deepEqual(loadingCalls, []);
  assert.equal(
    controller.getTrace().some(({type}) => type === 'assets.loading.show'),
    false,
  );
});

test('hides Loading and fails before the first action when preparation rejects', async () => {
  const pendingScene = deferred();
  const loadingCalls = [];
  let stageCalls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(lifecycleStory),
    port: {stage: async () => stageCalls++, sound: async () => {}},
    assetLifecycle: {
      prepare(payload) {
        return payload.phase === 'scene' ? pendingScene.promise : Promise.resolve();
      },
      async setLoading(payload) {
        loadingCalls.push(payload.visible);
      },
      async release() {},
    },
  });

  const run = controller.start({sceneId: 'next'});
  await waitUntil(() => loadingCalls.includes(true));
  pendingScene.reject(new Error('decode failed'));
  const state = await run;
  assert.equal(state.status, 'failed');
  assert.equal(state.diagnostic.code, 'K4-ASSET-PREPARE-001');
  assert.match(state.diagnostic.message, /decode failed/u);
  assert.deepEqual(loadingCalls, [true, false]);
  assert.equal(stageCalls, 0);
  assert.equal(controller.getTrace().at(-1).type, 'runtime.fail');
});

test('aborts stale preparation on reposition and releases lifecycle state on stop', async () => {
  const openingPreparation = deferred();
  const preparations = [];
  const releases = [];
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  OpeningBackdrop:
    kind: backdrop
    name: OpeningBackdrop
    loading: lazy
  DestinationBackdrop:
    kind: backdrop
    name: DestinationBackdrop
    loading: lazy
scenes:
  opening:
    - stage: OpeningBackdrop
  destination:
    - stage: DestinationBackdrop
`),
    port: {stage: async () => {}},
    assetLifecycle: {
      prepare(payload, context) {
        preparations.push({payload, signal: context.signal});
        return payload.sceneId === 'opening' ? openingPreparation.promise : Promise.resolve();
      },
      async setLoading() {},
      async release(payload) {
        releases.push(payload.reason);
      },
    },
  });

  const staleRun = controller.start();
  await waitUntil(() => preparations.some(({payload}) => payload.sceneId === 'opening'));
  const opening = preparations.find(({payload}) => payload.sceneId === 'opening');
  const paused = controller.reposition('destination', {reason: 'history.previousScene'});
  assert.equal(paused.status, 'paused');
  assert.equal(opening.signal.aborted, true);
  const resumed = await controller.resume();
  assert.equal(resumed.status, 'finished');
  assert.deepEqual(
    preparations
      .filter(({payload}) => payload.phase === 'scene')
      .map(({payload}) => payload.sceneId),
    ['opening', 'destination'],
  );
  openingPreparation.resolve();
  await staleRun;

  const stoppedController = createDsl4RuntimeController({
    storyDocument: parseStory(lifecycleStory),
    port: {stage: async () => {}, sound: async () => {}},
    assetLifecycle: {
      prepare(_payload, context) {
        preparations.push({payload: {phase: 'stop-test'}, signal: context.signal});
        return new Promise(() => {});
      },
      async setLoading() {},
      async release(payload) {
        releases.push(payload.reason);
      },
    },
  });
  const stoppedRun = stoppedController.start();
  await waitUntil(() => preparations.some(({payload}) => payload.phase === 'stop-test'));
  const stopPreparation = preparations.find(({payload}) => payload.phase === 'stop-test');
  const stopped = stoppedController.stop('test-stop');
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopPreparation.signal.aborted, true);
  assert.equal((await stoppedRun).status, 'stopped');
  await waitUntil(() => releases.includes('test-stop'));
});

test('validates the optional lifecycle contract and keeps platform dependencies outside core', async () => {
  const storyDocument = parseStory(`
kamishibai: '4.0'
scenes:
  opening: []
`);
  assert.throws(
    () => createDsl4RuntimeController({storyDocument, port: {}, assetLifecycle: {}}),
    /prepare, setLoading, and release/u,
  );
  const implementation = await readFile(
    path.join(projectRoot, 'src', 'dsl4', 'asset-preload-coordinator.js'),
    'utf8',
  );
  assert.doesNotMatch(implementation, /(?:node:fs|node:http|node:https|\bfetch\s*\()/u);
  assert.doesNotMatch(implementation, /(?:globalThis\.(?:document|window)|KeyboardEvent)/u);
  assert.doesNotMatch(implementation, /(?:\bScratch\b|scratch-vm|vm\.runtime|startHats)/u);
});

test('passes the same lifecycle through the keymap and history navigation session', async () => {
  const preparations = [];
  const releases = [];
  const result = createDsl4NavigationSession({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  Scene:
    kind: backdrop
    name: Scene
    loading: lazy
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - stage: Scene
`),
    controlProfile: 'production',
    port: {stage: async () => {}},
    assetLifecycle: {
      async prepare(payload) {
        preparations.push(payload);
      },
      async setLoading() {},
      async release(payload) {
        releases.push(payload.reason);
      },
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const state = await result.session.start();
  assert.equal(state.status, 'finished');
  assert.deepEqual(
    preparations.map(({phase, sceneId, assetIds}) => [phase, sceneId, assetIds]),
    [
      ['startup', null, []],
      ['scene', 'opening', ['Scene']],
    ],
  );
  result.session.dispose();
  await waitUntil(() => releases.includes('dispose'));
});
