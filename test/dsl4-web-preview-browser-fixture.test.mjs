import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'vitest';

const html = await readFile(
  new URL('fixtures/dsl4/web-preview-browser.html', import.meta.url),
  'utf8',
);
const moduleSource = await readFile(
  new URL('fixtures/dsl4/web-preview-browser.mjs', import.meta.url),
  'utf8',
);

test('keeps the Chromium Web Preview fixture deterministic and development-only', () => {
  assert.match(html, /web-preview-browser\.mjs/u);
  for (const id of [
    'web-preview-mount',
    'fixture-save-valid',
    'fixture-save-invalid',
    'fixture-remove-source',
    'fixture-restore-source',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`, 'u'));
  }
  assert.match(moduleSource, /createDsl4WebPreviewShell/u);
  assert.match(moduleSource, /showDirectoryPicker/u);
  assert.match(moduleSource, /searchParams\.has\('unsupported'\)/u);
  assert.match(moduleSource, /mode !== 'read'/u);
  assert.match(moduleSource, /dsl4WebPreviewAdapter: true/u);
  assert.match(moduleSource, /dsl4PreviewReloadOverlay: true/u);
  assert.doesNotMatch(moduleSource, /localStorage|sessionStorage|indexedDB/u);
});
