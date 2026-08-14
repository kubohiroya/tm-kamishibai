import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  createDsl4ActionContextTurboWarpSurface,
  createDsl4ActionInvocationAdapter,
  createDsl4ActionRegistrySnapshot,
  dsl4ActionContextBlockIconURI,
  dsl4ActionContextBlockBudget,
  dsl4ActionContextDefaultFeatureFlags,
  dsl4ActionContextManifest,
  resolveDsl4ActionContextFeatureFlags,
} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function fakeScratch() {
  const registered = [];
  const castInputs = [];
  return {
    Scratch: {
      extensions: {
        unsandboxed: true,
        register(extension) {
          registered.push(extension);
        },
      },
      BlockType: {
        HAT: 'hat',
        REPORTER: 'reporter',
        BOOLEAN: 'Boolean',
        COMMAND: 'command',
      },
      ArgumentType: {STRING: 'string'},
      Cast: {
        toString(value) {
          castInputs.push(value);
          return String(value ?? '');
        },
      },
    },
    registered,
    castInputs,
  };
}

function fakeAdapter(overrides = {}) {
  const calls = [];
  const adapter = {
    currentActionName(util) {
      calls.push(['currentActionName', util]);
      return 'wave';
    },
    currentActionTarget(util) {
      calls.push(['currentActionTarget', util]);
      return 'Hero';
    },
    currentActionHasArgument(name, util) {
      calls.push(['currentActionHasArgument', name, util]);
      return name === 'enabled';
    },
    currentActionArgument(name, util) {
      calls.push(['currentActionArgument', name, util]);
      return name === 'count' ? 0 : '';
    },
    completeCurrentAction(util) {
      calls.push(['completeCurrentAction', util]);
    },
    failCurrentAction(message, util) {
      calls.push(['failCurrentAction', message, util]);
    },
    gotoFromCurrentAction(scene, util) {
      calls.push(['gotoFromCurrentAction', scene, util]);
    },
    ...overrides,
  };
  return {adapter, calls};
}

test('freezes the exact Action Context developer palette and default-off flag', () => {
  assert.deepEqual(dsl4ActionContextDefaultFeatureFlags, {dsl4CustomActionsEnabled: false});
  assert.deepEqual(resolveDsl4ActionContextFeatureFlags(), dsl4ActionContextDefaultFeatureFlags);
  assert.deepEqual(resolveDsl4ActionContextFeatureFlags({dsl4CustomActionsEnabled: true}), {
    dsl4CustomActionsEnabled: true,
  });
  assert.throws(() => resolveDsl4ActionContextFeatureFlags({unknown: true}), /Unknown/u);
  assert.throws(
    () => resolveDsl4ActionContextFeatureFlags({dsl4CustomActionsEnabled: 1}),
    /must be boolean/u,
  );
  assert.deepEqual(dsl4ActionContextManifest, {
    version: 1,
    id: 'kubohiroyakamishibai4actioncontext',
    name: 'Kamishibai Action Context',
    blocks: [
      {
        opcode: 'whenCustomAction',
        blockType: 'HAT',
        text: 'when kamishibai custom action',
        arguments: {},
      },
      {
        opcode: 'currentActionName',
        blockType: 'REPORTER',
        text: 'current action name',
        arguments: {},
      },
      {
        opcode: 'currentActionTarget',
        blockType: 'REPORTER',
        text: 'current action target',
        arguments: {},
      },
      {
        opcode: 'currentActionHasArgument',
        blockType: 'BOOLEAN',
        text: 'current action has argument [NAME]?',
        arguments: {NAME: {type: 'STRING', defaultValue: 'name'}},
      },
      {
        opcode: 'currentActionArgument',
        blockType: 'REPORTER',
        text: 'current action argument [NAME]',
        arguments: {NAME: {type: 'STRING', defaultValue: 'name'}},
      },
      {
        opcode: 'completeCurrentAction',
        blockType: 'COMMAND',
        text: 'complete current action',
        arguments: {},
      },
      {
        opcode: 'failCurrentAction',
        blockType: 'COMMAND',
        text: 'fail current action [MESSAGE]',
        arguments: {MESSAGE: {type: 'STRING', defaultValue: 'failed'}},
      },
      {
        opcode: 'gotoFromCurrentAction',
        blockType: 'COMMAND',
        text: 'go to scene [SCENE] from current action',
        arguments: {SCENE: {type: 'STRING', defaultValue: 'scene'}},
      },
    ],
  });
  assert.equal(Object.isFrozen(dsl4ActionContextManifest), true);
  assert.equal(Object.isFrozen(dsl4ActionContextManifest.blocks), true);
  assert.equal(Object.isFrozen(dsl4ActionContextManifest.blocks[3].arguments.NAME), true);
  assert.deepEqual(dsl4ActionContextBlockBudget, {maximumOverheadBlocksPerHandler: 8});
});

