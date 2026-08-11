import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {runInThisContext} from 'node:vm';
import test from 'node:test';

import {strFromU8, unzipSync} from 'fflate';

import {
  createDownloadableReleaseSb3,
  downloadableReleases,
} from '../scripts/sb3/downloadable-releases.mjs';
import {
  createDsl4ProductionSourceFrontend,
  embedDsl4PackagedRuntimeComponentInSb3,
} from '../src/builder/index.js';
import {
  createDsl4EmbeddedAssetBundle,
  createDsl4EmbeddedSourceDescriptor,
  createDsl4RuntimeArtifactDescriptor,
} from '../src/dsl4/index.js';
import {dsl4StandardProductionFeatureFlags} from '../src/dsl4/feature-flags.js';
import {createFakeDocument, findByAttribute} from './helpers/fake-dom.mjs';
import {turbowarpVmCommit} from './helpers/turbowarp-vm.mjs';

const require = createRequire(import.meta.url);
const VirtualMachine = require('scratch-vm');
const dispatch = require('scratch-vm/src/dispatch/central-dispatch');
const vmLog = require('scratch-vm/src/util/log');
const bundleExtensionId = 'kubohiroyakamishibai4';
const runtimeExtensionId = 'kubohiroyakamishibairuntime4';
const release = downloadableReleases.find(({series}) => series === '4.0');
assert(release, 'The release catalog must publish a DSL 4.0 artifact.');
const schema = JSON.parse(
  await readFile(new URL('../schema/dsl-4.schema.json', import.meta.url), 'utf8'),
);
const frontend = createDsl4ProductionSourceFrontend(schema);
const storyComponentLimits = Object.freeze({
  maxSourceBytes: 1024 * 1024,
  maxAssetFiles: 64,
  maxAssetBytes: 64 * 1024 * 1024,
});

async function buildRelease() {
  return createDownloadableReleaseSb3(release);
}

async function buildEmbeddedStoryRelease() {
  const result = await buildRelease();
  const sourceText = `kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
assets:
  EndCover:
    kind: backdrop
    name: Menu
cover:
  backdrop: EndCover
scenes:
  opening:
    - wait: 0
`;
  const parsed = frontend.parse(sourceText, {sourceId: 'main'});
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const source = await createDsl4EmbeddedSourceDescriptor(sourceText, {
    sourceId: 'main',
    displayName: 'story.kamishibai.yaml',
    maxSourceBytes: storyComponentLimits.maxSourceBytes,
    subtleCrypto: webcrypto.subtle,
  });
  const artifact = await createDsl4RuntimeArtifactDescriptor(
    parsed.storyDocument,
    source,
    'production',
    {maxSourceBytes: storyComponentLimits.maxSourceBytes, subtleCrypto: webcrypto.subtle},
  );
  assert.equal(artifact.ok, true, JSON.stringify(artifact.diagnostics));
  const assets = await createDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    {
      manifest: {
        formatVersion: 1,
        assets: [
          {
            id: 'EndCover',
            kind: 'backdrop',
            loading: 'eager',
            source: {type: 'project', name: 'Menu'},
          },
        ],
      },
      getFile() {
        assert.fail('The embedded story fixture has no binary file asset.');
      },
    },
    {
      maxFiles: storyComponentLimits.maxAssetFiles,
      maxTotalBytes: storyComponentLimits.maxAssetBytes,
      subtleCrypto: webcrypto.subtle,
    },
  );
  const embedded = await embedDsl4PackagedRuntimeComponentInSb3(
    result.archive,
    parsed.storyDocument,
    source,
    artifact.artifact,
    assets,
    {
      channel: 'bundled',
      ...storyComponentLimits,
      replaceExisting: true,
      subtleCrypto: webcrypto.subtle,
    },
  );
  return embedded.bytes;
}

