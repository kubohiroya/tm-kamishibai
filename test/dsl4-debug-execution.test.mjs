import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'vitest';
import {fileURLToPath} from 'node:url';

import {
  createDsl4DebugExecutionCoordinator,
  createDsl4RuntimeController,
  createDsl4SourceFrontend,
} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);

function actionInput(command, actionIndex, signal) {
  return {
    command,
    sceneId: 'opening',
    actionIndex,
    actionPath: `/scenes/opening/actions/${actionIndex}`,
    signal,
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

test('breakpoint mode pauses only at debugger and resume releases that action', async () => {
  const debug = createDsl4DebugExecutionCoordinator({enabled: true});
  const controller = new AbortController();

  await debug.beforeAction(actionInput('wait', 0, controller.signal));
  assert.equal(debug.getState().paused, false);

  const paused = debug.beforeAction(actionInput('debugger', 1, controller.signal));
  assert.deepEqual(
    {
      mode: debug.getState().mode,
      paused: debug.getState().paused,
      reason: debug.getState().reason,
      actionPath: debug.getState().actionPath,
    },
    {
      mode: 'breakpoints',
      paused: true,
      reason: 'debugger',
      actionPath: '/scenes/opening/actions/1',
    },
  );
  debug.resume();
  await paused;
  assert.equal(debug.getState().paused, false);
});

test('step mode pauses before every action and abort clears an outstanding pause', async () => {
  const debug = createDsl4DebugExecutionCoordinator({enabled: true});
  debug.setMode('step');
  const controller = new AbortController();
  const paused = debug.beforeAction(actionInput('wait', 0, controller.signal));
  assert.equal(debug.getState().reason, 'step');
  controller.abort('story-reload');
  await assert.rejects(paused, {name: 'AbortError'});
  assert.equal(debug.getState().paused, false);
});

test('disabled debug execution never pauses', async () => {
  const debug = createDsl4DebugExecutionCoordinator();
  const controller = new AbortController();
  await debug.beforeAction(actionInput('debugger', 0, controller.signal));
  assert.equal(debug.getState().status, 'disabled');
});

test('runtime pauses before debugger in development and treats it as a no-op otherwise', async () => {
  const parsed = frontend.parse(
    "kamishibai: '4.0'\nscenes:\n  opening:\n    - wait: 0\n    - debugger:\n    - wait: 0\n",
    {sourceId: 'runtime-debugger.kamishibai.yaml'},
  );
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const calls = [];
  const debug = createDsl4DebugExecutionCoordinator({enabled: true});
  const runtime = createDsl4RuntimeController({
    storyDocument: parsed.storyDocument,
    port: {wait: async () => calls.push('wait')},
    debugExecution: debug,
  });
  const running = runtime.start();
  await waitFor(() => debug.getState().paused, 'runtime did not pause at debugger');
  assert.equal(runtime.getState().actionIndex, 1);
  assert.deepEqual(calls, ['wait']);
  assert.equal(
    runtime
      .getTrace()
      .filter(
        ({type, actionPath}) =>
          type === 'action.start' && actionPath === '/scenes/opening/actions/1',
      ).length,
    0,
  );
  debug.resume();
  assert.equal((await running).status, 'finished');
  assert.deepEqual(calls, ['wait', 'wait']);

  const productionCalls = [];
  const production = createDsl4RuntimeController({
    storyDocument: parsed.storyDocument,
    port: {wait: async () => productionCalls.push('wait')},
  });
  assert.equal((await production.start()).status, 'finished');
  assert.deepEqual(productionCalls, ['wait', 'wait']);
});

test('live reload quiesce cancels a step pause even for a finish-only action', async () => {
  const parsed = frontend.parse(
    "kamishibai: '4.0'\nscenes:\n  opening:\n    - goto: ending\n  ending: []\n",
    {sourceId: 'runtime-step-reload.kamishibai.yaml'},
  );
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const debug = createDsl4DebugExecutionCoordinator({enabled: true, mode: 'step'});
  const runtime = createDsl4RuntimeController({
    storyDocument: parsed.storyDocument,
    port: {},
    debugExecution: debug,
  });
  void runtime.start();
  await waitFor(() => debug.getState().paused, 'runtime did not enter step pause');
  const token = await runtime.quiesce({candidateId: 1, mode: 'finish-only'});
  assert.equal(token.resumeMode, 'replay-action');
  assert.equal(debug.getState().paused, false);
  assert.equal(runtime.getState().status, 'paused');
});
