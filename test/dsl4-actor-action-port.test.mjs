import assert from 'node:assert/strict';
import test from 'node:test';

import {createDsl4ActorActionPort} from '../src/dsl4/platform/index.js';

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
    ['HeroHappy', 'image/png'],
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
      async applyToTarget(name, target) {
        calls.push(['applyToTarget', name, target.id]);
      },
      ...overrides,
    },
  };
}

function fakeHost(overrides = {}) {
  const calls = [];
  return {
    calls,
    host: {
      showActor(actor, transform, context) {
        calls.push(['showActor', actor.id, transform, context.sceneId]);
      },
      hideActor(actor, context) {
        calls.push(['hideActor', actor.id, context.sceneId]);
      },
      setActorLayer(actor, layer, context) {
        calls.push(['setActorLayer', actor.id, layer, context.sceneId]);
      },
      setTransparency(actor, effect, context) {
        calls.push(['setTransparency', actor.id, effect, context.sceneId]);
      },
      createTransparencyTransition(actor, transition, context) {
        calls.push(['createTransparencyTransition', actor.id, transition, context.sceneId]);
        return {
          start() {
            calls.push(['startTransparencyTransition']);
          },
          startBackground() {
            calls.push(['startBackgroundTransparencyTransition']);
          },
          finish() {
            calls.push(['finishTransparencyTransition']);
          },
        };
      },
      createMove(actor, destination, context) {
        calls.push(['createMove', actor.id, destination, context.sceneId]);
        return {
          start() {
            calls.push(['startMove']);
          },
          finish() {
            calls.push(['finishMove']);
          },
        };
      },
      createSay(actor, speech, context) {
        calls.push(['createSay', actor.id, speech, context.sceneId]);
        return {
          start() {
            calls.push(['startSay']);
          },
          finish() {
            calls.push(['finishSay']);
          },
        };
      },
      ...overrides,
    },
  };
}

function actionContext(controller = new AbortController()) {
  return {signal: controller.signal, generation: 1, sceneId: 'opening'};
}

function actorPort({composition, host, resolveActor, stopActorLoop} = {}) {
  return createDsl4ActorActionPort({
    composition: composition ?? fakeComposition().composition,
    host: host ?? fakeHost().host,
    ...(stopActorLoop === undefined ? {} : {stopActorLoop}),
    resolveActor:
      resolveActor ??
      (() => {
        return {id: 'hero-target', isStage: false};
      }),
  });
}

test('maps show, hide, layer, transparency, move, and speech through one presentation host', async () => {
  const fake = fakeComposition();
  const presentation = fakeHost();
  const actor = Object.freeze({id: 'hero-target', isStage: false});
  const resolved = [];
  const session = Object.freeze({assetManagerComposition: fake.composition});
  const port = actorPort({
    composition: session.assetManagerComposition,
    host: presentation.host,
    resolveActor(actorId, context) {
      resolved.push([actorId, context.sceneId]);
      return actor;
    },
  });

  await port.show({target: 'Hero', skin: 'HeroHappy', x: 10, y: -20, scale: 30}, actionContext());
  await port.hide({target: 'Hero'}, actionContext());
  await port.setLayer({target: 'Hero', layer: 'back'}, actionContext());
  await port.setTransparency({target: 'Hero', transparency: 50}, actionContext());
  await port.moveTo(
    {target: 'Hero', x: 40, y: 50, seconds: 1.5, easing: 'easeIn'},
    actionContext(),
  );
  await port.say({target: 'Hero', text: '助けに行こう', seconds: 2}, actionContext());

  assert.equal(Object.isFrozen(port), true);
  assert.deepEqual(fake.calls, [
    ['isRegistered', 'HeroHappy'],
    ['getMimeType', 'HeroHappy'],
    ['applyToTarget', 'HeroHappy', 'hero-target'],
  ]);
  assert.deepEqual(presentation.calls, [
    ['showActor', 'hero-target', {x: 10, y: -20, scale: 30}, 'opening'],
    ['hideActor', 'hero-target', 'opening'],
    ['setActorLayer', 'hero-target', 'back', 'opening'],
    ['setTransparency', 'hero-target', {transparency: 50}, 'opening'],
    ['createMove', 'hero-target', {x: 40, y: 50, seconds: 1.5, easing: 'easeIn'}, 'opening'],
    ['startMove'],
    ['createSay', 'hero-target', {text: '助けに行こう', seconds: 2}, 'opening'],
    ['startSay'],
  ]);
  assert.deepEqual(resolved, [
    ['Hero', 'opening'],
    ['Hero', 'opening'],
    ['Hero', 'opening'],
    ['Hero', 'opening'],
    ['Hero', 'opening'],
    ['Hero', 'opening'],
  ]);
});

