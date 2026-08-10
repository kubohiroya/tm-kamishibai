import assert from 'node:assert/strict';
import test from 'node:test';

import {createDsl4RuntimeErrorIndicator} from '../src/dsl4/platform/runtime-error-indicator.js';
import {createFakeDocument, findByAttribute} from './helpers/fake-dom.mjs';

const locales = Object.freeze({
  en: Object.freeze({title: 'Invalid script'}),
  ja: Object.freeze({title: 'エラー：不正な台本ファイル'}),
});

test('shows a localized fatal diagnostic inside the supplied Scratch stage mount', () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {language: 'ja-JP', languages: ['ja-JP', 'en-US']},
  });
  const document = createFakeDocument();
  const mount = document.createElement('div');
  document.body.appendChild(mount);

  try {
    const indicator = createDsl4RuntimeErrorIndicator({document, mount, locales});
    const root = findByAttribute(mount, 'data-dsl4-runtime-error', 'true')[0];
    assert(root);
    assert.equal(root.style.position, 'absolute');
    assert.equal(root.style.cursor, 'auto');
    assert.equal(root.style.display, 'none');

    indicator.show({
      code: 'K4-HOST-PORT-MISSING',
      message: 'Runtime port method is required by the DSL 4.0 story: think',
    });
    assert.equal(root.style.display, 'flex');
    assert.equal(root.children[0].children[0].textContent, 'エラー：不正な台本ファイル');
    assert.equal(
      root.children[0].children[1].textContent,
      'Runtime port method is required by the DSL 4.0 story: think',
    );
    assert.equal(root.children[0].children[2].textContent, 'K4-HOST-PORT-MISSING');
    assert.equal(root.children[0].children[2].style.display, 'inline-block');

    indicator.hide();
    assert.equal(root.style.display, 'none');
    indicator.dispose();
    assert.equal(findByAttribute(mount, 'data-dsl4-runtime-error', 'true').length, 0);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
