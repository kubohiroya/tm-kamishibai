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

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
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
  RescuePose:
    kind: poseModel
    file: pose-models/rescue
actors:
  Hero: HeroIdle
  Caption: CaptionIdle
textStyles:
  title:
    color: '#ffffff'
variables:
  firstRoute: false
  score: 1
poseRecognition:
  idleSound: Effect
  chargeSound: Effect
  sequence:
    confidenceThreshold: 0.6
    fullConfidenceHoldSeconds: 1.5
    idleChargePerSecond: 0.1
  selection:
    accumulationPerSecond: 2
    decayPerSecond: 0.8
    scoreThreshold: 1
branches:
  choose:
    - if: firstRoute
      goto: ending
    - if: score == 1
      goto: keyChoice
    - else: ending
scenes:
  opening:
    poseModel: RescuePose
    actions:
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
      - Hero.hide: {}
      - Hero.setLayer: back
      - Hero.loop:
          steps:
            - skin: HeroIdle
              seconds: 0.3
            - skin: HeroHappy
              seconds: 0.3
      - Hero.setTransparency: 50
      - Hero.moveTo:
          x: 10
          y: 20
          seconds: 0
          easing: easeOut
      - Hero.say:
          text: hello
          seconds: 0
      - Hero.setSkin:
          skin: HeroIdle
          scale: 45
      - Caption.setText:
          text: title
          style: title
      - Hero.pose:
          steps:
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
        Hero: poseChoice
  poseChoice:
    poseModel: RescuePose
    actions:
      - poseInputToChangeScene:
          happy: ending
          jump: opening
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
      'hide',
      'setLayer',
      'loop',
      'setTransparency',
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
  port.waitForPose = async (payload) => {
    calls.push({method: 'waitForPose', payload});
  };
  port.keyInputToChangeScene = async (payload) => {
    calls.push({method: 'keyInputToChangeScene', payload});
    return 'Digit1';
  };
  port.touchInputToChangeScene = async (payload) => {
    calls.push({method: 'touchInputToChangeScene', payload});
    return 'Hero';
  };
  port.poseInputToChangeScene = async (payload) => {
    calls.push({method: 'poseInputToChangeScene', payload});
    return 'happy';
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
      'hide',
      'setLayer',
      'loop',
      'setTransparency',
      'moveTo',
      'say',
      'setSkin',
      'setText',
      'setSkin',
      'waitForPose',
      'sound',
      'keyInputToChangeScene',
      'touchInputToChangeScene',
      'poseInputToChangeScene',
    ],
  );
  assert.deepEqual(calls.find(({method}) => method === 'setTransparency').payload, {
    target: 'Hero',
    transparency: 50,
  });
  assert.deepEqual(calls.find(({method}) => method === 'setSkin').payload, {
    target: 'Hero',
    skin: 'HeroIdle',
    scale: 45,
  });
  assert.deepEqual(calls.find(({method}) => method === 'waitForPose').payload, {
    target: 'Hero',
    pose: 'happy',
    stepIndex: 0,
    poseModel: 'RescuePose',
    recognition: {
      confidenceThreshold: 0.6,
      fullConfidenceHoldSeconds: 1.5,
      idleChargePerSecond: 0.1,
      idleSound: 'Effect',
      chargeSound: 'Effect',
      feedback: {mode: 'scratchMirror'},
      navigation: {allowSkip: false},
    },
  });
  assert.deepEqual(calls.find(({method}) => method === 'poseInputToChangeScene').payload, {
    poses: ['happy', 'jump'],
    poseModel: 'RescuePose',
    recognition: {
      accumulationPerSecond: 2,
      decayPerSecond: 0.8,
      scoreThreshold: 1,
    },
  });
  assert.deepEqual(calls.find(({method}) => method === 'moveTo').payload, {
    target: 'Hero',
    x: 10,
    y: 20,
    seconds: 0,
    easing: 'easeOut',
  });
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
  assert.equal(trace.filter(({type}) => type === 'action.start').length, 20);
  assert.equal(trace.filter(({type}) => type === 'action.commit').length, 20);
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
      ['poseChoice', 'touchInput'],
      ['ending', 'poseInput'],
    ],
  );
  assert.equal(
    transitions.some(({reason}) => reason === 'transition'),
    false,
  );
});

