import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

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
const urashimaWebUrl =
  'https://kubohiroya.github.io/tmpose-kamishibai-samples/stories/urashima/web/';

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
  const [downloadTemplate, readme, packageJsonSource] = await Promise.all([
    readFile(path.join(projectRoot, 'site/downloads/index.html'), 'utf8'),
    readFile(path.join(projectRoot, 'README.md'), 'utf8'),
    readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageJsonSource);
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
    packageJson.devDependencies['@kubohiroya/sb3-toolchain'],
    '0.8.0',
    'SB3 toolchain dependency must use the reviewed exact npm version.',
  );
  assert.doesNotMatch(readme, /github:kubohiroya\/sb3-toolchain#[0-9a-f]{40}/u);
  assert.match(
    readme,
    new RegExp(
      `pnpm add --save-exact @kubohiroya/tmpose-kamishibai@${packageJson.version.replaceAll('.', '\\.')}`,
      'u',
    ),
    'README installation must use the current fixed npm version.',
  );
  assert.doesNotMatch(readme, /github:kubohiroya\/tmpose-kamishibai#v3\.1\.0/u);
  assert.doesNotMatch(readme, /allowBuilds/u);
  assert.match(readme, /github\.com\/kubohiroya\/tmpose-kamishibai-samples/u);
  assert.match(readme, /kubohiroya\.github\.io\/tmpose-kamishibai-samples\//u);
  assert.match(readme, /github\.com\/kubohiroya\/tmpose-kamishibai-docs/u);
  assert.match(readme, /kubohiroya\.github\.io\/tmpose-kamishibai-docs\//u);
  assert.doesNotMatch(readme, /\]\(docs\//u);
  assert.doesNotMatch(readme, /setLoadingCostume=/u);
});

test('builds immutable release artifacts from local snapshots without git history', async () => {
  const implementation = await readFile(
    path.join(projectRoot, 'scripts/sb3/downloadable-releases.mjs'),
    'utf8',
  );
  assert.doesNotMatch(implementation, /node:child_process|\bgit\b/u);

  for (const release of downloadableReleases) {
    const result = await createDownloadableReleaseSb3(release, {
      buildDate: '2099-12-31',
      now: new Date('2099-12-31T00:00:00Z'),
    });
    const digest = createHash('sha256').update(result.archive).digest('hex');
    assert.equal(result.titleBuildMetadata.buildDate, release.buildDate);
    assert.equal(digest, release.sha256);
    await Promise.all([
      readFile(path.join(projectRoot, release.sourceDirectory, 'project.source.json')),
      readFile(path.join(projectRoot, release.faviconPath)),
    ]);
  }
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
    /href="https:\/\/kubohiroya\.github\.io\/tmpose-kamishibai-docs\/workshops\/"/u,
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
    assert.match(page, /href="https:\/\/kubohiroya\.github\.io\/tmpose-kamishibai-samples\/"/u);
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

test('keeps the generic app source free of Urashima sample content', async () => {
  const genericProjectSource = await readFile(
    path.join(projectRoot, 'app/project.source.json'),
    'utf8',
  );
  const genericProject = JSON.parse(genericProjectSource);
  const genericStage = genericProject.targets.find((target) => target.isStage);
  const prompt = genericProject.targets.find((target) => target.name === 'prompt');
  const loading = genericProject.targets.find((target) => target.name === 'Loading');
  const sampleTargetNames = ['Fish', 'Princess', 'Turtle', 'Urashima'];
  const sampleAssetNames = ['Beach1', 'Dragon Castle', 'Ocean Wave', 'Urashima-old-2'];

  assert(genericStage, 'The generic app source has no Stage target.');
  assert.deepEqual(
    {x: prompt?.x, y: prompt?.y, size: prompt?.size},
    {x: -8, y: 150, size: 100},
    'The generic prompt layout differs.',
  );
  assert.deepEqual(
    {x: loading?.x, y: loading?.y, size: loading?.size},
    {x: 1, y: -62, size: 100},
    'The generic loading layout differs.',
  );
  assert.deepEqual(genericStage.variables?.tmposeEmbeddedScript, ['__tmpose_embedded_script', '']);
  assert.equal(
    genericProject.monitors.some((monitor) => monitor.id === 'tmposeEmbeddedScript'),
    false,
    'The reserved embedded script variable must not have a monitor.',
  );
  assert.equal(genericStage.blocks.embeddedScriptChoice?.opcode, 'control_if_else');
  assert.equal(genericStage.blocks.embeddedSetScript?.opcode, 'lmsTempVars2_setRuntimeVariable');
  assert.deepEqual(genericStage.blocks.embeddedSetScript?.inputs?.VAR, [1, [10, 'script']]);
  assert.equal(
    genericStage.blocks.embeddedStartStory?.inputs?.BROADCAST_INPUT?.[1]?.[1],
    'startStory',
  );
  assert.equal(genericStage.blocks['l@']?.inputs?.BROADCAST_INPUT?.[1]?.[1], 'showCover');
  for (const list of Object.values(genericStage.lists ?? {})) {
    assert.deepEqual(list[1], [], `Generic runtime list is not empty: ${list[0]}`);
  }
  for (const targetName of sampleTargetNames) {
    assert(
      !genericProject.targets.some((target) => target.name === targetName),
      `Generic app source contains the sample target: ${targetName}`,
    );
  }

  const genericAssetNames = genericProject.targets.flatMap((target) => [
    ...(target.costumes ?? []).map((costume) => costume.name),
    ...(target.sounds ?? []).map((sound) => sound.name),
  ]);
  for (const assetName of sampleAssetNames) {
    assert(
      !genericAssetNames.includes(assetName),
      `Generic app source contains the sample asset: ${assetName}`,
    );
  }
});