function installUnsandboxedScriptDom({withTitleUi = false} = {}) {
  const previous = {
    document: globalThis.document,
    location: globalThis.location,
    Scratch: globalThis.Scratch,
    ScratchExtensions: globalThis.ScratchExtensions,
  };
  globalThis.location = {href: 'https://release.test/'};
  const executeScript = (script) => {
    try {
      const prefix = 'data:text/javascript;base64,';
      assert(script.src.startsWith(prefix), 'The release extension must be embedded.');
      const source = Buffer.from(script.src.slice(prefix.length), 'base64').toString('utf8');
      runInThisContext(source, {filename: `${bundleExtensionId}.js`});
    } catch (error) {
      script.onerror?.(error);
    }
  };
  const document = withTitleUi
    ? createFakeDocument()
    : {
        visibilityState: 'visible',
        scripts: [],
        addEventListener() {},
        removeEventListener() {},
        createElement(tagName) {
          assert.equal(tagName, 'script');
          return {onerror: null, src: ''};
        },
        body: {appendChild: executeScript},
      };
  if (withTitleUi) {
    const appendChild = document.body.appendChild.bind(document.body);
    document.body.appendChild = (element) => {
      if (element.tagName === 'SCRIPT') {
        executeScript(element);
        return element;
      }
      return appendChild(element);
    };
  }
  globalThis.document = document;
  const restore = () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(globalThis, name);
      else globalThis[name] = value;
    }
  };
  restore.document = document;
  return restore;
}

async function extensionReporter(vm, opcode) {
  const service = vm.extensionManager._loadedExtensions.get(bundleExtensionId);
  assert(service, 'The embedded DSL 4.0 runtime extension was not loaded.');
  return dispatch.call(service, opcode);
}

async function loadProjectQuietly(vm, archive) {
  const originalWarn = vmLog.warn;
  const originalWarning = vmLog.warning;
  vmLog.warn = () => {};
  vmLog.warning = () => {};
  try {
    await vm.loadProject(archive);
  } finally {
    vmLog.warn = originalWarn;
    vmLog.warning = originalWarning;
  }
}

