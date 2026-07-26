import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  loadKamishibaiVm,
  turbowarpVmCommit,
} from './helpers/turbowarp-vm.mjs';

const runtimeFixtureUrl = new URL(
  './fixtures/runtime/skip-mode.txt',
  import.meta.url,
);
const poseFixtureUrl = new URL(
  './fixtures/runtime/pose-skip-mode.txt',
  import.meta.url,
);

async function startFixture(harness, fixtureUrl = runtimeFixtureUrl) {
  const script = await readFile(fixtureUrl, 'utf8');
  startScript(harness, script);
}

function startScript(harness, script) {
  harness.greenFlag();
  harness.runUntil(() => harness.getRuntimeVariable('skipMode') === 'title');
  harness.setRuntimeVariable('script', script);
  harness.broadcast('startStory');
  harness.runUntil(() => harness.getBackdropName() === 'Stars');
}

function actorActionScript(action, {before = []} = {}) {
  return [
    'kamishibai=3.1',
    'asset=Title,backdrop',
    'asset=Stars,backdrop',
    'asset=Hero,costume:Hatchling:hatchling-c',
    'actor=Hero,Hero',
    'cover=Title,',
    '---',
    'sceneLabel=first',
    'action=stage:Stars',
    ...before.map((line) => `action=${line}`),
    `action=${action}`,
    'action=stage:Title',
    'action=wait:30',
    '---',
    'sceneLabel=second',
    'action=stage:Stars',
    'action=wait:30',
  ].join('\n');
}

function sceneNavigationScript(firstSceneActions, {runtimeVariables = [], branches = []} = {}) {
  return [
    'kamishibai=3.1',
    'asset=Title,backdrop',
    'asset=Stars,backdrop',
    'asset=LeftDoor,costume:Hatchling:hatchling-c',
    'asset=RightDoor,costume:Hatchling:hatchling-c',
    'actor=LeftDoor,LeftDoor',
    'actor=RightDoor,RightDoor',
    ...runtimeVariables.map((value) => `setRuntimeVariable=${value}`),
    ...branches.map((value) => `registerBranch=${value}`),
    'cover=Title,',
    '---',
    'sceneLabel=first',
    'action=stage:Stars',
    ...firstSceneActions.map((action) => `action=${action}`),
    '---',
    'sceneLabel=home',
    'action=stage:Title',
    'action=wait:30',
    '---',
    'sceneLabel=ocean',
    'action=stage:Stars',
    'action=wait:30',
  ].join('\n');
}

test('pins and loads the generated SB3 in the TurboWarp VM', async (context) => {
  assert.equal(turbowarpVmCommit, 'c4823421cb7c17d8d8a89878851ce1668c26a21f');
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());

  assert.deepEqual(
    harness.vm.runtime.targets.map((target) => target.getName()),
    [
      'Stage',
      'Actor',
      'prompt',
      'openButton',
      'reloadButton',
      'showTitleButton',
      'Hatchling',
    ],
  );
  for (const name of [
    'prompt',
    'openButton',
    'reloadButton',
    'showTitleButton',
  ]) {
    assert.deepEqual(
      harness.getSprite(name).getCostumes().map((costume) => costume.name),
      ['ui-placeholder'],
      `${name} still contains a localized costume`,
    );
  }
});

for (const branchCase of [
  {condition: 'true', expectedSceneIndex: 3, expectedBackdrop: 'Stars'},
  {condition: 'false', expectedSceneIndex: 2, expectedBackdrop: 'Title'},
]) {
  test(`branches to the first true label when the first condition is ${branchCase.condition}`, async (context) => {
    const harness = await loadKamishibaiVm();
    context.after(() => harness.quit());
    startScript(harness, sceneNavigationScript([
      'wait:0.1',
      'branch:chooseRoute',
      'wait:30',
    ], {
      runtimeVariables: [`takeSeaRoute:${branchCase.condition}`],
      branches: ['chooseRoute:takeSeaRoute,true:ocean,home'],
    }));

    harness.runUntil(() => (
      Number(harness.getRuntimeVariable('sceneIndex')) === branchCase.expectedSceneIndex
      && harness.getBackdropName() === branchCase.expectedBackdrop
    ));
    assert.equal(harness.getBackdropName(), branchCase.expectedBackdrop);
  });
}

