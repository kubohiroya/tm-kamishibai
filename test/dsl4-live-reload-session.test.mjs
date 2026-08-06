import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {createDsl4LiveReloadSession, createDsl4SourceFrontend} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);

function parse(source) {
  return frontend.parse(source, {sourceId: 'main'});
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {promise, resolve};
}

function fakeSession(runtime, events, name) {
  let state = {...runtime};
  let disposed = false;
  return {
    start(options = {}) {
      events.push([name, 'start', options]);
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
      return Promise.resolve(state);
    },
    stop(reason) {
      events.push([name, 'stop', reason]);
      state = {...state, status: 'stopped'};
      return state;
    },
    dispose(reason) {
      events.push([name, 'dispose', reason]);
      disposed = true;
    },
    getState() {
      return {runtime: {...state}, disposed};
    },
  };
}

const initialSource = `
kamishibai: '4.0'
variables:
  score: 0
scenes:
  opening:
    - wait:
        seconds: 1
        stableId: active-wait
    - wait: 2
`;

test('waits through an invalid initial source and auto-starts the first valid snapshot', async () => {
  const events = [];
  let creates = 0;
  const liveReload = createDsl4LiveReloadSession({
    createSession({storyDocument, previousSession, preserveManagedPresentation}) {
      creates += 1;
      assert.equal(storyDocument.kind, 'StoryDocument');
      assert.equal(previousSession, null);
      assert.equal(preserveManagedPresentation, false);
      return fakeSession(
        {
          status: 'idle',
          sceneId: 'opening',
          actionIndex: 0,
          actionPath: '/scenes/opening/actions/0',
          variables: storyDocument.variables,
        },
        events,
        'initial',
      );
    },
  });

  const invalid = await liveReload.stage(parse(`kamishibai: '4.0'\nscenes: {}`));
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.hasCurrent, false);
  assert.ok(invalid.diagnostics.length > 0);
  assert.equal(creates, 0);

  const missing = await liveReload.stage({
    ok: false,
    diagnostics: [
      {
        version: 1,
        code: 'K4-SOURCE-MISSING',
        severity: 'error',
        message: 'DSL 4.0 source is missing',
        sourceId: 'main',
        range: {
          start: {line: 1, column: 1, offset: 0},
          end: {line: 1, column: 1, offset: 0},
        },
        path: '$',
        related: [],
      },
    ],
  });
  assert.equal(missing.status, 'invalid');
  assert.equal(missing.diagnostics[0].code, 'K4-SOURCE-MISSING');
  assert.equal(creates, 0);

  const valid = await liveReload.stage(parse(initialSource));
  assert.equal(valid.status, 'active');
  assert.equal(valid.hasCurrent, true);
  assert.equal(valid.candidate, null);
  assert.equal(creates, 1);
  assert.deepEqual(events, [['initial', 'start', {}]]);

  const directEvents = [];
  const direct = createDsl4LiveReloadSession({
    createSession({storyDocument}) {
      return fakeSession(
        {
          status: 'idle',
          sceneId: 'opening',
          actionIndex: 0,
          actionPath: '/scenes/opening/actions/0',
          variables: storyDocument.variables,
        },
        directEvents,
        'direct',
      );
    },
  });
  const directState = await direct.stage(parse(initialSource));
  assert.equal(directState.status, 'active');
  assert.deepEqual(directEvents, [['direct', 'start', {}]]);
});

test('keeps the current immutable execution when a changed source is invalid', async () => {
  const events = [];
  const currentStory = parse(initialSource).storyDocument;
  const currentSession = fakeSession(
    {
      status: 'running',
      sceneId: 'opening',
      actionIndex: 0,
      actionPath: '/scenes/opening/actions/0',
      variables: {score: 7},
    },
    events,
    'current',
  );
  const liveReload = createDsl4LiveReloadSession({
    initialStoryDocument: currentStory,
    initialSession: currentSession,
    createSession() {
      assert.fail('invalid source must not create a replacement session');
    },
  });

  const state = await liveReload.stage(parse(`kamishibai: '4.0'\nscenes: {}`));
  assert.equal(state.status, 'invalid');
  assert.equal(state.hasCurrent, true);
  assert.equal(state.current.runtime.status, 'running');
  assert.deepEqual(state.current.runtime.variables, {score: 7});
  assert.equal(state.candidate, null);
  assert.deepEqual(events, []);
});

