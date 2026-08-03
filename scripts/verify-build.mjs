import {access, readFile, readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {siteVersionPlaceholder} from './site-version.mjs';
import {createKamishibaiSb3} from './sb3/build.mjs';
import {readTitleBuildMetadataFromSb3} from './sb3/title-build-metadata.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const outputDirectory = path.join(projectRoot, 'dist');
const packageJsonPath = path.join(projectRoot, 'package.json');
const siteIndexPath = path.join(outputDirectory, 'index.html');
const faviconSourcePath = path.join(projectRoot, 'site/favicon.png');
const faviconPath = path.join(outputDirectory, 'favicon.png');
const heroImageSourcePath = path.join(projectRoot, 'site/images/image01.png');
const heroImagePath = path.join(outputDirectory, 'images/image01.png');
const downloadFilename = 'kamishibai.sb3';
const downloadSourceDirectory = path.join(projectRoot, 'site/downloads');
const downloadDirectory = path.join(outputDirectory, 'downloads');
const downloadIndexPath = path.join(downloadDirectory, 'index.html');
const downloadPath = path.join(downloadDirectory, downloadFilename);
const siteShellCssPath = path.join(outputDirectory, 'site-shell.css');
const siteShellScriptPath = path.join(outputDirectory, 'site-shell.js');
const docsSiteUrl = 'https://kubohiroya.github.io/tmpose-kamishibai-docs/';
const sampleSiteUrl = 'https://kubohiroya.github.io/tmpose-kamishibai-samples/';
const urashimaWebUrl = `${sampleSiteUrl}stories/urashima/web/`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function attributeValues(html, tagName, attributeName) {
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*\\b${attributeName}="([^"]+)"`, 'gu');
  return [...html.matchAll(tagPattern)].map((match) => match[1]);
}

async function findHtmlFiles(directory) {
  const entries = await readdir(directory, {withFileTypes: true});
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return findHtmlFiles(entryPath);
      return entry.isFile() && entry.name.endsWith('.html') ? [entryPath] : [];
    }),
  );
  return nestedFiles.flat();
}

async function verifyFavicon() {
  const [sourceFavicon, publishedFavicon, htmlFiles] = await Promise.all([
    readFile(faviconSourcePath),
    readFile(faviconPath),
    findHtmlFiles(outputDirectory),
  ]);
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  assert(
    sourceFavicon.equals(publishedFavicon),
    'The published favicon differs from site/favicon.png.',
  );
  assert(publishedFavicon.subarray(0, 8).equals(pngSignature), 'The favicon is not a PNG file.');
  assert(
    publishedFavicon.readUInt32BE(16) === 256 && publishedFavicon.readUInt32BE(20) === 256,
    'The favicon must be 256 by 256 pixels.',
  );
  assert(
    publishedFavicon[24] === 8 && publishedFavicon[25] === 6,
    'The favicon must use 8-bit RGBA pixels.',
  );
  assert(htmlFiles.length > 0, 'The generated site does not contain any HTML files.');

  for (const htmlFile of htmlFiles) {
    const html = await readFile(htmlFile, 'utf8');
    const expectedHref = path
      .relative(path.dirname(htmlFile), faviconPath)
      .split(path.sep)
      .join('/');
    const expectedLink = `<link rel="icon" type="image/png" sizes="256x256" href="${expectedHref}">`;
    assert(
      html.split(expectedLink).length - 1 === 1,
      `${path.relative(outputDirectory, htmlFile)} must contain exactly one favicon link.`,
    );
    await access(path.resolve(path.dirname(htmlFile), expectedHref));
  }

  return htmlFiles.length;
}