test('applies effective pose preview mirroring on every scene entry without changing recognition', async () => {
  const storyDocument = parseStory(`
kamishibai: '4.0'
assets:
  Tick: sound
  Charge: sound
  HeroIdle: costume:Hero
  RescuePose:
    kind: poseModel
    file: pose-models/rescue
actors:
  Hero: HeroIdle
poseRecognition:
  idleSound: Tick
  chargeSound: Charge
  preview:
    mirroring: unmirrored
scenes:
  opening:
    poseModel: RescuePose
    posePreview:
      mirroring: mirrored
    actions:
      - Hero.pose:
          steps:
            - pose: wave
  reset:
    poseModel: RescuePose
    actions: []
`);
  const calls = [];
  const controller = createDsl4RuntimeController({
    storyDocument,
    posePreviewMirroringEnabled: true,
    port: {
      setPosePreviewMirroring(mode) {
        calls.push({method: 'setPosePreviewMirroring', mode});
      },
      waitForPose(payload) {
        calls.push({method: 'waitForPose', payload});
      },
    },
  });

  const finished = await controller.start();
  assert.equal(finished.status, 'finished');
  assert.deepEqual(
    calls.map(({method, mode}) => [method, mode]),
    [
      ['setPosePreviewMirroring', 'mirrored'],
      ['waitForPose', undefined],
      ['setPosePreviewMirroring', 'unmirrored'],
    ],
  );
  const recognition = calls.find(({method}) => method === 'waitForPose').payload.recognition;
  assert.equal(Object.hasOwn(recognition, 'preview'), false);
  assert.deepEqual(recognition, {
    confidenceThreshold: 0.5,
    fullConfidenceHoldSeconds: 1,
    idleChargePerSecond: 0,
    idleSound: 'Tick',
    chargeSound: 'Charge',
    feedback: {mode: 'scratchMirror'},
    navigation: {allowSkip: false},
  });

  controller.reposition('opening');
  controller.reposition('reset');
  assert.deepEqual(
    calls.slice(-2).map(({mode}) => mode),
    ['mirrored', 'unmirrored'],
  );
});

test('keeps pose preview mirroring disabled without inspecting its runtime port', async () => {
  const port = {};
  Object.defineProperty(port, 'setPosePreviewMirroring', {
    get() {
      assert.fail('disabled pose preview mirroring must not inspect its runtime port');
    },
  });
  const storyDocument = parseStory("kamishibai: '4.0'\nscenes:\n  opening: []\n");
  const controller = createDsl4RuntimeController({storyDocument, port});
  assert.equal((await controller.start()).status, 'finished');
  assert.throws(
    () =>
      createDsl4RuntimeController({
        storyDocument,
        port: {},
        posePreviewMirroringEnabled: true,
      }),
    /setPosePreviewMirroring/u,
  );
  assert.throws(
    () =>
      createDsl4RuntimeController({
        storyDocument,
        port: {},
        posePreviewMirroringEnabled: 'yes',
      }),
    /posePreviewMirroringEnabled/u,
  );
});

test('fails closed before scene publication when pose preview mirroring cannot be applied', async () => {
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory("kamishibai: '4.0'\nscenes:\n  opening: []\n"),
    posePreviewMirroringEnabled: true,
    port: {
      setPosePreviewMirroring() {
        throw new Error('preview unavailable');
      },
    },
  });

  const result = await controller.start();
  assert.equal(result.status, 'failed');
  assert.equal(
    controller.getTrace().some(({type}) => type === 'scene.enter'),
    false,
  );
});

