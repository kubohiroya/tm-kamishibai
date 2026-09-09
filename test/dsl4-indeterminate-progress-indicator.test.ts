import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
  createDsl4IndeterminateProgressIndicator,
  createDsl4StandardAppShell,
} from '../src/dsl4/platform/index.js';
import {createFakeDocument, requireByAttribute} from './helpers/fake-dom.ts';
import {requireDefined, requireRecord} from './helpers/require-value.ts';

/**
 * Read the app shell as one that started its runtime.
 *
 * The factory's result is a union: a shell with title controls, or the disabled one it returns when
 * the runtime flag is off. These cases pass the flag, so they read the enabled half.
 */
function requireShell(shell: unknown) {
  return requireRecord(shell, 'the app shell') as unknown as {showTitle: () => void};
}

/** The three callbacks the app shell hands its runtime host. */
interface RuntimeHostOptions {
  setLoading: (state: unknown, context: unknown) => unknown;
  setBusy: (state: unknown) => unknown;
  setCursor: (state: unknown) => unknown;
}

test('renders an indeterminate progressbar while asset and camera waits overlap', async () => {
  const document = createFakeDocument();
  const indicator = createDsl4IndeterminateProgressIndicator({
    document,
    mount: document.body,
  });

  indicator.setBusy({visible: true, source: 'assets', label: 'Loading assets'});
  const root = requireByAttribute(document.body, 'role', 'progressbar');
  assert.equal(root.hidden, false);
  assert.equal(root.getAttribute('aria-busy'), 'true');
  assert.equal(root.getAttribute('aria-label'), 'Loading assets');
  assert.equal(root.getAttribute('aria-valuenow'), null);
  assert.equal(root.dataset.dsl4IndeterminateProgress, 'true');
  assert.equal(root.dataset.dsl4IndeterminateProgressVariant, 'circular');
  assert.equal(root.style.position, 'absolute');
  assert.equal(root.style.zIndex, '2147483647');
  assert.equal(root.style.background, 'rgba(0, 0, 0, 0.12)');

  indicator.setVariant('bar');
  assert.equal(root.dataset.dsl4IndeterminateProgressVariant, 'bar');
  const track = requireDefined(root.children[1], 'the progress track');
  assert.equal(track.dataset.dsl4IndeterminateProgressTrack, 'true');
  assert.equal(
    requireDefined(track.children[0], 'the progress fill').dataset.dsl4IndeterminateProgressFill,
    'true',
  );

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
  const cursorStyle = requireDefined(
    document.body.children.find((child) => child.dataset.dsl4CursorStyles === 'true'),
    'the cursor style element',
  );
  assert.match(
    cursorStyle.textContent,
    /data-dsl4-cursor="pointer"\] canvas\{cursor:pointer!important\}/u,
  );
  assert.doesNotMatch(cursorStyle.textContent, /data-dsl4-cursor="auto"\] canvas/u);
  assert.match(cursorStyle.textContent, /button:not\(:disabled\):not\(\[aria-disabled="true"\]\)/u);
  assert.match(cursorStyle.textContent, /button:disabled.*cursor:not-allowed/u);
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
  // Recorded through a holder: a `let` assigned inside the callback keeps its initial narrowing at
  // every use below, while a property read reflects what the shell actually handed over.
  const host: {options?: RuntimeHostOptions} = {};
  const shell = await createDsl4StandardAppShell({
    featureFlags: {dsl4Runtime: true, dsl4AppShell: true},
    surface: 'developmentPreview',
    document,
    mount: document.body,
    progressIndicator: {variant: 'bar'},
    runtimeHostOptions: {
      setLoading() {},
    },
    async createRuntimeHost(options: Record<string, unknown>) {
      host.options = options as unknown as RuntimeHostOptions;
      return {
        ok: true,
        enabled: true,
        diagnostics: [],
        host: {dispose() {}},
      };
    },
  });

  assert.equal(
    typeof requireDefined(host.options, 'the runtime host options').setLoading,
    'function',
  );
  assert.equal(typeof requireDefined(host.options, 'the runtime host options').setBusy, 'function');
  assert.equal(
    typeof requireDefined(host.options, 'the runtime host options').setCursor,
    'function',
  );
  requireDefined(host.options, 'the runtime host options').setLoading({visible: true}, {});
  const root = requireByAttribute(document.body, 'role', 'progressbar');
  assert.equal(root.dataset.dsl4IndeterminateProgressVariant, 'bar');
  assert.equal(root.hidden, false);
  requireDefined(host.options, 'the runtime host options').setLoading(
    {
      visible: true,
      resources: {backdrop: 'blob:loading-backdrop', costumes: ['blob:loading-costume']},
    },
    {},
  );
  const loadingScreen = requireByAttribute(document.body, 'data-dsl4-loading-screen', 'true');
  assert.equal(loadingScreen.style.position, 'absolute');
  assert.equal(loadingScreen.style.display, 'flex');
  assert.equal(loadingScreen.getAttribute('aria-hidden'), 'true');
  assert.equal(
    requireDefined(loadingScreen.children[0], 'the loading backdrop').src,
    'blob:loading-backdrop',
  );
  assert.equal(
    requireDefined(loadingScreen.children[1], 'the loading costume').src,
    'blob:loading-costume',
  );
  requireDefined(host.options, 'the runtime host options').setLoading({visible: false}, {});
  assert.equal(loadingScreen.style.display, 'none');
  requireDefined(host.options, 'the runtime host options').setBusy({
    visible: true,
    source: 'camera',
    label: 'Starting camera',
  });
  requireDefined(host.options, 'the runtime host options').setLoading({visible: false}, {});
  assert.equal(root.hidden, false);
  requireDefined(host.options, 'the runtime host options').setBusy({
    visible: false,
    source: 'camera',
    label: 'Starting camera',
  });
  assert.equal(root.hidden, true);
  requireDefined(host.options, 'the runtime host options').setCursor({
    visible: true,
    source: 'pose',
    cursor: 'progress',
  });
  assert.equal(document.body.dataset.dsl4Cursor, 'progress');
  requireDefined(host.options, 'the runtime host options').setCursor({
    visible: false,
    source: 'pose',
    cursor: 'progress',
  });
  assert.equal(document.body.dataset.dsl4Cursor, 'auto');

  await shell.dispose('indicator-test');
  assert.equal(document.body.children.length, 0);
});

