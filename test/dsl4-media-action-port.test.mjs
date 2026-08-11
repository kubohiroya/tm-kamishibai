import assert from 'node:assert/strict';
import test from 'node:test';

import {createDsl4MediaActionPort} from '../src/dsl4/platform/index.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

function fakeComposition(overrides = {}) {
  const calls = [];
  const assets = new Map([
    ['Beach', 'image/svg+xml'],
    ['HeroHappy', 'image/png'],
    ['Fish1', 'image/png'],
    ['Fish2', 'image/png'],
    ['OpeningSound', 'audio/wav'],
  ]);
  return {
    calls,
    assets,
    composition: {
      isRegistered(name) {
        calls.push(['isRegistered', name]);
        return assets.has(name);
      },
      getMimeType(name) {
        calls.push(['getMimeType', name]);
        return assets.get(name) ?? '';
      },
      async applyToStage(name) {
        calls.push(['applyToStage', name]);
      },
      async applyToTarget(name, target) {
        calls.push(['applyToTarget', name, target.id]);
      },
      async playSound(name, options) {
        calls.push(['playSound', name, options]);
      },
      stopSound(name) {
        calls.push(['stopSound', name]);
      },
      ...overrides,
    },
  };
}

function actionContext(controller = new AbortController()) {
  return {signal: controller.signal, generation: 1, sceneId: 'opening'};
}