test('waits for an in-flight loop skin before applying a show skin', async () => {
  const loopStopped = deferred();
  const loopStopStarted = deferred();
  const calls = [];
  const fake = fakeComposition({
    applyToTarget(name, target) {
      calls.push(['applyToTarget', name, target.id]);
    },
  });
  const presentation = fakeHost({
    showActor(actor) {
      calls.push(['showActor', actor.id]);
    },
  });
  const port = actorPort({
    composition: fake.composition,
    host: presentation.host,
    stopActorLoop(target) {
      calls.push(['stopActorLoop', target]);
      loopStopStarted.resolve();
      return loopStopped.promise;
    },
  });

  const show = port.show(
    {target: 'Hero', skin: 'HeroHappy', x: 10, y: -20, scale: 30},
    actionContext(),
  );
  await loopStopStarted.promise;
  assert.deepEqual(calls, [['stopActorLoop', 'Hero']]);

  loopStopped.resolve();
  await show;
  assert.deepEqual(calls, [
    ['stopActorLoop', 'Hero'],
    ['applyToTarget', 'HeroHappy', 'hero-target'],
    ['showActor', 'hero-target'],
  ]);
});

test('synchronously finishes moveTo at its destination before cancellation rejects', async () => {
  const movement = deferred();
  const started = deferred();
  const presentation = fakeHost({
    createMove(actor, destination) {
      presentation.calls.push(['createMove', actor.id, destination]);
      return {
        start() {
          presentation.calls.push(['startMove']);
          started.resolve();
          return movement.promise;
        },
        finish() {
          presentation.calls.push(['finishMove', destination.x, destination.y]);
        },
      };
    },
  });
  const port = actorPort({host: presentation.host});
  const controller = new AbortController();
  const pending = port.moveTo(
    {target: 'Hero', x: 100, y: 50, seconds: 3},
    actionContext(controller),
  );
  await started.promise;
  controller.abort('advance');

  assert.deepEqual(presentation.calls.at(-1), ['finishMove', 100, 50]);
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  movement.reject(new Error('late movement failure'));
  await Promise.resolve();
});

test('defaults moveTo easing to linear before presentation', async () => {
  const presentation = fakeHost();
  const port = actorPort({host: presentation.host});

  await port.moveTo({target: 'Hero', x: 10, y: 20, seconds: 1}, actionContext());

  assert.deepEqual(presentation.calls.slice(0, 2), [
    ['createMove', 'hero-target', {x: 10, y: 20, seconds: 1, easing: 'linear'}, 'opening'],
    ['startMove'],
  ]);
});

test('waits for foreground transparency and finishes it before cancellation rejects', async () => {
  const transition = deferred();
  const started = deferred();
  const presentation = fakeHost({
    createTransparencyTransition(actor, value) {
      presentation.calls.push(['createTransparencyTransition', actor.id, value]);
      return {
        start() {
          presentation.calls.push(['startTransparencyTransition']);
          started.resolve();
          return transition.promise;
        },
        finish() {
          presentation.calls.push(['finishTransparencyTransition', value.to]);
        },
      };
    },
  });
  const port = actorPort({host: presentation.host});
  const controller = new AbortController();
  const pending = port.setTransparency(
    {target: 'Hero', from: 0, to: 50, seconds: 1, background: false},
    actionContext(controller),
  );
  await started.promise;
  controller.abort('advance');

  assert.deepEqual(presentation.calls.at(-1), ['finishTransparencyTransition', 50]);
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  transition.resolve();
  await Promise.resolve();
});