test('continues the current scene when no registered branch condition is true', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());
  startScript(harness, sceneNavigationScript([
    'wait:0.1',
    'branch:noRoute',
    'stage:Title',
    'wait:30',
  ], {
    branches: ['noRoute:false,false:ocean,home'],
  }));

  harness.runUntil(() => (
    harness.getBackdropName() === 'Title'
    && Number(harness.getRuntimeVariable('sceneIndex')) === 1
    && harness.getRuntimeVariable('actionCommand') === 'wait'
  ));
  assert.equal(harness.hasRuntimeVariable('nextSceneLabel'), false);
});

test('changes scene from a registered physical key input', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());
  startScript(harness, sceneNavigationScript([
    'keyInputToChangeScene:ArrowLeft,ArrowRight:home,ocean',
    'wait:30',
  ]));
  harness.runUntil(() => harness.extensionState.keyInputBindings.size === 2);
  assert.equal(harness.extensionState.keyInputBindings.get('ArrowLeft').VALUE, 'home');
  assert.equal(harness.extensionState.keyInputBindings.get('ArrowRight').VALUE, 'ocean');

  harness.triggerAsyncKey('ArrowRight');
  harness.runUntil(() => Number(harness.getRuntimeVariable('sceneIndex')) === 3);

  assert.equal(harness.getBackdropName(), 'Stars');
  assert.equal(harness.extensionState.keyInputBindings.size, 0);
});

test('changes scene from a registered actor touch input', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());
  startScript(harness, sceneNavigationScript([
    'LeftDoor:show:LeftDoor:-100,0,50',
    'RightDoor:show:RightDoor:100,0,50',
    'touchInputToChangeScene:LeftDoor,RightDoor:home,ocean',
    'wait:30',
  ]));
  harness.runUntil(() => harness.extensionState.touchInputBindings.size === 2);
  assert.equal(harness.extensionState.touchInputBindings.get('LeftDoor').VALUE, 'home');
  assert.equal(harness.extensionState.touchInputBindings.get('RightDoor').VALUE, 'ocean');

  harness.triggerActorTouch('RightDoor');
  harness.runUntil(() => Number(harness.getRuntimeVariable('sceneIndex')) === 3);

  assert.equal(harness.getBackdropName(), 'Stars');
  assert.equal(harness.extensionState.touchInputBindings.size, 0);
});

test('accepts only Space while the title is active', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());

  harness.greenFlag();
  harness.runUntil(() => harness.getRuntimeVariable('skipMode') === 'title');

  harness.pressKey('ArrowRight');
  assert.equal(harness.getRuntimeVariable('skipMode'), 'title');
  harness.pressKey('ArrowDown');
  assert.equal(harness.getRuntimeVariable('skipMode'), 'title');

  harness.pressKey(' ');
  harness.runUntil(() => !harness.hasRuntimeVariable('skipMode'));
  assert.equal(harness.getBackdropName(), 'Stars');
});

test('keeps the external script flow when the embedded script slot is empty', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());

  harness.greenFlag();
  harness.runUntil(() => harness.getRuntimeVariable('skipMode') === 'title');
  assert.equal(harness.getStageVariable('__tmpose_embedded_script'), '');

  harness.clickStage();
  harness.runUntil(() => !harness.hasRuntimeVariable('skipMode'));
  assert.equal(harness.hasRuntimeVariable('script'), false);
});

