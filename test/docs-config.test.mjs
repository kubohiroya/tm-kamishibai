import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import {
  documentConfig,
  generalDocumentConfig,
  resolveLearnedThroughGrade,
  staffDocumentConfig,
} from '../docs/config.mjs';
import generalVivliostyleConfig from '../docs/vivliostyle.general.config.mjs';
import staffVivliostyleConfig from '../docs/vivliostyle.staff.config.mjs';
import workshopVivliostyleConfig from '../docs/vivliostyle.workshop.config.mjs';
import {
  normalizeGeneralImagePaths,
  normalizeWorkshopImagePaths,
} from '../scripts/build-docs.mjs';

test('uses the configured grade when no environment override is present', () => {
  const originalGrade = process.env.RUBYGANA_GRADE;
  delete process.env.RUBYGANA_GRADE;
  try {
    assert.equal(resolveLearnedThroughGrade(), documentConfig.learnedThroughGrade);
  } finally {
    if (originalGrade === undefined) {
      delete process.env.RUBYGANA_GRADE;
    } else {
      process.env.RUBYGANA_GRADE = originalGrade;
    }
  }
});

test('accepts every elementary school grade', () => {
  for (let grade = 1; grade <= 6; grade += 1) {
    assert.equal(resolveLearnedThroughGrade(String(grade)), grade);
  }
});

test('rejects values outside elementary school grades', () => {
  for (const value of ['0', '7', '2.5', 'three']) {
    assert.throws(() => resolveLearnedThroughGrade(value), RangeError);
  }
});

test('scopes the Hiroya name reading to the full name', () => {
  assert(documentConfig.rubyOverrides.includes('久保裕也:裕也:ひろや'));
  assert(!documentConfig.rubyOverrides.includes('裕也:ひろや'));
});

