import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {injectSiteAppBar} from '../scripts/site-appbar.mjs';
import {
  shouldHideAppBarForFragment,
  updateAppBarScrollState,
} from '../site/site-shell.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const siteRoot = 'https://kubohiroya.github.io/tmpose-kamishibai/';
const destinations = {
  top: siteRoot,
  docs: `${siteRoot}docs/`,
  samples: 'https://kubohiroya.github.io/tmpose-kamishibai-samples/',
  downloads: `${siteRoot}downloads/`,
};
const pages = [
  {
    path: 'site/index.html',
    current: 'top',
    stylesheet: 'site-shell.css',
    script: 'site-shell.js',
    symbol: 'favicon.png',
  },
  {
    path: 'site/docs/index.html',
    current: 'docs',
    stylesheet: '../site-shell.css',
    script: '../site-shell.js',
    symbol: '../favicon.png',
  },
  {
    path: 'site/downloads/index.html',
    current: 'downloads',
    stylesheet: '../site-shell.css',
    script: '../site-shell.js',
    symbol: '../favicon.png',
  },
];

test('uses one accessible site header across the published entry pages', async () => {
  for (const page of pages) {
    const html = await readFile(path.join(projectRoot, page.path), 'utf8');

    assert.match(html, /<a class="skip-link" href="#main-content">本文へ移動<\/a>/u);
    assert.match(html, /<header class="site-header">/u);
    assert.match(
      html,
      new RegExp(`<link rel="stylesheet" href="${page.stylesheet.replaceAll('.', '\\.')}">`, 'u'),
    );
    assert.match(
      html,
      new RegExp(
        `<script type="module" src="${page.script.replaceAll('.', '\\.')}"><\\/script>`,
        'u',
      ),
    );
    assert.match(
      html,
      new RegExp(
        `<img class="site-brand__symbol" src="${page.symbol.replaceAll('.', '\\.')}" width="40" height="40" alt="">`,
        'u',
      ),
    );
    assert.match(html, /<main id="main-content">/u);

    for (const [section, href] of Object.entries(destinations)) {
      const currentAttribute = section === page.current ? ' aria-current="page"' : '';
      assert.match(
        html,
        new RegExp(
          `<a class="site-nav__link" href="${href.replaceAll('.', '\\.')}"${currentAttribute}>`,
          'u',
        ),
      );
    }
    assert.equal(
      (html.match(/aria-current="page"/gu) ?? []).length,
      1,
      `${page.path} must expose exactly one current page.`,
    );
    assert.match(
      html,
      /<a class="site-repository" href="https:\/\/github\.com\/kubohiroya\/tmpose-kamishibai" target="_blank" rel="noopener" aria-label="tmpose-kamishibaiをGitHubで開く" title="tmpose-kamishibaiをGitHubで開く">/u,
    );
    assert.match(html, /<svg class="site-repository__icon"[\s\S]*?aria-hidden="true">/u);
  }
});