test('uses scene 0 text values for prompt and menu UI assets', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());

  harness.greenFlag();
  harness.runUntil(() => harness.getRuntimeVariable('skipMode') === 'title');
  harness.broadcast('showMenu');
  harness.runUntil(() => harness.getSprite('openButton')?.visible === true);

  const openButton = harness.getSprite('openButton');
  assert.equal(
    harness.extensionState.displayedText.get(openButton.id),
    'Open file',
  );

  harness.setRuntimeVariable('script', [
    'kamishibai=3.1',
    'text=ui.prompt:ポーズをとろう！',
    'text=ui.invalidScript:エラー：不正な台本ファイル',
    'text=ui.open:ファイルをひらく',
    'text=ui.reload:もういちど',
    'text=ui.about:このアプリについて',
    'asset=Title,backdrop',
    'asset=Stars,backdrop',
    'cover=Title,',
    '---',
    'sceneLabel=first',
    'action=stage:Stars',
    'action=wait:30',
  ].join('\n'));
  harness.broadcast('hideMenu');
  harness.broadcast('startStory');
  harness.runUntil(() => harness.getBackdropName() === 'Stars');

  assert.equal(harness.getRuntimeVariable('text:ui.prompt'), 'ポーズをとろう！');
  assert.equal(harness.getRuntimeVariable('text:ui.open'), 'ファイルをひらく');

  harness.broadcast('showPrompt');
  harness.runUntil(() => harness.getSprite('prompt')?.visible === true);
  const prompt = harness.getSprite('prompt');
  assert.equal(
    harness.extensionState.displayedText.get(prompt.id),
    'ポーズをとろう！',
  );

  harness.broadcast('invalidScript');
  harness.runUntil(() => (
    harness.extensionState.displayedText.get(prompt.id)
      === 'エラー：不正な台本ファイル'
  ));

  harness.broadcast('showMenu');
  harness.runUntil(() => (
    harness.getSprite('reloadButton')?.visible === true
    && harness.getSprite('showTitleButton')?.visible === true
  ));
  assert.equal(
    harness.extensionState.displayedText.get(openButton.id),
    'ファイルをひらく',
  );
  assert.equal(
    harness.extensionState.displayedText.get(harness.getSprite('reloadButton').id),
    'もういちど',
  );
  assert.equal(
    harness.extensionState.displayedText.get(
      harness.getSprite('showTitleButton').id,
    ),
    'このアプリについて',
  );
  assert.deepEqual(harness.extensionState.consoleErrors, []);
});

test('updates and clears a registered text asset from ordered text actions', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());
  startScript(harness, [
    'kamishibai=3.1',
    'asset=Title,backdrop',
    'asset=Stars,backdrop',
    'asset=Narration,text',
    'actor=Narration,Narration',
    'cover=Title,',
    '---',
    'sceneLabel=first',
    'action=stage:Stars',
    'action=text:Narration:むかし',
    'action=Narration:show:Narration:0,0,100',
    'action=wait:0.2',
    'action=text:Narration:むかし　むかし、',
    'action=wait:0.2',
    'action=text:Narration:',
    'action=wait:30',
  ].join('\n'));

  harness.runUntil(() => (
    harness.getRuntimeVariable('text:Narration') === 'むかし'
    && harness.getActor('Narration')?.visible === true
  ));
  assert.equal(harness.getActor('Narration')?.visible, true);
  assert.equal(harness.hasRuntimeVariable('Narration'), false);
  assert.deepEqual(harness.extensionState.consoleErrors, []);

  harness.runUntil(() => (
    harness.getRuntimeVariable('text:Narration') === 'むかし　むかし、'
  ));
  assert.equal(Number(harness.getRuntimeVariable('sceneIndex')), 1);

  harness.runUntil(() => (
    harness.getRuntimeVariable('text:Narration') === ''
  ));
  assert.equal(harness.getBackdropName(), 'Stars');
  assert.equal(harness.getActor('Narration')?.visible, true);
  assert.deepEqual(harness.extensionState.consoleErrors, []);
});

test('registers and displays a text asset through the production Asset Manager', async (context) => {
  const harness = await loadKamishibaiVm({productionAssetManager: true});
  context.after(() => harness.quit());
  const actor = harness.vm.runtime.targets.find((target) => (
    target.isOriginal && target.sprite?.name === 'Actor'
  ));
  const util = {runtime: harness.vm.runtime, target: actor};

  await harness.extensionState.assetManager.registerAsset({
    NAME: 'Narration',
    RESOURCE_ID: 'text',
  });
  await harness.extensionState.assetManager.setTextValue({
    NAME: 'Narration',
    VALUE: 'むかし',
  });
  await harness.extensionState.assetManager.setThisSpriteSkin(
    {NAME: 'Narration'},
    util,
  );

  assert.equal(
    harness.extensionState.assetManager?.isLoaded({NAME: 'Narration'}),
    true,
  );
  assert.equal(
    harness.extensionState.displayedText.get(actor.id),
    'むかし',
  );
  assert.equal(harness.extensionState.textColors.get(actor.id), '#ffffff');
  assert.equal(harness.extensionState.textOutlineWidths.get(actor.id), 2);
  assert.equal(harness.extensionState.textOutlineColors.get(actor.id), '#000000');

  await harness.extensionState.assetManager.setTextValue({
    NAME: 'Narration',
    VALUE: 'むかし　むかし、あるところに...',
  });
  assert.equal(
    harness.extensionState.displayedText.get(actor.id),
    'むかし　むかし、あるところに...',
  );

  await harness.extensionState.assetManager.setTextValue({
    NAME: 'Narration',
    VALUE: '',
  });
  assert.equal(harness.extensionState.displayedText.get(actor.id), '');
  assert.deepEqual(harness.extensionState.consoleErrors, []);
});

