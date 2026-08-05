import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {createDsl4RuntimeController, createDsl4SourceFrontend} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);

function parseStory(source) {
  const result = frontend.parse(source, {sourceId: 'runtime-test.kamishibai.yaml'});
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

const allCoreActionsStory = `
kamishibai: '4.0'
assets:
  Beach: backdrop
  HeroIdle: costume:Hero
  HeroHappy: costume:Hero
  CaptionIdle: costume:Caption
  Music: sound
  Effect: sound
actors:
  Hero: HeroIdle
  Caption: CaptionIdle
textStyles:
  title:
    color: '#ffffff'
variables:
  firstRoute: false
  score: 1
branches:
  choose:
    - if: firstRoute
      goto: ending
    - if: score == 1
      goto: keyChoice
    - else: ending
scenes:
  opening:
    - stage: Beach
    - bgm: Music
    - sound: Effect
    - wait: 0
    - transition:
        effect: fadeOut
        seconds: 0
    - Hero.show:
        skin: HeroHappy
        x: 0
        y: 0
        scale: 100
    - Hero.moveTo:
        x: 10
        y: 20
        seconds: 0
    - Hero.say:
        text: hello
        seconds: 0
    - Hero.setSkin: HeroIdle
    - Caption.setText:
        text: title
        style: title
    - Hero.pose:
        choices:
          - pose: happy
            skin: HeroHappy
            sound: Effect
    - goto: branching
  branching:
    - branch: choose
  keyChoice:
    - keyInputToChangeScene:
        Digit1: touchChoice
        Digit2: ending
  touchChoice:
    - touchInputToChangeScene:
        Hero: ending
  ending: []
`;

test('dispatches every core action and keeps transition separate from scene movement', async () => {
  const calls = [];
  const port = Object.fromEntries(
    [
      'stage',
      'bgm',
      'sound',
      'wait',
      'transition',
      'show',
      'moveTo',
      'say',
      'setSkin',
      'setText',
    ].map((method) => [
      method,
      async (payload) => {
        calls.push({method, payload});
      },
    ]),
  );
  port.pose = async (payload) => {
    calls.push({method: 'pose', payload});
    return 'happy';
  };
  port.keyInputToChangeScene = async (payload) => {
    calls.push({method: 'keyInputToChangeScene', payload});
    return 'Digit1';
  };
  port.touchInputToChangeScene = async (payload) => {
    calls.push({method: 'touchInputToChangeScene', payload});
    return 'Hero';
  };
  const evaluated = [];
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(allCoreActionsStory),
    port,
    evaluateCondition(expression, variables) {
      evaluated.push(expression);
      return expression === 'score == 1' && variables.score === 1;
    },
  });

  const state = await controller.start();
  assert.equal(state.status, 'finished');
  assert.deepEqual(evaluated, ['firstRoute', 'score == 1']);
  assert.deepEqual(
    calls.map(({method}) => method),
    [
      'stage',
      'bgm',
      'sound',
      'wait',
      'transition',
      'show',
      'moveTo',
      'say',
      'setSkin',
      'setText',
      'pose',
      'setSkin',
      'sound',
      'keyInputToChangeScene',
      'touchInputToChangeScene',
    ],
  );
  const trace = controller.getTrace();
  assert.deepEqual(
    trace.map(({sequence}) => sequence),
    trace.map((_event, index) => index),
  );
  assert.ok(trace.every(({storyPath}) => typeof storyPath === 'string'));
  assert.ok(
    trace
      .filter(({type}) => type === 'scene.enter')
      .every(({storyPath}) => storyPath.startsWith('/scenes/')),
  );
  assert.equal(trace.filter(({type}) => type === 'action.start').length, 15);
  assert.equal(trace.filter(({type}) => type === 'action.commit').length, 15);
  assert.equal(trace.at(-1).type, 'runtime.finish');
  const transitions = trace
    .filter(({type}) => type === 'scene.transition')
    .map(({details}) => details);
  assert.deepEqual(
    transitions.map(({to, reason}) => [to, reason]),
    [
      ['opening', 'start'],
      ['branching', 'goto'],
      ['keyChoice', 'branch'],
      ['touchChoice', 'keyInput'],
      ['ending', 'touchInput'],
    ],
  );
  assert.equal(
    transitions.some(({reason}) => reason === 'transition'),
    false,
  );
});

