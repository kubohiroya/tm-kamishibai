import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import {generalDocumentConfig} from '../docs/config.mjs';

const guide = readFileSync(
  new URL('../docs/general/08-extension-guide.md', import.meta.url),
  'utf8',
);
const project = JSON.parse(
  readFileSync(new URL('../app/project.source.json', import.meta.url), 'utf8'),
);
const theme = readFileSync(new URL('../docs/general-theme.css', import.meta.url), 'utf8');

const expectedSheets = [
  ['extension-consoles', 'sipcconsole'],
  ['extension-temporary-variables', 'lmsTempVars2'],
  ['extension-text-operators', 'strings'],
  ['extension-asset-manager', 'kubohiroyaassetmanager'],
  ['extension-tmpose', 'tmpose'],
  ['extension-local-storage', 'localstorage'],
  ['extension-text-lines', 'kubohiroyatextlines'],
  ['extension-runtime-expression', 'kubohiroyaruntimeexpression'],
  ['extension-kamishibai-runtime', 'kubohiroyakamishibairuntime'],
  ['extension-async-input', 'kubohiroyaasyncinput'],
  ['extension-more-timers', 'lmsTimers'],
  ['extension-files', 'files'],
  ['extension-animated-text', 'text'],
  ['extension-translate', 'translate'],
  ['extension-web-link', 'kubohiroyaweblink'],
];

test('documents every app extension in project order', () => {
  assert.deepEqual(
    expectedSheets.map(([, extensionId]) => extensionId),
    project.extensions,
  );

  const sheetIds = [...guide.matchAll(/^## .+ \{#([^ ]+) \.extension-sheet\}$/gmu)].map(
    ([, sheetId]) => sheetId,
  );
  assert.deepEqual(
    sheetIds,
    expectedSheets.map(([sheetId]) => sheetId),
  );

  for (const [, extensionId] of expectedSheets) {
    assert.match(guide, new RegExp(`<code>${extensionId}</code>`, 'u'));
  }
});

test('defines one overview and fifteen self-contained extension pages', () => {
  const documentConfig = generalDocumentConfig.documents.find(
    ({sourceFilename}) => sourceFilename === '08-extension-guide.md',
  );
  assert.equal(documentConfig?.pdfIncludesGeneratedToc, false);
  assert.equal(documentConfig?.expectedPdfPageCount, 16);
  assert.match(guide, /^# TMPose紙芝居 機能拡張ガイド$/mu);
  assert.match(guide, /<figure class="extension-overview-hero">/u);
  assert.match(guide, /<img src="\.\.\/images\/image01\.png"/u);
  assert.match(guide, /ポーズをとろう！/u);
  assert.match(guide, /全16ページ/u);
  assert.equal((guide.match(/<figure class="extension-flow">/gu) ?? []).length, 15);
  assert.equal((guide.match(/<div class="extension-columns">/gu) ?? []).length, 15);
  assert.equal((guide.match(/<p class="extension-note">/gu) ?? []).length, 15);
  assert.equal((guide.match(/<p class="extension-source">/gu) ?? []).length, 15);
  assert.match(guide, /extension-source extension-overview-source/u);

  assert.match(theme, /@page extension-guide\s*\{[\s\S]*size:\s*A4;/u);
  assert.match(
    theme,
    /section\.level2:has\(> h2\.extension-sheet\)\s*\{[\s\S]*break-before:\s*page;[\s\S]*break-after:\s*page;/u,
  );
});
