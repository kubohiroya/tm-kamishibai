import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const extensionSource = await readFile(
  new URL('../app/extensions/kubohiroyaweblink.js', import.meta.url),
  'utf8',
);

function loadWebLinkExtension({unsandboxed = true} = {}) {
  const openedUrls = [];
  const registeredExtensions = [];
  const Scratch = {
    ArgumentType: {STRING: 'string'},
    BlockType: {COMMAND: 'command'},
    Cast: {toString: (value) => String(value)},
    extensions: {
      register: (extension) => registeredExtensions.push(extension),
      unsandboxed,
    },
    openWindow: async (url) => openedUrls.push(url),
  };

  vm.runInNewContext(extensionSource, {Scratch}, {filename: 'kubohiroyaweblink.js'});
  return {openedUrls, registeredExtensions};
}

test('registers the production Web Link extension and opens HTTPS URLs', async () => {
  const {openedUrls, registeredExtensions} = loadWebLinkExtension();

  assert.equal(registeredExtensions.length, 1);
  const extension = registeredExtensions[0];
  const info = extension.getInfo();
  assert.equal(info.id, 'kubohiroyaweblink');
  assert.equal(info.blocks.length, 1);
  assert.equal(info.blocks[0].opcode, 'openUrl');

  await extension.openUrl({URL: 'https://kubohiroya.github.io/tmpose-kamishibai/'});
  assert.deepEqual(openedUrls, ['https://kubohiroya.github.io/tmpose-kamishibai/']);
});

test('rejects non-HTTPS URLs without opening a browser tab', async () => {
  const {openedUrls, registeredExtensions} = loadWebLinkExtension();

  await assert.rejects(
    registeredExtensions[0].openUrl({URL: 'http://example.com/'}),
    /Web Link only opens HTTPS URLs/u,
  );
  assert.deepEqual(openedUrls, []);
});

test('rejects loading the production Web Link extension in a sandbox', () => {
  assert.throws(() => loadWebLinkExtension({unsandboxed: false}), /Web Link must run unsandboxed/u);
});
