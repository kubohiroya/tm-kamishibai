import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'vitest';
import {fileURLToPath} from 'node:url';

import {
  createDsl4ActionQuiesceResolver,
  createDsl4ActionRegistrySnapshot,
  createDsl4KamishibaiStructuredDataSession,
  createDsl4LiveReloadSession,
  createDsl4ObjectStore,
  createDsl4RuntimeController,
  createDsl4SourceFrontend,
  dsl4CoreActionNames,
  dsl4CoreActionQuiesceModes,
} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);

function parse(source) {
  const result = frontend.parse(source, {sourceId: 'main'});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result;
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

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

function abortError() {
  const error = new Error('cancelled');
  error.name = 'AbortError';
  return error;
}

const twoWaits = `
kamishibai: '4.0'
variables:
  score: 0
scenes:
  opening:
    - wait:
        seconds: 1
        stableId: first-wait
    - wait:
        seconds: 2
        stableId: second-wait
`;

test('resolves core and startup-fixed custom quiesce modes with finish-only fallback', () => {
  const resolver = createDsl4ActionQuiesceResolver({
    registrySnapshot: createDsl4ActionRegistrySnapshot([
      {
        name: 'replaySafe',
        target: 'actor',
        parameters: [],
        quiesce: 'cancel-replay-safe',
        source: {targetId: 'private-target', hatBlockId: 'private-hat'},
      },
      {
        name: 'externalEffect',
        target: 'actor',
        parameters: [],
        source: {targetId: 'private-target', hatBlockId: 'private-hat-2'},
      },
    ]),
  });

  assert.equal(Object.isFrozen(resolver), true);
  assert.deepEqual(Object.keys(dsl4CoreActionQuiesceModes).sort(), [...dsl4CoreActionNames].sort());
  assert.equal(resolver({handler: 'core', command: 'wait'}), 'cancel-replay-safe');
  assert.equal(resolver({handler: 'core', command: 'sound'}), 'finish-only');
  assert.equal(resolver({handler: 'custom', command: 'replaySafe'}), 'cancel-replay-safe');
  assert.equal(resolver({handler: 'custom', command: 'externalEffect'}), 'finish-only');
  assert.equal(resolver({handler: 'custom', command: 'missing'}), 'finish-only');
  assert.equal(resolver({handler: 'malformed', command: 'wait'}), 'finish-only');
  assert.equal(resolver(null), 'finish-only');
});

test('finish-only closes the dispatch gate and plans only after action scope cleanup', async () => {
  const storyDocument = parse(twoWaits).storyDocument;
  const store = createDsl4ObjectStore();
  const structuredDataIntegration = createDsl4KamishibaiStructuredDataSession({
    storyDocument,
    store,
  });
  const first = deferred();
  let calls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument,
    structuredDataIntegration,
    port: {
      async wait(_payload, context) {
        calls += 1;
        if (calls === 1) {
          await first.promise;
          assert.equal(context.setVariable('score', 7), true);
        }
      },
    },
  });

  const run = controller.start();
  await waitUntil(() => calls === 1);
  const quiesced = controller.quiesce({candidateId: 1, mode: 'finish-only'});
  await Promise.resolve();
  assert.equal(calls, 1);
  first.resolve();
  const token = await quiesced;

  assert.equal(Object.isFrozen(token), true);
  assert.equal(Object.isFrozen(token.variables), true);
  assert.deepEqual(token, {
    kind: 'Dsl4QuiesceToken',
    version: 1,
    candidateId: 1,
    runtimeGeneration: 2,
    storyPath: '/scenes/opening/actions/1',
    actionSignature: {command: 'wait', target: null, handler: 'core'},
    sceneId: 'opening',
    actionIndex: 1,
    variables: {score: 7},
    resumeMode: 'next-action',
  });
  assert.equal(controller.getState().status, 'paused');
  assert.equal(structuredDataIntegration.currentActionResources(), null);
  assert.equal(calls, 1);

  await controller.resumeQuiesce(1);
  await controller.getRunPromise();
  assert.equal(calls, 2);
  assert.equal(controller.getState().status, 'finished');
  await run;
  controller.dispose();
});

