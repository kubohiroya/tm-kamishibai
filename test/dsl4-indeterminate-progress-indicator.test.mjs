import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDsl4IndeterminateProgressIndicator,
  createDsl4StandardAppShell,
} from '../src/dsl4/platform/index.js';
import {createFakeDocument, findByAttribute} from './helpers/fake-dom.mjs';

test('renders an indeterminate progressbar while asset and camera waits overlap', async () => {
  const document = createFakeDocument();
  const indicator = createDsl4IndeterminateProgressIndicator({
    document,
    mount: document.body,
  });

  indicator.setBusy({visible: true, source: 'assets', label: 'Loading assets'});
  const root = findByAttribute(document.body, 'role', 'progressbar')[0];
  assert.ok(root);
  assert.equal(root.hidden, false);
  assert.equal(root.getAttribute('aria-busy'), 'true');
  assert.equal(root.getAttribute('aria-label'), 'Loading assets');
  assert.equal(root.getAttribute('aria-valuenow'), null);
  assert.equal(root.dataset.dsl4IndeterminateProgress, 'true');
  assert.equal(root.dataset.dsl4IndeterminateProgressVariant, 'circular');
  assert.equal(root.style.position, 'fixed');
  assert.equal(root.style.zIndex, '2147483647');
  assert.equal(root.style.background, 'rgba(0, 0, 0, 0.12)');

  indicator.setVariant('bar');
  assert.equal(root.dataset.dsl4IndeterminateProgressVariant, 'bar');
  assert.equal(root.children[1].dataset.dsl4IndeterminateProgressTrack, 'true');
  assert.equal(root.children[1].children[0].dataset.dsl4IndeterminateProgressFill, 'true');

  indicator.setBusy({visible: true, source: 'camera', label: 'Starting camera'});
  indicator.setBusy({visible: false, source: 'assets', label: 'Loading assets'});
  assert.equal(root.hidden, false);
  assert.equal(root.getAttribute('aria-label'), 'Starting camera');

  indicator.setBusy({visible: false, source: 'camera', label: 'Starting camera'});
  assert.equal(root.hidden, true);
  assert.equal(root.getAttribute('aria-busy'), 'false');

  indicator.setCursor({visible: true, source: 'pose', cursor: 'progress'});
  assert.equal(document.body.dataset.dsl4CursorSurface, 'true');
  assert.equal(document.body.dataset.dsl4Cursor, 'progress');
  indicator.setCursor({visible: true, source: 'camera', cursor: 'wait'});
  assert.equal(document.body.dataset.dsl4Cursor, 'wait');
  indicator.setCursor({visible: false, source: 'camera', cursor: 'wait'});
  assert.equal(document.body.dataset.dsl4Cursor, 'progress');
  indicator.setCursor({visible: false, source: 'pose', cursor: 'progress'});
  assert.equal(document.body.dataset.dsl4Cursor, 'auto');

  indicator.dispose();
  assert.equal(document.body.children.length, 0);
});

test('Standard app shell wires loading and camera waits to the shared indicator', async () => {
  const document = createFakeDocument();
  let hostOptions = null;
  const shell = await createDsl4StandardAppShell({
    featureFlags: {dsl4Runtime: true, dsl4AppShell: true},
    surface: 'developmentPreview',
    document,
    mount: document.body,
    progressIndicator: {variant: 'bar'},
    runtimeHostOptions: {
      setLoading() {},
    },
    createRuntimeHost(options) {
      hostOptions = options;
      return {
        ok: true,
        enabled: true,
        diagnostics: [],
        host: {dispose() {}},
      };
    },
  });

  assert.equal(typeof hostOptions.setLoading, 'function');
  assert.equal(typeof hostOptions.setBusy, 'function');
  assert.equal(typeof hostOptions.setCursor, 'function');
  hostOptions.setLoading({visible: true}, {});
  const root = findByAttribute(document.body, 'role', 'progressbar')[0];
  assert.ok(root);
  assert.equal(root.dataset.dsl4IndeterminateProgressVariant, 'bar');
  assert.equal(root.hidden, false);
  hostOptions.setBusy({visible: true, source: 'camera', label: 'Starting camera'});
  hostOptions.setLoading({visible: false}, {});
  assert.equal(root.hidden, false);
  hostOptions.setBusy({visible: false, source: 'camera', label: 'Starting camera'});
  assert.equal(root.hidden, true);
  hostOptions.setCursor({visible: true, source: 'pose', cursor: 'progress'});
  assert.equal(document.body.dataset.dsl4Cursor, 'progress');
  hostOptions.setCursor({visible: false, source: 'pose', cursor: 'progress'});
  assert.equal(document.body.dataset.dsl4Cursor, 'auto');

  await shell.dispose('indicator-test');
  assert.equal(document.body.children.length, 0);
});

