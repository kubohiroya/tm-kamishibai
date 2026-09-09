import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
  createDsl4ActionInvocationAdapter,
  createDsl4ActionRegistrySnapshot,
  createDsl4KamishibaiStructuredDataSession,
  createDsl4ObjectStore,
  createDsl4RuntimeController,
} from '../src/dsl4/index.js';
import {thrown} from './helpers/thrown-error.ts';
import {deferred, waitUntil} from './helpers/async-test-helpers.ts';
import {okResult} from './helpers/result-outcome.ts';
import {requireDefined, requireNumber, requireRecord} from './helpers/require-value.ts';

/** One thread the fake host hands out, and the scene shape the fixture story is built from. */
interface HostThread {
  readonly id: string;
}

interface FixtureScene {
  readonly id: string;
  readonly actions: readonly ReturnType<typeof action>[];
}

/** The action resources the invocation adapter publishes for the running thread. */
interface ActionResources extends Record<string, unknown> {
  actionScopeRef: unknown;
  actionViewRef: unknown;
}

const registry = createDsl4ActionRegistrySnapshot([
  {
    name: 'wave',
    target: 'actor',
    parameters: [{name: 'speed', type: 'string'}],
    source: {targetId: 'private-target', hatBlockId: 'private-hat'},
  },
]);