test('delegates the workshop table of contents to Vivliostyle', () => {
  const source = readFileSync(
    new URL(
      `../docs/${documentConfig.sourceDirectory}/${documentConfig.sourceFilename}`,
      import.meta.url,
    ),
    'utf8',
  );
  const cover = readFileSync(
    new URL(
      `../docs/${documentConfig.sourceDirectory}/${documentConfig.coverFilename}`,
      import.meta.url,
    ),
    'utf8',
  );

  assert.equal(documentConfig.tocSectionDepth, 3);
  assert.equal(workshopVivliostyleConfig.viewerParam, 'bookMode=true');
  assert.equal(documentConfig.coverHtmlFilename, 'index.html');
  assert.notEqual(documentConfig.coverHtmlFilename, documentConfig.tocHtmlFilename);
  assert.equal(
    workshopVivliostyleConfig.copyAsset.excludes.includes('workshops/**'),
    false,
  );
  assert.doesNotMatch(`${cover}\n${source}`, /^## 目次\s*$/mu);
  assert.doesNotMatch(`${cover}\n${source}`, /^#{1,6}\s+!\[/mu);
  assert.equal((cover.match(/^#\s+/gmu) ?? []).length, 1);
  assert.doesNotMatch(cover, /^#{2,6}\s+/mu);
  assert.match(cover, /vivliostyle\.org\/viewer\/#src=.*&amp;bookMode=true/u);
  assert.match(source, /^# 0\. この教材と体験会について$/mu);
  assert.doesNotMatch(source, /^# [ABC]\. 付録/mu);
  assert.match(source, /^\*\*うまく動かないとき\*\*$/mu);
  assert.doesNotMatch(source, /^#{4,6}\s+/mu);
});

test('normalizes shared and document-local workshop image paths', () => {
  assert.equal(
    normalizeWorkshopImagePaths([
      '<img src="../../images/shared.png">',
      '<img src="./local.png">',
    ].join('\n')),
    [
      '<img src="images/shared.png">',
      `<img src="${documentConfig.sourceDirectory}/local.png">`,
    ].join('\n'),
  );
});

test('normalizes shared image paths for generated general document HTML', () => {
  assert.equal(
    normalizeGeneralImagePaths('<img src="../images/internal-state-transition.svg">'),
    '<img src="images/internal-state-transition.svg">',
  );
});

test('publishes appendix A as a standalone non-ruby staff document', () => {
  const source = readFileSync(
    new URL(
      `../docs/${staffDocumentConfig.sourceDirectory}/${staffDocumentConfig.sourceFilename}`,
      import.meta.url,
    ),
    'utf8',
  );

  assert.equal(
    staffDocumentConfig.title,
    '親子AIプログラミング体験会スタッフ向け資料2026年8月1日版',
  );
  assert.deepEqual(
    staffVivliostyleConfig.entry.map(({path, output}) => ({path, output})),
    [{
      path: `${staffDocumentConfig.sourceDirectory}/${staffDocumentConfig.sourceFilename}`,
      output: staffDocumentConfig.htmlFilename,
    }],
  );
  assert.match(source, new RegExp(`^# ${staffDocumentConfig.title}$`, 'mu'));
  assert.match(source, /^# 1\. 体験会運営用資料$/mu);
  assert.doesNotMatch(source, /^## 2\. アプリ$/mu);
  assert.doesNotMatch(source, /^## 3\. (?:関連)?ライブラリ(?:など)?$/mu);
  assert.doesNotMatch(source, /^#{1,3} [ABC]\./mu);
});

test('publishes the current software developer guide', () => {
  const developerDocument = generalDocumentConfig.documents.find(
    ({sourceFilename}) => sourceFilename === '06-developer-guide.md',
  );
  assert(developerDocument, 'Developer document is missing from the general document config.');

  const source = readFileSync(
    new URL(`../docs/${generalDocumentConfig.sourceDirectory}/${developerDocument.sourceFilename}`, import.meta.url),
    'utf8',
  );
  const generalTheme = readFileSync(new URL('../docs/general-theme.css', import.meta.url), 'utf8');
  assert.match(source, /^# 紙芝居アプリ ソフトウェア開発者向け資料$/mu);
  for (const heading of [
    '1. 管理範囲と責務を理解する',
    '2. 開発環境を準備する',
    '3. リポジトリ構成を把握する',
    '4. 共通の開発フローに従う',
    '5. アプリSB3を変更する',
    '6. 埋め込み機能拡張を更新する',
    '7. ビルダーを変更する',
    '8. ドキュメントとサイトを変更する',
    '9. 関連プロジェクトを確認する',
    '10. 関連ドキュメントを確認する',
  ]) {
    assert.match(source, new RegExp(`^## ${heading}$`, 'mu'));
  }
  assert.match(source, /\| 導入\s+\| 第1〜4章\s+\| 初めて開発するときに、この順に読む/u);
  assert.match(
    source,
    /\| 変更対象別手順\s+\| 第5〜8章\s+\| 変更対象に応じて、必要な章だけを読む/u,
  );
  assert.match(source, /\| 参照\s+\| 第9〜10章\s+\| 関連プロジェクトや資料を探すときに参照する/u);
  assert.match(source, /第5〜8章は、この順に実施する一連の工程ではなく、/u);
  assert.match(source, /第9〜10章は作業手順ではありません/u);
  assert.match(source, /<div class="print-page-break" aria-hidden="true"><\/div>/u);
  assert.match(generalTheme, /\.print-page-break\s*\{\s*break-before:\s*page;/u);
  const chapterHeadings = [...source.matchAll(/^## [0-9]+\. (.+)$/gmu)].map(([, heading]) => heading);
  assert.equal(chapterHeadings.length, 10);
  for (const heading of chapterHeadings) {
    assert.match(
      heading,
      /(?:理解する|準備する|把握する|従う|変更する|更新する|確認する)$/u,
      `Chapter heading is not action-oriented: ${heading}`,
    );
  }
  let previousRelatedProjectIndex = -1;
  for (const heading of [
    '9.1 sb3-toolchain',
    '9.2 Viteプラグイン',
    '9.3 TurboWarp 機能拡張開発用テンプレート',
    '9.4 TurboWarp 機能拡張',
    '9.5 その他のライブラリ',
  ]) {
    const headingIndex = source.indexOf(`### ${heading}`);
    assert(headingIndex > previousRelatedProjectIndex, `${heading} is missing or out of order.`);
    previousRelatedProjectIndex = headingIndex;
  }
  assert.match(source, /\[紙芝居アプリ内部仕様書\]\(07-internal-specification\.md\)/u);
  assert.doesNotMatch(source, /^## 2\. 成果物・ビルダー・検証・公開$/mu);
  assert.match(source, /sb3-toolchain\/blob\/main\/docs\/workflows\.md/u);
  assert.doesNotMatch(source, /`--discard-local-changes`/u);
  assert.doesNotMatch(source, /github:kubohiroya\/sb3-toolchain#[0-9a-f]{40}/u);
  assert.doesNotMatch(source, /@kubohiroya\/tmpose-kamishibai@[0-9]+\.[0-9]+\.[0-9]+/u);
  assert.doesNotMatch(source, /Issue #[0-9]+/u);
  assert.doesNotMatch(source, /^## .*`skipMode`/mu);
  assert.doesNotMatch(source, /^#{1,3} [BC]\./mu);
});

test('defines the general documents with furigana only for the kids summary', () => {
  assert.equal(generalDocumentConfig.sourceDirectory, 'general');
  assert.equal(generalDocumentConfig.outputDirectory, 'general');
  assert.equal(generalDocumentConfig.documents.length, 8);
  assert.deepEqual(
    generalDocumentConfig.documents
      .filter(({addFurigana}) => addFurigana === true)
      .map(({sourceFilename}) => sourceFilename),
    ['05-executive-summary-kids.md'],
  );
  assert.equal(generalVivliostyleConfig.viewerParam, 'bookMode=true');
  assert.deepEqual(
    generalVivliostyleConfig.entry.map(({path, output}) => ({path, output})),
    generalDocumentConfig.documents.map(({sourceFilename}) => ({
      path: `${generalDocumentConfig.sourceDirectory}/${sourceFilename}`,
      output: sourceFilename.replace(/\.md$/u, '.html'),
    })),
  );

  for (const {sourceFilename, title} of generalDocumentConfig.documents) {
    const source = readFileSync(
      new URL(`../docs/${generalDocumentConfig.sourceDirectory}/${sourceFilename}`, import.meta.url),
      'utf8',
    );
    assert.match(source, new RegExp(`^# ${title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'mu'));
  }
});

test('documents the kamishibai 3.1 DSL across the current general guides', () => {
  const sources = new Map(generalDocumentConfig.documents.map(({sourceFilename}) => [
    sourceFilename,
    readFileSync(
      new URL(`../docs/${generalDocumentConfig.sourceDirectory}/${sourceFilename}`, import.meta.url),
      'utf8',
    ),
  ]));

  for (const [sourceFilename, source] of sources) {
    if (sourceFilename === 'history.md') {
      continue;
    }
    assert.match(source, /kamishibai=3\.1/u, `${sourceFilename} does not identify DSL 3.1.`);
    assert.doesNotMatch(source, /kamishibai=2\.0/u, `${sourceFilename} still targets DSL 2.0.`);
  }

  for (const [sourceFilename, source] of sources) {
    assert(source.includes('Loading'), `${sourceFilename} does not document Loading.`);
  }

  for (const sourceFilename of ['02-dsl-manual.md', '03-command-reference.md']) {
    const source = sources.get(sourceFilename);
    for (const feature of [
      'setLoadingCostume',
      'setRuntimeVariable',
      'registerBranch',
      'sceneLabel',
      'action=text:',
      'text=ui.prompt:',
      'transition:fadeOut',
      'branch:',
      'keyInputToChangeScene',
      'touchInputToChangeScene',
      ':loop:',
      ':sequence:',
    ]) {
      assert(source.includes(feature), `${sourceFilename} does not document ${feature}.`);
    }
  }

  const history = sources.get('history.md');
  assert.match(history, /kamishibai=2\.0/u);
  assert.match(history, /kamishibai=3\.1/u);
  for (const feature of [
    'setLoadingCostume',
    'Loading',
    'setRuntimeVariable',
    'registerBranch',
    'sceneLabel',
    'action=text:',
    'text=ui.prompt:',
    'transition:fadeOut',
    'branch:',
    'keyInputToChangeScene',
    'touchInputToChangeScene',
    ':loop:',
    ':sequence:',
    'background:beach',
    'backdrop:beach',
    'setCostume',
    'setSkin',
  ]) {
    assert(history.includes(feature), `history.md does not document the ${feature} migration.`);
  }

  assert.match(
    sources.get('03-command-reference.md'),
    /setLoadingCostume=loading1,loading2,loading3/u,
  );
  assert.match(sources.get('01-user-guide.md'), /Loading.*分子・分母/u);
});

test('keeps general guides aligned with artifact modes, UI text, and public samples', () => {
  const sources = new Map(
    generalDocumentConfig.documents.map(({sourceFilename}) => [
      sourceFilename,
      readFileSync(
        new URL(
          `../docs/${generalDocumentConfig.sourceDirectory}/${sourceFilename}`,
          import.meta.url,
        ),
        'utf8',
      ),
    ]),
  );
  const userGuide = sources.get('01-user-guide.md');
  const developerGuide = sources.get('06-developer-guide.md');
  const internalSpecification = sources.get('07-internal-specification.md');

  for (const artifactMode of ['Web版', '`player`', '`editor`', '`generic`']) {
    assert(
      userGuide.includes(artifactMode),
      `01-user-guide.md does not document the ${artifactMode} artifact mode.`,
    );
  }
  for (const uiText of ['ui.prompt', 'ui.invalidScript', 'Pose!', 'Invalid script']) {
    assert(
      userGuide.includes(uiText),
      `01-user-guide.md does not document the ${uiText} UI text behavior.`,
    );
  }

  for (const sourceFilename of [
    '01-user-guide.md',
    '02-dsl-manual.md',
    '04-executive-summary-adult.md',
    '06-developer-guide.md',
  ]) {
    assert.match(
      sources.get(sourceFilename),
      /kubohiroya\.github\.io\/tmpose-kamishibai-samples\/stories\/urashima\//u,
      `${sourceFilename} does not link the current Urashima publication.`,
    );
  }

  assert.match(developerGuide, /`stories\/urashima\/`/u);
  assert.doesNotMatch(developerGuide, /samples\/urashima\//u);
  assert.match(internalSpecification, /^## 2\. 成果物プロファイル$/mu);

  for (const [sourceFilename, source] of sources) {
    if (sourceFilename === 'history.md') continue;
    assert(source.includes('`history.md`'), `${sourceFilename} does not reference history.md.`);
  }
});

test('starts each top-level body section on a new printed page', () => {
  const theme = readFileSync(new URL('../docs/theme.css', import.meta.url), 'utf8');

  assert.match(
    theme,
    /@media print[\s\S]*body\[data-publication-section="body"\] > section\.level1 \+ section\.level1\s*\{\s*break-before:\s*page;/u,
  );
});
