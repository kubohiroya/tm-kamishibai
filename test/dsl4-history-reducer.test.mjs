import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'vitest';
import {fileURLToPath} from 'node:url';

import {
  createDsl4HistoryReducer,
  createDsl4RuntimeController,
  createDsl4SourceFrontend,
} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);

function scene(sceneId, sequence) {
  return {type: 'scene.enter', sceneId, storyPath: `/scenes/${sceneId}`, sequence};
}

function action(sceneId, actionIndex, sequence) {
  return {
    type: 'action.commit',
    sceneId,
    actionPath: `/scenes/${sceneId}/actions/${actionIndex}`,
    sequence,
  };
}

function apply(reducer, state, event) {
  const result = reducer.reduce(state, event);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostic));
  return result;
}

test('requires finite positive limits', () => {
  assert.throws(
    () => createDsl4HistoryReducer({maxActionEntries: Infinity, maxSceneVisits: 1}),
    /maxActionEntries/,
  );
  assert.throws(
    () => createDsl4HistoryReducer({maxActionEntries: 1, maxSceneVisits: 0}),
    /maxSceneVisits/,
  );
});

test('records immutable chronological visits and commits without changing input state', () => {
  const reducer = createDsl4HistoryReducer({maxActionEntries: 10, maxSceneVisits: 10});
  const initial = reducer.initialState();
  const entered = apply(reducer, initial, scene('opening', 1));
  const committed = apply(reducer, entered.state, action('opening', 0, 2));

  assert.equal(Object.isFrozen(initial), true);
  assert.equal(Object.isFrozen(committed.state), true);
  assert.equal(Object.isFrozen(committed.state.sceneVisits), true);
  assert.equal(Object.isFrozen(committed.state.actionEntries), true);
  assert.equal(initial.sceneVisits.length, 0);
  assert.deepEqual(committed.state.sceneVisits, [
    {
      visitId: 1,
      sceneId: 'opening',
      storyPath: '/scenes/opening',
      firstActionHistoryIndex: 0,
      enteredSequence: 1,
    },
  ]);
  assert.equal(committed.state.actionCursor, 1);
  assert.equal(committed.state.lastSequence, 2);
});

test('keeps branch, goto, loop, and repeated scene visits in actual execution order', () => {
  const reducer = createDsl4HistoryReducer({maxActionEntries: 10, maxSceneVisits: 10});
  let state = reducer.initialState();
  for (const event of [
    scene('opening', 1),
    action('opening', 0, 2),
    scene('ending', 3),
    action('ending', 0, 4),
    scene('opening', 5),
    action('opening', 0, 6),
  ]) {
    state = apply(reducer, state, event).state;
  }

  assert.deepEqual(
    state.sceneVisits.map(({sceneId}) => sceneId),
    ['opening', 'ending', 'opening'],
  );
  assert.deepEqual(
    state.sceneVisits.map(({visitId}) => visitId),
    [1, 2, 3],
  );
  assert.deepEqual(
    state.actionEntries.map(({visitId}) => visitId),
    [1, 2, 3],
  );
});

test('consumes runtime controller scene and action events without translation', async () => {
  const parsed = frontend.parse(`
kamishibai: '4.0'
scenes:
  opening:
    - wait: 0
  ending: []
`);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const reducer = createDsl4HistoryReducer({maxActionEntries: 10, maxSceneVisits: 10});
  let historyState = reducer.initialState();
  const controller = createDsl4RuntimeController({
    storyDocument: parsed.storyDocument,
    port: {wait: async () => {}},
    onEvent(event) {
      if (event.type !== 'scene.enter' && event.type !== 'action.commit') return;
      const result = reducer.reduce(historyState, event);
      assert.equal(result.ok, true, JSON.stringify(result.diagnostic));
      historyState = result.state;
    },
  });

  await controller.start();
  assert.deepEqual(
    historyState.sceneVisits.map(({sceneId}) => sceneId),
    ['opening', 'ending'],
  );
  assert.deepEqual(
    historyState.actionEntries.map(({actionPath}) => actionPath),
    ['/scenes/opening/actions/0'],
  );
});

test('moves to previous committed actions without changing history entries', () => {
  const reducer = createDsl4HistoryReducer({maxActionEntries: 10, maxSceneVisits: 10});
  let state = reducer.initialState();
  for (const event of [scene('opening', 1), action('opening', 0, 2), action('opening', 1, 3)]) {
    state = apply(reducer, state, event).state;
  }
  const originalEntries = state.actionEntries;

  const previous = apply(reducer, state, {type: 'history.previousAction'});
  assert.equal(previous.destination.actionIndex, 1);
  assert.equal(previous.state.actionCursor, 1);
  assert.strictEqual(previous.state.actionEntries, originalEntries);

  const first = apply(reducer, previous.state, {type: 'history.previousAction'});
  assert.equal(first.destination.actionIndex, 0);
  assert.equal(first.state.actionCursor, 0);

  const boundary = apply(reducer, first.state, {type: 'history.previousAction'});
  assert.equal(boundary.changed, false);
  assert.strictEqual(boundary.state, first.state);
});

