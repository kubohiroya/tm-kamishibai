import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

import {assertSb3ReleaseSnapshotMetadata} from '@kubohiroya/sb3-toolchain';

import releasePins from '../../test/fixtures/dsl4/release-pins.json' with {type: 'json'};

/**
 * Kamishibai release policy for the generic SB3 release snapshot lifecycle owned by
 * `@kubohiroya/sb3-toolchain`. Everything here is DSL 4 specific: release identity, artifact
 * naming, publication surfaces, title build metadata stamping, and the download catalog contract.
 */

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
export const dsl4RecommendedLegacyReleaseVersion = '3.2.3';

/** Snapshot metadata fields the generic helper copies verbatim, in serialized order. */
export const dsl4ReleaseIdentity = Object.freeze({
  series: dsl4ReleaseSeries,
  version: dsl4ReleaseVersion,
  channel: dsl4ReleaseChannel,
  buildDate: dsl4ReleaseBuildDate,
});

export const dsl4ReleaseArtifactIdentity = Object.freeze({
  filename: dsl4ReleaseFilename,
  url: dsl4ReleaseAssetUrl,
});

export const dsl4ReleasePublicationPolicy = Object.freeze({
  npm: Object.freeze({distTag: dsl4ReleaseChannel}),
  github: Object.freeze({prerelease: true, tag: dsl4ReleaseTag}),
  pages: Object.freeze({recommended: false}),
});

/** Kamishibai SB3 build inputs, including the title build metadata stamped into the artifact. */
export function dsl4ReleaseSb3Options({root, sourceDirectory}) {
  return {
    buildDate: dsl4ReleaseBuildDate,
    faviconPath: path.join(root, 'site/favicon.png'),
    sourceDirectory,
    version: dsl4ReleaseVersion,
  };
}

export function assertDsl4ReleaseMetadata(metadata) {
  assertSb3ReleaseSnapshotMetadata(metadata);
  assert.equal(metadata.series, dsl4ReleaseSeries, 'DSL 4 release series is invalid.');
  assert.equal(metadata.version, dsl4ReleaseVersion, 'DSL 4 release version is invalid.');
  assert.equal(metadata.channel, dsl4ReleaseChannel, 'DSL 4 release channel is invalid.');
  assert.equal(metadata.buildDate, dsl4ReleaseBuildDate, 'DSL 4 release build date is invalid.');
  assert.equal(
    Object.hasOwn(metadata, 'sourceDirectory'),
    false,
    'Release metadata must not retain a source snapshot directory.',
  );
  assert.equal(metadata.artifact.filename, dsl4ReleaseFilename);
  assert.equal(metadata.artifact.url, dsl4ReleaseAssetUrl);
  assert.deepEqual(metadata.publication?.npm, {distTag: dsl4ReleaseChannel});
  assert.deepEqual(metadata.publication?.github, {prerelease: true, tag: dsl4ReleaseTag});
  assert.deepEqual(metadata.publication?.pages, {recommended: false});
  if (metadata.state === 'published') {
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

function publicationUrl(argumentName, value) {
  assert(value, `Missing ${argumentName}.`);
  const url = new URL(value);
  assert.equal(url.protocol, 'https:', `${argumentName} must use HTTPS.`);
  return url.href;
}

/** Map the record-publication CLI arguments onto the surfaces this release publishes to. */
export function dsl4ReleasePublicationUrls({npmUrl, githubReleaseUrl, pagesUrl}) {
  return {
    npm: publicationUrl('--npm-url', npmUrl),
    githubRelease: publicationUrl('--github-release-url', githubReleaseUrl),
    pages: publicationUrl('--pages-url', pagesUrl),
  };
}

export async function assertDsl4ReleasePackageVersion(root) {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.version, dsl4ReleaseVersion, 'package.json release version is stale.');
}

/** The site download catalog only advertises artifact bytes once the release is published. */
export async function assertDsl4ReleaseDownloadCatalog(metadata) {
  const {downloadCatalog} = await import('../download-catalog.mjs');
  const catalogEntry = downloadCatalog.find(({series}) => series === dsl4ReleaseSeries);
  assert.equal(catalogEntry?.version, metadata.version);
  if (metadata.state === 'published') {
    assert.equal(catalogEntry?.artifact?.sha256, metadata.artifact.sha256);
    assert.equal(catalogEntry?.artifact?.url, metadata.artifact.url);
  } else {
    assert.equal(catalogEntry?.artifact, undefined);
  }
  assert.equal(
    downloadCatalog.find(({recommended}) => recommended)?.version,
    dsl4RecommendedLegacyReleaseVersion,
  );
}