test('Standard app shell restores localized title controls and lifecycle visibility', async () => {
  const document = createFakeDocument();
  const opened = [];
  const previousOpen = globalThis.open;
  globalThis.open = (...args) => opened.push(args);
  let hostOptions;
  let closed = 0;
  let started = 0;
  try {
    const shell = await createDsl4StandardAppShell({
      featureFlags: {dsl4Runtime: true, dsl4AppShell: true},
      surface: 'regularEditor',
      document,
      mount: document.body,
      title: {
        version: '4.0.0-dev',
        officialWebsiteUrl: 'https://kubohiroya.github.io/tmpose-kamishibai/',
        initialLocale: 'en',
        locales: {
          en: {
            title: 'Participatory AI Kamishibai',
            officialWebsite: 'Official Website',
            close: 'Close',
            language: '日本語',
          },
          ja: {
            title: '「参加型」AI紙芝居',
            officialWebsite: '公式Webサイト',
            close: '閉じる',
            language: 'English',
          },
        },
      },
      runtimeHostOptions: {
        onCloseTitle() {
          closed += 1;
        },
        onTitleStart() {
          started += 1;
        },
      },
      createRuntimeHost(options) {
        hostOptions = options;
        return {ok: true, enabled: true, diagnostics: [], host: {dispose() {}}};
      },
    });
    const titleRoot = findByAttribute(document.body, 'data-dsl4-title-shell', 'true')[0];
    assert.ok(titleRoot);
    const panel = titleRoot.children[0];
    const language = panel.children[0];
    const close = panel.children[1];
    const heading = panel.children[2];
    const official = panel.children[4];
    assert.equal(titleRoot.style.display, 'none');
    assert.equal(titleRoot.style.position, 'absolute');
    assert.equal(titleRoot.style.cursor, 'pointer');
    assert.equal(panel.style.cursor, 'pointer');
    assert.equal(close.style.position, 'absolute');
    assert.equal(language.style.position, 'absolute');
    assert.equal(language.style.cursor, 'pointer');
    assert.equal(close.style.cursor, 'pointer');
    assert.equal(official.style.cursor, 'pointer');
    assert.equal(heading.textContent, 'Participatory AI Kamishibai');
    assert.equal(official.textContent, 'Official Website');
    language.click();
    assert.equal(heading.textContent, '「参加型」AI紙芝居');
    assert.equal(official.textContent, '公式Webサイト');
    official.click();
    assert.deepEqual(opened, [
      ['https://kubohiroya.github.io/tmpose-kamishibai/', '_blank', 'noopener,noreferrer'],
    ]);
    shell.showTitle();
    titleRoot.click();
    assert.equal(started, 1);
    assert.equal(titleRoot.style.display, 'none');
    shell.showTitle();
    close.click();
    assert.equal(closed, 1);
    assert.equal(started, 1);
    assert.equal(titleRoot.style.display, 'none');
    hostOptions.onEvent({type: 'runtime.start'});
    assert.equal(titleRoot.style.display, 'none');
    hostOptions.onEvent({type: 'runtime.finish'});
    assert.equal(titleRoot.style.display, 'none');
    hostOptions.onEvent({type: 'runtime.fail'});
    assert.equal(titleRoot.style.display, 'none');
    shell.showTitle();
    assert.equal(titleRoot.style.display, 'flex');
    titleRoot.click();
    assert.equal(started, 1);
    assert.equal(titleRoot.style.display, 'none');
    await shell.dispose('title-controls-test');
    assert.equal(document.body.children.length, 0);
  } finally {
    if (previousOpen === undefined) delete globalThis.open;
    else globalThis.open = previousOpen;
  }
});

test('selects Japanese as the default title locale from browser preferences', async () => {
  const document = createFakeDocument();
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {language: 'ja-JP', languages: ['ja-JP', 'en-US']},
  });
  try {
    const shell = await createDsl4StandardAppShell({
      featureFlags: {dsl4Runtime: true, dsl4AppShell: true},
      surface: 'regularEditor',
      document,
      mount: document.body,
      title: {
        version: '4.0.0-dev',
        officialWebsiteUrl: 'https://kubohiroya.github.io/tmpose-kamishibai/',
        locales: {
          en: {
            title: 'Participatory AI Kamishibai',
            officialWebsite: 'Official Website',
            close: 'Close',
            language: '日本語',
          },
          ja: {
            title: '「参加型」AI紙芝居',
            officialWebsite: '公式Webサイト',
            close: '閉じる',
            language: 'English',
          },
        },
      },
      runtimeHostOptions: {},
      createRuntimeHost() {
        return {ok: true, enabled: true, diagnostics: [], host: {dispose() {}}};
      },
    });
    const titleRoot = findByAttribute(document.body, 'data-dsl4-title-shell', 'true')[0];
    assert.equal(titleRoot.children[0].children[2].textContent, '「参加型」AI紙芝居');
    assert.equal(titleRoot.children[0].children[4].textContent, '公式Webサイト');
    await shell.dispose('browser-locale-test');
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
  }
});
