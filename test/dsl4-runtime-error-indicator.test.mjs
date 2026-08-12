import assert from 'node:assert/strict';
import test from 'node:test';

import {createDsl4RuntimeErrorIndicator} from '../src/dsl4/platform/runtime-error-indicator.js';
import {createFakeDocument, findByAttribute} from './helpers/fake-dom.mjs';

const locales = Object.freeze({
  en: Object.freeze({title: 'Invalid script'}),
  ja: Object.freeze({title: 'エラー：不正な台本ファイル'}),
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
    const root = findByAttribute(mount, 'data-dsl4-runtime-error', 'true')[0];
    const title = findByAttribute(root, 'data-dsl4-runtime-error-title', 'true')[0];
    const message = findByAttribute(root, 'data-dsl4-runtime-error-message', 'true')[0];
    const code = findByAttribute(root, 'data-dsl4-runtime-error-code', 'true')[0];
    const source = findByAttribute(root, 'data-dsl4-runtime-error-source', 'true')[0];
    const location = findByAttribute(root, 'data-dsl4-runtime-error-location', 'true')[0];
    const path = findByAttribute(root, 'data-dsl4-runtime-error-path', 'true')[0];
    const excerpt = findByAttribute(root, 'data-dsl4-runtime-error-excerpt', 'true')[0];
    const returnButton = findByAttribute(root, 'data-dsl4-runtime-error-action', 'menu')[0];
    assert(root);
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
    assert.equal(title.textContent, 'エラー：不正な台本ファイル');
    assert.equal(
      message.textContent,
      'Runtime port method is required by the DSL 4.0 story: think',
    );
    assert.equal(code.textContent, 'K4-HOST-PORT-MISSING');
    assert.equal(source.textContent, 'stories/very-long-story-name.kamishibai.yaml');
    assert.equal(location.textContent, '42:17');
    assert.equal(path.textContent, '$.scenes.opening[0].think');
    assert.match(excerpt.textContent, /this line can wrap/u);
    assert.match(message.style.cssText, /overflow-wrap:anywhere/u);
    assert.equal(returnButton.textContent, 'メニューに戻る');
    assert.equal(document.activeElement, returnButton);
    returnButton.click();
    await Promise.resolve();
    assert.equal(returnCount, 1);

    indicator.show({
      title: '紙芝居の実行エラー',
      message: 'The camera runtime is unavailable.',
    });
    assert.equal(title.textContent, '紙芝居の実行エラー');
    assert.equal(message.textContent, 'The camera runtime is unavailable.');
    assert.equal(code.style.display, 'none');
    assert.equal(returnButton.parentNode.style.display, 'none');

    indicator.hide();
    assert.equal(root.style.display, 'none');
    indicator.dispose();
    assert.equal(findByAttribute(mount, 'data-dsl4-runtime-error', 'true').length, 0);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
