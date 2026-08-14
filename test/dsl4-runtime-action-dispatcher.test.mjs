import assert from 'node:assert/strict';
import test from 'node:test';

import {createDsl4RuntimeActionDispatcher} from '../src/dsl4/index.js';

function action(command, args = {}, target = null) {
  return {command, target, args, handler: 'core'};
}

function createHarness(overrides = {}) {
  const calls = [];
  const recognition = {scoreThreshold: 0.5};
  const dispatcher = createDsl4RuntimeActionDispatcher({
    async invokePort(method, payload, context) {
      calls.push({method, payload, context});
      if (method === 'poseInputToChangeScene') return 'safe';
      return null;
    },
    async resolveBranch(branchId) {
      return `${branchId}-destination`;
    },
    resolveSpeechStyle(command, args) {
      return {...args, kind: command};
    },
    getPoseModel() {
      return 'SafetyPose';
    },
    poseSelectionRecognition: recognition,
    async dispatchPose(payload, context) {
      calls.push({method: 'pose', payload, context});
    },
    ...overrides,
  });
  return {dispatcher, calls, recognition};
}

test('dispatches normalized port, navigation, selection, speech, and pose actions', async () => {
  const {dispatcher, calls, recognition} = createHarness();
  const context = {signal: new AbortController().signal};
  assert.equal(Object.isFrozen(dispatcher), true);

  await dispatcher.dispatch(action('show', {skin: 'Ready'}, 'Guide'), context);
  assert.deepEqual(calls.shift(), {
    method: 'show',
    payload: {target: 'Guide', skin: 'Ready'},
    context,
  });

  await dispatcher.dispatch(action('say', {text: 'Ready?'}, 'Guide'), context);
  assert.deepEqual(calls.shift(), {
    method: 'say',
    payload: {target: 'Guide', text: 'Ready?', kind: 'say'},
    context,
  });

  assert.deepEqual(await dispatcher.dispatch(action('goto', {scene: 'safe'}), context), {
    sceneId: 'safe',
    reason: 'goto',
  });
  assert.deepEqual(await dispatcher.dispatch(action('branch', {branch: 'route'}), context), {
    sceneId: 'route-destination',
    reason: 'branch',
  });

  recognition.scoreThreshold = 1;
  assert.deepEqual(
    await dispatcher.dispatch(
      action('poseInputToChangeScene', {routes: {safe: 'under-desk'}}),
      context,
    ),
    {sceneId: 'under-desk', reason: 'poseInput'},
  );
  assert.deepEqual(calls.shift(), {
    method: 'poseInputToChangeScene',
    payload: {
      poses: ['safe'],
      poseModel: 'SafetyPose',
      recognition: {scoreThreshold: 0.5},
    },
    context,
  });

  await dispatcher.dispatch(action('pose', {steps: [{pose: 'safe'}]}, 'Guide'), context);
  assert.deepEqual(calls.shift(), {
    method: 'pose',
    payload: {target: 'Guide', args: {steps: [{pose: 'safe'}]}},
    context,
  });
});

test('fails closed for malformed construction, unknown actions, and invalid selection results', async () => {
  assert.throws(() => createDsl4RuntimeActionDispatcher({}), /invokePort must be a function/u);
  const {dispatcher} = createHarness({
    invokePort() {
      return 'undeclared';
    },
  });
  await assert.rejects(
    dispatcher.dispatch(action('notRegistered'), {}),
    (error) => error.code === 'K4-RUNTIME-DISPATCH-001',
  );
  await assert.rejects(
    dispatcher.dispatch(action('keyInputToChangeScene', {routes: {Space: 'next'}}), {}),
    (error) => error.code === 'K4-RUNTIME-RESULT-001',
  );
});
