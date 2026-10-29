import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4RuntimeErrorIndicator} from '../src/dsl4/platform/runtime-error-indicator.js';
import {createFakeDocument, findByAttribute, requireByAttribute} from './helpers/fake-dom.ts';
import {requireString} from './helpers/require-value.ts';

const locales = Object.freeze({
  en: Object.freeze({title: 'Invalid script'}),
  ja: Object.freeze({title: 'エラー：不正な台本ファイル'}),
});

test('shows the block/target and keeps the error visible on navigation failure, then hides on success', async () => {
  const document = createFakeDocument();
  const mount = document.createElement('div');
  let found = false;
  const indicator = createDsl4RuntimeErrorIndicator({
    document,
    mount,
    locales,
    initialLocale: 'ja',
    onLocateBlock: () => found,
  });
  const diagnostic = {message: '非対応ブロック', blockName: '（）回繰り返す', targetName: '案内役'};
  indicator.show(diagnostic, {locateBlock: true});
  const root = indicator.element;
  assert.equal(
    requireByAttribute(mount, 'data-dsl4-runtime-error-blockName', 'true').textContent,
    '（）回繰り返す',
  );
  assert.equal(
    requireByAttribute(mount, 'data-dsl4-runtime-error-targetName', 'true').textContent,
    '案内役',
  );
  const button = requireByAttribute(mount, 'data-dsl4-runtime-error-action', 'block');
  assert.equal(button.textContent, '該当ブロックを表示');
  assert.equal(document.activeElement, button);
  button.click();
  await Promise.resolve();
  assert.equal(root.style.display, 'flex');
  assert.match(
    requireByAttribute(mount, 'data-dsl4-runtime-error-locate-status', 'true').textContent,
    /コードタブ/u,
  );
  found = true;
  button.click();
  await Promise.resolve();
  assert.equal(root.style.display, 'none');
  indicator.show(diagnostic);
  assert.equal(button.hidden, true);
  indicator.dispose();
});

test('a late navigation result cannot dismiss a newer diagnostic', async () => {
  const document = createFakeDocument();
  const mount = document.createElement('div');
  let finish: (found: boolean) => void = () => {};
  const indicator = createDsl4RuntimeErrorIndicator({
    document,
    mount,
    locales,
    onLocateBlock: () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  });
  indicator.show({message: 'first'}, {locateBlock: true});
  requireByAttribute(mount, 'data-dsl4-runtime-error-action', 'block').click();
  indicator.show({message: 'second'});
  finish(true);
  await Promise.resolve();
  assert.equal(indicator.element.style.display, 'flex');
  assert.equal(
    requireByAttribute(mount, 'data-dsl4-runtime-error-originalMessage', 'true').textContent,
    'second',
  );
  indicator.dispose();
});