test('keeps the surface inert while disabled without inspecting Scratch or the adapter', () => {
  const options = {featureFlags: {}};
  for (const name of ['Scratch', 'adapter', 'onError']) {
    Object.defineProperty(options, name, {
      get: () => assert.fail(`disabled surface inspected ${name}`),
    });
  }
  const surface = createDsl4ActionContextTurboWarpSurface(options);
  assert.equal(surface.extension, null);
  assert.equal(surface.manifest, dsl4ActionContextManifest);
  assert.deepEqual(surface.register(), {registered: false});
  assert.equal(Object.isFrozen(surface), true);
});

test('rejects sandboxed, incomplete, and malformed enabled boundaries before registration', () => {
  const {Scratch} = fakeScratch();
  const {adapter} = fakeAdapter();
  const enabled = {dsl4CustomActionsEnabled: true};
  const sandboxed = {...Scratch, extensions: {...Scratch.extensions, unsandboxed: false}};
  assert.throws(
    () =>
      createDsl4ActionContextTurboWarpSurface({
        Scratch: sandboxed,
        adapter,
        featureFlags: enabled,
      }),
    /unsandboxed/u,
  );
  assert.throws(
    () =>
      createDsl4ActionContextTurboWarpSurface({
        Scratch,
        adapter: {...adapter, currentActionArgument: null},
        featureFlags: enabled,
      }),
    /currentActionArgument/u,
  );
  assert.throws(
    () =>
      createDsl4ActionContextTurboWarpSurface({
        Scratch,
        adapter,
        featureFlags: enabled,
        onError: true,
      }),
    /onError/u,
  );
});

test('maps Scratch inputs and thread util to the adapter without casting typed outputs', () => {
  const {Scratch, registered, castInputs} = fakeScratch();
  const {adapter, calls} = fakeAdapter();
  const surface = createDsl4ActionContextTurboWarpSurface({
    Scratch,
    adapter,
    featureFlags: {dsl4CustomActionsEnabled: true},
  });
  const info = surface.extension.getInfo();
  const util = {thread: {id: 'thread'}};

  assert.equal(info.id, dsl4ActionContextManifest.id);
  assert.equal(info.blockIconURI, dsl4ActionContextBlockIconURI);
  const iconSvg = decodeURIComponent(
    dsl4ActionContextBlockIconURI.slice('data:image/svg+xml,'.length),
  );
  assert.match(iconSvg, /viewBox="0 0 64 64"/u);
  assert.match(iconSvg, /m29 37 14 7-14 7Z/u);
  assert.doesNotMatch(iconSvg, /<rect/u);
  assert.deepEqual(
    info.blocks.map(({opcode, blockType}) => [opcode, blockType]),
    dsl4ActionContextManifest.blocks.map(({opcode, blockType}) => [
      opcode,
      Scratch.BlockType[blockType],
    ]),
  );
  assert.equal(info.blocks[0].isEdgeActivated, false);
  assert.equal(info.blocks[1].disableMonitor, true);
  assert.equal(info.blocks[3].disableMonitor, undefined);
  assert.equal(surface.extension.whenCustomAction(), true);
  assert.equal(surface.extension.currentActionName({}, util), 'wave');
  assert.equal(surface.extension.currentActionTarget({}, util), 'Hero');
  assert.equal(surface.extension.currentActionHasArgument({NAME: 'enabled'}, util), true);
  assert.equal(surface.extension.currentActionArgument({NAME: 'count'}, util), 0);
  surface.extension.completeCurrentAction({}, util);
  surface.extension.failCurrentAction({MESSAGE: 404}, util);
  surface.extension.gotoFromCurrentAction({SCENE: 2}, util);

  assert.deepEqual(castInputs, ['enabled', 'count', 404, 2]);
  assert.deepEqual(calls, [
    ['currentActionName', util],
    ['currentActionTarget', util],
    ['currentActionHasArgument', 'enabled', util],
    ['currentActionArgument', 'count', util],
    ['completeCurrentAction', util],
    ['failCurrentAction', '404', util],
    ['gotoFromCurrentAction', '2', util],
  ]);
  assert.deepEqual(surface.register(), {registered: true});
  assert.deepEqual(surface.register(), {registered: false});
  assert.deepEqual(registered, [surface.extension]);
});

