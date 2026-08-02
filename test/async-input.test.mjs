import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadAsyncInput() {
  const source = await readFile(
    new URL('../app/extensions/kubohiroyaasyncinput.js', import.meta.url),
    'utf8',
  );
  const variables = Object.create(null);
  const broadcasts = [];
  const canvasListeners = new Map();
  const windowListeners = new Map();
  const stage = {id: 'stage', isStage: true};
  const actor = {
    id: 'actor-right-door',
    isStage: false,
    drawableID: 7,
    lookupVariableByNameAndType: (name, type) =>
      name === 'actorName' && type === '' ? {value: 'RightDoor'} : undefined,
  };
  const canvas = {
    addEventListener: (name, listener) => canvasListeners.set(name, listener),
    removeEventListener: (name) => canvasListeners.delete(name),
    getBoundingClientRect: () => ({left: 0, top: 0, width: 480, height: 360}),
  };
  const runtimeListeners = new Map();
  const runtime = {
    ext_lmsTempVars2: {
      getRuntimeVariable: ({VAR}) => variables[VAR],
      runtimeVariableExists: ({VAR}) => Object.hasOwn(variables, VAR),
      setRuntimeVariable: ({VAR, STRING}) => {
        variables[VAR] = STRING;
      },
    },
    off: (name) => runtimeListeners.delete(name),
    on: (name, listener) => runtimeListeners.set(name, listener),
    renderer: {
      canvas,
      pick: () => actor.drawableID,
    },
    startHats: (opcode, fields) => broadcasts.push({opcode, fields}),
    targets: [stage, actor],
  };
  let extension;
  const Scratch = {
    ArgumentType: {NUMBER: 'number', STRING: 'string'},
    BlockType: {BOOLEAN: 'boolean', COMMAND: 'command'},
    extensions: {
      register: (registered) => {
        extension = registered;
      },
      unsandboxed: true,
    },
    translate: (value) => value,
    vm: {runtime},
  };
  const window = {
    addEventListener: (name, listener) => windowListeners.set(name, listener),
    removeEventListener: (name) => windowListeners.delete(name),
  };
  vm.runInNewContext(source, {console, Scratch, window}, {filename: 'kubohiroyaasyncinput.js'});
  return {
    actor,
    broadcasts,
    canvasListeners,
    extension,
    stage,
    variables,
  };
}

test('registers a stage-owned pointer binding for a named kamishibai actor', async () => {
  const state = await loadAsyncInput();
  assert(
    state.extension
      .getInfo()
      .blocks.some((block) => block.opcode === 'listenForActorTouchAndBroadcast'),
  );

  state.extension.listenForActorTouchAndBroadcast(
    {
      ACTOR: 'RightDoor',
      MESSAGE: 'stopTouchInput',
      RUNTIME_VAR: 'nextSceneLabel',
      VALUE: 'ocean',
    },
    {target: state.stage},
  );
  assert.equal(state.extension.touchBindings.get(state.actor.id).ownerTargetId, 'stage');

  state.canvasListeners.get('pointerdown')({
    button: 0,
    clientX: 120,
    clientY: 90,
  });
  assert.equal(state.variables.nextSceneLabel, 'ocean');
  assert.equal(state.broadcasts.at(-1).opcode, 'event_whenbroadcastreceived');
  assert.equal(state.broadcasts.at(-1).fields.BROADCAST_OPTION, 'stopTouchInput');

  state.extension.stopAllInputListeners({}, {target: state.stage});
  assert.equal(state.extension.touchBindings.size, 0);
  assert.equal(state.canvasListeners.has('pointerdown'), false);
});

test('rejects a touch binding for an unknown actor', async () => {
  const state = await loadAsyncInput();
  assert.throws(
    () =>
      state.extension.listenForActorTouchAndBroadcast(
        {
          ACTOR: 'MissingActor',
          MESSAGE: 'stopTouchInput',
          RUNTIME_VAR: 'nextSceneLabel',
          VALUE: 'missing',
        },
        {target: state.stage},
      ),
    /Actor not found: MissingActor/u,
  );
});
