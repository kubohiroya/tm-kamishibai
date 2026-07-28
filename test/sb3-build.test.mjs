import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {strFromU8, strToU8, unzipSync} from 'fflate';

import {buildSb3, parseBuildArguments} from '../scripts/sb3/build.mjs';
import {parseCheckArguments} from '../scripts/sb3/check.mjs';
import {importSb3} from '../scripts/sb3/import.mjs';
import {compareDirectories} from '../scripts/sb3/output-safety.mjs';
import {createDeterministicSb3, validateSb3Source} from '../scripts/sb3/source.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const currentSourceDirectory = path.join(projectRoot, 'app');

async function withTemporaryDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tmpose-sb3-build-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeMinimalSource(sourceDirectory) {
  const assetsDirectory = path.join(sourceDirectory, 'assets');
  const extensionsDirectory = path.join(sourceDirectory, 'extensions');
  await mkdir(assetsDirectory, {recursive: true});
  await mkdir(extensionsDirectory, {recursive: true});
  const assetContents = strToU8('<svg>asset</svg>');
  const assetId = createHash('md5').update(assetContents).digest('hex');
  const assetFilename = `${assetId}.svg`;
  await writeFile(path.join(assetsDirectory, assetFilename), assetContents);
  await writeFile(
    path.join(extensionsDirectory, 'custom.js'),
    'Scratch.extensions.register(new Custom());\n',
  );
  await writeJson(path.join(sourceDirectory, 'project.source.json'), {
    targets: [{
      isStage: true,
      name: 'Stage',
      costumes: [{
        name: 'asset',
        assetId,
        dataFormat: 'svg',
        md5ext: assetFilename,
      }],
      sounds: [],
    }],
    extensionURLs: {
      custom: 'embedded-extension:extensions/custom.js',
      external: 'https://extensions.turbowarp.org/text.js',
    },
    meta: {semver: '3.0.0'},
  });
  await writeJson(path.join(sourceDirectory, 'embedded-extensions.json'), {
    formatVersion: 1,
    extensions: [{
      id: 'custom',
      path: 'extensions/custom.js',
      mediaType: 'text/javascript',
      parameters: [],
      encoding: 'base64',
    }],
  });
  await writeJson(path.join(sourceDirectory, 'sb3-source.json'), {
    formatVersion: 1,
    project: 'project.source.json',
    embeddedExtensions: 'embedded-extensions.json',
    assetsDirectory: 'assets',
    archiveEntries: ['project.json', assetFilename],
  });
  return {assetFilename};
}

function readCentralDirectory(archive) {
  const bytes = Buffer.from(archive);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  assert.notEqual(endOffset, -1, 'ZIP end-of-central-directory record is missing');
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  let offset = bytes.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const fileNameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    entries.push({
      date: bytes.readUInt16LE(offset + 14),
      name: bytes.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8'),
      time: bytes.readUInt16LE(offset + 12),
    });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

test('validates the current source and builds bit-for-bit deterministic SB3 archives', async () => {
  const validated = await validateSb3Source(currentSourceDirectory);
  assert.equal(validated.assetContents.size, 7);
  assert.equal(validated.assetReferenceCount, 11);
  assert.equal(validated.extensions.length, 5);

  const [first, second] = await Promise.all([
    createDeterministicSb3(currentSourceDirectory),
    createDeterministicSb3(currentSourceDirectory),
  ]);
  assert.deepEqual(Buffer.from(first.archive), Buffer.from(second.archive));
  const centralEntries = readCentralDirectory(first.archive);
  assert.deepEqual(
    centralEntries.map((entry) => entry.name),
    validated.sourceManifest.archiveEntries,
  );
  assert.equal(centralEntries.every((entry) => entry.time === 0 && entry.date === 33), true);

  const archive = unzipSync(first.archive);
  const project = JSON.parse(strFromU8(archive['project.json']));
  assert.match(project.extensionURLs.twAssetManager, /^data:text\/javascript;base64,/u);
  assert.equal(project.extensionURLs.text, 'https://extensions.turbowarp.org/lab/text.js');
});

test('build leaves identical output untouched and round-trips without source differences', async () => {
  await withTemporaryDirectory(async (directory) => {
    const outputPath = path.join(directory, 'kamishibai.sb3');
    const roundTripDirectory = path.join(directory, 'round-trip');
    const first = await buildSb3({sourceDirectory: currentSourceDirectory, outputPath});
    const second = await buildSb3({sourceDirectory: currentSourceDirectory, outputPath});
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);

    await importSb3({inputPath: outputPath, outputDirectory: roundTripDirectory});
    const comparison = await compareDirectories(currentSourceDirectory, roundTripDirectory);
    assert.equal(comparison.identical, true);
    assert.deepEqual(comparison.differences, {added: [], modified: [], removed: []});
  });
});

