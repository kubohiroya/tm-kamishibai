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
import {turbowarpVmCommit} from './helpers/turbowarp-vm.mjs';

const require = createRequire(import.meta.url);
const VirtualMachine = require('scratch-vm');
const dispatch = require('scratch-vm/src/dispatch/central-dispatch');
const vmLog = require('scratch-vm/src/util/log');
const extensionId = 'kubohiroyakamishibairuntime4';
const release = downloadableReleases.find(({series}) => series === '4.0');
assert(release, 'The release catalog must publish a DSL 4.0 artifact.');

async function buildRelease() {
  return createDownloadableReleaseSb3(release);
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
  const extensionUrl = project.extensionURLs[extensionId];

  assert.equal(turbowarpVmCommit, 'c4823421cb7c17d8d8a89878851ce1668c26a21f');
  assert.deepEqual(Object.keys(project.extensionURLs), [extensionId]);
  assert.match(extensionUrl, /^data:text\/javascript;base64,/u);
  assert(project.extensions.includes(extensionId));
  assert.equal(
    project.extensionStorage[extensionId].source.text.includes("kamishibai: '4.0'"),
    true,
  );
  assert.equal(project.extensionStorage[extensionId].artifact.controlProfile, 'production');
  assert.deepEqual(project.extensionStorage[extensionId].assets.manifest.assets, []);
  assert.equal(createHash('sha256').update(result.archive).digest('hex'), release.sha256);
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
    await loadProjectQuietly(vm, result.archive);
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