test('builds one self-contained DSL 4.0 release with a pinned runtime extension', async () => {
  const result = await buildRelease();
  const archive = unzipSync(result.archive);
  const project = JSON.parse(strFromU8(archive['project.json']));
  const extensionUrl = project.extensionURLs[bundleExtensionId];
  const extensionSource = Buffer.from(
    extensionUrl.slice('data:text/javascript;base64,'.length),
    'base64',
  ).toString('utf8');
  const stage = project.targets.find(({isStage}) => isStage);
  const title = stage.costumes.find(({name}) => name === 'Title');
  assert(title, 'The release Stage must contain a Title backdrop.');
  const titleSvg = strFromU8(archive[title.md5ext]);
  assert.match(titleSvg, />Participatory AI Kamishibai</u);
  assert.doesNotMatch(titleSvg, /Kamishibai DSL 4\.0/u);
  const localizedTitle = stage.costumes.find(({name}) => name === 'TitleRuntime');
  const localizedTitleSvg = strFromU8(archive[localizedTitle.md5ext]);
  assert.match(localizedTitleSvg, />「参加型」AI紙芝居</u);
  assert.match(localizedTitleSvg, /Mozilla Public License 2\.0/u);
  assert.match(localizedTitleSvg, />久保 裕也 \/ hiroya@cuc\.ac\.jp</u);
  assert.doesNotMatch(localizedTitleSvg, /\{\{/u);
  assert.deepEqual(
    stage.costumes.map(({name}) => name),
    ['Title', 'TitleRuntime', 'Menu', 'MenuRuntime'],
  );
  const websiteTarget = project.targets.find(({name}) => name === 'officialWebsiteButton');
  const localizedWebsite = websiteTarget.costumes.find(
    ({name}) => name === 'official-website-button-runtime',
  );
  const localizedWebsiteSvg = strFromU8(archive[localizedWebsite.md5ext]);
  assert.match(localizedWebsiteSvg, /width="160" height="64"/u);
  assert.match(localizedWebsiteSvg, />公式Webサイト</u);
  assert.equal(websiteTarget.visible, true);
  assert.equal(websiteTarget.y, -16);
  assert.equal(project.targets.find(({name}) => name === 'closeTitleButton')?.visible, true);
  assert.equal(
    project.targets.find(({name}) => name === 'officialWebsiteButton')?.blocks?.officialWebsiteOpen
      ?.opcode,
    `${bundleExtensionId}_openOfficialWebsite`,
  );
  assert.equal(stage.blocks.titleFlag?.opcode, 'event_whenflagclicked');
  assert.equal(stage.blocks.titleFlag?.next, 'titleFlagShow');
  assert.equal(stage.blocks.titleFlagShow?.opcode, `${bundleExtensionId}_showTitle`);
  assert.equal(stage.blocks.titleStageClick?.opcode, 'event_whenstageclicked');
  assert.deepEqual(stage.blocks.titleStageClickClose?.inputs?.BROADCAST_INPUT, [
    1,
    [11, 'closeTitle', 'closeTitleMessage'],
  ]);
  assert.equal(stage.blocks.titleCloseHat?.opcode, 'event_whenbroadcastreceived');
  assert.deepEqual(stage.blocks.titleCloseHat?.fields?.BROADCAST_OPTION, [
    'closeTitle',
    'closeTitleMessage',
  ]);
  assert.equal(stage.blocks.titleCloseStart?.opcode, `${bundleExtensionId}_closeTitle`);
  assert.deepEqual(
    project.targets.find(({name}) => name === 'closeTitleButton')?.blocks?.closeTitleBroadcast
      ?.inputs?.BROADCAST_INPUT,
    [1, [11, 'closeTitle', 'closeTitleMessage']],
  );

  assert.equal(turbowarpVmCommit, 'c4823421cb7c17d8d8a89878851ce1668c26a21f');
  assert.deepEqual(project.extensions, [bundleExtensionId]);
  assert.deepEqual(Object.keys(project.extensionURLs), [bundleExtensionId]);
  assert.match(extensionUrl, /^data:text\/javascript;base64,/u);
  assert.match(extensionSource, /^\/\/ Name: Kamishibai DSL 4\.0 Runtime/mu);
  assert.match(extensionSource, /^\/\/ ID: kubohiroyakamishibai4/mu);
  assert.doesNotMatch(extensionSource, /kubohiroyaweblink|SB3-Toolchain-Reversible-Bundle-v1/u);
  for (const [flag, enabled] of Object.entries(dsl4StandardProductionFeatureFlags)) {
    assert.equal(enabled, true);
    assert.equal(
      extensionSource.includes(`${flag}:!0`),
      true,
      `The Standard release bundle must enable ${flag}.`,
    );
  }
  assert.match(extensionSource, /display:none/u);
  for (const title of [
    'Asset Manager',
    'Async Input',
    'Bubble',
    'Runtime Expression',
    'SVG Text',
    'TMPose',
    'Teachable Machine Pose',
    'TensorFlow.js',
    'PoseNet MobileNetV1 model',
  ]) {
    assert.match(extensionSource, new RegExp(title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  assert.match(extensionSource, /@tensorflow\/tfjs Copyright 2019 Google/u);
  assert.match(extensionSource, /var tmPose=/u);
  const runtimeStorage = project.extensionStorage[bundleExtensionId].components[runtimeExtensionId];
  assert.equal(runtimeStorage.source.text.includes("kamishibai: '4.0'"), true);
  assert.deepEqual(runtimeStorage.application, {mode: 'menu'});
  assert.equal(runtimeStorage.artifact.controlProfile, 'production');
  assert.deepEqual(runtimeStorage.assets.manifest.assets, []);
  assert.deepEqual(Object.values(stage.variables), [
    ['ポーズ認識', 0],
    ['チャージ', 0],
  ]);
  assert.deepEqual(
    project.monitors.map(({opcode, params, mode, sliderMin, sliderMax, visible}) => ({
      opcode,
      params,
      mode,
      sliderMin,
      sliderMax,
      visible,
    })),
    [
      {
        opcode: 'data_variable',
        params: {VARIABLE: 'ポーズ認識'},
        mode: 'slider',
        sliderMin: 0,
        sliderMax: 100,
        visible: false,
      },
      {
        opcode: 'data_variable',
        params: {VARIABLE: 'チャージ'},
        mode: 'slider',
        sliderMin: 0,
        sliderMax: 100,
        visible: false,
      },
    ],
  );
  assert.equal(createHash('sha256').update(result.archive).digest('hex'), release.sha256);
});

test('preserves the embedded source descriptor through a pinned TurboWarp resave', async () => {
  const result = await buildRelease();
  const archive = unzipSync(result.archive);
  const originalProject = JSON.parse(strFromU8(archive['project.json']));
  const originalSource =
    originalProject.extensionStorage[bundleExtensionId].components[runtimeExtensionId].source;
  const restoreGlobals = installUnsandboxedScriptDom();
  const vm = new VirtualMachine();
  try {
    vm.setCompatibilityMode(false);
    vm.setTurboMode(false);
    vm.setCompilerOptions({enabled: false});
    vm.securityManager.canLoadExtensionFromProject = () => true;
    vm.securityManager.getSandboxMode = () => 'unsandboxed';
    await loadProjectQuietly(vm, result.archive);

    const resavedProject = JSON.parse(vm.toJSON());
    assert.deepEqual(
      resavedProject.extensionStorage[bundleExtensionId].components[runtimeExtensionId].source,
      originalSource,
    );
  } finally {
    vm.quit();
    restoreGlobals();
  }
});

test('opens the fixed official website through the Runtime 4 opcode', async () => {
  const result = await buildRelease();
  const restoreGlobals = installUnsandboxedScriptDom();
  const previousOpen = globalThis.open;
  const opened = [];
  globalThis.open = (...args) => opened.push(args);
  const vm = new VirtualMachine();
  try {
    vm.setCompatibilityMode(false);
    vm.setTurboMode(false);
    vm.setCompilerOptions({enabled: false});
    vm.securityManager.canLoadExtensionFromProject = () => true;
    vm.securityManager.getSandboxMode = () => 'unsandboxed';
    await loadProjectQuietly(vm, result.archive);

    await extensionReporter(vm, 'openOfficialWebsite');
    assert.deepEqual(opened, [
      ['https://kubohiroya.github.io/tmpose-kamishibai/', '_blank', 'noopener,noreferrer'],
    ]);
  } finally {
    vm.quit();
    restoreGlobals();
    if (previousOpen === undefined) Reflect.deleteProperty(globalThis, 'open');
    else globalThis.open = previousOpen;
  }
});

test('waits at the title and opens the non-embedded menu from Stage and close-button clicks', async () => {
  const result = await buildRelease();
  const restoreGlobals = installUnsandboxedScriptDom();
  const vm = new VirtualMachine();
  try {
    vm.setCompatibilityMode(false);
    vm.setTurboMode(false);
    vm.setCompilerOptions({enabled: false});
    vm.securityManager.canLoadExtensionFromProject = () => true;
    vm.securityManager.getSandboxMode = () => 'unsandboxed';
    await loadProjectQuietly(vm, result.archive);
    vm.runtime.renderer = {
      draw() {},
      createSVGSkin() {
        return 1;
      },
      destroySkin() {},
      updateDrawableSkinId() {},
    };

    assert.equal(await extensionReporter(vm, 'versionReporter'), '4.0.0-dev');
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'ready');
    vm.greenFlag();
    const titleDeadline = Date.now() + 5_000;
    while (Date.now() < titleDeadline) {
      vm.runtime._step();
      if ((await extensionReporter(vm, 'statusReporter')) === 'title') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'title');
    assert.equal(
      vm.runtime.getTargetForStage().lookupBroadcastMsg('closeTitleMessage', 'closeTitle')?.name,
      'closeTitle',
    );
    const stageClickThreads = vm.runtime.startHats('event_whenstageclicked');
    assert.equal(stageClickThreads.length, 1, 'The Stage click must start the closeTitle stack.');
    const startupDeadline = Date.now() + 5_000;
    while (Date.now() < startupDeadline) {
      vm.runtime._step();
      const status = await extensionReporter(vm, 'statusReporter');
      if (status === 'menu') break;
      if (status === 'error') {
        assert.fail(`DSL 4.0 runtime failed: ${await extensionReporter(vm, 'lastErrorReporter')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finalStatus = await extensionReporter(vm, 'statusReporter');
    assert.equal(
      finalStatus,
      'menu',
      `DSL 4.0 runtime remained ${finalStatus} at startup timeout; threads=${JSON.stringify(
        vm.runtime.threads.map(({topBlock, status, stack}) => ({topBlock, status, stack})),
      )}`,
    );
    assert.equal(
      vm.runtime.getTargetForStage().sprite.costumes[vm.runtime.getTargetForStage().currentCostume]
        .name,
      'Menu',
    );

    vm.greenFlag();
    const secondTitleDeadline = Date.now() + 5_000;
    while (Date.now() < secondTitleDeadline) {
      vm.runtime._step();
      if (
        (await extensionReporter(vm, 'statusReporter')) === 'title' &&
        vm.runtime.getSpriteTargetByName('closeTitleButton')?.visible === true
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'title');
    const closeTarget = vm.runtime.getSpriteTargetByName('closeTitleButton');
    assert(closeTarget, 'The Scratch title close button must exist.');
    assert.equal(closeTarget.visible, true);
    const closeThreads = vm.runtime.startHats('event_whenthisspriteclicked', null, closeTarget);
    assert.equal(closeThreads.length, 1, 'The close button must start its closeTitle stack.');
    const closeDeadline = Date.now() + 5_000;
    while (Date.now() < closeDeadline) {
      vm.runtime._step();
      const status = await extensionReporter(vm, 'statusReporter');
      if (status === 'menu') break;
      if (status === 'error') {
        assert.fail(`DSL 4.0 runtime failed: ${await extensionReporter(vm, 'lastErrorReporter')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'menu');
    assert.equal(
      vm.runtime.getTargetForStage().sprite.costumes[vm.runtime.getTargetForStage().currentCostume]
        .name,
      'Menu',
    );
    assert.equal(closeTarget.visible, false);
  } finally {
    vm.quit();
    restoreGlobals();
  }
});

test('returns a naturally finished embedded story to the menu and allows a restart', async () => {
  const archive = await buildEmbeddedStoryRelease();
  const restoreGlobals = installUnsandboxedScriptDom({withTitleUi: true});
  const vm = new VirtualMachine();
  try {
    vm.setCompatibilityMode(false);
    vm.setTurboMode(false);
    vm.setCompilerOptions({enabled: false});
    vm.securityManager.canLoadExtensionFromProject = () => true;
    vm.securityManager.getSandboxMode = () => 'unsandboxed';
    await loadProjectQuietly(vm, archive);
    let nextSkinId = 1;
    let nextDrawableId = 1;
    for (const target of vm.runtime.targets) {
      target.drawableID = nextDrawableId;
      nextDrawableId += 1;
      for (const costume of target.sprite?.costumes ?? []) {
        costume.skinId = nextSkinId;
        nextSkinId += 1;
      }
    }
    vm.runtime.renderer = {
      draw() {},
      createSVGSkin() {
        return 1;
      },
      destroySkin() {},
      updateDrawableSkinId() {},
    };

    vm.greenFlag();
    const titleDeadline = Date.now() + 5_000;
    while (Date.now() < titleDeadline) {
      vm.runtime._step();
      if ((await extensionReporter(vm, 'statusReporter')) === 'title') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'title');

    await extensionReporter(vm, 'closeTitle');
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'menu');
    const stage = vm.runtime.getTargetForStage();
    assert.equal(stage.sprite.costumes[stage.currentCostume].name, 'Menu');
    assert.equal(vm.runtime.getSpriteTargetByName('officialWebsiteButton').visible, false);
    assert.equal(vm.runtime.getSpriteTargetByName('closeTitleButton').visible, false);

    vm.greenFlag();
    const restartDeadline = Date.now() + 5_000;
    while (Date.now() < restartDeadline) {
      vm.runtime._step();
      if ((await extensionReporter(vm, 'statusReporter')) === 'title') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'title');
    assert.equal(stage.sprite.costumes[stage.currentCostume].name, 'Title');
    assert.equal(vm.runtime.getSpriteTargetByName('officialWebsiteButton').visible, true);
    assert.equal(vm.runtime.getSpriteTargetByName('closeTitleButton').visible, true);
  } finally {
    vm.quit();
    restoreGlobals();
  }
});

test('localizes the existing Stage title without creating a DOM dialog', async () => {
  const result = await buildRelease();
  const restoreGlobals = installUnsandboxedScriptDom({withTitleUi: true});
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {language: 'ja-JP', languages: ['ja-JP', 'en-US']},
  });
  const vm = new VirtualMachine();
  try {
    vm.setCompatibilityMode(false);
    vm.setTurboMode(false);
    vm.setCompilerOptions({enabled: false});
    vm.securityManager.canLoadExtensionFromProject = () => true;
    vm.securityManager.getSandboxMode = () => 'unsandboxed';
    await loadProjectQuietly(vm, result.archive);
    const stage = vm.runtime.getTargetForStage();
    const website = vm.runtime.getSpriteTargetByName('officialWebsiteButton');
    assert.equal(stage.sprite.costumes[stage.currentCostume].name, 'Title');
    assert.equal(website.sprite.costumes[website.currentCostume].name, 'official-website-button');
    vm.runtime.renderer = {
      draw() {},
      createSVGSkin() {
        return 1;
      },
      destroySkin() {},
      updateDrawableSkinId() {},
    };

    vm.greenFlag();
    const document = restoreGlobals.document;
    const titleDeadline = Date.now() + 5_000;
    while (Date.now() < titleDeadline) {
      vm.runtime._step();
      if ((await extensionReporter(vm, 'statusReporter')) === 'title') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'title');
    assert.equal(stage.sprite.costumes[stage.currentCostume].name, 'TitleRuntime');
    assert.equal(
      website.sprite.costumes[website.currentCostume].name,
      'official-website-button-runtime',
    );
    assert.equal(website.visible, true);
    assert.equal(vm.runtime.getSpriteTargetByName('closeTitleButton').visible, true);
    assert.equal(findByAttribute(document.body, 'data-dsl4-title-shell', 'true').length, 0);
    assert.equal(document.body.style.cursor, 'pointer');

    await extensionReporter(vm, 'closeTitle');
    const startupDeadline = Date.now() + 5_000;
    while (Date.now() < startupDeadline) {
      vm.runtime._step();
      const status = await extensionReporter(vm, 'statusReporter');
      if (status === 'menu') break;
      if (status === 'error') {
        assert.fail(`DSL 4.0 runtime failed: ${await extensionReporter(vm, 'lastErrorReporter')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'menu');
    assert.equal(stage.sprite.costumes[stage.currentCostume].name, 'MenuRuntime');
    assert.equal(website.visible, false);
    assert.equal(document.body.style.cursor, 'pointer');
  } finally {
    vm.quit();
    restoreGlobals();
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('logs and renders a pre-title Standard initialization failure', async () => {
  const result = await buildRelease();
  const restoreGlobals = installUnsandboxedScriptDom({withTitleUi: true});
  const originalConsoleError = console.error;
  const consoleErrors = [];
  const vm = new VirtualMachine();
  let originalToJSON;
  try {
    vm.setCompatibilityMode(false);
    vm.setTurboMode(false);
    vm.setCompilerOptions({enabled: false});
    vm.securityManager.canLoadExtensionFromProject = () => true;
    vm.securityManager.getSandboxMode = () => 'unsandboxed';
    await loadProjectQuietly(vm, result.archive);
    originalToJSON = vm.toJSON.bind(vm);
    vm.toJSON = () => '{';
    console.error = (...args) => consoleErrors.push(args);
    vm.runtime.renderer = {
      draw() {},
      createSVGSkin() {
        return 1;
      },
      destroySkin() {},
      updateDrawableSkinId() {},
    };

    await extensionReporter(vm, 'showTitle');
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'error');
    const lastError = await extensionReporter(vm, 'lastErrorReporter');
    assert.equal(typeof lastError, 'string');
    assert.notEqual(lastError, '');
    const errorRoot = findByAttribute(
      restoreGlobals.document.body,
      'data-dsl4-runtime-error',
      'true',
    )[0];
    assert(errorRoot, 'The pre-title failure must be rendered inside the Scratch stage.');
    assert.equal(errorRoot.style.display, 'flex');
    const initializationLog = consoleErrors.find(
      ([message]) => message === '[Kamishibai DSL 4.0] initialization failed.',
    );
    assert(initializationLog, 'The pre-title failure must be written to console.error.');
    assert(initializationLog[1] instanceof Error);
    assert.equal(typeof initializationLog[1].stack, 'string');
    assert.match(initializationLog[1].stack, /JSON|Expected property|Unexpected/iu);
  } finally {
    if (originalToJSON) vm.toJSON = originalToJSON;
    vm.quit();
    console.error = originalConsoleError;
    restoreGlobals();
  }
});
