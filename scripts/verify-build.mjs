import {access, readFile, readdir, stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {
  documentConfig,
  generalDocumentConfig,
  resolveLearnedThroughGrade,
  staffDocumentConfig,
} from '../docs/config.mjs';
import {siteVersionPlaceholder} from './site-version.mjs';
import {createKamishibaiSb3} from './sb3/build.mjs';
import {readTitleBuildMetadataFromSb3} from './sb3/title-build-metadata.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const outputDirectory = path.join(projectRoot, 'dist');
const packageJsonPath = path.join(projectRoot, 'package.json');
const require = createRequire(import.meta.url);
const vivliostyleRequire = createRequire(require.resolve('@vivliostyle/cli/package.json'));
const {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
} = vivliostyleRequire('pdf-lib');
const docsDirectory = path.join(projectRoot, 'dist/docs');
const siteIndexPath = path.join(projectRoot, 'dist/index.html');
const faviconSourcePath = path.join(projectRoot, 'site/favicon.png');
const faviconPath = path.join(outputDirectory, 'favicon.png');
const heroImageSourcePath = path.join(projectRoot, 'docs/images/image01.png');
const heroImagePath = path.join(projectRoot, 'dist/images/image01.png');
const downloadFilename = 'kamishibai.sb3';
const downloadSourceDirectory = path.join(projectRoot, 'site/downloads');
const downloadDirectory = path.join(projectRoot, 'dist/downloads');
const downloadIndexPath = path.join(downloadDirectory, 'index.html');
const downloadPath = path.join(downloadDirectory, downloadFilename);
const docsIndexPath = path.join(docsDirectory, 'index.html');
const siteShellCssPath = path.join(outputDirectory, 'site-shell.css');
const siteShellScriptPath = path.join(outputDirectory, 'site-shell.js');
const generalDirectory = path.join(docsDirectory, generalDocumentConfig.outputDirectory);
const workshopDirectory = path.join(docsDirectory, documentConfig.outputDirectory);
const staffDirectory = path.join(docsDirectory, staffDocumentConfig.outputDirectory);
const tocPath = path.join(workshopDirectory, documentConfig.tocHtmlFilename);
const coverHtmlPath = path.join(workshopDirectory, documentConfig.coverHtmlFilename);
const htmlPath = path.join(
  workshopDirectory,
  documentConfig.sourceFilename.replace(/\.md$/u, '.html'),
);
const workshopSourceDirectory = path.join(projectRoot, 'docs', documentConfig.sourceDirectory);
const coverSourcePath = path.join(workshopSourceDirectory, documentConfig.coverFilename);
const sourcePath = path.join(workshopSourceDirectory, documentConfig.sourceFilename);
const publicationManifestPath = path.join(workshopDirectory, 'publication.json');
const publishedPdfPath = path.join(workshopDirectory, documentConfig.pdfFilename);
const outputPdfPath = path.join(
  projectRoot,
  'output/pdf',
  documentConfig.outputDirectory,
  documentConfig.pdfFilename,
);
const buildInfoPath = path.join(workshopDirectory, 'build-info.json');
const sampleSiteUrl = 'https://kubohiroya.github.io/tmpose-kamishibai-samples/';
const documentationCardIcons = [
  ['🕹️', '紙芝居アプリ 操作説明書'],
  ['✍️', '紙芝居DSLファイル作成マニュアル'],
  ['📚', '紙芝居DSL コマンドリファレンス'],
  ['👥', '紙芝居アプリ 概要説明書 大人向け'],
  ['🧒', '紙芝居アプリ 概要説明書 子供向け'],
  ['🛠️', '紙芝居アプリ ソフトウェアメンテナンスガイド'],
  ['🧩', '紙芝居アプリ内部仕様書'],
  ['🕰️', '紙芝居DSL 2.0から3.1への変更履歴'],
  ['🤖', '親子AIプログラミング体験会 2026年8月1日版'],
  ['🧰', '親子AIプログラミング体験会スタッフ向け資料2026年8月1日版'],
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function attributeValues(html, tagName, attributeName) {
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*\\b${attributeName}="([^"]+)"`, 'gu');
  return [...html.matchAll(tagPattern)].map((match) => match[1]);
}

async function findHtmlFiles(directory) {
  const entries = await readdir(directory, {withFileTypes: true});
  const nestedFiles = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return findHtmlFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith('.html') ? [entryPath] : [];
  }));
  return nestedFiles.flat();
}

async function verifyFavicon() {
  const [sourceFavicon, publishedFavicon, htmlFiles] = await Promise.all([
    readFile(faviconSourcePath),
    readFile(faviconPath),
    findHtmlFiles(outputDirectory),
  ]);
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  assert(sourceFavicon.equals(publishedFavicon),
    'The published favicon differs from site/favicon.png.');
  assert(publishedFavicon.subarray(0, 8).equals(pngSignature),
    'The favicon is not a PNG file.');
  assert(publishedFavicon.readUInt32BE(16) === 256 && publishedFavicon.readUInt32BE(20) === 256,
    'The favicon must be 256 by 256 pixels.');
  assert(publishedFavicon[24] === 8 && publishedFavicon[25] === 6,
    'The favicon must use 8-bit RGBA pixels.');
  assert(htmlFiles.length > 0, 'The generated site does not contain any HTML files.');

  for (const htmlFile of htmlFiles) {
    const html = await readFile(htmlFile, 'utf8');
    const expectedHref = path.relative(path.dirname(htmlFile), faviconPath).split(path.sep).join('/');
    const expectedLink = `<link rel="icon" type="image/png" sizes="256x256" href="${expectedHref}">`;
    const linkCount = html.split(expectedLink).length - 1;

    assert(linkCount === 1,
      `${path.relative(outputDirectory, htmlFile)} must contain exactly one favicon link.`);
    await access(path.resolve(path.dirname(htmlFile), expectedHref));
  }

  return htmlFiles.length;
}