test('passes the Adapter ExceptionRef predicate into live reload planning', async () => {
  const currentStory = parse(`
kamishibai: '4.0'
variables:
  exceptionToken: initial
  forgedToken: initial
scenes:
  opening:
    - wait: 1
`).storyDocument;
  const exceptionToken = '@sdx1.owned-realm.owned-token';
  const forgedToken = '@sdx1.forged-realm.forged-token';
  const liveReload = createDsl4LiveReloadSession({
    initialStoryDocument: currentStory,
    initialSession: fakeSession(
      {
        status: 'running',
        sceneId: 'opening',
        actionIndex: 0,
        actionPath: '/scenes/opening/actions/0',
        variables: {exceptionToken, forgedToken},
      },
      [],
      'current',
    ),
    isException: (value) => value === exceptionToken,
    createSession() {
      assert.fail('staging must not create a replacement session');
    },
  });
  const staged = await liveReload.stage(
    parse(`
kamishibai: '4.0'
variables:
  exceptionToken: reset
  forgedToken: reset
scenes:
  opening:
    - wait: 2
`),
  );

  assert.equal(staged.status, 'pending');
  assert.deepEqual(staged.candidate.plan.options.currentScene.variables, {
    exceptionToken: 'reset',
    forgedToken,
  });
  assert.equal(JSON.stringify(staged.candidate.plan).includes(exceptionToken), false);
  assert.throws(
    () =>
      createDsl4LiveReloadSession({
        createSession() {},
        isException: true,
      }),
    /isException must be a function/u,
  );
});

test('stages, defers, and commits each author-visible restart choice explicitly', async () => {
  for (const [choice, expectedPresentation] of [
    ['storyStart', false],
    ['currentScene', false],
    ['currentAction', true],
  ]) {
    const events = [];
    const currentStory = parse(initialSource).storyDocument;
    const currentSession = fakeSession(
      {
        status: 'running',
        sceneId: 'opening',
        actionIndex: 0,
        actionPath: '/scenes/opening/actions/0',
        variables: {score: 7},
      },
      events,
      'current',
    );
    const createCalls = [];
    const liveReload = createDsl4LiveReloadSession({
      initialStoryDocument: currentStory,
      initialSession: currentSession,
      createSession(context) {
        createCalls.push(context);
        return fakeSession(
          {
            status: 'idle',
            sceneId: null,
            actionIndex: -1,
            actionPath: null,
            variables: {},
          },
          events,
          'next',
        );
      },
    });
    const candidate = parse(`
kamishibai: '4.0'
variables:
  score: 10
scenes:
  opening:
    - wait: 9
  moved:
    - wait:
        seconds: 2
        stableId: active-wait
`);

    const pending = await liveReload.stage(candidate);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.candidate.plan.options[choice].enabled, true);
    const candidateId = pending.candidate.id;
    const deferredState = await liveReload.defer(candidateId);
    assert.equal(deferredState.status, 'deferred');
    assert.deepEqual(events, []);

    const committed = await liveReload.commit(candidateId, choice);
    const option = pending.candidate.plan.options[choice];
    assert.equal(committed.status, 'active');
    assert.equal(committed.generation, 2);
    assert.equal(committed.candidate, null);
    assert.equal(createCalls[0].previousSession, currentSession);
    assert.equal(createCalls[0].preserveManagedPresentation, expectedPresentation);
    assert.equal(Object.isFrozen(currentSession), false);
    assert.deepEqual(events, [
      ['current', 'stop', 'live-reload'],
      ['current', 'dispose', 'live-reload-replaced'],
      [
        'next',
        'start',
        {
          sceneId: option.destination.sceneId,
          actionIndex: option.destination.actionIndex,
          variables: option.variables,
        },
      ],
    ]);
  }
});

test('rejects disabled and stale choices without stopping the current execution', async () => {
  const events = [];
  const currentStory = parse(initialSource).storyDocument;
  const currentSession = fakeSession(
    {
      status: 'running',
      sceneId: 'opening',
      actionIndex: 1,
      actionPath: '/scenes/opening/actions/1',
      variables: {score: 3},
    },
    events,
    'current',
  );
  const liveReload = createDsl4LiveReloadSession({
    initialStoryDocument: currentStory,
    initialSession: currentSession,
    createSession() {
      assert.fail('disabled or stale choices must not create a session');
    },
  });
  const first = await liveReload.stage(
    parse(`kamishibai: '4.0'\nvariables: {score: 0}\nscenes:\n  other: []\n`),
  );
  assert.equal(first.candidate.plan.options.currentScene.enabled, false);
  assert.equal(first.candidate.plan.options.currentAction.enabled, false);
  await assert.rejects(
    liveReload.commit(first.candidate.id, 'currentAction'),
    /currentAction is disabled/u,
  );

  const second = await liveReload.stage(
    parse(`kamishibai: '4.0'\nvariables: {score: 0}\nscenes:\n  opening: []\n`),
  );
  await assert.rejects(liveReload.commit(first.candidate.id, 'storyStart'), /stale or missing/u);
  assert.notEqual(second.candidate.id, first.candidate.id);
  assert.deepEqual(events, []);
});