test('ignores rehearsal keys while the project is stopped', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());

  harness.greenFlag();
  harness.runUntil(() => harness.getRuntimeVariable('skipMode') === 'title');
  harness.stopAll();

  for (const key of [' ', 'ArrowRight', 'ArrowDown']) {
    harness.pressKey(key);
    assert.equal(harness.hasRuntimeVariable('skipMode'), false, `${key} was not ignored.`);
  }
});

test('clears pending input at project, cover, stop, and final scene boundaries', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());

  harness.setRuntimeVariable('skipMode', 'scene');
  harness.setRuntimeVariable('skipContext', 'action');
  harness.greenFlag();
  harness.runUntil(() => harness.getRuntimeVariable('skipMode') === 'title');
  assert.equal(harness.hasRuntimeVariable('skipContext'), false);

  harness.setRuntimeVariable('skipMode', 'action');
  harness.setRuntimeVariable('skipContext', 'pose');
  harness.broadcast('showCover');
  harness.runUntil(() => !harness.hasRuntimeVariable('skipMode'));
  assert.equal(harness.hasRuntimeVariable('skipContext'), false);

  harness.setRuntimeVariable('skipMode', 'scene');
  harness.setRuntimeVariable('skipContext', 'action');
  harness.stopAll();
  assert.equal(harness.hasRuntimeVariable('skipMode'), false);
  assert.equal(harness.hasRuntimeVariable('skipContext'), false);

  startScript(harness, [
    'kamishibai=3.1',
    'asset=Title,backdrop',
    'asset=Stars,backdrop',
    'cover=Title,',
    '---',
    'sceneLabel=only',
    'action=stage:Stars',
    'action=wait:0.1',
  ].join('\n'));
  harness.runUntil(() => (
    harness.getBackdropName() === 'Title'
    && !harness.hasRuntimeVariable('skipContext')
  ));
  assert.equal(harness.hasRuntimeVariable('skipMode'), false);
});

test('keeps a wait active without input and accepts Right during the action', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());
  await startFixture(harness);

  harness.step({milliseconds: 100, count: 20});
  assert.equal(harness.getBackdropName(), 'Stars');
  assert.equal(harness.getRuntimeVariable('sceneIndex'), '1');

  harness.pressKey('ArrowRight');
  harness.runUntil(() => harness.getBackdropName() !== 'Stars');
  assert.equal(harness.getBackdropName(), 'Title');
  assert.equal(harness.getRuntimeVariable('sceneIndex'), '1');
  assert.equal(harness.hasRuntimeVariable('skipMode'), false);
});

test('accepts keys only in their specified runtime contexts', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());

  harness.greenFlag();
  harness.runUntil(() => harness.getRuntimeVariable('skipMode') === 'title');
  harness.stopAll();

  const assertInput = (runtimeContext, key, expected) => {
    harness.deleteRuntimeVariable('skipMode');
    harness.setRuntimeVariable('skipContext', runtimeContext);
    harness.pressKey(key);
    assert.equal(harness.getRuntimeVariable('skipMode'), expected);
  };

  assertInput('pose', ' ', 'pose');
  assertInput('pose', 'ArrowRight', 'action');
  assertInput('pose', 'ArrowDown', 'scene');
  assertInput('action', ' ', undefined);
  assertInput('action', 'ArrowRight', 'action');
  assertInput('action', 'ArrowDown', 'scene');
  assertInput('betweenActions', ' ', undefined);
  assertInput('betweenActions', 'ArrowRight', undefined);
  assertInput('betweenActions', 'ArrowDown', 'scene');
  assertInput('scene', ' ', undefined);
  assertInput('scene', 'ArrowRight', undefined);
  assertInput('scene', 'ArrowDown', 'scene');
});