test('preserves non-default pose policy and increments stepIndex across ordered steps', async () => {
  const calls = [];
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  Tick: sound
  Charge: sound
  HeroIdle: costume:Hero
  RescuePose:
    kind: poseModel
    file: pose-models/rescue
actors:
  Hero: HeroIdle
poseRecognition:
  idleSound: Tick
  chargeSound: Charge
  feedback:
    mode: presenter
  navigation:
    allowSkip: true
scenes:
  rescue:
    poseModel: RescuePose
    actions:
      - Hero.pose:
          steps:
            - pose: help
            - pose: stand
`),
    port: {
      waitForPose: async (payload) => calls.push(payload),
    },
  });

  const state = await controller.start();
  assert.equal(state.status, 'finished');
  assert.deepEqual(
    calls.map(({pose, stepIndex, recognition}) => ({pose, stepIndex, recognition})),
    [
      {
        pose: 'help',
        stepIndex: 0,
        recognition: {
          confidenceThreshold: 0.5,
          fullConfidenceHoldSeconds: 1,
          idleChargePerSecond: 0,
          idleSound: 'Tick',
          chargeSound: 'Charge',
          feedback: {mode: 'presenter'},
          navigation: {allowSkip: true},
        },
      },
      {
        pose: 'stand',
        stepIndex: 1,
        recognition: {
          confidenceThreshold: 0.5,
          fullConfidenceHoldSeconds: 1,
          idleChargePerSecond: 0,
          idleSound: 'Tick',
          chargeSound: 'Charge',
          feedback: {mode: 'presenter'},
          navigation: {allowSkip: true},
        },
      },
    ],
  );
});

test('runs every Actor.pose step in order with optional skin and sound', async () => {
  const calls = [];
  const story = parseStory(`
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
  FirstSkin: costume:Hero
  LastSkin: costume:Hero
  Effect: sound
  RescuePose:
    kind: poseModel
    file: pose-models/rescue
actors:
  Hero: HeroIdle
scenes:
  opening:
    poseModel: RescuePose
    actions:
      - Hero.pose:
          steps:
            - pose: first
              skin: FirstSkin
              sound: Effect
            - pose: middle
            - pose: last
              skin: LastSkin
`);
  const controller = createDsl4RuntimeController({
    storyDocument: story,
    port: {
      setSkin: async ({skin}) => calls.push(['skin', skin]),
      waitForPose: async ({pose, recognition}) => calls.push(['wait', pose, recognition]),
      sound: async ({sound}) => calls.push(['sound', sound]),
    },
  });

  const state = await controller.start();

  assert.equal(state.status, 'finished');
  assert.deepEqual(
    calls.map(([method, value]) => [method, value]),
    [
      ['skin', 'FirstSkin'],
      ['wait', 'first'],
      ['sound', 'Effect'],
      ['wait', 'middle'],
      ['skin', 'LastSkin'],
      ['wait', 'last'],
    ],
  );
  assert.deepEqual(calls[1][2], {
    confidenceThreshold: 0.5,
    fullConfidenceHoldSeconds: 1,
    idleChargePerSecond: 0,
    idleSound: null,
    chargeSound: null,
    feedback: {mode: 'scratchMirror'},
    navigation: {allowSkip: false},
  });
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

test('cancelled pose keeps the current skin but does not sound or start a later step', async () => {
  const pendingPose = deferred();
  const poseStarted = deferred();
  const effects = [];
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
  HeroHappy: costume:Hero
  HeroLater: costume:Hero
  Effect: sound
  RescuePose:
    kind: poseModel
    file: pose-models/rescue
actors:
  Hero: HeroIdle
scenes:
  opening:
    poseModel: RescuePose
    actions:
      - Hero.pose:
          steps:
            - pose: happy
              skin: HeroHappy
              sound: Effect
            - pose: later
              skin: HeroLater
              sound: Effect
`),
    port: {
      waitForPose: ({pose}) => {
        effects.push(`wait:${pose}`);
        poseStarted.resolve();
        return pendingPose.promise;
      },
      setSkin: async ({skin}) => effects.push(`skin:${skin}`),
      sound: async ({sound}) => effects.push(`sound:${sound}`),
    },
  });
  const run = controller.start();
  await poseStarted.promise;
  controller.stop('cancel-pose');
  pendingPose.resolve();
  const state = await run;
  assert.equal(state.status, 'stopped');
  assert.deepEqual(effects, ['skin:HeroHappy', 'wait:happy']);
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