test('advances through empty scenes and the final scene deterministically', async () => {
  const story = parseStory(`
kamishibai: '4.0'
scenes:
  first: []
  second:
    - wait: 0
  final: []
`);
  let waits = 0;
  const controller = createDsl4RuntimeController({
    storyDocument: story,
    port: {wait: async () => waits++},
  });
  const state = await controller.start();
  assert.equal(state.status, 'finished');
  assert.equal(waits, 1);
  assert.deepEqual(
    controller
      .getTrace()
      .filter(({type}) => type === 'scene.enter')
      .map(({sceneId}) => sceneId),
    ['first', 'second', 'final'],
  );
});

test('prepares eager remote assets before entering the first scene', async () => {
  const order = [];
  let preparationPayload;
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  Beach:
    kind: backdrop
    delivery: remote
    loading: eager
    source:
      url: https://cdn.example.com/beach.webp
      integrity: sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      contentType: image/webp
      size: 123456
scenes:
  opening:
    - stage: Beach
`),
    port: {
      prepareAsset: async (payload, context) => {
        preparationPayload = payload;
        assert.equal(context.assetId, 'Beach');
        assert.equal(context.sceneId, null);
        assert.equal(context.storyPath, '/assets/Beach');
        order.push('prepare');
      },
      stage: async () => order.push('stage'),
    },
  });

  const state = await controller.start();
  assert.equal(state.status, 'finished');
  assert.deepEqual(order, ['prepare', 'stage']);
  assert.equal(preparationPayload.assetId, 'Beach');
  assert.equal(preparationPayload.asset.delivery, 'remote');
  const eventTypes = controller.getTrace().map(({type}) => type);
  assert.ok(eventTypes.indexOf('asset.prepare.commit') < eventTypes.indexOf('scene.enter'));
  assert.ok(eventTypes.indexOf('scene.enter') < eventTypes.indexOf('action.start'));
});

test('prepares lazy assets that are required by startup configuration', async () => {
  const prepared = [];
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  HeroIdle:
    kind: costume
    target: Hero
    delivery: remote
    loading: lazy
    source:
      url: https://cdn.example.com/hero-idle.webp
      integrity: sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      contentType: image/webp
      size: 123456
actors:
  Hero: HeroIdle
scenes:
  opening: []
`),
    port: {
      prepareAsset: async ({assetId}) => prepared.push(assetId),
    },
  });

  const state = await controller.start();
  assert.equal(state.status, 'finished');
  assert.deepEqual(prepared, ['HeroIdle']);
  const eventTypes = controller.getTrace().map(({type}) => type);
  assert.ok(eventTypes.indexOf('asset.prepare.commit') < eventTypes.indexOf('scene.enter'));
});