test('delegates background transparency ownership and returns without waiting for completion', async () => {
  const transition = deferred();
  const presentation = fakeHost({
    createTransparencyTransition(actor, value) {
      presentation.calls.push(['createTransparencyTransition', actor.id, value]);
      return {
        start() {
          presentation.calls.push(['startTransparencyTransition']);
          return transition.promise;
        },
        startBackground() {
          presentation.calls.push(['startBackgroundTransparencyTransition']);
          void transition.promise.catch((error) => {
            presentation.calls.push(['backgroundTransparencyFailure', error.message]);
          });
        },
        finish() {
          presentation.calls.push(['finishTransparencyTransition']);
        },
      };
    },
  });
  const port = actorPort({host: presentation.host});

  await port.setTransparency(
    {target: 'Hero', from: 0, to: 50, seconds: 1, background: true},
    actionContext(),
  );
  assert.deepEqual(presentation.calls, [
    ['createTransparencyTransition', 'hero-target', {from: 0, to: 50, seconds: 1}],
    ['startBackgroundTransparencyTransition'],
  ]);

  transition.reject(new Error('owned background failure'));
  await Promise.resolve();
  assert.deepEqual(presentation.calls.at(-1), [
    'backgroundTransparencyFailure',
    'owned background failure',
  ]);
});

test('rejects a background transparency operation without a background owner', async () => {
  const presentation = fakeHost({
    createTransparencyTransition() {
      return {start() {}, finish() {}};
    },
  });
  const port = actorPort({host: presentation.host});

  await assert.rejects(
    port.setTransparency(
      {target: 'Hero', from: 0, to: 50, seconds: 1, background: true},
      actionContext(),
    ),
    /must provide startBackground/u,
  );
});

test('keeps AbortError when finish synchronously settles the presentation promise', async () => {
  const movement = deferred();
  const started = deferred();
  const presentation = fakeHost({
    createMove() {
      return {
        start() {
          started.resolve();
          return movement.promise;
        },
        finish() {
          movement.resolve();
        },
      };
    },
  });
  const port = actorPort({host: presentation.host});
  const controller = new AbortController();
  const pending = port.moveTo(
    {target: 'Hero', x: 100, y: 50, seconds: 3},
    actionContext(controller),
  );
  await started.promise;
  controller.abort('advance');

  await assert.rejects(pending, (error) => error.name === 'AbortError');
});

test('synchronously clears say before cancellation rejects', async () => {
  const speech = deferred();
  const started = deferred();
  const presentation = fakeHost({
    createSay(actor, value) {
      presentation.calls.push(['createSay', actor.id, value]);
      return {
        start() {
          presentation.calls.push(['startSay']);
          started.resolve();
          return speech.promise;
        },
        finish() {
          presentation.calls.push(['finishSay']);
        },
      };
    },
  });
  const port = actorPort({host: presentation.host});
  const controller = new AbortController();
  const pending = port.say({target: 'Hero', text: '待って', seconds: 5}, actionContext(controller));
  await started.promise;
  controller.abort('advance');

  assert.deepEqual(presentation.calls.at(-1), ['finishSay']);
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  speech.resolve();
  await Promise.resolve();
});

test('does not show an actor when skin application settles after cancellation', async () => {
  const application = deferred();
  const fake = fakeComposition({
    applyToTarget(name, actor) {
      fake.calls.push(['applyToTarget', name, actor.id]);
      return application.promise;
    },
  });
  const presentation = fakeHost();
  const port = actorPort({composition: fake.composition, host: presentation.host});
  const controller = new AbortController();
  const pending = port.show(
    {target: 'Hero', skin: 'HeroHappy', x: 0, y: 0, scale: 100},
    actionContext(controller),
  );
  await Promise.resolve();
  controller.abort('runtime-stop');

  await assert.rejects(pending, (error) => error.name === 'AbortError');
  application.resolve();
  await Promise.resolve();
  assert.deepEqual(presentation.calls, []);
});