function poseNavigationStory(allowSkip, feedbackMode = 'scratchMirror') {
  return parseStory(`
kamishibai: '4.0'
assets:
  Tick: sound
  Charge: sound
  HeroIdle: costume:Hero
  Beach: backdrop
  RescuePose:
    kind: poseModel
    file: pose-models/rescue
actors:
  Hero: HeroIdle
poseRecognition:
  idleSound: Tick
  chargeSound: Charge
  feedback:
    mode: ${feedbackMode}
  navigation:
    allowSkip: ${allowSkip}
scenes:
  rescue:
    poseModel: RescuePose
    actions:
      - Hero.pose:
          steps:
            - pose: help
      - stage: Beach
`);
}

function poseWaitWithDeferredCleanup(cleanup, events) {
  return (_payload, context) =>
    new Promise((_resolve, reject) => {
      context.signal.addEventListener(
        'abort',
        () => {
          events.push('abort');
          void cleanup.promise.then(() => {
            events.push('cleanup');
            const error = new Error('pose wait cancelled');
            error.name = 'AbortError';
            reject(error);
          });
        },
        {once: true},
      );
    });
}

function poseSuboperationStory() {
  return parseStory(`
kamishibai: '4.0'
assets:
  Tick: sound
  Charge: sound
  StepSound: sound
  HeroIdle: costume:Hero
  HeroReady: costume:Hero
  Beach: backdrop
  RescuePose:
    kind: poseModel
    file: pose-models/rescue
actors:
  Hero: HeroIdle
poseRecognition:
  idleSound: Tick
  chargeSound: Charge
  navigation:
    allowSkip: false
scenes:
  rescue:
    poseModel: RescuePose
    actions:
      - Hero.pose:
          steps:
            - pose: help
              skin: HeroReady
              sound: StepSound
      - stage: Beach
`);
}

test('pose navigation policy refuses nextAction without cancelling an unskippable pose', async () => {
  const cleanup = deferred();
  const events = [];
  let stageCalls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument: poseNavigationStory(false),
    poseNavigationPolicyEnabled: true,
    port: {
      waitForPose: poseWaitWithDeferredCleanup(cleanup, events),
      stage: async () => stageCalls++,
    },
  });

  const run = controller.start();
  assert.equal(controller.canAdvance('navigation.nextAction'), false);
  const unchanged = await controller.advance('navigation.nextAction');
  assert.equal(unchanged.status, 'running');
  assert.deepEqual(events, []);
  assert.equal(stageCalls, 0);

  controller.stop('test-cleanup');
  cleanup.resolve();
  await run;
  assert.deepEqual(events, ['abort', 'cleanup']);
});

test('pose navigation policy is independent of all feedback modes', async () => {
  for (const feedbackMode of ['scratchMirror', 'scratchBinding', 'presenter']) {
    const blockedCleanup = deferred();
    const blocked = createDsl4RuntimeController({
      storyDocument: poseNavigationStory(false, feedbackMode),
      poseNavigationPolicyEnabled: true,
      port: {
        waitForPose: poseWaitWithDeferredCleanup(blockedCleanup, []),
        stage: async () => {},
      },
    });
    const blockedRun = blocked.start();
    assert.equal(blocked.canAdvance('navigation.nextAction'), false, feedbackMode);
    blocked.stop('test-cleanup');
    blockedCleanup.resolve();
    await blockedRun;

    const allowedCleanup = deferred();
    const allowed = createDsl4RuntimeController({
      storyDocument: poseNavigationStory(true, feedbackMode),
      poseNavigationPolicyEnabled: true,
      port: {
        waitForPose: poseWaitWithDeferredCleanup(allowedCleanup, []),
        stage: async () => {},
      },
    });
    const allowedRun = allowed.start();
    assert.equal(allowed.canAdvance('navigation.nextAction'), true, feedbackMode);
    allowed.stop('test-cleanup');
    allowedCleanup.resolve();
    await allowedRun;
  }
});

