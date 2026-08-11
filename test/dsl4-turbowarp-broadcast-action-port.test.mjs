import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';

import {createDsl4TurboWarpBroadcastActionPort} from '../src/dsl4/platform/index.js';

class FakeTurboWarpRuntime extends EventEmitter {
  constructor(messages = ['message']) {
    super();
    this.threads = [];
    this.starts = [];
    this.stops = [];
    this.queuedReceivers = [];
    this.stage = {
      variables: Object.fromEntries(
        messages.map((name, index) => [
          `broadcast-${index}`,
          {id: `broadcast-${index}`, name, type: 'broadcast_msg'},
        ]),
      ),
    };
  }

  getTargetForStage() {
    return this.stage;
  }

  queueThreads(...threads) {
    this.queuedReceivers.push(threads);
    return threads;
  }

  startHats(opcode, fields) {
    this.starts.push({opcode, fields: {...fields}});
    const threads = this.queuedReceivers.shift() ?? [];
    this.threads.push(...threads);
    return threads;
  }

  _stopThread(thread) {
    this.stops.push(thread);
    this.finish(thread);
  }

  finish(thread) {
    const index = this.threads.indexOf(thread);
    if (index !== -1) this.threads.splice(index, 1);
    this.emit('AFTER_EXECUTE');
  }
}

function context(controller = new AbortController()) {
  return {signal: controller.signal};
}

async function assertPending(promise) {
  let settled = false;
  promise.finally(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
}

test('broadcasts once and waits for every owned Stage, sprite, and clone receiver thread', async () => {
  const runtime = new FakeTurboWarpRuntime(['Opening Effect']);
  const threads = runtime.queueThreads(
    {id: 'stage-thread'},
    {id: 'sprite-thread'},
    {id: 'clone-thread'},
  );
  const port = createDsl4TurboWarpBroadcastActionPort({runtime});
  const operation = port.broadcastMessageAndWait({message: 'Opening Effect'}, context());

  assert.deepEqual(runtime.starts, [
    {
      opcode: 'event_whenbroadcastreceived',
      fields: {BROADCAST_OPTION: 'Opening Effect'},
    },
  ]);
  await assertPending(operation);
  runtime.finish(threads[0]);
  runtime.finish(threads[1]);
  await assertPending(operation);
  runtime.finish(threads[2]);
  await operation;
  assert.equal(runtime.listenerCount('AFTER_EXECUTE'), 0);
});

test('completes immediately for an exact declared message with no receivers', async () => {
  const runtime = new FakeTurboWarpRuntime(['message']);
  const port = createDsl4TurboWarpBroadcastActionPort({runtime});

  await port.broadcastMessageAndWait({message: 'message'}, context());
  assert.equal(runtime.starts.length, 1);
  assert.deepEqual(runtime.starts[0].fields, {BROADCAST_OPTION: 'message'});
});

test('does not case-fold, trim, or alias an undeclared message name', async () => {
  const runtime = new FakeTurboWarpRuntime(['Message', ' spaced ']);
  const port = createDsl4TurboWarpBroadcastActionPort({runtime});

  await port.broadcastMessageAndWait({message: 'message'}, context());
  await port.broadcastMessageAndWait({message: 'spaced'}, context());
  assert.deepEqual(runtime.starts, []);
});

test('abort stops only threads owned by that invocation and rejects after cleanup', async () => {
  const runtime = new FakeTurboWarpRuntime(['message']);
  const firstThreads = runtime.queueThreads({id: 'first-stage'}, {id: 'first-clone'});
  const secondThreads = runtime.queueThreads({id: 'second-stage'});
  const firstPort = createDsl4TurboWarpBroadcastActionPort({runtime});
  const secondPort = createDsl4TurboWarpBroadcastActionPort({runtime});
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = firstPort.broadcastMessageAndWait({message: 'message'}, context(firstController));
  const second = secondPort.broadcastMessageAndWait(
    {message: 'message'},
    context(secondController),
  );

  firstController.abort('scene-skip');
  await assert.rejects(first, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'K4-BROADCAST-CANCELLED');
    return true;
  });
  assert.deepEqual(runtime.stops, firstThreads);
  assert.equal(runtime.threads.includes(secondThreads[0]), true);
  await assertPending(second);
  runtime.finish(secondThreads[0]);
  await second;
});