test('waits for a lazy remote asset after its destination is selected and before scene entry', async () => {
  const pending = deferred();
  const preparationStarted = deferred();
  let stageCalls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  Ocean:
    kind: backdrop
    delivery: remote
    loading: lazy
    source:
      url: https://cdn.example.com/ocean.webp
      integrity: sha256-abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
      contentType: image/webp
      size: 654321
scenes:
  opening:
    - goto: ocean
  ocean:
    - stage: Ocean
`),
    port: {
      prepareAsset: (_payload, context) => {
        assert.equal(context.sceneId, 'ocean');
        preparationStarted.resolve();
        return pending.promise;
      },
      stage: async () => stageCalls++,
    },
  });

  const run = controller.start();
  await preparationStarted.promise;
  assert.equal(controller.getState().sceneId, 'ocean');
  assert.equal(controller.getState().actionIndex, -1);
  assert.equal(stageCalls, 0);
  const waitingTrace = controller.getTrace();
  assert.ok(
    waitingTrace.some(({type, details}) => type === 'scene.transition' && details.to === 'ocean'),
  );
  assert.equal(
    waitingTrace.some(({type, sceneId}) => type === 'scene.enter' && sceneId === 'ocean'),
    false,
  );

  pending.resolve();
  const state = await run;
  assert.equal(state.status, 'finished');
  assert.equal(stageCalls, 1);
  const completedTrace = controller.getTrace();
  const preparedAt = completedTrace.findIndex(({type}) => type === 'asset.prepare.commit');
  const enteredAt = completedTrace.findIndex(
    ({type, sceneId}) => type === 'scene.enter' && sceneId === 'ocean',
  );
  assert.ok(preparedAt < enteredAt);
});

test('advance waits for lazy assets when it crosses a scene boundary', async () => {
  const staleAction = deferred();
  const pendingAsset = deferred();
  const preparationStarted = deferred();
  let stageCalls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  Ocean:
    kind: backdrop
    delivery: remote
    loading: lazy
    source:
      url: https://cdn.example.com/ocean.webp
      integrity: sha256-abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
      contentType: image/webp
      size: 654321
scenes:
  opening:
    - wait: 1
  ocean:
    - stage: Ocean
`),
    port: {
      wait: () => staleAction.promise,
      prepareAsset: () => {
        preparationStarted.resolve();
        return pendingAsset.promise;
      },
      stage: async () => stageCalls++,
    },
  });

  const staleRun = controller.start();
  const advancedRun = controller.advance('test-next-scene');
  await preparationStarted.promise;
  assert.equal(controller.getState().sceneId, 'ocean');
  assert.equal(controller.getState().actionIndex, -1);
  assert.equal(stageCalls, 0);

  pendingAsset.resolve();
  const advancedState = await advancedRun;
  assert.equal(advancedState.status, 'finished');
  assert.equal(stageCalls, 1);
  staleAction.resolve();
  await staleRun;
  assert.equal(stageCalls, 1);
});

test('reposition stays side-effect free and resume prepares the selected remote scene', async () => {
  const staleAction = deferred();
  const pendingAsset = deferred();
  const preparationStarted = deferred();
  let preparations = 0;
  let stageCalls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  Ocean:
    kind: backdrop
    delivery: remote
    loading: lazy
    source:
      url: https://cdn.example.com/ocean.webp
      integrity: sha256-abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
      contentType: image/webp
      size: 654321
scenes:
  opening:
    - wait: 1
  ocean:
    - stage: Ocean
`),
    port: {
      wait: () => staleAction.promise,
      prepareAsset: () => {
        preparations += 1;
        preparationStarted.resolve();
        return pendingAsset.promise;
      },
      stage: async () => stageCalls++,
    },
  });

  const staleRun = controller.start();
  const paused = controller.reposition('ocean', {reason: 'history.nextScene'});
  assert.equal(paused.status, 'paused');
  assert.equal(preparations, 0);
  assert.equal(stageCalls, 0);

  const resumedRun = controller.resume();
  await preparationStarted.promise;
  assert.equal(stageCalls, 0);
  pendingAsset.resolve();
  const resumedState = await resumedRun;
  assert.equal(resumedState.status, 'finished');
  assert.equal(preparations, 1);
  assert.equal(stageCalls, 1);
  staleAction.resolve();
  await staleRun;
});

test('caches a prepared lazy asset across repeated scene visits', async () => {
  let preparations = 0;
  let stages = 0;
  let controller;
  controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  Ocean:
    kind: backdrop
    delivery: remote
    loading: lazy
    source:
      url: https://cdn.example.com/ocean.webp
      integrity: sha256-abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
      contentType: image/webp
      size: 654321
scenes:
  loop:
    - stage: Ocean
    - goto: loop
`),
    port: {
      prepareAsset: async () => preparations++,
      stage: async () => {
        stages += 1;
        if (stages === 3) controller.stop('loop-limit');
      },
    },
  });

  const state = await controller.start();
  assert.equal(state.status, 'stopped');
  assert.equal(stages, 3);
  assert.equal(preparations, 1);
});

