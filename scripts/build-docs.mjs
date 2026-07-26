import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {copyFile, cp, mkdir, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {
  documentConfig,
  generalDocumentConfig,
  resolveLearnedThroughGrade,
  staffDocumentConfig,
} from '../docs/config.mjs';

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const vivliostyleBin = path.join(
  path.dirname(require.resolve('@vivliostyle/cli/package.json')),
  'dist/cli.js',
);
const rubyganaBin = path.join(
  path.dirname(require.resolve('rubygana/package.json')),
  'bin/rubygana.js',
);
const rubyganaPackage = require('rubygana/package.json');
const rubyganaGradeData = require('rubygana/lib/学年別漢字.js').metadata;

function runNode(script, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: projectRoot,
      stdio: 'inherit',
      ...options,
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(script)} exited with ${signal ?? code}.`));
    });
  });
}

function runRubygana(input, output, grade) {
  return new Promise((resolve, reject) => {
    const rubyArguments = documentConfig.rubyOverrides.flatMap((override) => [
      '--ruby',
      override,
    ]);
    const child = spawn(process.execPath, [
      rubyganaBin,
      '--html',
      '--grade',
      String(grade),
      '--use-rp',
      ...rubyArguments,
      input,
    ], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const chunks = [];

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stdout.on('error', reject);
    child.on('error', reject);
    child.on('exit', async (code, signal) => {
      if (code !== 0) {
        reject(new Error(`rubygana exited with ${signal ?? code}.`));
        return;
      }

      try {
        await writeFile(output, Buffer.concat(chunks));
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function findHtmlFiles(directory) {
  const entries = await readdir(directory, {withFileTypes: true});
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return findHtmlFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith('.html') ? [entryPath] : [];
  }));
  return nested.flat();
}

async function processWorkshopHtmlFiles(directory, grade) {
  const htmlFiles = await findHtmlFiles(directory);
  if (htmlFiles.length === 0) {
    throw new Error('Vivliostyle did not generate workshop HTML documents.');
  }

  for (const htmlFile of htmlFiles) {
    await prepareWorkshopHtml(htmlFile, grade);
    await applyRubygana(htmlFile, grade);
  }

  return htmlFiles;
}

async function applyRubygana(htmlFile, grade) {
  const rubyOutput = `${htmlFile}.rubygana`;
  await runRubygana(htmlFile, rubyOutput, grade);
  await rename(rubyOutput, htmlFile);
}

function baseBuildInfo(details = {}) {
  return {
    htmlAndPdfGenerator: 'Vivliostyle CLI 11.1.0',
    ...details,
  };
}

function rubyganaBuildDetails(grade) {
  return {
    learnedThroughGrade: grade,
    rubyGenerator: `${rubyganaPackage.name} ${rubyganaPackage.version}`,
    kanjiDataset: {
      id: rubyganaGradeData.id,
      sourceUrl: rubyganaGradeData.sourceUrl,
      gradeCounts: rubyganaGradeData.expectedGradeCounts,
    },
  };
}

function workshopBuildInfo(grade, details = {}) {
  return baseBuildInfo({
    rubyApplied: true,
    ...rubyganaBuildDetails(grade),
    ...details,
  });
}

async function writeBuildInfo(directory, buildInfo) {
  await writeFile(
    path.join(directory, 'build-info.json'),
    `${JSON.stringify(buildInfo, null, 2)}\n`,
  );
}

async function prepareWorkshopHtml(htmlPath, grade) {
  const source = await readFile(htmlPath, 'utf8');
  const isTableOfContents = /<nav\b[^>]*\bid="toc"[^>]*>/iu.test(source);
  const section = path.basename(htmlPath) === documentConfig.coverHtmlFilename
    ? 'cover'
    : isTableOfContents ? 'toc' : 'body';
  const note = `<p class="furigana-build-note">このドキュメントには、小学${grade}年生までに学ぶ漢字を学習済みとして想定し、それ以後に学ぶ漢字についてふりがなを付けています。</p>`;
  const withoutGeneratedTitle = isTableOfContents
    ? source.replace(/(<body\b[^>]*>)\s*<h1\b[^>]*>[\s\S]*?<\/h1>/iu, '$1')
    : source;
  const withTocLabels = withoutGeneratedTitle.replace(
    /<nav\b[^>]*\bid="toc"[^>]*>[\s\S]*?<\/nav>/iu,
    (tableOfContents) => tableOfContents.replace(
      /(<a\b[^>]*>)([\s\S]*?)(<\/a>)/giu,
      '$1<span class="toc-label">$2</span>$3',
    ),
  );
  const withLocalImages = withTocLabels.replace(
    /(<img\b[^>]*\bsrc=")\.\.\/\.\.\/images\//giu,
    '$1images/',
  );
  const withGrade = withLocalImages.replace(
    /<html(\s|>)/i,
    `<html data-rubygana-grade="${grade}"$1`,
  );
  const withSection = withGrade.replace(
    /<body(\s|>)/i,
    `<body data-publication-section="${section}"$1`,
  );
  const withNote = section === 'cover'
    ? withSection.replace(/(<h1\b[^>]*>[\s\S]*?<\/h1>)/i, `$1\n${note}`)
    : withSection;
  await writeFile(htmlPath, withNote);
}

function browserArguments() {
  if (process.env.VIVLIOSTYLE_CHROME_PATH) {
    return ['--executable-browser', process.env.VIVLIOSTYLE_CHROME_PATH];
  }

  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'darwin' && existsSync(macChrome)) {
    return ['--executable-browser', macChrome];
  }

  return [];
}

async function buildWebPublication(configPath, outputDirectory) {
  await rm(outputDirectory, {recursive: true, force: true});
  await runNode(vivliostyleBin, [
    'build',
    '--config',
    configPath,
    '--output',
    outputDirectory,
    '--format',
    'webpub',
  ], {cwd: path.dirname(configPath)});
}

async function buildPdf(htmlPath, pdfPath) {
  await mkdir(path.dirname(pdfPath), {recursive: true});
  await runNode(vivliostyleBin, [
    'build',
    path.basename(htmlPath),
    '--size',
    'A4',
    '--output',
    pdfPath,
    ...browserArguments(),
  ], {cwd: path.dirname(htmlPath)});
}

async function normalizeGeneratedImagePaths(htmlPath) {
  const source = await readFile(htmlPath, 'utf8');
  await writeFile(htmlPath, source.replace(
    /(<img\b[^>]*\bsrc=")\.\.\/\.\.\/images\//giu,
    '$1images/',
  ));
}

async function prepareGeneralFuriganaHtml(htmlPath, grade) {
  const source = await readFile(htmlPath, 'utf8');
  await writeFile(htmlPath, source.replace(
    /<html(\s|>)/i,
    `<html data-rubygana-grade="${grade}"$1`,
  ));
}

async function removeDirectoryContentsExcept(directory, preservedEntryNames = []) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  const preservedEntries = new Set(preservedEntryNames);
  await Promise.all(
    entries
      .filter((entry) => !preservedEntries.has(entry))
      .map((entry) => rm(path.join(directory, entry), {recursive: true, force: true})),
  );
}

export async function buildDocs({
  distDirectory = path.join(projectRoot, 'dist'),
  publications = ['general', 'workshop', 'staff'],
} = {}) {
  const selectedPublications = new Set(publications);
  const unknownPublications = [...selectedPublications].filter(
    (publication) => !['general', 'workshop', 'staff'].includes(publication),
  );
  if (unknownPublications.length > 0) {
    throw new Error(`Unknown documentation publication(s): ${unknownPublications.join(', ')}`);
  }

  const grade = resolveLearnedThroughGrade();
  const docsDirectory = path.join(distDirectory, 'docs');
  const generalDirectory = path.join(docsDirectory, generalDocumentConfig.outputDirectory);
  const workshopDirectory = path.join(docsDirectory, documentConfig.outputDirectory);
  const staffDirectory = path.join(docsDirectory, staffDocumentConfig.outputDirectory);
  const generalConfigPath = path.join(projectRoot, 'docs/vivliostyle.general.config.mjs');
  const workshopConfigPath = path.join(projectRoot, 'docs/vivliostyle.workshop.config.mjs');
  const staffConfigPath = path.join(projectRoot, 'docs/vivliostyle.staff.config.mjs');
  const generalTempDirectory = path.join(projectRoot, 'tmp/docs-general-webpub');
  const workshopTempDirectory = path.join(projectRoot, 'tmp/docs-workshop-webpub');
  const staffTempDirectory = path.join(projectRoot, 'tmp/docs-staff-webpub');
  const pdfDirectory = path.join(projectRoot, 'output/pdf');

  await mkdir(docsDirectory, {recursive: true});
  await copyFile(
    path.join(projectRoot, 'site/docs/index.html'),
    path.join(docsDirectory, 'index.html'),
  );

  if (selectedPublications.has('general')) {
    await Promise.all([
      rm(generalDirectory, {recursive: true, force: true}),
      rm(path.join(pdfDirectory, generalDocumentConfig.outputDirectory), {
        recursive: true,
        force: true,
      }),
    ]);
    await buildWebPublication(generalConfigPath, generalTempDirectory);
    await cp(generalTempDirectory, generalDirectory, {recursive: true});

    for (const generalDocument of generalDocumentConfig.documents) {
      const htmlFilename = generalDocument.sourceFilename.replace(/\.md$/u, '.html');
      const pdfFilename = generalDocument.sourceFilename.replace(/\.md$/u, '.pdf');
      const htmlPath = path.join(generalDirectory, htmlFilename);
      const pdfPath = path.join(pdfDirectory, generalDocumentConfig.outputDirectory, pdfFilename);
      if (generalDocument.addFurigana === true) {
        await prepareGeneralFuriganaHtml(htmlPath, grade);
        await applyRubygana(htmlPath, grade);
      }
      await buildPdf(htmlPath, pdfPath);
      await copyFile(pdfPath, path.join(generalDirectory, pdfFilename));
    }

    await writeBuildInfo(
      generalDirectory,
      baseBuildInfo({
        publicationKind: 'general-documentation',
        rubyApplied: true,
        rubyPolicy: 'selected-documents',
        ...rubyganaBuildDetails(grade),
        sourceDirectory: generalDocumentConfig.sourceDirectory,
        documents: generalDocumentConfig.documents.map(({sourceFilename, title, addFurigana}) => ({
          sourceFilename,
          title,
          htmlFilename: sourceFilename.replace(/\.md$/u, '.html'),
          pdfFilename: sourceFilename.replace(/\.md$/u, '.pdf'),
          rubyApplied: addFurigana === true,
          ...(addFurigana === true ? {learnedThroughGrade: grade} : {}),
        })),
      }),
    );
  }

  if (selectedPublications.has('workshop')) {
    const workshopPdfDirectory = path.join(pdfDirectory, documentConfig.outputDirectory);
    await Promise.all([
      removeDirectoryContentsExcept(workshopDirectory, [path.basename(staffDirectory)]),
      removeDirectoryContentsExcept(workshopPdfDirectory, [
        path.basename(path.join(pdfDirectory, staffDocumentConfig.outputDirectory)),
      ]),
    ]);
    await buildWebPublication(workshopConfigPath, workshopTempDirectory);
    await processWorkshopHtmlFiles(workshopTempDirectory, grade);
    await cp(workshopTempDirectory, workshopDirectory, {recursive: true});

    const workshopManifest = path.join(workshopDirectory, 'publication.json');
    if (!existsSync(workshopManifest)) {
      throw new Error('Workshop Web Publication does not contain publication.json.');
    }

    const workshopPdfPath = path.join(workshopPdfDirectory, documentConfig.pdfFilename);
    await buildPdf(workshopManifest, workshopPdfPath);
    await copyFile(workshopPdfPath, path.join(workshopDirectory, documentConfig.pdfFilename));
    await writeBuildInfo(
      workshopDirectory,
      workshopBuildInfo(grade, {
        publicationKind: 'workshop-documentation',
        navigation: {
          viewerBookMode: true,
          pdfBookmarks: 'generatedTableOfContents',
        },
        sourceDirectory: documentConfig.sourceDirectory,
        coverFilename: documentConfig.coverFilename,
        sourceFilename: documentConfig.sourceFilename,
        generatedTableOfContents: {
          title: '目次',
          htmlFilename: documentConfig.tocHtmlFilename,
          sectionDepth: documentConfig.tocSectionDepth,
        },
      }),
    );
  }

  if (selectedPublications.has('staff')) {
    const staffPdfDirectory = path.join(pdfDirectory, staffDocumentConfig.outputDirectory);
    await Promise.all([
      rm(staffDirectory, {recursive: true, force: true}),
      rm(staffPdfDirectory, {recursive: true, force: true}),
    ]);
    await buildWebPublication(staffConfigPath, staffTempDirectory);
    await cp(staffTempDirectory, staffDirectory, {recursive: true});

    const staffHtmlPath = path.join(staffDirectory, staffDocumentConfig.htmlFilename);
    await normalizeGeneratedImagePaths(staffHtmlPath);
    const staffPdfPath = path.join(staffPdfDirectory, staffDocumentConfig.pdfFilename);
    await buildPdf(staffHtmlPath, staffPdfPath);
    await copyFile(staffPdfPath, path.join(staffDirectory, staffDocumentConfig.pdfFilename));
    await writeBuildInfo(
      staffDirectory,
      baseBuildInfo({
        publicationKind: 'workshop-staff-documentation',
        rubyApplied: false,
        sourceDirectory: staffDocumentConfig.sourceDirectory,
        sourceFilename: staffDocumentConfig.sourceFilename,
        htmlFilename: staffDocumentConfig.htmlFilename,
        pdfFilename: staffDocumentConfig.pdfFilename,
      }),
    );
  }

  if (selectedPublications.has('general')) {
    console.log(
      `Built ${generalDocumentConfig.documents.length} general HTML/PDF document pairs in ` +
        `${path.relative(projectRoot, generalDirectory)}/`,
    );
  }
  if (selectedPublications.has('workshop')) {
    console.log(
      `Built grade ${grade} workshop publication in ${path.relative(projectRoot, workshopDirectory)}/`,
    );
  }
  if (selectedPublications.has('staff')) {
    console.log(
      `Built non-ruby staff publication in ${path.relative(projectRoot, staffDirectory)}/`,
    );
  }
  if (selectedPublications.size > 0) {
    console.log(`Built printable PDFs in ${path.relative(projectRoot, pdfDirectory)}/`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildDocs();
}
