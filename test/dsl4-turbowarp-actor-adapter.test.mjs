import assert from 'node:assert/strict';
import test from 'node:test';

import {createDsl4TurboWarpActorPlatform} from '../src/dsl4/platform/index.js';

function fakeActor({id = 'hero-target', actorName = 'Hero', x = 0, y = 0} = {}) {
  const calls = [];
  return {
    calls,
    target: {
      id,
      isStage: false,
      x,
      y,
      lookupVariableByNameAndType(name, type) {
        calls.push(['lookupVariableByNameAndType', name, type]);
        return name === 'actorName' && type === '' ? {value: actorName} : undefined;
      },
      setXY(nextX, nextY) {
        calls.push(['setXY', nextX, nextY]);
        this.x = nextX;
        this.y = nextY;
      },
      setSize(size) {
        calls.push(['setSize', size]);
        this.size = size;
      },
      setVisible(visible) {
        calls.push(['setVisible', visible]);
        this.visible = visible;
      },
    },
  };
}

function manualScheduler() {
  let currentTime = 0;
  let nextId = 1;
  const timers = new Map();
  const calls = [];
  const scheduler = {
    now() {
      return currentTime;
    },
    setTimeout(callback, milliseconds) {
      const id = nextId;
      nextId += 1;
      calls.push(['setTimeout', id, milliseconds]);
      timers.set(id, {callback, due: currentTime + milliseconds});
      return id;
    },
    clearTimeout(id) {
      calls.push(['clearTimeout', id]);
      timers.delete(id);
    },
  };
  return {
    calls,
    scheduler,
    pendingCount: () => timers.size,
    advance(milliseconds) {
      const targetTime = currentTime + milliseconds;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.due <= targetTime)
          .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        currentTime = timer.due;
        timer.callback();
      }
      currentTime = targetTime;
    },
  };
}

function fakeRuntime(targets) {
  const bubbleCalls = [];
  return {
    bubbleCalls,
    runtime: {
      targets,
      ext_scratch3_looks: {
        _say(message, target) {
          bubbleCalls.push([message, target.id]);
        },
      },
    },
  };
}

test('resolves one actorName target and applies show transform and visibility', () => {
  const hero = fakeActor();
  const other = fakeActor({id: 'other-target', actorName: 'Other'});
  const stage = {id: 'stage', isStage: true};
  const fake = fakeRuntime([stage, other.target, hero.target]);
  const clock = manualScheduler();
  const platform = createDsl4TurboWarpActorPlatform({
    runtime: fake.runtime,
    scheduler: clock.scheduler,
  });

  const resolved = platform.resolveActor('Hero');
  platform.host.showActor(resolved, {x: 10, y: -20, scale: 30});

  assert.equal(Object.isFrozen(platform), true);
  assert.equal(Object.isFrozen(platform.host), true);
  assert.equal(resolved, hero.target);
  assert.deepEqual(hero.calls.slice(-3), [
    ['setXY', 10, -20],
    ['setSize', 30],
    ['setVisible', true],
  ]);
});

test('interpolates moveTo and completes exactly at the destination', async () => {
  const hero = fakeActor({x: 0, y: 10});
  const fake = fakeRuntime([hero.target]);
  const clock = manualScheduler();
  const platform = createDsl4TurboWarpActorPlatform({
    runtime: fake.runtime,
    scheduler: clock.scheduler,
    frameMilliseconds: 500,
  });
  const operation = platform.host.createMove(hero.target, {x: 100, y: 50, seconds: 1});
  const pending = operation.start();

  clock.advance(500);
  assert.equal(hero.target.x, 50);
  assert.equal(hero.target.y, 30);
  assert.equal(clock.pendingCount(), 1);
  clock.advance(500);
  await pending;

  assert.equal(hero.target.x, 100);
  assert.equal(hero.target.y, 50);
  assert.equal(clock.pendingCount(), 0);
});

test('moveTo finish synchronously cancels its timer and commits the destination once', async () => {
  const hero = fakeActor({x: -10, y: -20});
  const fake = fakeRuntime([hero.target]);
  const clock = manualScheduler();
  const platform = createDsl4TurboWarpActorPlatform({
    runtime: fake.runtime,
    scheduler: clock.scheduler,
    frameMilliseconds: 100,
  });
  const operation = platform.host.createMove(hero.target, {x: 20, y: 40, seconds: 1});
  const pending = operation.start();
  operation.finish();

  assert.equal(hero.target.x, 20);
  assert.equal(hero.target.y, 40);
  assert.equal(clock.pendingCount(), 0);
  await pending;
  const setXYCount = hero.calls.filter(([method]) => method === 'setXY').length;
  clock.advance(2000);
  operation.finish();
  assert.equal(hero.calls.filter(([method]) => method === 'setXY').length, setXYCount);
});

test('shows and clears say on timeout or synchronous finish', async () => {
  const hero = fakeActor();
  const fake = fakeRuntime([hero.target]);
  const clock = manualScheduler();
  const platform = createDsl4TurboWarpActorPlatform({
    runtime: fake.runtime,
    scheduler: clock.scheduler,
  });
  const timed = platform.host.createSay(hero.target, {text: '助けに行こう', seconds: 2});
  const timedPending = timed.start();
  assert.deepEqual(fake.bubbleCalls, [['助けに行こう', 'hero-target']]);
  clock.advance(2000);
  await timedPending;
  assert.deepEqual(fake.bubbleCalls, [
    ['助けに行こう', 'hero-target'],
    ['', 'hero-target'],
  ]);

  const skipped = platform.host.createSay(hero.target, {text: '待って', seconds: 5});
  const skippedPending = skipped.start();
  skipped.finish();
  assert.deepEqual(fake.bubbleCalls.slice(-2), [
    ['待って', 'hero-target'],
    ['', 'hero-target'],
  ]);
  assert.equal(clock.pendingCount(), 0);
  await skippedPending;
  clock.advance(5000);
  assert.deepEqual(fake.bubbleCalls.at(-1), ['', 'hero-target']);
});