test('rejects malformed and unresolved inputs before presentation side effects', async () => {
  const fake = fakeComposition();
  const presentation = fakeHost();
  let resolverCalls = 0;
  const port = actorPort({
    composition: fake.composition,
    host: presentation.host,
    resolveActor() {
      resolverCalls += 1;
      return null;
    },
  });
  const invalidPayloads = [
    () => port.show({target: 'Hero', skin: 'HeroHappy', x: 0, y: 0}, actionContext()),
    () =>
      port.show(
        {target: 'Hero', skin: 'HeroHappy', x: Number.NaN, y: 0, scale: 100},
        actionContext(),
      ),
    () => port.show({target: 'Hero', skin: 'HeroHappy', x: 0, y: 0, scale: 0}, actionContext()),
    () => port.setTransparency({target: 'Hero', transparency: -1}, actionContext()),
    () => port.setTransparency({target: 'Hero', transparency: 101}, actionContext()),
    () => port.setTransparency({target: 'Hero', transparency: Number.NaN}, actionContext()),
    () => port.setTransparency({target: 'Hero', transparency: 50, extra: true}, actionContext()),
    () => port.setTransparency({target: 'Hero', from: -1, to: 50, seconds: 1}, actionContext()),
    () => port.setTransparency({target: 'Hero', from: 0, to: 101, seconds: 1}, actionContext()),
    () => port.setTransparency({target: 'Hero', from: 0, to: 50, seconds: -1}, actionContext()),
    () =>
      port.setTransparency(
        {target: 'Hero', from: 0, to: 50, seconds: 1, background: 'yes'},
        actionContext(),
      ),
    () =>
      port.setTransparency(
        {target: 'Hero', from: 0, to: 50, seconds: 1, extra: true},
        actionContext(),
      ),
    () => port.moveTo({target: 'Hero', x: 0, y: 0, seconds: -1}, actionContext()),
    () => port.moveTo({target: 'Hero', x: 0, y: 0, seconds: 1, easing: 'spring'}, actionContext()),
    () =>
      port.moveTo(
        {target: 'Hero', x: 0, y: 0, seconds: 1, easing: 'linear', extra: true},
        actionContext(),
      ),
    () => port.say({target: 'Hero', text: 42, seconds: 1}, actionContext()),
    () => port.say({target: 'Hero', text: '', seconds: 1, extra: true}, actionContext()),
    () => port.say({target: 'Hero', text: '', seconds: 1}, {}),
  ];
  for (const invoke of invalidPayloads) {
    await assert.rejects(async () => invoke(), /actor action|payload|must|greater|negative/u);
  }
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(presentation.calls, []);
  assert.equal(resolverCalls, 0);

  await assert.rejects(
    port.show({target: 'Hero', skin: 'Missing', x: 0, y: 0, scale: 100}, actionContext()),
    /not registered/u,
  );
  await assert.rejects(
    port.show({target: 'Hero', skin: 'OpeningSound', x: 0, y: 0, scale: 100}, actionContext()),
    /image MIME/u,
  );
  await assert.rejects(
    port.moveTo({target: 'Unknown', x: 0, y: 0, seconds: 1}, actionContext()),
    /Actor target is unavailable/u,
  );
  assert.deepEqual(presentation.calls, []);
});

test('validates a presentation operation before start and isolates port instances', async () => {
  const firstPresentation = fakeHost({
    createMove() {
      firstPresentation.calls.push(['createMove']);
      return {start: 'invalid', finish() {}};
    },
  });
  const secondPresentation = fakeHost();
  const first = actorPort({host: firstPresentation.host});
  const second = actorPort({host: secondPresentation.host});

  await assert.rejects(
    first.moveTo({target: 'Hero', x: 1, y: 2, seconds: 0}, actionContext()),
    /presentation operation/u,
  );
  await second.say({target: 'Hero', text: '', seconds: 0}, actionContext());

  assert.deepEqual(firstPresentation.calls, [['createMove']]);
  assert.deepEqual(secondPresentation.calls, [
    ['createSay', 'hero-target', {text: '', seconds: 0}, 'opening'],
    ['startSay'],
  ]);
});

