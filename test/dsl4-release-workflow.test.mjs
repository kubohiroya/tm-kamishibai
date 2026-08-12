import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertDsl4ReleaseCanUpdate,
  checkDsl4Release,
  createDsl4ReleaseSourceIdentity,
  dsl4NextReleaseVersion,
  dsl4ReleaseMetadataPath,
  dsl4ReleaseSourceDirectory,
  freezeDsl4Release,
  recordDsl4Publication,
  updateDsl4Release,
} from '../scripts/sb3/dsl4-release-workflow.mjs';

const sourceFiles = () =>
  new Map([
    ['assets/example.svg', Buffer.from('<svg/>\n')],
    ['project.source.json', Buffer.from('{"targets":[]}\n')],
  ]);
const archive = Buffer.from('deterministic-sb3');
const createSb3 = async () => ({archive});

async function releaseSnapshot(root) {
  return Promise.all([
    readFile(path.join(root, dsl4ReleaseMetadataPath), 'utf8'),
    readFile(path.join(root, dsl4ReleaseSourceDirectory, 'assets/example.svg')),
    readFile(path.join(root, dsl4ReleaseSourceDirectory, 'project.source.json')),
  ]);
}

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

test('updates atomically, remains idempotent, and preserves the candidate on failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsl4-release-update-'));
  try {
    const options = {root, createSourceFiles: async () => sourceFiles(), createSb3};
    const first = await updateDsl4Release(options);
    const firstSnapshot = await releaseSnapshot(root);
    const second = await updateDsl4Release(options);
    const secondSnapshot = await releaseSnapshot(root);

    assert.equal(first.metadata.state, 'candidate');
    assert.deepEqual(secondSnapshot, firstSnapshot);
    assert.equal(second.previousMetadata.artifact.sha256, first.metadata.artifact.sha256);

    await assert.rejects(
      updateDsl4Release({
        root,
        createSourceFiles: async () => new Map([['broken', Buffer.from('partial')]]),
        createSb3: async () => {
          throw new Error('injected build failure');
        },
      }),
      /injected build failure/u,
    );
    assert.deepEqual(await releaseSnapshot(root), firstSnapshot);

    await writeFile(
      path.join(root, 'release-sources/4.0.0-rc.1/release.json'),
      '{"invalid":true}\n',
    );
    await assert.rejects(updateDsl4Release(options), /metadata format is invalid/u);
    assert.equal(
      await readFile(path.join(root, 'release-sources/4.0.0-rc.1/app/project.source.json'), 'utf8'),
      '{"targets":[]}\n',
    );
  } finally {
    await rm(root, {force: true, recursive: true});
  }
});

test('checks without mutation and rejects same-version updates after freeze', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsl4-release-freeze-'));
  const options = {
    root,
    createSourceFiles: async () => sourceFiles(),
    createSb3,
    verifyCatalog: false,
    verifyPackageVersion: false,
  };
  try {
    await updateDsl4Release(options);
    const beforeCheck = await releaseSnapshot(root);
    assert.equal((await checkDsl4Release(options)).state, 'candidate');
    assert.deepEqual(await releaseSnapshot(root), beforeCheck);

    const frozen = await freezeDsl4Release(options);
    assert.equal(frozen.state, 'frozen');
    assert.throws(
      () => assertDsl4ReleaseCanUpdate(frozen),
      new RegExp(`${dsl4NextReleaseVersion.replaceAll('.', '\\.')}`),
    );
    await assert.rejects(updateDsl4Release(options), /immutable/u);
    await assert.rejects(
      checkDsl4Release({
        ...options,
        createSourceFiles: async () =>
          new Map([...sourceFiles(), ['post-freeze-change', Buffer.from('not allowed')]]),
      }),
      new RegExp(`${dsl4NextReleaseVersion.replaceAll('.', '\\.')}`),
    );

    const published = await recordDsl4Publication(
      {
        npmUrl: 'https://www.npmjs.com/package/example/v/4.0.0-rc.1',
        githubReleaseUrl: 'https://github.com/example/project/releases/tag/v4.0.0-rc.1',
        pagesUrl: 'https://example.github.io/project/downloads/',
      },
      {root},
    );
    assert.equal(published.state, 'published');
    assert.deepEqual(Object.keys(published.publication.urls).sort(), [
      'githubRelease',
      'npm',
      'pages',
    ]);
    assert.equal((await checkDsl4Release(options)).state, 'published');
  } finally {
    await rm(root, {force: true, recursive: true});
  }
});
