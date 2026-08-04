import assert from 'node:assert/strict';
import test from 'node:test';

import {loadKamishibaiVm} from './helpers/turbowarp-vm.mjs';

const contractFixture = [
  'kamishibai=3.2',
  '# All DSL 3.2 commands and actions are represented in this fixture.',
  'setRuntimeVariable=score:1',
  'asset=Title,backdrop',
  'asset=Stars,backdrop',
  'asset=Hero,costume:Loading:loading',
  'asset=HeroAlt,costume:Loading:loading',
  'asset=Audio,text',
  'asset=Narration,text',
  'setLoadingBackdrop=Title',
  'setLoadingCostume=Hero,HeroAlt',
  'setPoseRecognitionSound=Hero',
  'text=ui.prompt:Pose!',
  'textStyle=Narration:font:Sans Serif',
  'actor=Hero,Hero',
  'cover=Title,',
  'registerBranch=route:score == 1:first',
  '---',
  'sceneLabel=first',
  'action=stage:Stars',
  'action=wait:30',
  '---',
  'sceneLabel=coverage',
  'TMPoseURL=https://example.com/model/',
  'action=bgm:Audio',
  'action=sound:Audio',
  'action=text:Narration:value=kept',
  'action=transition:reset',
  'action=branch:route',
  'action=keyInputToChangeScene:ArrowRight:destination',
  'action=touchInputToChangeScene:Hero:destination',
  'action=Hero:show:Hero:0,0,100',
  'action=Hero:hide',
  'action=Hero:say:hello',
  'action=Hero:think:hello',
  'action=Hero:setSkin:HeroAlt',
  'action=Hero:setScale:100',
  'action=Hero:setPosition:0,0',
  'action=Hero:moveTo:10,10,1',
  'action=Hero:setLayer:front',
  'action=Hero:loop:Hero,HeroAlt:1,1',
  'action=Hero:sequence:Hero,HeroAlt:1',
  'action=Hero:pose:Hero:pose:Audio',
  '---',
  'sceneLabel=destination',
  'action=wait:30',
].join('\n');

async function reachTitle(harness) {
  harness.greenFlag();
  await harness.runUntilAsync(
    () =>
      harness.getRuntimeVariable('skipMode') === 'title' && uiItemClonesById(harness).size === 7,
  );
}

function uiItemClonesById(harness) {
  return new Map(
    harness
      .getClones('UiItem')
      .map((target) => [target.lookupVariableByNameAndType('uiId', '')?.value, target]),
  );
}

function titleLayout(harness) {
  const cloneLayout = Object.fromEntries(
    [
      'titleHeading',
      'titleVersion',
      'titleLicenseApp',
      'titleLicenseStory',
      'titleAuthorOrganization',
      'titleAuthorName',
      'officialWebsiteLabel',
    ].map((name) => [name, targetLayout(uiItemClonesById(harness).get(name))]),
  );
  return {
    ...cloneLayout,
    officialWebsiteButton: targetLayout(harness.getSprite('officialWebsiteButton')),
    closeTitleButton: targetLayout(harness.getSprite('closeTitleButton')),
  };
}

function targetLayout(target) {
  return {size: target.size, visible: target.visible, x: target.x, y: target.y};
}

async function runDetailedPreflight(harness, script) {
  harness.setRuntimeVariable('script', script);
  harness.broadcast('startStory');
  await harness.runUntilAsync(() => Boolean(harness.getRuntimeVariable('kamishibaiErrorCategory')));
}

test('accepts the full contract fixture without preflight side effects', async (context) => {
  const harness = await loadKamishibaiVm({
    productionAssetManager: true,
    productionRuntimeExpression: true,
  });
  context.after(() => harness.quit());
  const manager = harness.extensionState.assetManager;
  const assetList = harness.getStage().lookupVariableByNameAndType('assetList', 'list');
  const before = {
    assetList: [...assetList.value],
    registrySize: manager.assetRegistry.size,
    runtimeVariables: {...harness.extensionState.tempVariables.runtimeVariables},
    targetCount: harness.vm.runtime.targets.length,
  };

  assert.deepEqual(
    JSON.parse(
      harness.extensionState.kamishibaiRuntime.validateScriptSource({SCRIPT: contractFixture}),
    ),
    {ok: true},
  );
  assert.deepEqual(
    {
      assetList: [...assetList.value],
      registrySize: manager.assetRegistry.size,
      runtimeVariables: {...harness.extensionState.tempVariables.runtimeVariables},
      targetCount: harness.vm.runtime.targets.length,
    },
    before,
  );
});

test('the Scratch parser processes the same full contract fixture', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());

  harness.greenFlag();
  harness.runUntil(() => harness.getRuntimeVariable('skipMode') === 'title');
  harness.setRuntimeVariable('script', contractFixture);
  harness.broadcast('startStory');
  harness.runUntil(() => harness.getBackdropName() === 'Stars', {maxSteps: 1000});

  assert.deepEqual(harness.extensionState.consoleErrors, []);
  assert.ok(harness.extensionState.assetRegistrations.length > 0);
});