function manualScheduler() {
  let nextId = 1;
  const timers = new Map();
  return {
    scheduler: {
      setTimeout(callback, milliseconds) {
        const id = nextId++;
        timers.set(id, {callback, milliseconds});
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    pendingCount: () => timers.size,
    runNext() {
      const [id, timer] = timers.entries().next().value ?? [];
      if (!timer) return false;
      timers.delete(id);
      timer.callback();
      return timer.milliseconds;
    },
  };
}

function actionCalls(calls) {
  return calls.filter(([method]) =>
    ['applyToStage', 'applyToTarget', 'playSound', 'stopSound'].includes(method),
  );
}

test('maps stage, bgm, sound, and setSkin to one shared Asset Manager composition', async () => {
  const fake = fakeComposition();
  const actor = Object.freeze({id: 'hero-target', isStage: false});
  const resolved = [];
  const session = Object.freeze({assetManagerComposition: fake.composition});
  const port = createDsl4MediaActionPort({
    composition: session.assetManagerComposition,
    resolveActor(actorId, context) {
      resolved.push([actorId, context.sceneId]);
      return actor;
    },
  });

  await port.stage({backdrop: 'Beach'}, actionContext());
  await port.bgm({sound: 'OpeningSound'}, actionContext());
  await port.sound({sound: 'OpeningSound'}, actionContext());
  await port.setSkin({target: 'Hero', skin: 'HeroHappy'}, actionContext());

  assert.equal(Object.isFrozen(port), true);
  assert.deepEqual(actionCalls(fake.calls), [
    ['applyToStage', 'Beach'],
    ['playSound', 'OpeningSound', undefined],
    ['playSound', 'OpeningSound', {untilDone: true}],
    ['applyToTarget', 'HeroHappy', 'hero-target'],
  ]);
  assert.deepEqual(resolved, [['Hero', 'opening']]);
});

test('applies setSkin scale and runs a cancellable deterministic background costume loop', async () => {
  const fake = fakeComposition();
  const clock = manualScheduler();
  const actor = Object.freeze({id: 'fish-target', isStage: false});
  const scales = [];
  const port = createDsl4MediaActionPort({
    composition: fake.composition,
    resolveActor: () => actor,
    setActorScale(target, scale) {
      scales.push([target.id, scale]);
    },
    scheduler: clock.scheduler,
  });

  await port.setSkin({target: 'Fish', skin: 'Fish1', scale: 45}, actionContext());
  await port.loop(
    {
      target: 'Fish',
      steps: [
        {skin: 'Fish1', seconds: 0.3},
        {skin: 'Fish2', seconds: 0.4},
      ],
    },
    actionContext(),
  );
  assert.equal(clock.pendingCount(), 1);
  assert.equal(clock.runNext(), 300);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(scales, [['fish-target', 45]]);
  assert.deepEqual(actionCalls(fake.calls), [
    ['applyToTarget', 'Fish1', 'fish-target'],
    ['applyToTarget', 'Fish1', 'fish-target'],
    ['applyToTarget', 'Fish2', 'fish-target'],
  ]);

  port.dispose();
  assert.equal(clock.pendingCount(), 0);
});

test('serializes a replacement skin after an in-flight loop skin', async () => {
  const inFlightLoopSkin = deferred();
  const applications = [];
  const fake = fakeComposition({
    applyToTarget(name, target) {
      applications.push([name, target.id]);
      if (applications.length === 2) return inFlightLoopSkin.promise;
    },
  });
  const clock = manualScheduler();
  const port = createDsl4MediaActionPort({
    composition: fake.composition,
    resolveActor: () => ({id: 'fish-target', isStage: false}),
    scheduler: clock.scheduler,
  });

  await port.loop(
    {
      target: 'Fish',
      steps: [
        {skin: 'Fish1', seconds: 0.3},
        {skin: 'Fish2', seconds: 0.3},
      ],
    },
    actionContext(),
  );
  clock.runNext();
  await Promise.resolve();
  const replacement = port.setSkin({target: 'Fish', skin: 'HeroHappy'}, actionContext());

  await Promise.resolve();
  assert.deepEqual(applications, [
    ['Fish1', 'fish-target'],
    ['Fish2', 'fish-target'],
  ]);
  inFlightLoopSkin.resolve();
  await replacement;
  assert.deepEqual(applications, [
    ['Fish1', 'fish-target'],
    ['Fish2', 'fish-target'],
    ['HeroHappy', 'fish-target'],
  ]);
  assert.equal(clock.pendingCount(), 0);
});

test('does not let a failed superseded loop stop its replacement loop', async () => {
  const staleApplication = deferred();
  const backgroundErrors = [];
  const applications = [];
  const fake = fakeComposition({
    applyToTarget(name, target) {
      applications.push([name, target.id]);
      if (applications.length === 2) return staleApplication.promise;
    },
  });
  const clock = manualScheduler();
  const port = createDsl4MediaActionPort({
    composition: fake.composition,
    resolveActor: () => ({id: 'fish-target', isStage: false}),
    scheduler: clock.scheduler,
    onBackgroundError(error) {
      backgroundErrors.push(error);
    },
  });
  const loop = {
    target: 'Fish',
    steps: [
      {skin: 'Fish1', seconds: 0.3},
      {skin: 'Fish2', seconds: 0.3},
    ],
  };

  await port.loop(loop, actionContext());
  clock.runNext();
  await Promise.resolve();
  const replacement = port.loop(loop, actionContext());
  staleApplication.reject(new Error('stale loop failure'));
  await replacement;
  await Promise.resolve();

  assert.equal(backgroundErrors.length, 1);
  assert.match(backgroundErrors[0].message, /stale loop failure/u);
  assert.equal(clock.pendingCount(), 1);
  assert.deepEqual(applications, [
    ['Fish1', 'fish-target'],
    ['Fish2', 'fish-target'],
    ['Fish1', 'fish-target'],
  ]);
  port.dispose();
});

test('stops only an until-done sound and rejects with AbortError on cancellation', async () => {
  const playback = deferred();
  const fake = fakeComposition({
    playSound(name, options) {
      fake.calls.push(['playSound', name, options]);
      return playback.promise;
    },
  });
  const port = createDsl4MediaActionPort({
    composition: fake.composition,
    resolveActor() {
      return {id: 'actor', isStage: false};
    },
  });
  const controller = new AbortController();
  const pending = port.sound({sound: 'OpeningSound'}, actionContext(controller));
  controller.abort('navigation');

  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.deepEqual(actionCalls(fake.calls), [
    ['playSound', 'OpeningSound', {untilDone: true}],
    ['stopSound', 'OpeningSound'],
  ]);
  playback.reject(new Error('late playback failure'));
  await Promise.resolve();
});

test('contains stale pending settlement after a non-sound operation is cancelled', async () => {
  const application = deferred();
  const fake = fakeComposition({
    applyToStage(name) {
      fake.calls.push(['applyToStage', name]);
      return application.promise;
    },
  });
  const port = createDsl4MediaActionPort({
    composition: fake.composition,
    resolveActor() {
      return {id: 'actor', isStage: false};
    },
  });
  const controller = new AbortController();
  const pending = port.stage({backdrop: 'Beach'}, actionContext(controller));
  controller.abort('runtime-stop');

  await assert.rejects(pending, (error) => error.name === 'AbortError');
  application.reject(new Error('late stage failure'));
  await Promise.resolve();
  assert.deepEqual(actionCalls(fake.calls), [['applyToStage', 'Beach']]);
});

test('rejects malformed, missing, mistyped, and unresolved inputs before action side effects', async () => {
  const fake = fakeComposition();
  let resolverCalls = 0;
  const port = createDsl4MediaActionPort({
    composition: fake.composition,
    resolveActor() {
      resolverCalls += 1;
      return null;
    },
  });
  const invalidPayloads = [
    () => port.stage({}, actionContext()),
    () => port.bgm({sound: ''}, actionContext()),
    () => port.sound({sound: 'OpeningSound', extra: true}, actionContext()),
    () => port.setSkin({target: 'Hero'}, actionContext()),
    () => port.stage({backdrop: 'Beach'}, {}),
  ];
  for (const invoke of invalidPayloads) {
    await assert.rejects(async () => invoke(), /media action|payload|must provide|non-empty/u);
  }
  assert.deepEqual(fake.calls, []);

  await assert.rejects(
    async () => port.stage({backdrop: 'Missing'}, actionContext()),
    /not registered/u,
  );
  await assert.rejects(
    async () => port.stage({backdrop: 'OpeningSound'}, actionContext()),
    /image MIME/u,
  );
  await assert.rejects(async () => port.sound({sound: 'Beach'}, actionContext()), /audio MIME/u);
  await assert.rejects(
    port.setSkin({target: 'Unknown', skin: 'HeroHappy'}, actionContext()),
    /Actor target is unavailable/u,
  );
  assert.equal(resolverCalls, 1);
  assert.deepEqual(actionCalls(fake.calls), []);
});

test('does not inspect composition or resolve actors for a pre-aborted action', async () => {
  const fake = fakeComposition();
  let resolverCalls = 0;
  const port = createDsl4MediaActionPort({
    composition: fake.composition,
    resolveActor() {
      resolverCalls += 1;
      return {id: 'actor', isStage: false};
    },
  });
  const controller = new AbortController();
  controller.abort('already-stopped');

  await assert.rejects(
    async () => port.stage({backdrop: 'Beach'}, actionContext(controller)),
    (error) => error.name === 'AbortError',
  );
  await assert.rejects(
    async () => port.setSkin({target: 'Hero', skin: 'HeroHappy'}, actionContext(controller)),
    (error) => error.name === 'AbortError',
  );
  assert.deepEqual(fake.calls, []);
  assert.equal(resolverCalls, 0);
});

test('validates every media action dependency before use', () => {
  assert.throws(
    () => createDsl4MediaActionPort({composition: {}, resolveActor() {}}),
    /Asset Manager composition/u,
  );
  assert.throws(
    () => createDsl4MediaActionPort({composition: fakeComposition().composition}),
    /resolveActor/u,
  );
});
