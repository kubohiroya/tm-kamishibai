import assert from 'node:assert/strict';
import {test} from 'vitest';
import {parse} from 'yaml';
import contract from './fixtures/dsl4/narrative-control-contract.json' with {type: 'json'};
import {
  compileDsl4NarrativeSource,
  Dsl4NarrativeControlError,
} from '../src/dsl4/narrative-control.js';

const story = (actions: unknown[]) => ({kamishibai: '4.0', scenes: {opening: actions}});
const compile = (actions: unknown[]) => compileDsl4NarrativeSource(story(actions));

test('three visits retain both arms, typed row values, source positions and deterministic iteration identities', () => {
  const input = parse(contract.threeVisits.source);
  const original = structuredClone(input);
  const result = compileDsl4NarrativeSource(input);
  const sequence = (result.story.scenes as Record<string, Record<string, unknown>[]>).visits!;
  assert.deepEqual(
    sequence.flatMap((action) =>
      action['Narrator.say'] ? [(action['Narrator.say'] as {text: string}).text] : [],
    ),
    ['長兄', '贈り物', '何もなし', '次兄', '贈り物', '何もなし', '末弟', '贈り物', '何もなし'],
  );
  assert.deepEqual(
    result.origins.visits!.flatMap((origin) =>
      origin.decision ? [origin.decision.condition] : [],
    ),
    [false, false, true],
  );
  const speechOrigins = result.origins.visits!.filter((_, i) => sequence[i]!['Narrator.say']);
  assert.deepEqual(
    speechOrigins.filter((_, i) => i % 3 === 0).map((origin) => origin.frames[0]!.number),
    [1, 2, 3],
  );
  assert.deepEqual(speechOrigins[1]!.path, [
    'scenes',
    'visits',
    0,
    'forEach',
    'do',
    1,
    'if',
    'then',
    0,
  ]);
  assert.deepEqual(input, original);
  assert.deepEqual(compileDsl4NarrativeSource(input), result);
});

test('zero iterations validate bodies but never add their actions to execution', () => {
  const result = compile([
    {repeat: {times: 0, as: 'round', do: [{wait: {ref: 'round.number'}}]}},
    {wait: 2},
  ]);
  assert.deepEqual((result.story.scenes as Record<string, unknown>).opening, [
    {wait: 0},
    {wait: 2},
  ]);
  assert(result.validation.opening!.some(({action}) => action.wait === 1));
  assert.throws(
    () => compile([{repeat: {times: 0, do: [{wait: {ref: 'missing.value'}}]}}]),
    /Unknown narrative reference/,
  );
});

test('empty items allow no-op bodies and reject unknowable column references', () => {
  assert.doesNotThrow(() => compile([{forEach: {as: 'row', items: [], do: []}}]));
  assert.throws(
    () => compile([{forEach: {as: 'row', items: [], do: [{wait: {ref: 'row.duration'}}]}}]),
    /Unknown narrative reference/,
  );
});

test('nested repeat resolves lexical scopes and gives repeated stable IDs distinct values', () => {
  const result = compile([
    {
      repeat: {
        times: 2,
        as: 'outer',
        do: [
          {
            repeat: {
              times: 2,
              as: 'inner',
              do: [{wait: {seconds: {ref: 'outer.number'}, stableId: 'pause'}}],
            },
          },
        ],
      },
    },
  ]);
  const sequence = (result.story.scenes as Record<string, Record<string, unknown>[]>).opening!;
  const waits = sequence.flatMap((action) =>
    typeof action.wait === 'object' ? [action.wait as {seconds: number; stableId: string}] : [],
  );
  assert.deepEqual(
    waits.map((args) => args.seconds),
    [1, 1, 2, 2],
  );
  assert.equal(new Set(waits.map((args) => args.stableId)).size, 4);
});

test('all rows and unselected arms are checked rather than silently discarded', () => {
  for (const items of [
    [{value: 1}, {value: 'bad'}],
    [{value: true}, {other: true}],
    [{value: Infinity}],
  ]) {
    assert.throws(
      () => compile([{forEach: {as: 'row', items, do: []}}]),
      Dsl4NarrativeControlError,
    );
  }
  assert.throws(
    () => compile([{if: {condition: false, then: [{wait: {ref: 'unknown.value'}}]}}]),
    /Unknown narrative reference/,
  );
  assert.throws(
    () =>
      compile([
        {
          forEach: {
            as: 'row',
            items: [{value: 'true'}],
            do: [{if: {condition: {ref: 'row.value'}, then: []}}],
          },
        },
      ]),
    /must be boolean/,
  );
  assert.throws(
    () => compile([{repeat: {times: 2, do: [], unexpected: true}}]),
    /Unknown narrative field/,
  );
});

test('iteration and expansion limits reject explosive input before producing expanded sequences', () => {
  for (const times of [-1, 0.5, 1025, Infinity]) {
    assert.throws(
      () => compile([{repeat: {times, do: []}}]),
      (error: unknown) =>
        error instanceof Dsl4NarrativeControlError && error.code === 'K4-NARRATIVE-LIMIT-001',
    );
  }
  assert.throws(
    () => compile([{repeat: {times: 1024, do: [{repeat: {times: 1024, do: [{wait: 0}]}}]}}]),
    /Expanded action count/,
  );
  let nested: unknown[] = [];
  for (let depth = 0; depth < 17; depth += 1) nested = [{repeat: {times: 0, do: nested}}];
  assert.throws(() => compile(nested), /nesting/);
});

test('host policy may lower but never raise narrative iteration limits', () => {
  assert.throws(
    () => compileDsl4NarrativeSource(story([{repeat: {times: 2, do: []}}]), {maxIterations: 1}),
    /Iteration count/,
  );
  assert.throws(() => compileDsl4NarrativeSource(story([]), {maxIterations: 1025}), /only lower/);
});
