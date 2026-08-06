import assert from 'node:assert/strict';
import test from 'node:test';

import {createDsl4AsyncInputActionPort} from '../src/dsl4/platform/index.js';

function context(controller = new AbortController()) {
  return {signal: controller.signal, generation: 1, sceneId: 'opening'};
}

test('adapts key and actor candidates with the action AbortSignal unchanged', async () => {
  const calls = [];
  const port = createDsl4AsyncInputActionPort({
    composition: {
      waitForKeyCandidate(options) {
        calls.push(['key', options]);
        return Promise.resolve(options.candidates[1]);
      },
      waitForActorTouchCandidate(options) {
        calls.push(['touch', options]);
        return Promise.resolve(options.candidates[0]);
      },
    },
  });
  const actionContext = context();

  assert.equal(
    await port.keyInputToChangeScene({codes: ['ArrowLeft', 'ArrowRight']}, actionContext),
    'ArrowRight',
  );
  assert.equal(
    await port.touchInputToChangeScene({actors: ['Hero', 'Door']}, actionContext),
    'Hero',
  );
  assert.strictEqual(calls[0][1].signal, actionContext.signal);
  assert.strictEqual(calls[1][1].signal, actionContext.signal);
  assert.equal(Object.isFrozen(port), true);
});

test('rejects malformed payloads, contexts, and compositions before subscribing', () => {
  const composition = {
    waitForKeyCandidate() {
      assert.fail('invalid input must not subscribe');
    },
    waitForActorTouchCandidate() {
      assert.fail('invalid input must not subscribe');
    },
  };
  const port = createDsl4AsyncInputActionPort({composition});
  for (const payload of [
    {},
    {codes: []},
    {codes: ['']},
    {codes: ['Space', 'Space']},
    {codes: [' Space']},
    {codes: ['Space'], extra: true},
  ]) {
    assert.throws(
      () => port.keyInputToChangeScene(payload, context()),
      (error) => error.code === 'K4-ASYNC-INPUT-PORT-001',
    );
  }
  assert.throws(
    () => port.touchInputToChangeScene({actors: ['Hero']}, {}),
    (error) => error.code === 'K4-ASYNC-INPUT-PORT-001',
  );
  assert.throws(() => createDsl4AsyncInputActionPort({composition: {}}), /waitForKeyCandidate/u);
});
