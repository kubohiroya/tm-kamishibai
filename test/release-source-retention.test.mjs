import assert from 'node:assert/strict';
import {access, readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {downloadCatalog} from '../scripts/download-catalog.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

test('keeps release source snapshots and the legacy app out of the current repository', async () => {
  for (const directory of ['app', 'release-sources']) {
    await assert.rejects(
      access(path.join(repositoryRoot, directory)),
      (error) => error.code === 'ENOENT',
    );
  }
  for (const entry of downloadCatalog.filter(({artifact}) => artifact)) {
    assert.match(
      entry.artifact.url,
      new RegExp(`/releases/download/v${entry.version.replaceAll('.', '\\.')}/`, 'u'),
    );
    assert.equal(Object.hasOwn(entry.artifact, 'sourceDirectory'), false);
  }
  for (const version of ['4.0.0-rc.6', '4.0.0-rc.7']) {
    const metadata = JSON.parse(
      await readFile(path.join(repositoryRoot, `release-metadata/${version}.json`), 'utf8'),
    );
    assert.equal(Object.hasOwn(metadata, 'sourceDirectory'), false);
  }
});
