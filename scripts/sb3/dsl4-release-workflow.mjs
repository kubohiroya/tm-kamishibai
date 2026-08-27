import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

import {
  assertSb3ReleaseSnapshotMetadata,
  computeReleaseSourceIdentity,
  createSb3ReleaseSnapshot,
  freezeSb3ReleaseSnapshot,
  recordPublishedSb3ReleaseSnapshot,
  verifySb3ReleaseSnapshot,
  writeSb3ReleaseCandidate,
} from '@kubohiroya/sb3-toolchain';

import {createKamishibaiSb3} from './build.mjs';
import {createDsl4ReleaseSourceFiles} from './dsl4-downloadable-release.mjs';
import releasePins from '../../test/fixtures/dsl4/release-pins.json' with {type: 'json'};

export const dsl4ReleaseVersion = releasePins.release.version;
export const dsl4NextReleaseVersion = '4.0.0-rc.12';
export const dsl4ReleaseSeries = releasePins.release.series;
export const dsl4ReleaseBuildDate = '2026-08-26';
export const dsl4ReleaseChannel = releasePins.release.channel;
export const dsl4ReleaseTag = `v${dsl4ReleaseVersion}`;
export const dsl4ReleaseFilename = `kamishibai-${dsl4ReleaseVersion}.sb3`;
export const dsl4ReleaseMetadataPath = `release-metadata/${dsl4ReleaseVersion}.json`;
export const dsl4ReleaseCandidateArtifactPath = `tmp/release-candidates/${dsl4ReleaseFilename}`;
export const dsl4ReleaseAssetUrl =
  `https://github.com${releasePins.release.repositoryPath}/releases/download/` +
  `${dsl4ReleaseTag}/${dsl4ReleaseFilename}`;

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const validReleaseStates = new Set(['candidate', 'frozen', 'published']);

