import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {createKamishibaiSb3} from '../scripts/sb3/build.mjs';
import {createDsl4ReleaseSourceFiles} from '../scripts/sb3/dsl4-downloadable-release.mjs';
import {
  readTitleBuildMetadataFromSb3,
  resolveTitleBuildMetadata,
  titleBuildDateEnvironmentVariable,
} from '../scripts/sb3/title-build-metadata.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

test('resolves the Title build date in Asia/Tokyo and accepts a reproducible override', () => {
  assert.deepEqual(
    resolveTitleBuildMetadata({
      environment: {},
      now: new Date('2026-07-30T15:01:00.000Z'),
      version: '7.8.9',
    }),
    {
      buildDate: '2026-07-31',
      label: 'Version 7.8.9 (2026/07/31)',
      version: '7.8.9',
    },
  );
  assert.equal(
    resolveTitleBuildMetadata({
      environment: {[titleBuildDateEnvironmentVariable]: '2026-07-19'},
      now: new Date('2026-07-31T00:00:00.000Z'),
      version: '7.8.9',
    }).label,
    'Version 7.8.9 (2026/07/19)',
  );
  assert.throws(
    () =>
      resolveTitleBuildMetadata({
        environment: {[titleBuildDateEnvironmentVariable]: '2026-02-29'},
        version: '7.8.9',
      }),
    /not a valid calendar date/u,
  );
});

test('stamps the transient current DSL 4 release source without a tracked app directory', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'tmpose-title-metadata-'));
  const sourceDirectory = path.join(temporaryRoot, 'source');
  try {
    for (const [relativePath, contents] of await createDsl4ReleaseSourceFiles()) {
      const outputPath = path.join(sourceDirectory, relativePath);
      await mkdir(path.dirname(outputPath), {recursive: true});
      await writeFile(outputPath, contents);
    }
    const built = await createKamishibaiSb3({
      buildDate: '2026-08-15',
      faviconPath: path.join(projectRoot, 'site/favicon.png'),
      packageJsonPath: path.join(projectRoot, 'package.json'),
      sourceDirectory,
      version: '4.0.0-rc.7',
    });
    assert.deepEqual(readTitleBuildMetadataFromSb3(built.archive), {
      buildDate: '2026-08-15',
      label: 'Version 4.0.0-rc.7 (2026/08/15)',
      version: '4.0.0-rc.7',
    });
  } finally {
    await rm(temporaryRoot, {recursive: true, force: true});
  }
});
