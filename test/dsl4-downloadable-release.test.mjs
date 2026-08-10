import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {runInThisContext} from 'node:vm';
import test from 'node:test';

import {strFromU8, unzipSync} from 'fflate';

import {
  createDownloadableReleaseSb3,
  downloadableReleases,
} from '../scripts/sb3/downloadable-releases.mjs';
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

async function buildRelease() {
  return createDownloadableReleaseSb3(release);
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
  assert.equal(project.targets.find(({name}) => name === 'officialWebsiteButton')?.visible, true);
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
  assert.equal(extensionSource.includes('dsl4PoseFeedbackModes:!0'), true);
  assert.equal(extensionSource.includes('dsl4SpeechAdvanceTypewriter:!0'), true);
  assert.match(extensionSource, /display:none/u);
  for (const title of [
    'Asset Manager',
    'Async Input',
    'Bubble',
    'Runtime Expression',
    'SVG Text',
    'TMPose',
    'PoseNet MobileNetV1 model',
  ]) {
    assert.match(extensionSource, new RegExp(title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  const runtimeStorage = project.extensionStorage[bundleExtensionId].components[runtimeExtensionId];
  assert.equal(runtimeStorage.source.text.includes("kamishibai: '4.0'"), true);
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

test('waits at the title and starts the embedded story from Stage and close-button clicks', async () => {
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
      if (status === 'finished') break;
      if (status === 'error') {
        assert.fail(`DSL 4.0 runtime failed: ${await extensionReporter(vm, 'lastErrorReporter')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finalStatus = await extensionReporter(vm, 'statusReporter');
    assert.equal(
      finalStatus,
      'finished',
      `DSL 4.0 runtime remained ${finalStatus} at startup timeout; threads=${JSON.stringify(
        vm.runtime.threads.map(({topBlock, status, stack}) => ({topBlock, status, stack})),
      )}`,
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
      if (status === 'finished') break;
      if (status === 'error') {
        assert.fail(`DSL 4.0 runtime failed: ${await extensionReporter(vm, 'lastErrorReporter')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'finished');
    assert.equal(closeTarget.visible, false);
  } finally {
    vm.quit();
    restoreGlobals();
  }
});

test('shows the browser-localized title and routes its close button through closeTitle', async () => {
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
    let titleRoot;
    while (Date.now() < titleDeadline) {
      vm.runtime._step();
      titleRoot = findByAttribute(document.body, 'data-dsl4-title-shell', 'true')[0];
      if (titleRoot?.style?.display === 'flex') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(titleRoot, 'The localized title must be mounted after green flag.');
    assert.equal(titleRoot.style.display, 'flex');
    assert.equal(titleRoot.children[0].children[2].textContent, '「参加型」AI紙芝居');
    assert.equal(titleRoot.children[0].children[4].textContent, '公式Webサイト');
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'title');

    titleRoot.children[0].children[1].click();
    const startupDeadline = Date.now() + 5_000;
    while (Date.now() < startupDeadline) {
      vm.runtime._step();
      const status = await extensionReporter(vm, 'statusReporter');
      if (status === 'finished') break;
      if (status === 'error') {
        assert.fail(`DSL 4.0 runtime failed: ${await extensionReporter(vm, 'lastErrorReporter')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'finished');
    assert.equal(titleRoot.style.display, 'none');
  } finally {
    vm.quit();
    restoreGlobals();
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