test('unskippable pose policy does not block navigation outside waitForPose', async () => {
  const skinPending = deferred();
  let skinWaitCalls = 0;
  let skinStageCalls = 0;
  const skinController = createDsl4RuntimeController({
    storyDocument: poseSuboperationStory(),
    poseNavigationPolicyEnabled: true,
    port: {
      setSkin: () => skinPending.promise,
      waitForPose: async () => skinWaitCalls++,
      sound: async () => {},
      stage: async () => skinStageCalls++,
    },
  });
  const skinRun = skinController.start();
  assert.equal(skinController.canAdvance('navigation.nextAction'), true);
  const skinAdvance = skinController.advance('navigation.nextAction');
  assert.equal((await skinAdvance).status, 'finished');
  assert.equal(skinStageCalls, 1);
  assert.equal(skinWaitCalls, 0);
  skinPending.resolve();
  await skinRun;

  const soundPending = deferred();
  let soundCalls = 0;
  let soundStageCalls = 0;
  const soundController = createDsl4RuntimeController({
    storyDocument: poseSuboperationStory(),
    poseNavigationPolicyEnabled: true,
    port: {
      setSkin: async () => {},
      waitForPose: async () => {},
      sound: () => {
        soundCalls += 1;
        return soundPending.promise;
      },
      stage: async () => soundStageCalls++,
    },
  });
  const soundRun = soundController.start();
  await waitFor(() => soundCalls === 1, 'pose step sound did not start');
  assert.equal(soundController.canAdvance('navigation.nextAction'), true);
  const soundAdvance = soundController.advance('navigation.nextAction');
  assert.equal((await soundAdvance).status, 'finished');
  assert.equal(soundStageCalls, 1);
  soundPending.resolve();
  await soundRun;
});

test('pose navigation policy waits for cleanup and advances a skippable pose once', async () => {
  const cleanup = deferred();
  const events = [];
  let stageCalls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument: poseNavigationStory(true),
    poseNavigationPolicyEnabled: true,
    port: {
      waitForPose: poseWaitWithDeferredCleanup(cleanup, events),
      stage: async () => {
        events.push('stage');
        stageCalls += 1;
      },
    },
  });

  const staleRun = controller.start();
  assert.equal(controller.canAdvance('navigation.nextAction'), true);
  const firstAdvance = controller.advance('navigation.nextAction');
  assert.equal(controller.canAdvance('navigation.nextAction'), false);
  const duplicateAdvance = controller.advance('navigation.nextAction');
  assert.strictEqual(duplicateAdvance, firstAdvance);
  assert.strictEqual(controller.getRunPromise(), firstAdvance);
  assert.deepEqual(events, ['abort']);
  assert.equal(stageCalls, 0);

  cleanup.resolve();
  const state = await firstAdvance;
  await duplicateAdvance;
  await staleRun;
  assert.equal(state.status, 'finished');
  assert.equal(stageCalls, 1);
  assert.deepEqual(events, ['abort', 'cleanup', 'stage']);
  assert.equal(controller.getTrace().filter(({type}) => type === 'navigation.advance').length, 1);
  assert.equal(controller.getRunPromise(), null);
});

test('stop wins while a skippable pose is waiting for cancellation cleanup', async () => {
  const cleanup = deferred();
  const events = [];
  let stageCalls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument: poseNavigationStory(true),
    poseNavigationPolicyEnabled: true,
    port: {
      waitForPose: poseWaitWithDeferredCleanup(cleanup, events),
      stage: async () => stageCalls++,
    },
  });

  const staleRun = controller.start();
  const advance = controller.advance('navigation.nextAction');
  const stopped = controller.stop('runtime-stop');
  assert.equal(stopped.status, 'stopped');
  cleanup.resolve();
  const finalState = await advance;
  await staleRun;

  assert.equal(finalState.status, 'stopped');
  assert.equal(stageCalls, 0);
  assert.deepEqual(events, ['abort', 'cleanup']);
  assert.equal(controller.getTrace().filter(({type}) => type === 'navigation.advance').length, 0);
  assert.equal(controller.getTrace().filter(({type}) => type === 'action.cancel').length, 1);
  assert.equal(controller.getRunPromise(), null);
});

