import {copyFile, cp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  documentConfig,
  generalDocumentConfig,
  staffDocumentConfig,
} from '../docs/config.mjs';
import {buildDocs} from './build-docs.mjs';
import {outputsAreUpToDate} from './build-freshness.mjs';
import {buildSb3} from './sb3/build.mjs';
import {verifyBuild} from './verify-build.mjs';

const source = new URL('../site/', import.meta.url);
const output = new URL('../dist/', import.meta.url);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const outputPath = fileURLToPath(output);
const faviconPath = path.join(outputPath, 'favicon.png');
const heroImageSource = new URL('../docs/images/image01.png', import.meta.url);
const heroImageDirectory = new URL('../dist/images/', import.meta.url);
const downloadSb3 = new URL('../dist/downloads/kamishibai.sb3', import.meta.url);

async function findDocumentationInputs(directory) {
  const entries = await readdir(directory, {withFileTypes: true});
  const nestedFiles = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return findDocumentationInputs(entryPath);
    }
    return entry.isFile() && /\.(?:avif|css|gif|jpe?g|md|mjs|png|svg|webp)$/iu.test(entry.name)
      ? [entryPath]
      : [];
  }));
  return nestedFiles.flat();
}

function documentationOutputs() {
  const docsOutput = path.join(outputPath, 'docs');
  const pdfOutput = path.join(projectRoot, 'output/pdf');
  const generalOutput = path.join(docsOutput, generalDocumentConfig.outputDirectory);
  const workshopOutput = path.join(docsOutput, documentConfig.outputDirectory);
  const staffOutput = path.join(docsOutput, staffDocumentConfig.outputDirectory);

  return [
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
    path.join(workshopOutput, documentConfig.coverHtmlFilename),
    path.join(workshopOutput, documentConfig.tocHtmlFilename),
    path.join(workshopOutput, documentConfig.sourceFilename.replace(/\.md$/u, '.html')),
    path.join(workshopOutput, documentConfig.pdfFilename),
    path.join(pdfOutput, documentConfig.outputDirectory, documentConfig.pdfFilename),
    path.join(workshopOutput, 'publication.json'),
    path.join(workshopOutput, 'build-info.json'),
    path.join(staffOutput, staffDocumentConfig.htmlFilename),
    path.join(staffOutput, staffDocumentConfig.pdfFilename),
    path.join(pdfOutput, staffDocumentConfig.outputDirectory, staffDocumentConfig.pdfFilename),
    path.join(staffOutput, 'publication.json'),
    path.join(staffOutput, 'build-info.json'),
  ];
}

async function documentationIsUpToDate() {
  const inputs = await findDocumentationInputs(path.join(projectRoot, 'docs'));
  inputs.push(
    path.join(projectRoot, 'package.json'),
    path.join(projectRoot, 'pnpm-lock.yaml'),
    fileURLToPath(new URL('./build-docs.mjs', import.meta.url)),
  );
  return outputsAreUpToDate(inputs, documentationOutputs(), {
    force: process.env.FORCE_REBUILD === '1',
  });
}

async function prepareOutputDirectory() {
  await mkdir(output, {recursive: true});
  const entries = await readdir(outputPath, {withFileTypes: true});

  await Promise.all(entries
    .filter((entry) => entry.name !== 'docs')
    .map((entry) => rm(path.join(outputPath, entry.name), {recursive: true, force: true})));
  await cp(source, output, {recursive: true});
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
const sb3Build = await buildSb3({outputPath: fileURLToPath(downloadSb3)});
console.log(`Built downloadable SB3: ${sb3Build.outputPath}`);
await mkdir(heroImageDirectory, {recursive: true});
await copyFile(heroImageSource, new URL('image01.png', heroImageDirectory));
if (await documentationIsUpToDate()) {
  console.log('Skipped documentation HTML/PDF generation (outputs are up to date).');
} else {
  await buildDocs();
}
await addFaviconLinks();
await verifyBuild();
console.log('Built GitHub Pages content in dist/');
