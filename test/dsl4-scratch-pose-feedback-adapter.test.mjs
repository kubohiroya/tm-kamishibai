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
  const confidence = {value: 0};
  const progress = {value: 0};
  const variables = new Map([
    [dsl4ScratchPoseFeedbackVariableNames.confidence, confidence],
    [dsl4ScratchPoseFeedbackVariableNames.progress, progress],
  ]);
  const stage = {
    isStage: true,
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
    stage,
    runtime: {
      getTargetForStage: () => stage,
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
  setup.confidence.value = 100;
  setup.progress.value = 100;
  assert.equal(adapter.readPoseStateBinding(), null);

  adapter.onPoseState(event({confidence: 0.4, progress: 0.25}));
  assert.equal(setup.confidence.value, 40);
  assert.equal(setup.progress.value, 25);
});

test('scratchBinding samples one final valid Scratch snapshot at each tick boundary', () => {
  const setup = fakeRuntime();
  const adapter = createDsl4ScratchPoseFeedbackAdapter({
    runtime: setup.runtime,
    mode: 'scratchBinding',
  });
  adapter.onPoseState(event({phase: 'waiting', confidence: 0, progress: 0}));

  setup.confidence.value = 25;
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

test('terminal state stops binding and dispose clears both variables exactly once', () => {
  const setup = fakeRuntime();
  const adapter = createDsl4ScratchPoseFeedbackAdapter({
    runtime: setup.runtime,
    mode: 'scratchBinding',
  });
  adapter.onPoseState(event({phase: 'completed', confidence: 1, progress: 1}));
  setup.confidence.value = 50;
  setup.progress.value = 50;
  assert.equal(adapter.readPoseStateBinding(), null);

  adapter.dispose();
  assert.equal(setup.confidence.value, 0);
  assert.equal(setup.progress.value, 0);
  setup.confidence.value = 12;
  adapter.dispose();
  adapter.onPoseState(event());
  assert.equal(setup.confidence.value, 12);
  assert.equal(adapter.readPoseStateBinding(), null);
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
});