async function verifySiteAppBars() {
  const htmlFiles = await findHtmlFiles(outputDirectory);

  for (const htmlFile of htmlFiles) {
    const html = await readFile(htmlFile, 'utf8');
    const relativeCss = path
      .relative(path.dirname(htmlFile), siteShellCssPath)
      .split(path.sep)
      .join('/');
    const relativeScript = path
      .relative(path.dirname(htmlFile), siteShellScriptPath)
      .split(path.sep)
      .join('/');
    const stylesheets = attributeValues(html, 'link', 'href');
    const scripts = attributeValues(html, 'script', 'src');

    assert(
      (html.match(/<header class="site-header">/gu) ?? []).length === 1,
      `${path.relative(outputDirectory, htmlFile)} must contain exactly one site AppBar.`,
    );
    assert(
      stylesheets.filter((href) => href === relativeCss).length === 1,
      `${path.relative(outputDirectory, htmlFile)} must load the site stylesheet once.`,
    );
    assert(
      scripts.filter((src) => src === relativeScript).length === 1,
      `${path.relative(outputDirectory, htmlFile)} must load the AppBar behavior once.`,
    );
    for (const destination of [
      'https://kubohiroya.github.io/tmpose-kamishibai/',
      docsSiteUrl,
      sampleSiteUrl,
      'https://kubohiroya.github.io/tmpose-kamishibai/downloads/',
    ]) {
      assert(
        html.includes(`href="${destination}"`),
        `${path.relative(outputDirectory, htmlFile)} is missing ${destination}.`,
      );
    }
    assert(
      !html.includes('href="https://kubohiroya.github.io/tmpose-kamishibai/docs/"'),
      `${path.relative(outputDirectory, htmlFile)} still uses the old documentation URL.`,
    );
    await Promise.all([
      access(path.resolve(path.dirname(htmlFile), relativeCss)),
      access(path.resolve(path.dirname(htmlFile), relativeScript)),
    ]);
  }

  return htmlFiles.length;
}

async function verifyLocalReferences(htmlPath, tagName, attributeName) {
  const html = await readFile(htmlPath, 'utf8');
  const references = attributeValues(html, tagName, attributeName).filter(
    (reference) => !/^(?:data:|https?:|mailto:)/u.test(reference),
  );

  for (const reference of references) {
    const [relativePath, encodedFragment] = reference.split('#');
    const targetPath = relativePath
      ? path.resolve(path.dirname(htmlPath), decodeURIComponent(relativePath))
      : htmlPath;
    await access(targetPath);

    if (encodedFragment) {
      const targetHtml = await readFile(targetPath, 'utf8');
      const targetIds = new Set(attributeValues(targetHtml, '[a-z][a-z0-9]*', 'id'));
      assert(
        targetIds.has(decodeURIComponent(encodedFragment)),
        `${reference} does not resolve from ${htmlPath}.`,
      );
    }
  }

  return references;
}

async function verifySiteIndex() {
  const html = await readFile(siteIndexPath, 'utf8');
  const images = await verifyLocalReferences(siteIndexPath, 'img', 'src');
  const localLinks = await verifyLocalReferences(siteIndexPath, 'a', 'href');
  const allLinks = attributeValues(html, 'a', 'href');
  const altTexts = attributeValues(html, 'img', 'alt');
  const cardCount = (html.match(/<a\b(?=[^>]*class="content-card")[^>]*>/gu) ?? []).length;
  const [sourceImage, publishedImage, packageJson] = await Promise.all([
    readFile(heroImageSourcePath),
    readFile(heroImagePath),
    readFile(packageJsonPath, 'utf8').then(JSON.parse),
  ]);

  assert(images.includes('images/image01.png'), 'The top page does not reference the hero image.');
  assert(
    altTexts.includes(
      'カメラ映像の上に浦島太郎とカメを重ね、ポーズ認識で紙芝居を進めているアプリ画面',
    ),
    'The top-page hero image does not have the expected alternative text.',
  );
  assert(
    sourceImage.equals(publishedImage),
    'The published top-page hero image differs from site/images/image01.png.',
  );
  assert(cardCount === 4, `Expected four top-page content cards, found ${cardCount}.`);
  assert(allLinks.includes(urashimaWebUrl), 'The top page does not link to the Urashima sample.');
  assert(allLinks.includes(docsSiteUrl), 'The top page does not link to the documentation site.');
  assert(!localLinks.includes('docs/'), 'The top page still links to a local documentation build.');
  assert(localLinks.includes('downloads/'), 'The top-page download card is missing.');
  assert(allLinks.includes(sampleSiteUrl), 'The top page does not link to the sample site.');
  assert(
    !allLinks.includes('https://sqs.prof.cuc.ac.jp/kamishibai/'),
    'The top page still links to the retired SQS web app.',
  );
  for (const icon of ['▶️', '📕', '🎭', '📁']) {
    assert(
      html.includes(`<span class="card-icon" aria-hidden="true">${icon}</span>`),
      `The top-page card icon ${icon} is missing.`,
    );
  }
  assert(
    html
      .replace(/\s+/gu, ' ')
      .includes(
        `TurboWarpで編集・実行できるkamishibai ${packageJson.version}` +
          'のSB3ファイルをダウンロードできます。',
      ),
    'The top-page download card does not use the package version.',
  );
  assert(
    !html.includes(siteVersionPlaceholder) && !html.includes('kamishibai 3.1a1'),
    'The top-page download card contains an unresolved or retired version.',
  );
}

