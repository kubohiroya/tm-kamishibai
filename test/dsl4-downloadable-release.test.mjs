import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {runInThisContext} from 'node:vm';
import test from 'node:test';

import {strFromU8, unzipSync} from 'fflate';

import {createKamishibaiSb3} from '../scripts/sb3/build.mjs';
import {turbowarpVmCommit} from './helpers/turbowarp-vm.mjs';

const require = createRequire(import.meta.url);
const VirtualMachine = require('scratch-vm');
const dispatch = require('scratch-vm/src/dispatch/central-dispatch');
const extensionId = 'kubohiroyakamishibairuntime4';
const sourceDirectory = 'release-sources/4.0.0-dev/app';

async function buildRelease() {
  return createKamishibaiSb3({
    sourceDirectory,
    faviconPath: 'site/favicon.png',
    version: '4.0.0-dev',
    buildDate: '2026-08-07',
  });
}

function installUnsandboxedScriptDom() {
  const previous = {
    document: globalThis.document,
    location: globalThis.location,
    Scratch: globalThis.Scratch,
    ScratchExtensions: globalThis.ScratchExtensions,
  };
  globalThis.location = {href: 'https://release.test/'};
  globalThis.document = {
    visibilityState: 'visible',
    scripts: [],
    addEventListener() {},
    removeEventListener() {},
    createElement(tagName) {
      assert.equal(tagName, 'script');
      return {onerror: null, src: ''};
    },
    body: {
      appendChild(script) {
        try {
          const prefix = 'data:text/javascript;base64,';
          assert(script.src.startsWith(prefix), 'The release extension must be embedded.');
          const source = Buffer.from(script.src.slice(prefix.length), 'base64').toString('utf8');
          runInThisContext(source, {filename: `${extensionId}.js`});
        } catch (error) {
          script.onerror?.(error);
        }
      },
    },
  };
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(globalThis, name);
      else globalThis[name] = value;
    }
  };
}

async function extensionReporter(vm, opcode) {
  const service = vm.extensionManager._loadedExtensions.get(extensionId);
  assert(service, 'The embedded DSL 4.0 runtime extension was not loaded.');
  return dispatch.call(service, opcode);
}

test('builds one self-contained DSL 4.0 release with a pinned runtime extension', async () => {
  const result = await buildRelease();
  const archive = unzipSync(result.archive);
  const project = JSON.parse(strFromU8(archive['project.json']));
  const extensionUrl = project.extensionURLs[extensionId];

  assert.equal(turbowarpVmCommit, 'c4823421cb7c17d8d8a89878851ce1668c26a21f');
  assert.match(extensionUrl, /^data:text\/javascript;base64,/u);
  assert(project.extensions.includes(extensionId));
  assert.equal(
    project.extensionStorage[extensionId].source.text.includes("kamishibai: '4.0'"),
    true,
  );
  assert.equal(project.extensionStorage[extensionId].artifact.controlProfile, 'production');
  assert.deepEqual(project.extensionStorage[extensionId].assets.manifest.assets, []);
  assert.doesNotMatch(extensionUrl, /https?:\/\//u);
  assert.equal(createHash('sha256').update(result.archive).digest('hex').length, 64);
});

test('starts and finishes the downloaded DSL 4.0 story in the pinned TurboWarp VM', async () => {
  const result = await buildRelease();
  const restoreGlobals = installUnsandboxedScriptDom();
  const vm = new VirtualMachine();
  try {
    vm.setCompatibilityMode(false);
    vm.setTurboMode(false);
    vm.setCompilerOptions({enabled: false});
    vm.securityManager.canLoadExtensionFromProject = () => true;
    vm.securityManager.getSandboxMode = () => 'unsandboxed';
    await vm.loadProject(result.archive);
    vm.runtime.renderer = {
      createSVGSkin() {
        return 1;
      },
      destroySkin() {},
      updateDrawableSkinId() {},
    };

    assert.equal(await extensionReporter(vm, 'versionReporter'), '4.0.0-dev');
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'ready');
    vm.greenFlag();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const status = await extensionReporter(vm, 'statusReporter');
      if (status === 'finished') break;
      if (status === 'error') {
        assert.fail(`DSL 4.0 runtime failed: ${await extensionReporter(vm, 'lastErrorReporter')}`);
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'finished');
  } finally {
    vm.quit();
    restoreGlobals();
  }
});
