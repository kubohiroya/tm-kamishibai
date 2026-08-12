import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

import {createKamishibaiSb3} from './build.mjs';
import {createDsl4ReleaseSourceFiles} from './dsl4-downloadable-release.mjs';

export const dsl4ReleaseVersion = '4.0.0-rc.2';
export const dsl4NextReleaseVersion = '4.0.0-rc.3';
export const dsl4ReleaseSeries = '4.0';
export const dsl4ReleaseBuildDate = '2026-08-12';
export const dsl4ReleaseChannel = 'next';
export const dsl4ReleaseTag = `v${dsl4ReleaseVersion}`;
export const dsl4ReleaseFilename = `kamishibai-${dsl4ReleaseVersion}.sb3`;
export const dsl4ReleaseRoot = `release-sources/${dsl4ReleaseVersion}`;
export const dsl4ReleaseSourceDirectory = `${dsl4ReleaseRoot}/app`;
export const dsl4ReleaseMetadataPath = `${dsl4ReleaseRoot}/release.json`;

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const validReleaseStates = new Set(['candidate', 'frozen', 'published']);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizedSourceFiles(files) {
  return [...files.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'));
}

export function createDsl4ReleaseSourceIdentity(files) {
  const hash = createHash('sha256');
  for (const [relativePath, contents] of normalizedSourceFiles(files)) {
    const pathBytes = Buffer.from(relativePath);
    hash.update(Buffer.from(`${pathBytes.byteLength}:`));
    hash.update(pathBytes);
    hash.update(Buffer.from(`:${contents.byteLength}:`));
    hash.update(contents);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function assertDsl4ReleaseMetadata(metadata) {
  assert.equal(metadata?.formatVersion, 1, 'DSL 4 release metadata format is invalid.');
  assert.equal(metadata.series, dsl4ReleaseSeries, 'DSL 4 release series is invalid.');
  assert.equal(metadata.version, dsl4ReleaseVersion, 'DSL 4 release version is invalid.');
  assert.equal(metadata.channel, dsl4ReleaseChannel, 'DSL 4 release channel is invalid.');
  assert(validReleaseStates.has(metadata.state), 'DSL 4 release state is invalid.');
  assert.equal(metadata.buildDate, dsl4ReleaseBuildDate, 'DSL 4 release build date is invalid.');
  assert.equal(
    metadata.sourceDirectory,
    dsl4ReleaseSourceDirectory,
    'DSL 4 release source directory is invalid.',
  );
  assert.match(
    metadata.sourceIdentity,
    /^sha256:[0-9a-f]{64}$/u,
    'DSL 4 release source identity is invalid.',
  );
  assert.equal(
    metadata.artifact?.filename,
    dsl4ReleaseFilename,
    'DSL 4 release artifact filename is invalid.',
  );
  assert.match(
    metadata.artifact?.sha256,
    /^[0-9a-f]{64}$/u,
    'DSL 4 release artifact SHA-256 is invalid.',
  );
  assert.deepEqual(metadata.publication?.npm, {distTag: dsl4ReleaseChannel});
  assert.deepEqual(metadata.publication?.github, {prerelease: true, tag: dsl4ReleaseTag});
  assert.deepEqual(metadata.publication?.pages, {recommended: false});
  if (metadata.state === 'published') {
    for (const [surface, url] of Object.entries(metadata.publication.urls ?? {})) {
      assert.match(url, /^https:\/\//u, `${surface} publication URL must use HTTPS.`);
    }
    assert.deepEqual(Object.keys(metadata.publication.urls ?? {}).sort(), [
      'githubRelease',
      'npm',
      'pages',
    ]);
  }
  return metadata;
}

export function assertDsl4ReleaseCanUpdate(metadata) {
  if (!metadata) return;
  assertDsl4ReleaseMetadata(metadata);
  assert.equal(
    metadata.state,
    'candidate',
    `${dsl4ReleaseVersion} is ${metadata.state} and immutable. Create ${dsl4NextReleaseVersion} instead.`,
  );
}

function createMetadata(files, archive, state = 'candidate') {
  return {
    formatVersion: 1,
    series: dsl4ReleaseSeries,
    version: dsl4ReleaseVersion,
    channel: dsl4ReleaseChannel,
    state,
    buildDate: dsl4ReleaseBuildDate,
    sourceDirectory: dsl4ReleaseSourceDirectory,
    sourceIdentity: createDsl4ReleaseSourceIdentity(files),
    artifact: {
      filename: dsl4ReleaseFilename,
      sha256: sha256(archive),
    },
    publication: {
      npm: {distTag: dsl4ReleaseChannel},
      github: {prerelease: true, tag: dsl4ReleaseTag},
      pages: {recommended: false},
    },
  };
}

async function readMetadata(root) {
  try {
    const source = await readFile(path.join(root, dsl4ReleaseMetadataPath), 'utf8');
    return assertDsl4ReleaseMetadata(JSON.parse(source));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function directoryExists(directory) {
  try {
    return (await stat(directory)).isDirectory();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeSourceFiles(directory, files) {
  for (const [relativePath, contents] of normalizedSourceFiles(files)) {
    const outputPath = path.join(directory, relativePath);
    await mkdir(path.dirname(outputPath), {recursive: true});
    await writeFile(outputPath, contents);
  }
}

async function listFiles(directory, relative = '') {
  const entries = await readdir(directory, {withFileTypes: true});
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const nested = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory())
      files.push(...(await listFiles(path.join(directory, entry.name), nested)));
    else if (entry.isFile()) files.push(nested);
    else throw new Error(`Unsupported release source entry: ${nested}`);
  }
  return files;
}

async function assertSourceFiles(directory, expectedFiles, repairGuidance) {
  const expectedNames = normalizedSourceFiles(expectedFiles).map(([relativePath]) => relativePath);
  assert.deepEqual(
    await listFiles(directory),
    expectedNames,
    `DSL 4 release source file set is stale. ${repairGuidance}`,
  );
  for (const [relativePath, expected] of normalizedSourceFiles(expectedFiles)) {
    const actual = await readFile(path.join(directory, relativePath));
    assert(
      actual.equals(expected),
      `DSL 4 release source is stale: ${relativePath}. ${repairGuidance}`,
    );
  }
}

async function replaceReleaseRoot(targetRoot, temporaryRoot) {
  const backupRoot = `${targetRoot}.backup-${process.pid}`;
  let movedExisting = false;
  try {
    if (await directoryExists(targetRoot)) {
      await rename(targetRoot, backupRoot);
      movedExisting = true;
    }
    await rename(temporaryRoot, targetRoot);
  } catch (error) {
    if (movedExisting && !(await directoryExists(targetRoot))) {
      await rename(backupRoot, targetRoot);
    }
    throw error;
  }
  if (movedExisting) await rm(backupRoot, {force: true, recursive: true});
}

function sb3Options(root, sourceDirectory) {
  return {
    buildDate: dsl4ReleaseBuildDate,
    faviconPath: path.join(root, 'site/favicon.png'),
    sourceDirectory,
    version: dsl4ReleaseVersion,
  };
}

export async function updateDsl4Release({
  root = repositoryRoot,
  createSourceFiles = createDsl4ReleaseSourceFiles,
  createSb3 = createKamishibaiSb3,
} = {}) {
  const previousMetadata = await readMetadata(root);
  assertDsl4ReleaseCanUpdate(previousMetadata);

  const files = await createSourceFiles();
  const releaseParent = path.join(root, 'release-sources');
  await mkdir(releaseParent, {recursive: true});
  const temporaryRoot = await mkdtemp(path.join(releaseParent, '.dsl4-release-'));
  const temporarySource = path.join(temporaryRoot, 'app');
  try {
    await writeSourceFiles(temporarySource, files);
    const built = await createSb3(sb3Options(root, temporarySource));
    const metadata = createMetadata(files, built.archive);
    assertDsl4ReleaseMetadata(metadata);
    await writeFile(
      path.join(temporaryRoot, 'release.json'),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    await replaceReleaseRoot(path.join(root, dsl4ReleaseRoot), temporaryRoot);
    return {metadata, previousMetadata};
  } catch (error) {
    await rm(temporaryRoot, {force: true, recursive: true});
    throw error;
  }
}

export async function checkDsl4Release({
  root = repositoryRoot,
  createSourceFiles = createDsl4ReleaseSourceFiles,
  createSb3 = createKamishibaiSb3,
  verifyCatalog = true,
  verifyPackageVersion = true,
} = {}) {
  const metadata = await readMetadata(root);
  assert(metadata, `Missing ${dsl4ReleaseMetadataPath}. Run pnpm release:dsl4:update.`);
  const repairGuidance =
    metadata.state === 'candidate'
      ? `Run pnpm release:dsl4:update for ${dsl4ReleaseVersion}; do not edit hashes by hand.`
      : `${dsl4ReleaseVersion} is ${metadata.state} and immutable. Create ${dsl4NextReleaseVersion} instead.`;
  const expectedFiles = await createSourceFiles();
  const sourceDirectory = path.join(root, dsl4ReleaseSourceDirectory);
  await assertSourceFiles(sourceDirectory, expectedFiles, repairGuidance);
  assert.equal(
    createDsl4ReleaseSourceIdentity(expectedFiles),
    metadata.sourceIdentity,
    `DSL 4 release source identity is stale. ${repairGuidance}`,
  );

  const [first, second] = await Promise.all([
    createSb3(sb3Options(root, sourceDirectory)),
    createSb3(sb3Options(root, sourceDirectory)),
  ]);
  assert(
    Buffer.from(first.archive).equals(Buffer.from(second.archive)),
    `${dsl4ReleaseVersion} SB3 generation is not deterministic.`,
  );
  assert.equal(
    sha256(first.archive),
    metadata.artifact.sha256,
    `DSL 4 release artifact hash is stale. ${repairGuidance}`,
  );

  if (verifyPackageVersion) {
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    assert.equal(packageJson.version, dsl4ReleaseVersion, 'package.json release version is stale.');
  }
  if (verifyCatalog) {
    const {downloadCatalog} = await import('../download-catalog.mjs');
    const catalogEntry = downloadCatalog.find(({series}) => series === dsl4ReleaseSeries);
    assert.equal(catalogEntry?.version, metadata.version);
    assert.equal(catalogEntry?.artifact?.sha256, metadata.artifact.sha256);
    assert.equal(catalogEntry?.artifact?.sourceIdentity, metadata.sourceIdentity);
    assert.equal(catalogEntry?.recommended, undefined);
    assert.equal(
      downloadCatalog.find(({recommended}) => recommended)?.version,
      '3.2.3',
      '3.2.3 must remain the recommended stable release while 4.0 is a release candidate.',
    );
  }
  return metadata;
}

async function writeMetadataAtomically(root, metadata) {
  const metadataPath = path.join(root, dsl4ReleaseMetadataPath);
  const temporaryPath = `${metadataPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await rename(temporaryPath, metadataPath);
}

export async function freezeDsl4Release(options = {}) {
  const metadata = await checkDsl4Release(options);
  if (metadata.state === 'frozen') return metadata;
  assert.equal(metadata.state, 'candidate', `${dsl4ReleaseVersion} is already published.`);
  const frozen = {...metadata, state: 'frozen'};
  assertDsl4ReleaseMetadata(frozen);
  await writeMetadataAtomically(options.root ?? repositoryRoot, frozen);
  return frozen;
}

function publicationUrl(argumentName, value) {
  assert(value, `Missing ${argumentName}.`);
  const url = new URL(value);
  assert.equal(url.protocol, 'https:', `${argumentName} must use HTTPS.`);
  return url.href;
}

export async function recordDsl4Publication(
  {npmUrl, githubReleaseUrl, pagesUrl},
  {root = repositoryRoot} = {},
) {
  const metadata = await readMetadata(root);
  assert(metadata, `Missing ${dsl4ReleaseMetadataPath}.`);
  assert.equal(
    metadata.state,
    'frozen',
    `${dsl4ReleaseVersion} must be frozen before publication.`,
  );
  const published = {
    ...metadata,
    state: 'published',
    publication: {
      ...metadata.publication,
      urls: {
        npm: publicationUrl('--npm-url', npmUrl),
        githubRelease: publicationUrl('--github-release-url', githubReleaseUrl),
        pages: publicationUrl('--pages-url', pagesUrl),
      },
    },
  };
  assertDsl4ReleaseMetadata(published);
  await writeMetadataAtomically(root, published);
  return published;
}

function argumentValue(name) {
  const position = process.argv.indexOf(name);
  return position === -1 ? undefined : process.argv[position + 1];
}

async function main() {
  const command = process.argv[2];
  if (command === 'update') {
    const {metadata, previousMetadata} = await updateDsl4Release();
    process.stdout.write(
      `Updated ${metadata.version} candidate: ${previousMetadata?.artifact.sha256 ?? 'new'} -> ${metadata.artifact.sha256}\n` +
        `Run pnpm release:dsl4:check next.\n`,
    );
    return;
  }
  if (command === 'check') {
    const metadata = await checkDsl4Release();
    process.stdout.write(
      `Verified ${metadata.version} ${metadata.state}: ${metadata.artifact.sha256}\n`,
    );
    return;
  }
  if (command === 'freeze') {
    const metadata = await freezeDsl4Release();
    process.stdout.write(
      `Frozen ${metadata.version}: ${metadata.artifact.sha256}. Future changes require ${dsl4NextReleaseVersion}.\n`,
    );
    return;
  }
  if (command === 'record-publication') {
    const metadata = await recordDsl4Publication({
      npmUrl: argumentValue('--npm-url'),
      githubReleaseUrl: argumentValue('--github-release-url'),
      pagesUrl: argumentValue('--pages-url'),
    });
    process.stdout.write(`Recorded ${metadata.version} as published.\n`);
    return;
  }
  throw new Error('Usage: dsl4-release-workflow.mjs <update|check|freeze|record-publication>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
