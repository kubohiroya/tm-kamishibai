import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {strFromU8, unzipSync} from 'fflate';
import {
  appShellCommon,
  appShellLocales,
  appShellProjectPlaceholders,
} from './app-shell-locales.mjs';

export const titleVersionPlaceholder = 'Version {{VERSION}} ({{BUILD_DATE}})';
export const officialWebsiteFaviconPlaceholder = '{{OFFICIAL_WEBSITE_FAVICON}}';
export const titleBuildDateEnvironmentVariable = 'KAMISHIBAI_BUILD_DATE';

const titleCostumeNames = Object.freeze({en: 'Title-en', ja: 'Title'});
const officialWebsiteCostumeNames = Object.freeze({
  en: 'official-website-button-en',
  ja: 'official-website-button',
});

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function replaceProjectPlaceholders(value) {
  if (typeof value === 'string') {
    return appShellProjectPlaceholders[value] ?? value;
  }
  if (Array.isArray(value)) {
    return value.map(replaceProjectPlaceholders);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        replaceProjectPlaceholders(nestedValue),
      ]),
    );
  }
  return value;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function assertValidBuildDate(buildDate) {
  assert(
    typeof buildDate === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(buildDate),
    `${titleBuildDateEnvironmentVariable} must use YYYY-MM-DD: ${buildDate}`,
  );
  const [year, month, day] = buildDate.split('-').map(Number);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  assert(
    month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1],
    `${titleBuildDateEnvironmentVariable} is not a valid calendar date: ${buildDate}`,
  );
  return buildDate;
}

