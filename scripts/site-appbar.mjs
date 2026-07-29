import {readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const siteRoot = 'https://kubohiroya.github.io/tmpose-kamishibai/';

function renderSiteAppBar(assetBase) {
  return `<a class="skip-link" href="#main-content">本文へ移動</a>
<header class="site-header">
  <div class="site-header__inner">
    <a class="site-brand" href="${siteRoot}">
      <img class="site-brand__symbol" src="${assetBase}favicon.png" width="40" height="40" alt="">
      <span>TMPose紙芝居</span>
    </a>
    <nav class="site-nav" aria-label="サイトナビゲーション">
      <a class="site-nav__link" href="${siteRoot}">トップ</a>
      <a class="site-nav__link" href="${siteRoot}docs/" aria-current="page">ドキュメント</a>
      <a class="site-nav__link" href="https://kubohiroya.github.io/tmpose-kamishibai-samples/">サンプル</a>
      <a class="site-nav__link" href="${siteRoot}downloads/">ダウンロード</a>
    </nav>
    <a class="site-repository" href="https://github.com/kubohiroya/tmpose-kamishibai" target="_blank" rel="noopener" aria-label="tmpose-kamishibaiをGitHubで開く" title="tmpose-kamishibaiをGitHubで開く">
      <svg class="site-repository__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943"/>
      </svg>
    </a>
  </div>
</header>
<div id="main-content" class="site-content-anchor" tabindex="-1"></div>`;
}

function addBodyClass(bodyTag) {
  const classAttribute = bodyTag.match(/\bclass=(["'])(.*?)\1/iu);
  if (!classAttribute) {
    return bodyTag.replace(/<body\b/iu, '<body class="site-document"');
  }

  const classes = classAttribute[2].split(/\s+/u);
  if (classes.includes('site-document')) {
    return bodyTag;
  }
  return bodyTag.replace(
    classAttribute[0],
    `class=${classAttribute[1]}${classAttribute[2]} site-document${classAttribute[1]}`,
  );
}

export function injectSiteAppBar(source, assetBase) {
  if (/<header\b[^>]*\bclass=(["'])[^"']*\bsite-header\b[^"']*\1/iu.test(source)) {
    return source;
  }

  const assets = [
    `<link rel="stylesheet" href="${assetBase}site-shell.css">`,
    `<script type="module" src="${assetBase}site-shell.js"></script>`,
  ].join('\n  ');
  let updated = source.replace(/<\/head>/iu, `  ${assets}\n</head>`);
  if (updated === source) {
    throw new Error(
      'Cannot install the site AppBar because the document does not contain </head>.',
    );
  }

  updated = updated.replace(/<body\b[^>]*>/iu, addBodyClass);
  const withAppBar = updated.replace(
    /<body\b[^>]*>/iu,
    (bodyTag) => `${bodyTag}\n${renderSiteAppBar(assetBase)}`,
  );
  if (withAppBar === updated) {
    throw new Error('Cannot install the site AppBar because the document does not contain <body>.');
  }
  return withAppBar;
}

async function findHtmlFiles(directory) {
  const entries = await readdir(directory, {withFileTypes: true});
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return findHtmlFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith('.html') ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

export async function installSiteAppBars(directory, siteRootDirectory) {
  const htmlFiles = await findHtmlFiles(directory);
  let installedCount = 0;

  for (const htmlFile of htmlFiles) {
    const source = await readFile(htmlFile, 'utf8');
    const relativeRoot = path
      .relative(path.dirname(htmlFile), siteRootDirectory)
      .split(path.sep)
      .join('/');
    const assetBase = relativeRoot === '' ? '' : `${relativeRoot}/`;
    const updated = injectSiteAppBar(source, assetBase);
    if (updated !== source) {
      await writeFile(htmlFile, updated);
      installedCount += 1;
    }
  }

  return {htmlCount: htmlFiles.length, installedCount};
}