test('build preserves differing output unless replacement is explicitly authorized', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const outputPath = path.join(directory, 'kamishibai.sb3');
    await writeMinimalSource(sourceDirectory);
    await writeFile(outputPath, 'existing output');

    await assert.rejects(
      buildSb3({sourceDirectory, outputPath}),
      /Non-interactive replacement requires --yes/u,
    );
    assert.equal(await readFile(outputPath, 'utf8'), 'existing output');

    await assert.rejects(
      buildSb3({
        sourceDirectory,
        outputPath,
        confirmReplace: async () => {
          await writeFile(outputPath, 'changed during confirmation');
          return true;
        },
      }),
      /changed while the build was running/u,
    );
    assert.equal(await readFile(outputPath, 'utf8'), 'changed during confirmation');

    const result = await buildSb3({sourceDirectory, outputPath, yes: true});
    assert.equal(result.changed, true);
    assert.ok(unzipSync(await readFile(outputPath))['project.json']);
  });
});

test('build stops when an interrupted rollback file exists', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const outputPath = path.join(directory, 'kamishibai.sb3');
    const rollbackPath = path.join(directory, '.kamishibai.sb3.rollback-interrupted');
    await writeMinimalSource(sourceDirectory);
    await buildSb3({sourceDirectory, outputPath});
    await writeFile(rollbackPath, 'previous output');

    await assert.rejects(
      buildSb3({sourceDirectory, outputPath}),
      /interrupted SB3 build rollback file/u,
    );
  });
});

test('rejects duplicate archive entries and extra asset files', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const {assetFilename} = await writeMinimalSource(sourceDirectory);
    const manifestPath = path.join(sourceDirectory, 'sb3-source.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.archiveEntries.push(assetFilename);
    await writeJson(manifestPath, manifest);
    await assert.rejects(validateSb3Source(sourceDirectory), /Duplicate archive entry/u);

    manifest.archiveEntries.pop();
    await writeJson(manifestPath, manifest);
    await writeFile(path.join(sourceDirectory, 'assets/extra.svg'), '<svg/>');
    await assert.rejects(validateSb3Source(sourceDirectory), /Extra: extra.svg/u);
  });
});

test('rejects asset content hash and embedded extension mapping mismatches', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const {assetFilename} = await writeMinimalSource(sourceDirectory);
    await writeFile(path.join(sourceDirectory, 'assets', assetFilename), '<svg>changed</svg>');
    await assert.rejects(validateSb3Source(sourceDirectory), /Asset content hash mismatch/u);

    await writeMinimalSource(sourceDirectory);
    const projectPath = path.join(sourceDirectory, 'project.source.json');
    const project = JSON.parse(await readFile(projectPath, 'utf8'));
    project.extensionURLs.custom = 'embedded-extension:extensions/other.js';
    await writeJson(projectPath, project);
    await assert.rejects(validateSb3Source(sourceDirectory), /mapping does not match/u);
  });
});

test('parses build and check CLI options', () => {
  assert.deepEqual(parseBuildArguments(['--help']), {help: true});
  assert.deepEqual(
    parseBuildArguments(['--source', 'custom-source', '--yes']),
    {help: false, sourceDirectory: path.resolve('custom-source'), yes: true},
  );
  assert.throws(() => parseBuildArguments(['--source']), /requires a directory/u);
  assert.deepEqual(parseCheckArguments(['--help']), {help: true});
  assert.deepEqual(
    parseCheckArguments(['--source', 'custom-source']),
    {help: false, sourceDirectory: path.resolve('custom-source')},
  );
});
