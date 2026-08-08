import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {renderAppBarState, updateAppBarScrollState} from '../site/site-shell.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const siteRoot = 'https://kubohiroya.github.io/tmpose-kamishibai/';
const destinations = {
  top: {label: 'トップ', href: siteRoot},
  docs: {label: 'ドキュメント', href: 'https://kubohiroya.github.io/tmpose-kamishibai-docs/'},
  workshops: {
    label: 'ワークショップ',
    href: 'https://kubohiroya.github.io/tmpose-kamishibai-docs/workshops/',
  },
  samples: {label: '作品', href: 'https://kubohiroya.github.io/tmpose-kamishibai-samples/'},
  downloads: {label: 'ダウンロード', href: `${siteRoot}downloads/`},
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
      new RegExp(
        `<link rel="stylesheet" href="${page.stylesheet.replaceAll('.', '\\.')}"\\s*/?>`,
        'u',
      ),
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
        `<img class="site-brand__symbol" src="${page.symbol.replaceAll('.', '\\.')}" width="40" height="40" alt=""\\s*/?>`,
        'u',
      ),
    );
    assert.match(html, /<main id="main-content">/u);

    for (const [section, {href, label}] of Object.entries(destinations)) {
      const currentAttribute = section === page.current ? ' aria-current="page"' : '';
      assert.match(
        html,
        new RegExp(
          `<a\\b(?=[^>]*class="site-nav__link")(?=[^>]*href="${href.replaceAll('.', '\\.')}")${
            currentAttribute ? '(?=[^>]*aria-current="page")' : '(?![^>]*aria-current="page")'
          }[^>]*>\\s*${label}\\s*<\\/a\\s*>`,
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
      /<a\b(?=[^>]*class="site-repository")(?=[^>]*href="https:\/\/github\.com\/kubohiroya\/tmpose-kamishibai")(?=[^>]*target="_blank")(?=[^>]*rel="noopener")(?=[^>]*aria-label="tmpose-kamishibaiをGitHubで開く")(?=[^>]*title="tmpose-kamishibaiをGitHubで開く")[^>]*>/u,
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

test('renders the current AppBar visibility', () => {
  const classes = new Set();
  const operations = [];
  const header = {
    classList: {
      toggle(name, enabled) {
        operations.push(['toggle', name, enabled]);
        if (enabled) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
      },
    },
  };

  renderAppBarState(header, {hidden: true});

  assert.deepEqual(operations, [['toggle', 'site-header--hidden', true]]);
  assert.deepEqual([...classes], ['site-header--hidden']);
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
