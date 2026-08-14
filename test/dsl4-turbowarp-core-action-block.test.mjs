import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {dsl4CoreActionManifest} from '../src/dsl4/core-action-manifest.js';
import {
  createDsl4TurboWarpCoreActionBlockAdapter,
  createDsl4TurboWarpCoreActionBlockSurface,
  dsl4TurboWarpCoreActionBlockSpecs,
} from '../src/dsl4/platform/turbowarp-core-action-block.js';

const schema = JSON.parse(
  await readFile(new URL('../schema/dsl-4.schema.json', import.meta.url), 'utf8'),
);
const Scratch = Object.freeze({
  ArgumentType: Object.freeze({NUMBER: 'number', STRING: 'string'}),
  BlockType: Object.freeze({COMMAND: 'command'}),
});

test('defines one distinct public block for every manifest core action', () => {
  const commands = dsl4CoreActionManifest.map(({command}) => command);
  assert.deepEqual(
    dsl4TurboWarpCoreActionBlockSpecs.map(({command}) => command),
    commands,
  );
  assert.equal(new Set(commands).size, 23);

  const enabled = createDsl4TurboWarpCoreActionBlockSurface(Scratch, {visible: true});
  assert.deepEqual(
    enabled.blocks.map(({opcode}) => opcode),
    commands,
  );
  assert.ok(enabled.blocks.every(({blockType}) => blockType === Scratch.BlockType.COMMAND));
  assert.ok(enabled.blocks.every((definition) => !Object.hasOwn(definition, 'hideFromPalette')));
  assert.ok(enabled.blocks.every(({opcode}) => opcode !== 'runActionJson'));
  assert.equal(Object.isFrozen(enabled), true);
  assert.equal(Object.isFrozen(enabled.blocks), true);

  const disabled = createDsl4TurboWarpCoreActionBlockSurface(Scratch);
  assert.ok(disabled.blocks.every(({hideFromPalette}) => hideFromPalette === true));
  assert.deepEqual(enabled.menus.dsl4TransitionEffect.items, [
    'fadeOut',
    'fadeUp',
    'fadeToWhite',
    'fadeFromWhite',
    'reset',
  ]);
  assert.deepEqual(enabled.menus.dsl4MoveEasing.items, [
    'linear',
    'easeIn',
    'easeOut',
    'easeInOut',
  ]);
});