test('cancel-replay-safe waits for cancellation cleanup before issuing a replay token and Esc replays', async () => {
  const storyDocument = parse(twoWaits).storyDocument;
  const store = createDsl4ObjectStore();
  const structuredDataIntegration = createDsl4KamishibaiStructuredDataSession({
    storyDocument,
    store,
  });
  const cleanup = deferred();
  let calls = 0;
  let firstResources;
  const controller = createDsl4RuntimeController({
    storyDocument,
    structuredDataIntegration,
    port: {
      wait(_payload, context) {
        calls += 1;
        if (calls > 1) return Promise.resolve();
        firstResources = context.structuredData;
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => {
              cleanup.promise.then(() => reject(abortError()));
            },
            {once: true},
          );
        });
      },
    },
  });

  const initialRun = controller.start();
  await waitUntil(() => calls === 1);
  let settled = false;
  const quiesced = controller
    .quiesce({candidateId: 2, mode: 'cancel-replay-safe'})
    .then((token) => {
      settled = true;
      return token;
    });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(store.classifyHandle(firstResources.actionScopeRef).ok, false);
  assert.equal(store.classifyHandle(firstResources.actionViewRef).ok, false);

  cleanup.resolve();
  const token = await quiesced;
  assert.equal(token.resumeMode, 'replay-action');
  assert.equal(token.storyPath, '/scenes/opening/actions/0');
  assert.equal(token.actionIndex, 0);
  assert.equal(controller.getState().status, 'paused');
  await initialRun;

  await controller.resumeQuiesce(2);
  await controller.getRunPromise();
  assert.equal(calls, 3);
  assert.equal(controller.getState().status, 'finished');
  controller.dispose();
});

test('Esc before quiesce completion resumes finish-only in place and cancel-safe after cleanup', async () => {
  {
    const storyDocument = parse(twoWaits).storyDocument;
    const first = deferred();
    let calls = 0;
    const controller = createDsl4RuntimeController({
      storyDocument,
      port: {
        wait() {
          calls += 1;
          return calls === 1 ? first.promise : Promise.resolve();
        },
      },
    });
    const run = controller.start();
    await waitUntil(() => calls === 1);
    const quiesced = controller.quiesce({candidateId: 21, mode: 'finish-only'});
    const rejected = assert.rejects(quiesced, (error) => error.name === 'AbortError');
    const resumed = await controller.resumeQuiesce(21);
    assert.equal(resumed.status, 'running');
    await rejected;
    first.resolve();
    await run;
    assert.equal(calls, 2);
    assert.equal(controller.getState().status, 'finished');
    controller.dispose();
  }

  {
    const storyDocument = parse(twoWaits).storyDocument;
    const cleanup = deferred();
    let calls = 0;
    const controller = createDsl4RuntimeController({
      storyDocument,
      port: {
        wait(_payload, context) {
          calls += 1;
          if (calls > 1) return Promise.resolve();
          return new Promise((_resolve, reject) => {
            context.signal.addEventListener(
              'abort',
              () => cleanup.promise.then(() => reject(abortError())),
              {once: true},
            );
          });
        },
      },
    });
    controller.start();
    await waitUntil(() => calls === 1);
    const quiesced = controller.quiesce({candidateId: 22, mode: 'cancel-replay-safe'});
    const rejected = assert.rejects(quiesced, (error) => error.name === 'AbortError');
    const resumed = controller.resumeQuiesce(22);
    await Promise.resolve();
    assert.equal(calls, 1);
    cleanup.resolve();
    await rejected;
    await resumed;
    await controller.getRunPromise();
    assert.equal(calls, 3);
    assert.equal(controller.getState().status, 'finished');
    controller.dispose();
  }
});

