import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDsl4ScratchPoseFeedbackAdapter,
  dsl4ScratchPoseFeedbackVariableNames,
} from '../src/dsl4/platform/index.js';

function event(overrides = {}) {
  return {
    phase: 'charging',
    target: 'Hero',
    pose: 'help',
    stepIndex: 0,
    confidence: 0.82,
    progress: 0.64,
    ...overrides,
  };
}

function fakeRuntime(overrides = {}) {
  const confidence = overrides.confidenceVariable ?? {value: 0};
  const progress = overrides.progressVariable ?? {value: 0};
  Object.assign(confidence, {id: 'pose-confidence', name: 'ポーズ認識', type: '', isCloud: false});
  Object.assign(progress, {id: 'pose-progress', name: 'チャージ', type: '', isCloud: false});
  const variables = new Map([
    [dsl4ScratchPoseFeedbackVariableNames.confidence, confidence],
    [dsl4ScratchPoseFeedbackVariableNames.progress, progress],
  ]);
  const monitorRecords = new Map();
  const monitorBlocksById = new Map();
  for (const variable of [confidence, progress]) {
    const record = {
      id: variable.id,
      opcode: 'data_variable',
      params: {VARIABLE: variable.name},
      targetId: null,
      spriteName: null,
      mode: 'slider',
      sliderMin: 0,
      sliderMax: 100,
      isDiscrete: true,
      visible: false,
      get(property) {
        return this[property];
      },
    };
    monitorRecords.set(variable.id, record);
    monitorBlocksById.set(variable.id, {
      id: variable.id,
      opcode: 'data_variable',
      fields: {VARIABLE: {id: variable.id, value: variable.name}},
      isMonitored: false,
    });
  }
  const monitorState = {
    has: (id) => monitorRecords.has(id),
    get: (id) => monitorRecords.get(id),
    valueSeq: () => monitorRecords.values(),
  };
  const monitorBlocks = {
    getBlock: (id) => monitorBlocksById.get(id),
    getScripts: () => [...monitorBlocksById.keys()],
    changeBlock({id, element, value}) {
      assert.equal(element, 'checkbox');
      const block = monitorBlocksById.get(id);
      const record = monitorRecords.get(id);
      if (!block || !record) return;
      block.isMonitored = value;
      record.visible = value;
    },
  };
  const stage = {
    isStage: true,
    variables: Object.fromEntries([
      [confidence.id, confidence],
      [progress.id, progress],
    ]),
    lookupVariableByNameAndType(name, type) {
      assert.equal(type, '');
      return variables.get(name) ?? null;
    },
    ...overrides.stage,
  };
  return {
    confidence,
    progress,
    variables,
    monitorBlocks,
    monitorBlocksById,
    monitorRecords,
    monitorVisible(variable) {
      return monitorRecords.get(variable.id)?.visible;
    },
    stage,
    runtime: {
      getTargetForStage: () => stage,
      getMonitorState: () => monitorState,
      monitorBlocks,
      ...overrides.runtime,
    },
  };
}

test('scratchMirror projects normalized state to 0-100 and never reads Scratch edits back', () => {
  const setup = fakeRuntime();
  const adapter = createDsl4ScratchPoseFeedbackAdapter({
    runtime: setup.runtime,
    mode: 'scratchMirror',
  });

  adapter.onPoseState(event());
  assert.equal(setup.confidence.value, 82);
  assert.equal(setup.progress.value, 64);
  assert.equal(setup.monitorVisible(setup.confidence), true);
  assert.equal(setup.monitorVisible(setup.progress), true);
  setup.confidence.value = 100;
  setup.progress.value = 100;
  assert.equal(adapter.readPoseStateBinding(), null);

  adapter.onPoseState(event({confidence: 0.4, progress: 0.25}));
  assert.equal(setup.confidence.value, 40);
  assert.equal(setup.progress.value, 25);
});

