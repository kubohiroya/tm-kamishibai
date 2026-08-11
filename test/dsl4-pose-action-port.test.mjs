import assert from 'node:assert/strict';
import test from 'node:test';

import {createAsyncInputComposition} from '@kubohiroya/turbowarp-async-input/composition';

import {createDsl4PoseActionPort} from '../src/dsl4/platform/index.js';

function actionContext(controller = new AbortController()) {
  return {signal: controller.signal, generation: 1, sceneId: 'rescue'};
}

function sequenceActionContext(stepController, actionController) {
  return {
    ...actionContext(stepController),
    actionSignal: actionController.signal,
  };
}

function sequencePayload(overrides = {}) {
  return {
    target: 'Hero',
    pose: 'help',
    stepIndex: 0,
    stepCount: 1,
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
  let previewVisible = true;
  const preview = [];
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
    showPreview() {
      previewVisible = true;
      preview.push(['show']);
    },
    hidePreview() {
      previewVisible = false;
      preview.push(['hide']);
    },
    isPreviewVisible() {
      return previewVisible;
    },
    setPreviewPosition(position) {
      preview.push(['position', position]);
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
    preview,
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function setup(overrides = {}) {
  const {tmpose: tmposeOverrides = {}, ...portOverrides} = overrides;
  const pose = fakeTMPose(tmposeOverrides);
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
    ...portOverrides,
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
  assert.deepEqual(pose.preview, [['position', 'full-stage'], ['show'], ['hide']]);
  assert.equal(pose.composition.isPreviewVisible(), false);
  assert.equal(pose.composition.isRecognizing(), true);
});

test('keeps the camera preview visible until the final pose step completes', async () => {
  const {pose, clock, port} = setup();
  const actionController = new AbortController();
  pose.confidence.set('help', 1);

  const first = port.waitForPose(
    sequencePayload({stepIndex: 0, stepCount: 2}),
    sequenceActionContext(new AbortController(), actionController),
  );
  await flush();
  clock.advance(1000);
  await first;

  assert.equal(pose.composition.isPreviewVisible(), true);
  assert.equal(pose.preview.filter(([method]) => method === 'hide').length, 0);

  pose.confidence.set('stand', 1);
  const final = port.waitForPose(
    sequencePayload({pose: 'stand', stepIndex: 1, stepCount: 2}),
    sequenceActionContext(new AbortController(), actionController),
  );
  await flush();
  clock.advance(1000);
  await final;

  assert.equal(pose.composition.isPreviewVisible(), false);
  assert.equal(pose.preview.filter(([method]) => method === 'hide').length, 1);
});

test('keeps the camera preview while an intermediate pose step is skipped', async () => {
  const {pose, port} = setup();
  const actionController = new AbortController();
  const stepController = new AbortController();
  const first = port.waitForPose(
    sequencePayload({stepIndex: 0, stepCount: 2}),
    sequenceActionContext(stepController, actionController),
  );
  await flush();

  stepController.abort('navigation.nextAction');
  await assert.rejects(first, (error) => error.name === 'AbortError');
  assert.equal(pose.composition.isPreviewVisible(), true);
  assert.equal(pose.preview.filter(([method]) => method === 'hide').length, 0);

  actionController.abort('scene-transition');
  assert.equal(pose.composition.isPreviewVisible(), false);
  assert.equal(pose.preview.filter(([method]) => method === 'hide').length, 1);
});

test('shows a non-authoritative camera busy indicator while recognition starts', async () => {
  const busy = [];
  const cursors = [];
  const {pose, port} = setup({
    setBusy(event) {
      busy.push(event);
    },
    setCursor(event) {
      cursors.push(event);
    },
  });
  let releaseRecognition;
  pose.composition.startRecognition = () =>
    new Promise((resolve) => {
      releaseRecognition = resolve;
    });
  const controller = new AbortController();
  const pending = port.waitForPose(sequencePayload(), actionContext(controller));
  await flush();

  assert.deepEqual(busy, [
    {visible: true, source: 'camera', label: 'Starting camera', cursor: 'wait'},
  ]);
  releaseRecognition();
  await flush();
  assert.deepEqual(busy, [
    {visible: true, source: 'camera', label: 'Starting camera', cursor: 'wait'},
    {visible: false, source: 'camera', label: 'Starting camera', cursor: 'wait'},
  ]);
  assert.deepEqual(cursors, [{visible: true, source: 'pose-sequence', cursor: 'progress'}]);

  controller.abort();
  await assert.rejects(pending, /cancelled/u);
  assert.deepEqual(cursors, [
    {visible: true, source: 'pose-sequence', cursor: 'progress'},
    {visible: false, source: 'pose-sequence', cursor: 'progress'},
  ]);
  await port.dispose();
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

test('aborts during recognition startup and reuses the pending startup for the next step', async () => {
  let finishStartup = () => {};
  const startup = new Promise((resolve) => {
    finishStartup = resolve;
  });
  const states = [];
  let recognizing = false;
  let startCalls = 0;
  const {pose, clock, port} = setup({
    tmpose: {
      isRecognizing: () => recognizing,
      async startRecognition() {
        startCalls += 1;
        await startup;
        recognizing = true;
      },
    },
    onPoseState: (event) => states.push(event),
  });
  pose.confidence.set('help', 1);

  const firstController = new AbortController();
  const first = port.waitForPose(sequencePayload(), actionContext(firstController));
  await flush();
  assert.equal(startCalls, 1);

  firstController.abort('navigation.nextAction');
  await assert.rejects(first, (error) => error.name === 'AbortError');
  assert.deepEqual(
    states.map(({phase, stepIndex}) => [phase, stepIndex]),
    [
      ['waiting', 0],
      ['cancelled', 0],
    ],
  );

  const second = port.waitForPose(sequencePayload({stepIndex: 1, stepCount: 2}), actionContext());
  await flush();
  assert.equal(startCalls, 1);
  assert.equal(clock.size, 0);

  finishStartup();
  await flush();
  assert.equal(clock.size, 1);
  clock.advance(1000);
  await second;
  assert.equal(startCalls, 1);
  assert.deepEqual(
    states.map(({phase, stepIndex}) => [phase, stepIndex]),
    [
      ['waiting', 0],
      ['cancelled', 0],
      ['waiting', 1],
      ['charging', 1],
      ['completed', 1],
    ],
  );
});

test('publishes completed before awaiting asynchronous sound cleanup', async () => {
  const states = [];
  let finishSoundCleanup = () => {};
  const soundCleanup = new Promise((resolve) => {
    finishSoundCleanup = resolve;
  });
  const {pose, clock, port} = setup({
    onPoseState: (event) => states.push(event),
    stopSound: () => soundCleanup,
  });
  const pending = port.waitForPose(sequencePayload(), actionContext());
  let settled = false;
  pending.then(() => {
    settled = true;
  });
  await flush();
  pose.confidence.set('help', 1);
  clock.advance(1000);
  await flush();

  assert.equal(settled, false);
  assert.deepEqual(
    states.map(({phase}) => phase),
    ['waiting', 'charging', 'completed'],
  );
  assert.deepEqual(pose.preview.slice(-1), [['hide']]);
  assert.equal(pose.composition.isRecognizing(), true);

  finishSoundCleanup();
  await pending;
  assert.equal(states.filter(({phase}) => phase === 'completed').length, 1);
});

test('publishes cancelled before awaiting asynchronous sound cleanup', async () => {
  const states = [];
  let finishSoundCleanup = () => {};
  const soundCleanup = new Promise((resolve) => {
    finishSoundCleanup = resolve;
  });
  const controller = new AbortController();
  const {pose, port} = setup({
    onPoseState: (event) => states.push(event),
    stopSound: () => soundCleanup,
  });
  const pending = port.waitForPose(sequencePayload(), actionContext(controller));
  let settled = false;
  pending.catch(() => {
    settled = true;
  });
  await flush();
  controller.abort('scene-transition');
  await flush();

  assert.equal(settled, false);
  assert.deepEqual(
    states.map(({phase}) => phase),
    ['waiting', 'cancelled'],
  );
  assert.deepEqual(pose.preview.slice(-1), [['hide']]);
  assert.equal(pose.composition.isRecognizing(), true);

  finishSoundCleanup();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(states.filter(({phase}) => phase === 'cancelled').length, 1);
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
    port.waitForPose(sequencePayload({stepIndex: 2, stepCount: 2}), actionContext()),
    (error) => error.code === 'K4-POSE-PORT-001',
  );
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
