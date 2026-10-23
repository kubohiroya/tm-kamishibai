import assert from 'node:assert/strict';
import {test} from 'vitest';
import {stringify} from 'yaml';
import contract from './fixtures/dsl4/narrative-control-contract.json' with {type: 'json'};
import {createDsl4TestProductionSourceFrontend} from './helpers/dsl4-test-frontend.ts';
import {createDsl4RuntimeController} from '../src/dsl4/runtime-controller.js';
import {deferred} from './helpers/async-test-helpers.ts';
import {createDsl4KamishibaiStructuredDataSession} from '../src/dsl4/kamishibai-structured-data.js';

const frontend = createDsl4TestProductionSourceFrontend({narrativeControlEnabled: true});
function document(actions: unknown[], extra: Record<string, unknown> = {}) {
  const parsed = frontend.parse(
    stringify({kamishibai: '4.1', ...extra, scenes: {opening: actions}}),
  );
  assert(parsed.ok, JSON.stringify(parsed.diagnostics));
  return parsed.storyDocument;
}

test('4.1 is gated at parse and execution while existing 4.0 has unchanged semantics', () => {
  const off = createDsl4TestProductionSourceFrontend();
  const rejected = off.parse(contract.threeVisits.source);
  assert(!rejected.ok);
  assert.equal(rejected.diagnostics[0]!.code, 'K4-NARRATIVE-FLAG-001');
  const legacy = "kamishibai: '4.0'\nscenes: {opening: [{wait: 0}]}\n";
  assert.deepEqual(frontend.parse(legacy), off.parse(legacy));
  assert.throws(
    () => createDsl4RuntimeController({storyDocument: document([]), port: {}}),
    /dsl4NarrativeControl/,
  );
});

test('actual runtime plays the three visits and only each selected outcome', async () => {
  const parsed = frontend.parse(contract.threeVisits.source);
  assert(parsed.ok, JSON.stringify(parsed.diagnostics));
  const speech: unknown[] = [];
  const controller = createDsl4RuntimeController({
    storyDocument: parsed.storyDocument,
    narrativeControlEnabled: true,
    port: {
      say: (payload: Record<string, unknown>) => {
        speech.push(payload.text);
      },
    },
  });
  const result = await controller.start();
  assert.equal(result.status, 'finished', JSON.stringify(result.diagnostic));
  assert.deepEqual(speech, contract.threeVisits.expectedSpeech);
});

test('if evaluates once, commits typed variable writes, and never dispatches the unselected arm', async () => {
  const storyDocument = document(
    [
      {
        if: {
          condition: 'score > 0',
          then: [{setVariable: {name: 'score', value: 0}}, {wait: 1}],
          else: [{wait: 99}],
        },
      },
    ],
    {variables: {score: 1}},
  );
  const waits: unknown[] = [];
  let evaluations = 0;
  const controller = createDsl4RuntimeController({
    storyDocument,
    narrativeControlEnabled: true,
    port: {
      wait: (payload: Record<string, unknown>) => {
        waits.push(payload.seconds);
      },
    },
    evaluateCondition: (_expression, variables) => {
      evaluations += 1;
      return Number(variables.score) > 0;
    },
  });
  const result = await controller.start();
  assert.equal(result.status, 'finished', JSON.stringify(result.diagnostic));
  assert.deepEqual(waits, [1]);
  assert.equal(evaluations, 1);
  assert.deepEqual(result.variables, {score: 0});
});

test('zero-count bodies and unselected arms still use ordinary schema and expression validation', () => {
  for (const actions of [
    [{repeat: {times: 0, do: [{wait: 'bad'}]}}],
    [{if: {condition: false, then: [{unknownAction: 1}]}}],
    [{repeat: {times: 0, do: [{if: {condition: 'score ???', then: []}}]}}],
  ]) {
    const result = frontend.parse(stringify({kamishibai: '4.1', scenes: {opening: actions}}));
    assert(!result.ok, JSON.stringify(actions));
  }
});

test('goto abandons the rest of a repeated body and its remaining iterations', async () => {
  const parsed = frontend.parse(
    stringify({
      kamishibai: '4.1',
      scenes: {
        opening: [{repeat: {times: 3, do: [{wait: 1}, {goto: 'ending'}, {wait: 99}]}}],
        ending: [{wait: 2}],
      },
    }),
  );
  assert(parsed.ok, JSON.stringify(parsed.diagnostics));
  const waits: unknown[] = [];
  const controller = createDsl4RuntimeController({
    storyDocument: parsed.storyDocument,
    narrativeControlEnabled: true,
    port: {
      wait: (payload: Record<string, unknown>) => {
        waits.push(payload.seconds);
      },
    },
  });
  const result = await controller.start();
  assert.equal(result.status, 'finished', JSON.stringify(result.diagnostic));
  assert.deepEqual(waits, [1, 2]);
});

