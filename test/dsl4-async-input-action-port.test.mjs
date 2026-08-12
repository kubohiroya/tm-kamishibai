import assert from 'node:assert/strict';
import test from 'node:test';

import {createDsl4InputArbitration} from '../src/dsl4/index.js';
import {createDsl4AsyncInputActionPort} from '../src/dsl4/platform/index.js';

function context(controller = new AbortController()) {
  return {signal: controller.signal, generation: 1, sceneId: 'opening'};
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

test('publishes action wait ownership and one accepted touch release to the arbiter', async () => {
  const arbitration = createDsl4InputArbitration();
  const keyWait = deferred();
  const touchWait = deferred();
  const cursors = [];
  const port = createDsl4AsyncInputActionPort({
    inputArbitration: arbitration,
    setCursor(event) {
      cursors.push(event);
    },
    composition: {
      waitForKeyCandidate: () => keyWait.promise,
      waitForActorTouchCandidate: () => touchWait.promise,
    },
  });

  const keyOperation = port.keyInputToChangeScene({codes: ['Enter']}, context());
  assert.equal(arbitration.getState().activeStoryInputKind, 'key');
  keyWait.resolve('Enter');
  assert.equal(await keyOperation, 'Enter');
  assert.equal(arbitration.getState().activeStoryInputKind, null);

  const touchOperation = port.touchInputToChangeScene({actors: ['Hero']}, context());
  assert.equal(arbitration.getState().activeStoryInputKind, 'touch');
  assert.deepEqual(cursors, [{visible: true, source: 'touch-input-1', cursor: 'pointer'}]);
  touchWait.resolve('Hero');
  assert.equal(await touchOperation, 'Hero');
  assert.deepEqual(cursors, [
    {visible: true, source: 'touch-input-1', cursor: 'pointer'},
    {visible: false, source: 'touch-input-1', cursor: 'pointer'},
  ]);
  assert.equal(arbitration.getState().suppressPointerRelease, true);
  assert.equal(
    arbitration.arbitrateNavigationPointer({pointerType: 'touch', historyPaused: false}),
    'suppress',
  );
});

test('restores the cursor when an actor touch wait is cancelled', async () => {
  const cursors = [];
  const controller = new AbortController();
  const port = createDsl4AsyncInputActionPort({
    setCursor(event) {
      cursors.push(event);
    },
    composition: {
      waitForKeyCandidate() {
        assert.fail('key input must not be used');
      },
      waitForActorTouchCandidate({signal}) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('cancelled');
              error.name = 'AbortError';
              reject(error);
            },
            {once: true},
          );
        });
      },
    },
  });

  const pending = port.touchInputToChangeScene({actors: ['Hero']}, context(controller));
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.deepEqual(cursors, [
    {visible: true, source: 'touch-input-1', cursor: 'pointer'},
    {visible: false, source: 'touch-input-1', cursor: 'pointer'},
  ]);
});

test('serializes asynchronous cursor notifications without delaying actor input', async () => {
  const cursors = [];
  const releaseCursorStart = deferred();
  const cursorNotificationsDone = deferred();
  const port = createDsl4AsyncInputActionPort({
    async setCursor(event) {
      if (event.visible) await releaseCursorStart.promise;
      cursors.push(event);
      if (cursors.length === 2) cursorNotificationsDone.resolve();
    },
    composition: {
      waitForKeyCandidate() {
        assert.fail('key input must not be used');
      },
      waitForActorTouchCandidate() {
        return Promise.resolve('Hero');
      },
    },
  });

  assert.equal(
    await port.touchInputToChangeScene({actors: ['Hero']}, context()),
    'Hero',
    'cursor presentation must not delay authoritative input',
  );
  assert.deepEqual(cursors, []);
  releaseCursorStart.resolve();
  await cursorNotificationsDone.promise;
  assert.deepEqual(cursors, [
    {visible: true, source: 'touch-input-1', cursor: 'pointer'},
    {visible: false, source: 'touch-input-1', cursor: 'pointer'},
  ]);
});
