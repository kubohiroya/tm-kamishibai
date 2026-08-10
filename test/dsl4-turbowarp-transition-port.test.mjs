import assert from 'node:assert/strict';
import test from 'node:test';

import {createDsl4TurboWarpTransitionPort} from '../src/dsl4/platform/turbowarp-transition-port.js';

function fixture(initialBrightness = 0) {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const calls = [];
  const stage = {
    isStage: true,
    effects: {brightness: initialBrightness},
    setEffect(name, value) {
      calls.push([name, value]);
      this.effects[name] = value;
    },
  };
  const port = createDsl4TurboWarpTransitionPort({
    runtime: {getTargetForStage: () => stage},
    now: () => now,
    scheduler: {
      setTimeout(callback) {
        const id = nextId++;
        timers.set(id, callback);
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    frameMilliseconds: 50,
  });
  return {
    calls,
    port,
    stage,
    tick(milliseconds) {
      now += milliseconds;
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    pendingCount: () => timers.size,
  };
}

function context(controller = new AbortController()) {
  return {controller, value: {signal: controller.signal}};
}

test('renders every DSL 3.2 brightness transition to its exact endpoint', async () => {
  for (const [effect, initial, endpoint] of [
    ['fadeOut', 0, -100],
    ['fadeUp', -100, 0],
    ['fadeToWhite', 0, 100],
    ['fadeFromWhite', 100, 0],
  ]) {
    const current = fixture(initial);
    const operation = current.port.transition({effect, seconds: 1}, context().value);
    current.tick(500);
    assert.equal(current.stage.effects.brightness, initial + (endpoint - initial) * 0.5);
    current.tick(500);
    await operation;
    assert.equal(current.stage.effects.brightness, endpoint);
    assert.equal(current.pendingCount(), 0);
  }

  const reset = fixture(-65);
  await reset.port.transition({effect: 'reset', seconds: 0}, context().value);
  assert.equal(reset.stage.effects.brightness, 0);
});

test('commits the endpoint synchronously before an aborted transition rejects', async () => {
  const current = fixture();
  const active = context();
  const operation = current.port.transition({effect: 'fadeOut', seconds: 1}, active.value);
  current.tick(250);
  assert.equal(current.stage.effects.brightness, -25);

  active.controller.abort('rehearsal-next-action');
  assert.equal(current.stage.effects.brightness, -100);
  await assert.rejects(operation, (error) => error.name === 'AbortError');
  assert.equal(current.pendingCount(), 0);
});

test('rejects unsupported effects and malformed TurboWarp contracts', () => {
  const current = fixture();
  assert.throws(
    () => current.port.transition({effect: 'dissolve', seconds: 1}, context().value),
    /supported effect/u,
  );
  assert.throws(
    () => createDsl4TurboWarpTransitionPort({runtime: {getTargetForStage: () => null}}),
    /Stage target/u,
  );
  current.port.dispose();
  assert.throws(
    () => current.port.transition({effect: 'reset', seconds: 0}, context().value),
    /disposed/u,
  );
});
