import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {downloadableReleases} from '../download-catalog.mjs';
import {readTitleBuildMetadataFromSb3} from './title-build-metadata.mjs';

export {downloadableReleases};

const releaseAssetPath =
  /^\/kubohiroya\/tmpose-kamishibai\/releases\/download\/v[^/]+\/[^/]+\.sb3$/u;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertImmutableReleaseUrl(release) {
  const url = new URL(release.url);
  assert.equal(url.protocol, 'https:', `${release.version} release URL must use HTTPS.`);
  assert.equal(
    url.hostname,
    'github.com',
    `${release.version} release URL must use GitHub Releases.`,
  );
  assert.match(url.pathname, releaseAssetPath, `${release.version} release URL is invalid.`);
  assert.equal(
    decodeURIComponent(path.posix.basename(url.pathname)),
    release.filename,
    `${release.version} release URL filename differs from the catalog.`,
  );
  assert(
    url.pathname.includes(`/download/v${release.version}/`),
    `${release.version} release URL must use its exact version tag.`,
  );
  return url.href;
}

async function readBoundedResponse(response, maximumBytes) {
  const declaredLength = response.headers?.get?.('content-length');
  if (declaredLength !== null && declaredLength !== undefined) {
    assert.equal(
      Number(declaredLength),
      maximumBytes,
      `Release asset Content-Length differs from the catalog: ${declaredLength}.`,
    );
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(bytes.byteLength <= maximumBytes, 'Release asset exceeds its catalog size.');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    assert(byteLength <= maximumBytes, 'Release asset exceeds its catalog size.');
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, byteLength);
}

export async function createDownloadableReleaseSb3(release, {fetchImpl = globalThis.fetch} = {}) {
  assert.equal(typeof fetchImpl, 'function', 'A fetch implementation is required.');
  const url = assertImmutableReleaseUrl(release);
  const response = await fetchImpl(url, {
    headers: {accept: 'application/octet-stream'},
    redirect: 'follow',
  });
  assert(
    response.ok,
    `Cannot download ${release.version} from GitHub Releases: HTTP ${response.status}.`,
  );
  const archive = await readBoundedResponse(response, release.size);
  assert.equal(
    archive.byteLength,
    release.size,
    `${release.version} release asset size is invalid.`,
  );
  assert.equal(
    sha256(archive),
    release.sha256,
    `${release.version} release asset SHA-256 is invalid.`,
  );
  assert.equal(archive.subarray(0, 2).toString(), 'PK', `${release.version} is not an SB3 ZIP.`);
  return {
    archive,
    titleBuildMetadata: readTitleBuildMetadataFromSb3(archive),
  };
}

export async function buildDownloadableReleaseSb3(release, options = {}) {
  assert.equal(typeof options.outputPath, 'string', 'The release output path is required.');
  const result = await createDownloadableReleaseSb3(release, options);
  await mkdir(path.dirname(options.outputPath), {recursive: true});
  const temporaryPath = `${options.outputPath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, result.archive);
    await rename(temporaryPath, options.outputPath);
  } catch (error) {
    await rm(temporaryPath, {force: true});
    throw error;
  }
  return {...result, changed: true, outputPath: options.outputPath};
}