test('releases the pose cleanup lock when the next pending action starts', async () => {
  const poseCleanup = deferred();
  const nextWait = deferred();
  let stageCalls = 0;
  const story = parseStory(`
kamishibai: '4.0'
assets:
  Tick: sound
  Charge: sound
  HeroIdle: costume:Hero
  Beach: backdrop
  RescuePose:
    kind: poseModel
    file: pose-models/rescue
actors:
  Hero: HeroIdle
poseRecognition:
  idleSound: Tick
  chargeSound: Charge
  navigation:
    allowSkip: true
scenes:
  rescue:
    poseModel: RescuePose
    actions:
      - Hero.pose:
          steps:
            - pose: help
      - wait: 1
      - stage: Beach
`);
  const controller = createDsl4RuntimeController({
    storyDocument: story,
    poseNavigationPolicyEnabled: true,
    port: {
      waitForPose: poseWaitWithDeferredCleanup(poseCleanup, []),
      wait: () => nextWait.promise,
      stage: async () => stageCalls++,
    },
  });

  const initialRun = controller.start();
  const poseAdvance = controller.advance('navigation.nextAction');
  poseCleanup.resolve();
  await waitFor(
    () => controller.getState().actionPath === '/scenes/rescue/actions/1',
    'next pending action did not start after pose cleanup',
  );

  const waitAdvance = controller.advance('navigation.nextAction');
  const state = await waitAdvance;
  assert.equal(state.status, 'finished');
  assert.equal(stageCalls, 1);

  nextWait.resolve();
  await Promise.all([initialRun, poseAdvance]);
});

test('pose skip at a scene end waits for cleanup before asset-coordinated next scene effects', async () => {
  const cleanup = deferred();
  const events = [];
  const lifecycleCalls = [];
  const story = parseStory(`
kamishibai: '4.0'
assets:
  Tick: sound
  Charge: sound
  HeroIdle: costume:Hero
  NextBackdrop:
    kind: backdrop
    name: NextBackdrop
    loading: lazy
  RescuePose:
    kind: poseModel
    file: pose-models/rescue
actors:
  Hero: HeroIdle
poseRecognition:
  idleSound: Tick
  chargeSound: Charge
  navigation:
    allowSkip: true
scenes:
  rescue:
    poseModel: RescuePose
    actions:
      - Hero.pose:
          steps:
            - pose: help
  ending:
    - stage: NextBackdrop
`);
  const controller = createDsl4RuntimeController({
    storyDocument: story,
    poseNavigationPolicyEnabled: true,
    port: {
      waitForPose: (_payload, context) =>
        new Promise((_resolve, reject) => {
          events.push('pose-start');
          context.signal.addEventListener(
            'abort',
            () => {
              events.push('abort');
              void cleanup.promise.then(() => {
                events.push('cleanup');
                const error = new Error('pose wait cancelled');
                error.name = 'AbortError';
                reject(error);
              });
            },
            {once: true},
          );
        }),
      stage: async () => events.push('stage'),
    },
    assetLifecycle: {
      async prepare(payload) {
        lifecycleCalls.push({method: 'prepare', payload});
      },
      async setLoading(payload) {
        lifecycleCalls.push({method: 'setLoading', payload});
      },
      async releaseAssets(payload) {
        lifecycleCalls.push({method: 'releaseAssets', payload});
      },
      async release(payload) {
        lifecycleCalls.push({method: 'release', payload});
      },
    },
  });

  const initialRun = controller.start();
  await waitFor(() => events.includes('pose-start'), 'pose did not start after asset startup');
  const advance = controller.advance('navigation.nextAction');
  assert.deepEqual(events, ['pose-start', 'abort']);
  cleanup.resolve();

  const state = await advance;
  await initialRun;
  assert.equal(state.status, 'finished');
  assert.equal(state.sceneId, 'ending');
  assert.ok(events.indexOf('cleanup') < events.indexOf('stage'));
  assert.equal(
    lifecycleCalls.some(
      ({method, payload}) =>
        method === 'prepare' && payload.phase === 'scene' && payload.sceneId === 'ending',
    ),
    true,
  );
  assert.equal(controller.getTrace().filter(({type}) => type === 'navigation.advance').length, 1);
});

