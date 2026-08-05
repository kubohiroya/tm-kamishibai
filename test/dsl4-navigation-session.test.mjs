import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {createDsl4NavigationSession, createDsl4SourceFrontend} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);

function parseStory(source) {
  const result = frontend.parse(source, {sourceId: 'session-test.kamishibai.yaml'});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.storyDocument;
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {promise, resolve};
}

function keyEvent(code) {
  const counters = {preventDefault: 0, stopPropagation: 0};
  return {
    code,
    defaultPrevented: false,
    repeat: false,
    preventDefault() {
      counters.preventDefault += 1;
      this.defaultPrevented = true;
    },
    stopPropagation() {
      counters.stopPropagation += 1;
    },
    counters,
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

const controls = `
controls:
  keymaps:
    development:
      Space: navigation.nextAction
      ArrowLeft: history.previousAction
      ArrowUp: history.previousScene
      ArrowDown: history.nextScene
    production:
      Space: navigation.nextAction
`;

test('history-free profile creates no history state and dispatches only its selected keymap', async () => {
  const pending = deferred();
  let stageCalls = 0;
  const story = parseStory(`
kamishibai: '4.0'
${controls}
assets:
  Beach: backdrop
scenes:
  opening:
    - wait: 1
    - stage: Beach
`);
  const created = createDsl4NavigationSession({
    storyDocument: story,
    controlProfile: 'production',
    port: {
      wait: () => pending.promise,
      stage: async () => stageCalls++,
    },
  });
  assert.equal(created.ok, true, JSON.stringify(created.diagnostics));
  const {session} = created;
  const staleRun = session.start();
  assert.equal(session.getState().historyEnabled, false);
  assert.equal(session.getState().history, null);

  const arrow = keyEvent('ArrowLeft');
  assert.equal(session.handleKeyDown(arrow), false);
  assert.deepEqual(arrow.counters, {preventDefault: 0, stopPropagation: 0});
  const inactive = session.dispatchCommand('history.previousAction');
  assert.equal(inactive.ok, false);
  assert.equal(inactive.diagnostics[0].code, 'K4-KEYMAP-COMMAND-INACTIVE');

  const space = keyEvent('Space');
  assert.equal(session.handleKeyDown(space), true);
  await session.whenInputIdle();
  await waitFor(() => stageCalls === 1, 'selected nextAction did not advance the runtime');
  assert.deepEqual(space.counters, {preventDefault: 1, stopPropagation: 1});
  assert.equal(session.getState().history, null);
  pending.resolve();
  await staleRun;
});

test('history profile requires availability and explicit finite limits', () => {
  const story = parseStory(`
kamishibai: '4.0'
${controls}
scenes:
  opening: []
`);
  const unavailable = createDsl4NavigationSession({
    storyDocument: story,
    controlProfile: 'development',
    port: {},
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.diagnostics[0].code, 'K4-KEYMAP-HISTORY-UNAVAILABLE');

  const noLimits = createDsl4NavigationSession({
    storyDocument: story,
    controlProfile: 'development',
    historyNavigationAvailable: true,
    port: {},
  });
  assert.equal(noLimits.ok, false);
  assert.equal(noLimits.diagnostics[0].code, 'K4-HISTORY-LIMIT-CONFIG-001');
});

test('integrates chronological scene navigation, future truncation, and non-retroactive variables', async () => {
  const waits = [];
  let presentationState = 'initial';
  const story = parseStory(`
kamishibai: '4.0'
${controls}
variables:
  score: 1
scenes:
  opening:
    - wait: 1
    - goto: middle
  middle:
    - wait: 1
    - goto: ending
  ending:
    - wait: 1
`);
  const created = createDsl4NavigationSession({
    storyDocument: story,
    controlProfile: 'development',
    historyNavigationAvailable: true,
    historyLimits: {maxActionEntries: 20, maxSceneVisits: 20},
    port: {
      wait: (_payload, context) => {
        const nextScore = Number(context.getVariable('score')) + 1;
        context.setVariable('score', nextScore);
        presentationState = `wait-${nextScore}`;
        const pending = deferred();
        waits.push(pending);
        return pending.promise;
      },
    },
  });
  assert.equal(created.ok, true, JSON.stringify(created.diagnostics));
  const {session} = created;
  session.start();
  await waitFor(() => waits.length === 1, 'opening wait did not start');

  for (const expectedWaitCount of [2, 3]) {
    assert.equal(session.handleKeyDown(keyEvent('Space')), true);
    await session.whenInputIdle();
    await waitFor(() => waits.length === expectedWaitCount, 'next scene wait did not start');
  }
  assert.deepEqual(
    session.getState().history.sceneVisits.map(({sceneId}) => sceneId),
    ['opening', 'middle', 'ending'],
  );
  assert.equal(session.getState().runtime.variables.score, 4);
  assert.equal(presentationState, 'wait-4');

  for (const [code, expectedScene] of [
    ['ArrowUp', 'middle'],
    ['ArrowUp', 'opening'],
    ['ArrowDown', 'middle'],
  ]) {
    session.handleKeyDown(keyEvent(code));
    await session.whenInputIdle();
    assert.equal(session.getState().runtime.status, 'paused');
    assert.equal(session.getState().runtime.sceneId, expectedScene);
    assert.equal(session.getState().runtime.variables.score, 4);
    assert.equal(presentationState, 'wait-4');
  }

  session.handleKeyDown(keyEvent('Space'));
  await session.whenInputIdle();
  await waitFor(() => waits.length === 4, 'history destination action did not resume');
  assert.equal(session.getState().runtime.sceneId, 'middle');
  assert.equal(session.getState().runtime.variables.score, 5);
  assert.deepEqual(
    session.getState().history.sceneVisits.map(({sceneId}) => sceneId),
    ['opening', 'middle'],
  );

  session.handleKeyDown(keyEvent('Space'));
  await session.whenInputIdle();
  await waitFor(() => waits.length === 5, 'new future scene did not execute');
  const current = session.getState();
  assert.equal(current.runtime.sceneId, 'ending');
  assert.equal(current.runtime.variables.score, 6);
  assert.deepEqual(
    current.history.sceneVisits.map(({sceneId}) => sceneId),
    ['opening', 'middle', 'ending'],
  );
  assert.deepEqual(
    current.history.sceneVisits.map(({visitId}) => visitId),
    [1, 2, 4],
  );

  session.stop('test-complete');
  const stopped = session.getState();
  assert.equal(stopped.history.actionEntries.length, 0);
  assert.equal(stopped.history.sceneVisits.length, 0);
  for (const wait of waits) wait.resolve();
});

test('can reposition from a finished runtime and releases input and history on dispose', async () => {
  const story = parseStory(`
kamishibai: '4.0'
${controls}
scenes:
  opening:
    - wait: 0
`);
  const created = createDsl4NavigationSession({
    storyDocument: story,
    controlProfile: 'development',
    historyNavigationAvailable: true,
    historyLimits: {maxActionEntries: 10, maxSceneVisits: 10},
    port: {wait: async () => {}},
  });
  const {session} = created;
  await session.start();
  assert.equal(session.getState().runtime.status, 'finished');
  const moved = session.dispatchCommand('history.previousAction');
  assert.equal(moved.ok, true);
  assert.equal(session.getState().runtime.status, 'paused');
  assert.equal(session.getState().runtime.actionPath, '/scenes/opening/actions/0');

  session.dispose();
  assert.equal(session.getState().disposed, true);
  assert.equal(session.getState().history.actionEntries.length, 0);
  assert.equal(session.handleKeyDown(keyEvent('ArrowLeft')), false);
});

test('history limit failure stops the runtime without partially recording the next visit', async () => {
  const pending = deferred();
  const story = parseStory(`
kamishibai: '4.0'
${controls}
scenes:
  opening:
    - wait: 1
    - goto: ending
  ending: []
`);
  const created = createDsl4NavigationSession({
    storyDocument: story,
    controlProfile: 'development',
    historyNavigationAvailable: true,
    historyLimits: {maxActionEntries: 10, maxSceneVisits: 1},
    port: {wait: () => pending.promise},
  });
  const {session} = created;
  const staleRun = session.start();
  session.handleKeyDown(keyEvent('Space'));
  await session.whenInputIdle();
  await waitFor(() => session.getState().diagnostic !== null, 'history limit did not fail closed');
  const failed = session.getState();
  assert.equal(failed.runtime.status, 'stopped');
  assert.equal(failed.diagnostic.code, 'K4-HISTORY-LIMIT-001');
  assert.deepEqual(
    failed.history.sceneVisits.map(({sceneId}) => sceneId),
    ['opening'],
  );
  pending.resolve();
  await staleRun;
});

test('navigation session core has no filesystem, network, global DOM, VM, or Scratch dependency', async () => {
  const implementation = await readFile(
    path.join(projectRoot, 'src', 'dsl4', 'navigation-session.js'),
    'utf8',
  );
  assert.doesNotMatch(implementation, /(?:node:fs|node:http|node:https|\bfetch\s*\()/);
  assert.doesNotMatch(implementation, /(?:globalThis\.(?:document|window)|KeyboardEvent)/);
  assert.doesNotMatch(implementation, /(?:\bScratch\b|scratch-vm|vm\.runtime|startHats)/);
});
