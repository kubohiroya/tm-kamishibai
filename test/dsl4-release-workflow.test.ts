import assert from 'node:assert/strict';
import {access, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'vitest';

import {
  assertDsl4ReleaseCanUpdate,
  checkDsl4Release,
  createDsl4ReleaseSourceIdentity,
  cutDsl4Release,
  dsl4NextReleaseVersion,
  dsl4ReleaseCandidateArtifactPath,
  dsl4ReleaseMetadataPath,
  freezeDsl4Release,
  recordDsl4Publication,
  rebuildFrozenDsl4Release,
  updateDsl4Release,
  verifyDsl4PublishedReleaseSnapshot,
} from '../scripts/sb3/dsl4-release-workflow.ts';
import {requireDefined} from './helpers/require-value.ts';
import {thrown} from './helpers/thrown-error.ts';

const sourceFiles = () =>
  new Map([
    ['assets/example.svg', Buffer.from('<svg/>\n')],
    ['project.source.json', Buffer.from('{"targets":[]}\n')],
  ]);
const archive = Buffer.from('deterministic-sb3');
const createSb3 = async () => ({archive});
const fetchReleaseArtifact = async () => archive;

async function snapshot(root: string) {
  return Promise.all([
    readFile(path.join(root, dsl4ReleaseMetadataPath)),
    readFile(path.join(root, dsl4ReleaseCandidateArtifactPath)),
  ]);
}

const options = (root: string) => ({
  root,
  createSourceFiles: async () => sourceFiles(),
  createSb3,
  fetchReleaseArtifact,
  verifyCatalog: false,
  verifyPackageVersion: false,
});

test('derives one stable release source identity from sorted path and byte content', () => {
  const ordered = sourceFiles();
  const reversed = new Map([...ordered].reverse());
  const modified = sourceFiles();
  modified.set('project.source.json', Buffer.from('{"targets":[1]}\n'));
  assert.equal(createDsl4ReleaseSourceIdentity(ordered), createDsl4ReleaseSourceIdentity(reversed));
  assert.notEqual(
    createDsl4ReleaseSourceIdentity(ordered),
    createDsl4ReleaseSourceIdentity(modified),
  );
});

test('updates only metadata and an ignored transient artifact, preserving both on failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsl4-release-update-'));
  try {
    const first = await updateDsl4Release(options(root));
    const firstSnapshot = await snapshot(root);
    const second = await updateDsl4Release(options(root));
    assert.deepEqual(await snapshot(root), firstSnapshot);
    assert.equal(
      requireDefined(second.previousMetadata, 'the previous metadata').artifact.sha256,
      first.metadata.artifact.sha256,
    );
    assert.equal(Object.hasOwn(first.metadata, 'sourceDirectory'), false);
    await assert.rejects(
      access(path.join(root, 'release-sources')),
      (error) => thrown(error).code === 'ENOENT',
    );

    await assert.rejects(
      updateDsl4Release({
        ...options(root),
        createSourceFiles: async () => new Map([['broken', Buffer.from('partial')]]),
        createSb3: async () => {
          throw new Error('injected build failure');
        },
      }),
      /injected build failure/u,
    );
    assert.deepEqual(await snapshot(root), firstSnapshot);

    await writeFile(path.join(root, dsl4ReleaseMetadataPath), '{"invalid":true}\n');
    await assert.rejects(updateDsl4Release(options(root)), /metadata format is invalid/u);
  } finally {
    await rm(root, {force: true, recursive: true});
  }
});

test('cuts a frozen release in one step and refuses to regenerate it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsl4-release-cut-'));
  try {
    const {metadata, previousMetadata, artifactPath} = await cutDsl4Release(options(root));
    // A candidate on main is a version whose bytes can still change under anyone who pins it,
    // so the cut leaves nothing for a second pull request to freeze.
    assert.equal(metadata.state, 'frozen');
    assert.equal(previousMetadata, null, 'A first cut has no earlier metadata.');
    await access(artifactPath);
    // check still rebuilds from source for a frozen release, which is what verifies the cut.
    assert.equal((await checkDsl4Release(options(root))).state, 'frozen');
    await assert.rejects(cutDsl4Release(options(root)), /immutable/u);
    assert.throws(
      () => assertDsl4ReleaseCanUpdate(metadata),
      new RegExp(dsl4NextReleaseVersion.replaceAll('.', '\\.')),
    );
  } finally {
    await rm(root, {force: true, recursive: true});
  }
});