test('navigation aborts preparation and ignores its stale completion', async () => {
  const slowPreparation = deferred();
  const slowStarted = deferred();
  let slowSignal;
  const stages = [];
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  Slow:
    kind: backdrop
    delivery: remote
    loading: lazy
    source:
      url: https://cdn.example.com/slow.webp
      integrity: sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      contentType: image/webp
      size: 123456
  Fast:
    kind: backdrop
    delivery: remote
    loading: lazy
    source:
      url: https://cdn.example.com/fast.webp
      integrity: sha256-abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
      contentType: image/webp
      size: 654321
scenes:
  opening:
    - goto: slow
  slow:
    - stage: Slow
  fast:
    - stage: Fast
`),
    port: {
      prepareAsset: ({assetId}, context) => {
        if (assetId === 'Slow') {
          slowSignal = context.signal;
          slowStarted.resolve();
          return slowPreparation.promise;
        }
        return Promise.resolve();
      },
      stage: async ({backdrop}) => stages.push(backdrop),
    },
  });

  const staleRun = controller.start();
  await slowStarted.promise;
  const navigatedRun = controller.navigate('fast', {reason: 'history.nextScene'});
  assert.equal(slowSignal.aborted, true);
  const navigatedState = await navigatedRun;
  assert.equal(navigatedState.status, 'finished');
  assert.deepEqual(stages, ['Fast']);

  slowPreparation.resolve();
  await staleRun;
  assert.equal(
    controller
      .getTrace()
      .some(({type, details}) => type === 'asset.prepare.commit' && details.assetId === 'Slow'),
    false,
  );
});

test('stop aborts remote preparation and ignores its stale completion', async () => {
  const pending = deferred();
  const started = deferred();
  let preparationSignal;
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  Beach:
    kind: backdrop
    delivery: remote
    source:
      url: https://cdn.example.com/beach.webp
      integrity: sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      contentType: image/webp
      size: 123456
scenes:
  opening:
    - stage: Beach
`),
    port: {
      prepareAsset: (_payload, context) => {
        preparationSignal = context.signal;
        started.resolve();
        return pending.promise;
      },
      stage: async () => assert.fail('scene action must not run'),
    },
  });

  const run = controller.start();
  await started.promise;
  const stopped = controller.stop('test-stop');
  assert.equal(stopped.status, 'stopped');
  assert.equal(preparationSignal.aborted, true);
  pending.resolve();
  const final = await run;
  assert.equal(final.status, 'stopped');
  assert.equal(
    controller.getTrace().some(({type}) => type === 'asset.prepare.commit'),
    false,
  );
});

test('reports asset preparation failures at the asset StoryPath', async () => {
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  Beach:
    kind: backdrop
    delivery: remote
    source:
      url: https://cdn.example.com/beach.webp
      integrity: sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      contentType: image/webp
      size: 123456
scenes:
  opening:
    - stage: Beach
`),
    port: {
      prepareAsset: async () => {
        throw new Error('integrity mismatch');
      },
      stage: async () => assert.fail('scene action must not run'),
    },
  });

  const state = await controller.start();
  assert.equal(state.status, 'failed');
  assert.equal(state.diagnostic.code, 'K4-RUNTIME-ASSET-001');
  assert.equal(state.diagnostic.storyPath, '/assets/Beach');
  assert.equal(state.diagnostic.message, 'integrity mismatch');
});

for (const [label, truthyExpression, destination, evaluated] of [
  ['first matching rule', 'first', 'firstScene', ['first']],
  ['later matching rule', 'second', 'secondScene', ['first', 'second']],
  ['final else rule', null, 'elseScene', ['first', 'second']],
]) {
  test(`branch selects the ${label}`, async () => {
    const story = parseStory(`
kamishibai: '4.0'
branches:
  route:
    - if: first
      goto: firstScene
    - if: second
      goto: secondScene
    - else: elseScene
scenes:
  opening:
    - branch: route
  firstScene: []
  secondScene: []
  elseScene: []
`);
    const expressions = [];
    const controller = createDsl4RuntimeController({
      storyDocument: story,
      port: {},
      evaluateCondition(expression) {
        expressions.push(expression);
        return expression === truthyExpression;
      },
    });
    await controller.start();
    assert.deepEqual(expressions, evaluated);
    const branchTransition = controller
      .getTrace()
      .find(({type, details}) => type === 'scene.transition' && details.reason === 'branch');
    assert.equal(branchTransition.details.to, destination);
  });
}

test('stop aborts the current action and ignores its stale completion', async () => {
  const pending = deferred();
  let stageCalls = 0;
  let waitSignal;
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  Beach: backdrop
scenes:
  opening:
    - wait: 1
    - stage: Beach
`),
    port: {
      wait: (_payload, context) => {
        waitSignal = context.signal;
        return pending.promise;
      },
      stage: async () => stageCalls++,
    },
  });
  const run = controller.start();
  const stopped = controller.stop('test-stop');
  assert.equal(stopped.status, 'stopped');
  assert.equal(waitSignal.aborted, true);
  pending.resolve();
  const final = await run;
  assert.equal(final.status, 'stopped');
  assert.equal(stageCalls, 0);
  assert.deepEqual(
    controller
      .getTrace()
      .filter(({type}) => type === 'action.commit' || type === 'action.cancel')
      .map(({type}) => type),
    ['action.cancel'],
  );
});