test('preserves physical source locations for LF, CRLF, and CR scripts', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());

  for (const newline of ['\n', '\r\n', '\r']) {
    const sourceLine = 'unsupported=value=with=equals';
    const script = ['kamishibai=3.2', '# comment', '', '---', sourceLine].join(newline);
    const result = JSON.parse(
      harness.extensionState.kamishibaiRuntime.validateScriptSource({SCRIPT: script}),
    );

    assert.equal(result.ok, false);
    assert.equal(result.diagnostic.code, 'K32-COMMAND-002');
    assert.deepEqual(result.diagnostic.source, {line: 5, column: 1, text: sourceLine});
  }
});

test('escapes SVG source text and localizes diagnostics in English and Japanese', async (context) => {
  for (const {language, message, title} of [
    {language: 'English', message: /not supported/u, title: /Script error/u},
    {language: 'Japanese', message: /対応していません/u, title: /台本エラー/u},
  ]) {
    const harness = await loadKamishibaiVm({viewerLanguage: language});
    context.after(() => harness.quit());
    harness.setStageVariable('featureDetailedScriptErrors', true);
    await reachTitle(harness);
    await runDetailedPreflight(harness, 'kamishibai=<2.0>&"');

    assert.match(harness.getRuntimeVariable('kamishibaiErrorMessage'), message);
    const svg = harness.getRuntimeVariable('kamishibaiErrorSvg');
    assert.match(svg, title);
    assert.match(svg, /kamishibai=&lt;2\.0&gt;&amp;&quot;/u);
    assert.doesNotMatch(svg, /kamishibai=<2\.0>/u);
  }
});

test('stops background work and clears the diagnostic presentation on project restart', async (context) => {
  const harness = await loadKamishibaiVm({
    productionAssetManager: true,
    productionRuntimeExpression: true,
  });
  context.after(() => harness.quit());
  harness.setStageVariable('featureDetailedScriptErrors', true);
  await reachTitle(harness);
  const initialTitleLayout = titleLayout(harness);
  const initialPromptLayout = targetLayout(harness.getSprite('prompt'));

  harness.extensionState.asyncInput.listenForKeyAndBroadcast(
    {KEY_ID: 'KeyA', MESSAGE: 'unused', RUNTIME_VAR: 'unused', VALUE: '1'},
    {target: harness.getStage()},
  );
  harness.extensionState.assetManager.actorAnimations.set('stale-test-animation', {timer: null});
  await runDetailedPreflight(harness, ['kamishibai=3.2', 'unsupported=first-error'].join('\n'));

  assert.equal(harness.extensionState.keyInputBindings.size, 0);
  assert.equal(harness.extensionState.assetManager.actorAnimations.size, 0);
  assert.equal(harness.getRuntimeVariable('kamishibaiErrorLine'), 2);
  assert.equal(harness.getSprite('prompt').visible, true);

  const unrelatedTarget = harness.getSprite('officialWebsiteButton');
  const originalSetSize = unrelatedTarget.setSize.bind(unrelatedTarget);
  const originalSetXY = unrelatedTarget.setXY.bind(unrelatedTarget);
  let unrelatedLayoutWrites = 0;
  unrelatedTarget.setSize = (...arguments_) => {
    unrelatedLayoutWrites += 1;
    return originalSetSize(...arguments_);
  };
  unrelatedTarget.setXY = (...arguments_) => {
    unrelatedLayoutWrites += 1;
    return originalSetXY(...arguments_);
  };
  harness.extensionState.kamishibaiRuntime.resetForProjectStart();
  unrelatedTarget.setSize = originalSetSize;
  unrelatedTarget.setXY = originalSetXY;
  assert.equal(unrelatedLayoutWrites, 0);
  assert.deepEqual(targetLayout(harness.getSprite('prompt')), initialPromptLayout);

  await reachTitle(harness);
  assert.equal(harness.extensionState.kamishibaiRuntime.getLastDiagnosticJson(), '');
  assert.equal(harness.hasRuntimeVariable('kamishibaiErrorCategory'), false);
  assert.equal(harness.hasRuntimeVariable('kamishibaiErrorLine'), false);
  assert.equal(harness.getSprite('prompt').visible, false);
  assert.equal(harness.getSprite('officialWebsiteButton').visible, true);
  assert.deepEqual(titleLayout(harness), initialTitleLayout);

  await runDetailedPreflight(harness, 'kamishibai=2.0');
  assert.equal(harness.getRuntimeVariable('kamishibaiErrorLine'), 1);
  assert.equal(harness.getRuntimeVariable('kamishibaiErrorSource'), 'kamishibai=2.0');
});

test('keeps the detailed preflight disabled for an execution that started with the flag off', async (context) => {
  const harness = await loadKamishibaiVm();
  context.after(() => harness.quit());
  harness.setStageVariable('featureDetailedScriptErrors', false);
  harness.setRuntimeVariable('script', 'kamishibai=2.0');

  harness.extensionState.kamishibaiRuntime.validateScriptOrStop();
  harness.setStageVariable('featureDetailedScriptErrors', true);
  harness.extensionState.kamishibaiRuntime.validateScriptOrStop();

  assert.equal(harness.extensionState.kamishibaiRuntime.getLastDiagnosticJson(), '');
  assert.equal(harness.hasRuntimeVariable('kamishibaiErrorCategory'), false);

  harness.greenFlag();
  harness.setRuntimeVariable('script', 'kamishibai=2.0');
  harness.extensionState.kamishibaiRuntime.validateScriptOrStop();
  assert.equal(harness.getRuntimeVariable('kamishibaiErrorCode'), 'K32-VERSION-001');
});