function action(sceneId: string, index: number) {
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
  const scenes: FixtureScene[] = [
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

function createThreadHost() {
  const threads: HostThread[] = [];
  const records = new Map<HostThread, ReturnType<typeof deferred<void>>>();
  const stops: {thread: HostThread; reason: unknown}[] = [];
  const recordOf = (thread: HostThread) =>
    requireDefined(records.get(thread), `the completion record of ${thread.id}`);
  return {
    threads,
    stops,
    start() {
      const thread = {id: `thread-${threads.length + 1}`};
      threads.push(thread);
      records.set(thread, deferred<void>());
      return [thread];
    },
    waitForCompletion(thread: HostThread) {
      return recordOf(thread).promise;
    },
    stop(thread: HostThread, reason: unknown) {
      stops.push({thread, reason});
      recordOf(thread).resolve();
    },
    complete(thread: HostThread) {
      recordOf(thread).resolve();
    },
  };
}

function createScheduler() {
  const entries: {callback: () => void; milliseconds: number; active: boolean}[] = [];
  return {
    entries,
    schedule(callback: () => void, milliseconds: number) {
      const entry = {callback, milliseconds, active: true};
      entries.push(entry);
      return () => {
        entry.active = false;
      };
    },
    fire(index = 0) {
      const entry = entries[index];
      if (entry?.active) entry.callback();
    },
  };
}

function activeCounts(store: {debugSnapshot(): {counts: Record<string, unknown>}}) {
  const counts = store.debugSnapshot().counts;
  return {
    scopes: counts.scopes,
    entries: counts.entries,
    nodes: counts.nodes,
    leases: counts.leases,
    referenceEdges: counts.referenceEdges,
  };
}

function createExecution({
  storyDocument = story(),
  failReleaseAction = false,
  failEndStory = false,
} = {}) {
  const store = createDsl4ObjectStore();
  const baseIntegration = createDsl4KamishibaiStructuredDataSession({storyDocument, store});
  const cleanupCalls = {releaseAction: 0, endStory: 0};
  const integration = Object.freeze({
    beginStory: baseIntegration.beginStory,
    enterScene: baseIntegration.enterScene,
    beginNextAction: baseIntegration.beginNextAction,
    currentActionResources: baseIntegration.currentActionResources,
    releaseAction(reason: Parameters<typeof baseIntegration.releaseAction>[0]) {
      cleanupCalls.releaseAction += 1;
      if (failReleaseAction) {
        throw Object.assign(new Error('private Store cleanup failure'), {
          code: 'K4-STRUCTURED-DATA-CLEANUP-001',
        });
      }
      return baseIntegration.releaseAction(reason);
    },
    endStory(reason: Parameters<typeof baseIntegration.endStory>[0]) {
      cleanupCalls.endStory += 1;
      const result = baseIntegration.endStory(reason);
      if (failEndStory) {
        throw Object.assign(new Error('private Store end-story failure'), {
          code: 'K4-STRUCTURED-DATA-CLEANUP-001',
        });
      }
      return result;
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

function assertActionView(
  execution: ReturnType<typeof createExecution>,
  thread: HostThread,
  expectedPath = '/scenes/opening/actions/0',
): ActionResources {
  const resources = requireRecord(
    execution.adapter.currentActionResources({thread}),
    'the current action resources',
  ) as ActionResources;
  assert.equal(Object.isFrozen(resources), true);
  const scope = requireRecord(
    okResult(execution.store.classifyHandle(resources.actionScopeRef), 'the action scope handle')
      .value,
    'the action scope classification',
  );
  assert.equal(scope.kind, 'scope');
  const stored = okResult(execution.store.readValue(resources.actionViewRef), 'the stored value');
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

function assertReleased(
  execution: ReturnType<typeof createExecution>,
  resources: ActionResources,
  thread: HostThread,
) {
  assert.equal(execution.store.classifyHandle(resources.actionScopeRef).ok, false);
  assert.equal(execution.store.classifyHandle(resources.actionViewRef).ok, false);
  assert.throws(
    () => execution.adapter.currentActionResources({thread}),
    (error) => thrown(error).code === 'K4-CUSTOM-CONTEXT-MISSING',
  );
}

async function disposeExecution(execution: ReturnType<typeof createExecution>) {
  await execution.adapter.dispose();
  execution.controller.dispose();
}

test('reuses the controller-owned ActionView scope for normal, explicit, and goto completion', async () => {
  for (const mode of ['normal', 'explicit', 'goto']) {
    const execution = createExecution();
    const run = execution.controller.start();
    await waitUntil(() => execution.threadHost.threads.length === 1);
    const thread = requireDefined(execution.threadHost.threads[0], 'the started thread');
    const resources = assertActionView(execution, thread);
    const active = activeCounts(execution.store);
    assert.equal(active.scopes, 4);
    assert.equal(active.entries, 2);
    assert.equal(active.leases, 0);
    assert.equal(active.referenceEdges, 0);
    assert.ok(requireNumber(active.nodes, 'the active node count') > 0);

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
    const thread = requireDefined(execution.threadHost.threads[0], 'the started thread');
    const resources = assertActionView(execution, thread);

    if (mode === 'fail') execution.adapter.failCurrentAction('expected failure', {thread});
    if (mode === 'timeout') execution.scheduler.fire();
    if (mode === 'stop') execution.controller.stop('test-stop');
    const state = await run;

    assert.equal(state.status, mode === 'stop' ? 'stopped' : 'failed');
    if (mode === 'fail')
      assert.equal(requireRecord(state.diagnostic, 'the run diagnostic').code, 'K4-CUSTOM-FAILED');
    if (mode === 'timeout')
      assert.equal(requireRecord(state.diagnostic, 'the run diagnostic').code, 'K4-CUSTOM-TIMEOUT');
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
    const firstThread = requireDefined(execution.threadHost.threads[0], 'the first thread');
    const firstResources = assertActionView(execution, firstThread);
    const advanced = execution.controller.advance('test-advance');
    assertReleased(execution, firstResources, firstThread);
    await waitUntil(() => execution.threadHost.threads.length === 2);
    const secondThread = requireDefined(execution.threadHost.threads[1], 'the second thread');
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
    const thread = requireDefined(execution.threadHost.threads[0], 'the started thread');
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
  const thread = requireDefined(execution.threadHost.threads[0], 'the started thread');
  const resources = assertActionView(execution, thread);
  execution.threadHost.complete(thread);
  const state = await run;

  assert.equal(state.status, 'failed');
  assert.equal(
    requireRecord(state.diagnostic, 'the run diagnostic').code,
    'K4-CUSTOM-CLEANUP-FAILED',
  );
  assert.equal(
    requireRecord(state.diagnostic, 'the run diagnostic').message,
    'Custom action scope cleanup failed',
  );
  assert.doesNotMatch(JSON.stringify(state.diagnostic), /private Store cleanup failure/u);
  assert.equal(
    execution.controller
      .getTrace()
      .some((event) => requireRecord(event, 'a trace event').type === 'action.commit'),
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

test('maps a custom end-story scope cleanup failure during stop to the same diagnostic', async () => {
  const execution = createExecution({failEndStory: true});
  const run = execution.controller.start();
  await waitUntil(() => execution.threadHost.threads.length === 1);
  const thread = requireDefined(execution.threadHost.threads[0], 'the started thread');
  const resources = assertActionView(execution, thread);
  const stopped = execution.controller.stop('test-stop-cleanup-failure');
  const state = await run;

  assert.equal(stopped.status, 'failed');
  assert.equal(state.status, 'failed');
  assert.equal(
    requireRecord(state.diagnostic, 'the run diagnostic').code,
    'K4-CUSTOM-CLEANUP-FAILED',
  );
  assert.equal(
    requireRecord(state.diagnostic, 'the run diagnostic').message,
    'Custom action scope cleanup failed',
  );
  assert.doesNotMatch(JSON.stringify(state.diagnostic), /private Store end-story failure/u);
  assert.equal(
    execution.controller
      .getTrace()
      .some((event) => requireRecord(event, 'a trace event').type === 'action.commit'),
    false,
  );
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
});