test('regenerates candidate and frozen inputs, then verifies the GitHub asset after publication', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsl4-release-lifecycle-'));
  try {
    await updateDsl4Release(options(root));
    assert.equal((await checkDsl4Release(options(root))).state, 'candidate');
    await assert.rejects(
      checkDsl4Release({
        ...options(root),
        createSourceFiles: async () =>
          new Map([...sourceFiles(), ['candidate-change', Buffer.from('update required')]]),
      }),
      /release source changed/u,
    );

    const frozen = await freezeDsl4Release(options(root));
    assert.equal(frozen.state, 'frozen');
    assert.throws(
      () => assertDsl4ReleaseCanUpdate(frozen),
      new RegExp(dsl4NextReleaseVersion.replaceAll('.', '\\.')),
    );
    await assert.rejects(updateDsl4Release(options(root)), /immutable/u);

    const published = await recordDsl4Publication(
      {
        npmUrl: 'https://www.npmjs.com/package/example/v/4.0.0-rc.9',
        githubReleaseUrl: 'https://github.com/example/project/releases/tag/v4.0.0-rc.9',
        pagesUrl: 'https://example.github.io/project/downloads/',
      },
      {root, fetchReleaseArtifact},
    );
    assert.equal(published.state, 'published');
    let generated = false;
    const publishedOptions = {
      ...options(root),
      createSourceFiles: async () => {
        generated = true;
        return sourceFiles();
      },
    };
    assert.equal((await verifyDsl4PublishedReleaseSnapshot(publishedOptions)).state, 'published');
    assert.equal(generated, false, 'Published verification must use the GitHub Release asset.');
  } finally {
    await rm(root, {force: true, recursive: true});
  }
});

test('rejects a published GitHub Release asset with different bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsl4-release-remote-'));
  try {
    await updateDsl4Release(options(root));
    await freezeDsl4Release(options(root));
    await recordDsl4Publication(
      {
        npmUrl: 'https://www.npmjs.com/package/example/v/4.0.0-rc.9',
        githubReleaseUrl: 'https://github.com/example/project/releases/tag/v4.0.0-rc.9',
        pagesUrl: 'https://example.github.io/project/downloads/',
      },
      {root, fetchReleaseArtifact},
    );
    await assert.rejects(
      verifyDsl4PublishedReleaseSnapshot({
        ...options(root),
        fetchReleaseArtifact: async () => Buffer.from('tampered'),
      }),
      /size is invalid/u,
    );
  } finally {
    await rm(root, {force: true, recursive: true});
  }
});

test('rebuilds frozen publication bytes without changing source metadata or the candidate file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsl4-read-only-publication-'));
  try {
    await cutDsl4Release(options(root));
    const before = await snapshot(root);
    const result = await rebuildFrozenDsl4Release(options(root));
    assert.deepEqual(result.archive, archive);
    assert.equal(result.metadata.state, 'frozen');
    assert.deepEqual(await snapshot(root), before);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('refuses to attach a mutable candidate', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsl4-mutable-publication-'));
  try {
    await updateDsl4Release(options(root));
    const before = await snapshot(root);
    await assert.rejects(rebuildFrozenDsl4Release(options(root)), /frozen/u);
    assert.deepEqual(await snapshot(root), before);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('fails publication reconstruction when frozen source or output bytes drift', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsl4-publication-drift-'));
  try {
    await cutDsl4Release(options(root));
    const before = await snapshot(root);
    await assert.rejects(
      rebuildFrozenDsl4Release({
        ...options(root),
        createSourceFiles: async () => new Map([['changed', Buffer.from('changed')]]),
      }),
    );
    await assert.rejects(
      rebuildFrozenDsl4Release({
        ...options(root),
        createSb3: async () => ({archive: Buffer.from('changed')}),
      }),
    );
    assert.deepEqual(await snapshot(root), before);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