function formatTokyoDate(now) {
  assert(now instanceof Date && !Number.isNaN(now.valueOf()), 'A valid build time is required.');
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(({type, value: partValue}) => [type, partValue]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function resolveTitleBuildMetadata({
  buildDate,
  environment = process.env,
  now = new Date(),
  version,
} = {}) {
  assert(
    typeof version === 'string' && /^[0-9A-Za-z.+-]+$/u.test(version),
    `Invalid package version for the Title backdrop: ${version}`,
  );
  const resolvedBuildDate = assertValidBuildDate(
    buildDate ?? environment[titleBuildDateEnvironmentVariable] ?? formatTokyoDate(now),
  );
  const displayDate = resolvedBuildDate.replaceAll('-', '/');
  return Object.freeze({
    buildDate: resolvedBuildDate,
    label: `Version ${version} (${displayDate})`,
    version,
  });
}

export function readTitleBuildMetadataFromSb3(archiveBytes) {
  const archive = unzipSync(new Uint8Array(archiveBytes));
  assert(archive['project.json'], 'The SB3 archive must contain project.json.');
  const project = JSON.parse(strFromU8(archive['project.json']));
  const stages = project.targets.filter((target) => target.isStage);
  assert.equal(stages.length, 1, 'The SB3 archive must contain exactly one Stage target.');
  const titleCostumes = stages[0].costumes.filter((costume) => costume.name === 'Title');
  assert.equal(titleCostumes.length, 1, 'The Stage must contain exactly one Title backdrop.');
  const titleCostume = titleCostumes[0];
  assert.equal(titleCostume.dataFormat, 'svg', 'The Title backdrop must be an SVG asset.');
  const titleAsset = archive[titleCostume.md5ext];
  assert(titleAsset, `The SB3 archive is missing the Title asset: ${titleCostume.md5ext}`);
  const titleSvg = strFromU8(titleAsset);
  const metadataMatches = [
    ...titleSvg.matchAll(/Version ([0-9A-Za-z.+-]+) \((\d{4}\/\d{2}\/\d{2})\)/gu),
  ];
  assert.equal(
    metadataMatches.length,
    1,
    'The Title backdrop must contain exactly one stamped version and build date.',
  );
  const [, version, displayDate] = metadataMatches[0];
  const metadata = resolveTitleBuildMetadata({
    buildDate: displayDate.replaceAll('/', '-'),
    environment: {},
    version,
  });
  assert.equal(
    metadata.label,
    metadataMatches[0][0],
    'The Title backdrop contains invalid build metadata.',
  );
  return metadata;
}

async function readPackageVersion(packageJsonPath) {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  return packageJson.version;
}

async function stampSvgAsset({
  assetsDirectory,
  costume,
  description,
  placeholder,
  project,
  replacement,
  sourceManifest,
}) {
  assert.equal(costume.dataFormat, 'svg', `${description} must be an SVG asset.`);
  const originalFilename = costume.md5ext;
  const references = project.targets
    .flatMap((target) => [...(target.costumes ?? []), ...(target.sounds ?? [])])
    .filter((asset) => asset.md5ext === originalFilename);
  assert.equal(
    references.length,
    1,
    `${description} must have exactly one Scratch asset reference: ${originalFilename}`,
  );

  const originalAssetPath = path.join(assetsDirectory, originalFilename);
  const originalSvg = await readFile(originalAssetPath, 'utf8');
  assert.equal(
    originalSvg.split(placeholder).length,
    2,
    `${description} must contain exactly one placeholder: ${placeholder}`,
  );
  const stampedSvg = originalSvg.replace(placeholder, replacement);
  const assetId = createHash('md5').update(stampedSvg).digest('hex');
  const filename = `${assetId}.svg`;

  costume.assetId = assetId;
  costume.md5ext = filename;
  const archiveEntryIndexes = sourceManifest.archiveEntries
    .map((entryName, index) => (entryName === originalFilename ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(
    archiveEntryIndexes.length,
    1,
    `The source manifest must contain ${description} exactly once: ${originalFilename}`,
  );
  sourceManifest.archiveEntries[archiveEntryIndexes[0]] = filename;

  await writeFile(path.join(assetsDirectory, filename), stampedSvg);
  if (filename !== originalFilename) {
    await rm(originalAssetPath);
  }

  return Object.freeze({assetId, filename});
}

async function stampTitleSource(sourceDirectory, faviconPath, metadata) {
  const projectPath = path.join(sourceDirectory, 'project.source.json');
  const sourceManifestPath = path.join(sourceDirectory, 'sb3-source.json');
  const assetsDirectory = path.join(sourceDirectory, 'assets');
  const [projectSource, sourceManifestSource] = await Promise.all([
    readFile(projectPath, 'utf8'),
    readFile(sourceManifestPath, 'utf8'),
  ]);
  const project = replaceProjectPlaceholders(JSON.parse(projectSource));
  const sourceManifest = JSON.parse(sourceManifestSource);
  const stages = project.targets.filter((target) => target.isStage);
  assert.equal(stages.length, 1, 'The app source must contain exactly one Stage target.');
  const titleCostumes = Object.fromEntries(
    Object.entries(titleCostumeNames).map(([locale, costumeName]) => {
      const matches = stages[0].costumes.filter((costume) => costume.name === costumeName);
      assert.equal(
        matches.length,
        1,
        `The Stage must contain exactly one ${costumeName} backdrop.`,
      );
      return [locale, matches[0]];
    }),
  );
  const officialWebsiteTargets = project.targets.filter(
    (target) => target.name === 'officialWebsiteButton',
  );
  assert.equal(
    officialWebsiteTargets.length,
    1,
    'The app source must contain exactly one officialWebsiteButton target.',
  );
  const officialWebsiteCostumes = Object.fromEntries(
    Object.entries(officialWebsiteCostumeNames).map(([locale, costumeName]) => {
      const matches = officialWebsiteTargets[0].costumes.filter(
        (costume) => costume.name === costumeName,
      );
      assert.equal(
        matches.length,
        1,
        `officialWebsiteButton must contain exactly one ${costumeName} costume.`,
      );
      return [locale, matches[0]];
    }),
  );
  const favicon = await readFile(faviconPath);
  const titleAssets = {};
  const officialWebsiteAssets = {};

  for (const locale of Object.keys(appShellLocales)) {
    const localized = appShellLocales[locale];
    const titleReplacements = [
      [titleVersionPlaceholder, metadata.label],
      ['{{ABOUT_TITLE}}', escapeXml(localized.about.title)],
      ['{{ABOUT_LICENSE_APP}}', escapeXml(localized.about.license.app)],
      ['{{ABOUT_LICENSE_STORY}}', escapeXml(localized.about.license.story)],
      ['{{ABOUT_AUTHOR_ORGANIZATION}}', escapeXml(localized.about.author.organization)],
      ['{{ABOUT_AUTHOR_NAME}}', escapeXml(localized.about.author.name)],
      ['{{ABOUT_AUTHOR_EMAIL}}', escapeXml(appShellCommon.about.author.email)],
    ];
    let titleAsset;
    for (const [placeholder, replacement] of titleReplacements) {
      titleAsset = await stampSvgAsset({
        assetsDirectory,
        costume: titleCostumes[locale],
        description: `The ${titleCostumeNames[locale]} backdrop SVG`,
        placeholder,
        project,
        replacement,
        sourceManifest,
      });
    }
    titleAssets[locale] = Object.freeze({...titleAsset, label: metadata.label});

    let officialWebsiteAsset = await stampSvgAsset({
      assetsDirectory,
      costume: officialWebsiteCostumes[locale],
      description: `The ${officialWebsiteCostumeNames[locale]} SVG`,
      placeholder: officialWebsiteFaviconPlaceholder,
      project,
      replacement: favicon.toString('base64'),
      sourceManifest,
    });
    officialWebsiteAsset = await stampSvgAsset({
      assetsDirectory,
      costume: officialWebsiteCostumes[locale],
      description: `The ${officialWebsiteCostumeNames[locale]} SVG`,
      placeholder: '{{ABOUT_OFFICIAL_WEBSITE_NAME}}',
      project,
      replacement: escapeXml(localized.about.officialWebsite.name),
      sourceManifest,
    });
    officialWebsiteAssets[locale] = officialWebsiteAsset;
  }

  const resolvedProjectSource = `${JSON.stringify(project, null, 2)}\n`;
  for (const placeholder of Object.keys(appShellProjectPlaceholders)) {
    assert(
      !resolvedProjectSource.includes(placeholder),
      `The app project contains an unresolved app-shell placeholder: ${placeholder}`,
    );
  }

  await Promise.all([
    writeFile(projectPath, resolvedProjectSource),
    writeFile(sourceManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`),
  ]);

  return Object.freeze({
    officialWebsiteAsset: officialWebsiteAssets.ja,
    officialWebsiteAssets: Object.freeze(officialWebsiteAssets),
    titleAsset: titleAssets.ja,
    titleAssets: Object.freeze(titleAssets),
  });
}

export async function withTitleBuildMetadataSource(
  {
    buildDate,
    environment = process.env,
    faviconPath,
    now = new Date(),
    packageJsonPath,
    sourceDirectory,
    version,
  },
  callback,
) {
  assert(typeof sourceDirectory === 'string', 'The app source directory is required.');
  assert(typeof packageJsonPath === 'string', 'The package.json path is required.');
  assert(typeof faviconPath === 'string', 'The site favicon path is required.');
  assert(typeof callback === 'function', 'A versioned source callback is required.');
  const resolvedVersion = version ?? (await readPackageVersion(packageJsonPath));
  const metadata = resolveTitleBuildMetadata({
    buildDate,
    environment,
    now,
    version: resolvedVersion,
  });
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'tmpose-title-build-'));
  const temporarySource = path.join(temporaryRoot, 'app');

  try {
    await cp(sourceDirectory, temporarySource, {recursive: true});
    const stampedAssets = await stampTitleSource(temporarySource, faviconPath, metadata);
    return await callback({
      metadata: Object.freeze({...metadata, ...stampedAssets}),
      sourceDirectory: temporarySource,
    });
  } finally {
    await rm(temporaryRoot, {force: true, recursive: true});
  }
}
