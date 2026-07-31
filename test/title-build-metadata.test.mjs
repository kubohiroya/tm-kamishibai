import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {access, readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {strFromU8, unzipSync} from 'fflate';

import {createKamishibaiSb3} from '../scripts/sb3/build.mjs';
import {
  appShellCommon,
  appShellLocales,
  appShellProjectPlaceholders,
} from '../scripts/sb3/app-shell-locales.mjs';
import {
  officialWebsiteFaviconPlaceholder,
  readTitleBuildMetadataFromSb3,
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

function escapeXmlText(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

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
  const officialWebsiteButton = project.targets.find(
    (target) => target.name === 'officialWebsiteButton',
  );
  const expectedLabel = `Version ${packageJson.version} (2026/07/31)`;

  assert.equal(built.titleBuildMetadata.label, expectedLabel);
  assert.deepEqual(readTitleBuildMetadataFromSb3(built.archive), {
    buildDate: '2026-07-31',
    label: expectedLabel,
    version: packageJson.version,
  });
  const costumeNames = {
    en: {
      officialWebsite: 'official-website-button-en',
      title: 'Title-en',
    },
    ja: {
      officialWebsite: 'official-website-button',
      title: 'Title',
    },
  };
  for (const [locale, localized] of Object.entries(appShellLocales)) {
    const titleCostume = stage.costumes.find(
      (costume) => costume.name === costumeNames[locale].title,
    );
    const titleSvg = strFromU8(archive[titleCostume.md5ext]);
    assert(titleSvg.includes(expectedLabel));
    assert(titleSvg.includes(escapeXmlText(localized.about.title)));
    assert(titleSvg.includes(escapeXmlText(localized.about.license.app)));
    assert(titleSvg.includes(escapeXmlText(localized.about.license.story)));
    assert(titleSvg.includes(escapeXmlText(localized.about.author.organization)));
    assert(titleSvg.includes(escapeXmlText(localized.about.author.name)));
    assert(titleSvg.includes(appShellCommon.about.author.email));
    assert(!titleSvg.includes(titleVersionPlaceholder));
    assert(!titleSvg.includes('{{'));
    assert.match(titleSvg, /text-anchor="middle"/u);
    assert.equal(createHash('md5').update(titleSvg).digest('hex'), titleCostume.assetId);
    assert.equal(titleCostume.md5ext, `${titleCostume.assetId}.svg`);
    assert.equal(built.titleBuildMetadata.titleAssets[locale].filename, titleCostume.md5ext);
    if (locale === 'ja') {
      assert.equal(
        [
          ...titleSvg.matchAll(
            /<text transform="translate\((?:220\.36368,132\.13592|240,174)\)[^>]+text-anchor="middle">/gu,
          ),
        ].length,
        2,
      );
      assert.match(
        titleSvg,
        /<text transform="translate\(240,320\.97056\) scale\(0\.5,0\.5\)" font-size="36"[^>]+text-anchor="middle">/u,
      );
      assert(titleSvg.includes('久保 裕也 &lt;hiroya@cuc.ac.jp&gt;'));
      assert(!titleSvg.includes('　　　久保 裕也'));
      assert.match(
        titleSvg,
        /<text transform="translate\(240,238\) scale\(0\.5,0\.5\)" font-size="16"[^>]+text-anchor="middle">/u,
      );
    }

    const officialWebsiteCostume = officialWebsiteButton.costumes.find(
      (costume) => costume.name === costumeNames[locale].officialWebsite,
    );
    const officialWebsiteSvg = strFromU8(archive[officialWebsiteCostume.md5ext]);
    assert(!officialWebsiteSvg.includes(officialWebsiteFaviconPlaceholder));
    assert(!officialWebsiteSvg.includes('{{'));
    assert(officialWebsiteSvg.includes(escapeXmlText(localized.about.officialWebsite.name)));
    assert(officialWebsiteSvg.includes('width="116" height="24" viewBox="0 0 116 24"'));
    assert(officialWebsiteSvg.includes('x="0.75" y="0.75" width="114.5"'));
    assert(officialWebsiteSvg.includes('x="17" y="5" width="14" height="14"'));
    assert(officialWebsiteSvg.includes('fill="#fff" stroke="#007f71"'));
    assert(officialWebsiteSvg.includes('fill="#007f71"'));
    const embeddedFavicon = officialWebsiteSvg.match(/data:image\/png;base64,([^"]+)/u)?.[1];
    assert(embeddedFavicon, `${locale} official website button does not contain the favicon.`);
    assert(Buffer.from(embeddedFavicon, 'base64').equals(favicon));
    assert.equal(
      createHash('md5').update(officialWebsiteSvg).digest('hex'),
      officialWebsiteCostume.assetId,
    );
    assert.equal(officialWebsiteCostume.md5ext, `${officialWebsiteCostume.assetId}.svg`);
    assert.equal(
      built.titleBuildMetadata.officialWebsiteAssets[locale].filename,
      officialWebsiteCostume.md5ext,
    );
  }
  const builtProjectSource = JSON.stringify(project);
  for (const placeholder of Object.keys(appShellProjectPlaceholders)) {
    assert(!builtProjectSource.includes(placeholder));
  }
  assert(builtProjectSource.includes(appShellCommon.about.officialWebsite.url));
  for (const sourceFilename of [
    'adf8160b04c3c672483e67e39dd73fb3.svg',
    '40f446b284b37121ac7f31a5f645e62a.svg',
    '48fdbeb367aa87ae58976e9f85ac28f0.svg',
    '0ffa1c2dee55ace499d6a6bdb95ffbdd.svg',
  ]) {
    assert.equal(archive[sourceFilename], undefined);
  }
  assert.equal(archive['c7334c6a74860d5808c4962f250b52f2.svg'], undefined);
  assert.equal(archive['219229644e41b20c4811dce46b3dfdd1.svg'], undefined);
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