async function verifyDownloads(titleBuildMetadata) {
  const html = await readFile(downloadIndexPath, 'utf8');
  const links = await verifyLocalReferences(downloadIndexPath, 'a', 'href');
  const [sourceEntries, publishedEntries, publishedArchive, archiveStat, packageJson] =
    await Promise.all([
      readdir(downloadSourceDirectory, {withFileTypes: true}),
      readdir(downloadDirectory, {withFileTypes: true}),
      readFile(downloadPath),
      stat(downloadPath),
      readFile(packageJsonPath, 'utf8').then(JSON.parse),
    ]);
  const publishedMetadata = readTitleBuildMetadataFromSb3(publishedArchive);

  assert(
    publishedMetadata.version === packageJson.version,
    `The published SB3 version ${publishedMetadata.version} differs from package.json.`,
  );
  if (titleBuildMetadata) {
    assert(
      publishedMetadata.buildDate === titleBuildMetadata.buildDate &&
        publishedMetadata.version === titleBuildMetadata.version,
      'The published SB3 metadata differs from the current build metadata.',
    );
  }
  const expectedBuild = await createKamishibaiSb3({
    buildDate: publishedMetadata.buildDate,
    version: publishedMetadata.version,
  });
  const sourceSb3Files = sourceEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sb3'))
    .map((entry) => entry.name);
  const publishedSb3Files = publishedEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sb3'))
    .map((entry) => entry.name)
    .sort();

  assert(
    links.includes(downloadFilename),
    `${downloadFilename} is missing from the download page.`,
  );
  assert(
    html.includes(`href="${downloadFilename}" download`),
    'The SB3 link does not use the browser download behavior.',
  );
  assert(sourceSb3Files.length === 0, 'site/downloads must not contain tracked SB3 binaries.');
  assert(
    JSON.stringify(publishedSb3Files) === JSON.stringify([downloadFilename]),
    `Unexpected published SB3 files: ${publishedSb3Files.join(', ')}`,
  );
  assert(
    publishedArchive.equals(Buffer.from(expectedBuild.archive)),
    'The published SB3 differs from the deterministic app source build.',
  );
  assert(
    archiveStat.size === publishedArchive.length &&
      archiveStat.size > 0 &&
      publishedArchive.subarray(0, 2).toString() === 'PK',
    'The published SB3 is not a non-empty ZIP-based Scratch project.',
  );

  return {filename: downloadFilename, size: archiveStat.size};
}

export async function verifyBuild({titleBuildMetadata} = {}) {
  await verifySiteIndex();
  const downloadResults = await verifyDownloads(titleBuildMetadata);
  const faviconHtmlCount = await verifyFavicon();
  const appBarHtmlCount = await verifySiteAppBars();
  const docsEntries = await readdir(path.join(outputDirectory, 'docs'));

  assert(
    JSON.stringify(docsEntries.sort()) === JSON.stringify(['index.html']),
    `The legacy documentation path must contain only its redirect page: ${docsEntries.join(', ')}`,
  );
  await access(path.join(outputDirectory, 'docs/index.html'));
  await access(path.join(outputDirectory, 'images/image01.png'));

  console.log(
    `Verified favicon links and AppBars in ${faviconHtmlCount}/${appBarHtmlCount} HTML file(s), ` +
      `${downloadResults.filename} (${downloadResults.size} bytes), the external documentation ` +
      'link, and the legacy /docs/ redirect.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyBuild();
}