test('Standard app shell restores localized title controls and lifecycle visibility', async () => {
  const document = createFakeDocument();
  const opened: unknown[][] = [];
  const previousOpen = globalThis.open;
  // The shell only calls `open`; the case records the arguments rather than opening a window.
  globalThis.open = ((...args: unknown[]) => {
    opened.push(args);
    return null;
  }) as unknown as typeof globalThis.open;
  const shellHost: {options?: {onEvent: (event: unknown) => unknown}} = {};
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
        officialWebsiteUrl: 'https://kubohiroya.github.io/tm-kamishibai/',
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
      async createRuntimeHost(options: Record<string, unknown>) {
        shellHost.options = options as unknown as {onEvent: (event: unknown) => unknown};
        return {ok: true, enabled: true, diagnostics: [], host: {dispose() {}}};
      },
    });
    const titleRoot = requireByAttribute(document.body, 'data-dsl4-title-shell', 'true');
    const panel = requireDefined(titleRoot.children[0], 'the title panel');
    const language = requireDefined(panel.children[0], 'the language control');
    const close = requireDefined(panel.children[1], 'the close control');
    const heading = requireDefined(panel.children[2], 'the heading');
    const official = requireDefined(panel.children[4], 'the official website link');
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
      ['https://kubohiroya.github.io/tm-kamishibai/', '_blank', 'noopener,noreferrer'],
    ]);
    requireShell(shell).showTitle();
    titleRoot.click();
    assert.equal(started, 1);
    assert.equal(titleRoot.style.display, 'none');
    requireShell(shell).showTitle();
    close.click();
    assert.equal(closed, 1);
    assert.equal(started, 1);
    assert.equal(titleRoot.style.display, 'none');
    requireDefined(shellHost.options, 'the runtime host options').onEvent({type: 'runtime.start'});
    assert.equal(titleRoot.style.display, 'none');
    requireDefined(shellHost.options, 'the runtime host options').onEvent({type: 'runtime.finish'});
    assert.equal(titleRoot.style.display, 'none');
    requireDefined(shellHost.options, 'the runtime host options').onEvent({type: 'runtime.fail'});
    assert.equal(titleRoot.style.display, 'none');
    requireShell(shell).showTitle();
    assert.equal(titleRoot.style.display, 'flex');
    titleRoot.click();
    assert.equal(started, 1);
    assert.equal(titleRoot.style.display, 'none');
    await shell.dispose('title-controls-test');
    assert.equal(document.body.children.length, 0);
  } finally {
    // Both globals are declared as always present, so restoring "absent" is a deliberate delete.
    if (previousOpen === undefined) Reflect.deleteProperty(globalThis, 'open');
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
        officialWebsiteUrl: 'https://kubohiroya.github.io/tm-kamishibai/',
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
      async createRuntimeHost() {
        return {ok: true, enabled: true, diagnostics: [], host: {dispose() {}}};
      },
    });
    const titleRoot = requireByAttribute(document.body, 'data-dsl4-title-shell', 'true');
    const panel = requireDefined(titleRoot.children[0], 'the title panel');
    assert.equal(
      requireDefined(panel.children[2], 'the heading').textContent,
      '「参加型」AI紙芝居',
    );
    assert.equal(
      requireDefined(panel.children[4], 'the official website link').textContent,
      '公式Webサイト',
    );
    await shell.dispose('browser-locale-test');
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
