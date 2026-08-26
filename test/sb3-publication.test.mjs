import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {strToU8, zipSync} from 'fflate';

import {
  downloadCardsPlaceholder,
  downloadCatalog,
  recommendedDownload,
  renderDownloadCards,
} from '../scripts/download-catalog.mjs';
import {
  createDownloadableReleaseSb3,
  downloadableReleases,
} from '../scripts/sb3/downloadable-releases.mjs';
import {renderSiteVersion, siteVersionPlaceholder} from '../scripts/site-version.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const urashimaWebUrl = 'https://kubohiroya.github.io/tm-kamishibai-samples/stories/urashima/web/';
const releasePins = JSON.parse(
  await readFile(new URL('fixtures/dsl4/release-pins.json', import.meta.url), 'utf8'),
);

test('keeps static distribution sources free of SB3 binaries', async () => {
  const downloadEntries = await readdir(path.join(projectRoot, 'site/downloads'));
  assert.deepEqual(
    downloadEntries.filter((entryName) => entryName.endsWith('.sb3')),
    [],
  );

  const ignoreRules = new Set(
    (await readFile(path.join(projectRoot, '.gitignore'), 'utf8')).split(/\r?\n/u),
  );
  assert(ignoreRules.has('/kamishibai.sb3'));
  assert(ignoreRules.has('/urashima.sb3'));
  assert(ignoreRules.has('/site/downloads/*.sb3'));
  await assert.rejects(
    readFile(path.join(projectRoot, 'urashima.sb3')),
    (error) => error.code === 'ENOENT',
  );
});