test('restart invalidates an old pose cleanup lock without waiting for it', async () => {
  const oldCleanup = deferred();
  const newCleanup = deferred();
  const cancelReasons = [];
  let poseCalls = 0;
  let stageCalls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument: poseNavigationStory(true),
    poseNavigationPolicyEnabled: true,
    onEvent(event) {
      if (event.type === 'action.cancel') cancelReasons.push(event.details.reason);
    },
    port: {
      waitForPose(payload, context) {
        poseCalls += 1;
        const cleanup = poseCalls === 1 ? oldCleanup : newCleanup;
        return poseWaitWithDeferredCleanup(cleanup, [])(payload, context);
      },
      stage: async () => stageCalls++,
    },
  });

  const firstRun = controller.start();
  const oldAdvance = controller.advance('navigation.nextAction');
  const restartedRun = controller.start();
  assert.equal(poseCalls, 2);
  assert.equal(controller.canAdvance('navigation.nextAction'), true);

  const newAdvance = controller.advance('navigation.nextAction');
  newCleanup.resolve();
  const state = await newAdvance;
  assert.equal(state.status, 'finished');
  assert.equal(stageCalls, 1);

  oldCleanup.resolve();
  await Promise.all([firstRun, oldAdvance, restartedRun]);
  assert.equal(controller.getState().status, 'finished');
  assert.equal(stageCalls, 1);
  assert.deepEqual(cancelReasons, ['navigation.nextAction', 'navigation.nextAction']);
});

test('pose navigation policy remains inert while its startup gate is disabled', async () => {
  const pending = deferred();
  let stageCalls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument: poseNavigationStory(false),
    port: {
      waitForPose: () => pending.promise,
      stage: async () => stageCalls++,
    },
  });

  const staleRun = controller.start();
  await controller.advance('navigation.nextAction');
  assert.equal(stageCalls, 1);
  pending.resolve();
  await staleRun;
});

test('finishes background presentation state before advance aborts the current action', async () => {
  const waitPending = deferred();
  const waitStarted = deferred();
  const order = [];
  let transitionActive = false;
  let ghost = null;
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
actors:
  Hero: HeroIdle
scenes:
  opening:
    - Hero.setTransparency:
        from: 0
        to: 50
        seconds: 1
        background: true
    - wait: 1
`),
    port: {
      setTransparency(payload) {
        transitionActive = true;
        ghost = payload.from;
      },
      wait(_payload, context) {
        context.signal.addEventListener(
          'abort',
          () => {
            order.push('abort-current-action');
          },
          {once: true},
        );
        waitStarted.resolve();
        return waitPending.promise;
      },
      finishPresentationTransitions() {
        if (!transitionActive) return;
        ghost = 50;
        transitionActive = false;
        order.push('finish-to-50');
      },
    },
  });
  const staleRun = controller.start();
  await waitStarted.promise;
  const advanced = await controller.advance('skip');

  assert.equal(advanced.status, 'finished');
  assert.equal(ghost, 50);
  assert.deepEqual(order, ['finish-to-50', 'abort-current-action']);
  waitPending.resolve();
  await staleRun;
});

test('does not skip when background presentation finalization fails and permits a retry', async () => {
  const waitPending = deferred();
  const waitStarted = deferred();
  const order = [];
  let finalizationFailures = 1;
  let transitionActive = false;
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
actors:
  Hero: HeroIdle
scenes:
  opening:
    - Hero.setTransparency:
        from: 0
        to: 50
        seconds: 1
        background: true
    - wait: 1
`),
    port: {
      setTransparency() {
        transitionActive = true;
      },
      wait(_payload, context) {
        context.signal.addEventListener(
          'abort',
          () => {
            order.push('abort-current-action');
          },
          {once: true},
        );
        waitStarted.resolve();
        return waitPending.promise;
      },
      finishPresentationTransitions() {
        if (!transitionActive) return;
        if (finalizationFailures > 0) {
          finalizationFailures -= 1;
          order.push('finish-failed');
          throw new Error('finalization failed');
        }
        transitionActive = false;
        order.push('finish-to-50');
      },
    },
  });
  const staleRun = controller.start();
  await waitStarted.promise;

  assert.throws(() => controller.advance('first-skip'), /finalization failed/u);
  assert.equal(controller.getState().status, 'running');
  assert.deepEqual(order, ['finish-failed']);

  const advanced = await controller.advance('retry-skip');
  assert.equal(advanced.status, 'finished');
  assert.deepEqual(order, ['finish-failed', 'finish-to-50', 'abort-current-action']);
  waitPending.resolve();
  await staleRun;
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

