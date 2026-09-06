import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
  coerceDsl4StoryVariableBlockValue,
  createDsl4TurboWarpRuntimeVariableBlockSurface,
} from '../src/dsl4/platform/turbowarp-runtime-variable-block.js';
import {requireDefined} from './helpers/require-value.ts';

const Scratch = Object.freeze({
  ArgumentType: Object.freeze({NUMBER: 'number', STRING: 'string'}),
  BlockType: Object.freeze({BOOLEAN: 'boolean', COMMAND: 'command', REPORTER: 'reporter'}),
});

test('defines distinct feature-gated read and typed-write blocks', () => {
  const enabled = createDsl4TurboWarpRuntimeVariableBlockSurface(Scratch, {
    stateVisible: true,
    writeVisible: true,
  });
  assert.equal(enabled.blocks.length, 20);
  assert.equal(new Set(enabled.blocks.map(({opcode}) => opcode)).size, enabled.blocks.length);
  assert.ok(enabled.blocks.every(({hideFromPalette}) => hideFromPalette === false));
  assert.deepEqual(
    requireDefined(enabled.menus.dsl4StoryVariableTypes, 'the story variable types menu').items,
    ['string', 'number', 'boolean'],
  );

  const readOnly = createDsl4TurboWarpRuntimeVariableBlockSurface(Scratch, {
    stateVisible: true,
    writeVisible: false,
  });
  assert.equal(
    requireDefined(
      readOnly.blocks.find(({opcode}) => opcode === 'storyStatusReporter'),
      'the storyStatusReporter block',
    ).hideFromPalette,
    false,
  );
  assert.equal(
    requireDefined(
      readOnly.blocks.find(({opcode}) => opcode === 'setStoryVariable'),
      'the setStoryVariable block',
    ).hideFromPalette,
    true,
  );
  assert.throws(
    () =>
      createDsl4TurboWarpRuntimeVariableBlockSurface(Scratch, {
        stateVisible: false,
        writeVisible: true,
      }),
    /require the state surface/u,
  );
});

test('coerces only explicit finite primitive write values', () => {
  assert.deepEqual(coerceDsl4StoryVariableBlockValue(12, 'string'), {ok: true, value: '12'});
  assert.deepEqual(coerceDsl4StoryVariableBlockValue('2.5', 'number'), {
    ok: true,
    value: 2.5,
  });
  assert.deepEqual(coerceDsl4StoryVariableBlockValue('true', 'boolean'), {
    ok: true,
    value: true,
  });
  assert.equal(coerceDsl4StoryVariableBlockValue('yes', 'boolean').ok, false);
  assert.equal(coerceDsl4StoryVariableBlockValue('Infinity', 'number').ok, false);
  assert.equal(coerceDsl4StoryVariableBlockValue('x', 'unknown').ok, false);
});
