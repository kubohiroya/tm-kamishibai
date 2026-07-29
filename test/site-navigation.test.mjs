import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

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
    symbol: 'favicon.png',
  },
  {
    path: 'site/docs/index.html',
    current: 'docs',
    stylesheet: '../site-shell.css',
    symbol: '../favicon.png',
  },
  {
    path: 'site/downloads/index.html',
    current: 'downloads',
    stylesheet: '../site-shell.css',
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
  assert.match(css, /:focus-visible/u);
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