test('resume inside a previously selected arm restores its choice and iteration position', async () => {
  const storyDocument = document(
    [
      {
        repeat: {
          times: 2,
          as: 'round',
          do: [
            {if: {condition: 'changed', then: [{wait: {ref: 'round.number'}}], else: [{wait: 99}]}},
          ],
        },
      },
    ],
    {variables: {changed: false}},
  );
  const scene = (storyDocument.scenes as {actions: Record<string, unknown>[]}[])[0]!;
  const secondThen = scene.actions.findIndex(
    (action) => (action.args as {seconds?: number}).seconds === 2,
  );
  assert(secondThen >= 0);
  const waits: unknown[] = [];
  const controller = createDsl4RuntimeController({
    storyDocument,
    narrativeControlEnabled: true,
    port: {
      wait: (payload: Record<string, unknown>) => {
        waits.push(payload.seconds);
      },
    },
    evaluateCondition: () => {
      throw new Error('restored arm must not re-evaluate its earlier boundary');
    },
  });
  const result = await controller.start({actionIndex: secondThen});
  assert.equal(result.status, 'finished', JSON.stringify(result.diagnostic));
  assert.deepEqual(waits, [2]);
});

test('stop during an asynchronous condition prevents late dispatch and cleanup remains bounded', async () => {
  const storyDocument = document([{if: {condition: 'true', then: [{wait: 1}], else: [{wait: 2}]}}]);
  const condition = deferred<boolean>();
  const entered = deferred<void>();
  const waits: unknown[] = [];
  const controller = createDsl4RuntimeController({
    storyDocument,
    narrativeControlEnabled: true,
    port: {
      wait: (payload: Record<string, unknown>) => {
        waits.push(payload.seconds);
      },
    },
    evaluateCondition: () => {
      entered.resolve();
      return condition.promise;
    },
  });
  const running = controller.start();
  await entered.promise;
  controller.stop('test-stop');
  condition.resolve(true);
  const result = await running;
  assert.equal(result.status, 'stopped');
  assert.deepEqual(waits, []);
});

test('structured action iterator stays aligned while internal boundaries and false arms are skipped', async () => {
  const storyDocument = document([
    {if: {condition: false, then: [{wait: 99}], else: [{wait: 1}]}},
    {wait: 2},
  ]);
  const integration = createDsl4KamishibaiStructuredDataSession({storyDocument});
  const waits: unknown[] = [];
  const controller = createDsl4RuntimeController({
    storyDocument,
    structuredDataIntegration: integration,
    narrativeControlEnabled: true,
    port: {
      wait: (payload: Record<string, unknown>) => {
        waits.push(payload.seconds);
      },
    },
  });
  try {
    const result = await controller.start();
    assert.equal(result.status, 'finished', JSON.stringify(result.diagnostic));
    assert.deepEqual(waits, [1, 2]);
  } finally {
    integration.dispose();
  }
});

test('a condition from an abandoned generation cannot fail a restarted story', async () => {
  const storyDocument = document([{if: {condition: 'true', then: [{wait: 1}], else: [{wait: 2}]}}]);
  const oldCondition = deferred<boolean>();
  const oldEntered = deferred<void>();
  const newEntered = deferred<void>();
  const wait = deferred<void>();
  let count = 0;
  const controller = createDsl4RuntimeController({
    storyDocument,
    narrativeControlEnabled: true,
    port: {
      wait: () => {
        newEntered.resolve();
        return wait.promise;
      },
    },
    evaluateCondition: () => {
      if (count++ === 0) {
        oldEntered.resolve();
        return oldCondition.promise;
      }
      return false;
    },
  });
  const oldRun = controller.start();
  await oldEntered.promise;
  const newRun = controller.start();
  await newEntered.promise;
  oldCondition.resolve(true);
  await oldRun;
  assert.equal(controller.getState().status, 'running');
  wait.resolve();
  assert.equal((await newRun).status, 'finished');
});

test('logical expression strings retain their expression meaning and scalar references stay typed', async () => {
  const storyDocument = document(
    [{if: {condition: {all: ['score > 0', true]}, then: [{wait: 99}], else: [{wait: 1}]}}],
    {variables: {score: 0}},
  );
  const waits: unknown[] = [];
  const controller = createDsl4RuntimeController({
    storyDocument,
    narrativeControlEnabled: true,
    port: {
      wait: (payload: Record<string, unknown>) => {
        waits.push(payload.seconds);
      },
    },
    evaluateCondition: (expression, variables) => {
      assert(expression.includes('score > 0'));
      assert(!expression.includes('"score > 0"'));
      return Number(variables.score) > 0;
    },
  });
  assert.equal((await controller.start()).status, 'finished');
  assert.deepEqual(waits, [1]);
  const invalid = frontend.parse(
    stringify({
      kamishibai: '4.1',
      scenes: {
        opening: [
          {
            forEach: {
              as: 'row',
              items: [{text: 'true'}],
              do: [{if: {condition: {all: [{ref: 'row.text'}, true]}, then: []}}],
            },
          },
        ],
      },
    }),
  );
  assert(!invalid.ok);
});
