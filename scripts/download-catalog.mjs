import assert from 'node:assert/strict';

export const downloadCardsPlaceholder = '{{DOWNLOAD_CARDS}}';
export const dsl4DocsUrl =
  'https://kubohiroya.github.io/tmpose-kamishibai-docs/dsl-author-guides/dsl-4.0-author-guide/';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export const downloadCatalog = deepFreeze([
  {
    artifact: {
      buildDate: '2026-08-06',
      filename: 'kamishibai-3.2.sb3',
      faviconPath: 'release-sources/3.2.3/site/favicon.png',
      sha256: '9c94368b68297e68c3b37a0e2b15a81c07461dd78a2d0c876b0805ef07ea1d11',
      sourceCommit: '28015ac9ff5221f371e8bd0357a7750ce40bbf7c',
      sourceDirectory: 'release-sources/3.2.3/app',
    },
    description:
      '3.1と3.2の既存作品を扱うための最終安定版です。新しく作品を作る場合は4.0を利用してください。',
    series: '3.2',
    status: '過去の安定版',
    statusKind: 'past',
    version: '3.2.3',
  },
  {
    artifact: {
      buildDate: '2026-08-08',
      filename: 'kamishibai-4.0.sb3',
      faviconPath: 'site/favicon.png',
      sha256: 'b4982e6464744fe1cd1d848253357d28b9423b4998017df40c0dccdc94074864',
      sourceCommit: 'a5f5c41eb7ba4bce4689a418e4fa498934460947',
      sourceDirectory: 'release-sources/4.0.0/app',
    },
    description:
      'YAML、local preview、自己完結SB3を提供する現在の安定版です。新しい作品には4.0を推奨します。',
    docsUrl: dsl4DocsUrl,
    series: '4.0',
    recommended: true,
    status: '安定版',
    statusKind: 'stable',
    version: '4.0.0',
  },
  {
    artifact: {
      buildDate: '2026-08-04',
      filename: 'kamishibai-3.1.sb3',
      faviconPath: 'release-sources/3.1.9/site/favicon.png',
      sha256: '31a4358a459407624aabe748e9b3ba74d08667d0550f06078a72da100d3ae018',
      sourceCommit: '96b1fe66e052f10da2938389f98fd15c95fcfdee',
      sourceDirectory: 'release-sources/3.1.9/app',
    },
    description:
      '3.1系列で作成した既存作品を扱うための最終安定版です。新しく作品を作る場合は3.2を利用してください。',
    series: '3.1',
    status: '過去の安定版',
    statusKind: 'past',
    version: '3.1.9',
  },
]);

assert.equal(
  new Set(downloadCatalog.map(({series}) => series)).size,
  downloadCatalog.length,
  'Download catalog series must be unique.',
);
assert.equal(
  downloadCatalog.filter(({recommended}) => recommended).length,
  1,
  'The download catalog must have exactly one recommended release.',
);
for (const entry of downloadCatalog) {
  assert(
    typeof entry.series === 'string' && entry.series.length > 0,
    'Catalog series is required.',
  );
  assert(
    typeof entry.version === 'string' && entry.version.length > 0,
    'Catalog version is required.',
  );
  if (entry.artifact) {
    assert.match(entry.artifact.sha256, /^[0-9a-f]{64}$/u, `${entry.series} SHA-256 is invalid.`);
    assert.match(
      entry.artifact.sourceCommit,
      /^[0-9a-f]{40}$/u,
      `${entry.series} source commit is invalid.`,
    );
  } else {
    assert(
      entry.unavailableLabel && entry.unavailableNote,
      `${entry.series} unavailable text is required.`,
    );
  }
}

export const downloadableReleases = deepFreeze(
  downloadCatalog
    .filter(({artifact}) => artifact)
    .map(({artifact, series, version}) => ({...artifact, series, version})),
);

export const recommendedDownload = downloadCatalog.find(({recommended}) => recommended);
assert(recommendedDownload?.artifact, 'The recommended download must have a published artifact.');

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderActions(entry) {
  const actions = [];
  if (entry.artifact) {
    actions.push(
      `<a class="button" href="${escapeHtml(entry.artifact.filename)}" download>` +
        `📁 ${escapeHtml(entry.series)}のSB3をダウンロード</a>`,
    );
  }
  if (entry.docsUrl) {
    const secondary = entry.artifact ? ' button--secondary' : '';
    actions.push(
      `<a class="button${secondary}" href="${escapeHtml(entry.docsUrl)}">` +
        `📕 ${escapeHtml(entry.series)}ドキュメントを開く</a>`,
    );
  }
  if (!entry.artifact) {
    actions.push(
      `<span class="button button--disabled" aria-disabled="true">` +
        `${escapeHtml(entry.unavailableLabel)}</span>`,
    );
  }
  return actions.map((action) => `        ${action}`).join('\n');
}

function renderFileInfo(entry) {
  if (!entry.artifact) return escapeHtml(entry.unavailableNote);
  return (
    `ファイル: <code>${escapeHtml(entry.artifact.filename)}</code>` +
    `（${escapeHtml(entry.version)}）`
  );
}

function renderCard(entry) {
  return `    <article data-version="${escapeHtml(entry.series)}">
      <h2>kamishibai ${escapeHtml(entry.series)} <span class="status status--${escapeHtml(entry.statusKind)}">${escapeHtml(entry.status)}</span></h2>
      <p>${escapeHtml(entry.description)}</p>
      <div class="actions">
${renderActions(entry)}
      </div>
      <p class="file-info">${renderFileInfo(entry)}</p>
    </article>`;
}

export function renderDownloadCards(template) {
  const placeholderCount = template.split(downloadCardsPlaceholder).length - 1;
  assert.equal(
    placeholderCount,
    1,
    `Expected one download-card placeholder, found ${placeholderCount}.`,
  );
  return template.replace(downloadCardsPlaceholder, downloadCatalog.map(renderCard).join('\n\n'));
}