test('cancel-replay-safe timeout fails closed without issuing a token or dispatching the next action', async () => {
  const storyDocument = parse(twoWaits).storyDocument;
  const scheduled = [];
  let calls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument,
    quiesceTimeoutMs: 100,
    scheduleQuiesceTimeout(callback, milliseconds) {
      const entry = {callback, milliseconds, active: true};
      scheduled.push(entry);
      return () => {
        entry.active = false;
      };
    },
    port: {
      wait() {
        calls += 1;
        return new Promise(() => {});
      },
    },
  });

  controller.start();
  await waitUntil(() => calls === 1);
  const quiesced = controller.quiesce({candidateId: 3, mode: 'cancel-replay-safe'});
  assert.equal(scheduled[0].milliseconds, 100);
  scheduled[0].callback();

  await assert.rejects(quiesced, (error) => error.code === 'K4-RELOAD-QUIESCE-TIMEOUT');
  assert.equal(controller.getState().status, 'failed');
  assert.equal(controller.getState().diagnostic.code, 'K4-RELOAD-QUIESCE-TIMEOUT');
  assert.equal(calls, 1);
  controller.dispose();
});

test('runtime stop wins over a pending finish-only quiesce', async () => {
  const storyDocument = parse(twoWaits).storyDocument;
  const action = deferred();
  let calls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument,
    port: {
      wait(_payload, context) {
        calls += 1;
        return new Promise((resolve, reject) => {
          action.promise.then(resolve);
          context.signal.addEventListener('abort', () => reject(abortError()), {once: true});
        });
      },
    },
  });
  const run = controller.start();
  await waitUntil(() => calls === 1);
  const quiesced = controller.quiesce({candidateId: 4, mode: 'finish-only'});
  controller.stop('test-stop');

  await assert.rejects(quiesced, (error) => error.code === 'K4-RELOAD-QUIESCE-FAILED');
  await run;
  assert.equal(controller.getState().status, 'stopped');
  assert.equal(calls, 1);
  controller.dispose();
});

test('action timeout wins over finish-only quiesce and prevents the next dispatch', async () => {
  const storyDocument = parse(twoWaits).storyDocument;
  const action = deferred();
  let calls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument,
    port: {
      wait() {
        calls += 1;
        return calls === 1 ? action.promise : Promise.resolve();
      },
    },
  });
  const run = controller.start();
  await waitUntil(() => calls === 1);
  const quiesced = controller.quiesce({candidateId: 5, mode: 'finish-only'});
  action.reject(
    Object.assign(new Error('Custom action primary handler timed out'), {
      code: 'K4-CUSTOM-TIMEOUT',
    }),
  );

  await assert.rejects(quiesced, (error) => error.code === 'K4-CUSTOM-TIMEOUT');
  const state = await run;
  assert.equal(state.status, 'failed');
  assert.equal(state.diagnostic.code, 'K4-CUSTOM-TIMEOUT');
  assert.equal(calls, 1);
  controller.dispose();
});

function quiesceToken(candidateId, variables = {score: 9}) {
  return Object.freeze({
    kind: 'Dsl4QuiesceToken',
    version: 1,
    candidateId,
    runtimeGeneration: 7,
    storyPath: '/scenes/opening/actions/0',
    actionSignature: {command: 'wait', target: null, handler: 'core'},
    sceneId: 'opening',
    actionIndex: 0,
    variables,
    resumeMode: 'replay-action',
  });
}

