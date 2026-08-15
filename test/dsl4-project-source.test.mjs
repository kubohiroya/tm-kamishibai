import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {resolveDsl4ProjectSource} from '../src/builder/dsl4-project-source.js';
import {Sb3BuilderError} from '../src/builder/errors.js';

async function withProject(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'dsl4-project-source-'));
  try {
    return await callback(projectRoot);
  } finally {
    await rm(projectRoot, {recursive: true, force: true});
  }
}

test('discovers one .k4.yml without creating a manifest and applies defaults', async () => {
  await withProject(async (projectRoot) => {
    await writeFile(path.join(projectRoot, 'opening.k4.yml'), "kamishibai: '4.0'\nscenes: {}\n");
    const resolved = await resolveDsl4ProjectSource({projectRoot});
    assert.deepEqual(resolved, {
      manifest: {
        formatVersion: 1,
        mode: 'external',
        sourceId: 'main',
        path: 'opening.k4.yml',
      },
      manifestPath: null,
      manifestFilename: null,
      manifestExists: false,
    });
  });
});

test('fails for zero or multiple candidates unless CLI selects one', async () => {
  await withProject(async (projectRoot) => {
    await assert.rejects(
      resolveDsl4ProjectSource({projectRoot}),
      (error) => error instanceof Sb3BuilderError && error.code === 'K4-SOURCE-MISSING',
    );
    await Promise.all([
      writeFile(path.join(projectRoot, 'opening.k4.yml'), ''),
      writeFile(path.join(projectRoot, 'ending.k4.yml'), ''),
    ]);
    await assert.rejects(
      resolveDsl4ProjectSource({projectRoot}),
      (error) => error instanceof Sb3BuilderError && error.code === 'K4-SOURCE-AMBIGUOUS',
    );
    const selected = await resolveDsl4ProjectSource({
      projectRoot,
      source: 'ending.k4.yml',
      sourceId: 'ending',
    });
    assert.equal(selected.manifest.path, 'ending.k4.yml');
    assert.equal(selected.manifest.sourceId, 'ending');
    assert.equal(selected.manifestExists, false);
  });
});

test('accepts an empty manifest and lets CLI override its selected source', async () => {
  await withProject(async (projectRoot) => {
    const manifestPath = path.join(projectRoot, 'project.source.yml');
    await Promise.all([
      writeFile(path.join(projectRoot, 'opening.k4.yml'), ''),
      writeFile(path.join(projectRoot, 'ending.k4.yml'), ''),
      writeFile(manifestPath, 'path: opening.k4.yml\nsourceId: manifest\n'),
    ]);
    const fromManifest = await resolveDsl4ProjectSource({projectRoot});
    assert.equal(fromManifest.manifest.path, 'opening.k4.yml');
    assert.equal(fromManifest.manifest.sourceId, 'manifest');
    assert.equal(fromManifest.manifestPath, await realpath(manifestPath));

    const overridden = await resolveDsl4ProjectSource({
      projectRoot,
      source: 'ending.k4.yml',
      sourceId: 'cli',
    });
    assert.equal(overridden.manifest.path, 'ending.k4.yml');
    assert.equal(overridden.manifest.sourceId, 'cli');

    await writeFile(manifestPath, '# defaults only\n');
    await assert.rejects(
      resolveDsl4ProjectSource({projectRoot}),
      (error) => error instanceof Sb3BuilderError && error.code === 'K4-SOURCE-AMBIGUOUS',
    );
  });
});
