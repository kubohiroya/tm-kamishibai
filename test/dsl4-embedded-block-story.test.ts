import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {test} from 'vitest';

import {
  hasDsl4EmbeddedBlockStory,
  prepareDsl4EmbeddedBlockStoryProject,
} from '../src/dsl4/platform/embedded-block-story.js';
import {loadDsl4RuntimeComponent} from '../src/dsl4/runtime-artifact-loader.js';
import {createDsl4StructuredBlockSourceDeclaration} from '../src/dsl4/structured-block-source.js';
import {dsl4TestSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';
import {okResult} from './helpers/result-outcome.ts';
import {requireArray, requireRecord} from './helpers/require-value.ts';

const options = {
  maxSourceBytes: 16384,
  maxAssetFiles: 10,
  maxTotalAssetBytes: 16384,
  subtleCrypto: webcrypto.subtle,
};

function blocks(label = '', value = 1) {
  return createDsl4StructuredBlockSourceDeclaration({
    source: {
      controls: {keymaps: {production: {Space: 'navigation.nextAction'}}},
      assets: {Cover: {kind: 'backdrop', name: 'Menu'}},
      cover: {backdrop: 'Cover'},
      scenes: {opening: [{wait: value}]},
    },
    label,
    form: 'bundle',
    hatId: 'root',
    idPrefix: 'root-',
  });
}

function project(declarations = blocks()) {
  return {
    targets: [{isStage: true, name: 'Stage', blocks: declarations}],
    extensionStorage: {
      otherExtension: {value: 'preserved'},
      kubohiroyakamishibai4: {
        components: {
          kubohiroyakamishibairuntime4: {application: {mode: 'menu'}, assets: {invalid: true}},
          otherComponent: {value: 'also preserved'},
        },
      },
    },
  };
}

async function loaded(input: Record<string, unknown>) {
  const prepared = await prepareDsl4EmbeddedBlockStoryProject(input, frontend, options);
  const result = okResult(
    await loadDsl4RuntimeComponent(prepared, frontend, options),
    'the compiled block component',
  );
  return {prepared, story: requireRecord(result.storyDocument, 'the current block story')};
}

test('compiles an empty-name root into the normal runtime component without changing the SB3', async () => {
  const input = project();
  const before = structuredClone(input);
  assert.equal(hasDsl4EmbeddedBlockStory(input), true);
  const {prepared, story} = await loaded(input);
  assert.deepEqual(input, before);
  const storage = requireRecord(prepared.extensionStorage, 'storage');
  const bundle = requireRecord(storage.kubohiroyakamishibai4, 'bundle');
  const components = requireRecord(bundle.components, 'components');
  assert.deepEqual(storage.otherExtension, {value: 'preserved'});
  assert.deepEqual(components.otherComponent, {value: 'also preserved'});
  assert.deepEqual(requireRecord(components.kubohiroyakamishibairuntime4, 'runtime').application, {
    mode: 'story',
  });
  assert.deepEqual(requireRecord(story.cover, 'cover').backdrop, 'Cover');
  const originalScene = JSON.stringify(story.scenes);
  const wait = Object.values(input.targets[0]!.blocks).find((block) =>
    block.opcode.endsWith('__wait'),
  );
  assert.ok(wait);
  wait.inputs.SECONDS = [1, [4, 7]];
  const edited = await loaded(input);
  assert.notEqual(JSON.stringify(edited.story.scenes), originalScene);
  assert.match(JSON.stringify(edited.story.scenes), /7/u);
});

test('resolves named includeBlocks from the empty-name root', async () => {
  const root = createDsl4StructuredBlockSourceDeclaration({
    source: {
      controls: {keymaps: {production: {Space: 'navigation.nextAction'}}},
      scenes: {opening: [{goto: 'ending'}]},
    },
    label: '',
    includeLabels: ['ending'],
    form: 'bundle',
    hatId: 'root',
    idPrefix: 'root-',
  });
  const module = createDsl4StructuredBlockSourceDeclaration({
    source: {scenes: {ending: [{wait: 0}]}},
    label: 'ending',
    form: 'bundle',
    hatId: 'module',
    idPrefix: 'module-',
  });
  const {story} = await loaded(project({...module, ...root}));
  assert.match(JSON.stringify(story.scenes), /ending/u);
  assert.equal(requireArray(story.scenes, 'scenes').length, 2);
});

test('does not reinterpret a named-only script as the root', async () => {
  const input = project(blocks('named'));
  assert.equal(hasDsl4EmbeddedBlockStory(input), true);
  await assert.rejects(prepareDsl4EmbeddedBlockStoryProject(input, frontend, options), {
    code: 'K4-BLOCK-SOURCE-MISSING-001',
  });
});

test('diagnoses broken blocks instead of using stale source or opening a file', async () => {
  const input = project();
  input.targets[0]!.blocks.root!.next = 'missing-block';
  await assert.rejects(prepareDsl4EmbeddedBlockStoryProject(input, frontend, options), {
    code: 'K4-BLOCK-SOURCE-GRAPH-001',
  });
});

test('leaves projects without block declarations on their existing startup path', async () => {
  const input = project({});
  assert.equal(hasDsl4EmbeddedBlockStory(input), false);
  assert.strictEqual(await prepareDsl4EmbeddedBlockStoryProject(input, frontend, options), input);
});

test('compiles only enabled section actions from the current project on each story start', async () => {
  const declarations = blocks();
  const scene = Object.entries(declarations).find(([, block]) => block.opcode.endsWith('_scene'))!;
  const [waitId, wait] = Object.entries(declarations).find(([, block]) =>
    block.opcode.endsWith('__wait'),
  )!;
  declarations.outsideWait = {
    ...structuredClone(wait),
    parent: 'section',
    inputs: {SECONDS: [1, [4, 43]]},
  };
  declarations.section = {
    opcode: 'kubohiroyakamishibaiauthoring4_useSection',
    next: 'outsideWait',
    parent: scene[0],
    inputs: {SUBSTACK: [2, waitId]},
    fields: {ENABLED: ['off', null]},
    shadow: false,
    topLevel: false,
  };
  wait.parent = 'section';
  scene[1].inputs.SUBSTACK = [2, 'section'];
  const input = project(declarations);
  const before = structuredClone(input);
  const off = await loaded(input);
  const sceneActions = (story: Record<string, unknown>) =>
    requireArray(
      requireRecord(requireArray(story.scenes, 'scenes')[0], 'opening').actions,
      'actions',
    ).map((action) => requireRecord(requireRecord(action, 'action').args, 'arguments').seconds);
  assert.deepEqual(sceneActions(off.story), [43]);
  assert.deepEqual(input, before);
  declarations.section.fields.ENABLED = ['on', null];
  assert.deepEqual(sceneActions((await loaded(input)).story), [1, 43]);
});