test('shows a localized structured diagnostic and returns to the menu from the Stage', async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {language: 'ja-JP', languages: ['ja-JP', 'en-US']},
  });
  const document = createFakeDocument();
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  let returnCount = 0;

  try {
    const indicator = createDsl4RuntimeErrorIndicator({
      document,
      mount,
      locales,
      onReturnToMenu: async () => {
        returnCount += 1;
      },
    });
    const root = requireByAttribute(mount, 'data-dsl4-runtime-error', 'true');
    const title = requireByAttribute(root, 'data-dsl4-runtime-error-title', 'true');
    const message = requireByAttribute(root, 'data-dsl4-runtime-error-message', 'true');
    const code = requireByAttribute(root, 'data-dsl4-runtime-error-code', 'true');
    const source = requireByAttribute(root, 'data-dsl4-runtime-error-source', 'true');
    const location = requireByAttribute(root, 'data-dsl4-runtime-error-location', 'true');
    const path = requireByAttribute(root, 'data-dsl4-runtime-error-path', 'true');
    const excerpt = requireByAttribute(root, 'data-dsl4-runtime-error-excerpt', 'true');
    const returnButton = requireByAttribute(root, 'data-dsl4-runtime-error-action', 'menu');
    assert.equal(root.style.position, 'absolute');
    assert.equal(root.style.cursor, 'auto');
    assert.equal(root.style.display, 'none');

    indicator.show(
      {
        code: 'K4-HOST-PORT-MISSING',
        message: 'Runtime port method is required by the DSL 4.0 story: think',
        displayName: 'stories/very-long-story-name.kamishibai.yaml',
        range: {start: {line: 42, column: 17}},
        path: '$.scenes.opening[0].think',
        excerpt: '    - think: this line can wrap without leaving the dialog',
      },
      {returnToMenu: true},
    );
    assert.equal(root.style.display, 'flex');
    assert.equal(title.textContent, 'この実行環境では処理を実行できません');
    assert.equal(
      requireByAttribute(root, 'data-dsl4-runtime-error-originalMessage', 'true').textContent,
      'Runtime port method is required by the DSL 4.0 story: think',
    );
    assert.equal(code.textContent, 'K4-HOST-PORT-MISSING');
    assert.equal(source.textContent, 'stories/very-long-story-name.kamishibai.yaml');
    assert.equal(location.textContent, '42:17');
    assert.equal(path.textContent, '$.scenes.opening[0].think');
    assert.match(
      requireString(excerpt.children[0]!.textContent, 'the excerpt text'),
      /this line can wrap/u,
    );
    assert.match(
      requireString(message.style.cssText, 'the message style'),
      /overflow-wrap:anywhere/u,
    );
    assert.equal(returnButton.textContent, 'メニューに戻る');
    assert.equal(document.activeElement, returnButton);
    returnButton.click();
    await Promise.resolve();
    assert.equal(returnCount, 1);

    indicator.show({
      title: '紙芝居の実行エラー',
      message: 'The camera runtime is unavailable.',
    });
    assert.equal(title.textContent, '紙芝居を続けられませんでした');
    assert.equal(message.textContent, '原因を特定できませんでした。');
    assert.equal(code.style.display, 'none');
    assert.equal(returnButton.hidden, false);

    indicator.hide();
    assert.equal(root.style.display, 'none');
    indicator.dispose();
    assert.equal(findByAttribute(mount, 'data-dsl4-runtime-error', 'true').length, 0);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('default UI provides explanation, recovery, technical details and a close action without host navigation', () => {
  const document = createFakeDocument();
  const indicator = createDsl4RuntimeErrorIndicator({
    document,
    mount: document.body,
    locales,
    initialLocale: 'ja',
  });
  indicator.show({
    code: 'K4-SCHEMA-001',
    message: 'must have required property',
    validation: {keyword: 'required', field: 'asset'},
    storyPath: '/scenes/opening/actions/1',
  });
  const root = indicator.element;
  assert.match(
    requireByAttribute(document.body, 'data-dsl4-runtime-error-message', 'true').textContent,
    /必須項目「asset」/u,
  );
  assert.match(
    requireByAttribute(document.body, 'data-dsl4-runtime-error-recovery', 'true').textContent,
    /追加/u,
  );
  assert.match(
    requireByAttribute(document.body, 'data-dsl4-runtime-error-where', 'true').textContent,
    /2番目/u,
  );
  assert.equal(
    requireByAttribute(document.body, 'data-dsl4-runtime-error-technical', 'true').tagName,
    'DETAILS',
  );
  assert.equal(
    requireByAttribute(document.body, 'data-dsl4-runtime-error-action', 'copy').hidden,
    false,
  );
  const close = requireByAttribute(document.body, 'data-dsl4-runtime-error-action', 'close');
  assert.equal(close.hidden, false);
  close.click();
  assert.equal(root.style.display, 'none');
  indicator.dispose();
});

test('clipboard failure offers selected diagnostic text and late completions cannot alter a new diagnostic', async () => {
  const document = createFakeDocument();
  let resolve: (() => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  let copied = '';
  const indicator = createDsl4RuntimeErrorIndicator({
    document,
    mount: document.body,
    locales,
    initialLocale: 'ja',
    runtimeVersion: 'test-version',
    writeClipboard: (value) => {
      copied = value;
      return new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
    },
  });
  indicator.show({code: 'K4-UNKNOWN', message: 'first'});
  const copy = requireByAttribute(document.body, 'data-dsl4-runtime-error-action', 'copy');
  copy.click();
  assert.match(copied, /test-version/u);
  reject!(new Error('denied'));
  await Promise.resolve();
  const report = requireByAttribute(document.body, 'data-dsl4-runtime-error-report', 'true');
  assert.equal(report.hidden, false);
  assert.match(report.value, /first/u);
  assert.equal(document.activeElement, report);
  indicator.show({message: 'second'});
  copy.click();
  indicator.show({message: 'third'});
  resolve!();
  await Promise.resolve();
  assert.equal(report.hidden, true);
  assert.equal(
    requireByAttribute(document.body, 'data-dsl4-runtime-error-locate-status', 'true').textContent,
    '',
  );
  assert.equal(
    requireByAttribute(document.body, 'data-dsl4-runtime-error-originalMessage', 'true')
      .textContent,
    'third',
  );
  indicator.dispose();
});

test('failed menu navigation preserves the error and offers closing without unhandled rejection', async () => {
  const document = createFakeDocument();
  const indicator = createDsl4RuntimeErrorIndicator({
    document,
    mount: document.body,
    locales,
    initialLocale: 'ja',
    onReturnToMenu: async () => {
      throw new Error('failed');
    },
  });
  indicator.show({message: 'original'});
  requireByAttribute(document.body, 'data-dsl4-runtime-error-action', 'menu').click();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(indicator.element.style.display, 'flex');
  assert.equal(
    requireByAttribute(document.body, 'data-dsl4-runtime-error-action', 'close').hidden,
    false,
  );
  assert.match(
    requireByAttribute(document.body, 'data-dsl4-runtime-error-locate-status', 'true').textContent,
    /戻れません/u,
  );
  indicator.dispose();
});

test('source navigation is offered only for editable original source and does not resume playback', async () => {
  const document = createFakeDocument();
  let opened: unknown;
  const indicator = createDsl4RuntimeErrorIndicator({
    document,
    mount: document.body,
    locales,
    onLocateSource: async (diagnostic) => {
      opened = diagnostic.sourceId;
      return true;
    },
  });
  indicator.show({sourceId: 'story.kamishibai.yaml'}, {locateSource: true});
  const source = requireByAttribute(document.body, 'data-dsl4-runtime-error-action', 'source');
  assert.equal(source.hidden, false);
  source.click();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(opened, 'story.kamishibai.yaml');
  assert.equal(indicator.element.style.display, 'none');
  indicator.show(
    {sourceId: 'generated.kamishibai.yaml', generatedSource: true},
    {locateSource: true},
  );
  assert.equal(source.hidden, true);
  indicator.dispose();
});
