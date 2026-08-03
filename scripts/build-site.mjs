import {cp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {renderSiteVersion} from './site-version.mjs';
import {buildKamishibaiSb3} from './sb3/build.mjs';
import {verifyBuild} from './verify-build.mjs';

const source = new URL('../site/', import.meta.url);
const output = new URL('../dist/', import.meta.url);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const outputPath = fileURLToPath(output);
const packageJsonPath = path.join(projectRoot, 'package.json');
const siteIndexPath = path.join(outputPath, 'index.html');
const faviconPath = path.join(outputPath, 'favicon.png');
const downloadSb3 = new URL('../dist/downloads/kamishibai.sb3', import.meta.url);

async function prepareOutputDirectory() {
  await rm(output, {recursive: true, force: true});
  await mkdir(output, {recursive: true});
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
await renderSiteMetadata();
const sb3Build = await buildKamishibaiSb3({
  outputPath: fileURLToPath(downloadSb3),
});
console.log(`Built downloadable SB3: ${sb3Build.outputPath}`);
await addFaviconLinks();
await verifyBuild({titleBuildMetadata: sb3Build.titleBuildMetadata});
console.log('Built GitHub Pages content in dist/');
