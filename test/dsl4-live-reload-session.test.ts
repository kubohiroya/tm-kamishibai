import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'vitest';
import {fileURLToPath} from 'node:url';

import {createDsl4LiveReloadSession, createDsl4SourceFrontend} from '../src/dsl4/index.js';
import type {LiveReloadRuntimeSession} from '../src/dsl4/live-reload-session.js';
import type {ParseResult} from '../src/dsl4/source-frontend.js';
import {thrown} from './helpers/thrown-error.ts';
import {deferred} from './helpers/async-test-helpers.ts';
import {requireArray, requireDefined, requireRecord} from './helpers/require-value.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);

type LiveReloadSession = ReturnType<typeof createDsl4LiveReloadSession>;
type LiveReloadState = ReturnType<LiveReloadSession['getState']>;
type LiveReloadCandidate = NonNullable<LiveReloadState['candidate']>;
type LiveReloadPlan = NonNullable<LiveReloadCandidate['plan']>;
type RestartChoice = keyof LiveReloadPlan['options'];

/** What one fake runtime session reports, and what a restart choice moves it to. */
interface FakeRuntimeState {
  status: string;
  sceneId: string | null;
  actionIndex: number;
  actionPath: string | null;
  variables: Readonly<Record<string, string | number | boolean>>;
}

/** The `[session, member, argument]` rows every case asserts the reload order on. */
type SessionEvent = [string, string, unknown];

function parse(source: string): ParseResult {
  return frontend.parse(source, {sourceId: 'main'});
}

/** Read the story document one source parses to, so a case fails on the parse rather than later. */
function story(source: string): Readonly<Record<string, unknown>> {
  const result = parse(source);
  assert(result.ok, 'expected the source to parse');
  return result.storyDocument;
}

