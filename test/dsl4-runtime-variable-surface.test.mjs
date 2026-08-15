import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {createRuntimeExpressionComposition} from '@kubohiroya/turbowarp-runtime-expression/composition';

import {createDsl4ProductionSourceFrontend} from '../src/builder/dsl4-source-frontend.js';
import {
  createDsl4RuntimeStateExpressionComposition,
  createDsl4RuntimeVariableSnapshot,
  lowerDsl4RuntimeExpression,
} from '../src/dsl4/runtime-variable-surface.js';
import {mapDsl4RuntimeExpressionError} from '../src/dsl4/expression-diagnostics.js';

test('projects only the documented immutable primitive runtime-variable surface', () => {
  const snapshot = createDsl4RuntimeVariableSnapshot(
    {
      status: 'running',
      sceneId: 'opening',
      actionIndex: 1,
      actionPath: '/scenes/opening/actions/1',
      generation: 12,
      variables: {score: 3, title: '', ready: true, invalid: Number.NaN},
      diagnostic: {
        code: 'K4-RUNTIME-TEST',
        storyPath: '/scenes/opening/actions/1',
        message: 'must not be public',
      },
    },
    {
      poseState: {
        phase: 'completed',
        target: 'Hero',
        pose: 'rescue',
        stepIndex: 0,
        confidence: 1,
        progress: 1,
      },
      version: '4.0.0-test.1',
    },
  );

  assert.deepEqual(snapshot, {
    storyVariables: {score: 3, title: '', ready: true},
    runtime: {
      status: 'running',
      'scene.id': 'opening',
      'action.number': 2,
      'action.path': '/scenes/opening/actions/1',
      'pose.phase': 'completed',
      'pose.target': 'Hero',
      'pose.name': 'rescue',
      'pose.stepNumber': 1,
      version: '4.0.0-test.1',
    },
    diagnostic: {code: 'K4-RUNTIME-TEST', storyPath: '/scenes/opening/actions/1'},
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.runtime), true);
  assert.equal(Object.hasOwn(snapshot, 'generation'), false);
  assert.equal(JSON.stringify(snapshot).includes('must not be public'), false);
});

test('normalizes missing and disposed state without retaining a prior runtime position', () => {
  assert.deepEqual(createDsl4RuntimeVariableSnapshot(null).runtime, {
    status: 'idle',
    'scene.id': '',
    'action.number': 0,
    'action.path': '',
    'pose.phase': 'inactive',
    'pose.target': '',
    'pose.name': '',
    'pose.stepNumber': 0,
    version: '',
  });
  const disposed = createDsl4RuntimeVariableSnapshot(
    {
      status: 'finished',
      sceneId: 'ending',
      actionIndex: 2,
      actionPath: '/scenes/ending/actions/2',
      variables: {score: 4},
    },
    {poseState: {phase: 'completed', target: 'Hero', pose: 'rescue', stepIndex: 1}, disposed: true},
  );
  assert.deepEqual(disposed.runtime, {
    status: 'stopped',
    'scene.id': '',
    'action.number': 0,
    'action.path': '',
    'pose.phase': 'inactive',
    'pose.target': '',
    'pose.name': '',
    'pose.stepNumber': 0,
    version: '',
  });
});

test('lowers the fixed runtime namespace through the pinned expression composition', () => {
  const source = 'score >= 3 && runtime [ "pose.phase" ] == "completed"';
  const lowered = lowerDsl4RuntimeExpression(source);
  assert.equal(lowered.length, source.length);
  assert.match(lowered, /vars\["@r:pose\.phase"\]/u);

  const composition = createDsl4RuntimeStateExpressionComposition({
    composition: createRuntimeExpressionComposition(),
    enabled: true,
  });
  const snapshot = createDsl4RuntimeVariableSnapshot(
    {status: 'running', variables: {score: 3}},
    {poseState: {phase: 'completed'}, version: '4.0.0-test.1'},
  );
  assert.deepEqual(composition.validateConditionSyntax(source), {ok: true});
  assert.equal(composition.evaluateCondition(source, {score: 3}, snapshot), true);
  assert.deepEqual(composition.validateConditionSyntax('runtime["private"] == 1'), {
    ok: false,
    code: 'RUNTIME_EXPRESSION_UNKNOWN_RUNTIME_KEY',
    position: 0,
  });
  assert.throws(
    () => composition.evaluateCondition('runtime["private"] == 1', {}, snapshot),
    (error) => error.code === 'RUNTIME_EXPRESSION_UNKNOWN_RUNTIME_KEY',
  );
  composition.releaseAll();
});

test('production source validation gates and diagnoses the runtime namespace', async () => {
  const schema = JSON.parse(
    await readFile(new URL('../schema/dsl-4.schema.json', import.meta.url), 'utf8'),
  );
  const story = (condition) => `
kamishibai: '4.0'
branches:
  choice:
    - if: '${condition}'
      goto: ending
    - else: ending
scenes:
  opening:
    - branch: choice
  ending: []
`;
  const disabled = createDsl4ProductionSourceFrontend(schema).parse(
    story('runtime["status"] == "running"'),
  );
  assert.equal(disabled.ok, false);
  assert.equal(disabled.diagnostics[0].code, 'K4-EXPRESSION-SYNTAX-001');

  const enabledFrontend = createDsl4ProductionSourceFrontend(schema, {
    runtimeStateExpressionsEnabled: true,
  });
  assert.equal(enabledFrontend.parse(story('runtime["status"] == "running"')).ok, true);
  const unknown = enabledFrontend.parse(story('runtime["private"] == 1'));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.diagnostics[0].code, 'K4-EXPRESSION-RUNTIME-UNKNOWN');
});

test('maps an unknown runtime key without exposing the key or dependency message', () => {
  const sourceError = Object.assign(new Error('secret runtime key private'), {
    code: 'RUNTIME_EXPRESSION_UNKNOWN_RUNTIME_KEY',
  });
  const mapped = mapDsl4RuntimeExpressionError(sourceError, {
    storyPath: '/branches/choice/0/if',
    sourcePath: '$.branches.choice[0].if',
  });
  assert.equal(mapped.code, 'K4-EXPRESSION-RUNTIME-UNKNOWN');
  assert.equal(mapped.message, 'Runtime expression referenced an unknown runtime key');
  assert.equal(mapped.message.includes('private'), false);
});
