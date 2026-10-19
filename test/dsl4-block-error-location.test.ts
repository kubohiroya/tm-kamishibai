import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4BlockErrorLocation} from '../src/dsl4/platform/block-error-location.js';
import type {
  Dsl4BlockErrorHost,
  Dsl4ErrorBlockly,
} from '../src/dsl4/platform/block-error-location.js';

function fixture(isStage = false) {
  const original = {opcode: 'control_repeat'};
  const calls: string[] = [];
  const parent = {
    type: 'scene',
    inputList: [],
    setCollapsed(value: boolean) {
      calls.push(`collapsed:${value}`);
    },
  };
  const block = {
    type: 'control_repeat',
    inputList: [{type: 1, fieldRow: [{getText: () => '回繰り返す'}]}],
    getParent: () => parent,
    select() {
      calls.push('selected');
    },
  };
  let live: typeof original | null = original;
  const target = {
    id: 'target',
    isOriginal: true,
    isStage,
    getName: () => (isStage ? 'Stage' : '案内役'),
    blocks: {getBlock: (id: string) => (id === 'bad' ? live : null)},
  };
  let visible = true;
  let rendered = false;
  let openCodeTab: (() => void) | undefined;
  const workspace = {
    getBlockById: (id: string) => (rendered && id === 'bad' ? block : null),
    centerOnBlock(id: string) {
      calls.push(`center:${id}`);
    },
    isVisible: () => visible,
    getInjectionDiv: () =>
      ({
        closest: () =>
          openCodeTab
            ? {
                getAttribute: () => 'code-tab',
                ownerDocument: {getElementById: () => ({click: () => openCodeTab?.()})},
              }
            : null,
      }) as unknown as HTMLElement,
  };
  const blocks: Dsl4ErrorBlockly = {INPUT_VALUE: 1, getMainWorkspace: () => workspace};
  const host: Dsl4BlockErrorHost = {
    gui: {getBlockly: async () => blocks},
    vm: {
      runtime: {targets: [target]},
      editingTarget: null,
      setEditingTarget(id) {
        calls.push(`target:${id}`);
        host.vm.editingTarget = target;
        setTimeout(() => {
          rendered = true;
        }, 0);
      },
    },
  };
  const error = {code: 'K4-BLOCK-SOURCE-GRAPH-001', targetName: target.getName(), blockId: 'bad'};
  return {
    host,
    blocks,
    error,
    calls,
    target,
    original,
    remove: () => {
      live = null;
    },
    replace: () => {
      live = {...original};
    },
    hide: () => {
      visible = false;
    },
    allowCodeTab: () => {
      openCodeTab = () => {
        calls.push('code-tab');
        visible = true;
      };
    },
  };
}

test('gives Japanese block and sprite names before Blockly is available', () => {
  const f = fixture();
  const location = createDsl4BlockErrorLocation(f.host, f.error, 'ja');
  assert.ok(location);
  assert.equal(location.blockName, '（）回繰り返す');
  assert.equal(location.targetName, '案内役');
  assert.equal(location.blockId, 'bad');
  assert.equal(location.canLocate, false);
  const stage = fixture(true);
  assert.equal(createDsl4BlockErrorLocation(stage.host, stage.error, 'ja')?.targetName, 'ステージ');
});

test('switches target, waits for rendering, expands parents and selects/centers the exact block', async () => {
  const f = fixture();
  const before = {...f.original};
  const location = createDsl4BlockErrorLocation(f.host, f.error, 'ja', f.blocks);
  assert.ok(location?.canLocate);
  assert.equal(await location.locate(), true);
  assert.deepEqual(f.calls, ['target:target', 'collapsed:false', 'selected', 'center:bad']);
  assert.deepEqual(f.original, before);
});

test('does not navigate to deleted, replaced or project-switched blocks', async () => {
  for (const mutate of ['remove', 'replace'] as const) {
    const f = fixture();
    const location = createDsl4BlockErrorLocation(f.host, f.error, 'ja', f.blocks)!;
    f[mutate]();
    assert.equal(await location.locate(), false);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  const location = createDsl4BlockErrorLocation(f.host, f.error, 'ja', f.blocks)!;
  f.host.vm.runtime = {targets: []};
  assert.equal(await location.locate(), false);
});

test('reports navigation failure when the code workspace is hidden', async () => {
  const f = fixture();
  f.hide();
  assert.equal(
    await createDsl4BlockErrorLocation(f.host, f.error, 'ja', f.blocks)!.locate(),
    false,
  );
  assert.ok(!f.calls.includes('selected'));
});

test('cancels a pending selection when its diagnostic has been replaced', async () => {
  const f = fixture();
  let active = true;
  const pending = createDsl4BlockErrorLocation(f.host, f.error, 'ja', f.blocks)!.locate(
    () => active,
  );
  active = false;
  assert.equal(await pending, false);
  assert.ok(!f.calls.includes('selected'));
});

test('opens the workspace code tab through its ARIA relationship before locating the block', async () => {
  const f = fixture();
  f.hide();
  f.allowCodeTab();
  assert.equal(await createDsl4BlockErrorLocation(f.host, f.error, 'ja', f.blocks)!.locate(), true);
  assert.deepEqual(f.calls, [
    'code-tab',
    'target:target',
    'collapsed:false',
    'selected',
    'center:bad',
  ]);
});

test('uses registered block labels without reading children and disposes its temporary workspace', () => {
  const f = fixture();
  f.original.opcode = 'looks_say';
  let disposed = false;
  const blocks: Dsl4ErrorBlockly = {
    ...f.blocks,
    Workspace: class {
      newBlock(opcode: string) {
        assert.equal(opcode, 'looks_say');
        return {type: opcode, inputList: [{type: 1, fieldRow: [{getText: () => 'と言う'}]}]};
      }
      dispose() {
        disposed = true;
      }
    },
  };
  const location = createDsl4BlockErrorLocation(f.host, f.error, 'ja', blocks)!;
  assert.equal(location.blockName, 'と言う （）');
  assert.equal(disposed, true);
  assert.deepEqual(f.calls, []);
});

test('keeps opcode fallback and diagnostic when a definition is unavailable', () => {
  const f = fixture();
  f.original.opcode = 'missing_extension';
  const blocks: Dsl4ErrorBlockly = {
    ...f.blocks,
    Workspace: class {
      newBlock(): never {
        throw new Error('Unknown definition');
      }
      dispose() {}
    },
  };
  assert.equal(
    createDsl4BlockErrorLocation(f.host, f.error, 'ja', blocks)?.blockName,
    'missing_extension',
  );
  assert.equal(createDsl4BlockErrorLocation(f.host, {...f.error, blockId: 'deleted'}, 'ja'), null);
  assert.equal(
    createDsl4BlockErrorLocation(f.host, {...f.error, code: 'K4-ASSET-001'}, 'ja'),
    null,
  );
});