/** Read the variables a story document declares, as the runtime state carries them. */
function storyVariables(
  storyDocument: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string | number | boolean>> {
  const variables = requireRecord(storyDocument.variables, 'the story variables');
  return Object.fromEntries(
    Object.entries(variables).map(([name, value]) => {
      assert(
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
        `expected story variable ${name} to be a scalar`,
      );
      return [name, value];
    }),
  );
}

function candidateOf(state: LiveReloadState): LiveReloadCandidate {
  return requireDefined(state.candidate, 'the staged candidate');
}

function planOf(state: LiveReloadState): LiveReloadPlan {
  return requireDefined(candidateOf(state).plan, 'the candidate plan');
}

/** Read one restart choice the plan reports on, enabled or not. */
function planOption(state: LiveReloadState, choice: RestartChoice) {
  return planOf(state).options[choice];
}

/** Read one restart choice the case expects the plan to offer. */
function enabledOption(state: LiveReloadState, choice: RestartChoice) {
  const option = planOf(state).options[choice];
  assert(option.enabled, `expected the ${choice} choice to be enabled`);
  return option;
}

/** Read the runtime the current generation reports. */
function currentRuntime(state: LiveReloadState): Record<string, unknown> {
  return requireRecord(
    requireDefined(state.current, 'the current generation').runtime,
    'its runtime state',
  );
}

/**
 * Pass arguments the factory refuses on purpose.
 *
 * The guard cases assert that the factory rejects a non-function `isException` and a session that
 * is missing members, which its declaration already forbids.
 */
function invalidOptions(
  options: Record<string, unknown>,
): Parameters<typeof createDsl4LiveReloadSession>[0] {
  return options as unknown as Parameters<typeof createDsl4LiveReloadSession>[0];
}

function fakeSession(
  runtime: FakeRuntimeState,
  events: SessionEvent[],
  name: string,
): LiveReloadRuntimeSession {
  let state: FakeRuntimeState = {...runtime};
  let disposed = false;
  let quiesceToken: Readonly<Record<string, unknown>> | null = null;
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
    stop(reason?: string) {
      events.push([name, 'stop', reason]);
      state = {...state, status: 'stopped'};
      quiesceToken = null;
      return state;
    },
    invokeAction(action) {
      events.push([name, 'invokeAction', action]);
      return Promise.resolve({outcome: 'completed'});
    },
    queueVariableWrite(request) {
      events.push([name, 'queueVariableWrite', request]);
      return {accepted: true, code: ''};
    },
    getRuntimeVariableSnapshot() {
      return {owner: name, storyVariables: {...state.variables}};
    },
    dispose(reason?: string) {
      events.push([name, 'dispose', reason]);
      disposed = true;
    },
    getState() {
      return {runtime: {...state}, disposed};
    },
    quiesce({candidateId}) {
      quiesceToken = Object.freeze({
        kind: 'Dsl4QuiesceToken',
        version: 1,
        candidateId,
        runtimeGeneration: 1,
        storyPath: state.actionPath ?? `/scenes/${state.sceneId}`,
        actionSignature: state.actionPath ? {command: 'wait', target: null, handler: 'core'} : null,
        sceneId: state.sceneId,
        actionIndex: state.actionIndex,
        variables: {...state.variables},
        resumeMode: state.actionPath ? 'replay-action' : 'finished',
      });
      state = {...state, status: 'paused'};
      return quiesceToken;
    },
    resumeQuiesce(candidateId: number) {
      if (!quiesceToken || quiesceToken.candidateId !== candidateId) {
        throw new TypeError('stale quiesce candidate');
      }
      quiesceToken = null;
      state = {...state, status: 'running'};
      return state;
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

test('routes action invocation directly to the active live reload generation', async () => {
  const events: SessionEvent[] = [];
  const storyDocument = story(initialSource);
  const currentSession = fakeSession(
    {
      status: 'running',
      sceneId: 'opening',
      actionIndex: 0,
      actionPath: '/scenes/opening/actions/0',
      variables: {score: 0},
    },
    events,
    'current',
  );
  const liveReload = createDsl4LiveReloadSession({
    initialStoryDocument: storyDocument,
    initialSession: currentSession,
    createSession() {
      assert.fail('action invocation must not create a reload generation');
    },
  });
  const action = {command: 'wait', target: null, args: {seconds: 0}};

  assert.deepEqual(await liveReload.invokeAction(action), {outcome: 'completed'});
  const write = {operation: 'change', name: 'score', value: 1};
  assert.deepEqual(liveReload.queueVariableWrite(write), {accepted: true, code: ''});
  assert.deepEqual(liveReload.getRuntimeVariableSnapshot(), {
    owner: 'current',
    storyVariables: {score: 0},
  });
  assert.deepEqual(events, [
    ['current', 'invokeAction', action],
    ['current', 'queueVariableWrite', write],
  ]);
  await liveReload.dispose();
  await assert.rejects(
    liveReload.invokeAction(action),
    (error) => thrown(error).code === 'K4-RELOAD-INVOKE-DISPOSED',
  );
});

test('waits through an invalid initial source and auto-starts the first valid snapshot', async () => {
  const events: SessionEvent[] = [];
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
          variables: storyVariables(storyDocument),
        },
        events,
        'initial',
      );
    },
  });

  const invalid = await liveReload.stage(parse(`kamishibai: '4.0'\nscenes: {}`));
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.hasCurrent, false);
  assert.ok(requireArray(invalid.diagnostics, 'the invalid-source diagnostics').length > 0);
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
  assert.equal(
    requireRecord(
      requireArray(missing.diagnostics, 'the missing-source diagnostics')[0],
      'its first diagnostic',
    ).code,
    'K4-SOURCE-MISSING',
  );
  assert.equal(creates, 0);

  const valid = await liveReload.stage(parse(initialSource));
  assert.equal(valid.status, 'active');
  assert.equal(valid.hasCurrent, true);
  assert.equal(valid.candidate, null);
  assert.equal(creates, 1);
  assert.deepEqual(events, [['initial', 'start', {}]]);

  const directEvents: SessionEvent[] = [];
  const direct = createDsl4LiveReloadSession({
    createSession({storyDocument}) {
      return fakeSession(
        {
          status: 'idle',
          sceneId: 'opening',
          actionIndex: 0,
          actionPath: '/scenes/opening/actions/0',
          variables: storyVariables(storyDocument),
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
  const events: SessionEvent[] = [];
  const currentStory = story(initialSource);
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
  assert.equal(currentRuntime(state).status, 'running');
  assert.deepEqual(currentRuntime(state).variables, {score: 7});
  assert.equal(state.candidate, null);
  assert.deepEqual(events, []);
});

test('passes the Adapter ExceptionRef predicate into live reload planning', async () => {
  const currentStory = story(`
kamishibai: '4.0'
variables:
  exceptionToken: initial
  forgedToken: initial
scenes:
  opening:
    - wait: 1
`);
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
  assert.deepEqual(enabledOption(staged, 'currentScene').variables, {
    exceptionToken: 'reset',
    forgedToken,
  });
  assert.equal(JSON.stringify(planOf(staged)).includes(exceptionToken), false);
  assert.throws(
    () =>
      createDsl4LiveReloadSession(
        invalidOptions({
          createSession() {},
          isException: true,
        }),
      ),
    /isException must be a function/u,
  );
});

test('stages, defers, and commits each author-visible restart choice explicitly', async () => {
  const choices: [RestartChoice, boolean][] = [
    ['storyStart', false],
    ['currentScene', false],
    ['currentAction', true],
  ];
  for (const [choice, expectedPresentation] of choices) {
    const events: SessionEvent[] = [];
    const currentStory = story(initialSource);
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
    const createCalls: Readonly<{
      previousSession: LiveReloadRuntimeSession | null;
      preserveManagedPresentation: boolean;
    }>[] = [];
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
    assert.equal(enabledOption(pending, choice).enabled, true);
    const candidateId = candidateOf(pending).id;
    const deferredState = await liveReload.defer(candidateId);
    assert.equal(deferredState.status, 'active');
    assert.equal(deferredState.candidate, null);
    assert.deepEqual(events, []);

    await assert.rejects(liveReload.commit(candidateId, choice), /stale or missing/u);
    const restaged = await liveReload.stage(candidate);
    const committed = await liveReload.commit(candidateOf(restaged).id, choice);
    const option = enabledOption(restaged, choice);
    assert.equal(committed.status, 'active');
    assert.equal(committed.generation, 2);
    assert.equal(committed.candidate, null);
    const firstCall = requireDefined(createCalls[0], 'the first createSession call');
    assert.equal(firstCall.previousSession, currentSession);
    assert.equal(firstCall.preserveManagedPresentation, expectedPresentation);
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
  const events: SessionEvent[] = [];
  const currentStory = story(initialSource);
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
  assert.equal(planOption(first, 'currentScene').enabled, false);
  assert.equal(planOption(first, 'currentAction').enabled, false);
  await assert.rejects(
    liveReload.commit(candidateOf(first).id, 'currentAction'),
    /currentAction is disabled/u,
  );

  const second = await liveReload.stage(
    parse(`kamishibai: '4.0'\nvariables: {score: 0}\nscenes:\n  opening: []\n`),
  );
  await assert.rejects(liveReload.commit(candidateOf(first).id, 'storyStart'), /stale or missing/u);
  assert.notEqual(candidateOf(second).id, candidateOf(first).id);
  assert.deepEqual(events, []);
});

test('serializes a later stage behind an in-flight commit and plans from the new runtime', async () => {
  const events: SessionEvent[] = [];
  const gate = deferred();
  const currentStory = story(initialSource);
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
  const commit = liveReload.commit(candidateOf(first).id, 'currentAction');
  const laterStage = liveReload.stage(parse(initialSource.replace('seconds: 1', 'seconds: 3')));
  await Promise.resolve();
  assert.equal(createCount, 1);
  gate.resolve();
  await commit;
  const later = await laterStage;
  assert.equal(later.status, 'pending');
  assert.equal(later.generation, 2);
  assert.equal(enabledOption(later, 'currentAction').enabled, true);
});

test('clears a pending candidate on a later invalid source and disposes once', async () => {
  const events: SessionEvent[] = [];
  const currentStory = story(initialSource);
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
  const events: SessionEvent[] = [];
  const currentStory = story(initialSource);
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
  assert.equal(
    requireDefined(pending.current, 'the current generation').integrity,
    'sha256-current',
  );
  assert.equal(candidateOf(pending).integrity, 'sha256-next');

  const active = await liveReload.discardCandidate();
  assert.equal(active.status, 'active');
  assert.equal(active.candidate, null);
  assert.equal(
    requireDefined(active.current, 'the current generation').integrity,
    'sha256-current',
  );
  assert.deepEqual(events, []);
});

test('discarding a candidate does not revive a runtime after commit failure', async () => {
  const events: SessionEvent[] = [];
  const currentStory = story(initialSource);
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
    liveReload.commit(candidateOf(pending).id, 'currentAction'),
    /replacement start failed/u,
  );
  assert.equal(liveReload.getState().status, 'failed');
  assert.equal((await liveReload.discardCandidate()).status, 'failed');
});