test('dispose cancels every active invocation without stopping unrelated threads', async () => {
  const runtime = new FakeTurboWarpRuntime(['message']);
  const owned = runtime.queueThreads({id: 'owned'});
  const unrelated = {id: 'unrelated'};
  runtime.threads.push(unrelated);
  const port = createDsl4TurboWarpBroadcastActionPort({runtime});
  const operation = port.broadcastMessageAndWait({message: 'message'}, context());

  port.dispose();
  await assert.rejects(operation, (error) => error.code === 'K4-BROADCAST-CANCELLED');
  assert.deepEqual(runtime.stops, owned);
  assert.equal(runtime.threads.includes(unrelated), true);
  await assert.rejects(
    port.broadcastMessageAndWait({message: 'message'}, context()),
    (error) => error.code === 'K4-BROADCAST-DISPOSED',
  );
});

test('rejects malformed payloads, contexts, and runtime contracts with stable errors', async () => {
  const runtime = new FakeTurboWarpRuntime(['message']);
  const port = createDsl4TurboWarpBroadcastActionPort({runtime});
  for (const payload of [null, {}, {message: ''}, {message: 1}, {message: 'ok', extra: true}]) {
    await assert.rejects(
      Promise.resolve().then(() => port.broadcastMessageAndWait(payload, context())),
      (error) => error.code === 'K4-BROADCAST-PAYLOAD-001',
    );
  }
  await assert.rejects(
    Promise.resolve().then(() =>
      port.broadcastMessageAndWait({message: 'message'}, {signal: null}),
    ),
    (error) => error.code === 'K4-BROADCAST-CONTEXT-001',
  );
  for (const options of [undefined, {}, {runtime: {}}, {runtime: {...runtime, threads: null}}]) {
    assert.throws(
      () => createDsl4TurboWarpBroadcastActionPort(options),
      (error) => error.code === 'K4-BROADCAST-RUNTIME-001',
    );
  }
});

test('normalizes start, observer setup, and cancellation cleanup failures', async () => {
  const startFailure = new FakeTurboWarpRuntime(['message']);
  startFailure.startHats = () => {
    throw new Error('start failed');
  };
  const startPort = createDsl4TurboWarpBroadcastActionPort({runtime: startFailure});
  await assert.rejects(
    Promise.resolve().then(() =>
      startPort.broadcastMessageAndWait({message: 'message'}, context()),
    ),
    (error) => error.code === 'K4-BROADCAST-START-001',
  );

  const observerFailure = new FakeTurboWarpRuntime(['message']);
  const observerThreads = observerFailure.queueThreads({id: 'observer-thread'});
  observerFailure.on = () => {
    throw new Error('listener failed');
  };
  const observerPort = createDsl4TurboWarpBroadcastActionPort({runtime: observerFailure});
  await assert.rejects(
    observerPort.broadcastMessageAndWait({message: 'message'}, context()),
    (error) => error.code === 'K4-BROADCAST-RUNTIME-001',
  );
  assert.deepEqual(observerFailure.stops, observerThreads);
  assert.deepEqual(observerFailure.threads, []);

  const cleanupFailure = new FakeTurboWarpRuntime(['message']);
  cleanupFailure.queueThreads({id: 'cleanup-thread'});
  cleanupFailure._stopThread = () => {
    throw new Error('stop failed');
  };
  const cleanupController = new AbortController();
  const cleanupPort = createDsl4TurboWarpBroadcastActionPort({runtime: cleanupFailure});
  const operation = cleanupPort.broadcastMessageAndWait(
    {message: 'message'},
    context(cleanupController),
  );
  cleanupController.abort();
  await assert.rejects(operation, (error) => error.code === 'K4-BROADCAST-CLEANUP-001');
  assert.equal(cleanupFailure.listenerCount('AFTER_EXECUTE'), 0);
});
