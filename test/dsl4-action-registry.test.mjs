import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  createDsl4ActionRegistrySnapshot,
  createDsl4RuntimeController,
  createDsl4SourceFrontend,
  dsl4CoreActionNames,
  Dsl4ActionRegistryError,
  validateDsl4ActionRegistrySnapshot,
} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);

function registryEntry(name, parameters = []) {
  return {
    name,
    target: 'actor',
    parameters,
    source: {targetId: `target-${name}`, hatBlockId: `hat-${name}`},
  };
}

function assertDeepFrozen(value) {
  if (typeof value !== 'object' || value === null) return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

const registry = createDsl4ActionRegistrySnapshot([
  registryEntry('jumpTwice'),
  registryEntry('wave', [
    {name: 'speed', type: 'string'},
    {name: 'count', type: 'number', required: false},
  ]),
]);

test('creates a deterministic immutable Action Registry Snapshot', () => {
  assert.deepEqual(
    registry.actions.map(({name}) => name),
    ['jumpTwice', 'wave'],
  );
  assert.deepEqual(registry.actions[1].parameters, [
    {name: 'speed', type: 'string', required: true},
    {name: 'count', type: 'number', required: false},
  ]);
  assert.equal(registry.version, 2);
  assert.equal(registry.actions[0].quiesce, 'finish-only');
  assert.equal(registry.actions[1].quiesce, 'finish-only');
  assertDeepFrozen(registry);
  assert.deepEqual(validateDsl4ActionRegistrySnapshot(registry), registry);

  const legacy = JSON.parse(JSON.stringify(registry));
  legacy.version = 1;
  for (const action of legacy.actions) delete action.quiesce;
  assert.deepEqual(validateDsl4ActionRegistrySnapshot(legacy), registry);

  const replaySafe = createDsl4ActionRegistrySnapshot([
    {...registryEntry('replaySafe'), quiesce: 'cancel-replay-safe'},
  ]);
  assert.equal(replaySafe.actions[0].quiesce, 'cancel-replay-safe');
});

test('rejects invalid, colliding, duplicate, and non-canonical registrations', () => {
  const invalidEntries = [
    [{...registryEntry('wave'), unexpected: true}],
    [{...registryEntry('wave'), source: {...registryEntry('wave').source, unexpected: true}}],
    [registryEntry('bad name')],
    [registryEntry('e\u0301')],
    [registryEntry('wave'), registryEntry('wave')],
    [
      registryEntry('wave', [
        {name: 'speed', type: 'string'},
        {name: 'speed', type: 'number'},
      ]),
    ],
    [registryEntry('wave', [{name: 'speed', type: 'object'}])],
    [registryEntry('wave', [{name: 'speed', type: 'string', required: 'yes'}])],
    [{...registryEntry('wave'), quiesce: 'pause-anywhere'}],
  ];
  for (const entries of invalidEntries) {
    assert.throws(
      () => createDsl4ActionRegistrySnapshot(entries),
      (error) => error instanceof Dsl4ActionRegistryError && error.code.startsWith('K4-REGISTRY-'),
    );
  }
  for (const name of dsl4CoreActionNames) {
    assert.throws(
      () => createDsl4ActionRegistrySnapshot([registryEntry(name)]),
      (error) =>
        error instanceof Dsl4ActionRegistryError && error.code === 'K4-REGISTRY-COLLISION-001',
    );
  }

  const nonCanonical = JSON.parse(JSON.stringify(registry));
  nonCanonical.actions.reverse();
  assert.throws(
    () => validateDsl4ActionRegistrySnapshot(nonCanonical),
    (error) =>
      error instanceof Dsl4ActionRegistryError && error.code === 'K4-REGISTRY-SNAPSHOT-001',
  );

  const nonCanonicalQuiesce = JSON.parse(JSON.stringify(registry));
  delete nonCanonicalQuiesce.actions[0].quiesce;
  assert.throws(
    () => validateDsl4ActionRegistrySnapshot(nonCanonicalQuiesce),
    (error) =>
      error instanceof Dsl4ActionRegistryError && error.code === 'K4-REGISTRY-SNAPSHOT-001',
  );
});

const customStory = `
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
actors:
  Hero: HeroIdle
scenes:
  opening:
    - Hero.wave:
        stableId: firstWave
        arguments:
          speed: fast
          count: 3
`;

test('accepts registered custom actions and normalizes named arguments and Source Map', () => {
  const frontend = createDsl4SourceFrontend(schema, {actionRegistry: registry});
  const result = frontend.parse(customStory, {sourceId: 'custom.kamishibai.yaml'});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const action = result.storyDocument.scenes[0].actions[0];
  assert.deepEqual(action, {
    kind: 'Action',
    id: '/scenes/opening/actions/0',
    target: 'Hero',
    command: 'wave',
    args: {speed: 'fast', count: 3},
    handler: 'custom',
    stableId: 'firstWave',
    sourceRange: action.sourceRange,
  });
  assert.ok(result.storyDocument.sourceMap['/scenes/opening/actions/0/args/speed']);
  assert.ok(result.storyDocument.sourceMap['/scenes/opening/actions/0/args/count']);
  assert.ok(result.storyDocument.sourceMap['/scenes/opening/actions/0/stableId']);

  const noArguments = frontend.parse(`
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
actors:
  Hero: HeroIdle
scenes:
  opening:
    - Hero.jumpTwice: {}
`);
  assert.equal(noArguments.ok, true, JSON.stringify(noArguments.diagnostics));
  assert.deepEqual(noArguments.storyDocument.scenes[0].actions[0].args, {});
});

test('preserves a custom action parameter named transition', () => {
  const transitionRegistry = createDsl4ActionRegistrySnapshot([
    registryEntry('animate', [{name: 'transition', type: 'number'}]),
  ]);
  const frontend = createDsl4SourceFrontend(schema, {actionRegistry: transitionRegistry});
  const result = frontend.parse(`
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
actors: {Hero: HeroIdle}
scenes:
  opening:
    - Hero.animate:
        arguments: {transition: 1}
`);

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.storyDocument.scenes[0].actions[0].args, {transition: 1});
});