test('serializes a later stage behind an in-flight commit and plans from the new runtime', async () => {
  const events = [];
  const gate = deferred();
  const currentStory = parse(initialSource).storyDocument;
  const currentSession = fakeSession(
    {
      status: 'running',
      sceneId: 'opening',
      actionIndex: 0,
      actionPath: '/scenes/opening/actions/0',
      variables: {score: 4},
    },
    events,
    'current',
  );
  let createCount = 0;
  const liveReload = createDsl4LiveReloadSession({
    initialStoryDocument: currentStory,
    initialSession: currentSession,
    async createSession() {
      createCount += 1;
      await gate.promise;
      return fakeSession(
        {
          status: 'idle',
          sceneId: null,
          actionIndex: -1,
          actionPath: null,
          variables: {},
        },
        events,
        `next-${createCount}`,
      );
    },
  });
  const first = await liveReload.stage(parse(initialSource.replace('seconds: 1', 'seconds: 2')));
  const commit = liveReload.commit(first.candidate.id, 'currentAction');
  const laterStage = liveReload.stage(parse(initialSource.replace('seconds: 1', 'seconds: 3')));
  await Promise.resolve();
  assert.equal(createCount, 1);
  gate.resolve();
  await commit;
  const later = await laterStage;
  assert.equal(later.status, 'pending');
  assert.equal(later.generation, 2);
  assert.equal(later.candidate.plan.options.currentAction.enabled, true);
});

test('clears a pending candidate on a later invalid source and disposes once', async () => {
  const events = [];
  const currentStory = parse(initialSource).storyDocument;
  const currentSession = fakeSession(
    {
      status: 'running',
      sceneId: 'opening',
      actionIndex: 0,
      actionPath: '/scenes/opening/actions/0',
      variables: {score: 1},
    },
    events,
    'current',
  );
  const liveReload = createDsl4LiveReloadSession({
    initialStoryDocument: currentStory,
    initialSession: currentSession,
    createSession() {
      assert.fail('no replacement should be created');
    },
  });
  const pending = await liveReload.stage(parse(initialSource));
  assert.equal(pending.status, 'pending');
  const invalid = await liveReload.stage(parse(`kamishibai: '4.0'\nscenes: {}`));
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.candidate, null);

  const disposed = await liveReload.dispose();
  assert.equal(disposed.status, 'disposed');
  assert.equal(disposed.hasCurrent, false);
  await liveReload.dispose();
  assert.deepEqual(events, [
    ['current', 'stop', 'live-reload-dispose'],
    ['current', 'dispose', 'live-reload-dispose'],
  ]);
  await assert.rejects(liveReload.stage(parse(initialSource)), /disposed/u);
});

test('preserves source integrity and discards candidate state without stopping current runtime', async () => {
  const events = [];
  const currentStory = parse(initialSource).storyDocument;
  const currentSession = fakeSession(
    {
      status: 'running',
      sceneId: 'opening',
      actionIndex: 0,
      actionPath: '/scenes/opening/actions/0',
      variables: {score: 1},
    },
    events,
    'current',
  );
  const liveReload = createDsl4LiveReloadSession({
    initialStoryDocument: currentStory,
    initialSession: currentSession,
    initialSourceIntegrity: 'sha256-current',
    createSession() {
      assert.fail('discard must not create a replacement session');
    },
  });
  const next = {
    ...parse(initialSource.replace('seconds: 1', 'seconds: 2')),
    sourceSnapshot: {sourceId: 'main', integrity: 'sha256-next'},
  };
  const pending = await liveReload.stage(next);
  assert.equal(pending.current.integrity, 'sha256-current');
  assert.equal(pending.candidate.integrity, 'sha256-next');

  const active = await liveReload.discardCandidate();
  assert.equal(active.status, 'active');
  assert.equal(active.candidate, null);
  assert.equal(active.current.integrity, 'sha256-current');
  assert.deepEqual(events, []);
});

test('discarding a candidate does not revive a runtime after commit failure', async () => {
  const events = [];
  const currentStory = parse(initialSource).storyDocument;
  const liveReload = createDsl4LiveReloadSession({
    initialStoryDocument: currentStory,
    initialSession: fakeSession(
      {
        status: 'running',
        sceneId: 'opening',
        actionIndex: 0,
        actionPath: '/scenes/opening/actions/0',
        variables: {score: 1},
      },
      events,
      'current',
    ),
    createSession() {
      const next = fakeSession(
        {status: 'idle', sceneId: null, actionIndex: -1, actionPath: null, variables: {}},
        events,
        'next',
      );
      return {...next, start: () => assert.fail('replacement start failed')};
    },
  });
  const pending = await liveReload.stage(parse(initialSource.replace('seconds: 1', 'seconds: 2')));
  await assert.rejects(
    liveReload.commit(pending.candidate.id, 'currentAction'),
    /replacement start failed/u,
  );
  assert.equal(liveReload.getState().status, 'failed');
  assert.equal((await liveReload.discardCandidate()).status, 'failed');
});

test('live reload core has no filesystem, network, DOM, transport, VM, or Scratch dependency', async () => {
  const implementation = await readFile(
    path.join(projectRoot, 'src', 'dsl4', 'live-reload-session.js'),
    'utf8',
  );
  assert.doesNotMatch(implementation, /(?:node:fs|node:http|node:https|\bfetch\s*\()/);
  assert.doesNotMatch(
    implementation,
    /(?:globalThis\.(?:document|window)|WebSocket|KeyboardEvent|addEventListener)/,
  );
  assert.doesNotMatch(implementation, /(?:\bScratch\b|scratch-vm|vm\.runtime|startHats)/);
});
