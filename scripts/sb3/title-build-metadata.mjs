import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const titleVersionPlaceholder = 'Version {{VERSION}} ({{BUILD_DATE}})';
export const titleBuildDateEnvironmentVariable = 'KAMISHIBAI_BUILD_DATE';

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

async function readPackageVersion(packageJsonPath) {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  return packageJson.version;
}

async function stampTitleSource(sourceDirectory, metadata) {
  const projectPath = path.join(sourceDirectory, 'project.source.json');
  const sourceManifestPath = path.join(sourceDirectory, 'sb3-source.json');
  const assetsDirectory = path.join(sourceDirectory, 'assets');
  const [projectSource, sourceManifestSource] = await Promise.all([
    readFile(projectPath, 'utf8'),
    readFile(sourceManifestPath, 'utf8'),
  ]);
  const project = JSON.parse(projectSource);
  const sourceManifest = JSON.parse(sourceManifestSource);
  const stages = project.targets.filter((target) => target.isStage);
  assert.equal(stages.length, 1, 'The app source must contain exactly one Stage target.');
  const titleCostumes = stages[0].costumes.filter((costume) => costume.name === 'Title');
  assert.equal(titleCostumes.length, 1, 'The Stage must contain exactly one Title backdrop.');
  const [titleCostume] = titleCostumes;
  assert.equal(titleCostume.dataFormat, 'svg', 'The Title backdrop must be an SVG asset.');

  const originalFilename = titleCostume.md5ext;
  const references = project.targets
    .flatMap((target) => [...(target.costumes ?? []), ...(target.sounds ?? [])])
    .filter((asset) => asset.md5ext === originalFilename);
  assert.equal(
    references.length,
    1,
    `The Title SVG must have exactly one Scratch asset reference: ${originalFilename}`,
  );

  const originalAssetPath = path.join(assetsDirectory, originalFilename);
  const originalSvg = await readFile(originalAssetPath, 'utf8');
  assert.equal(
    originalSvg.split(titleVersionPlaceholder).length,
    2,
    'The Title SVG must contain exactly one build metadata placeholder.',
  );
  const stampedSvg = originalSvg.replace(titleVersionPlaceholder, metadata.label);
  const assetId = createHash('md5').update(stampedSvg).digest('hex');
  const filename = `${assetId}.svg`;

  titleCostume.assetId = assetId;
  titleCostume.md5ext = filename;
  const archiveEntryIndexes = sourceManifest.archiveEntries
    .map((entryName, index) => (entryName === originalFilename ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(
    archiveEntryIndexes.length,
    1,
    `The source manifest must contain the Title SVG exactly once: ${originalFilename}`,
  );
  sourceManifest.archiveEntries[archiveEntryIndexes[0]] = filename;

  await Promise.all([
    writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`),
    writeFile(sourceManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`),
    writeFile(path.join(assetsDirectory, filename), stampedSvg),
  ]);
  if (filename !== originalFilename) {
    await rm(originalAssetPath);
  }

  return Object.freeze({
    assetId,
    filename,
    label: metadata.label,
  });
}

export async function withTitleBuildMetadataSource(
  {
    buildDate,
    environment = process.env,
    now = new Date(),
    packageJsonPath,
    sourceDirectory,
    version,
  },
  callback,
) {
  assert(typeof sourceDirectory === 'string', 'The app source directory is required.');
  assert(typeof packageJsonPath === 'string', 'The package.json path is required.');
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
    const titleAsset = await stampTitleSource(temporarySource, metadata);
    return await callback({
      metadata: Object.freeze({...metadata, titleAsset}),
      sourceDirectory: temporarySource,
    });
  } finally {
    await rm(temporaryRoot, {force: true, recursive: true});
  }
}