test('moves between scene visits chronologically, including repeated scene IDs', () => {
  const reducer = createDsl4HistoryReducer({maxActionEntries: 10, maxSceneVisits: 10});
  let state = reducer.initialState();
  for (const event of [scene('zeta', 1), scene('alpha', 2), scene('zeta', 3)]) {
    state = apply(reducer, state, event).state;
  }

  const previous = apply(reducer, state, {type: 'history.previousScene'});
  assert.deepEqual([previous.destination.sceneId, previous.destination.visitId], ['alpha', 2]);
  const first = apply(reducer, previous.state, {type: 'history.previousScene'});
  assert.deepEqual([first.destination.sceneId, first.destination.visitId], ['zeta', 1]);
  const beforeFirst = apply(reducer, first.state, {type: 'history.previousScene'});
  assert.equal(beforeFirst.changed, false);
  const next = apply(reducer, beforeFirst.state, {type: 'history.nextScene'});
  assert.deepEqual([next.destination.sceneId, next.destination.visitId], ['alpha', 2]);
});

test('resume truncates the selected destination and future before appending a new timeline', () => {
  const reducer = createDsl4HistoryReducer({maxActionEntries: 10, maxSceneVisits: 10});
  let state = reducer.initialState();
  for (const event of [
    scene('opening', 1),
    action('opening', 0, 2),
    scene('middle', 3),
    action('middle', 0, 4),
    scene('oldEnding', 5),
    action('oldEnding', 0, 6),
  ]) {
    state = apply(reducer, state, event).state;
  }

  const moved = apply(reducer, state, {type: 'history.previousScene'});
  assert.equal(moved.destination.sceneId, 'middle');
  assert.equal(moved.state.sceneVisits.length, 3);
  assert.equal(moved.state.actionEntries.length, 3);

  const resumed = apply(reducer, moved.state, {type: 'resume'});
  assert.equal(resumed.state.mode, 'live');
  assert.deepEqual(
    resumed.state.sceneVisits.map(({sceneId}) => sceneId),
    ['opening', 'middle'],
  );
  assert.deepEqual(
    resumed.state.actionEntries.map(({sceneId}) => sceneId),
    ['opening'],
  );

  state = apply(reducer, resumed.state, action('middle', 0, 7)).state;
  state = apply(reducer, state, scene('newEnding', 8)).state;
  assert.deepEqual(
    state.sceneVisits.map(({sceneId}) => sceneId),
    ['opening', 'middle', 'newEnding'],
  );
  assert.deepEqual(
    state.actionEntries.map(({sceneId}) => sceneId),
    ['opening', 'middle'],
  );
});

test('handles empty and single-action scene boundaries as deterministic no-ops', () => {
  const reducer = createDsl4HistoryReducer({maxActionEntries: 10, maxSceneVisits: 10});
  let state = reducer.initialState();
  for (const event of [scene('empty', 1), scene('single', 2), action('single', 0, 3)]) {
    state = apply(reducer, state, event).state;
  }

  const empty = apply(reducer, state, {type: 'history.previousScene'});
  assert.equal(empty.destination.sceneId, 'empty');
  assert.equal(empty.destination.actionPath, null);
  assert.equal(empty.destination.actionIndex, 0);
  const noPreviousAction = apply(reducer, empty.state, {type: 'history.previousAction'});
  assert.equal(noPreviousAction.changed, false);

  const single = apply(reducer, empty.state, {type: 'history.nextScene'});
  assert.equal(single.destination.sceneId, 'single');
  const noNextScene = apply(reducer, single.state, {type: 'history.nextScene'});
  assert.equal(noNextScene.changed, false);
});

test('rejects capacity and sequence violations without partially changing state', () => {
  const reducer = createDsl4HistoryReducer({maxActionEntries: 1, maxSceneVisits: 1});
  let state = apply(reducer, reducer.initialState(), scene('opening', 1)).state;
  state = apply(reducer, state, action('opening', 0, 2)).state;

  for (const [event, code, kind] of [
    [action('opening', 1, 3), 'K4-HISTORY-LIMIT-001', 'actionEntries'],
    [scene('ending', 3), 'K4-HISTORY-LIMIT-001', 'sceneVisits'],
    [action('opening', 1, 2), 'K4-HISTORY-SEQUENCE-001', undefined],
  ]) {
    const result = reducer.reduce(state, event);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostic.code, code);
    assert.equal(result.diagnostic.details.kind, kind);
    assert.strictEqual(result.state, state);
  }
});

test('reset releases all history without carrying runtime or presentation state', () => {
  const reducer = createDsl4HistoryReducer({maxActionEntries: 10, maxSceneVisits: 10});
  let state = apply(reducer, reducer.initialState(), scene('opening', 1)).state;
  state = apply(reducer, state, action('opening', 0, 2)).state;
  assert.deepEqual(Object.keys(state).sort(), [
    'actionCursor',
    'actionEntries',
    'currentVisitId',
    'lastSequence',
    'mode',
    'nextVisitId',
    'sceneVisitCursor',
    'sceneVisits',
  ]);

  const reset = apply(reducer, state, {type: 'reset'});
  assert.deepEqual(reset.state, reducer.initialState());
});
