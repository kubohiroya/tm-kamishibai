import assert from 'node:assert/strict';
import test from 'node:test';

import {createDsl4RuntimeSourceChooser} from '../src/dsl4/platform/runtime-source-chooser.js';
import {createFakeDocument, findByAttribute} from './helpers/fake-dom.mjs';

const locales = {
  en: {openFile: 'Open story file', openProject: 'Open project directory', cancel: 'Cancel'},
  ja: {
    openFile: '台本ファイルを開く',
    openProject: 'プロジェクトディレクトリを開く',
    cancel: 'キャンセル',
  },
};

test('chooses a story file or project directory without closing the application menu flow', async () => {
  const document = createFakeDocument();
  const choices = [];
  const chooser = createDsl4RuntimeSourceChooser({
    document,
    mount: document.body,
    locales,
    onFile: () => choices.push('file'),
    onProject: () => choices.push('project'),
    onCancel: () => choices.push('cancel'),
  });

  chooser.show('ja', {fileEnabled: true, projectEnabled: false});
  assert.equal(chooser.element.style.display, 'flex');
  const file = findByAttribute(chooser.element, 'data-dsl4-source-choice', 'file')[0];
  const project = findByAttribute(chooser.element, 'data-dsl4-source-choice', 'project')[0];
  const cancel = findByAttribute(chooser.element, 'data-dsl4-source-choice', 'cancel')[0];
  assert.equal(file.textContent, locales.ja.openFile);
  assert.equal(project.textContent, locales.ja.openProject);
  assert.equal(project.disabled, true);
  file.click();
  project.click();
  cancel.click();
  await Promise.resolve();
  assert.deepEqual(choices, ['file', 'cancel']);

  chooser.hide();
  assert.equal(chooser.element.style.display, 'none');
  chooser.dispose();
  assert.equal(chooser.element.parentNode, null);
});
