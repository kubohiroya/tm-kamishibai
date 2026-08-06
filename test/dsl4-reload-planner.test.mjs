import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {createDsl4ReloadPlan, createDsl4SourceFrontend} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);

function parseStory(source, sourceId = 'reload-test.kamishibai.yaml') {
  const result = frontend.parse(source, {sourceId});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.storyDocument;
}

function execution(story, sceneId, actionIndex, variables = story.variables) {
  const scene = story.scenes.find((candidate) => candidate.id === sceneId);
  return {
    status: 'running',
    sceneId,
    actionIndex,
    actionPath: scene?.actions[actionIndex]?.id ?? null,
    variables,
  };
}

const currentSource = `
kamishibai: '4.0'
variables:
  score: 0
  hero: Alice
  ready: false
scenes:
  opening:
    - wait:
        seconds: 1
        stableId: opening-wait
    - wait: 2
  ending:
    - wait: 3
`;

test('always enables a story restart and resets all state to new initial variables', () => {
  const current = parseStory(currentSource);
  const candidate = parseStory(`
kamishibai: '4.0'
variables:
  score: 10
  added: new
scenes:
  next:
    - wait: 1
`);
  const plan = createDsl4ReloadPlan({
    currentStoryDocument: current,
    candidateStoryDocument: candidate,
    currentExecution: execution(current, 'opening', 0, {score: 99, hero: 'Bob', ready: true}),
  });

  assert.deepEqual(plan.options.storyStart, {
    enabled: true,
    destination: {sceneId: 'next', actionIndex: 0, actionPath: '/scenes/next/actions/0'},
    variables: {score: 10, added: 'new'},
    preserveManagedPresentation: false,
  });
  assert.equal(plan.options.currentScene.enabled, false);
  assert.equal(plan.options.currentScene.reason, 'K4-RELOAD-SCENE-MISSING');
});

test('preserves only same-name, same-type scalar variables for scene and action restarts', () => {
  const current = parseStory(currentSource);
  const candidate = parseStory(`
kamishibai: '4.0'
variables:
  score: 10
  hero: 7
  ready: true
  added: new
scenes:
  opening:
    - wait:
        seconds: 4
        stableId: opening-wait
`);
  const plan = createDsl4ReloadPlan({
    currentStoryDocument: current,
    candidateStoryDocument: candidate,
    currentExecution: execution(current, 'opening', 0, {
      score: 99,
      hero: 99,
      ready: {objectStoreReference: 'asset-1'},
      removed: true,
    }),
  });

  const expected = {score: 99, hero: 7, ready: true, added: 'new'};
  assert.deepEqual(plan.options.currentScene.variables, expected);
  assert.deepEqual(plan.options.currentAction.variables, expected);
  assert.deepEqual(
    plan.diagnostics
      .filter((entry) => entry.code === 'K4-RELOAD-VARIABLE-RESET')
      .map((entry) => entry.details.name),
    ['hero', 'ready'],
  );
  assert.equal(plan.options.currentScene.preserveManagedPresentation, false);
  assert.equal(plan.options.currentAction.preserveManagedPresentation, true);
});

test('resets Object Store and ExceptionRef variables instead of transferring runtime handles', () => {
  const current = parseStory(`
kamishibai: '4.0'
variables:
  objectHandle: initial-object
  exceptionToken: initial-exception
  forgedToken: initial-forged
  preserved: initial
scenes:
  opening:
    - wait: 1
`);
  const candidate = parseStory(`
kamishibai: '4.0'
variables:
  objectHandle: next-object
  exceptionToken: next-exception
  forgedToken: next-forged
  preserved: next
scenes:
  opening:
    - wait: 2
`);
  const runtimeOnlyValues = {
    objectHandle: '@os1.private-realm.private-handle',
    exceptionToken: '@sdx1.private-realm.private-exception',
    forgedToken: '@sdx1.forged-realm.forged-exception',
    preserved: 'live-value',
  };
  const plan = createDsl4ReloadPlan({
    currentStoryDocument: current,
    candidateStoryDocument: candidate,
    currentExecution: execution(current, 'opening', 0, runtimeOnlyValues),
    isException: (value) => value === runtimeOnlyValues.exceptionToken,
  });

  const expectedVariables = {
    objectHandle: 'next-object',
    exceptionToken: 'next-exception',
    forgedToken: runtimeOnlyValues.forgedToken,
    preserved: 'live-value',
  };
  assert.deepEqual(plan.options.currentScene.variables, expectedVariables);
  assert.deepEqual(plan.options.currentAction.variables, expectedVariables);
  assert.deepEqual(
    plan.diagnostics
      .filter((entry) => entry.code === 'K4-RELOAD-VARIABLE-REFERENCE-RESET')
      .map((entry) => [entry.details.name, entry.details.referenceKind]),
    [
      ['objectHandle', 'object-store'],
      ['exceptionToken', 'exception'],
    ],
  );
  const serialized = JSON.stringify(plan);
  for (const value of [runtimeOnlyValues.objectHandle, runtimeOnlyValues.exceptionToken]) {
    assert.equal(serialized.includes(value), false);
  }
  assert.equal(serialized.includes(runtimeOnlyValues.forgedToken), true);
});

test('uses stableId before location and follows a moved action across scenes', () => {
  const current = parseStory(currentSource);
  const candidate = parseStory(`
kamishibai: '4.0'
scenes:
  opening:
    - wait: 9
  moved:
    - wait:
        seconds: 5
        stableId: opening-wait
`);
  const plan = createDsl4ReloadPlan({
    currentStoryDocument: current,
    candidateStoryDocument: candidate,
    currentExecution: execution(current, 'opening', 0),
  });

  assert.deepEqual(plan.options.currentAction.destination, {
    sceneId: 'moved',
    actionIndex: 0,
    actionPath: '/scenes/moved/actions/0',
  });
  assert.deepEqual(plan.options.currentAction.anchor, {
    strategy: 'stableId',
    value: 'opening-wait',
  });
});

