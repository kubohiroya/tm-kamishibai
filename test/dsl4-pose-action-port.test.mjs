import assert from 'node:assert/strict';
import test from 'node:test';

import {createAsyncInputComposition} from '@kubohiroya/turbowarp-async-input/composition';

import {createDsl4PoseActionPort} from '../src/dsl4/platform/index.js';

function actionContext(controller = new AbortController()) {
  return {signal: controller.signal, generation: 1, sceneId: 'rescue'};
}

function sequencePayload(overrides = {}) {
  return {
    target: 'Hero',
    pose: 'help',
    stepIndex: 0,
    poseModel: 'RescuePose',
    recognition: {
      confidenceThreshold: 0.5,
      fullConfidenceHoldSeconds: 1,
      idleChargePerSecond: 0,
      idleSound: 'Tick',
      chargeSound: 'Charge',
      feedback: {mode: 'scratchMirror'},
      navigation: {allowSkip: false},
    },
    ...overrides,
  };
}

/** @param {'scratchMirror' | 'scratchBinding' | 'presenter'} mode */
function sequencePayloadWithFeedback(mode) {
  const payload = sequencePayload();
  return {
    ...payload,
    recognition: {...payload.recognition, feedback: {mode}},
  };
}

function selectionPayload(overrides = {}) {
  return {
    poses: ['help', 'stand'],
    poseModel: 'RescuePose',
    recognition: {
      accumulationPerSecond: 2,
      decayPerSecond: 0.8,
      scoreThreshold: 1,
    },
    ...overrides,
  };
}

function poseEvent(poseName, previousPoseName = '') {
  return {
    version: 1,
    poseName,
    previousPoseName,
    score: poseName ? 1 : 0,
    reason: poseName ? 'prediction' : 'reset',
    timestamp: 1,
  };
}

function manualClock() {
  let time = 0;
  let nextId = 0;
  const scheduled = new Map();
  return {
    now: () => time,
    schedule(callback) {
      const id = ++nextId;
      scheduled.set(id, callback);
      return () => scheduled.delete(id);
    },
    advance(milliseconds) {
      time += milliseconds;
      const callbacks = [...scheduled.values()];
      scheduled.clear();
      for (const callback of callbacks) callback();
    },
    get size() {
      return scheduled.size;
    },
  };
}

