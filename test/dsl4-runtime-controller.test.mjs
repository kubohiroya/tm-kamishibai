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
