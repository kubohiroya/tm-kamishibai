import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import {generalDocumentConfig} from '../docs/config.mjs';

const guide = readFileSync(
  new URL('../docs/general/09-application-materials-guide.md', import.meta.url),
  'utf8',
);
const theme = readFileSync(new URL('../docs/general-theme.css', import.meta.url), 'utf8');

const expectedSheets = [
  'application-delivery',
  'urashima-experience',
  'urashima-script',
  'workshop-concepts',
  'workshop-cycle',
  'dsl-31',
  'sb3-toolchain',
];

test('uses the requested eight-page subject allocation', () => {
  const sheetIds = [
    ...guide.matchAll(/^## .+ \{#([^ ]+) \.application-sheet \.unnumbered\}$/gmu),
  ].map(([, sheetId]) => sheetId);
  assert.deepEqual(sheetIds, expectedSheets);

  assert.equal((guide.match(/アプリ概要<\/p>/gu) ?? []).length, 2);
  assert.equal((guide.match(/浦島太郎による具体例<\/p>/gu) ?? []).length, 2);
  assert.equal((guide.match(/体験会教材説明<\/p>/gu) ?? []).length, 2);
  assert.equal((guide.match(/DSL 3\.1説明<\/p>/gu) ?? []).length, 1);
  assert.equal((guide.match(/sb3-toolchain説明<\/p>/gu) ?? []).length, 1);
  assert.deepEqual(
    [...guide.matchAll(/<p class="application-page-label">([1-8]) \/ 8/gmu)].map(([, pageNumber]) =>
      Number(pageNumber),
    ),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
});

test('includes the app, sample, workshop, DSL, and pinned toolchain evidence', () => {
  assert.match(guide, /<img src="\.\.\/images\/image01\.png"/u);
  assert.match(guide, /ポーズをとろう！/u);
  for (const image of [
    'image60.png',
    'image10.png',
    'image11.png',
    'image25.png',
    'tmpose-training.png',
    'turbowarp-costumes.png',
  ]) {
    assert(guide.includes(`../images/${image}`), `${image} is missing from the guide.`);
  }
  assert.match(guide, /tmpose-kamishibai-samples\/stories\/urashima\//u);
  assert.match(guide, /kamishibai=3\.1/u);
  assert.match(guide, /Loading/u);
  assert.match(guide, /SVG文字/u);
  assert.match(guide, /2c82aaf02f605564f79efe8ff3bbd8f1a78d6fe9/u);
  assert.match(guide, /pnpm sb3:check/u);
  assert.match(guide, /複数拡張のbundle/u);
});

test('registers and styles the guide as an eight-page standalone PDF', () => {
  const documentConfig = generalDocumentConfig.documents.find(
    ({sourceFilename}) => sourceFilename === '09-application-materials-guide.md',
  );
  assert.equal(documentConfig?.pdfIncludesGeneratedToc, false);
  assert.equal(documentConfig?.expectedPdfPageCount, 8);
  assert.match(guide, /^# TMPose紙芝居 アプリ・教材・ツールチェインガイド$/mu);
  assert.match(theme, /@page application-guide\s*\{[\s\S]*size:\s*A4;/u);
  assert.match(
    theme,
    /section\.level2:has\(> h2\.application-sheet\)\s*\{[\s\S]*break-before:\s*page;[\s\S]*break-after:\s*page;/u,
  );
});