test('handles zero-second operations without retaining a timer', async () => {
  const hero = fakeActor({x: 1, y: 2});
  const fake = fakeRuntime([hero.target]);
  const clock = manualScheduler();
  const platform = createDsl4TurboWarpActorPlatform({
    runtime: fake.runtime,
    scheduler: clock.scheduler,
  });

  await platform.host.createMove(hero.target, {x: 3, y: 4, seconds: 0}).start();
  await platform.host.createSay(hero.target, {text: '', seconds: 0}).start();

  assert.equal(hero.target.x, 3);
  assert.equal(hero.target.y, 4);
  assert.equal(clock.pendingCount(), 0);
  assert.deepEqual(fake.bubbleCalls, [
    ['', 'hero-target'],
    ['', 'hero-target'],
  ]);
});

test('contains a scheduled bubble failure in the say operation promise', async () => {
  const hero = fakeActor();
  const clock = manualScheduler();
  const runtime = {
    targets: [hero.target],
    ext_scratch3_looks: {
      _say(message) {
        if (message === '') throw new Error('bubble clear failed');
      },
    },
  };
  const platform = createDsl4TurboWarpActorPlatform({
    runtime,
    scheduler: clock.scheduler,
  });
  const pending = platform.host.createSay(hero.target, {text: 'hello', seconds: 1}).start();

  clock.advance(1000);
  await assert.rejects(pending, /bubble clear failed/u);
  assert.equal(clock.pendingCount(), 0);
});

test('fails closed for missing, duplicate, malformed, and imprecise actors', () => {
  const hero = fakeActor();
  const duplicate = fakeActor({id: 'duplicate-target'});
  const fake = fakeRuntime([hero.target, duplicate.target]);
  const platform = createDsl4TurboWarpActorPlatform({runtime: fake.runtime});

  assert.equal(platform.resolveActor('hero'), null);
  assert.equal(platform.resolveActor('Missing'), null);
  assert.throws(() => platform.resolveActor('Hero'), /ambiguous/u);
  assert.throws(() => platform.resolveActor(''), /non-empty/u);

  fake.runtime.targets = [
    {
      id: 'malformed',
      isStage: false,
      lookupVariableByNameAndType() {
        return {value: 'Hero'};
      },
    },
  ];
  assert.throws(() => platform.resolveActor('Hero'), /target is invalid/u);
});

test('rejects invalid runtime, scheduler, target, specs, duration, and repeated start', async () => {
  const hero = fakeActor();
  const fake = fakeRuntime([hero.target]);
  assert.throws(() => createDsl4TurboWarpActorPlatform({runtime: {}}), /targets array/u);
  assert.throws(
    () => createDsl4TurboWarpActorPlatform({runtime: {targets: []}}),
    /ext_scratch3_looks/u,
  );
  assert.throws(
    () => createDsl4TurboWarpActorPlatform({runtime: fake.runtime, scheduler: {}}),
    /scheduler/u,
  );
  assert.throws(
    () => createDsl4TurboWarpActorPlatform({runtime: fake.runtime, frameMilliseconds: 0}),
    /greater than zero/u,
  );
  const platform = createDsl4TurboWarpActorPlatform({runtime: fake.runtime});
  assert.throws(() => platform.host.showActor({}, {x: 0, y: 0, scale: 1}), /target/u);
  assert.throws(() => platform.host.showActor(hero.target, {x: 0, y: 0, scale: 0}), /positive/u);
  assert.throws(
    () => platform.host.createMove(hero.target, {x: 0, y: 0, seconds: Number.MAX_VALUE}),
    /finite non-negative duration/u,
  );
  assert.throws(
    () => platform.host.createSay(hero.target, {text: 1, seconds: 0}),
    /text must be a string/u,
  );
  const movement = platform.host.createMove(hero.target, {x: 0, y: 0, seconds: 0});
  await movement.start();
  assert.throws(() => movement.start(), /only start once/u);
});

test('keeps platform instances and their schedulers isolated', async () => {
  const firstActor = fakeActor({id: 'first'});
  const secondActor = fakeActor({id: 'second'});
  const firstRuntime = fakeRuntime([firstActor.target]);
  const secondRuntime = fakeRuntime([secondActor.target]);
  const firstClock = manualScheduler();
  const secondClock = manualScheduler();
  const first = createDsl4TurboWarpActorPlatform({
    runtime: firstRuntime.runtime,
    scheduler: firstClock.scheduler,
  });
  const second = createDsl4TurboWarpActorPlatform({
    runtime: secondRuntime.runtime,
    scheduler: secondClock.scheduler,
  });

  const firstPending = first.host.createSay(firstActor.target, {text: 'first', seconds: 1}).start();
  const secondPending = second.host
    .createSay(secondActor.target, {text: 'second', seconds: 1})
    .start();
  firstClock.advance(1000);
  await firstPending;

  assert.deepEqual(firstRuntime.bubbleCalls.at(-1), ['', 'first']);
  assert.deepEqual(secondRuntime.bubbleCalls, [['second', 'second']]);
  secondClock.advance(1000);
  await secondPending;
});