test('renders ordered versioned download cards from one release catalog', async () => {
  const [downloadTemplate, readme, readmeJapanese, packageJsonSource] = await Promise.all([
    readFile(path.join(projectRoot, 'site/downloads/index.html'), 'utf8'),
    readFile(path.join(projectRoot, 'README.md'), 'utf8'),
    readFile(path.join(projectRoot, 'README.ja.md'), 'utf8'),
    readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageJsonSource);
  const releaseInstallSpecifier = `${releasePins.release.package}@${releasePins.release.version}`;
  const downloadPage = renderDownloadCards(downloadTemplate);

  assert.deepEqual(
    downloadCatalog.map(({series}) => series),
    ['4.0', '3.2', '3.1'],
  );
  assert.equal(downloadTemplate.split(downloadCardsPlaceholder).length - 1, 1);
  assert(!downloadPage.includes(downloadCardsPlaceholder));
  const cardPositions = downloadCatalog.map(({series}) =>
    downloadPage.indexOf(`data-version="${series}"`),
  );
  assert(cardPositions.every((position) => position >= 0));
  assert(
    cardPositions.every((position, index) => index === 0 || cardPositions[index - 1] < position),
  );
  for (const entry of downloadCatalog) {
    assert(downloadPage.includes(`status--${entry.statusKind}">${entry.status}</span>`));
    assert(downloadPage.includes(entry.description));
  }
  for (const release of downloadableReleases) {
    assert.match(downloadPage, new RegExp(`href="${release.filename}" download`, 'u'));
    assert(downloadPage.includes(`<code>${release.filename}</code>（${release.version}）`));
    assert(
      downloadPage.includes(
        `<time datetime="${release.buildDate}">${release.buildDate
          .split('-')
          .map(Number)
          .map((part, index) => `${part}${['年', '月', '日'][index]}`)
          .join('')}</time>`,
      ),
    );
    assert(downloadPage.includes(`${release.size.toLocaleString('ja-JP')} bytes`));
  }
  assert.doesNotMatch(downloadPage, /4\.0ドキュメントを参照できます。/u);
  assert.doesNotMatch(downloadPage, /4\.0ドキュメントを開く/u);
  assert.doesNotMatch(downloadPage, /\/dsl-author-guides\/dsl-4\.0-author-guide\//u);
  for (const entry of downloadCatalog.filter(({artifact}) => !artifact)) {
    assert(downloadPage.includes(`aria-disabled="true">${entry.unavailableLabel}</span>`));
    assert(downloadPage.includes(entry.unavailableNote));
  }
  assert.doesNotMatch(downloadPage, /href="kamishibai\.sb3"/u);
  assert.doesNotMatch(downloadPage, /kamishibai-3_1a1\.sb3/u);
  assert.match(readme, /github\.com\/kubohiroya\/sb3-toolchain/u);
  assert.equal(
    packageJson.name,
    releasePins.release.package,
    'Package name must match the reviewed release contract.',
  );
  assert.equal(
    packageJson.version,
    releasePins.release.version,
    'Package version must match the reviewed release contract.',
  );
  assert.equal(
    packageJson.devDependencies['@kubohiroya/sb3-toolchain'],
    releasePins.devDependencies['@kubohiroya/sb3-toolchain'],
    'SB3 toolchain dependency must use the reviewed exact npm version.',
  );
  assert.equal(packageJson.devDependencies['@kubohiroya/sb3-toolchain-legacy'], undefined);
  assert.doesNotMatch(readme, /github:kubohiroya\/sb3-toolchain#[0-9a-f]{40}/u);
  assert.match(
    readme,
    new RegExp(`pnpm add --save-exact ${releaseInstallSpecifier.replaceAll('.', '\\.')}`, 'u'),
    'README installation must use the current fixed npm version.',
  );
  assert.doesNotMatch(readme, /github:kubohiroya\/tmpose-kamishibai#v3\.1\.0/u);
  assert.doesNotMatch(readme, /allowBuilds/u);
  assert.match(readme, /github\.com\/kubohiroya\/tm-kamishibai-samples/u);
  assert.match(readme, /kubohiroya\.github\.io\/tm-kamishibai-samples\//u);
  assert.match(readme, /github\.com\/kubohiroya\/tm-kamishibai-docs/u);
  assert.match(readme, /kubohiroya\.github\.io\/tm-kamishibai-docs\//u);
  assert.doesNotMatch(readme, /\]\(docs\//u);
  assert.doesNotMatch(readme, /setLoadingCostume=/u);
  assert.match(readme, /English \| \[日本語\]\(README\.ja\.md\)/u);
  assert.match(readmeJapanese, /\[English\]\(README\.md\) \| 日本語/u);
  assert(packageJson.files.includes('README.md'));
  assert(packageJson.files.includes('README.ja.md'));

  const examples = (source) =>
    [...source.matchAll(/```(?:bash|json|yaml)\n([\s\S]*?)```/gu)].map((match) => match[1]);
  assert.deepEqual(examples(readmeJapanese), examples(readme));

  const remoteLinks = (source) =>
    [...new Set([...source.matchAll(/https:\/\/[^\s)]+/gu)].map((match) => match[0]))].sort();
  assert.deepEqual(remoteLinks(readmeJapanese), remoteLinks(readme));

  const headingLevels = (source) =>
    source
      .split('\n')
      .filter((line) => /^#{1,6} /u.test(line))
      .map((line) => line.indexOf(' '));
  assert.deepEqual(headingLevels(readmeJapanese), headingLevels(readme));
  assert.match(
    readmeJapanese,
    new RegExp(`pnpm add --save-exact ${releaseInstallSpecifier.replaceAll('.', '\\.')}`, 'u'),
    'Japanese README installation must use the current fixed npm version.',
  );
});

test('downloads a bounded GitHub Release asset and verifies its catalog identity', async () => {
  const implementation = await readFile(
    path.join(projectRoot, 'scripts/sb3/downloadable-releases.mjs'),
    'utf8',
  );
  assert.doesNotMatch(implementation, /node:child_process|\bgit\b/u);
  for (const release of downloadableReleases) {
    assert.match(
      release.url,
      new RegExp(`/releases/download/v${release.version.replaceAll('.', '\\.')}/`, 'u'),
    );
    assert.equal(Object.hasOwn(release, 'sourceDirectory'), false);
  }

  const title = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const archive = Buffer.from(
    zipSync({
      'project.json': strToU8(
        JSON.stringify({
          targets: [
            {
              isStage: true,
              costumes: [{name: 'Title', dataFormat: 'svg', md5ext: 'title.svg'}],
              blocks: {
                version: {
                  opcode: 'kubohiroyaassetmanager_setTextValue',
                  inputs: {
                    NAME: [1, [10, 'about.version']],
                    VALUE: [1, [10, 'Version 9.8.7 (2026/08/15)']],
                  },
                },
              },
            },
          ],
        }),
      ),
      'title.svg': title,
    }),
  );
  const release = {
    buildDate: '2026-08-15',
    filename: 'kamishibai-9.8.7.sb3',
    series: '9.8',
    version: '9.8.7',
    url: `https://github.com${releasePins.release.repositoryPath}/releases/download/v9.8.7/kamishibai-9.8.7.sb3`,
    size: archive.byteLength,
    sha256: createHash('sha256').update(archive).digest('hex'),
  };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push([url, options]);
    return new Response(archive, {
      status: 200,
      headers: {'content-length': String(archive.byteLength)},
    });
  };
  const result = await createDownloadableReleaseSb3(release, {fetchImpl});
  assert.deepEqual(result.archive, archive);
  assert.deepEqual(result.titleBuildMetadata, {
    buildDate: '2026-08-15',
    label: 'Version 9.8.7 (2026/08/15)',
    version: '9.8.7',
  });
  assert.deepEqual(requests, [
    [release.url, {headers: {accept: 'application/octet-stream'}, redirect: 'follow'}],
  ]);
  await assert.rejects(
    createDownloadableReleaseSb3({...release, sha256: '0'.repeat(64)}, {fetchImpl}),
    /SHA-256 is invalid/u,
  );
});

test('renders the top-page version from the recommended download catalog entry', async () => {
  const siteIndex = await readFile(path.join(projectRoot, 'site/index.html'), 'utf8');

  assert.equal(siteIndex.split(siteVersionPlaceholder).length - 1, 1);
  assert.doesNotMatch(siteIndex, /kamishibai \d/u);

  const rendered = renderSiteVersion(siteIndex, recommendedDownload.version);
  assert.match(
    rendered,
    new RegExp(
      `kamishibai\\s+${recommendedDownload.version.replaceAll('.', '\\.')}のSB3ファイル`,
      'u',
    ),
  );
  assert(!rendered.includes(siteVersionPlaceholder));
  assert.throws(
    () =>
      renderSiteVersion(siteIndex.replace(siteVersionPlaceholder, ''), recommendedDownload.version),
    /Expected exactly one/u,
  );
  assert.throws(
    () => renderSiteVersion(`${siteIndex}\n${siteVersionPlaceholder}`, recommendedDownload.version),
    /found 2/u,
  );
});

test('opens the Urashima web sample from the top-page Web card', async () => {
  const siteIndex = await readFile(path.join(projectRoot, 'site/index.html'), 'utf8');
  const webCardHrefPosition = siteIndex.indexOf(`href="${urashimaWebUrl}"`);
  const webCardStart = siteIndex.lastIndexOf('<a', webCardHrefPosition);
  const webCardEnd = siteIndex.indexOf('</a>', webCardHrefPosition);
  const webCard = siteIndex.slice(webCardStart, webCardEnd + '</a>'.length);
  const heroImagePosition = siteIndex.indexOf('class="hero-image"');
  const siteContentsPosition = siteIndex.indexOf('id="site-contents"');
  const siteContentsCardsStart = siteIndex.indexOf('<div class="cards">', siteContentsPosition);
  const siteContentsCardsEnd = siteIndex.indexOf('</div>', siteContentsCardsStart);
  const siteContentsCards = siteIndex.slice(siteContentsCardsStart, siteContentsCardsEnd);

  assert.ok(webCardHrefPosition >= 0);
  assert.ok(heroImagePosition < webCardHrefPosition);
  assert.ok(webCardHrefPosition < siteContentsPosition);
  assert.doesNotMatch(siteContentsCards, /Web版を開く|stories\/urashima\/web/u);
  assert.match(
    siteContentsCards,
    /href="https:\/\/kubohiroya\.github\.io\/tm-kamishibai-docs\/workshops\/"/u,
  );
  assert.match(siteContentsCards, /ワークショップ一覧へ/u);
  assert.match(webCard, /class="content-card featured-web-card"/u);
  assert.match(webCard, /Web版を開く/u);
  assert.match(webCard, /DSL\s+3\.2系/u);
  assert.match(webCard, /組み込み台本「浦島太郎」/u);
  assert.match(webCard, /DSL 3\.2版「浦島太郎」へ/u);
  assert.doesNotMatch(siteIndex, /https:\/\/sqs\.prof\.cuc\.ac\.jp\/kamishibai\//u);
});

test('links the public sample site without restoring the retired local page', async () => {
  const pages = await Promise.all(
    ['site/index.html', 'site/docs/index.html', 'site/downloads/index.html'].map((relativePath) =>
      readFile(path.join(projectRoot, relativePath), 'utf8'),
    ),
  );

  for (const page of pages) {
    assert.match(page, /href="https:\/\/kubohiroya\.github\.io\/tm-kamishibai-samples\/"/u);
    assert.doesNotMatch(page, /href="(?:\.\.\/)*samples\/"/u);
  }
});

test('keeps only minimal validation scripts in the application repository', async () => {
  const sampleEntries = await readdir(path.join(projectRoot, 'samples')).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  assert.deepEqual(sampleEntries, []);

  const fixtureDirectories = ['manual', 'runtime'];
  const fixtureFiles = [];
  for (const directory of fixtureDirectories) {
    const directoryPath = path.join(projectRoot, 'test/fixtures', directory);
    for (const filename of await readdir(directoryPath)) {
      if (filename.endsWith('.txt')) fixtureFiles.push(path.join(directoryPath, filename));
    }
  }

  assert(fixtureFiles.length > 0, 'No validation scripts were found.');
  for (const fixtureFile of fixtureFiles) {
    const fixture = await readFile(fixtureFile, 'utf8');
    assert(fixture.length < 1_000, `Validation script is not minimal: ${fixtureFile}`);
  }
});