function fakeTMPose(overrides = {}) {
  const listeners = new Set();
  const log = [];
  const labels = new Map([['RescuePose', ['help', 'stand']]]);
  const confidence = new Map([
    ['help', 0],
    ['stand', 0],
  ]);
  let activeModel = 'OtherPose';
  let recognizing = true;
  const composition = {
    activatePoseModel(name) {
      log.push(['activate', name]);
      activeModel = name;
    },
    isPoseModelRegistered(name) {
      return labels.has(name);
    },
    getActivePoseModelName() {
      return activeModel;
    },
    async startRecognition() {
      log.push(['recognition.start']);
      recognizing = true;
    },
    stopRecognition() {
      log.push(['recognition.stop']);
      recognizing = false;
    },
    isRecognizing() {
      return recognizing;
    },
    confidenceOf(name) {
      return confidence.get(name) ?? 0;
    },
    configureAccumulatedPose(configuration) {
      log.push(['selection.configure', configuration]);
    },
    resetAccumulatedPose() {
      log.push(['selection.reset']);
    },
    subscribeAccumulatedPose(listener) {
      log.push(['selection.subscribe']);
      listeners.add(listener);
      return () => {
        log.push(['selection.unsubscribe']);
        listeners.delete(listener);
      };
    },
    ...overrides,
  };
  return {
    composition,
    confidence,
    labels,
    listeners,
    log,
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function setup(overrides = {}) {
  const pose = fakeTMPose();
  const asyncInput = createAsyncInputComposition({poseSource: pose.composition});
  const clock = manualClock();
  const sounds = [];
  const port = createDsl4PoseActionPort({
    tmposeComposition: pose.composition,
    asyncInputComposition: asyncInput,
    getPoseModelLabels: (name) => pose.labels.get(name) ?? null,
    playSound(sound) {
      sounds.push(['play', sound]);
    },
    stopSound(sound) {
      sounds.push(['stop', sound]);
    },
    schedule: clock.schedule,
    now: clock.now,
    ...overrides,
  });
  return {pose, asyncInput, clock, sounds, port};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('charges one Actor pose from elapsed confidence and controls recognition feedback sounds', async () => {
  const {pose, clock, sounds, port} = setup();
  let settled = false;
  const pending = port.waitForPose(sequencePayload(), actionContext()).then(() => {
    settled = true;
  });
  await flush();

  assert.deepEqual(pose.log.slice(0, 3), [
    ['recognition.stop'],
    ['activate', 'RescuePose'],
    ['recognition.start'],
  ]);
  assert.deepEqual(sounds, [['play', 'Tick']]);
  assert.equal(clock.size, 1);

  pose.confidence.set('help', 0.4);
  clock.advance(500);
  await flush();
  assert.equal(settled, false);

  pose.confidence.set('help', 1);
  clock.advance(1000);
  await pending;
  assert.equal(settled, true);
  assert.deepEqual(sounds, [
    ['play', 'Tick'],
    ['play', 'Charge'],
    ['stop', 'Tick'],
  ]);
});

test('publishes deterministic immutable state through completion without Scratch or DOM fields', async () => {
  const states = [];
  const {pose, clock, port} = setup({
    onPoseState(event) {
      states.push(event);
    },
  });
  const pending = port.waitForPose(sequencePayload(), actionContext());
  await flush();

  pose.confidence.set('help', 0.4);
  clock.advance(500);
  await flush();
  pose.confidence.set('help', 1);
  clock.advance(1000);
  await pending;

  assert.deepEqual(
    states.map(({phase, confidence, progress}) => [phase, confidence, progress]),
    [
      ['waiting', 0, 0],
      ['waiting', 0.4, 0],
      ['charging', 1, 1],
      ['completed', 1, 1],
    ],
  );
  assert.ok(states.every((event) => Object.isFrozen(event)));
  assert.ok(
    states.every(
      ({target, pose: poseName, stepIndex}) =>
        target === 'Hero' && poseName === 'help' && stepIndex === 0,
    ),
  );
  assert.ok(states.every((event) => !Object.hasOwn(event, 'scratchVariableId')));
  assert.ok(states.every((event) => !Object.hasOwn(event, 'element')));
});

test('publishes a final cancelled state after action abort and releases its timer', async () => {
  const states = [];
  const {clock, port} = setup({onPoseState: (event) => states.push(event)});
  const controller = new AbortController();
  const pending = port.waitForPose(sequencePayload(), actionContext(controller));
  await flush();
  controller.abort('scene-transition');
  await assert.rejects(pending, (error) => error.name === 'AbortError');

  assert.equal(clock.size, 0);
  assert.deepEqual(
    states.map(({phase}) => phase),
    ['waiting', 'cancelled'],
  );
});

test('contains synchronous and asynchronous observer failures without changing pose execution', async () => {
  let calls = 0;
  const {pose, clock, sounds, port} = setup({
    onPoseState() {
      calls += 1;
      if (calls === 1) throw new Error('sync observer failure');
      return Promise.reject(new Error('async observer failure'));
    },
  });
  const pending = port.waitForPose(sequencePayload(), actionContext());
  await flush();
  pose.confidence.set('help', 1);
  clock.advance(1000);
  await pending;
  await flush();

  assert.equal(calls, 3);
  assert.equal(clock.size, 0);
  assert.deepEqual(sounds, [
    ['play', 'Tick'],
    ['play', 'Charge'],
    ['stop', 'Tick'],
  ]);
});

test('applies one normalized Scratch binding snapshot before the deterministic pose tick', async () => {
  const states = [];
  let reads = 0;
  const {clock, sounds, port} = setup({
    onPoseState: (event) => states.push(event),
    readPoseStateBinding() {
      reads += 1;
      return {confidence: 1, progress: 0.5};
    },
  });
  const pending = port.waitForPose(sequencePayloadWithFeedback('scratchBinding'), actionContext());
  await flush();
  clock.advance(500);
  await pending;

  assert.equal(reads, 1);
  assert.deepEqual(
    states.map(({phase, confidence, progress}) => [phase, confidence, progress]),
    [
      ['waiting', 0, 0],
      ['charging', 1, 1],
      ['completed', 1, 1],
    ],
  );
  assert.deepEqual(sounds, [
    ['play', 'Tick'],
    ['play', 'Charge'],
    ['stop', 'Tick'],
  ]);
});

test('never samples a Scratch binding for mirror or presenter feedback', async () => {
  for (const mode of ['scratchMirror', 'presenter']) {
    let reads = 0;
    const {pose, clock, port} = setup({
      readPoseStateBinding() {
        reads += 1;
        return {progress: 1};
      },
    });
    pose.confidence.set('help', 1);

    const pending = port.waitForPose(sequencePayloadWithFeedback(mode), actionContext());
    await flush();
    clock.advance(1000);
    await pending;

    assert.equal(reads, 0, mode);
  }
});

test('ignores asynchronous or malformed binding samples and waits for the next valid tick', async () => {
  let reads = 0;
  const {clock, port} = setup({
    readPoseStateBinding() {
      reads += 1;
      if (reads === 1) return Promise.resolve({progress: 1});
      return {progress: 1};
    },
  });
  const pending = port.waitForPose(
    sequencePayload({
      recognition: {
        confidenceThreshold: 0.5,
        fullConfidenceHoldSeconds: 1,
        idleChargePerSecond: 0,
        idleSound: null,
        chargeSound: null,
        feedback: {mode: 'scratchBinding'},
        navigation: {allowSkip: false},
      },
    }),
    actionContext(),
  );
  await flush();
  clock.advance(100);
  await flush();
  assert.equal(reads, 1);
  clock.advance(100);
  await pending;
  assert.equal(reads, 2);
});

test('uses idleChargePerSecond only while confidence is below threshold', async () => {
  const {pose, clock, sounds, port} = setup();
  pose.confidence.set('help', 0.49);
  const payload = sequencePayload({
    recognition: {
      confidenceThreshold: 0.5,
      fullConfidenceHoldSeconds: 1,
      idleChargePerSecond: 1,
      idleSound: null,
      chargeSound: null,
      feedback: {mode: 'scratchMirror'},
      navigation: {allowSkip: false},
    },
  });
  const pending = port.waitForPose(payload, actionContext());
  await flush();
  clock.advance(1000);
  await pending;
  assert.deepEqual(sounds, []);
});

test('selects one candidate in a reset action session and applies selection configuration', async () => {
  const {pose, port} = setup();
  const pending = port.poseInputToChangeScene(selectionPayload(), actionContext());
  await flush();

  assert.deepEqual(pose.log.slice(-4), [
    ['selection.configure', {accumulationPerSecond: 2, decayPerSecond: 0.8, scoreThreshold: 1}],
    ['recognition.start'],
    ['selection.reset'],
    ['selection.subscribe'],
  ]);
  pose.emit(poseEvent('other'));
  pose.emit(poseEvent('stand', 'other'));
  await assert.doesNotReject(async () => assert.equal(await pending, 'stand'));
  assert.equal(pose.listeners.size, 0);
});

test('keeps only the latest overlapping candidate wait', async () => {
  const {pose, port} = setup();
  const first = port.poseInputToChangeScene(selectionPayload({poses: ['help']}), actionContext());
  const firstRejected = assert.rejects(first, (error) => error.name === 'AbortError');
  await flush();
  const second = port.poseInputToChangeScene(selectionPayload({poses: ['stand']}), actionContext());
  await firstRejected;
  await flush();

  assert.equal(pose.listeners.size, 1);
  assert.equal(pose.log.filter(([method]) => method === 'selection.reset').length, 2);
  pose.emit(poseEvent('help'));
  pose.emit(poseEvent('stand', 'help'));
  assert.equal(await second, 'stand');
});

test('cancels active selection for Actor sequence and queues selection until sequence ends', async () => {
  const {pose, clock, port} = setup();
  const displaced = port.poseInputToChangeScene(
    selectionPayload({poses: ['help']}),
    actionContext(),
  );
  const displacedRejected = assert.rejects(displaced, (error) => error.name === 'AbortError');
  await flush();
  assert.equal(pose.listeners.size, 1);

  pose.confidence.set('help', 1);
  const sequence = port.waitForPose(
    sequencePayload({
      recognition: {
        confidenceThreshold: 0.5,
        fullConfidenceHoldSeconds: 1,
        idleChargePerSecond: 0,
        idleSound: null,
        chargeSound: null,
        feedback: {mode: 'scratchMirror'},
        navigation: {allowSkip: false},
      },
    }),
    actionContext(),
  );
  const queuedSelection = port.poseInputToChangeScene(
    selectionPayload({poses: ['stand']}),
    actionContext(),
  );
  await displacedRejected;
  await flush();

  assert.equal(pose.listeners.size, 0);
  pose.emit(poseEvent('stand'));
  assert.equal(clock.size, 1);
  clock.advance(1000);
  await sequence;
  await flush();
  assert.equal(pose.listeners.size, 1);
  pose.emit(poseEvent('stand'));
  assert.equal(await queuedSelection, 'stand');
});

test('aborts either mode without leaving timers or listeners', async () => {
  const {pose, clock, port} = setup();
  const sequenceController = new AbortController();
  const sequence = port.waitForPose(sequencePayload(), actionContext(sequenceController));
  await flush();
  sequenceController.abort('scene-reposition');
  await assert.rejects(sequence, (error) => error.name === 'AbortError');
  assert.equal(clock.size, 0);

  const selectionController = new AbortController();
  const selection = port.poseInputToChangeScene(
    selectionPayload(),
    actionContext(selectionController),
  );
  await flush();
  selectionController.abort('live-reload');
  await assert.rejects(selection, (error) => error.name === 'AbortError');
  assert.equal(pose.listeners.size, 0);
});

test('rejects unavailable models, unknown labels, invalid confidence, and concurrent sequences', async () => {
  const {pose, clock, port} = setup();
  await assert.rejects(
    port.waitForPose(sequencePayload({poseModel: 'Missing'}), actionContext()),
    (error) => error.code === 'K4-POSE-PORT-002',
  );
  await assert.rejects(
    port.poseInputToChangeScene(selectionPayload({poses: ['unknown']}), actionContext()),
    (error) => error.code === 'K4-POSE-PORT-003',
  );

  pose.confidence.set('help', 2);
  const invalidConfidence = port.waitForPose(sequencePayload(), actionContext());
  await flush();
  await assert.rejects(
    port.waitForPose(sequencePayload(), actionContext()),
    (error) => error.code === 'K4-POSE-PORT-006',
  );
  clock.advance(100);
  await assert.rejects(invalidConfidence, (error) => error.code === 'K4-POSE-PORT-007');
});

test('dispose is idempotent, cancels active work, and makes the port final', async () => {
  const {port} = setup();
  const pending = port.poseInputToChangeScene(selectionPayload(), actionContext());
  const rejected = assert.rejects(pending, (error) => error.name === 'AbortError');
  await flush();
  const firstDispose = port.dispose();
  const secondDispose = port.dispose();
  assert.strictEqual(secondDispose, firstDispose);
  await Promise.all([rejected, firstDispose]);
  await assert.rejects(
    port.poseInputToChangeScene(selectionPayload(), actionContext()),
    (error) => error.code === 'K4-POSE-PORT-005',
  );
});
