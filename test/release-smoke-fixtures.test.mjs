import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {strFromU8, unzipSync} from 'fflate';

import {buildReleaseSmokeFixtures} from '../scripts/build-release-smoke-fixtures.mjs';

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tmpose-release-smoke-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

function readStage(bytes) {
  const archive = unzipSync(new Uint8Array(bytes));
  const project = JSON.parse(strFromU8(archive['project.json']));
  return project.targets.find((target) => target.isStage);
}

test('builds reproducible release smoke fixtures with detailed diagnostics on and off', async () => {
  await withTemporaryDirectory(async (directory) => {
    const firstDirectory = path.join(directory, 'first');
    const secondDirectory = path.join(directory, 'second');
    const first = await buildReleaseSmokeFixtures({outputDirectory: firstDirectory});
    await buildReleaseSmokeFixtures({outputDirectory: secondDirectory});

    assert.equal(first.manifest.formatVersion, 1);
    assert.equal(first.manifest.base.path, 'dist/downloads/kamishibai.sb3');
    assert.equal(first.fixtures.length, 2);
    for (const fixture of first.fixtures) {
      const firstBytes = await readFile(path.join(firstDirectory, fixture.filename));
      const secondBytes = await readFile(path.join(secondDirectory, fixture.filename));
      const stage = readStage(firstBytes);
      assert.deepEqual(firstBytes, secondBytes);
      assert.equal(stage.variables.tmposeEmbeddedScript[1], 'kamishibai=4.0\n');
      assert.equal(stage.variables.featureDetailedScriptErrors[1], fixture.detailedErrors);
    }
  });
});
