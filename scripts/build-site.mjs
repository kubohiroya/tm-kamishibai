import {copyFile, cp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {buildSb3} from '@kubohiroya/sb3-toolchain';

import {
  documentConfig,
  generalDocumentConfig,
  staffDocumentConfig,
} from '../docs/config.mjs';
import {buildDocs} from './build-docs.mjs';
import {outdatedPublicationNames} from './build-freshness.mjs';
import {renderSiteVersion} from './site-version.mjs';
import {verifyBuild} from './verify-build.mjs';

const source = new URL('../site/', import.meta.url);
const output = new URL('../dist/', import.meta.url);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const outputPath = fileURLToPath(output);
const packageJsonPath = path.join(projectRoot, 'package.json');
const siteIndexPath = path.join(outputPath, 'index.html');
const faviconPath = path.join(outputPath, 'favicon.png');
const heroImageSource = new URL('../docs/images/image01.png', import.meta.url);
const heroImageDirectory = new URL('../dist/images/', import.meta.url);
const downloadSb3 = new URL('../dist/downloads/kamishibai.sb3', import.meta.url);

async function findReferencedLocalAssets(markdownPaths) {
  const referencedPaths = new Set();
  const localAssetPattern = /(?:\.\.?\/)+[^()\s<>"']+\.(?:avif|gif|jpe?g|png|svg|webp)/giu;

  for (const markdownPath of markdownPaths) {
    const source = await readFile(markdownPath, 'utf8');
    for (const match of source.matchAll(localAssetPattern)) {
      referencedPaths.add(path.resolve(path.dirname(markdownPath), match[0]));
    }
  }

  return [...referencedPaths];
}

function sharedDocumentationInputs() {
  return [
    path.join(projectRoot, 'package.json'),
    path.join(projectRoot, 'pnpm-lock.yaml'),
    path.join(projectRoot, 'docs/config.mjs'),
    fileURLToPath(new URL('./build-docs.mjs', import.meta.url)),
    fileURLToPath(new URL('./build-freshness.mjs', import.meta.url)),
    fileURLToPath(new URL('./site-appbar.mjs', import.meta.url)),
  ];
}

async function documentationPublications() {
  const docsOutput = path.join(outputPath, 'docs');
  const pdfOutput = path.join(projectRoot, 'output/pdf');
  const generalOutput = path.join(docsOutput, generalDocumentConfig.outputDirectory);
  const workshopOutput = path.join(docsOutput, documentConfig.outputDirectory);
  const staffOutput = path.join(docsOutput, staffDocumentConfig.outputDirectory);
  const generalSources = generalDocumentConfig.documents.map(({sourceFilename}) =>
    path.join(projectRoot, 'docs', generalDocumentConfig.sourceDirectory, sourceFilename),
  );
  const workshopSources = [documentConfig.coverFilename, documentConfig.sourceFilename].map(
    (sourceFilename) =>
      path.join(projectRoot, 'docs', documentConfig.sourceDirectory, sourceFilename),
  );
  const staffSources = [
    path.join(
      projectRoot,
      'docs',
      staffDocumentConfig.sourceDirectory,
      staffDocumentConfig.sourceFilename,
    ),
  ];
  const sharedInputs = sharedDocumentationInputs();

  return [
    {
      name: 'general',
      inputs: [
        ...sharedInputs,
        path.join(projectRoot, 'docs/vivliostyle.general.config.mjs'),
        path.join(projectRoot, 'docs/theme.css'),
        path.join(projectRoot, 'docs/general-theme.css'),
        ...generalSources,
        ...(await findReferencedLocalAssets(generalSources)),
      ],
      outputs: [
        ...generalDocumentConfig.documents.flatMap(({sourceFilename}) => {
          const htmlFilename = sourceFilename.replace(/\.md$/u, '.html');
          const pdfFilename = sourceFilename.replace(/\.md$/u, '.pdf');
          return [
            path.join(generalOutput, htmlFilename),
            path.join(generalOutput, pdfFilename),
            path.join(pdfOutput, generalDocumentConfig.outputDirectory, pdfFilename),
          ];
        }),
        path.join(generalOutput, generalDocumentConfig.tocHtmlFilename),
        path.join(generalOutput, 'publication.json'),
        path.join(generalOutput, 'build-info.json'),
      ],
    },
    {
      name: 'workshop',
      inputs: [
        ...sharedInputs,
        path.join(projectRoot, 'docs/vivliostyle.workshop.config.mjs'),
        path.join(projectRoot, 'docs/theme.css'),
        path.join(projectRoot, 'docs/document-theme.css'),
        ...workshopSources,
        ...(await findReferencedLocalAssets(workshopSources)),
      ],
      outputs: [
        path.join(workshopOutput, documentConfig.coverHtmlFilename),
        path.join(workshopOutput, documentConfig.tocHtmlFilename),
        path.join(workshopOutput, documentConfig.sourceFilename.replace(/\.md$/u, '.html')),
        path.join(workshopOutput, documentConfig.pdfFilename),
        path.join(pdfOutput, documentConfig.outputDirectory, documentConfig.pdfFilename),
        path.join(workshopOutput, 'publication.json'),
        path.join(workshopOutput, 'build-info.json'),
      ],
    },
    {
      name: 'staff',
      inputs: [
        ...sharedInputs,
        path.join(projectRoot, 'docs/vivliostyle.staff.config.mjs'),
        path.join(projectRoot, 'docs/theme.css'),
        path.join(projectRoot, 'docs/staff-theme.css'),
        ...staffSources,
        ...(await findReferencedLocalAssets(staffSources)),
      ],
      outputs: [
        path.join(staffOutput, staffDocumentConfig.htmlFilename),
        path.join(staffOutput, staffDocumentConfig.pdfFilename),
        path.join(pdfOutput, staffDocumentConfig.outputDirectory, staffDocumentConfig.pdfFilename),
        path.join(staffOutput, 'publication.json'),
        path.join(staffOutput, 'build-info.json'),
      ],
    },
  ];
}

async function prepareOutputDirectory() {
  await mkdir(output, {recursive: true});
  const entries = await readdir(outputPath, {withFileTypes: true});

  await Promise.all(entries
    .filter((entry) => entry.name !== 'docs')
    .map((entry) => rm(path.join(outputPath, entry.name), {recursive: true, force: true})));
  await cp(source, output, {recursive: true});
}

async function renderSiteMetadata() {
  const [sourceHtml, packageJsonSource] = await Promise.all([
    readFile(siteIndexPath, 'utf8'),
    readFile(packageJsonPath, 'utf8'),
  ]);
  const packageJson = JSON.parse(packageJsonSource);
  await writeFile(siteIndexPath, renderSiteVersion(sourceHtml, packageJson.version));
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

async function addFaviconLinks() {
  const htmlFiles = await findHtmlFiles(outputPath);
  let addedCount = 0;

  for (const htmlFile of htmlFiles) {
    const sourceHtml = await readFile(htmlFile, 'utf8');
    const relativePath = path.relative(path.dirname(htmlFile), faviconPath).split(path.sep).join('/');
    const faviconLink = `<link rel="icon" type="image/png" sizes="256x256" href="${relativePath}">`;
    if (sourceHtml.includes(faviconLink)) {
      continue;
    }
    const updatedHtml = sourceHtml.replace(/<head(?:\s[^>]*)?>/iu, `$&\n  ${faviconLink}`);

    if (updatedHtml === sourceHtml) {
      throw new Error(`Cannot add a favicon link because ${htmlFile} does not contain <head>.`);
    }
    await writeFile(htmlFile, updatedHtml);
    addedCount += 1;
  }

  console.log(`Added favicon links to ${addedCount} of ${htmlFiles.length} HTML file(s).`);
}

await prepareOutputDirectory();
await renderSiteMetadata();
const sb3Build = await buildSb3({
  outputPath: fileURLToPath(downloadSb3),
  sourceDirectory: path.join(projectRoot, 'app'),
});
console.log(`Built downloadable SB3: ${sb3Build.outputPath}`);
await mkdir(heroImageDirectory, {recursive: true});
await copyFile(heroImageSource, new URL('image01.png', heroImageDirectory));
const publicationsToBuild = await outdatedPublicationNames(await documentationPublications(), {
  force: process.env.FORCE_REBUILD === '1',
});
if (publicationsToBuild.length === 0) {
  console.log('Skipped documentation HTML/PDF generation (outputs are up to date).');
} else {
  console.log(`Rebuilding documentation publications: ${publicationsToBuild.join(', ')}.`);
  await buildDocs({publications: publicationsToBuild});
}
await addFaviconLinks();
await verifyBuild();
console.log('Built GitHub Pages content in dist/');