test('disables a stableId anchor that is missing, ambiguous, or signature-incompatible', () => {
  const current = parseStory(currentSource);
  const cases = [
    {
      source: `kamishibai: '4.0'\nscenes:\n  opening:\n    - wait: 1\n`,
      code: 'K4-RELOAD-ANCHOR-MISSING',
    },
    {
      source: `kamishibai: '4.0'\nscenes:\n  opening:\n    - goto:\n        scene: opening\n        stableId: opening-wait\n`,
      code: 'K4-RELOAD-ANCHOR-INCOMPATIBLE',
    },
  ];
  for (const fixture of cases) {
    const candidate = parseStory(fixture.source);
    const plan = createDsl4ReloadPlan({
      currentStoryDocument: current,
      candidateStoryDocument: candidate,
      currentExecution: execution(current, 'opening', 0),
    });
    assert.equal(plan.options.currentAction.enabled, false);
    assert.equal(plan.options.currentAction.reason, fixture.code);
  }

  const candidate = parseStory(`kamishibai: '4.0'\nscenes:\n  opening:\n    - wait: 1\n`);
  const duplicate = candidate.scenes[0].actions[0];
  const ambiguousCandidate = {
    ...candidate,
    scenes: [
      {
        ...candidate.scenes[0],
        actions: [
          {...duplicate, stableId: 'opening-wait'},
          {...duplicate, id: '/scenes/opening/actions/1', stableId: 'opening-wait'},
        ],
      },
    ],
  };
  const ambiguousPlan = createDsl4ReloadPlan({
    currentStoryDocument: current,
    candidateStoryDocument: ambiguousCandidate,
    currentExecution: execution(current, 'opening', 0),
  });
  assert.equal(ambiguousPlan.options.currentAction.reason, 'K4-RELOAD-ANCHOR-AMBIGUOUS');
});

test('falls back to exact StoryPath plus command and target when stableId is absent', () => {
  const current = parseStory(currentSource);
  const candidate = parseStory(`
kamishibai: '4.0'
scenes:
  opening:
    - wait: 10
    - wait: 20
`);
  const plan = createDsl4ReloadPlan({
    currentStoryDocument: current,
    candidateStoryDocument: candidate,
    currentExecution: execution(current, 'opening', 1),
  });

  assert.equal(plan.options.currentAction.enabled, true);
  assert.deepEqual(plan.options.currentAction.anchor, {
    strategy: 'storyPath+signature',
    value: '/scenes/opening/actions/1',
  });
  assert.deepEqual(plan.options.currentAction.destination, {
    sceneId: 'opening',
    actionIndex: 1,
    actionPath: '/scenes/opening/actions/1',
  });
});

test('strict fallback reports missing, ambiguous, and incompatible without fuzzy matching', () => {
  const current = parseStory(currentSource);
  const currentExecution = execution(current, 'ending', 0);
  const missing = parseStory(`
kamishibai: '4.0'
scenes:
  opening:
    - wait: 3
  ending: []
`);
  const missingPlan = createDsl4ReloadPlan({
    currentStoryDocument: current,
    candidateStoryDocument: missing,
    currentExecution,
  });
  assert.equal(missingPlan.options.currentAction.reason, 'K4-RELOAD-ANCHOR-MISSING');

  const incompatible = parseStory(`
kamishibai: '4.0'
scenes:
  opening: []
  ending:
    - goto: opening
`);
  const incompatiblePlan = createDsl4ReloadPlan({
    currentStoryDocument: current,
    candidateStoryDocument: incompatible,
    currentExecution,
  });
  assert.equal(incompatiblePlan.options.currentAction.reason, 'K4-RELOAD-ANCHOR-INCOMPATIBLE');

  const duplicate = missing.scenes[0].actions[0];
  const ambiguous = {
    ...missing,
    scenes: [
      missing.scenes[0],
      {
        ...missing.scenes[1],
        actions: [
          {...duplicate, id: '/scenes/ending/actions/0'},
          {...duplicate, id: '/scenes/ending/actions/0'},
        ],
      },
    ],
  };
  const ambiguousPlan = createDsl4ReloadPlan({
    currentStoryDocument: current,
    candidateStoryDocument: ambiguous,
    currentExecution,
  });
  assert.equal(ambiguousPlan.options.currentAction.reason, 'K4-RELOAD-ANCHOR-AMBIGUOUS');
});

test('returns deeply immutable data and rejects invalid planner boundaries', () => {
  const current = parseStory(currentSource);
  const plan = createDsl4ReloadPlan({
    currentStoryDocument: current,
    candidateStoryDocument: current,
    currentExecution: execution(current, 'opening', 0),
  });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.options.currentAction.destination), true);
  assert.equal(Object.isFrozen(plan.options.currentAction.variables), true);
  assert.equal(Object.isFrozen(plan.diagnostics), true);

  assert.throws(
    () =>
      createDsl4ReloadPlan({
        currentStoryDocument: {kind: 'StoryDocument', version: '3.2'},
        candidateStoryDocument: current,
        currentExecution: {},
      }),
    /currentStoryDocument must be a DSL 4\.0 StoryDocument/u,
  );
  assert.throws(
    () =>
      createDsl4ReloadPlan({
        currentStoryDocument: current,
        candidateStoryDocument: current,
        currentExecution: execution(current, 'opening', 0),
        isException: true,
      }),
    /isException must be a function/u,
  );
});
