import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4RuntimeSourceChooser} from '../src/dsl4/platform/runtime-source-chooser.js';
import {createFakeDocument, requireByAttribute, type FakeElement} from './helpers/fake-dom.ts';

/**
 * Read the root the chooser mounted.
 *
 * The external app-shell factory types its element as `HTMLElement`; this suite drives the module
 * with the fake document, so the read is named once rather than cast at each call.
 */
function chooserRoot(chooser: {element: unknown}): FakeElement {
  return chooser.element as unknown as FakeElement;
}

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
  const choices: string[] = [];
  const chooser = createDsl4RuntimeSourceChooser({
    document,
    mount: document.body,
    locales,
    onFile: () => choices.push('file'),
    onProject: () => choices.push('project'),
    onCancel: () => choices.push('cancel'),
  });

  chooser.show('ja', {fileEnabled: true, projectEnabled: false});
  assert.equal(chooserRoot(chooser).style.display, 'flex');
  const file = requireByAttribute(chooserRoot(chooser), 'data-dsl4-source-choice', 'file');
  const project = requireByAttribute(chooserRoot(chooser), 'data-dsl4-source-choice', 'project');
  const cancel = requireByAttribute(chooserRoot(chooser), 'data-dsl4-source-choice', 'cancel');
  assert.equal(file.getAttribute('aria-label'), locales.ja.openFile);
  assert.equal(project.getAttribute('aria-label'), locales.ja.openProject);
  assert.equal(cancel.getAttribute('aria-label'), locales.ja.cancel);
  assert.equal(project.disabled, true);
  file.click();
  project.click();
  cancel.click();
  await Promise.resolve();
  assert.deepEqual(choices, ['file', 'cancel']);

  chooser.hide();
  assert.equal(chooserRoot(chooser).style.display, 'none');
  chooser.dispose();
  assert.equal(chooser.element.parentNode, null);
});