async function verifySiteAppBars() {
  const htmlFiles = await findHtmlFiles(outputDirectory);

  for (const htmlFile of htmlFiles) {
    const html = await readFile(htmlFile, 'utf8');
    const relativeCss = path.relative(path.dirname(htmlFile), siteShellCssPath)
      .split(path.sep)
      .join('/');
    const relativeScript = path.relative(path.dirname(htmlFile), siteShellScriptPath)
      .split(path.sep)
      .join('/');
    const stylesheet = `<link rel=\"stylesheet\" href=\"${relativeCss}\">`;
    const script = `<script type=\"module\" src=\"${relativeScript}\"></script>`;

    assert((html.match(/<header class="site-header">/gu) ?? []).length === 1,
      `${path.relative(outputDirectory, htmlFile)} must contain exactly one site AppBar.`);
    assert(html.split(stylesheet).length - 1 === 1,
      `${path.relative(outputDirectory, htmlFile)} must load the shared site stylesheet once.`);
    assert(html.split(script).length - 1 === 1,
      `${path.relative(outputDirectory, htmlFile)} must load the AppBar behavior once.`);
    assert(html.includes('href=\"https://kubohiroya.github.io/tmpose-kamishibai/\"')
        && html.includes('href=\"https://kubohiroya.github.io/tmpose-kamishibai/docs/\"')
        && html.includes('href=\"https://kubohiroya.github.io/tmpose-kamishibai-samples/\"')
        && html.includes('href=\"https://kubohiroya.github.io/tmpose-kamishibai/downloads/\"'),
    `${path.relative(outputDirectory, htmlFile)} is missing a shared AppBar destination.`);
    await Promise.all([
      access(path.resolve(path.dirname(htmlFile), relativeCss)),
      access(path.resolve(path.dirname(htmlFile), relativeScript)),
    ]);
  }

  return htmlFiles.length;
}

async function verifyLocalReferences(htmlPath, tagName, attributeName) {
  const html = await readFile(htmlPath, 'utf8');
  const references = attributeValues(html, tagName, attributeName)
    .filter((reference) => !/^(?:data:|https?:|mailto:)/u.test(reference));

  for (const reference of references) {
    const [relativePath, encodedFragment] = reference.split('#');
    const targetPath = relativePath
      ? path.resolve(path.dirname(htmlPath), decodeURIComponent(relativePath))
      : htmlPath;
    await access(targetPath);

    if (encodedFragment) {
      const targetHtml = await readFile(targetPath, 'utf8');
      const targetIds = new Set(attributeValues(targetHtml, '[a-z][a-z0-9]*', 'id'));
      const fragment = decodeURIComponent(encodedFragment);
      assert(targetIds.has(fragment), `${reference} does not resolve from ${htmlPath}.`);
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
  const cardCount = (html.match(/<a class="content-card"/gu) ?? []).length;
  const [sourceImage, publishedImage] = await Promise.all([
    readFile(heroImageSourcePath),
    readFile(heroImagePath),
  ]);
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));

  assert(images.includes('images/image01.png'),
    'The top page does not reference the configured hero image.');
  assert(altTexts.includes('カメラ映像の上に浦島太郎とカメを重ね、ポーズ認識で紙芝居を進めているアプリ画面'),
    'The top-page hero image does not have the expected alternative text.');
  assert(sourceImage.equals(publishedImage),
    'The published top-page hero image differs from docs/images/image01.png.');
  assert(cardCount === 4, `Expected four top-page content cards, found ${cardCount}.`);
  assert(allLinks.includes('https://sqs.prof.cuc.ac.jp/kamishibai/'),
    'The top page does not link to the published web app.');
  for (const link of ['docs/', 'downloads/']) {
    assert(localLinks.includes(link), `The top-page card link ${link} is missing.`);
  }
  assert(allLinks.includes(sampleSiteUrl),
    'The top page does not link to the external sample site.');
  for (const icon of ['▶️', '📕', '🎭', '📁']) {
    assert(html.includes(`<span class="card-icon" aria-hidden="true">${icon}</span>`),
      `The top-page card icon ${icon} is missing.`);
  }
  assert(
    html.includes(
      `TurboWarpで編集・実行できるkamishibai ${packageJson.version}`
        + 'のSB3ファイルをダウンロードできます。',
    ),
    'The top-page download card does not use the package version.',
  );
  assert(
    !html.includes(siteVersionPlaceholder) && !html.includes('kamishibai 3.1a1'),
    'The top-page download card contains an unresolved or retired version.',
  );
  assert(!html.includes('class="actions"')
      && !html.includes('docs/workshops/2026-08-01/tmpose-kamishibai-20260801.pdf'),
  'The retired standalone top-page button group remains.');
}