test('cancelled pose does not apply stale skin or sound effects', async () => {
  const pendingPose = deferred();
  const effects = [];
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
  HeroHappy: costume:Hero
  Effect: sound
actors:
  Hero: HeroIdle
scenes:
  opening:
    - Hero.pose:
        choices:
          - pose: happy
            skin: HeroHappy
            sound: Effect
`),
    port: {
      pose: () => pendingPose.promise,
      setSkin: async () => effects.push('setSkin'),
      sound: async () => effects.push('sound'),
    },
  });
  const run = controller.start();
  controller.stop('cancel-pose');
  pendingPose.resolve('happy');
  const state = await run;
  assert.equal(state.status, 'stopped');
  assert.deepEqual(effects, []);
});

test('cancelled branch does not evaluate later rules', async () => {
  const firstCondition = deferred();
  const evaluated = [];
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
branches:
  route:
    - if: first
      goto: destination
    - if: second
      goto: destination
    - else: destination
scenes:
  opening:
    - branch: route
  destination: []
`),
    port: {},
    evaluateCondition(expression) {
      evaluated.push(expression);
      return expression === 'first' ? firstCondition.promise : false;
    },
  });
  const run = controller.start();
  controller.stop('cancel-branch');
  firstCondition.resolve(false);
  const state = await run;
  assert.equal(state.status, 'stopped');
  assert.deepEqual(evaluated, ['first']);
});

test('restart isolates the new run from completion of the cancelled run', async () => {
  const firstWait = deferred();
  let waits = 0;
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
scenes:
  opening:
    - wait: 0
`),
    port: {
      wait: () => {
        waits += 1;
        return waits === 1 ? firstWait.promise : Promise.resolve();
      },
    },
  });
  const cancelledRun = controller.start();
  const currentRun = controller.start();
  const currentState = await currentRun;
  assert.equal(currentState.status, 'finished');
  firstWait.resolve();
  await cancelledRun;
  assert.equal(controller.getState().status, 'finished');
  assert.equal(controller.getRunPromise(), null);
  assert.equal(waits, 2);
});

test('navigation cancels the old action and keeps non-position variables', async () => {
  const pending = deferred();
  let stageCalls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  Beach: backdrop
variables:
  score: 1
scenes:
  opening:
    - wait: 1
  destination:
    - stage: Beach
`),
    port: {
      wait: (_payload, context) => {
        context.setVariable('score', 2);
        return pending.promise;
      },
      stage: async () => stageCalls++,
    },
  });
  const staleRun = controller.start();
  const navigatedRun = controller.navigate('destination', {reason: 'history.previousScene'});
  const navigatedState = await navigatedRun;
  assert.equal(navigatedState.status, 'finished');
  assert.equal(navigatedState.variables.score, 2);
  assert.equal(stageCalls, 1);
  pending.resolve();
  await staleRun;
  assert.equal(stageCalls, 1);
  assert.ok(
    controller
      .getTrace()
      .some(
        ({type, details}) => type === 'action.cancel' && details.reason === 'history.previousScene',
      ),
  );
});

