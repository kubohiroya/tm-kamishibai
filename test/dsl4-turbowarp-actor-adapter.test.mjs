import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4TurboWarpActorPlatform} from '../src/dsl4/platform/index.js';
import {createTestTurboWarpRuntimeHost} from './helpers/turbowarp-runtime-host.mjs';

function fakeActor({id = 'hero-target', actorName = 'Hero', name, x = 0, y = 0} = {}) {
  const calls = [];
  return {
    calls,
    target: {
      id,
      ...(name === undefined ? {} : {name}),
      isStage: false,
      x,
      y,
      lookupVariableByNameAndType(name, type) {
        calls.push(['lookupVariableByNameAndType', name, type]);
        return name === 'actorName' && type === '' && actorName !== null
          ? {value: actorName}
          : undefined;
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
      setEffect(effect, value) {
        calls.push(['setEffect', effect, value]);
      },
      goToFront() {
        calls.push(['goToFront']);
      },
      goToBack() {
        calls.push(['goToBack']);
      },
      goForwardLayers(count) {
        calls.push(['goForwardLayers', count]);
      },
      goBackwardLayers(count) {
        calls.push(['goBackwardLayers', count]);
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
  const runtime = {
    targets,
    ext_scratch3_looks: {
      _say(message, target) {
        bubbleCalls.push([message, target.id]);
      },
    },
  };
  return {bubbleCalls, runtime, runtimeHost: createTestTurboWarpRuntimeHost(runtime)};
}

test('resolves one actorName target and applies show transform and visibility', () => {
  const hero = fakeActor();
  const other = fakeActor({id: 'other-target', actorName: 'Other'});
  const stage = {id: 'stage', isStage: true};
  const fake = fakeRuntime([stage, other.target, hero.target]);
  const clock = manualScheduler();
  const platform = createDsl4TurboWarpActorPlatform({
    runtimeHost: fake.runtimeHost,
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

test('resolves a standalone DSL 4.0 actor by its project target name', () => {
  const hero = fakeActor({actorName: null, name: 'Hero'});
  const fake = fakeRuntime([hero.target]);
  const platform = createDsl4TurboWarpActorPlatform({runtimeHost: fake.runtimeHost});

  assert.equal(platform.resolveActor('Hero'), hero.target);
});

test('applies hide, scale, and absolute or relative layer changes to one actor', () => {
  const hero = fakeActor();
  const fake = fakeRuntime([hero.target]);
  const platform = createDsl4TurboWarpActorPlatform({runtimeHost: fake.runtimeHost});

  platform.host.hideActor(platform.resolveActor('Hero'));
  platform.host.setActorScale(hero.target, 45);
  for (const layer of ['front', 'back', 2, -3]) {
    platform.host.setActorLayer(hero.target, layer);
  }

  assert.deepEqual(hero.calls.slice(-6), [
    ['setVisible', false],
    ['setSize', 45],
    ['goToFront'],
    ['goToBack'],
    ['goForwardLayers', 2],
    ['goBackwardLayers', 3],
  ]);
});

test('maps transparency 0, 50, and 100 directly to the Scratch ghost effect', () => {
  const hero = fakeActor();
  const fake = fakeRuntime([hero.target]);
  const platform = createDsl4TurboWarpActorPlatform({runtimeHost: fake.runtimeHost});

  for (const transparency of [0, 50, 100]) {
    platform.host.setTransparency(hero.target, {transparency});
  }

  assert.deepEqual(
    hero.calls.filter(([method]) => method === 'setEffect'),
    [
      ['setEffect', 'ghost', 0],
      ['setEffect', 'ghost', 50],
      ['setEffect', 'ghost', 100],
    ],
  );
});

test('linearly interpolates transparency from 0 to 50', async () => {
  const hero = fakeActor();
  const fake = fakeRuntime([hero.target]);
  const clock = manualScheduler();
  const platform = createDsl4TurboWarpActorPlatform({
    runtimeHost: fake.runtimeHost,
    scheduler: clock.scheduler,
    frameMilliseconds: 500,
  });
  const operation = platform.host.createTransparencyTransition(hero.target, {
    from: 0,
    to: 50,
    seconds: 1,
  });
  const pending = operation.start();

  assert.deepEqual(hero.calls.at(-1), ['setEffect', 'ghost', 0]);
  clock.advance(500);
  assert.deepEqual(hero.calls.at(-1), ['setEffect', 'ghost', 25]);
  assert.equal(clock.pendingCount(), 1);
  clock.advance(500);
  await pending;

  assert.deepEqual(
    hero.calls.filter(([method]) => method === 'setEffect'),
    [
      ['setEffect', 'ghost', 0],
      ['setEffect', 'ghost', 25],
      ['setEffect', 'ghost', 50],
    ],
  );
  assert.equal(clock.pendingCount(), 0);
});

test('crossfades actor visibility and restores the authored ghost baseline', async () => {
  const hero = fakeActor();
  hero.target.effects = {ghost: 20};
  const fake = fakeRuntime([hero.target]);
  const clock = manualScheduler();
  const platform = createDsl4TurboWarpActorPlatform({
    runtimeHost: fake.runtimeHost,
    scheduler: clock.scheduler,
    frameMilliseconds: 500,
  });

  const show = platform.host.createVisibilityTransition(hero.target, {
    visible: true,
    seconds: 1,
    easing: 'linear',
  });
  const showing = show.start();
  clock.advance(500);
  assert.deepEqual(hero.calls.at(-1), ['setEffect', 'ghost', 60]);
  clock.advance(500);
  await showing;
  assert.deepEqual(hero.calls.slice(-2), [
    ['setVisible', true],
    ['setEffect', 'ghost', 20],
  ]);

  const hide = platform.host.createVisibilityTransition(hero.target, {
    visible: false,
    seconds: 1,
    easing: 'linear',
  });
  const hiding = hide.start();
  clock.advance(500);
  assert.deepEqual(hero.calls.at(-1), ['setEffect', 'ghost', 60]);
  clock.advance(500);
  await hiding;
  assert.deepEqual(hero.calls.slice(-3), [
    ['setEffect', 'ghost', 100],
    ['setVisible', false],
    ['setEffect', 'ghost', 20],
  ]);
});

test('transparency finish synchronously commits the final state and cancels its timer', async () => {
  const hero = fakeActor();
  const fake = fakeRuntime([hero.target]);
  const clock = manualScheduler();
  const platform = createDsl4TurboWarpActorPlatform({
    runtimeHost: fake.runtimeHost,
    scheduler: clock.scheduler,
    frameMilliseconds: 250,
  });
  const operation = platform.host.createTransparencyTransition(hero.target, {
    from: 0,
    to: 50,
    seconds: 1,
  });
  const pending = operation.start();
  clock.advance(250);
  operation.finish();

  assert.deepEqual(hero.calls.at(-1), ['setEffect', 'ghost', 50]);
  assert.equal(clock.pendingCount(), 0);
  await pending;
  const effectCallCount = hero.calls.filter(([method]) => method === 'setEffect').length;
  clock.advance(2000);
  operation.finish();
  assert.equal(hero.calls.filter(([method]) => method === 'setEffect').length, effectCallCount);
});

test('keeps foreground transparency pending until finalization retry succeeds', async () => {
  const hero = fakeActor();
  const originalSetEffect = hero.target.setEffect.bind(hero.target);
  let finalizationFailures = 1;
  hero.target.setEffect = (effect, value) => {
    originalSetEffect(effect, value);
    if (value === 50 && finalizationFailures > 0) {
      finalizationFailures -= 1;
      throw new Error('finalization failed');
    }
  };
  const fake = fakeRuntime([hero.target]);
  const clock = manualScheduler();
  const platform = createDsl4TurboWarpActorPlatform({
    runtimeHost: fake.runtimeHost,
    scheduler: clock.scheduler,
  });
  const operation = platform.host.createTransparencyTransition(hero.target, {
    from: 0,
    to: 50,
    seconds: 1,
  });
  const pending = operation.start();
  let settlement = 'pending';
  void pending.then(
    () => {
      settlement = 'resolved';
    },
    () => {
      settlement = 'rejected';
    },
  );

  assert.throws(() => operation.finish(), /finalization failed/u);
  await Promise.resolve();
  assert.equal(settlement, 'pending');
  assert.equal(clock.pendingCount(), 0);

  operation.finish();
  await pending;
  assert.equal(settlement, 'resolved');
  assert.deepEqual(
    hero.calls.filter(([method]) => method === 'setEffect'),
    [
      ['setEffect', 'ghost', 0],
      ['setEffect', 'ghost', 50],
      ['setEffect', 'ghost', 50],
    ],
  );
});

test('retains failed background finalization and retries it at each lifecycle boundary', async () => {
  const hero = fakeActor();
  const originalSetEffect = hero.target.setEffect.bind(hero.target);
  let interpolationFailures = 1;
  let finalizationFailures = 2;
  hero.target.setEffect = (effect, value) => {
    originalSetEffect(effect, value);
    if (value === 25 && interpolationFailures > 0) {
      interpolationFailures -= 1;
      throw new Error('interpolation failed');
    }
    if (value === 50 && finalizationFailures > 0) {
      finalizationFailures -= 1;
      throw new Error('finalization failed');
    }
  };
  const fake = fakeRuntime([hero.target]);
  const clock = manualScheduler();
  const platform = createDsl4TurboWarpActorPlatform({
    runtimeHost: fake.runtimeHost,
    scheduler: clock.scheduler,
    frameMilliseconds: 500,
  });
  const operation = platform.host.createTransparencyTransition(hero.target, {
    from: 0,
    to: 50,
    seconds: 1,
  });
  operation.startBackground();

  clock.advance(500);
  await Promise.resolve();
  assert.equal(clock.pendingCount(), 0);
  assert.throws(
    () => platform.finishTransparencyTransitions(),
    /transparency transition cleanup failed/u,
  );

  platform.finishTransparencyTransitions();
  assert.deepEqual(hero.calls.at(-1), ['setEffect', 'ghost', 50]);
  const effectCallCount = hero.calls.filter(([method]) => method === 'setEffect').length;
  platform.finishTransparencyTransitions();
  assert.equal(hero.calls.filter(([method]) => method === 'setEffect').length, effectCallCount);
});

test('new transitions and platform cleanup finish the previous actor transition first', async () => {
  const hero = fakeActor();
  const fake = fakeRuntime([hero.target]);
  const clock = manualScheduler();
  const platform = createDsl4TurboWarpActorPlatform({
    runtimeHost: fake.runtimeHost,
    scheduler: clock.scheduler,
    frameMilliseconds: 250,
  });
  const first = platform.host.createTransparencyTransition(hero.target, {
    from: 0,
    to: 50,
    seconds: 1,
  });
  const second = platform.host.createTransparencyTransition(hero.target, {
    from: 60,
    to: 80,
    seconds: 1,
  });
  const firstPending = first.start();
  clock.advance(250);
  const secondPending = second.start();
  await firstPending;

  assert.deepEqual(hero.calls.filter(([method]) => method === 'setEffect').slice(-2), [
    ['setEffect', 'ghost', 50],
    ['setEffect', 'ghost', 60],
  ]);
  assert.equal(clock.pendingCount(), 1);

  platform.finishTransparencyTransitions();
  assert.deepEqual(hero.calls.at(-1), ['setEffect', 'ghost', 80]);
  assert.equal(clock.pendingCount(), 0);
  await secondPending;

  const third = platform.host.createTransparencyTransition(hero.target, {
    from: 80,
    to: 90,
    seconds: 1,
  });
  const thirdPending = third.start();
  platform.dispose();
  assert.deepEqual(hero.calls.at(-1), ['setEffect', 'ghost', 90]);
  assert.equal(clock.pendingCount(), 0);
  await thirdPending;
  assert.throws(() => platform.resolveActor('Hero'), /disposed/u);
});

test('interpolates moveTo and completes exactly at the destination', async () => {
  const hero = fakeActor({x: 0, y: 10});
  const fake = fakeRuntime([hero.target]);
  const clock = manualScheduler();
  const platform = createDsl4TurboWarpActorPlatform({
    runtimeHost: fake.runtimeHost,
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
  assert.equal(hero.calls.filter(([method]) => method === 'setXY').length, 2);
});

test('applies named moveTo easing curves to normalized elapsed time', async () => {
  const expectedQuarterProgress = {
    linear: 0.25,
    easeIn: 0.0625,
    easeOut: 0.4375,
    easeInOut: 0.125,
  };

  for (const [easing, expectedProgress] of Object.entries(expectedQuarterProgress)) {
    const hero = fakeActor({x: 0, y: 100});
    const fake = fakeRuntime([hero.target]);
    const clock = manualScheduler();
    const platform = createDsl4TurboWarpActorPlatform({
      runtimeHost: fake.runtimeHost,
      scheduler: clock.scheduler,
      frameMilliseconds: 250,
    });
    const pending = platform.host
      .createMove(hero.target, {x: 100, y: -100, seconds: 1, easing})
      .start();

    clock.advance(250);
    assert.equal(hero.target.x, 100 * expectedProgress, easing);
    assert.equal(hero.target.y, 100 - 200 * expectedProgress, easing);
    clock.advance(750);
    await pending;
    assert.equal(hero.target.x, 100, easing);
    assert.equal(hero.target.y, -100, easing);
    assert.equal(clock.pendingCount(), 0, easing);
  }
});

test('moveTo finish synchronously cancels its timer and commits the destination once', async () => {
  const hero = fakeActor({x: -10, y: -20});
  const fake = fakeRuntime([hero.target]);
  const clock = manualScheduler();
  const platform = createDsl4TurboWarpActorPlatform({
    runtimeHost: fake.runtimeHost,
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
    runtimeHost: fake.runtimeHost,
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

test('renders typewriter speech through one Bubble handle and closes it on advance', async () => {
  const hero = fakeActor();
  const clock = manualScheduler();
  const calls = [];
  const handle = {
    async setText(text) {
      calls.push(['setText', text]);
    },
    async setAnimationMode(mode) {
      calls.push(['setAnimationMode', mode]);
    },
    async close() {
      calls.push(['close']);
    },
  };
  const bubbleComposition = {
    async show(input) {
      calls.push(['show', input]);
      return handle;
    },
    async releaseAll() {},
  };
  const platform = createDsl4TurboWarpActorPlatform({
    runtimeHost: createTestTurboWarpRuntimeHost({targets: [hero.target]}),
    scheduler: clock.scheduler,
    speechAdvanceTypewriterEnabled: true,
    bubbleComposition,
  });
  const operation = platform.host.createThink(hero.target, {
    text: '浦島',
    waitFor: 'advance',
    bubbleStyle: 'dialogue',
    characterIntervalSeconds: 0.1,
  });
  const pending = operation.start();
  for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();

  assert.deepEqual(calls[0], [
    'show',
    {
      actor: hero.target,
      actorKey: 'hero-target',
      kind: 'think',
      text: '浦',
      styleName: 'dialogue',
      animationMode: 'talking',
    },
  ]);
  clock.advance(100);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls.slice(1), [
    ['setText', '浦島'],
    ['setAnimationMode', 'awaiting-continue'],
  ]);

  operation.finish('advance');
  await pending;
  assert.deepEqual(calls.at(-1), ['close']);
  assert.equal(clock.pendingCount(), 0);
});

test('drives Bubble native reveal units and preserves finish audio lifecycle', async () => {
  const hero = fakeActor();
  const clock = manualScheduler();
  const calls = [];
  const handle = {
    async animate(motion) {
      calls.push(['animate', motion]);
    },
    async revealNext() {
      calls.push(['revealNext']);
      return true;
    },
    async revealAll() {
      calls.push(['revealAll']);
    },
    async finish() {
      calls.push(['finish']);
    },
    async setAnimationMode(mode) {
      calls.push(['setAnimationMode', mode]);
    },
    async close() {
      calls.push(['close']);
    },
  };
  const bubbleComposition = {
    async show(input) {
      calls.push(['show', input]);
      return handle;
    },
    async releaseAll() {},
  };
  const platform = createDsl4TurboWarpActorPlatform({
    runtimeHost: createTestTurboWarpRuntimeHost({targets: [hero.target]}),
    scheduler: clock.scheduler,
    speechAdvanceTypewriterEnabled: true,
    bubbleComposition,
  });
  const operation = platform.host.createSay(hero.target, {
    text: '浦島太郎',
    waitFor: 'advance',
    bubbleStyle: 'native',
    bubbleReveal: {unit: 'CHARACTER', layout: 'RESERVED', intervalSeconds: 0.1},
    bubbleMotions: [
      {name: 'shake', direction: 'right', count: 2},
      {name: 'animateBubbleShape', visualStyle: 'YELLING', durationSeconds: 0.2},
    ],
  });
  const pending = operation.start();
  for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();

  assert.deepEqual(calls[0], [
    'show',
    {
      actor: hero.target,
      actorKey: 'hero-target',
      kind: 'say',
      text: '浦島太郎',
      styleName: 'native',
      animationMode: 'talking',
      reveal: {
        unit: 'CHARACTER',
        delimiters: ' \t\r\n',
        showDelimiters: false,
        layout: 'RESERVED',
        intervalSeconds: 0,
      },
    },
  ]);
  assert.deepEqual(calls.slice(1, 3), [
    ['animate', {name: 'shake', direction: 'right', count: 2}],
    ['animate', {name: 'animateBubbleShape', visualStyle: 'YELLING', durationSeconds: 0.2}],
  ]);
  for (let index = 0; index < 3; index += 1) {
    clock.advance(100);
    for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
  }
  assert.equal(calls.filter(([name]) => name === 'revealNext').length, 3);
  assert.deepEqual(calls.at(-1), ['setAnimationMode', 'awaiting-continue']);

  assert.deepEqual(operation.finish('advance'), {consumed: false});
  await pending;
  assert.deepEqual(calls.slice(-2), [['finish'], ['close']]);
  assert.equal(clock.pendingCount(), 0);
});

test('uses advance as revealNext when native reveal disables automatic progress', async () => {
  const hero = fakeActor();
  const calls = [];
  const handle = {
    async revealNext() {
      calls.push('revealNext');
      return true;
    },
    async revealAll() {},
    async finish() {
      calls.push('finish');
    },
    async setAnimationMode(mode) {
      calls.push(mode);
    },
    async close() {
      calls.push('close');
    },
  };
  const platform = createDsl4TurboWarpActorPlatform({
    runtimeHost: createTestTurboWarpRuntimeHost({targets: [hero.target]}),
    speechAdvanceTypewriterEnabled: true,
    bubbleComposition: {
      async show() {
        return handle;
      },
      async releaseAll() {},
    },
  });
  const operation = platform.host.createSay(hero.target, {
    text: 'AB',
    waitFor: 'advance',
    bubbleStyle: 'manual',
    bubbleReveal: {unit: 'CHARACTER', intervalSeconds: 0},
  });
  const pending = operation.start();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(operation.finish('advance'), {consumed: true});
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  assert.deepEqual(calls.slice(-2), ['revealNext', 'awaiting-continue']);
  assert.deepEqual(operation.finish('advance'), {consumed: false});
  await pending;
  assert.deepEqual(calls.slice(-2), ['finish', 'close']);
});

test('handles zero-second operations without retaining a timer', async () => {
  const hero = fakeActor({x: 1, y: 2});
  const fake = fakeRuntime([hero.target]);
  const clock = manualScheduler();
  const platform = createDsl4TurboWarpActorPlatform({
    runtimeHost: fake.runtimeHost,
    scheduler: clock.scheduler,
  });

  await platform.host.createMove(hero.target, {x: 3, y: 4, seconds: 0}).start();
  await platform.host
    .createTransparencyTransition(hero.target, {from: 10, to: 20, seconds: 0})
    .start();
  await platform.host.createSay(hero.target, {text: '', seconds: 0}).start();

  assert.equal(hero.target.x, 3);
  assert.equal(hero.target.y, 4);
  assert.equal(clock.pendingCount(), 0);
  assert.deepEqual(
    hero.calls.filter(([method]) => method === 'setEffect'),
    [
      ['setEffect', 'ghost', 10],
      ['setEffect', 'ghost', 20],
    ],
  );
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
    runtimeHost: createTestTurboWarpRuntimeHost(runtime),
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
  const platform = createDsl4TurboWarpActorPlatform({runtimeHost: fake.runtimeHost});

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
  assert.throws(
    () => createDsl4TurboWarpActorPlatform({runtimeHost: {}}),
    /injected TurboWarp runtime host/u,
  );
  // Actor resolution runs on every action, so a malformed target list is rejected once at
  // construction rather than surfacing mid-story from the shared host's per-call validation.
  assert.throws(
    () =>
      createDsl4TurboWarpActorPlatform({
        runtimeHost: createTestTurboWarpRuntimeHost({targets: 'not-an-array'}),
      }),
    /targets must be an array/u,
  );
  assert.throws(
    () =>
      createDsl4TurboWarpActorPlatform({
        runtimeHost: createTestTurboWarpRuntimeHost({targets: []}),
      }),
    /ext_scratch3_looks/u,
  );
  assert.throws(
    () => createDsl4TurboWarpActorPlatform({runtimeHost: fake.runtimeHost, scheduler: {}}),
    /scheduler/u,
  );
  assert.throws(
    () => createDsl4TurboWarpActorPlatform({runtimeHost: fake.runtimeHost, frameMilliseconds: 0}),
    /greater than zero/u,
  );
  const platform = createDsl4TurboWarpActorPlatform({runtimeHost: fake.runtimeHost});
  assert.throws(() => platform.host.showActor({}, {x: 0, y: 0, scale: 1}), /target/u);
  assert.throws(() => platform.host.showActor(hero.target, {x: 0, y: 0, scale: 0}), /positive/u);
  const bubblePlatform = createDsl4TurboWarpActorPlatform({
    runtimeHost: createTestTurboWarpRuntimeHost({targets: [hero.target]}),
    speechAdvanceTypewriterEnabled: true,
    bubbleComposition: {
      async show() {
        assert.fail('invalid motion must be rejected before Bubble show');
      },
      async releaseAll() {},
    },
  });
  assert.throws(
    () =>
      bubblePlatform.host.createSay(hero.target, {
        text: 'hello',
        seconds: 1,
        bubbleStyle: 'native',
        bubbleMotions: [{name: 'unknown'}],
      }),
    /bubbleMotions is invalid/u,
  );
  for (const transparency of [-1, 101, Number.NaN]) {
    assert.throws(
      () => platform.host.setTransparency(hero.target, {transparency}),
      /finite number|between 0 and 100/u,
    );
  }
  assert.throws(
    () => platform.host.setTransparency(hero.target, {transparency: 50, extra: true}),
    /provide exactly/u,
  );
  const missingEffect = {...hero.target};
  delete missingEffect.setEffect;
  assert.throws(
    () => platform.host.setTransparency(missingEffect, {transparency: 50}),
    /provide setEffect/u,
  );
  for (const transition of [
    {from: -1, to: 50, seconds: 1},
    {from: 0, to: 101, seconds: 1},
    {from: 0, to: 50, seconds: Number.MAX_VALUE},
    {from: 0, to: 50, seconds: 1, extra: true},
  ]) {
    assert.throws(
      () => platform.host.createTransparencyTransition(hero.target, transition),
      /provide exactly|finite non-negative duration|between 0 and 100/u,
    );
  }
  assert.equal(
    hero.calls.some(([method]) => method === 'setEffect'),
    false,
  );
  assert.throws(
    () => platform.host.createMove(hero.target, {x: 0, y: 0, seconds: Number.MAX_VALUE}),
    /finite non-negative duration/u,
  );
  assert.throws(
    () => platform.host.createMove(hero.target, {x: 0, y: 0, seconds: 1, easing: 'spring'}),
    /easing must be one of/u,
  );
  assert.throws(
    () =>
      platform.host.createMove(hero.target, {
        x: 0,
        y: 0,
        seconds: 1,
        easing: 'linear',
        extra: true,
      }),
    /specification/u,
  );
  assert.throws(
    () => platform.host.createSay(hero.target, {text: 1, seconds: 0}),
    /text must be a string/u,
  );
  const movement = platform.host.createMove(hero.target, {x: 0, y: 0, seconds: 0});
  await movement.start();
  assert.throws(() => movement.start(), /only start once/u);
  const transparency = platform.host.createTransparencyTransition(hero.target, {
    from: 0,
    to: 50,
    seconds: 0,
  });
  await transparency.start();
  assert.throws(() => transparency.start(), /only start once/u);
});

test('keeps platform instances and their schedulers isolated', async () => {
  const firstActor = fakeActor({id: 'first'});
  const secondActor = fakeActor({id: 'second'});
  const firstRuntime = fakeRuntime([firstActor.target]);
  const secondRuntime = fakeRuntime([secondActor.target]);
  const firstClock = manualScheduler();
  const secondClock = manualScheduler();
  const first = createDsl4TurboWarpActorPlatform({
    runtimeHost: firstRuntime.runtimeHost,
    scheduler: firstClock.scheduler,
  });
  const second = createDsl4TurboWarpActorPlatform({
    runtimeHost: secondRuntime.runtimeHost,
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