async function verifyDownloads(titleBuildMetadata) {
  const html = await readFile(downloadIndexPath, 'utf8');
  const links = await verifyLocalReferences(downloadIndexPath, 'a', 'href');
  const [
    sourceEntries,
    publishedEntries,
    publishedArchive,
    archiveStat,
    packageJsonSource,
  ] = await Promise.all([
    readdir(downloadSourceDirectory, {withFileTypes: true}),
    readdir(downloadDirectory, {withFileTypes: true}),
    readFile(downloadPath),
    stat(downloadPath),
    readFile(packageJsonPath, 'utf8'),
  ]);
  const publishedMetadata = readTitleBuildMetadataFromSb3(publishedArchive);
  const packageJson = JSON.parse(packageJsonSource);
  assert(publishedMetadata.version === packageJson.version,
    `The published SB3 version ${publishedMetadata.version} differs from package.json ${packageJson.version}.`);
  if (titleBuildMetadata) {
    assert(publishedMetadata.buildDate === titleBuildMetadata.buildDate
        && publishedMetadata.version === titleBuildMetadata.version,
    'The published SB3 metadata differs from the current build metadata.');
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

  assert(links.includes(downloadFilename),
    `${downloadFilename} is missing from the download page.`);
  assert(html.includes(`href="${downloadFilename}" download`),
    'The SB3 link does not use the browser download behavior.');
  assert(html.includes('kamishibai 3.1') && html.includes('ビルド生成'),
    'The download page does not identify the generated kamishibai 3.1 archive.');
  assert(sourceSb3Files.length === 0,
    `site/downloads must not contain tracked SB3 binaries: ${sourceSb3Files.join(', ')}`);
  assert(JSON.stringify(publishedSb3Files) === JSON.stringify([downloadFilename]),
    `Unexpected published SB3 files: ${publishedSb3Files.join(', ')}`);
  assert(publishedArchive.equals(Buffer.from(expectedBuild.archive)),
    'The published SB3 differs from the deterministic app source build.');
  assert(archiveStat.size === publishedArchive.length && archiveStat.size > 0
      && publishedArchive.subarray(0, 2).toString() === 'PK',
    'The published SB3 is not a non-empty ZIP-based Scratch project.');
  assert(Array.isArray(expectedBuild.source.project.targets),
    'The canonical app source project does not contain targets.');

  return {filename: downloadFilename, size: archiveStat.size};
}

async function pdfBookmarkCount(pdfPath) {
  const pdf = await PDFDocument.load(await readFile(pdfPath));
  const outlines = pdf.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
  if (!outlines) {
    return 0;
  }
  return outlines.lookupMaybe(PDFName.of('Count'), PDFNumber)?.asNumber() ?? 0;
}

async function verifyPdfFile(pdfPath, minimumSize = 10_000) {
  const pdf = await readFile(pdfPath);
  const pdfStat = await stat(pdfPath);
  assert(pdf.subarray(0, 5).toString() === '%PDF-', `${pdfPath} is not a PDF.`);
  assert(pdfStat.size > minimumSize, `${pdfPath} is unexpectedly small.`);
  const document = await PDFDocument.load(pdf);
  assert(document.getPageCount() > 0, `${pdfPath} does not contain any pages.`);
  return document.getPageCount();
}

async function verifyGeneralDocuments(grade) {
  const [buildInfo, publicationManifest, generalTheme] = await Promise.all([
    readFile(path.join(generalDirectory, 'build-info.json'), 'utf8').then(JSON.parse),
    readFile(path.join(generalDirectory, 'publication.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectRoot, 'docs/general-theme.css'), 'utf8'),
  ]);
  const readingOrder = publicationManifest.readingOrder.map((entry) => entry.url ?? entry);
  const docsIndexLinks = await verifyLocalReferences(docsIndexPath, 'a', 'href');
  const docsIndex = await readFile(docsIndexPath, 'utf8');
  const generalTocLinks = await verifyLocalReferences(
    path.join(generalDirectory, generalDocumentConfig.tocHtmlFilename),
    'a',
    'href',
  );
  let totalPages = 0;
  let rubyDocumentCount = 0;
  let rubyCount = 0;
  const generatedHeadingIds = new Map(await Promise.all(
    generalDocumentConfig.documents.map(async ({sourceFilename}) => {
      const basename = sourceFilename.replace(/\.md$/u, '');
      const article = await readFile(
        path.join(
          generalDirectory,
          basename,
          generalDocumentConfig.standaloneArticleHtmlFilename,
        ),
        'utf8',
      );
      return [sourceFilename, new Set(attributeValues(article, 'h[1-3]', 'id'))];
    }),
  ));

  assert(buildInfo.publicationKind === 'general-documentation',
    'General build metadata does not identify the general publication.');
  assert(buildInfo.rubyApplied === true && buildInfo.rubyPolicy === 'selected-documents',
    'General build metadata does not identify selective rubygana processing.');
  assert(buildInfo.documents.length === generalDocumentConfig.documents.length,
    'General build metadata does not list every configured document.');
  assert(!docsIndex.includes('一般ドキュメントは原文どおりに組版し、rubyganaによるふりがな追加は行っていません。'),
    'The retired non-ruby note remains on the documentation entrance page.');
  assert((docsIndex.match(/<span class="card-icon" aria-hidden="true">/gu) ?? []).length
      === documentationCardIcons.length,
  `Expected ${documentationCardIcons.length} documentation card icons.`);
  assert((docsIndex.match(/>Vivliostyle Viewer<\/a>/gu) ?? []).length
      === documentationCardIcons.length,
  `Expected ${documentationCardIcons.length} Vivliostyle Viewer links.`);
  assert(generalTheme.includes('counter-reset: general-chapter;')
      && generalTheme.includes('counter-increment: general-section;'),
  'The general theme does not generate body chapter and section numbers.');
  assert(generalTheme.includes('counter-increment: general-toc-chapter;')
      && generalTheme.includes('counter-increment: general-toc-section;'),
  'The general theme does not generate table-of-contents numbers.');
  assert(generalTheme.includes('target-counter(attr(href), general-chapter)')
      && generalTheme.includes('target-counter(attr(href), general-section)'),
  'The general theme does not generate chapter and section cross-reference numbers.');
  assert(
    /#toc > ol > li\[data-section-level="1"\]:only-child > a\s*\{\s*display: none;/u
      .test(generalTheme)
      && /#toc > ol > li\[data-section-level="1"\]:only-child > ol\s*\{\s*padding-left: 0;/u
        .test(generalTheme),
    'A standalone table of contents does not promote chapters to the visual top level.',
  );
  for (const [icon, title] of documentationCardIcons) {
    assert(docsIndex.includes(
      `<h3><span class="card-icon" aria-hidden="true">${icon}</span>${title}</h3>`,
    ), `The documentation card for ${title} does not use the expected ${icon} icon.`);
  }

  for (const generalDocument of generalDocumentConfig.documents) {
    const basename = generalDocument.sourceFilename.replace(/\.md$/u, '');
    const htmlFilename = generalDocument.sourceFilename.replace(/\.md$/u, '.html');
    const pdfFilename = generalDocument.sourceFilename.replace(/\.md$/u, '.pdf');
    const sourcePath = path.join(
      projectRoot,
      'docs',
      generalDocumentConfig.sourceDirectory,
      generalDocument.sourceFilename,
    );
    const htmlPath = path.join(generalDirectory, htmlFilename);
    const standaloneDirectory = path.join(generalDirectory, basename);
    const standaloneTocPath = path.join(
      standaloneDirectory,
      generalDocumentConfig.standaloneTocHtmlFilename,
    );
    const standaloneArticlePath = path.join(
      standaloneDirectory,
      generalDocumentConfig.standaloneArticleHtmlFilename,
    );
    const standaloneManifestPath = path.join(standaloneDirectory, 'publication.json');
    const publishedPdfPath = path.join(generalDirectory, pdfFilename);
    const outputPdfPath = path.join(
      projectRoot,
      'output/pdf',
      generalDocumentConfig.outputDirectory,
      pdfFilename,
    );
    const [source, html, standaloneToc, standaloneArticle, standaloneManifest, publishedPdf, outputPdf]
      = await Promise.all([
      readFile(sourcePath, 'utf8'),
      readFile(htmlPath, 'utf8'),
      readFile(standaloneTocPath, 'utf8'),
      readFile(standaloneArticlePath, 'utf8'),
      readFile(standaloneManifestPath, 'utf8').then(JSON.parse),
      readFile(publishedPdfPath),
      readFile(outputPdfPath),
    ]);
    const standaloneTocLinks = await verifyLocalReferences(
      standaloneTocPath,
      'a',
      'href',
    );
    await verifyLocalReferences(standaloneArticlePath, 'img', 'src');
    const standaloneReadingOrder = standaloneManifest.readingOrder.map(
      (entry) => entry.url ?? entry,
    );
    const standaloneTocNav = standaloneToc.match(
      /<nav\b[^>]*\brole="doc-toc"[^>]*>[\s\S]*?<\/nav>/u,
    )?.[0];

    assert(source.startsWith(`# ${generalDocument.title}\n`),
      `${generalDocument.sourceFilename} does not start with its configured title.`);
    assert(html.includes(generalDocument.title),
      `${htmlFilename} does not contain its configured title.`);
    assert(standaloneArticle.includes(generalDocument.title),
      `${basename}/${generalDocumentConfig.standaloneArticleHtmlFilename} does not contain its configured title.`);
    assert(!/^#{2,3} [0-9]+(?:\.[0-9]+)*\.? /mu.test(source),
      `${generalDocument.sourceFilename} contains a manually numbered h2 or h3 heading.`);
    assert(!/\]\([^)\n]*#[0-9]/u.test(source),
      `${generalDocument.sourceFilename} contains a numeric heading fragment reference.`);
    for (const match of source.matchAll(/\]\((?!https?:)([^)\s]+\.md)#([^)]+)\)/gu)) {
      const [, targetReference, fragment] = match;
      const targetFilename = path.basename(targetReference);
      assert(generatedHeadingIds.get(targetFilename)?.has(decodeURIComponent(fragment)),
        `${targetReference}#${fragment} does not resolve from ${generalDocument.sourceFilename}.`);
    }
    for (const referenceType of ['chapter', 'section']) {
      const sourceReferenceCount = (
        source.match(
          new RegExp(
            `\\]\\([^\\n)]+\\)\\{data-ref="${referenceType}"\\}`,
            'gu',
          ),
        ) ?? []
      ).length;
      const generatedReferenceCount = attributeValues(standaloneArticle, 'a', 'data-ref')
        .filter((value) => value === referenceType)
        .length;
      assert(sourceReferenceCount === generatedReferenceCount,
        `${generalDocument.sourceFilename} lost a ${referenceType} cross-reference attribute.`);
    }
    if (generalDocument.sourceFilename === '02-executive-summary-kids.md') {
      assert(!source.includes('忍者') && !source.includes('銅像')
          && !standaloneArticle.includes('忍者') && !standaloneArticle.includes('銅像'),
      'The retired ninja/statue sentence remains in the kids summary.');
    }
    assert(standaloneTocNav,
      `${basename}/${generalDocumentConfig.standaloneTocHtmlFilename} does not contain a Vivliostyle-generated table of contents.`);
    assert(standaloneTocNav.includes('<h2>目次</h2>'),
      `${basename}/${generalDocumentConfig.standaloneTocHtmlFilename} does not use the configured table-of-contents title.`);
    assert(JSON.stringify(standaloneReadingOrder) === JSON.stringify([
      generalDocumentConfig.standaloneTocHtmlFilename,
      generalDocumentConfig.standaloneArticleHtmlFilename,
    ]), `Unexpected standalone reading order for ${basename}: ${standaloneReadingOrder.join(', ')}`);
    assert(standaloneManifest.readingOrder[0].rel === 'contents',
      `${basename}/publication.json does not identify its table of contents.`);
    const bodyHeadingIds = attributeValues(standaloneArticle, 'h[1-3]', 'id');
    const tocHeadingIds = standaloneTocLinks.flatMap((reference) => {
      const [relativePath, encodedFragment] = reference.split('#');
      return relativePath === generalDocumentConfig.standaloneArticleHtmlFilename
          && encodedFragment
        ? [decodeURIComponent(encodedFragment)]
        : [];
    });
    assert(JSON.stringify(tocHeadingIds) === JSON.stringify(bodyHeadingIds),
      `${basename} table of contents does not match its h1-h3 headings.`);
    const documentBuildInfo = buildInfo.documents.find(
      ({sourceFilename}) => sourceFilename === generalDocument.sourceFilename,
    );
    const shouldAddFurigana = generalDocument.addFurigana === true;
    const documentRubyCount = (standaloneArticle.match(/<ruby\b/gu) ?? []).length;
    const codeBlocks = standaloneArticle.match(/<pre\b[\s\S]*?<\/pre>/gu) ?? [];
    assert(documentBuildInfo?.rubyApplied === shouldAddFurigana,
      `${htmlFilename} has inconsistent rubygana build metadata.`);
    assert(documentBuildInfo?.webPublicationDirectory === basename,
      `${htmlFilename} build metadata does not record its standalone Web Publication.`);
    assert(documentBuildInfo?.generatedTableOfContents?.htmlFilename
        === generalDocumentConfig.standaloneTocHtmlFilename
        && documentBuildInfo.generatedTableOfContents.sectionDepth
          === generalDocumentConfig.tocSectionDepth,
    `${htmlFilename} build metadata does not record its generated table of contents.`);
    if (shouldAddFurigana) {
      assert(standaloneArticle.includes(`data-rubygana-grade="${grade}"`),
        `${htmlFilename} does not record the configured rubygana grade.`);
      assert(documentRubyCount >= 20,
        `${htmlFilename} was not processed by rubygana.`);
      assert(documentBuildInfo.learnedThroughGrade === grade,
        `${htmlFilename} does not record its learned-through grade.`);
      assert(codeBlocks.every((block) => !block.includes('<ruby')),
        `rubygana changed a code block in ${htmlFilename}.`);
      rubyDocumentCount += 1;
      rubyCount += documentRubyCount;
    } else {
      assert(documentRubyCount === 0 && !standaloneArticle.includes('data-rubygana-grade='),
        `${htmlFilename} was unexpectedly processed by rubygana.`);
    }
    assert(readingOrder.includes(htmlFilename),
      `${htmlFilename} is missing from the general publication reading order.`);
    assert(docsIndexLinks.includes(`${generalDocumentConfig.outputDirectory}/${basename}/`),
      `${basename}/ is missing from the documentation entrance page.`);
    assert(docsIndexLinks.includes(`${generalDocumentConfig.outputDirectory}/${pdfFilename}`),
      `${pdfFilename} is missing from the documentation entrance page.`);
    assert(docsIndex.includes(
      `href="https://vivliostyle.org/viewer/#src=https://kubohiroya.github.io/`
        + `tmpose-kamishibai/docs/general/${basename}/publication.json&amp;bookMode=true"`,
    ), `${basename} Vivliostyle Viewer link is missing from the documentation entrance page.`);
    assert(publishedPdf.equals(outputPdf),
      `${pdfFilename} differs between dist/docs and output/pdf.`);

    totalPages += await verifyPdfFile(publishedPdfPath);
    await verifyPdfFile(outputPdfPath);
    const bookmarkCount = await pdfBookmarkCount(publishedPdfPath);
    assert(bookmarkCount >= bodyHeadingIds.length,
      `${pdfFilename} does not contain bookmarks for its generated table of contents.`);
  }

  assert(generalTocLinks.length >= generalDocumentConfig.documents.length,
    'General publication TOC does not link to every document.');
  assert(rubyDocumentCount === 1 && rubyCount > 0,
    `Expected one furigana-enabled general document, found ${rubyDocumentCount}.`);
  assert(docsIndexLinks.includes(
    `${documentConfig.outputDirectory}/${documentConfig.pdfFilename}`,
  ), 'Workshop PDF is missing from the documentation entrance page.');

  return {
    documentCount: generalDocumentConfig.documents.length,
    pageCount: totalPages,
    rubyCount,
    rubyDocumentCount,
  };
}

async function verifyStaffDocument() {
  const sourcePath = path.join(
    projectRoot,
    'docs',
    staffDocumentConfig.sourceDirectory,
    staffDocumentConfig.sourceFilename,
  );
  const htmlPath = path.join(staffDirectory, staffDocumentConfig.htmlFilename);
  const publishedPdfPath = path.join(staffDirectory, staffDocumentConfig.pdfFilename);
  const outputPdfPath = path.join(
    projectRoot,
    'output/pdf',
    staffDocumentConfig.outputDirectory,
    staffDocumentConfig.pdfFilename,
  );
  const [source, html, buildInfo, publicationManifest, publishedPdf, outputPdf] = await Promise.all([
    readFile(sourcePath, 'utf8'),
    readFile(htmlPath, 'utf8'),
    readFile(path.join(staffDirectory, 'build-info.json'), 'utf8').then(JSON.parse),
    readFile(path.join(staffDirectory, 'publication.json'), 'utf8').then(JSON.parse),
    readFile(publishedPdfPath),
    readFile(outputPdfPath),
  ]);
  const docsIndexLinks = await verifyLocalReferences(docsIndexPath, 'a', 'href');
  const images = await verifyLocalReferences(htmlPath, 'img', 'src');
  const contentImages = images.filter((image) => !image.endsWith('favicon.png'));
  const readingOrder = publicationManifest.readingOrder.map((entry) => entry.url ?? entry);

  assert(source.startsWith(`# ${staffDocumentConfig.title}\n`),
    'Staff Markdown does not start with the configured title.');
  assert(/^# 1\. 体験会運営用資料$/mu.test(source),
    'Staff Markdown does not contain the reorganized operations section.');
  assert(!/^## 2\. アプリ$/mu.test(source)
      && !/^## 3\. (?:関連)?ライブラリ(?:など)?$/mu.test(source),
  'Staff Markdown still contains developer documentation.');
  assert(!/^#{1,3} [ABC]\./mu.test(source),
    'Staff Markdown still uses appendix-style headings.');
  assert(html.includes(staffDocumentConfig.title),
    'Staff HTML does not contain its configured title.');
  assert(!html.includes('<ruby') && !html.includes('data-rubygana-grade='),
    'Staff HTML was unexpectedly processed by rubygana.');
  assert(contentImages.length === 1 && contentImages[0] === 'images/image03.jpg',
    'Staff HTML does not contain the expected local venue map.');
  assert(JSON.stringify(readingOrder) === JSON.stringify([staffDocumentConfig.htmlFilename]),
    `Unexpected staff publication reading order: ${readingOrder.join(', ')}`);
  assert(buildInfo.publicationKind === 'workshop-staff-documentation'
      && buildInfo.rubyApplied === false,
  'Staff build metadata does not identify a non-ruby staff publication.');
  assert(docsIndexLinks.includes(`${staffDocumentConfig.outputDirectory}/`),
    'Staff HTML is missing from the documentation entrance page.');
  assert(docsIndexLinks.includes(
    `${staffDocumentConfig.outputDirectory}/${staffDocumentConfig.pdfFilename}`,
  ), 'Staff PDF is missing from the documentation entrance page.');
  assert(publishedPdf.equals(outputPdf),
    'Staff PDF differs between dist/docs and output/pdf.');

  const pageCount = await verifyPdfFile(publishedPdfPath);
  await verifyPdfFile(outputPdfPath);
  return {imageCount: contentImages.length, pageCount};
}

export async function verifyBuild({titleBuildMetadata} = {}) {
  const grade = resolveLearnedThroughGrade();
  const buildInfo = JSON.parse(await readFile(buildInfoPath, 'utf8'));
  const publicationManifest = JSON.parse(await readFile(publicationManifestPath, 'utf8'));
  const coverSource = await readFile(coverSourcePath, 'utf8');
  const source = await readFile(sourcePath, 'utf8');
  const combinedSource = `${coverSource}\n${source}`;
  const toc = await readFile(tocPath, 'utf8');
  const coverHtml = await readFile(coverHtmlPath, 'utf8');
  const html = await readFile(htmlPath, 'utf8');
  const combinedHtml = `${coverHtml}\n${html}`;
  const rubyCount = (combinedHtml.match(/<ruby\b/gu) ?? []).length;
  const sourceNameCount = (combinedSource.match(/久保裕也/gu) ?? []).length;
  const correctNameRubyCount = (
    combinedHtml.match(/<ruby><rb>裕也<\/rb>[\s\S]*?<rt>ひろや<\/rt>[\s\S]*?<\/ruby>/gu) ?? []
  ).length;
  const incorrectNameRubyCount = (
    combinedHtml.match(/<ruby><rb>裕也<\/rb>[\s\S]*?<rt>ゆうや<\/rt>[\s\S]*?<\/ruby>/gu) ?? []
  ).length;
  const tocLabelCount = (toc.match(/class="toc-label"/gu) ?? []).length;
  const codeBlocks = combinedHtml.match(/<pre\b[\s\S]*?<\/pre>/gu) ?? [];
  const docsEntries = await readdir(docsDirectory, {withFileTypes: true});
  const tocLinks = (await verifyLocalReferences(tocPath, 'a', 'href'))
    .filter((reference) => reference !== '#main-content');
  const coverImages = await verifyLocalReferences(coverHtmlPath, 'img', 'src');
  const bodyImages = await verifyLocalReferences(htmlPath, 'img', 'src');
  const images = [...coverImages, ...bodyImages];
  const readingOrder = publicationManifest.readingOrder.map((entry) => entry.url ?? entry);
  const legacySamplesExists = await access(path.join(outputDirectory, 'samples')).then(
    () => true,
    () => false,
  );
  await verifySiteIndex();
  const downloadResults = await verifyDownloads(titleBuildMetadata);
  const generalResults = await verifyGeneralDocuments(grade);
  const staffResults = await verifyStaffDocument();
  const faviconHtmlCount = await verifyFavicon();
  const appBarHtmlCount = await verifySiteAppBars();
  const bodyHeadingIds = attributeValues(html, 'h[1-4]', 'id');
  const bodyHtmlFilename = documentConfig.sourceFilename.replace(/\.md$/u, '.html');
  const tocHeadingIds = tocLinks.flatMap((reference) => {
    const [relativePath, encodedFragment] = reference.split('#');
    return relativePath === bodyHtmlFilename && encodedFragment
      ? [decodeURIComponent(encodedFragment)]
      : [];
  });

  assert(!legacySamplesExists,
    'The retired /samples/ page is still present in the published site.');

  assert(buildInfo.rubyApplied === true,
    'Workshop build metadata does not record rubygana processing.');
  assert(buildInfo.kanjiDataset.id === 'mext-h29',
    'Build does not use the current MEXT kanji dataset.');
  assert(buildInfo.kanjiDataset.gradeCounts.reduce((total, count) => total + count, 0) === 1026,
    'Build does not record all 1,026 elementary school kanji.');
  assert(buildInfo.publicationKind === 'workshop-documentation',
    'Build metadata does not identify the workshop publication.');
  assert(buildInfo.navigation.viewerBookMode === true,
    'Build metadata does not record Vivliostyle Viewer Book Mode.');
  assert(buildInfo.navigation.pdfBookmarks === 'generatedTableOfContents',
    'Build metadata does not identify the generated TOC as the PDF bookmark source.');
  assert(buildInfo.coverFilename === documentConfig.coverFilename,
    'Build metadata does not identify the configured Markdown cover.');
  assert(buildInfo.sourceFilename === documentConfig.sourceFilename,
    'Build metadata does not identify the configured Markdown source.');
  assert(buildInfo.sourceDirectory === documentConfig.sourceDirectory,
    'Build metadata does not identify the workshop source directory.');
  assert(buildInfo.generatedTableOfContents.sectionDepth === documentConfig.tocSectionDepth,
    'Build metadata does not record the configured TOC depth.');
  assert(buildInfo.generatedTableOfContents.htmlFilename === documentConfig.tocHtmlFilename,
    'Build metadata does not identify the generated TOC HTML.');
  assert(!/^## 目次\s*$/mu.test(combinedSource),
    'Documentation source contains a manually maintained table of contents.');
  assert(!/^#{1,6}\s+!\[/mu.test(combinedSource),
    'Documentation source contains an image-only heading.');
  assert(!/^# [ABC]\. 付録/mu.test(source),
    'Participant documentation still contains staff appendices.');
  assert(JSON.stringify(readingOrder.slice(0, 3)) === JSON.stringify([
    documentConfig.coverHtmlFilename,
    documentConfig.tocHtmlFilename,
    documentConfig.sourceFilename.replace(/\.md$/u, '.html'),
  ]), `Unexpected publication reading order: ${readingOrder.join(', ')}`);
  assert(!toc.includes(documentConfig.coverHtmlFilename),
    'Documentation cover is included in the table of contents.');
  assert(!toc.includes(`href="${documentConfig.sourceFilename.replace(/\.md$/u, '.html')}">`),
    'Documentation table of contents contains a duplicate body-title link.');
  assert(toc.includes('<nav id="toc" role="doc-toc">'),
    'Documentation does not contain a generated doc-toc navigation.');
  assert(!/<body\b[^>]*>\s*<h1\b/iu.test(toc),
    'Documentation table of contents still contains a duplicate publication title.');
  assert(tocHeadingIds.length === tocLinks.length,
    'Documentation table of contents contains a link outside the generated body headings.');
  assert(JSON.stringify(tocHeadingIds) === JSON.stringify(bodyHeadingIds),
    `Expected TOC links for ${bodyHeadingIds.length} rendered headings in document order, `
      + `found ${tocHeadingIds.length}.`);
  assert(tocLabelCount === tocLinks.length,
    `Expected every TOC link to contain one label, found ${tocLabelCount} labels.`);
  assert(toc.includes(`data-section-level="${documentConfig.tocSectionDepth}"`),
    'Documentation table of contents does not include its configured deepest headings.');
  assert(!toc.includes(`data-section-level="${documentConfig.tocSectionDepth + 1}"`),
    'Documentation table of contents includes headings deeper than configured.');
  assert(!html.includes('付録1-体験会運営用資料')
      && !html.includes('付録2-アプリ')
      && !html.includes('付録3-ライブラリなど'),
  'Participant HTML still contains staff appendices.');
  assert(coverHtml.includes('data-publication-section="cover"'),
    'Documentation cover is not identified as the cover section.');
  assert(toc.includes('data-publication-section="toc"'),
    'Documentation table of contents is not identified as the TOC section.');
  assert(html.includes('data-publication-section="body"'),
    'Documentation body is not identified as the body section.');
  assert(coverHtml.includes('class="furigana-build-note"'),
    'Documentation cover does not contain the furigana build note.');
  assert(coverHtml.includes(`href="${documentConfig.tocHtmlFilename}"`),
    'Documentation cover does not link to the table of contents.');
  assert(!coverHtml.includes('vivliostyle.org/viewer/#src='),
    'Documentation cover still contains the redundant Vivliostyle Viewer link.');
  assert(!coverHtml.includes('href="../../"'),
    'Documentation cover still contains the redundant documentation-list link.');
  assert(!toc.includes('class="furigana-build-note"')
      && !html.includes('class="furigana-build-note"'),
    'Furigana build note appears outside the documentation cover.');
  assert(!html.includes('{#1.3-この作品は、どんな技術でできているの？}'),
    'Documentation HTML contains an unresolved Markdown ID attribute.');
  assert(rubyCount >= 500,
    `Expected at least 500 ruby elements, found ${rubyCount}.`);
  assert(codeBlocks.every((block) => !block.includes('<ruby')),
    'rubygana changed a code block.');
  assert(combinedHtml.includes('<rt>りゅうぐうじょう</rt>'),
    'The 竜宮城 reading override was not applied.');
  assert(sourceNameCount > 0 && correctNameRubyCount === sourceNameCount,
    'The scoped 久保裕也 name reading override was not applied to every occurrence.');
  assert(incorrectNameRubyCount === 0,
    'Documentation HTML still contains the incorrect ゆうや reading.');
  assert(images.length > 0, 'Generated documentation does not contain any local images.');
  assert(!combinedHtml.includes('data:image/'),
    'Documentation HTML contains an embedded image data URL.');
  assert(toc.includes(`data-rubygana-grade="${grade}"`),
    'Documentation TOC does not record the configured grade.');
  assert(coverHtml.includes(`data-rubygana-grade="${grade}"`),
    'Documentation cover does not record the configured grade.');
  assert(html.includes(`data-rubygana-grade="${grade}"`),
    'Documentation HTML does not record the configured grade.');
  assert(docsEntries.every((entry) => !['dist', 'docs', 'tmp', 'textbook'].includes(entry.name)),
    'Web Publication contains a copied build, temporary directory, or obsolete textbook output.');
  assert(docsEntries.every((entry) => entry.name !== 'tmpose-kamishibai-guide.pdf'),
    'Web Publication still contains the replaced guide PDF.');

  for (const pdfPath of [publishedPdfPath, outputPdfPath]) {
    await verifyPdfFile(pdfPath, 50_000);
    const bookmarkCount = await pdfBookmarkCount(pdfPath);
    assert(bookmarkCount === tocLinks.length,
      `Expected ${tocLinks.length} PDF bookmarks in ${pdfPath}, found ${bookmarkCount}.`);
  }

  console.log(
    `Verified ${generalResults.documentCount} general HTML/PDF pairs `
      + `(${generalResults.pageCount} PDF pages/${generalResults.rubyCount} ruby elements in `
      + `${generalResults.rubyDocumentCount} document), ${tocLinks.length} workshop TOC links, `
      + `${images.length} workshop images, `
      + `staff PDF ${staffResults.pageCount} pages/${staffResults.imageCount} image, `
      + `${rubyCount} ruby elements, `
      + `favicon links and AppBars in ${faviconHtmlCount}/${appBarHtmlCount} HTML file(s), `
      + `${tocLinks.length} PDF bookmarks, ${downloadResults.filename} `
      + `(${downloadResults.size} bytes), and both PDF copies.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyBuild();
}
