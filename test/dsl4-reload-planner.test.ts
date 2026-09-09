import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4ReloadPlan} from '../src/dsl4/index.js';
import {dsl4TestSourceFrontend} from './helpers/dsl4-test-frontend.ts';
import {requireDefined, requireRecord} from './helpers/require-value.ts';

const frontend = dsl4TestSourceFrontend;

function parseStory(source: string, sourceId = 'reload-test.kamishibai.yaml'): PlannerStory {
  const result = frontend.parse(source, {sourceId});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return requireRecord(result.storyDocument, 'the story document') as unknown as PlannerStory;
}

/**
 * The story members this suite reads out of a parsed document.
 *
 * The frontend declares its document opaquely; the planner cases build an execution position from
 * the scenes and variables, so those are named here once.
 */
interface PlannerStory extends Readonly<Record<string, unknown>> {
  variables: Record<string, unknown>;
  scenes: {id: string; actions: Record<string, unknown>[]}[];
}

/**
 * Presents a deliberately out-of-contract value to the planner.
 *
 * The rejection cases hand the planner arguments its own types forbid, so this seam names that
 * intent once instead of repeating a cast at every such call site.
 */
function outOfContract<T>(value: unknown): T {
  return value as T;
}

function execution(
  story: PlannerStory,
  sceneId: string,
  actionIndex: number,
  variables: Record<string, unknown> = story.variables,
) {
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
      .map((entry) => requireRecord(entry.details, 'the diagnostic details').name),
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
      .map((entry) => [
        requireRecord(entry.details, 'the diagnostic details').name,
        requireRecord(entry.details, 'the diagnostic details').referenceKind,
      ]),
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
  const firstScene = requireDefined(candidate.scenes[0], 'the first scene');
  const duplicate = requireDefined(firstScene.actions[0], 'its first action');
  const ambiguousCandidate = {
    ...candidate,
    scenes: [
      {
        ...firstScene,
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

  const missingFirstScene = requireDefined(missing.scenes[0], 'the first scene');
  const duplicate = requireDefined(missingFirstScene.actions[0], 'its first action');
  const ambiguous = {
    ...missing,
    scenes: [
      missingFirstScene,
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
        isException: outOfContract(true),
      }),
    /isException must be a function/u,
  );
});
