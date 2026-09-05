import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rename, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

import {
  computeReleaseSourceIdentity,
  createSb3ReleaseSnapshot,
  freezeSb3ReleaseSnapshot,
  readSb3ReleaseSnapshotMetadata,
  recordPublishedSb3ReleaseSnapshot,
  verifySb3ReleaseSnapshot,
  writeSb3ReleaseCandidate,
  // @ts-expect-error -- @kubohiroya/sb3-toolchain ships JavaScript without declarations today.
  // The package is migrating to TypeScript; when it publishes types this directive becomes unused
  // and the type check fails, which is the signal to delete it and pick the real types up.
} from '@kubohiroya/sb3-toolchain';

import {createKamishibaiSb3} from './build.mjs';
import {createDsl4ReleaseSourceFiles} from './dsl4-downloadable-release.mjs';
import {
  assertDsl4ReleaseCanUpdate,
  assertDsl4ReleaseDownloadCatalog,
  assertDsl4ReleaseMetadata,
  assertDsl4ReleasePackageVersion,
  dsl4ReleaseArtifactIdentity,
  dsl4ReleaseCandidateArtifactPath,
  dsl4ReleaseIdentity,
  dsl4ReleaseMetadataPath,
  dsl4ReleasePublicationPolicy,
  dsl4ReleasePublicationUrls,
  dsl4ReleaseSb3Options,
  dsl4ReleaseVersion,
} from './dsl4-release-policy.mjs';

/**
 * Drives the generic SB3 release snapshot lifecycle from `@kubohiroya/sb3-toolchain` — source
 * identity, deterministic build verification, artifact hash and size metadata, candidate write,
 * freeze, and published artifact verification — under the DSL 4 policy in
 * `./dsl4-release-policy.mjs`.
 */

export * from './dsl4-release-policy.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export const createDsl4ReleaseSourceIdentity = computeReleaseSourceIdentity;

async function readMetadata(/** @type {any} */ root) {
  try {
    const metadata = await readSb3ReleaseSnapshotMetadata(path.join(root, dsl4ReleaseMetadataPath));
    return assertDsl4ReleaseMetadata(metadata);
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Materialize the in-memory release source into a throwaway directory the SB3 builder can read. */
async function withReleaseSourceDirectory(/** @type {any} */ files, /** @type {any} */ build) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'tmpose-kamishibai-release-'));
  const sourceDirectory = path.join(temporaryRoot, 'app');
  try {
    for (const [relativePath, contents] of [...files.entries()].sort(([left], [right]) =>
      left.localeCompare(right, 'en'),
    )) {
      const outputPath = path.join(sourceDirectory, relativePath);
      await mkdir(path.dirname(outputPath), {recursive: true});
      await writeFile(outputPath, contents);
    }
    return await build(sourceDirectory);
  } finally {
    await rm(temporaryRoot, {force: true, recursive: true});
  }
}

function createReleaseSb3(
  /** @type {any} */ root,
  /** @type {any} */ files,
  /** @type {any} */ createSb3,
) {
  return () =>
    withReleaseSourceDirectory(files, (/** @type {any} */ sourceDirectory) =>
      createSb3(dsl4ReleaseSb3Options({root, sourceDirectory})),
    );
}

async function writeMetadataAtomically(/** @type {any} */ root, /** @type {any} */ metadata) {
  const filename = path.join(root, dsl4ReleaseMetadataPath);
  await mkdir(path.dirname(filename), {recursive: true});
  const temporaryPath = `${filename}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`);
    await rename(temporaryPath, filename);
  } catch (error) {
    await rm(temporaryPath, {force: true});
    throw error;
  }
}

async function defaultFetchReleaseArtifact(/** @type {any} */ metadata) {
  const {createDownloadableReleaseSb3} = await import('./downloadable-releases.mjs');
  const result = await createDownloadableReleaseSb3({
    ...metadata.artifact,
    buildDate: metadata.buildDate,
    series: metadata.series,
    version: metadata.version,
  });
  return result.archive;
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
    artifact: {...dsl4ReleaseArtifactIdentity},
    createSb3: createReleaseSb3(root, files, createSb3),
    metadata: {...dsl4ReleaseIdentity},
    publication: {...dsl4ReleasePublicationPolicy},
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
    await verifySb3ReleaseSnapshot({metadata, fetchPublishedArtifact: fetchReleaseArtifact});
  } else {
    const files = await createSourceFiles();
    await verifySb3ReleaseSnapshot({
      createSb3: createReleaseSb3(root, files, createSb3),
      metadata,
      sourceFiles: files,
    });
  }
  if (verifyPackageVersion) await assertDsl4ReleasePackageVersion(root);
  if (verifyCatalog) await assertDsl4ReleaseDownloadCatalog(metadata);
  return metadata;
}

export const checkDsl4Release = verifyDsl4ReleaseSnapshot;

export async function verifyDsl4PublishedReleaseSnapshot(/** @type {any} */ options = {}) {
  const metadata = await readMetadata(options.root ?? repositoryRoot);
  assert(metadata, `Missing ${dsl4ReleaseMetadataPath}.`);
  assert.equal(metadata.state, 'published', `${dsl4ReleaseVersion} must be published.`);
  return verifyDsl4ReleaseSnapshot(options);
}

export async function freezeDsl4Release(/** @type {any} */ options = {}) {
  const metadata = await checkDsl4Release(options);
  if (metadata.state === 'frozen') return metadata;
  assert.equal(metadata.state, 'candidate', `${dsl4ReleaseVersion} is already published.`);
  const frozen = assertDsl4ReleaseMetadata(freezeSb3ReleaseSnapshot(metadata));
  await writeMetadataAtomically(options.root ?? repositoryRoot, frozen);
  return frozen;
}

export async function recordDsl4Publication(
  /** @type {any} */ urls,
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
    await recordPublishedSb3ReleaseSnapshot(metadata, dsl4ReleasePublicationUrls(urls), {
      fetchPublishedArtifact: fetchReleaseArtifact,
    }),
  );
  await writeMetadataAtomically(root, published);
  return published;
}

function argumentValue(/** @type {any} */ name) {
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
