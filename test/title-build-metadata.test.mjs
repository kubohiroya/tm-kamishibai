import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {access, readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {strFromU8, unzipSync} from 'fflate';

import {createKamishibaiSb3} from '../scripts/sb3/build.mjs';
import {
  officialWebsiteFaviconPlaceholder,
  resolveTitleBuildMetadata,
  titleBuildDateEnvironmentVariable,
  titleVersionPlaceholder,
} from '../scripts/sb3/title-build-metadata.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const appDirectory = path.join(projectRoot, 'app');
const packageJsonPath = path.join(projectRoot, 'package.json');
const faviconPath = path.join(projectRoot, 'site', 'favicon.png');
const projectSourcePath = path.join(appDirectory, 'project.source.json');
const sourceManifestPath = path.join(appDirectory, 'sb3-source.json');
const assetsDirectory = path.join(appDirectory, 'assets');

test('resolves the Title build date in Asia/Tokyo and accepts a reproducible override', () => {
  assert.deepEqual(
    resolveTitleBuildMetadata({
      environment: {},
      now: new Date('2026-07-30T15:01:00.000Z'),
      version: '7.8.9',
    }),
    {
      buildDate: '2026-07-31',
      label: 'Version 7.8.9 (2026/07/31)',
      version: '7.8.9',
    },
  );
  assert.equal(
    resolveTitleBuildMetadata({
      environment: {[titleBuildDateEnvironmentVariable]: '2026-07-19'},
      now: new Date('2026-07-31T00:00:00.000Z'),
      version: '7.8.9',
    }).label,
    'Version 7.8.9 (2026/07/19)',
  );
  assert.throws(
    () =>
      resolveTitleBuildMetadata({
        environment: {[titleBuildDateEnvironmentVariable]: '2026-02-29'},
        version: '7.8.9',
      }),
    /not a valid calendar date/u,
  );
});

test('embeds Title metadata and the site favicon without changing app source', async () => {
  const [packageJson, favicon, projectSourceBefore, sourceManifestBefore, assetFilenamesBefore] =
    await Promise.all([
      readFile(packageJsonPath, 'utf8').then(JSON.parse),
      readFile(faviconPath),
      readFile(projectSourcePath),
      readFile(sourceManifestPath),
      readdir(assetsDirectory),
    ]);
  const built = await createKamishibaiSb3({
    environment: {[titleBuildDateEnvironmentVariable]: '2026-07-31'},
  });
  const archive = unzipSync(built.archive);
  const project = JSON.parse(strFromU8(archive['project.json']));
  const stage = project.targets.find((target) => target.isStage);
  const titleCostume = stage.costumes.find((costume) => costume.name === 'Title');
  const titleSvg = strFromU8(archive[titleCostume.md5ext]);
  const officialWebsiteButton = project.targets.find(
    (target) => target.name === 'officialWebsiteButton',
  );
  const officialWebsiteCostume = officialWebsiteButton.costumes.find(
    (costume) => costume.name === 'official-website-button',
  );
  const officialWebsiteSvg = strFromU8(archive[officialWebsiteCostume.md5ext]);
  const expectedLabel = `Version ${packageJson.version} (2026/07/31)`;

  assert.equal(built.titleBuildMetadata.label, expectedLabel);
  assert(titleSvg.includes(expectedLabel));
  assert(!titleSvg.includes(titleVersionPlaceholder));
  assert.equal(
    [
      ...titleSvg.matchAll(
        /<text transform="translate\((?:220\.36368,144\.13592|190\.11368,186)\)[^>]+text-anchor="middle">/gu,
      ),
    ].length,
    2,
  );
  assert.equal(createHash('md5').update(titleSvg).digest('hex'), titleCostume.assetId);
  assert.equal(titleCostume.md5ext, `${titleCostume.assetId}.svg`);
  assert(archive[titleCostume.md5ext]);
  assert.equal(archive['1ae83bbde362a1bc85eea4d67263e794.svg'], undefined);
  assert.equal(
    built.titleBuildMetadata.officialWebsiteAsset.filename,
    officialWebsiteCostume.md5ext,
  );
  assert(!officialWebsiteSvg.includes(officialWebsiteFaviconPlaceholder));
  assert(officialWebsiteSvg.includes('fill="#fff" stroke="#007f71"'));
  assert(officialWebsiteSvg.includes('fill="#007f71"'));
  const embeddedFavicon = officialWebsiteSvg.match(/data:image\/png;base64,([^"]+)/u)?.[1];
  assert(embeddedFavicon, 'The official website button does not contain an embedded PNG favicon.');
  assert(Buffer.from(embeddedFavicon, 'base64').equals(favicon));
  assert.equal(
    createHash('md5').update(officialWebsiteSvg).digest('hex'),
    officialWebsiteCostume.assetId,
  );
  assert.equal(officialWebsiteCostume.md5ext, `${officialWebsiteCostume.assetId}.svg`);
  assert.equal(archive['2edba0af7984277b1611a8f687484361.svg'], undefined);
  await assert.rejects(access(built.source.resolvedSourceDirectory));

  const [projectSourceAfter, sourceManifestAfter, assetFilenamesAfter] = await Promise.all([
    readFile(projectSourcePath),
    readFile(sourceManifestPath),
    readdir(assetsDirectory),
  ]);
  assert(projectSourceAfter.equals(projectSourceBefore));
  assert(sourceManifestAfter.equals(sourceManifestBefore));
  assert.deepEqual(assetFilenamesAfter.sort(), assetFilenamesBefore.sort());
});
