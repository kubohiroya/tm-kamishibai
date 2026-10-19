import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {test} from 'vitest';

import {prepareDsl4EmbeddedBlockStoryProject} from '../src/dsl4/platform/embedded-block-story.js';
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

function targets(seconds: number) {
  return [
    {
      isStage: true,
      name: 'Stage',
      blocks: createDsl4StructuredBlockSourceDeclaration({
        source: {
          controls: {keymaps: {production: {Space: 'navigation.nextAction'}}},
          scenes: {opening: [{wait: seconds}]},
        },
        label: '',
        form: 'bundle',
        hatId: 'root',
        idPrefix: 'root-',
      }),
    },
  ];
}

function component(project: Record<string, unknown>) {
  const storage = requireRecord(project.extensionStorage, 'extension storage');
  const bundle = requireRecord(storage.kubohiroyakamishibai4, 'bundle');
  const components = requireRecord(bundle.components, 'components');
  return requireRecord(components.kubohiroyakamishibairuntime4, 'runtime component');
}

test('replaces the old distribution snapshot when embedded blocks change the story', async () => {
  const original = await prepareDsl4EmbeddedBlockStoryProject(
    {targets: targets(1)},
    frontend,
    options,
  );
  const originalStory = okResult(
    await loadDsl4RuntimeComponent(original, frontend, options),
    'the original block story',
  ).storyDocument;
  component(original).assetDistribution = {
    formatVersion: 1,
    profile: 'local',
    network: 'allowed',
    storyDocument: originalStory,
    assets: [],
    canonicalResolution: JSON.stringify({
      formatVersion: 1,
      profile: 'local',
      network: 'allowed',
      assets: [],
    }),
  };
  okResult(
    await loadDsl4RuntimeComponent(original, frontend, options),
    'a valid pre-existing distribution snapshot',
  );
  original.targets = targets(7);

  const prepared = await prepareDsl4EmbeddedBlockStoryProject(original, frontend, options);
  assert.equal(Object.hasOwn(component(prepared), 'assetDistribution'), false);
  assert.equal(Object.hasOwn(component(original), 'assetDistribution'), true);
  const loaded = okResult(
    await loadDsl4RuntimeComponent(prepared, frontend, options),
    'the edited blocks without the stale distribution snapshot',
  );
  const story = requireRecord(loaded.storyDocument, 'edited story');
  const scene = requireRecord(requireArray(story.scenes, 'scenes')[0], 'opening scene');
  const action = requireRecord(requireArray(scene.actions, 'actions')[0], 'wait action');
  assert.equal(action.command, 'wait');
  assert.equal(requireRecord(action.args, 'wait arguments').seconds, 7);
});
