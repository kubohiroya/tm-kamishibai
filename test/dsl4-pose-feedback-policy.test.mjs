import assert from 'node:assert/strict';
import test from 'node:test';

import {createDsl4PoseStateEvent} from '../src/dsl4/index.js';

function validEvent(overrides = {}) {
  return {
    phase: 'charging',
    target: 'Hero',
    pose: 'help',
    stepIndex: 1,
    confidence: 0.82,
    progress: 0.64,
    ...overrides,
  };
}

test('creates one exact immutable renderer-independent pose state event', () => {
  const input = validEvent();
  const event = createDsl4PoseStateEvent(input);
  assert.deepEqual(event, input);
  assert.notStrictEqual(event, input);
  assert.equal(Object.isFrozen(event), true);
});

test('accepts only the four lifecycle phases and normalized finite progress values', () => {
  for (const phase of ['waiting', 'charging', 'completed', 'cancelled']) {
    assert.equal(createDsl4PoseStateEvent(validEvent({phase})).phase, phase);
  }
  for (const [field, value] of [
    ['confidence', -0.1],
    ['confidence', 1.1],
    ['confidence', Number.NaN],
    ['progress', Number.POSITIVE_INFINITY],
  ]) {
    assert.throws(() => createDsl4PoseStateEvent(validEvent({[field]: value})), TypeError);
  }
  assert.throws(() => createDsl4PoseStateEvent(validEvent({phase: 'failed'})), TypeError);
});

test('rejects unknown, missing, and malformed semantic fields without a partial event', () => {
  assert.throws(() => createDsl4PoseStateEvent({...validEvent(), scratchVariableId: 'secret'}));
  const missing = validEvent();
  delete missing.pose;
  assert.throws(() => createDsl4PoseStateEvent(missing), TypeError);
  assert.throws(() => createDsl4PoseStateEvent(validEvent({stepIndex: -1})), TypeError);
  assert.throws(() => createDsl4PoseStateEvent(validEvent({target: ''})), TypeError);
});