test('contains reporter context errors and retries registration after a host failure', () => {
  const observed = [];
  const {Scratch, registered} = fakeScratch();
  let attempts = 0;
  Scratch.extensions.register = (extension) => {
    attempts += 1;
    if (attempts === 1) throw new Error('injected registration failure');
    registered.push(extension);
  };
  const {adapter} = fakeAdapter({
    currentActionName() {
      throw new Error('private context details');
    },
  });
  const surface = createDsl4ActionContextTurboWarpSurface({
    Scratch,
    adapter,
    featureFlags: {dsl4CustomActionsEnabled: true},
    onError(error, context) {
      observed.push([error, context]);
      throw new Error('observer failure');
    },
  });

  assert.equal(surface.extension.currentActionName({}, {thread: {}}), '');
  assert.equal(observed.length, 1);
  assert.equal(observed[0][1].opcode, 'currentActionName');
  assert.equal(Object.isFrozen(observed[0][1]), true);
  assert.throws(() => surface.register(), /injected registration failure/u);
  assert.deepEqual(surface.register(), {registered: true});
  assert.deepEqual(surface.register(), {registered: false});
  assert.equal(attempts, 2);
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {promise, resolve};
}

test('distinguishes omitted optional arguments from false, zero, and an empty string end to end', async () => {
  const registration = createDsl4ActionRegistrySnapshot([
    {
      name: 'wave',
      target: 'actor',
      parameters: [
        {name: 'label', type: 'string'},
        {name: 'count', type: 'number', required: false},
        {name: 'enabled', type: 'boolean', required: false},
        {name: 'caption', type: 'string', required: false},
      ],
      source: {targetId: 'target', hatBlockId: 'hat'},
    },
  ]);
  const completion = deferred();
  const thread = {id: 'primary'};
  const adapter = createDsl4ActionInvocationAdapter({
    registrySnapshot: registration,
    storyDocument: {
      kind: 'StoryDocument',
      version: '4.0',
      scenes: [{id: 'opening', actions: []}],
    },
    runtimeGeneration: 1,
    customActionTimeoutMs: 1_000,
    threadHost: {
      start() {
        return [thread];
      },
      waitForCompletion() {
        return completion.promise;
      },
      stop() {
        completion.resolve();
      },
    },
  });
  const {Scratch} = fakeScratch();
  const surface = createDsl4ActionContextTurboWarpSurface({
    Scratch,
    adapter,
    featureFlags: {dsl4CustomActionsEnabled: true},
  });
  const result = adapter.customAction(
    {
      name: 'wave',
      target: 'Hero',
      arguments: {label: '', count: 0, enabled: false},
    },
    {
      actionPath: '/scenes/opening/actions/0',
      signal: new AbortController().signal,
      structuredData: {actionScopeRef: '@scope', actionViewRef: '@action'},
    },
  );
  const util = {thread};

  assert.equal(surface.extension.currentActionHasArgument({NAME: 'label'}, util), true);
  assert.equal(surface.extension.currentActionArgument({NAME: 'label'}, util), '');
  assert.equal(surface.extension.currentActionHasArgument({NAME: 'count'}, util), true);
  assert.equal(surface.extension.currentActionArgument({NAME: 'count'}, util), 0);
  assert.equal(surface.extension.currentActionHasArgument({NAME: 'enabled'}, util), true);
  assert.equal(surface.extension.currentActionArgument({NAME: 'enabled'}, util), false);
  assert.equal(surface.extension.currentActionHasArgument({NAME: 'caption'}, util), false);
  assert.equal(surface.extension.currentActionArgument({NAME: 'caption'}, util), '');

  surface.extension.completeCurrentAction({}, util);
  assert.deepEqual(await result, {outcome: 'completed'});
  await adapter.dispose();
});

test('keeps every fixture handler within the eight-block Kamishibai overhead budget', async () => {
  const fixture = JSON.parse(
    await readFile(
      path.join(projectRoot, 'test', 'fixtures', 'dsl4', 'custom-action-block-budget.json'),
      'utf8',
    ),
  );
  const contextOpcodes = new Set(
    dsl4ActionContextManifest.blocks.map((definition) => definition.opcode),
  );
  assert.equal(fixture.version, 1);
  assert.deepEqual(
    fixture.handlers.map(({name}) => name),
    [
      'implicit-no-argument',
      'target-reporter',
      'required-argument',
      'optional-argument',
      'explicit-complete',
      'explicit-fail',
      'explicit-goto',
    ],
  );

  for (const handler of fixture.handlers) {
    const contextBlocks = handler.blocks.filter(({opcode}) => contextOpcodes.has(opcode));
    const overhead = handler.blocks.filter(({role}) => role !== 'performance');
    assert.equal(contextBlocks[0]?.opcode, 'whenCustomAction', handler.name);
    assert.equal(
      contextBlocks.every(({role}) => role !== 'performance'),
      true,
      handler.name,
    );
    assert.equal(overhead.length, handler.expectedOverhead, handler.name);
    assert.ok(
      overhead.length <= dsl4ActionContextBlockBudget.maximumOverheadBlocksPerHandler,
      handler.name,
    );
    assert.equal(
      handler.blocks.some(({opcode}) =>
        /(?:register|temporary|waitUntilComplete|releaseScope|jsonPath|iterator)/iu.test(opcode),
      ),
      false,
      handler.name,
    );
  }
});
