import assert from 'node:assert/strict';
import test from 'node:test';

import {createDsl4RuntimeTitleControls} from '../src/dsl4/platform/runtime-title-controls.js';
import {createFakeDocument, findByAttribute} from './helpers/fake-dom.mjs';

test('centers the title close icon without relying on font metrics', () => {
  const document = createFakeDocument();
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  let closeCount = 0;
  const controls = createDsl4RuntimeTitleControls({
    document,
    mount,
    locales: {
      en: {website: 'Official Website', close: 'Close'},
      ja: {website: '公式Webサイト', close: '閉じる'},
    },
    onWebsite() {},
    onClose() {
      closeCount += 1;
    },
  });

  const close = findByAttribute(controls.element, 'data-dsl4-title-action', 'close')[0];
  const icon = findByAttribute(close, 'data-dsl4-close-icon', 'true')[0];
  const lines = findByAttribute(icon, 'data-dsl4-close-icon-line', 'true');
  assert(close);
  assert(icon);
  assert.equal(lines.length, 2);
  assert.match(close.style.cssText, /left:92\.5%;top:1\.1111%;width:6\.6667%;height:8\.8889%/u);
  assert.doesNotMatch(close.style.cssText, /font:/u);
  assert.equal(close.textContent, '');
  assert.equal(icon.getAttribute('aria-hidden'), 'true');
  for (const line of lines) {
    assert.match(line.style.cssText, /left:50%;top:50%/u);
    assert.match(line.style.cssText, /transform:translate\(-50%,-50%\) rotate\((?:-)?45deg\)/u);
    assert.match(line.style.cssText, /transform-origin:center/u);
  }
  assert.notEqual(lines[0].style.cssText, lines[1].style.cssText);

  controls.show('ja');
  assert.equal(close.getAttribute('aria-label'), '閉じる');
  assert.equal(close.getAttribute('title'), '閉じる');
  close.click();
  assert.equal(closeCount, 1);
});
