import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
  coerceDsl4StoryVariableBlockValue,
  createDsl4TurboWarpRuntimeVariableBlockSurface,
} from '../src/dsl4/platform/turbowarp-runtime-variable-block.js';

const Scratch = Object.freeze({
  ArgumentType: Object.freeze({NUMBER: 'number', STRING: 'string'}),
  BlockType: Object.freeze({BOOLEAN: 'boolean', COMMAND: 'command', REPORTER: 'reporter'}),
});

test('defines the read-only runtime state blocks', () => {
  const enabled = createDsl4TurboWarpRuntimeVariableBlockSurface(Scratch, {stateVisible: true});
  assert.equal(enabled.blocks.length, 17);
  assert.equal(new Set(enabled.blocks.map(({opcode}) => opcode)).size, enabled.blocks.length);
  assert.ok(enabled.blocks.every(({hideFromPalette}) => hideFromPalette === false));
  // Writing a story variable is a core action, so this surface publishes no write block.
  assert.equal(
    enabled.blocks.some(({opcode}) => opcode.startsWith('setStoryVariable')),
    false,
  );
  assert.deepEqual(enabled.menus, {});

  const hidden = createDsl4TurboWarpRuntimeVariableBlockSurface(Scratch, {stateVisible: false});
  assert.equal(hidden.blocks.length, 17);
  assert.ok(hidden.blocks.every(({hideFromPalette}) => hideFromPalette === true));
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
