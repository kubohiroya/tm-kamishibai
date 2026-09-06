import {cp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {recommendedDownload, renderDownloadCards} from './download-catalog.mjs';
import {replaceSiteNavigation} from './site-navigation.mjs';
import {renderSiteVersion} from './site-version.mjs';
import {buildDownloadableReleaseSb3, downloadableReleases} from './sb3/downloadable-releases.mjs';
import {verifyBuild} from './verify-build.mjs';

const source = new URL('../site/', import.meta.url);
const output = new URL('../site-dist/', import.meta.url);
const outputPath = fileURLToPath(output);
const siteIndexPath = path.join(outputPath, 'index.html');
const downloadIndexPath = path.join(outputPath, 'downloads', 'index.html');
const faviconPath = path.join(outputPath, 'favicon.png');

async function prepareOutputDirectory() {
  await rm(output, {recursive: true, force: true});
  await mkdir(output, {recursive: true});
  await cp(source, output, {recursive: true});
}

async function renderSiteMetadata() {
  const [sourceHtml, downloadHtml] = await Promise.all([
    readFile(siteIndexPath, 'utf8'),
    readFile(downloadIndexPath, 'utf8'),
  ]);
  await Promise.all([
    writeFile(siteIndexPath, renderSiteVersion(sourceHtml, recommendedDownload.version)),
    writeFile(downloadIndexPath, renderDownloadCards(downloadHtml)),
  ]);
}

async function renderSiteNavigation() {
  const htmlFiles = await findHtmlFiles(outputPath);
  let updatedCount = 0;
  for (const htmlFile of htmlFiles) {
    const sourceHtml = await readFile(htmlFile, 'utf8');
    const relativePath = path.relative(outputPath, htmlFile).split(path.sep).join('/');
    const pathname =
      relativePath === 'index.html'
        ? '/tm-kamishibai/'
        : `/tm-kamishibai/${relativePath.replace(/(?:index\.html)?$/u, '')}`;
    const updatedHtml = replaceSiteNavigation(sourceHtml, {
      site: 'tm-kamishibai',
      pathname,
    });
    if (updatedHtml !== sourceHtml) {
      await writeFile(htmlFile, updatedHtml);
      updatedCount += 1;
    }
  }
  console.log(
    `Rendered the contract AppBar in ${updatedCount} of ${htmlFiles.length} HTML file(s).`,
  );
}

/** @returns {Promise<string[]>} */
async function findHtmlFiles(/** @type {any} */ directory) {
  const entries = await readdir(directory, {withFileTypes: true});
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return findHtmlFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith('.html') ? [entryPath] : [];
    }),
  );
  return nestedFiles.flat();
}

async function addFaviconLinks() {
  const htmlFiles = await findHtmlFiles(outputPath);
  let addedCount = 0;

  for (const htmlFile of htmlFiles) {
    const sourceHtml = await readFile(htmlFile, 'utf8');
    const relativePath = path
      .relative(path.dirname(htmlFile), faviconPath)
      .split(path.sep)
      .join('/');
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
await renderSiteNavigation();
await renderSiteMetadata();
const releaseBuilds = await Promise.all(
  downloadableReleases.map(async (/** @type {any} */ release) => {
    const build = await buildDownloadableReleaseSb3(release, {
      outputPath: path.join(outputPath, 'downloads', release.filename),
    });
    console.log(`Downloaded verified ${release.series} SB3: ${build.outputPath}`);
    return {release, titleBuildMetadata: build.titleBuildMetadata};
  }),
);
await addFaviconLinks();
await verifyBuild({releaseBuilds});
console.log('Built GitHub Pages content in site-dist/');
