import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {downloadableReleases} from '../download-catalog.mjs';
import {buildKamishibaiSb3, createKamishibaiSb3} from './build.mjs';

export {downloadableReleases};

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

function releaseSourceOptions(release, options) {
  return {
    ...options,
    buildDate: release.buildDate,
    faviconPath: path.join(projectRoot, release.faviconPath),
    sourceDirectory: path.join(projectRoot, release.sourceDirectory),
    version: release.version,
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertReleaseArtifact(release, bytes) {
  assert.equal(
    sha256(bytes),
    release.sha256,
    `${release.version} SB3 differs from the immutable release artifact ${release.sha256}.`,
  );
}

export async function createDownloadableReleaseSb3(release, options = {}) {
  const result = await createKamishibaiSb3(releaseSourceOptions(release, options));
  assertReleaseArtifact(release, result.archive);
  return result;
}

export async function buildDownloadableReleaseSb3(release, options = {}) {
  const result = await buildKamishibaiSb3({
    ...releaseSourceOptions(release, options),
    yes: true,
  });
  assertReleaseArtifact(release, await readFile(result.outputPath));
  return result;
}