test('rejects unregistered commands, unknown parameters, missing parameters, and wrong types', async () => {
  const unregistered = createDsl4SourceFrontend(schema).parse(customStory);
  assert.equal(unregistered.ok, false);
  assert.ok(
    unregistered.diagnostics.some(
      ({code, storyPath}) =>
        code === 'K4-COMMAND-UNSUPPORTED' && storyPath === '/scenes/opening/actions/0',
    ),
  );

  const frontend = createDsl4SourceFrontend(schema, {actionRegistry: registry});
  const unknownSource = await readFile(
    path.join(
      projectRoot,
      'test',
      'fixtures',
      'dsl4',
      'invalid',
      'custom-action-unknown-key.kamishibai.yaml',
    ),
    'utf8',
  );
  const unknown = frontend.parse(unknownSource);
  assert.equal(unknown.ok, false);
  assert.ok(
    unknown.diagnostics.some(
      ({code, storyPath}) =>
        code === 'K4-SCHEMA-UNKNOWN-KEY' &&
        storyPath === '/scenes/opening/actions/0/args/repetitions',
    ),
  );

  const missing = frontend.parse(customStory.replace('          speed: fast\n', ''));
  assert.equal(missing.ok, false);
  assert.ok(missing.diagnostics.some(({message}) => message.includes('requires parameter speed')));

  const wrongType = frontend.parse(customStory.replace('speed: fast', 'speed: 1'));
  assert.equal(wrongType.ok, false);
  assert.ok(wrongType.diagnostics.some(({message}) => message.includes('speed must be string')));

  const unknownOuterKey = frontend.parse(
    customStory.replace('        stableId: firstWave\n', '        unexpected: true\n'),
  );
  assert.equal(unknownOuterKey.ok, false);
  assert.ok(unknownOuterKey.diagnostics.some(({code}) => code === 'K4-SCHEMA-UNKNOWN-KEY'));
});

test('dispatches custom actions through one fixed runtime port', async () => {
  const parsed = createDsl4SourceFrontend(schema, {actionRegistry: registry}).parse(customStory);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const calls = [];
  const controller = createDsl4RuntimeController({
    storyDocument: parsed.storyDocument,
    port: {
      async customAction(payload, context) {
        calls.push({payload, actionPath: context.actionPath});
      },
    },
  });
  const state = await controller.start();
  assert.equal(state.status, 'finished');
  assert.deepEqual(calls, [
    {
      payload: {
        name: 'wave',
        target: 'Hero',
        arguments: {speed: 'fast', count: 3},
      },
      actionPath: '/scenes/opening/actions/0',
    },
  ]);
});