test('keeps the first accepted input until its owner consumes it', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());

  harness.greenFlag();
  harness.runUntil(() => harness.getRuntimeVariable('skipMode') === 'title');
  harness.stopAll();
  harness.setRuntimeVariable('skipContext', 'pose');

  harness.pressKey(' ');
  harness.pressKey('ArrowRight');
  harness.pressKey('ArrowDown');
  assert.equal(harness.getRuntimeVariable('skipMode'), 'pose');
});

test('accepts Down during an action and advances to the next scene', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());
  await startFixture(harness);

  harness.pressKey('ArrowDown');
  harness.runUntil(() => harness.getRuntimeVariable('sceneIndex') === 2);

  assert.equal(harness.getRuntimeVariable('sceneIndex'), 2);
  assert.equal(harness.getBackdropName(), 'Stars');
  assert.equal(harness.hasRuntimeVariable('skipMode'), false);
});

test('consumes Space inside a pose action and continues with its next pose', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());
  await startFixture(harness, poseFixtureUrl);
  harness.runUntil(() => harness.getRuntimeVariable('skipContext') === 'pose');

  harness.pressKey(' ');
  harness.runUntil(() => harness.getStageVariable('poseIndex') === 2);

  assert.equal(harness.getRuntimeVariable('skipContext'), 'pose');
  assert.equal(harness.hasRuntimeVariable('skipMode'), false);
  assert.equal(harness.getBackdropName(), 'Stars');
});

test('propagates Right from a pose to the action boundary', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());
  await startFixture(harness, poseFixtureUrl);
  harness.runUntil(() => harness.getRuntimeVariable('skipContext') === 'pose');

  harness.pressKey('ArrowRight');
  harness.runUntil(() => harness.getBackdropName() === 'Title');

  assert.equal(harness.getRuntimeVariable('sceneIndex'), '1');
  assert.equal(harness.hasRuntimeVariable('skipMode'), false);
});

test('propagates Down from a pose to the scene boundary', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());
  await startFixture(harness, poseFixtureUrl);
  harness.runUntil(() => harness.getRuntimeVariable('skipContext') === 'pose');

  harness.pressKey('ArrowDown');
  harness.runUntil(() => harness.getRuntimeVariable('sceneIndex') === 2);

  assert.equal(harness.getBackdropName(), 'Stars');
  assert.equal(harness.hasRuntimeVariable('skipMode'), false);
});

for (const command of ['say', 'think']) {
  test(`clears a ${command} bubble when Right finishes the action`, async (context) => {
    const harness = await loadKamishibaiVm();
    context.after(() => harness.quit());
    startScript(harness, actorActionScript(`Hero:${command}:message:30`));
    harness.runUntil(() => harness.getBubbleText('Hero') === 'message');

    harness.pressKey('ArrowRight');
    harness.runUntil(() => harness.getBackdropName() === 'Title', {maxSteps: 50});

    assert.equal(harness.getBubbleText('Hero'), '');
    assert.equal(harness.hasRuntimeVariable('skipMode'), false);
  });
}

test('moves an actor to the destination when Right finishes a glide', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());
  startScript(harness, actorActionScript('Hero:moveTo:100,50,30', {
    before: ['Hero:show:Hero:0,0,30'],
  }));
  harness.runUntil(() => (
    harness.getRuntimeVariable('actionCommand') === 'moveTo'
    && harness.getRuntimeVariable('skipContext') === 'action'
  ));

  harness.pressKey('ArrowRight');
  harness.runUntil(() => harness.getBackdropName() === 'Title', {maxSteps: 50});

  assert.equal(harness.getActor('Hero').x, 100);
  assert.equal(harness.getActor('Hero').y, 50);
  assert.equal(harness.hasRuntimeVariable('skipMode'), false);
});