test('advance cancels the current action and executes the next action once', async () => {
  const pending = deferred();
  let stageCalls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  Beach: backdrop
variables:
  score: 1
scenes:
  opening:
    - wait: 1
    - stage: Beach
`),
    port: {
      wait: (_payload, context) => {
        context.setVariable('score', 2);
        return pending.promise;
      },
      stage: async () => stageCalls++,
    },
  });
  const staleRun = controller.start();
  const advancedState = await controller.advance();
  assert.equal(advancedState.status, 'finished');
  assert.equal(advancedState.variables.score, 2);
  assert.equal(stageCalls, 1);
  pending.resolve();
  await staleRun;
  assert.equal(stageCalls, 1);
  const advanceEvent = controller.getTrace().find(({type}) => type === 'navigation.advance');
  assert.deepEqual(
    [advanceEvent.details.fromStoryPath, advanceEvent.details.toStoryPath],
    ['/scenes/opening/actions/0', '/scenes/opening/actions/1'],
  );
});

test('advance crosses a scene boundary and finishes at the final action boundary', async () => {
  const firstWait = deferred();
  const finalWait = deferred();
  let waits = 0;
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
scenes:
  first:
    - wait: 1
  final:
    - wait: 1
`),
    port: {
      wait: () => {
        waits += 1;
        return waits === 1 ? firstWait.promise : finalWait.promise;
      },
    },
  });
  const firstRun = controller.start();
  const finalRun = controller.advance('test-next-scene');
  assert.equal(controller.getState().sceneId, 'final');
  const finished = await controller.advance('test-finish');
  assert.equal(finished.status, 'finished');
  assert.equal(waits, 2);
  firstWait.resolve();
  finalWait.resolve();
  await Promise.all([firstRun, finalRun]);
  assert.equal(controller.getState().status, 'finished');
});

test('reposition pauses without presentation effects and resume starts at the selected action', async () => {
  const pending = deferred();
  const effects = [];
  let presentationState = 'initial';
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  Beach: backdrop
  Effect: sound
variables:
  score: 1
scenes:
  opening:
    - wait: 1
  destination:
    - stage: Beach
    - sound: Effect
`),
    port: {
      wait: (_payload, context) => {
        context.setVariable('score', 2);
        presentationState = 'changed-by-running-action';
        return pending.promise;
      },
      stage: async () => effects.push('stage'),
      sound: async () => effects.push('sound'),
    },
  });
  const staleRun = controller.start();
  const soundPosition = controller.reposition('destination', {
    actionIndex: 1,
    reason: 'history.previousAction',
  });
  assert.equal(soundPosition.status, 'paused');
  assert.equal(soundPosition.actionIndex, 1);
  assert.equal(soundPosition.actionPath, '/scenes/destination/actions/1');
  assert.equal(soundPosition.variables.score, 2);
  assert.deepEqual(effects, []);
  assert.equal(presentationState, 'changed-by-running-action');

  const stagePosition = controller.reposition('destination', {
    actionIndex: 0,
    reason: 'history.previousScene',
  });
  assert.equal(stagePosition.status, 'paused');
  assert.equal(stagePosition.actionPath, '/scenes/destination/actions/0');
  assert.deepEqual(effects, []);
  assert.equal(presentationState, 'changed-by-running-action');

  const resumed = await controller.resume('navigation.nextAction');
  assert.equal(resumed.status, 'finished');
  assert.equal(resumed.variables.score, 2);
  assert.deepEqual(effects, ['stage', 'sound']);
  pending.resolve();
  await staleRun;
  assert.deepEqual(effects, ['stage', 'sound']);

  const moves = controller.getTrace().filter(({type}) => type === 'navigation.reposition');
  assert.deepEqual(
    moves.map(({details}) => [details.fromStoryPath, details.toStoryPath, details.reason]),
    [
      ['/scenes/opening/actions/0', '/scenes/destination/actions/1', 'history.previousAction'],
      ['/scenes/destination/actions/1', '/scenes/destination/actions/0', 'history.previousScene'],
    ],
  );
});

test('reposition and resume support an empty scene', async () => {
  const pending = deferred();
  let stageCalls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  Beach: backdrop
scenes:
  opening:
    - wait: 1
  empty: []
  ending:
    - stage: Beach
`),
    port: {
      wait: () => pending.promise,
      stage: async () => stageCalls++,
    },
  });
  const staleRun = controller.start();
  const paused = controller.reposition('empty', {actionIndex: 0});
  assert.equal(paused.status, 'paused');
  assert.equal(paused.sceneId, 'empty');
  assert.equal(paused.actionIndex, 0);
  assert.equal(paused.actionPath, null);
  assert.equal(stageCalls, 0);
  const resumed = await controller.resume();
  assert.equal(resumed.status, 'finished');
  assert.equal(stageCalls, 1);
  pending.resolve();
  await staleRun;
  assert.equal(stageCalls, 1);
});