test('normalizes all 23 block inputs through their manifest Schema definitions', () => {
  const adapter = createDsl4TurboWarpCoreActionBlockAdapter(schema);
  const cases = [
    ['stage', {BACKDROP: 'Beach'}, null, {backdrop: 'Beach'}],
    ['bgm', {SOUND: 'Music'}, null, {sound: 'Music'}],
    ['sound', {SOUND: 'Effect'}, null, {sound: 'Effect'}],
    ['wait', {SECONDS: '1.5'}, null, {seconds: 1.5}],
    ['debugger', {}, null, {}],
    ['broadcastMessageAndWait', {MESSAGE: 'receiver'}, null, {message: 'receiver'}],
    ['transition', {EFFECT: 'fadeOut', SECONDS: 0.5}, null, {effect: 'fadeOut', seconds: 0.5}],
    ['goto', {SCENE: 'ending'}, null, {scene: 'ending'}],
    ['branch', {BRANCH: 'choice'}, null, {branch: 'choice'}],
    ['keyInputToChangeScene', {ROUTES: '{"Space":"ending"}'}, null, {routes: {Space: 'ending'}}],
    ['touchInputToChangeScene', {ROUTES: '{"Hero":"ending"}'}, null, {routes: {Hero: 'ending'}}],
    ['poseInputToChangeScene', {ROUTES: '{"help":"ending"}'}, null, {routes: {help: 'ending'}}],
    [
      'show',
      {TARGET: 'Hero', SKIN: 'HeroIdle', X: '10', Y: -20, SCALE: 80},
      'Hero',
      {skin: 'HeroIdle', x: 10, y: -20, scale: 80},
    ],
    ['hide', {TARGET: 'Hero'}, 'Hero', {}],
    ['setTransparency', {TARGET: 'Hero', SPEC: '50'}, 'Hero', {transparency: 50}],
    [
      'moveTo',
      {TARGET: 'Hero', X: 1, Y: 2, SECONDS: 3, EASING: 'easeInOut'},
      'Hero',
      {x: 1, y: 2, seconds: 3, easing: 'easeInOut'},
    ],
    [
      'say',
      {
        TARGET: 'Hero',
        SPEC: '{"text":"hello","seconds":1,"styles":["novel"],"stableId":"speech-1"}',
      },
      'Hero',
      {text: 'hello', seconds: 1, styles: ['novel']},
    ],
    [
      'think',
      {TARGET: 'Hero', SPEC: '{"text":"hmm","waitFor":"advance"}'},
      'Hero',
      {text: 'hmm', waitFor: 'advance'},
    ],
    ['setSkin', {TARGET: 'Hero', SKIN: 'HeroHappy', SCALE: ''}, 'Hero', {skin: 'HeroHappy'}],
    ['setLayer', {TARGET: 'Hero', LAYER: '-2'}, 'Hero', {layer: -2}],
    [
      'loop',
      {TARGET: 'Hero', STEPS: '[{"skin":"HeroIdle","seconds":1}]'},
      'Hero',
      {steps: [{skin: 'HeroIdle', seconds: 1}]},
    ],
    [
      'setText',
      {TARGET: 'Caption', TEXT: 'title', STYLE: 'heading'},
      'Caption',
      {text: 'title', style: 'heading'},
    ],
    [
      'pose',
      {
        TARGET: 'Hero',
        STEPS: '[{"pose":"help","skin":"HeroHappy","sound":"Effect"}]',
      },
      'Hero',
      {steps: [{pose: 'help', skin: 'HeroHappy', sound: 'Effect'}]},
    ],
  ];

  assert.equal(cases.length, 23);
  for (const [command, input, target, args] of cases) {
    assert.deepEqual(adapter.createAction(command, input), {
      target,
      command,
      args,
      handler: 'core',
    });
  }

  assert.deepEqual(
    adapter.createAction('setTransparency', {
      TARGET: 'Hero',
      SPEC: '{"from":0,"to":100,"seconds":1,"background":true}',
    }).args,
    {from: 0, to: 100, seconds: 1, background: true},
  );
  assert.deepEqual(
    adapter.createAction('setSkin', {TARGET: 'Hero', SKIN: 'HeroHappy', SCALE: '75'}).args,
    {skin: 'HeroHappy', scale: 75},
  );
  assert.deepEqual(adapter.createAction('setLayer', {TARGET: 'Hero', LAYER: 'front'}).args, {
    layer: 'front',
  });
});

test('fails closed for malformed, unsafe, excessive, or Schema-invalid block inputs', () => {
  const adapter = createDsl4TurboWarpCoreActionBlockAdapter(schema, {
    maxJsonCharacters: 128,
    maxJsonDepth: 4,
    maxJsonNodes: 16,
  });
  const rejects = [
    () => adapter.createAction('unknown', {}),
    () => adapter.createAction('wait', {SECONDS: Number.NaN}),
    () => adapter.createAction('wait', {SECONDS: 1, EXTRA: true}),
    () => adapter.createAction('show', {TARGET: 'Hero', SKIN: 'Skin', X: 0, Y: 0, SCALE: 0}),
    () => adapter.createAction('say', {TARGET: 'Hero', SPEC: '{"text":"missing wait"}'}),
    () => adapter.createAction('keyInputToChangeScene', {ROUTES: '[]'}),
    () => adapter.createAction('keyInputToChangeScene', {ROUTES: '{'}),
    () =>
      adapter.createAction('keyInputToChangeScene', {
        ROUTES: '{"__proto__":{"scene":"ending"}}',
      }),
    () =>
      adapter.createAction('keyInputToChangeScene', {
        ROUTES: '{"Space":"' + 'x'.repeat(128) + '"}',
      }),
    () =>
      adapter.createAction('keyInputToChangeScene', {
        ROUTES: '{"a":{"b":{"c":{"d":{"e":"ending"}}}}}',
      }),
  ];

  for (const reject of rejects) {
    assert.throws(reject, (error) => /^K4-BLOCK-ACTION/u.test(error.code));
  }
  assert.throws(
    () => createDsl4TurboWarpCoreActionBlockAdapter(schema, {maxJsonNodes: 1_025}),
    TypeError,
  );
  assert.throws(
    () => createDsl4TurboWarpCoreActionBlockAdapter(schema, {unknown: true}),
    TypeError,
  );
});
