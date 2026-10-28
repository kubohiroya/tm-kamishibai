import assert from 'node:assert/strict';
import {test} from 'vitest';
import {dsl4TestProductionSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';
import {definitionRecord} from '../src/dsl4/definition-references.js';
import {bindDsl4ProjectSourceFrontend} from '../src/dsl4/source-frontend.js';

export const implicitAssetProject = {
  targets: [
    {
      isStage: true,
      name: 'Stage',
      costumes: [{name: 'Same', bitmapResolution: 2}],
      sounds: [{name: 'Same'}],
    },
    {
      isStage: false,
      name: 'Cat',
      currentCostume: 0,
      costumes: [{name: 'Same'}, {name: 'Walk'}],
      sounds: [{name: 'Meow'}],
    },
    {isStage: false, name: 'Dog', costumes: [{name: 'Same'}], sounds: [{name: 'Woof'}]},
  ],
};

function parse(story: Record<string, unknown>, project: unknown = implicitAssetProject) {
  return frontend.parse(JSON.stringify({kamishibai: '4.0', ...story}), {project});
}

test('resolves undeclared actors, costumes, backdrops and sounds in a concrete SB3 without name collisions', () => {
  const result = parse({
    scenes: {
      opening: [
        {stage: 'Same'},
        {'Cat.show': {skin: 'Same', x: 0, y: 0, scale: 100}},
        {'Dog.show': {skin: 'Same', x: 0, y: 0, scale: 100}},
        {sound: 'Same'},
        {sound: 'Meow'},
      ],
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  if (!result.ok) return;
  const assets = definitionRecord(result.storyDocument.assets);
  assert.equal(Object.keys(assets).length, 5);
  assert.equal(
    Object.values(assets).filter((asset) => definitionRecord(asset).kind === 'costume').length,
    2,
  );
  assert.deepEqual(Object.keys(definitionRecord(result.storyDocument.actors)), ['Cat', 'Dog']);
  const meow = Object.values(assets)
    .map(definitionRecord)
    .find((asset) => asset.name === 'Meow');
  assert.equal(meow?.target, 'Cat');
  assert.equal(
    Object.values(assets)
      .map(definitionRecord)
      .find((asset) => asset.kind === 'backdrop')?.bitmapResolution,
    2,
  );
  assert.deepEqual(
    result,
    parse({
      scenes: {
        opening: [
          {stage: 'Same'},
          {'Cat.show': {skin: 'Same', x: 0, y: 0, scale: 100}},
          {'Dog.show': {skin: 'Same', x: 0, y: 0, scale: 100}},
          {sound: 'Same'},
          {sound: 'Meow'},
        ],
      },
    }),
  );
});

test('keeps explicit asset definitions and actor aliases ahead of implicit names', () => {
  const result = parse({
    assets: {Same: {kind: 'backdrop', name: 'Explicit'}},
    scenes: {opening: [{stage: 'Same'}]},
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  if (result.ok)
    assert.equal(
      definitionRecord(definitionRecord(result.storyDocument.assets).Same).name,
      'Explicit',
    );
  const wrongKind = parse({assets: {Same: 'sound'}, scenes: {opening: [{stage: 'Same'}]}});
  assert.equal(wrongKind.ok, false);
  assert.equal(wrongKind.diagnostics[0]?.code, 'K4-REF-002');
});

test('rejects missing, wrong-owner, duplicate and ambiguous project assets', () => {
  for (const story of [
    {scenes: {opening: [{stage: 'Missing'}]}},
    {scenes: {opening: [{'Dog.show': {skin: 'Walk', x: 0, y: 0, scale: 100}}]}},
    {scenes: {opening: [{'Ghost.show': {skin: 'Same', x: 0, y: 0, scale: 100}}]}},
  ]) {
    const result = parse(story);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]?.code, 'K4-PROJECT-REF-001');
  }
  const duplicate = structuredClone(implicitAssetProject);
  duplicate.targets[0]!.costumes.push({name: 'Same', bitmapResolution: 1});
  assert.equal(parse({scenes: {opening: [{stage: 'Same'}]}}, duplicate).ok, false);
  const ambiguous = structuredClone(implicitAssetProject);
  ambiguous.targets[2]!.sounds.push({name: 'Meow'});
  assert.equal(parse({scenes: {opening: [{sound: 'Meow'}]}}, ambiguous).ok, false);
});

test('resolves every branch and typed forEach reference without changing the authored source', () => {
  const result = parse({
    scenes: {
      opening: [
        {
          if: {
            condition: false,
            then: [{'Cat.show': {skin: 'Walk', x: 0, y: 0, scale: 100}}],
            else: [{stage: 'Same'}],
          },
        },
        {
          forEach: {
            as: 'row',
            items: [
              {skin: 'Walk', x: 0, y: 0, scale: 100},
              {skin: 'Same', x: 0, y: 0, scale: 100},
            ],
            do: [{'Cat.show': {skin: {ref: 'row.skin'}, x: 0, y: 0, scale: 100}}],
          },
        },
      ],
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  if (result.ok) {
    assert.ok(result.canonicalSource.includes('forEach'));
    assert.ok(
      Object.values(definitionRecord(result.storyDocument.assets)).some(
        (asset) => definitionRecord(asset).name === 'Walk',
      ),
    );
  }
});

test('does not relax context-free validation or mutate the project', () => {
  const original = structuredClone(implicitAssetProject);
  const result = frontend.parse("kamishibai: '4.0'\nscenes:\n  opening:\n    - stage: Same\n");
  assert.equal(result.ok, false);
  parse({scenes: {opening: [{stage: 'Same'}]}});
  assert.deepEqual(implicitAssetProject, original);
});

test('defaults cover to the first Stage backdrop and sound and defaults startSceneIndex to one', () => {
  const result = parse({scenes: {opening: [{wait: 0}]}});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(definitionRecord(result.storyDocument.variables).startSceneIndex, 1);
  const cover = definitionRecord(result.storyDocument.cover);
  const assets = definitionRecord(result.storyDocument.assets);
  assert.equal(definitionRecord(assets[String(cover.backdrop)]).name, 'Same');
  assert.equal(definitionRecord(assets[String(cover.bgm)]).kind, 'sound');
  const explicit = parse({
    cover: {backdrop: 'Same'},
    variables: {startSceneIndex: 3},
    scenes: {opening: [{wait: 0}]},
  });
  assert.equal(explicit.ok, true);
  if (explicit.ok) {
    assert.equal(definitionRecord(explicit.storyDocument.variables).startSceneIndex, 3);
    assert.equal(definitionRecord(explicit.storyDocument.cover).bgm, undefined);
  }
  const noSound = parse(
    {scenes: {opening: [{wait: 0}]}},
    {
      targets: [
        {isStage: true, name: 'Stage', costumes: [{name: 'First'}, {name: 'Second'}], sounds: []},
      ],
    },
  );
  assert.equal(noSound.ok, true);
  if (noSound.ok) assert.equal(definitionRecord(noSound.storyDocument.cover).bgm, undefined);
  const noMedia = parse(
    {scenes: {opening: [{wait: 0}]}},
    {targets: [{isStage: true, name: 'Stage', costumes: [], sounds: []}]},
  );
  assert.equal(noMedia.ok, true);
  if (noMedia.ok) assert.equal(noMedia.storyDocument.cover, null);
  const contextFree = frontend.parse(
    JSON.stringify({kamishibai: '4.0', scenes: {opening: [{wait: 0}]}}),
  );
  if (contextFree.ok)
    assert.equal(definitionRecord(contextFree.storyDocument.variables).startSceneIndex, 1);
});

test('an undeclared actor starts on its same-name sprite first costume regardless of currentCostume', () => {
  const project = structuredClone(implicitAssetProject);
  project.targets[1]!.currentCostume = 1;
  const result = parse({scenes: {opening: [{'Cat.hide': {}}]}}, project);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  if (result.ok) {
    const actorAsset = definitionRecord(result.storyDocument.actors).Cat;
    assert.equal(
      definitionRecord(definitionRecord(result.storyDocument.assets)[String(actorAsset)]).name,
      'Same',
    );
  }
});

test('resolves scalar setSkin and an unowned loading costume using the actual owning sprite', () => {
  const result = parse({
    loading: {backdrop: 'Same', costumes: ['Walk']},
    scenes: {opening: [{'Cat.setSkin': 'Walk'}]},
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  if (result.ok) {
    const id = (definitionRecord(result.storyDocument.loading).costumes as string[])[0]!;
    assert.equal(definitionRecord(definitionRecord(result.storyDocument.assets)[id]).target, 'Cat');
  }
});

test('does not overwrite a user declaration that happens to use an internal project asset name', () => {
  const collision = '@project/backdrop/Stage/Same';
  const result = parse({assets: {[collision]: 'sound'}, scenes: {opening: [{stage: 'Same'}]}});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  if (result.ok) {
    assert.equal(
      definitionRecord(definitionRecord(result.storyDocument.assets)[collision]).kind,
      'sound',
    );
    assert.notEqual(definitionRecord(result.storyDocument.cover).backdrop, collision);
  }
});

test('binds an immutable name catalog for preview without freezing the original project', () => {
  const project = structuredClone(implicitAssetProject);
  const bound = bindDsl4ProjectSourceFrontend(frontend, project);
  project.targets[0]!.costumes[0]!.name = 'Edited';
  const result = bound.parse(
    JSON.stringify({kamishibai: '4.0', scenes: {opening: [{stage: 'Same'}]}}),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(Object.isFrozen(project.targets[0]), false);
});