test('starts a replacement runtime at one planned action with migrated variables', async () => {
  const calls = [];
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
variables:
  score: 1
  hero: Alice
scenes:
  opening:
    - wait: 1
    - wait: 2
    - wait: 3
`),
    port: {
      wait: async (payload, context) => {
        calls.push({seconds: payload.seconds, variables: context.variables});
      },
    },
  });

  const state = await controller.start({
    sceneId: 'opening',
    actionIndex: 1,
    variables: {score: 42, hero: 'Bob'},
  });
  assert.equal(state.status, 'finished');
  assert.deepEqual(calls, [
    {seconds: 2, variables: {score: 42, hero: 'Bob'}},
    {seconds: 3, variables: {score: 42, hero: 'Bob'}},
  ]);
  assert.deepEqual(state.variables, {score: 42, hero: 'Bob'});
  assert.equal(
    controller
      .getTrace()
      .some(
        ({type, actionPath}) =>
          type === 'action.start' && actionPath === '/scenes/opening/actions/0',
      ),
    false,
  );
});

test('rejects invalid replacement state before cancelling the active action', async () => {
  const pending = deferred();
  let activeSignal;
  const controller = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
variables:
  score: 1
scenes:
  opening:
    - wait: 1
    - wait: 2
`),
    port: {
      wait: (_payload, context) => {
        activeSignal = context.signal;
        return pending.promise;
      },
    },
  });
  const run = controller.start();
  await Promise.resolve();
  assert.equal(activeSignal.aborted, false);

  assert.throws(
    () => controller.start({sceneId: 'opening', actionIndex: 9, variables: {score: 2}}),
    /Invalid runtime start position/u,
  );
  assert.throws(
    () => controller.start({sceneId: 'opening', actionIndex: 1, variables: {score: 'wrong'}}),
    /wrong type/u,
  );
  assert.throws(
    () => controller.start({sceneId: 'opening', actionIndex: 1, variables: {score: 2, extra: 1}}),
    /match every declared story variable/u,
  );
  assert.equal(controller.getState().status, 'running');
  assert.equal(activeSignal.aborted, false);

  controller.stop('test-cleanup');
  pending.resolve();
  await run;
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
    const parsedStory = parseStory(`
kamishibai: '4.0'
scenes:
  opening:
    - wait: 0
`);
    const actionPath = '/scenes/opening/actions/0';
    const includedRange = parsedStory.sourceMap[actionPath];
    const controller = createDsl4RuntimeController({
      storyDocument: {
        ...parsedStory,
        sourceOrigins: {
          [actionPath]: {sourceId: 'chapters/opening.k4.yml', range: includedRange},
        },
      },
      port,
    });
    const state = await controller.start();
    assert.equal(state.status, 'failed');
    assert.equal(state.diagnostic.code, expectedCode);
    assert.equal(state.diagnostic.storyPath, actionPath);
    assert.equal(state.diagnostic.sourceId, 'chapters/opening.k4.yml');
    assert.deepEqual(state.diagnostic.range, includedRange);
    assert.equal(controller.getTrace().at(-1).type, 'runtime.fail');
  });
}

test('rejects key and pose input results outside their declared routes', async () => {
  const keyController = createDsl4RuntimeController({
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
  const poseController = createDsl4RuntimeController({
    storyDocument: parseStory(`
kamishibai: '4.0'
assets:
  RescuePose:
    kind: poseModel
    file: pose-models/rescue
scenes:
  opening:
    poseModel: RescuePose
    actions:
      - poseInputToChangeScene:
          happy: ending
  ending: []
`),
    port: {poseInputToChangeScene: async () => 'jump'},
  });

  for (const controller of [keyController, poseController]) {
    const state = await controller.start();
    assert.equal(state.status, 'failed');
    assert.equal(state.diagnostic.code, 'K4-RUNTIME-RESULT-001');
  }
});