test('paused execution can stop and restart deterministically', async () => {
  const pending = deferred();
  let waits = 0;
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
variables:
  score: 1
scenes:
  opening:
    - wait: 1
  destination: []
`),
    port: {
      wait: (_payload, context) => {
        waits += 1;
        context.setVariable('score', 2);
        return pending.promise;
      },
    },
  });
  const staleRun = controller.start();
  controller.reposition('destination');
  const stopped = controller.stop('paused-stop');
  assert.equal(stopped.status, 'stopped');
  const restarted = await controller.start({sceneId: 'destination'});
  assert.equal(restarted.status, 'finished');
  assert.equal(restarted.variables.score, 1);
  assert.equal(waits, 1);
  pending.resolve();
  await staleRun;
  assert.equal(controller.getState().status, 'finished');
});

test('keeps variables outside StoryDocument and rejects stale or mistyped writes', async () => {
  const story = parseStory(`
kamishibai: '4.0'
variables:
  score: 1
scenes:
  opening:
    - wait: 0
`);
  const writes = [];
  const controller = createDsl4RuntimeController({
    storyDocument: story,
    port: {
      wait: async (_payload, context) => {
        writes.push(context.setVariable('score', 'wrong'));
        writes.push(context.setVariable('score', 2));
      },
    },
  });
  const state = await controller.start();
  assert.deepEqual(writes, [false, true]);
  assert.equal(state.variables.score, 2);
  assert.equal(story.variables.score, 1);
  const oldContextWrite = controller.getState().variables;
  assert.equal(Object.isFrozen(oldContextWrite), true);
});

test('records repeated visits to the same scene and can stop from an active port', async () => {
  const story = parseStory(`
kamishibai: '4.0'
scenes:
  loop:
    - wait: 0
    - goto: loop
`);
  let waits = 0;
  let controller;
  controller = createDsl4RuntimeController({
    storyDocument: story,
    port: {
      wait: async () => {
        waits += 1;
        if (waits === 3) controller.stop('loop-limit');
      },
    },
  });
  const state = await controller.start();
  assert.equal(state.status, 'stopped');
  assert.equal(waits, 3);
  assert.equal(
    controller.getTrace().filter(({type, sceneId}) => type === 'scene.enter' && sceneId === 'loop')
      .length,
    3,
  );
});

for (const [name, port, expectedCode] of [
  ['missing port', {}, 'K4-RUNTIME-PORT-001'],
  [
    'port failure',
    {
      wait: async () => {
        throw new Error('wait failed');
      },
    },
    'K4-RUNTIME-ACTION-001',
  ],
]) {
  test(`converts ${name} into a runtime diagnostic`, async () => {
    const controller = createDsl4RuntimeController({
      storyDocument: parseStory(`
kamishibai: '4.0'
scenes:
  opening:
    - wait: 0
`),
      port,
    });
    const state = await controller.start();
    assert.equal(state.status, 'failed');
    assert.equal(state.diagnostic.code, expectedCode);
    assert.equal(state.diagnostic.storyPath, '/scenes/opening/actions/0');
    assert.equal(controller.getTrace().at(-1).type, 'runtime.fail');
  });
}

test('rejects an input result outside the declared routes', async () => {
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
scenes:
  opening:
    - keyInputToChangeScene:
        Digit1: ending
  ending: []
`),
    port: {keyInputToChangeScene: async () => 'Digit2'},
  });
  const state = await controller.start();
  assert.equal(state.status, 'failed');
  assert.equal(state.diagnostic.code, 'K4-RUNTIME-RESULT-001');
});

test('runtime controller core has no filesystem, network, VM, or Scratch dependency', async () => {
  const implementation = await readFile(
    path.join(projectRoot, 'src', 'dsl4', 'runtime-controller.js'),
    'utf8',
  );
  assert.doesNotMatch(implementation, /(?:node:fs|node:http|node:https|\bfetch\s*\()/);
  assert.doesNotMatch(implementation, /(?:\bScratch\b|scratch-vm|vm\.runtime|startHats)/);
});