test('scratchBinding accepts one valid write per variable at each tick boundary', () => {
  const setup = fakeRuntime();
  const adapter = createDsl4ScratchPoseFeedbackAdapter({
    runtime: setup.runtime,
    mode: 'scratchBinding',
  });
  adapter.onPoseState(event({phase: 'waiting', confidence: 0, progress: 0}));

  setup.confidence.value = '75';
  setup.progress.value = '50.0';
  const sample = adapter.readPoseStateBinding();
  assert.deepEqual(sample, {confidence: 0.75, progress: 0.5});
  assert.equal(Object.isFrozen(sample), true);

  setup.confidence.value = 90;
  setup.progress.value = 90;
  assert.equal(adapter.readPoseStateBinding(), null);
  adapter.onPoseState(event({confidence: 0.8, progress: 0.6}));
  assert.equal(setup.confidence.value, 80);
  assert.equal(setup.progress.value, 60);

  setup.confidence.value = '80';
  setup.progress.value = 70;
  assert.deepEqual(adapter.readPoseStateBinding(), {progress: 0.7});
});

test('scratchBinding samples the final ordered writes at one projected tick boundary', () => {
  const setup = fakeRuntime();
  const adapter = createDsl4ScratchPoseFeedbackAdapter({
    runtime: setup.runtime,
    mode: 'scratchBinding',
  });
  adapter.onPoseState(event({phase: 'waiting', confidence: 0.4, progress: 0.2}));

  setup.confidence.value = 25;
  setup.confidence.value = 75;
  setup.progress.value = 50;
  assert.deepEqual(adapter.readPoseStateBinding(), {confidence: 0.75, progress: 0.5});

  adapter.onPoseState(event({phase: 'charging', confidence: 0.5, progress: 0.3}));
  setup.confidence.value = 80;
  setup.progress.value = 60;
  setup.progress.value = 70;
  assert.deepEqual(adapter.readPoseStateBinding(), {confidence: 0.8, progress: 0.7});
});

test('scratchBinding rejects an invalid pair atomically and restores the last projection', () => {
  const setup = fakeRuntime();
  const adapter = createDsl4ScratchPoseFeedbackAdapter({
    runtime: setup.runtime,
    mode: 'scratchBinding',
  });
  const invalidValues = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    101,
    '',
    'Infinity',
    '0x10',
    'not a number',
  ];

  for (const invalid of invalidValues) {
    adapter.onPoseState(event({confidence: 0.4, progress: 0.2}));
    setup.confidence.value = invalid;
    setup.progress.value = 75;
    assert.equal(adapter.readPoseStateBinding(), null, String(invalid));
    assert.equal(setup.confidence.value, 40);
    assert.equal(setup.progress.value, 20);
  }
});

test('completed and cancelled terminal states disable binding and reset both variables', () => {
  const setup = fakeRuntime();
  const originalDescriptor = Object.getOwnPropertyDescriptor(setup.confidence, 'value');
  const adapter = createDsl4ScratchPoseFeedbackAdapter({
    runtime: setup.runtime,
    mode: 'scratchBinding',
  });
  assert.deepEqual(Object.getOwnPropertyDescriptor(setup.confidence, 'value'), originalDescriptor);
  adapter.onPoseState(event({phase: 'charging', confidence: 0.7, progress: 0.6}));
  adapter.onPoseState(event({phase: 'completed', confidence: 1, progress: 1}));
  assert.equal(setup.confidence.value, 0);
  assert.equal(setup.progress.value, 0);
  assert.equal(setup.monitorVisible(setup.confidence), false);
  assert.equal(setup.monitorVisible(setup.progress), false);
  setup.confidence.value = 50;
  setup.progress.value = 50;
  assert.equal(adapter.readPoseStateBinding(), null);

  adapter.onPoseState(event({phase: 'waiting', confidence: 0.2, progress: 0.1}));
  assert.equal(setup.monitorVisible(setup.confidence), true);
  assert.equal(setup.monitorVisible(setup.progress), true);
  adapter.onPoseState(event({phase: 'cancelled', confidence: 0.2, progress: 0.1}));
  assert.equal(setup.confidence.value, 0);
  assert.equal(setup.progress.value, 0);
  assert.equal(setup.monitorVisible(setup.confidence), false);
  assert.equal(setup.monitorVisible(setup.progress), false);

  adapter.dispose();
  assert.equal(setup.confidence.value, 0);
  assert.equal(setup.progress.value, 0);
  assert.deepEqual(Object.getOwnPropertyDescriptor(setup.confidence, 'value'), {
    ...originalDescriptor,
    value: 0,
  });
  setup.confidence.value = 12;
  adapter.dispose();
  adapter.onPoseState(event());
  assert.equal(setup.confidence.value, 12);
  assert.equal(adapter.readPoseStateBinding(), null);
});