test('fails closed and cleans speech presentation for invalid advance handles or outcomes', async () => {
  async function exercise(createAdvanceWait, expectedMessage, expectedStarts) {
    const calls = [];
    const presentation = deferred();
    const host = fakeHost({
      createThink() {
        calls.push(['createThink']);
        return {
          start() {
            calls.push(['start']);
            return presentation.promise;
          },
          finish(reason) {
            calls.push(['finish', reason]);
            presentation.resolve();
          },
        };
      },
    });
    const port = createDsl4ActorActionPort({
      composition: fakeComposition().composition,
      host: host.host,
      resolveActor: () => ({id: 'hero-target', isStage: false}),
      speechAdvanceTypewriterEnabled: true,
    });
    const controller = new AbortController();
    await assert.rejects(
      port.think(
        {target: 'Hero', text: 'hmm', waitFor: 'advance'},
        {...actionContext(controller), createAdvanceWait},
      ),
      expectedMessage,
    );
    assert.equal(calls.filter(([name]) => name === 'start').length, expectedStarts);
    if (expectedStarts > 0) assert.deepEqual(calls.at(-1), ['finish', 'cancel']);
  }

  let invalidCancelCalls = 0;
  await exercise(
    () => ({
      promise: 42,
      cancel() {
        invalidCancelCalls += 1;
      },
    }),
    /invalid handle/u,
    0,
  );
  assert.equal(invalidCancelCalls, 1);

  let rejectedCancelCalls = 0;
  await exercise(
    () => ({
      promise: Promise.reject(new Error('advance source failed')),
      cancel() {
        rejectedCancelCalls += 1;
      },
    }),
    /advance source failed/u,
    1,
  );
  assert.equal(rejectedCancelCalls, 1);

  let outcomeCancelCalls = 0;
  await exercise(
    () => ({
      promise: Promise.resolve({outcome: 'unexpected'}),
      cancel() {
        outcomeCancelCalls += 1;
      },
    }),
    /invalid outcome/u,
    1,
  );
  assert.equal(outcomeCancelCalls, 1);
});

test('does not inspect dependencies for a pre-aborted action', async () => {
  const fake = fakeComposition();
  const presentation = fakeHost();
  let resolverCalls = 0;
  const port = actorPort({
    composition: fake.composition,
    host: presentation.host,
    resolveActor() {
      resolverCalls += 1;
      return {id: 'hero-target', isStage: false};
    },
  });
  const controller = new AbortController();
  controller.abort('already-stopped');

  await assert.rejects(
    port.show(
      {target: 'Hero', skin: 'HeroHappy', x: 0, y: 0, scale: 100},
      actionContext(controller),
    ),
    (error) => error.name === 'AbortError',
  );
  await assert.rejects(
    port.moveTo({target: 'Hero', x: 0, y: 0, seconds: 1}, actionContext(controller)),
    (error) => error.name === 'AbortError',
  );
  await assert.rejects(
    port.setTransparency({target: 'Hero', transparency: 50}, actionContext(controller)),
    (error) => error.name === 'AbortError',
  );
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(presentation.calls, []);
  assert.equal(resolverCalls, 0);
});

test('validates every actor action dependency before use', () => {
  assert.throws(
    () => createDsl4ActorActionPort({composition: {}, resolveActor() {}, host: {}}),
    /Asset Manager composition/u,
  );
  assert.throws(
    () =>
      createDsl4ActorActionPort({
        composition: fakeComposition().composition,
        resolveActor() {},
        host: {},
      }),
    /Actor presentation host/u,
  );
  assert.throws(
    () =>
      createDsl4ActorActionPort({
        composition: fakeComposition().composition,
        host: fakeHost().host,
      }),
    /resolveActor/u,
  );
});