test('candidate replacement rebuilds the plan from one fixed token and Esc discards it', async () => {
  const currentStoryDocument = parse(twoWaits).storyDocument;
  const gate = deferred();
  const quiesceCalls = [];
  let latestCandidateId = 0;
  let state = {
    status: 'running',
    sceneId: 'opening',
    actionIndex: 0,
    actionPath: '/scenes/opening/actions/0',
    variables: {score: 1},
  };
  let activeToken = null;
  const session = {
    start() {},
    stop() {
      state = {...state, status: 'stopped'};
    },
    dispose() {},
    getState() {
      return {runtime: state};
    },
    quiesce({candidateId}) {
      latestCandidateId = candidateId;
      quiesceCalls.push(candidateId);
      return gate.promise.then(() => {
        state = {...state, status: 'paused'};
        activeToken = quiesceToken(latestCandidateId);
        return activeToken;
      });
    },
    resumeQuiesce(candidateId) {
      assert.equal(candidateId, activeToken.candidateId);
      activeToken = null;
      state = {...state, status: 'running'};
    },
  };
  const liveReload = createDsl4LiveReloadSession({
    initialStoryDocument: currentStoryDocument,
    initialSession: session,
    createSession() {
      assert.fail('replacement is not committed in this test');
    },
  });

  const first = liveReload.stage(parse(twoWaits.replace('seconds: 1', 'seconds: 3')));
  const second = liveReload.stage(parse(twoWaits.replace('seconds: 1', 'seconds: 4')));
  await waitUntil(() => quiesceCalls.length === 2);
  assert.deepEqual(quiesceCalls, [1, 2]);
  assert.equal(liveReload.getState().status, 'quiescing');
  let idleSettled = false;
  const idle = liveReload.whenIdle().then(() => {
    idleSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idleSettled, false);
  gate.resolve();

  await assert.rejects(first, /replaced while quiescing/u);
  const pending = await second;
  await idle;
  assert.equal(idleSettled, true);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.candidate.id, 2);
  assert.deepEqual(pending.candidate.plan.options.currentAction.variables, {score: 9});
  const resumed = await liveReload.defer(2);
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.candidate, null);
  assert.equal(state.status, 'running');
});

test('quiesce failure is redacted and withholds every restart choice', async () => {
  const currentStoryDocument = parse(twoWaits).storyDocument;
  const session = {
    start() {},
    stop() {},
    dispose() {},
    getState() {
      return {
        runtime: {
          status: 'running',
          sceneId: 'opening',
          actionIndex: 0,
          actionPath: '/scenes/opening/actions/0',
          variables: {score: 1},
        },
      };
    },
    quiesce() {
      throw Object.assign(new Error('private thread and Store cleanup details'), {
        code: 'K4-RELOAD-QUIESCE-TIMEOUT',
        storyPath: '/scenes/opening/actions/0',
      });
    },
    resumeQuiesce() {},
  };
  const liveReload = createDsl4LiveReloadSession({
    initialStoryDocument: currentStoryDocument,
    initialSession: session,
    createSession() {
      assert.fail('failed quiesce must not create a replacement');
    },
  });

  const failed = await liveReload.stage(parse(twoWaits.replace('seconds: 1', 'seconds: 5')));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.candidate, null);
  assert.equal(failed.diagnostics[0].code, 'K4-RELOAD-QUIESCE-TIMEOUT');
  assert.doesNotMatch(JSON.stringify(failed), /private thread and Store cleanup details/u);
});

test('rejects a non-exact token and stops the unusable old runtime', async () => {
  const currentStoryDocument = parse(twoWaits).storyDocument;
  let stops = 0;
  const session = {
    start() {},
    stop() {
      stops += 1;
    },
    dispose() {},
    getState() {
      return {
        runtime: {
          status: 'paused',
          sceneId: 'opening',
          actionIndex: 0,
          actionPath: '/scenes/opening/actions/0',
          variables: {score: 1},
        },
      };
    },
    quiesce({candidateId}) {
      return {...quiesceToken(candidateId), privateThreadId: 'must-not-cross-boundary'};
    },
    resumeQuiesce() {},
  };
  const liveReload = createDsl4LiveReloadSession({
    initialStoryDocument: currentStoryDocument,
    initialSession: session,
    createSession() {
      assert.fail('invalid token must not create a replacement');
    },
  });

  const failed = await liveReload.stage(parse(twoWaits.replace('seconds: 1', 'seconds: 6')));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.candidate, null);
  assert.equal(failed.diagnostics[0].code, 'K4-RELOAD-QUIESCE-FAILED');
  assert.equal(stops, 1);
  assert.doesNotMatch(JSON.stringify(failed), /must-not-cross-boundary/u);
});

