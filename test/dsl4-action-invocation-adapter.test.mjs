import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDsl4ActionInvocationAdapter,
  createDsl4ActionRegistrySnapshot,
  createDsl4RuntimeController,
  dsl4CustomActionTimeoutDefaults,
  Dsl4CustomActionError,
} from '../src/dsl4/index.js';

const registry = createDsl4ActionRegistrySnapshot([
  {
    name: 'wave',
    target: 'actor',
    parameters: [
      {name: 'speed', type: 'string'},
      {name: 'count', type: 'number', required: false},
      {name: 'enabled', type: 'boolean', required: false},
    ],
    quiesce: 'finish-only',
    source: {targetId: 'private-target', hatBlockId: 'private-hat'},
  },
]);

const storyDocument = Object.freeze({
  kind: 'StoryDocument',
  version: '4.0',
  scenes: Object.freeze([
    Object.freeze({id: 'opening', actions: Object.freeze([])}),
    Object.freeze({id: 'ending', actions: Object.freeze([])}),
  ]),
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

function createThreadHost(cardinalities = [1]) {
  const records = new Map();
  const starts = [];
  const stops = [];
  let nextThread = 1;
  let failStop = false;
  return {
    starts,
    stops,
    records,
    setFailStop(value) {
      failStop = value;
    },
    start(source) {
      starts.push(source);
      const count = cardinalities.shift() ?? 1;
      return Array.from({length: count}, () => {
        const thread = {id: `thread-${nextThread++}`};
        records.set(thread, deferred());
        return thread;
      });
    },
    waitForCompletion(thread) {
      return records.get(thread).promise;
    },
    stop(thread, reason) {
      stops.push({thread, reason});
      if (failStop) throw new Error('private stop failure');
      records.get(thread)?.resolve();
    },
    complete(thread) {
      records.get(thread).resolve();
    },
    fail(thread) {
      records.get(thread).reject(new Error('private thread failure'));
    },
    latestThread() {
      return [...records.keys()].at(-1);
    },
  };
}

function createFakeTimeoutScheduler() {
  const scheduled = [];
  return {
    scheduled,
    schedule(callback, milliseconds) {
      const entry = {callback, milliseconds, active: true};
      scheduled.push(entry);
      return () => {
        entry.active = false;
      };
    },
    fire(index = 0) {
      const entry = scheduled[index];
      if (entry?.active) entry.callback();
    },
  };
}

function payload(extraArguments = {}) {
  return {
    name: 'wave',
    target: 'Hero',
    arguments: {speed: 'fast', ...extraArguments},
  };
}

function context(controller = new AbortController(), actionPath = '/scenes/opening/actions/0') {
  return {
    signal: controller.signal,
    actionPath,
    structuredData: {actionScopeRef: '@test.scope', actionViewRef: '@test.action'},
  };
}

function createAdapter(threadHost, extra = {}) {
  return createDsl4ActionInvocationAdapter({
    registrySnapshot: registry,
    storyDocument,
    runtimeGeneration: 7,
    threadHost,
    customActionTimeoutMs: 1_000,
    ...extra,
  });
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof Dsl4CustomActionError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test('binds one immutable invocation to the primary thread and implicitly completes', async () => {
  const host = createThreadHost();
  const adapter = createAdapter(host);
  const runtimeContext = context();
  const resultPromise = adapter.customAction(payload({enabled: false}), runtimeContext);
  const thread = host.latestThread();
  const util = {thread};
  runtimeContext.structuredData.actionScopeRef = '@private.replaced';
  runtimeContext.structuredData.actionViewRef = '@private.replaced';

  assert.deepEqual(host.starts, [{targetId: 'private-target', hatBlockId: 'private-hat'}]);
  assert.equal(Object.isFrozen(host.starts[0]), true);
  assert.equal(adapter.currentActionName(util), 'wave');
  assert.equal(adapter.currentActionTarget(util), 'Hero');
  assert.equal(adapter.currentActionHasArgument('speed', util), true);
  assert.equal(adapter.currentActionArgument('speed', util), 'fast');
  assert.equal(adapter.currentActionHasArgument('count', util), false);
  assert.equal(adapter.currentActionArgument('count', util), '');
  assert.equal(adapter.currentActionHasArgument('enabled', util), true);
  assert.equal(adapter.currentActionArgument('enabled', util), false);
  assert.deepEqual(adapter.currentActionResources(util), {
    actionScopeRef: '@test.scope',
    actionViewRef: '@test.action',
  });
  assert.equal(Object.isFrozen(adapter.currentActionResources(util)), true);

  host.complete(thread);
  assert.deepEqual(await resultPromise, {outcome: 'completed'});
  assert.equal(host.stops.length, 0);
  assert.throws(
    () => adapter.currentActionName(util),
    (error) => error.code === 'K4-CUSTOM-CONTEXT-MISSING',
  );
});

test('rejects missing and ambiguous primary handlers and stops every ambiguous thread', async () => {
  const missingHost = createThreadHost([0]);
  await rejectsCode(
    createAdapter(missingHost).customAction(payload(), context()),
    'K4-CUSTOM-HANDLER-MISSING',
  );

  const ambiguousHost = createThreadHost([2]);
  await rejectsCode(
    createAdapter(ambiguousHost).customAction(payload(), context()),
    'K4-CUSTOM-HANDLER-AMBIGUOUS',
  );
  assert.equal(ambiguousHost.stops.length, 2);
  assert.deepEqual(
    ambiguousHost.stops.map(({reason}) => reason),
    ['handler-cardinality-invalid', 'handler-cardinality-invalid'],
  );
});

test('does not leak context to a broadcast, clone, or another adapter session', async () => {
  const firstHost = createThreadHost();
  const secondHost = createThreadHost();
  const first = createAdapter(firstHost);
  const second = createAdapter(secondHost);
  const firstResult = first.customAction(payload(), context());
  const secondResult = second.customAction(payload(), context());
  const firstThread = firstHost.latestThread();
  const secondThread = secondHost.latestThread();

  assert.equal(first.currentActionName({thread: firstThread}), 'wave');
  for (const operation of [
    () => first.currentActionName({thread: {id: 'broadcast'}}),
    () => first.currentActionName({thread: {id: 'clone'}}),
    () => first.currentActionName({thread: secondThread}),
    () => second.currentActionName({thread: firstThread}),
  ]) {
    assert.throws(operation, (error) => error.code === 'K4-CUSTOM-CONTEXT-MISSING');
  }

  firstHost.complete(firstThread);
  secondHost.complete(secondThread);
  await Promise.all([firstResult, secondResult]);
});

test('accepts only the first terminal signal and reports later terminal attempts', async () => {
  const diagnostics = [];
  const host = createThreadHost();
  const adapter = createAdapter(host, {onDiagnostic: (entry) => diagnostics.push(entry)});
  const resultPromise = adapter.customAction(payload(), context());
  const util = {thread: host.latestThread()};

  adapter.completeCurrentAction(util);
  adapter.failCurrentAction('must not replace complete', util);
  adapter.gotoFromCurrentAction('ending', util);

  assert.deepEqual(await resultPromise, {outcome: 'completed'});
  assert.equal(host.stops.length, 1);
  assert.deepEqual(
    diagnostics.map(({code}) => code),
    ['K4-CUSTOM-ALREADY-SETTLED', 'K4-CUSTOM-ALREADY-SETTLED'],
  );
  assert.equal(
    diagnostics.every((entry) => !JSON.stringify(entry).includes('private-')),
    true,
  );
});

test('settles explicit fail and valid or invalid goto with bounded diagnostics', async () => {
  const failHost = createThreadHost();
  const failAdapter = createAdapter(failHost);
  const failed = failAdapter.customAction(payload(), context());
  failAdapter.failCurrentAction('失'.repeat(300), {thread: failHost.latestThread()});
  await assert.rejects(failed, (error) => {
    assert.equal(error.code, 'K4-CUSTOM-FAILED');
    assert.equal([...error.message].length, 256);
    return true;
  });

  const gotoHost = createThreadHost();
  const gotoAdapter = createAdapter(gotoHost);
  const transitioned = gotoAdapter.customAction(payload(), context());
  gotoAdapter.gotoFromCurrentAction('ending', {thread: gotoHost.latestThread()});
  assert.deepEqual(await transitioned, {outcome: 'transitioned', sceneId: 'ending'});

  const invalidHost = createThreadHost();
  const invalidAdapter = createAdapter(invalidHost);
  const invalid = invalidAdapter.customAction(payload(), context());
  invalidAdapter.gotoFromCurrentAction('unknown-private-scene', {
    thread: invalidHost.latestThread(),
  });
  await assert.rejects(invalid, (error) => {
    assert.equal(error.code, 'K4-CUSTOM-GOTO-001');
    assert.doesNotMatch(error.message, /unknown-private-scene/u);
    return true;
  });
});

test('fails unknown argument reporters without returning source data', async () => {
  const host = createThreadHost();
  const adapter = createAdapter(host);
  const resultPromise = adapter.customAction(payload(), context());
  const util = {thread: host.latestThread()};

  assert.equal(adapter.currentActionArgument('private-undeclared-name', util), '');
  await assert.rejects(resultPromise, (error) => {
    assert.equal(error.code, 'K4-CUSTOM-ARGUMENT-UNKNOWN');
    assert.doesNotMatch(error.message, /private-undeclared-name/u);
    return true;
  });
});

test('maps thread failure, timeout, runtime cancellation, and stop failure deterministically', async () => {
  const failedHost = createThreadHost();
  const failedAdapter = createAdapter(failedHost);
  const threadFailure = failedAdapter.customAction(payload(), context());
  failedHost.fail(failedHost.latestThread());
  await rejectsCode(threadFailure, 'K4-CUSTOM-THREAD-FAILED');

  const scheduler = createFakeTimeoutScheduler();
  const timeoutHost = createThreadHost();
  const timeoutAdapter = createAdapter(timeoutHost, {scheduleTimeout: scheduler.schedule});
  const timeout = timeoutAdapter.customAction(payload(), context());
  assert.equal(scheduler.scheduled[0].milliseconds, 1_000);
  scheduler.fire();
  await rejectsCode(timeout, 'K4-CUSTOM-TIMEOUT');
  assert.equal(timeoutHost.stops.length, 1);

  const cancelHost = createThreadHost();
  const cancelAdapter = createAdapter(cancelHost);
  const controller = new AbortController();
  const cancelled = cancelAdapter.customAction(payload(), context(controller));
  controller.abort('private runtime reason');
  await assert.rejects(cancelled, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.doesNotMatch(error.message, /private runtime reason/u);
    return true;
  });
  assert.equal(cancelHost.stops.length, 1);

  const cleanupHost = createThreadHost();
  const cleanupAdapter = createAdapter(cleanupHost);
  const cleanup = cleanupAdapter.customAction(payload(), context());
  cleanupHost.setFailStop(true);
  cleanupAdapter.completeCurrentAction({thread: cleanupHost.latestThread()});
  await rejectsCode(cleanup, 'K4-CUSTOM-CLEANUP-FAILED');
});

test('fails a timeout scheduler error once without a false late-terminal diagnostic', async () => {
  const diagnostics = [];
  const internalErrors = [];
  const host = createThreadHost();
  const adapter = createAdapter(host, {
    scheduleTimeout() {
      throw new Error('private scheduler failure');
    },
    onDiagnostic: (entry) => diagnostics.push(entry),
    onInternalError: (error) => internalErrors.push(error),
  });

  await rejectsCode(adapter.customAction(payload(), context()), 'K4-CUSTOM-TIMEOUT');
  assert.equal(host.stops.length, 1);
  assert.deepEqual(diagnostics, []);
  assert.equal(internalErrors.length, 1);
});

test('fails closed when the thread host does not return a completion promise', async () => {
  const host = createThreadHost();
  host.waitForCompletion = () => undefined;
  const adapter = createAdapter(host);

  await rejectsCode(adapter.customAction(payload(), context()), 'K4-CUSTOM-THREAD-FAILED');
  assert.equal(host.stops.length, 1);
});

test('ignores an old thread settlement after cancellation and isolates the next invocation', async () => {
  const host = createThreadHost([1, 1]);
  const adapter = createAdapter(host);
  const firstController = new AbortController();
  const first = adapter.customAction(payload(), context(firstController));
  const firstThread = host.latestThread();
  firstController.abort();
  await assert.rejects(first, {name: 'AbortError'});

  const second = adapter.customAction(payload({count: 2}), context());
  const secondThread = host.latestThread();
  host.complete(firstThread);
  assert.equal(adapter.currentActionArgument('count', {thread: secondThread}), 2);
  host.complete(secondThread);
  assert.deepEqual(await second, {outcome: 'completed'});
});

test('unbinds context immediately but dispose still waits for asynchronous thread cleanup', async () => {
  const host = createThreadHost();
  const cleanup = deferred();
  const stop = host.stop.bind(host);
  host.stop = (thread, reason) => {
    stop(thread, reason);
    return cleanup.promise;
  };
  const adapter = createAdapter(host);
  const resultPromise = adapter.customAction(payload(), context());
  const thread = host.latestThread();
  adapter.completeCurrentAction({thread});
  assert.throws(
    () => adapter.currentActionName({thread}),
    (error) => error.code === 'K4-CUSTOM-CONTEXT-MISSING',
  );

  let disposed = false;
  const disposal = adapter.dispose().then(() => {
    disposed = true;
  });
  await Promise.resolve();
  assert.equal(disposed, false);
  cleanup.resolve();
  assert.deepEqual(await resultPromise, {outcome: 'completed'});
  await disposal;
  assert.equal(disposed, true);
});

test('disposes active invocations once and rejects malformed boundaries before starting', async () => {
  assert.deepEqual(dsl4CustomActionTimeoutDefaults, {
    customActionTimeoutMs: 30_000,
    minimumCustomActionTimeoutMs: 100,
    maximumCustomActionTimeoutMs: 300_000,
    maximumFailureMessageScalars: 256,
  });
  assert.equal(Object.isFrozen(dsl4CustomActionTimeoutDefaults), true);

  const host = createThreadHost();
  const adapter = createAdapter(host);
  const active = adapter.customAction(payload(), context());
  await adapter.dispose();
  await assert.rejects(active, {name: 'AbortError'});
  await adapter.dispose();
  assert.equal(host.stops.length, 1);
  await assert.rejects(adapter.customAction(payload(), context()), /adapter is disposed/u);

  for (const invalidPayload of [
    {name: 'missing', target: 'Hero', arguments: {}},
    {name: 'wave', target: 'Hero', arguments: {speed: 'fast', private: true}},
    {name: 'wave', target: 'Hero', arguments: {speed: 1}},
    {name: 'wave', target: 'Hero', arguments: {}},
  ]) {
    const invalidHost = createThreadHost();
    await assert.rejects(createAdapter(invalidHost).customAction(invalidPayload, context()));
    assert.equal(invalidHost.starts.length, 0);
  }

  const missingResourcesHost = createThreadHost();
  await assert.rejects(
    createAdapter(missingResourcesHost).customAction(payload(), {
      signal: new AbortController().signal,
      actionPath: '/scenes/opening/actions/0',
    }),
    /requires Structured Data resources/u,
  );
  assert.equal(missingResourcesHost.starts.length, 0);
});

test('routes a custom goto outcome through the controller scene transition', async () => {
  const runtimeStory = Object.freeze({
    kind: 'StoryDocument',
    version: '4.0',
    metadata: Object.freeze({sourceId: 'main'}),
    sourceMap: Object.freeze({'/': null}),
    variables: Object.freeze({}),
    actors: Object.freeze({Hero: 'HeroIdle'}),
    branches: Object.freeze({}),
    assets: Object.freeze([]),
    scenes: Object.freeze([
      Object.freeze({
        id: 'opening',
        actions: Object.freeze([
          Object.freeze({
            kind: 'Action',
            id: '/scenes/opening/actions/0',
            target: 'Hero',
            command: 'wave',
            args: Object.freeze({speed: 'fast'}),
            handler: 'custom',
          }),
        ]),
      }),
      Object.freeze({id: 'ending', actions: Object.freeze([])}),
    ]),
  });
  const events = [];
  const controller = createDsl4RuntimeController({
    storyDocument: runtimeStory,
    port: {
      async customAction() {
        return {outcome: 'transitioned', sceneId: 'ending'};
      },
    },
    onEvent: (event) => events.push(event),
  });

  const state = await controller.start();
  assert.equal(state.status, 'finished');
  assert.ok(
    events.some(
      (event) =>
        event.type === 'scene.transition' &&
        event.details.to === 'ending' &&
        event.details.reason === 'customAction',
    ),
  );
});

test('rejects a non-exact custom action outcome at the controller boundary', async () => {
  const runtimeStory = Object.freeze({
    kind: 'StoryDocument',
    version: '4.0',
    metadata: Object.freeze({sourceId: 'main'}),
    sourceMap: Object.freeze({'/scenes/opening/actions/0': null, '/': null}),
    variables: Object.freeze({}),
    actors: Object.freeze({Hero: 'HeroIdle'}),
    branches: Object.freeze({}),
    assets: Object.freeze([]),
    scenes: Object.freeze([
      Object.freeze({
        id: 'opening',
        actions: Object.freeze([
          Object.freeze({
            kind: 'Action',
            id: '/scenes/opening/actions/0',
            target: 'Hero',
            command: 'wave',
            args: Object.freeze({speed: 'fast'}),
            handler: 'custom',
          }),
        ]),
      }),
    ]),
  });
  const controller = createDsl4RuntimeController({
    storyDocument: runtimeStory,
    port: {
      async customAction() {
        return {outcome: 'completed', privateValue: true};
      },
    },
  });

  const state = await controller.start();
  assert.equal(state.status, 'failed');
  assert.equal(state.diagnostic.code, 'K4-RUNTIME-RESULT-001');
});
