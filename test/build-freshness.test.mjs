import assert from 'node:assert/strict';
import {mkdtemp, rm, utimes, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {outputsAreUpToDate} from '../scripts/build-freshness.mjs';

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tmpose-build-freshness-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

test('treats outputs as current only when every output is at least as new as every input', async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = path.join(directory, 'input.md');
    const htmlPath = path.join(directory, 'output.html');
    const pdfPath = path.join(directory, 'output.pdf');
    await Promise.all([
      writeFile(inputPath, 'source'),
      writeFile(htmlPath, 'html'),
      writeFile(pdfPath, 'pdf'),
    ]);

    const oldTime = new Date('2026-01-01T00:00:00Z');
    const newTime = new Date('2026-01-02T00:00:00Z');
    await utimes(inputPath, oldTime, oldTime);
    await utimes(htmlPath, newTime, newTime);
    await utimes(pdfPath, newTime, newTime);

    assert.equal(await outputsAreUpToDate([inputPath], [htmlPath, pdfPath]), true);

    await utimes(inputPath, newTime, newTime);
    await utimes(htmlPath, oldTime, oldTime);
    assert.equal(await outputsAreUpToDate([inputPath], [htmlPath, pdfPath]), false);
  });
});

test('forces rebuilding and rebuilds when an input or output is missing', async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = path.join(directory, 'input.md');
    const outputPath = path.join(directory, 'output.html');
    await writeFile(inputPath, 'source');

    assert.equal(await outputsAreUpToDate([inputPath], [outputPath]), false);

    await writeFile(outputPath, 'html');
    assert.equal(await outputsAreUpToDate([inputPath], [outputPath], {force: true}), false);
  });
});