test('rolls back both variables when a special setter fails halfway through projection', () => {
  let progressValue = 0;
  let rejectedValue = null;
  const progressVariable = {};
  Object.defineProperty(progressVariable, 'value', {
    configurable: true,
    enumerable: true,
    get() {
      return progressValue;
    },
    set(value) {
      if (value === rejectedValue) throw new Error(`setter rejected ${value}`);
      progressValue = value;
    },
  });
  const setup = fakeRuntime({progressVariable});
  const adapter = createDsl4ScratchPoseFeedbackAdapter({
    runtime: setup.runtime,
    mode: 'scratchBinding',
  });
  adapter.onPoseState(event({phase: 'waiting', confidence: 0.4, progress: 0.2}));
  rejectedValue = 60;

  assert.throws(
    () => adapter.onPoseState(event({phase: 'charging', confidence: 0.8, progress: 0.6})),
    /setter rejected 60/u,
  );
  assert.equal(setup.confidence.value, 40);
  assert.equal(setup.progress.value, 20);

  rejectedValue = null;
  adapter.dispose();
  assert.equal(setup.confidence.value, 0);
  assert.equal(setup.progress.value, 0);
});

test('fails closed before mutation when the stage variables are missing, cloud, or ambiguous', () => {
  const missing = fakeRuntime();
  missing.variables.delete(dsl4ScratchPoseFeedbackVariableNames.progress);
  assert.throws(
    () => createDsl4ScratchPoseFeedbackAdapter({runtime: missing.runtime, mode: 'scratchMirror'}),
    (error) => error.code === 'K4-TW-POSE-FEEDBACK-001',
  );
  assert.equal(missing.confidence.value, 0);

  const cloud = fakeRuntime();
  cloud.confidence.isCloud = true;
  assert.throws(
    () => createDsl4ScratchPoseFeedbackAdapter({runtime: cloud.runtime, mode: 'scratchMirror'}),
    (error) => error.code === 'K4-TW-POSE-FEEDBACK-001',
  );

  const ambiguous = fakeRuntime();
  ambiguous.variables.set(dsl4ScratchPoseFeedbackVariableNames.progress, ambiguous.confidence);
  assert.throws(
    () =>
      createDsl4ScratchPoseFeedbackAdapter({
        runtime: ambiguous.runtime,
        mode: 'scratchBinding',
      }),
    (error) => error.code === 'K4-TW-POSE-FEEDBACK-001',
  );

  const fixed = fakeRuntime();
  Object.defineProperty(fixed.confidence, 'value', {
    value: 0,
    writable: true,
    configurable: false,
  });
  const fixedAdapter = createDsl4ScratchPoseFeedbackAdapter({
    runtime: fixed.runtime,
    mode: 'scratchBinding',
  });
  fixedAdapter.onPoseState(event({phase: 'waiting', confidence: 0.2, progress: 0.1}));
  fixed.confidence.value = 75;
  assert.deepEqual(fixedAdapter.readPoseStateBinding(), {confidence: 0.75});
  fixedAdapter.dispose();
  assert.equal(fixed.confidence.value, 0);
});