test('rejects a token whose action anchor or variable snapshot contradicts the old story', async () => {
  const currentStoryDocument = parse(twoWaits).storyDocument;

  for (const invalidToken of [
    {...quiesceToken(1), actionSignature: {command: 'say', target: null, handler: 'core'}},
    {...quiesceToken(1), variables: {score: 'wrong-type'}},
  ]) {
    let stops = 0;
    const liveReload = createDsl4LiveReloadSession({
      initialStoryDocument: currentStoryDocument,
      initialSession: {
        start() {},
        stop() {
          stops += 1;
        },
        dispose() {},
        getState() {
          return {runtime: {status: 'paused'}};
        },
        quiesce() {
          return invalidToken;
        },
        resumeQuiesce() {},
      },
      createSession() {
        assert.fail('an inconsistent token must not create a replacement');
      },
    });

    const failed = await liveReload.stage(parse(twoWaits.replace('seconds: 1', 'seconds: 6')));
    assert.equal(failed.status, 'failed');
    assert.equal(failed.candidate, null);
    assert.equal(failed.diagnostics[0].code, 'K4-RELOAD-QUIESCE-FAILED');
    assert.equal(stops, 1);
  }
});

function immediateSession(storyDocument, name, events) {
  let state = {
    status: 'running',
    sceneId: 'opening',
    actionIndex: 0,
    actionPath: '/scenes/opening/actions/0',
    variables: {...storyDocument.variables},
  };
  let token = null;
  return {
    start(options = {}) {
      events.push([name, 'start']);
      state = {
        ...state,
        status: 'running',
        sceneId: options.sceneId ?? state.sceneId,
        actionIndex: options.actionIndex ?? state.actionIndex,
        actionPath:
          options.actionIndex === undefined
            ? state.actionPath
            : `/scenes/${options.sceneId}/actions/${options.actionIndex}`,
        variables: options.variables ?? state.variables,
      };
    },
    stop() {
      events.push([name, 'stop']);
      token = null;
      state = {...state, status: 'stopped'};
    },
    dispose() {
      events.push([name, 'dispose']);
    },
    getState() {
      return {runtime: state};
    },
    quiesce({candidateId}) {
      token = quiesceToken(candidateId, state.variables);
      state = {...state, status: 'paused'};
      return token;
    },
    resumeQuiesce(candidateId) {
      if (!token || token.candidateId !== candidateId) throw new TypeError('stale candidate');
      token = null;
      state = {...state, status: 'running'};
    },
  };
}

test('commit and Esc are exclusive and the operation queued first wins', async () => {
  const currentStoryDocument = parse(twoWaits).storyDocument;
  const candidateResult = parse(twoWaits.replace('seconds: 1', 'seconds: 8'));

  {
    const events = [];
    const creation = deferred();
    const liveReload = createDsl4LiveReloadSession({
      initialStoryDocument: currentStoryDocument,
      initialSession: immediateSession(currentStoryDocument, 'old', events),
      async createSession({storyDocument}) {
        await creation.promise;
        return immediateSession(storyDocument, 'new', events);
      },
    });
    const pending = await liveReload.stage(candidateResult);
    const commit = liveReload.commit(pending.candidate.id, 'currentAction');
    const escape = liveReload.defer(pending.candidate.id);
    creation.resolve();

    assert.equal((await commit).status, 'active');
    await assert.rejects(escape, /stale or missing/u);
    assert.deepEqual(
      events.map(([runtime, event]) => [runtime, event]),
      [
        ['old', 'stop'],
        ['old', 'dispose'],
        ['new', 'start'],
      ],
    );
  }

  {
    const events = [];
    const liveReload = createDsl4LiveReloadSession({
      initialStoryDocument: currentStoryDocument,
      initialSession: immediateSession(currentStoryDocument, 'old', events),
      createSession() {
        assert.fail('Esc-first must not create a replacement');
      },
    });
    const pending = await liveReload.stage(candidateResult);
    const escape = liveReload.defer(pending.candidate.id);
    const commit = liveReload.commit(pending.candidate.id, 'currentAction');

    assert.equal((await escape).status, 'active');
    await assert.rejects(commit, /stale or missing/u);
    assert.deepEqual(events, []);
  }
});