test('keeps the shared navigation visible and operable on narrow screens', async () => {
  const css = await readFile(path.join(projectRoot, 'site/site-shell.css'), 'utf8');

  assert.match(css, /\.site-header\s*\{[\s\S]*?position:\s*sticky;/u);
  assert.match(css, /\.site-nav\s*\{[\s\S]*?overflow-x:\s*auto;/u);
  assert.match(css, /\.site-nav__link\s*\{[\s\S]*?min-height:\s*44px;/u);
  assert.match(css, /\.site-repository\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/u);
  assert.match(
    css,
    /\.site-brand__symbol\s*\{[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*transparent;/u,
  );
  assert.match(css, /@media \(max-width:\s*760px\)/u);
  assert.match(css, /\.site-header--hidden\s*\{[\s\S]*?transform:\s*translateY\(/u);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/u);
  assert.match(css, /@media print/u);
  assert.match(css, /:focus-visible/u);
});

test('injects the shared AppBar into generated documentation HTML', () => {
  const generatedHtml = [
    '<!doctype html>',
    '<html lang="ja">',
    '<head><meta charset="utf-8"><link rel="stylesheet" href="theme.css"></head>',
    '<body data-publication-section="body"><h1>資料</h1></body>',
    '</html>',
  ].join('');
  const updatedHtml = injectSiteAppBar(generatedHtml, '../../../');

  assert.match(updatedHtml, /<link rel="stylesheet" href="\.\.\/\.\.\/\.\.\/site-shell\.css">/u);
  assert.match(
    updatedHtml,
    /<script type="module" src="\.\.\/\.\.\/\.\.\/site-shell\.js"><\/script>/u,
  );
  assert.match(updatedHtml, /<body class="site-document" data-publication-section="body">/u);
  assert.match(updatedHtml, /<header class="site-header">/u);
  assert.match(
    updatedHtml,
    /<img class="site-brand__symbol" src="\.\.\/\.\.\/\.\.\/favicon\.png"/u,
  );
  assert.match(
    updatedHtml,
    /<a class="site-nav__link" href="https:\/\/kubohiroya\.github\.io\/tmpose-kamishibai\/docs\/" aria-current="page">/u,
  );
  assert.match(
    updatedHtml,
    /<div id="main-content" class="site-content-anchor" tabindex="-1"><\/div>/u,
  );
  assert.equal(injectSiteAppBar(updatedHtml, '../../../'), updatedHtml);
});

test('hides on downward scroll and reopens on upward scroll or focus', () => {
  let state = {
    lastY: 0,
    accumulatedDelta: 0,
    hidden: false,
  };

  state = updateAppBarScrollState(state, {
    scrollY: 80,
    headerHeight: 68,
    hasFocus: false,
  });
  assert.equal(state.hidden, true);

  state = updateAppBarScrollState(state, {
    scrollY: 60,
    headerHeight: 68,
    hasFocus: false,
  });
  assert.equal(state.hidden, false);

  state = updateAppBarScrollState(
    {...state, hidden: true},
    {
      scrollY: 120,
      headerHeight: 68,
      hasFocus: true,
    },
  );
  assert.equal(state.hidden, false);

  state = updateAppBarScrollState(
    {...state, hidden: true},
    {
      scrollY: 0,
      headerHeight: 68,
      hasFocus: false,
    },
  );
  assert.equal(state.hidden, false);
});

test('starts hidden when a document opens at a heading fragment', () => {
  assert.equal(
    shouldHideAppBarForFragment({
      hash: '#1-概要',
      isDocumentPage: true,
    }),
    true,
  );
  assert.equal(
    shouldHideAppBarForFragment({
      hash: '#main-content',
      isDocumentPage: true,
    }),
    false,
  );
  assert.equal(
    shouldHideAppBarForFragment({
      hash: '',
      isDocumentPage: true,
    }),
    false,
  );
  assert.equal(
    shouldHideAppBarForFragment({
      hash: '#1-概要',
      isDocumentPage: false,
    }),
    false,
  );
});

test('keeps only the table-of-contents button on the workshop cover', async () => {
  const cover = await readFile(
    path.join(projectRoot, 'docs/workshops/2026-08-01/tmpose-kamishibai-cover-20260801.md'),
    'utf8',
  );

  assert.doesNotMatch(cover, />ドキュメント一覧へ<\/a>/u);
  assert.doesNotMatch(cover, />Vivliostyle Viewerで読む/u);
  assert.match(cover, />目次へ<\/a>/u);
});

test('records the Urashima source used for the site symbol', async () => {
  const metadata = JSON.parse(
    await readFile(path.join(projectRoot, 'site/favicon.source.json'), 'utf8'),
  );

  assert.equal(metadata.sourceName, 'Urashima-walk-1');
  assert.equal(metadata.sourceRepository, 'kubohiroya/tmpose-kamishibai-samples');
  assert.equal(
    metadata.sourcePath,
    'stories/urashima/assets/images/963e926995791fde1b335fd4ba60d6d7.png',
  );
  assert.equal(
    metadata.sourceSha256,
    'f66c89b710324a7ca0809ab8cdc5acdfff83e988828a199403b7104ade6ec2df',
  );
  assert.equal(metadata.license, 'MPL-2.0');
  assert.equal(metadata.derivedAsset, 'favicon.png');
});