test('fails closed before mutation when a Stage variable monitor is missing or ambiguous', () => {
  const missing = fakeRuntime();
  missing.monitorBlocksById.delete(missing.progress.id);
  missing.monitorRecords.delete(missing.progress.id);
  assert.throws(
    () => createDsl4ScratchPoseFeedbackAdapter({runtime: missing.runtime, mode: 'scratchMirror'}),
    (error) => error.code === 'K4-TW-POSE-FEEDBACK-001',
  );
  assert.equal(missing.confidence.value, 0);
  assert.equal(missing.monitorVisible(missing.confidence), false);

  const ambiguous = fakeRuntime();
  ambiguous.monitorBlocksById.set('duplicate-monitor', {
    id: 'duplicate-monitor',
    opcode: 'data_variable',
    fields: {
      VARIABLE: {id: ambiguous.confidence.id, value: ambiguous.confidence.name},
    },
    isMonitored: false,
  });
  ambiguous.monitorRecords.set('duplicate-monitor', {
    id: 'duplicate-monitor',
    opcode: 'data_variable',
    params: {VARIABLE: ambiguous.confidence.name},
    targetId: null,
    spriteName: null,
    mode: 'slider',
    sliderMin: 0,
    sliderMax: 100,
    isDiscrete: true,
    visible: false,
    get(property) {
      return this[property];
    },
  });
  assert.throws(
    () =>
      createDsl4ScratchPoseFeedbackAdapter({runtime: ambiguous.runtime, mode: 'scratchBinding'}),
    (error) => error.code === 'K4-TW-POSE-FEEDBACK-001',
  );
  assert.equal(ambiguous.monitorVisible(ambiguous.confidence), false);
});

test('ignores an unrelated sprite monitor with the same variable name', () => {
  const setup = fakeRuntime();
  setup.monitorBlocksById.set('sprite-local-confidence', {
    id: 'sprite-local-confidence',
    opcode: 'data_variable',
    fields: {
      VARIABLE: {id: 'sprite-local-confidence', value: setup.confidence.name},
    },
    isMonitored: false,
  });
  setup.monitorRecords.set('sprite-local-confidence', {
    id: 'sprite-local-confidence',
    opcode: 'data_variable',
    params: {VARIABLE: setup.confidence.name},
    targetId: 'sprite-target',
    spriteName: 'Sprite',
    mode: 'default',
    sliderMin: 0,
    sliderMax: 100,
    isDiscrete: true,
    visible: false,
    get(property) {
      return this[property];
    },
  });

  const adapter = createDsl4ScratchPoseFeedbackAdapter({
    runtime: setup.runtime,
    mode: 'scratchMirror',
  });
  adapter.onPoseState(event());
  assert.equal(setup.monitorVisible(setup.confidence), true);
  assert.equal(setup.monitorRecords.get('sprite-local-confidence').visible, false);
  adapter.dispose();
});

test('attempts monitor cleanup after reset failure and aggregates both failures', () => {
  let progressValue = 0;
  const progressVariable = {};
  Object.defineProperty(progressVariable, 'value', {
    configurable: true,
    enumerable: true,
    get() {
      return progressValue;
    },
    set(value) {
      if (value === 0 && progressValue !== 0) throw new Error('reset failed');
      progressValue = value;
    },
  });
  const setup = fakeRuntime({progressVariable});
  const adapter = createDsl4ScratchPoseFeedbackAdapter({
    runtime: setup.runtime,
    mode: 'scratchBinding',
  });
  adapter.onPoseState(event({confidence: 0.7, progress: 0.6}));
  const changeBlock = setup.monitorBlocks.changeBlock;
  setup.monitorBlocks.changeBlock = (input) => {
    if (input.id === setup.progress.id && input.value === false) {
      throw new Error('monitor hide failed');
    }
    changeBlock(input);
  };

  assert.throws(adapter.dispose, (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.match(String(error.errors[0]), /reset failed/u);
    assert.match(String(error.errors[1]), /monitor hide failed/u);
    return true;
  });
  assert.equal(setup.monitorVisible(setup.confidence), false);
  assert.equal(setup.monitorVisible(setup.progress), true);
});
