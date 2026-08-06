import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDsl4ActionInvocationAdapter,
  createDsl4ActionRegistrySnapshot,
  createDsl4KamishibaiStructuredDataSession,
  createDsl4ObjectStore,
  createDsl4RuntimeController,
} from '../src/dsl4/index.js';

const registry = createDsl4ActionRegistrySnapshot([
  {
    name: 'wave',
    target: 'actor',
    parameters: [{name: 'speed', type: 'string'}],
    source: {targetId: 'private-target', hatBlockId: 'private-hat'},
  },
]);

function action(sceneId, index) {
  return Object.freeze({
    kind: 'Action',
    id: `/scenes/${sceneId}/actions/${index}`,
    target: 'Hero',
    command: 'wave',
    args: Object.freeze({speed: 'fast'}),
    handler: 'custom',
  });
}

function story(openingActionCount = 1, includeEnding = true) {
  const scenes = [
    Object.freeze({
      id: 'opening',
      actions: Object.freeze(
        Array.from({length: openingActionCount}, (_, index) => action('opening', index)),
      ),
    }),
  ];
  if (includeEnding) scenes.push(Object.freeze({id: 'ending', actions: Object.freeze([])}));
  return Object.freeze({
    kind: 'StoryDocument',
    version: '4.0',
    metadata: Object.freeze({sourceId: 'main'}),
    sourceMap: Object.freeze({'/': null}),
    variables: Object.freeze({}),
    actors: Object.freeze({Hero: 'HeroIdle'}),
    branches: Object.freeze({}),
    assets: Object.freeze([]),
    scenes: Object.freeze(scenes),
  });
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

function createThreadHost() {
  const threads = [];
  const records = new Map();
  const stops = [];
  return {
    threads,
    stops,
    start() {
      const thread = {id: `thread-${threads.length + 1}`};
      threads.push(thread);
      records.set(thread, deferred());
      return [thread];
    },
    waitForCompletion(thread) {
      return records.get(thread).promise;
    },
    stop(thread, reason) {
      stops.push({thread, reason});
      records.get(thread).resolve();
    },
    complete(thread) {
      records.get(thread).resolve();
    },
  };
}

function createScheduler() {
  const entries = [];
  return {
    entries,
    schedule(callback, milliseconds) {
      const entry = {callback, milliseconds, active: true};
      entries.push(entry);
      return () => {
        entry.active = false;
      };
    },
    fire(index = 0) {
      if (entries[index]?.active) entries[index].callback();
    },
  };
}

function activeCounts(store) {
  const counts = store.debugSnapshot().counts;
  return {
    scopes: counts.scopes,
    entries: counts.entries,
    nodes: counts.nodes,
    leases: counts.leases,
    referenceEdges: counts.referenceEdges,
  };
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

function createExecution({storyDocument = story(), failReleaseAction = false} = {}) {
  const store = createDsl4ObjectStore();
  const baseIntegration = createDsl4KamishibaiStructuredDataSession({storyDocument, store});
  const cleanupCalls = {releaseAction: 0, endStory: 0};
  const integration = Object.freeze({
    beginStory: baseIntegration.beginStory,
    enterScene: baseIntegration.enterScene,
    beginNextAction: baseIntegration.beginNextAction,
    currentActionResources: baseIntegration.currentActionResources,
    releaseAction(reason) {
      cleanupCalls.releaseAction += 1;
      if (failReleaseAction) {
        throw Object.assign(new Error('private Store cleanup failure'), {
          code: 'K4-STRUCTURED-DATA-CLEANUP-001',
        });
      }
      return baseIntegration.releaseAction(reason);
    },
    endStory(reason) {
      cleanupCalls.endStory += 1;
      return baseIntegration.endStory(reason);
    },
    dispose: baseIntegration.dispose,
  });
  const threadHost = createThreadHost();
  const scheduler = createScheduler();
  const adapter = createDsl4ActionInvocationAdapter({
    registrySnapshot: registry,
    storyDocument,
    runtimeGeneration: 1,
    threadHost,
    customActionTimeoutMs: 100,
    scheduleTimeout: scheduler.schedule,
  });
  const controller = createDsl4RuntimeController({
    storyDocument,
    structuredDataIntegration: integration,
    port: {customAction: adapter.customAction},
  });
  return {
    store,
    baseIntegration,
    cleanupCalls,
    threadHost,
    scheduler,
    adapter,
    controller,
  };
}

function assertActionView(execution, thread, expectedPath = '/scenes/opening/actions/0') {
  const resources = execution.adapter.currentActionResources({thread});
  assert.equal(Object.isFrozen(resources), true);
  assert.equal(execution.store.classifyHandle(resources.actionScopeRef).value.kind, 'scope');
  const stored = execution.store.readValue(resources.actionViewRef);
  assert.equal(stored.ok, true);
  assert.deepEqual(stored.value, {
    typeTag: 'kamishibai.actionView',
    value: {
      kind: 'ActionView',
      version: 1,
      name: 'wave',
      target: 'Hero',
      arguments: {speed: 'fast'},
      storyPath: expectedPath,
    },
  });
  return resources;
}

function assertReleased(execution, resources, thread) {
  assert.equal(execution.store.classifyHandle(resources.actionScopeRef).ok, false);
  assert.equal(execution.store.classifyHandle(resources.actionViewRef).ok, false);
  assert.throws(
    () => execution.adapter.currentActionResources({thread}),
    (error) => error.code === 'K4-CUSTOM-CONTEXT-MISSING',
  );
}

async function disposeExecution(execution) {
  await execution.adapter.dispose();
  execution.controller.dispose();
}

test('reuses the controller-owned ActionView scope for normal, explicit, and goto completion', async () => {
  for (const mode of ['normal', 'explicit', 'goto']) {
    const execution = createExecution();
    const run = execution.controller.start();
    await waitUntil(() => execution.threadHost.threads.length === 1);
    const thread = execution.threadHost.threads[0];
    const resources = assertActionView(execution, thread);
    const active = activeCounts(execution.store);
    assert.equal(active.scopes, 4);
    assert.equal(active.entries, 2);
    assert.equal(active.leases, 0);
    assert.equal(active.referenceEdges, 0);
    assert.ok(active.nodes > 0);

    if (mode === 'normal') execution.threadHost.complete(thread);
    if (mode === 'explicit') execution.adapter.completeCurrentAction({thread});
    if (mode === 'goto') execution.adapter.gotoFromCurrentAction('ending', {thread});
    const state = await run;

    assert.equal(state.status, 'finished');
    assert.equal(execution.cleanupCalls.releaseAction, 1);
    assert.equal(execution.cleanupCalls.endStory, 1);
    assertReleased(execution, resources, thread);
    assert.deepEqual(activeCounts(execution.store), {
      scopes: 1,
      entries: 0,
      nodes: 0,
      leases: 0,
      referenceEdges: 0,
    });
    await disposeExecution(execution);
  }
});

test('releases the same ActionView through fail, timeout, and runtime stop', async () => {
  for (const mode of ['fail', 'timeout', 'stop']) {
    const execution = createExecution();
    const run = execution.controller.start();
    await waitUntil(() => execution.threadHost.threads.length === 1);
    const thread = execution.threadHost.threads[0];
    const resources = assertActionView(execution, thread);

    if (mode === 'fail') execution.adapter.failCurrentAction('expected failure', {thread});
    if (mode === 'timeout') execution.scheduler.fire();
    if (mode === 'stop') execution.controller.stop('test-stop');
    const state = await run;

    assert.equal(state.status, mode === 'stop' ? 'stopped' : 'failed');
    if (mode === 'fail') assert.equal(state.diagnostic.code, 'K4-CUSTOM-FAILED');
    if (mode === 'timeout') assert.equal(state.diagnostic.code, 'K4-CUSTOM-TIMEOUT');
    assert.equal(execution.cleanupCalls.releaseAction, 0);
    assert.equal(execution.cleanupCalls.endStory, 1);
    assertReleased(execution, resources, thread);
    assert.deepEqual(activeCounts(execution.store), {
      scopes: 1,
      entries: 0,
      nodes: 0,
      leases: 0,
      referenceEdges: 0,
    });
    await disposeExecution(execution);
  }
});

test('advance and navigate invalidate the old thread before publishing a new resource', async () => {
  {
    const execution = createExecution({storyDocument: story(2, false)});
    const initialRun = execution.controller.start();
    await waitUntil(() => execution.threadHost.threads.length === 1);
    const firstThread = execution.threadHost.threads[0];
    const firstResources = assertActionView(execution, firstThread);
    const advanced = execution.controller.advance('test-advance');
    assertReleased(execution, firstResources, firstThread);
    await waitUntil(() => execution.threadHost.threads.length === 2);
    const secondThread = execution.threadHost.threads[1];
    const secondResources = assertActionView(execution, secondThread, '/scenes/opening/actions/1');
    assert.notEqual(secondResources.actionScopeRef, firstResources.actionScopeRef);
    assert.notEqual(secondResources.actionViewRef, firstResources.actionViewRef);
    execution.threadHost.complete(secondThread);
    assert.equal((await advanced).status, 'finished');
    await initialRun;
    assertReleased(execution, secondResources, secondThread);
    assert.equal(execution.cleanupCalls.releaseAction, 2);
    await disposeExecution(execution);
  }

  {
    const execution = createExecution();
    const initialRun = execution.controller.start();
    await waitUntil(() => execution.threadHost.threads.length === 1);
    const thread = execution.threadHost.threads[0];
    const resources = assertActionView(execution, thread);
    const navigated = execution.controller.navigate('ending', {reason: 'test-navigate'});
    assertReleased(execution, resources, thread);
    assert.equal((await navigated).status, 'finished');
    await initialRun;
    assert.equal(execution.cleanupCalls.releaseAction, 1);
    await disposeExecution(execution);
  }
});

test('maps a custom ActionView scope release failure to one redacted fail-closed diagnostic', async () => {
  const execution = createExecution({failReleaseAction: true});
  const run = execution.controller.start();
  await waitUntil(() => execution.threadHost.threads.length === 1);
  const thread = execution.threadHost.threads[0];
  const resources = assertActionView(execution, thread);
  execution.threadHost.complete(thread);
  const state = await run;

  assert.equal(state.status, 'failed');
  assert.equal(state.diagnostic.code, 'K4-CUSTOM-CLEANUP-FAILED');
  assert.equal(state.diagnostic.message, 'Custom action scope cleanup failed');
  assert.doesNotMatch(JSON.stringify(state.diagnostic), /private Store cleanup failure/u);
  assert.equal(
    execution.controller.getTrace().some((event) => event.type === 'action.commit'),
    false,
  );
  assert.equal(execution.cleanupCalls.releaseAction, 1);
  assert.equal(execution.cleanupCalls.endStory, 1);
  assertReleased(execution, resources, thread);
  assert.deepEqual(activeCounts(execution.store), {
    scopes: 1,
    entries: 0,
    nodes: 0,
    leases: 0,
    referenceEdges: 0,
  });
  await disposeExecution(execution);
});
