import assert from 'node:assert/strict';
import {access, readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'vitest';
import {fileURLToPath} from 'node:url';

import {downloadCatalog} from '../scripts/download-catalog.ts';
import {thrown} from './helpers/thrown-error.ts';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

test('keeps release source snapshots and the legacy app out of the current repository', async () => {
  for (const directory of ['app', 'release-sources']) {
    await assert.rejects(
      access(path.join(repositoryRoot, directory)),
      (error) => thrown(error).code === 'ENOENT',
    );
  }
  for (const entry of downloadCatalog) {
    // Destructure rather than filter: a `.filter(({artifact}) => artifact)` does not narrow the
    // element type, so every read below would need its own check.
    const {artifact} = entry;
    if (!artifact) continue;
    assert.match(
      artifact.url,
      new RegExp(`/releases/download/v${entry.version.replaceAll('.', '\\.')}/`, 'u'),
    );
    assert.equal(Object.hasOwn(artifact, 'sourceDirectory'), false);
  }
  for (const version of ['4.0.0-rc.6', '4.0.0-rc.7', '4.0.0-rc.8', '4.0.0-rc.9']) {
    const metadata = JSON.parse(
      await readFile(path.join(repositoryRoot, `release-metadata/${version}.json`), 'utf8'),
    );
    assert.equal(Object.hasOwn(metadata, 'sourceDirectory'), false);
  }
});