test('stops an asset sound when Right finishes sound-until-done', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());
  startScript(harness, [
    'kamishibai=3.1',
    'asset=Title,backdrop',
    'asset=Stars,backdrop',
    'asset=Effect,sound:Hatchling:Chirp',
    'asset=Music,https://example.com/music.mp3',
    'cover=Title,',
    '---',
    'sceneLabel=first',
    'action=stage:Stars',
    'action=bgm:Music',
    'action=sound:Effect',
    'action=stage:Title',
    'action=wait:30',
    '---',
    'sceneLabel=second',
    'action=stage:Stars',
    'action=wait:30',
  ].join('\n'));
  harness.runUntil(() => harness.isSoundPlaying('Effect'));

  harness.pressKey('ArrowRight');
  harness.runUntil(() => harness.getBackdropName() === 'Title', {maxSteps: 50});

  assert.equal(harness.isSoundPlaying('Effect'), false);
  assert.equal(harness.isSoundPlaying('Music'), true);
  assert.equal(harness.hasRuntimeVariable('skipMode'), false);
});

test('keeps BGM playing when Right finishes an unrelated wait', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());
  startScript(harness, [
    'kamishibai=3.1',
    'asset=Title,backdrop',
    'asset=Stars,backdrop',
    'asset=Music,sound:Hatchling:Chirp',
    'cover=Title,',
    '---',
    'sceneLabel=first',
    'action=stage:Stars',
    'action=bgm:Music',
    'action=wait:30',
    'action=stage:Title',
    'action=wait:30',
    '---',
    'sceneLabel=second',
    'action=stage:Stars',
    'action=wait:30',
  ].join('\n'));
  harness.runUntil(() => (
    harness.isSoundPlaying('Music')
    && harness.getRuntimeVariable('actionCommand') === 'wait'
  ));

  harness.pressKey('ArrowRight');
  harness.runUntil(() => harness.getBackdropName() === 'Title', {maxSteps: 50});

  assert.equal(harness.isSoundPlaying('Music'), true);
  assert.equal(harness.hasRuntimeVariable('skipMode'), false);
});

for (const transition of [
  {name: 'fadeOut', before: [], finalBrightness: -100},
  {name: 'fadeUp', before: ['action=transition:fadeOut'], finalBrightness: 0},
]) {
  test(`applies the final brightness when Right finishes ${transition.name}`, async (context) => {
    const harness = await loadKamishibaiVm();
    context.after(() => harness.quit());
    startScript(harness, [
      'kamishibai=3.1',
      'asset=Title,backdrop',
      'asset=Stars,backdrop',
      'cover=Title,',
      '---',
      'sceneLabel=first',
      'action=stage:Stars',
      ...transition.before,
      `action=transition:${transition.name}`,
      'action=stage:Title',
      'action=wait:30',
      '---',
      'sceneLabel=second',
      'action=stage:Stars',
      'action=wait:30',
    ].join('\n'));
    harness.runUntil(() => (
      harness.getRuntimeVariable('actionParam') === transition.name
      && harness.getStageEffect('brightness') > -100
      && harness.getStageEffect('brightness') < 0
    ));

    harness.pressKey('ArrowRight');
    harness.runUntil(() => harness.getBackdropName() === 'Title', {maxSteps: 50});

    assert.equal(harness.getStageEffect('brightness'), transition.finalBrightness);
    assert.equal(harness.hasRuntimeVariable('skipMode'), false);
  });
}

test('applies the final image when a later Right input finishes a sequence', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());
  startScript(harness, [
    'kamishibai=3.1',
    'asset=Title,backdrop',
    'asset=Stars,backdrop',
    'asset=Hero,costume:Hatchling:hatchling-c',
    'asset=Hero2,costume:Hatchling:hatchling-c',
    'actor=Hero,Hero',
    'cover=Title,',
    '---',
    'sceneLabel=first',
    'action=stage:Stars',
    'action=Hero:sequence:Hero,Hero2:30',
    'action=wait:30',
    'action=stage:Title',
    'action=wait:30',
    '---',
    'sceneLabel=second',
    'action=stage:Stars',
    'action=wait:30',
  ].join('\n'));
  harness.runUntil(() => (
    harness.getActorSkin('Hero') === 'Hero'
    && harness.getRuntimeVariable('actionCommand') === 'wait'
  ));

  harness.pressKey('ArrowRight');
  harness.runUntil(() => harness.getBackdropName() === 'Title', {maxSteps: 50});

  assert.equal(harness.getActorSkin('Hero'), 'Hero2');
  assert.equal(harness.hasRuntimeVariable('skipMode'), false);
});