function normalizedSourceFiles(files) {
  return [...files.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'));
}

export function createDsl4ReleaseSourceIdentity(files) {
  return computeReleaseSourceIdentity(files);
}

export function assertDsl4ReleaseMetadata(metadata) {
  assertSb3ReleaseSnapshotMetadata(metadata);
  assert.equal(metadata.series, dsl4ReleaseSeries, 'DSL 4 release series is invalid.');
  assert.equal(metadata.version, dsl4ReleaseVersion, 'DSL 4 release version is invalid.');
  assert.equal(metadata.channel, dsl4ReleaseChannel, 'DSL 4 release channel is invalid.');
  assert(validReleaseStates.has(metadata.state), 'DSL 4 release state is invalid.');
  assert.equal(metadata.buildDate, dsl4ReleaseBuildDate, 'DSL 4 release build date is invalid.');
  assert.equal(
    Object.hasOwn(metadata, 'sourceDirectory'),
    false,
    'Release metadata must not retain a source snapshot directory.',
  );
  assert.match(
    metadata.sourceIdentity,
    /^sha256:[0-9a-f]{64}$/u,
    'DSL 4 release source identity is invalid.',
  );
  assert.equal(metadata.artifact?.filename, dsl4ReleaseFilename);
  assert.equal(metadata.artifact?.url, dsl4ReleaseAssetUrl);
  assert.match(metadata.artifact?.sha256, /^[0-9a-f]{64}$/u);
  assert(
    Number.isSafeInteger(metadata.artifact?.size) && metadata.artifact.size > 0,
    'DSL 4 release artifact size is invalid.',
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

async function readMetadata(root) {
  try {
    const source = await readFile(path.join(root, dsl4ReleaseMetadataPath), 'utf8');
    return assertDsl4ReleaseMetadata(JSON.parse(source));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
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

function sb3Options(root, sourceDirectory) {
  return {
    buildDate: dsl4ReleaseBuildDate,
    faviconPath: path.join(root, 'site/favicon.png'),
    sourceDirectory,
    version: dsl4ReleaseVersion,
  };
}

async function createCandidate(root, files, createSb3) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'tmpose-kamishibai-release-'));
  const sourceDirectory = path.join(temporaryRoot, 'app');
  try {
    await writeSourceFiles(sourceDirectory, files);
    return await createSb3(sb3Options(root, sourceDirectory));
  } finally {
    await rm(temporaryRoot, {force: true, recursive: true});
  }
}

async function writeAtomically(filename, contents) {
  await mkdir(path.dirname(filename), {recursive: true});
  const temporaryPath = `${filename}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, contents);
    await rename(temporaryPath, filename);
  } catch (error) {
    await rm(temporaryPath, {force: true});
    throw error;
  }
}

async function defaultFetchReleaseArtifact(metadata) {
  const {createDownloadableReleaseSb3} = await import('./downloadable-releases.mjs');
  const result = await createDownloadableReleaseSb3({
    ...metadata.artifact,
    buildDate: metadata.buildDate,
    series: metadata.series,
    version: metadata.version,
  });
  return result.archive;
}

async function verifyRemoteArtifact(metadata, fetchReleaseArtifact = defaultFetchReleaseArtifact) {
  await verifySb3ReleaseSnapshot({metadata, fetchPublishedArtifact: fetchReleaseArtifact});
}

export async function updateDsl4Release({
  root = repositoryRoot,
  createSourceFiles = createDsl4ReleaseSourceFiles,
  createSb3 = createKamishibaiSb3,
} = {}) {
  const previousMetadata = await readMetadata(root);
  assertDsl4ReleaseCanUpdate(previousMetadata);
  const files = await createSourceFiles();
  const built = await createSb3ReleaseSnapshot({
    artifact: {
      filename: dsl4ReleaseFilename,
      url: dsl4ReleaseAssetUrl,
    },
    createSb3: () => createCandidate(root, files, createSb3),
    metadata: {
      series: dsl4ReleaseSeries,
      version: dsl4ReleaseVersion,
      channel: dsl4ReleaseChannel,
      buildDate: dsl4ReleaseBuildDate,
    },
    publication: {
      npm: {distTag: dsl4ReleaseChannel},
      github: {prerelease: true, tag: dsl4ReleaseTag},
      pages: {recommended: false},
    },
    sourceFiles: files,
  });
  const metadata = assertDsl4ReleaseMetadata(built.metadata);
  await writeSb3ReleaseCandidate({
    archive: built.archive,
    artifactPath: path.join(root, dsl4ReleaseCandidateArtifactPath),
    metadata,
    metadataPath: path.join(root, dsl4ReleaseMetadataPath),
  });
  return {
    artifactPath: path.join(root, dsl4ReleaseCandidateArtifactPath),
    metadata,
    previousMetadata,
  };
}

export async function verifyDsl4ReleaseSnapshot({
  root = repositoryRoot,
  createSourceFiles = createDsl4ReleaseSourceFiles,
  createSb3 = createKamishibaiSb3,
  fetchReleaseArtifact = defaultFetchReleaseArtifact,
  verifyCatalog = true,
  verifyPackageVersion = true,
} = {}) {
  const metadata = await readMetadata(root);
  assert(metadata, `Missing ${dsl4ReleaseMetadataPath}. Run pnpm release:dsl4:update.`);
  if (metadata.state === 'published') {
    await verifyRemoteArtifact(metadata, fetchReleaseArtifact);
  } else {
    const files = await createSourceFiles();
    await verifySb3ReleaseSnapshot({
      createSb3: () => createCandidate(root, files, createSb3),
      metadata,
      sourceFiles: files,
    });
  }
  if (verifyPackageVersion) {
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    assert.equal(packageJson.version, dsl4ReleaseVersion, 'package.json release version is stale.');
  }
  if (verifyCatalog) {
    const {downloadCatalog} = await import('../download-catalog.mjs');
    const catalogEntry = downloadCatalog.find(({series}) => series === dsl4ReleaseSeries);
    assert.equal(catalogEntry?.version, metadata.version);
    if (metadata.state === 'published') {
      assert.equal(catalogEntry?.artifact?.sha256, metadata.artifact.sha256);
      assert.equal(catalogEntry?.artifact?.url, metadata.artifact.url);
    } else {
      assert.equal(catalogEntry?.artifact, undefined);
    }
    assert.equal(downloadCatalog.find(({recommended}) => recommended)?.version, '3.2.3');
  }
  return metadata;
}

export const checkDsl4Release = verifyDsl4ReleaseSnapshot;

export async function verifyDsl4PublishedReleaseSnapshot(options = {}) {
  const metadata = await readMetadata(options.root ?? repositoryRoot);
  assert(metadata, `Missing ${dsl4ReleaseMetadataPath}.`);
  assert.equal(metadata.state, 'published', `${dsl4ReleaseVersion} must be published.`);
  return verifyDsl4ReleaseSnapshot(options);
}

async function writeMetadataAtomically(root, metadata) {
  await writeAtomically(
    path.join(root, dsl4ReleaseMetadataPath),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}

export async function freezeDsl4Release(options = {}) {
  const metadata = await checkDsl4Release(options);
  if (metadata.state === 'frozen') return metadata;
  assert.equal(metadata.state, 'candidate', `${dsl4ReleaseVersion} is already published.`);
  const frozen = assertDsl4ReleaseMetadata(freezeSb3ReleaseSnapshot(metadata));
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
  {root = repositoryRoot, fetchReleaseArtifact = defaultFetchReleaseArtifact} = {},
) {
  const metadata = await readMetadata(root);
  assert(metadata, `Missing ${dsl4ReleaseMetadataPath}.`);
  assert.equal(
    metadata.state,
    'frozen',
    `${dsl4ReleaseVersion} must be frozen before publication.`,
  );
  const published = assertDsl4ReleaseMetadata(
    await recordPublishedSb3ReleaseSnapshot(
      metadata,
      {
        npm: publicationUrl('--npm-url', npmUrl),
        githubRelease: publicationUrl('--github-release-url', githubReleaseUrl),
        pages: publicationUrl('--pages-url', pagesUrl),
      },
      {fetchPublishedArtifact: fetchReleaseArtifact},
    ),
  );
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
    const {artifactPath, metadata, previousMetadata} = await updateDsl4Release();
    process.stdout.write(
      `Updated ${metadata.version} candidate: ${previousMetadata?.artifact.sha256 ?? 'new'} -> ${metadata.artifact.sha256}\n` +
        `Transient artifact: ${artifactPath}\nRun pnpm release:dsl4:check next.\n`,
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
  if (command === 'verify-published-snapshot') {
    const metadata = await verifyDsl4PublishedReleaseSnapshot();
    process.stdout.write(
      `Verified ${metadata.version} published release asset: ${metadata.artifact.sha256}\n`,
    );
    return;
  }
  if (command === 'freeze') {
    const metadata = await freezeDsl4Release();
    process.stdout.write(`Frozen ${metadata.version}: ${metadata.artifact.sha256}.\n`);
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
  throw new Error(
    'Usage: dsl4-release-workflow.mjs <update|check|verify-published-snapshot|freeze|record-publication>',
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
