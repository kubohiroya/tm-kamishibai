import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {parseCliArguments, runCli} from '../src/builder/cli.js';
import {
  convertDsl32File,
  convertDsl32ToDsl4,
  Dsl32ConversionError,
} from '../src/converter/index.js';
import {createDsl4SourceFrontend} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = path.join(projectRoot, 'test', 'fixtures', 'converter');
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const poseModels = JSON.parse(await readFile(path.join(fixtureRoot, 'pose-models.json'), 'utf8'));

test('converts the complete DSL 3.2 fixture into deterministic schema-valid DSL 4.0 YAML', async () => {
  const [source, expected] = await Promise.all([
    readFile(path.join(fixtureRoot, 'full.dsl32.txt')),
    readFile(path.join(fixtureRoot, 'full.kamishibai.yaml'), 'utf8'),
  ]);

  const first = convertDsl32ToDsl4(source, {sourceId: 'full.dsl32.txt', poseModels});
  const second = convertDsl32ToDsl4(source, {sourceId: 'full.dsl32.txt', poseModels});

  assert.equal(first.ok, true);
  assert.equal(first.yaml, expected);
  assert.equal(second.yaml, expected);
  assert.equal(first.source.startsWith('\uFEFF'), false);
  assert.equal(first.source.includes('\r'), false);
  assert.deepEqual(
    first.diagnostics.map((diagnostic) => diagnostic.range.start.line),
    [2, 3, 10, 11, 12, 13, 45],
  );
  assert.ok(first.diagnostics.some((diagnostic) => diagnostic.code === 'K4-CONVERT-VARIABLE-TYPE'));
  assert.ok(
    first.diagnostics.some((diagnostic) => diagnostic.code === 'K4-CONVERT-COSTUME-RETARGETED'),
  );
  const validated = frontend.parse(first.yaml, {sourceId: 'full.kamishibai.yaml'});
  assert.equal(validated.ok, true);
  assert.deepEqual(validated.diagnostics, []);
  assert.deepEqual(first.document?.variables, {
    score: 1,
    takeSeaRoute: false,
    playerName: 'ななし',
  });
  assert.deepEqual(first.document?.scenes.rescue.actions[2]['Hero.pose'].steps, [
    {pose: 'help', skin: 'HeroHelp', sound: 'Success'},
    {pose: 'jump', skin: 'HeroHappy', sound: 'Success'},
  ]);
  assert.equal(first.yaml.includes('poseInputToChangeScene'), false);
});

test('canonicalizes BOM and legacy newlines before recording source positions', () => {
  const result = convertDsl32ToDsl4(
    Buffer.from('\uFEFFkamishibai=3.2\r\nsceneLabel=opening\raction=wait:1\r\n'),
    {sourceId: 'legacy.txt'},
  );

  assert.equal(result.ok, true);
  assert.equal(result.source, 'kamishibai=3.2\nsceneLabel=opening\naction=wait:1\n');
  assert.deepEqual(result.diagnostics, []);

  const invalidUtf8 = convertDsl32ToDsl4(Buffer.from([0xff]), {sourceId: 'invalid.txt'});
  assert.equal(invalidUtf8.ok, false);
  assert.equal(invalidUtf8.diagnostics[0].code, 'K4-CONVERT-UTF8-001');
});

test('reports an empty pose step at the original line and returns no partial YAML', async () => {
  const source = await readFile(path.join(fixtureRoot, 'invalid-pose.dsl32.txt'));
  const result = convertDsl32ToDsl4(source, {sourceId: 'invalid-pose.dsl32.txt'});

  assert.equal(result.ok, false);
  assert.equal(result.document, null);
  assert.equal(result.yaml, null);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'K4-CONVERT-POSE-STEPS' &&
        diagnostic.range.start.line === 6 &&
        diagnostic.command === 'action',
    ),
  );
});

test('converts Actor.pose as ordered steps and preserves optional skin and sound slots', () => {
  const result = convertDsl32ToDsl4(
    [
      'kamishibai=3.2',
      'asset=Hero,costume',
      'asset=Success,sound',
      'actor=Hero,Hero',
      'sceneLabel=rescue',
      'TMPoseURL=https://example.com/models/rescue/',
      'action=Hero:pose:Hero,:help,jump:Success',
    ].join('\n'),
    {sourceId: 'optional-pose.txt', poseModels},
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.document?.scenes.rescue.actions[0]['Hero.pose'].steps, [
    {pose: 'help', skin: 'Hero', sound: 'Success'},
    {pose: 'jump'},
  ]);
});

test('requires an explicit local replacement for each scene TMPoseURL', async () => {
  const source = await readFile(path.join(fixtureRoot, 'full.dsl32.txt'));
  const missing = convertDsl32ToDsl4(source, {sourceId: 'full.dsl32.txt'});
  assert.equal(missing.ok, false);
  assert.equal(missing.yaml, null);
  assert.ok(
    missing.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'K4-CONVERT-POSE-MODEL' && diagnostic.range.start.line === 36,
    ),
  );

  const malformed = convertDsl32ToDsl4(source, {
    sourceId: 'full.dsl32.txt',
    poseModels: {
      'https://example.com/models/rescue/': {
        id: 'RescuePose',
        file: '../outside',
      },
    },
  });
  assert.equal(malformed.ok, false);
  assert.ok(
    malformed.diagnostics.some((diagnostic) => diagnostic.code === 'K4-CONVERT-POSE-MODEL-MAP'),
  );
});

test('does not silently drop legacy Text Assets or unsupported DSL 3.2 actions', () => {
  const result = convertDsl32ToDsl4(
    [
      'kamishibai=3.2',
      'asset=Title,backdrop',
      'asset=Narration,text',
      'actor=Hero,Narration',
      'sceneLabel=opening',
      'action=Hero:hide',
    ].join('\n'),
    {sourceId: 'legacy.txt'},
  );

  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'K4-CONVERT-LEGACY-TEXT' && diagnostic.range.start.line === 3,
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'K4-CONVERT-ACTION-UNSUPPORTED' && diagnostic.range.start.line === 6,
    ),
  );
});

test('installs one converted file atomically and preserves the prior output on conversion errors', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tmpose-converter-'));
  context.after(() => rm(directory, {recursive: true, force: true}));
  const inputPath = path.join(directory, 'source.txt');
  const outputPath = path.join(directory, 'story.kamishibai.yaml');
  const validSource = 'kamishibai=3.2\nsceneLabel=opening\naction=wait:1\n';
  await Promise.all([
    writeFile(inputPath, validSource),
    writeFile(outputPath, 'previous output\n'),
  ]);

  const converted = await convertDsl32File({inputPath, outputPath});
  assert.equal(converted.ok, true);
  assert.equal(converted.outputPath, outputPath);
  assert.equal(await readFile(inputPath, 'utf8'), validSource);
  const installed = await readFile(outputPath, 'utf8');
  assert.equal(installed, converted.yaml);

  await writeFile(
    inputPath,
    await readFile(path.join(fixtureRoot, 'invalid-pose.dsl32.txt'), 'utf8'),
  );
  const rejected = await convertDsl32File({inputPath, outputPath});
  assert.equal(rejected.ok, false);
  assert.equal(rejected.outputPath, null);
  assert.equal(await readFile(outputPath, 'utf8'), installed);

  const samePath = await convertDsl32File({inputPath: outputPath, outputPath});
  assert.equal(samePath.ok, false);
  assert.equal(samePath.diagnostics[0].code, 'K4-CONVERT-OUTPUT-SOURCE');
  assert.equal(await readFile(outputPath, 'utf8'), installed);
});

test('exposes convert-dsl4 through the installable CLI contract', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tmpose-converter-cli-'));
  context.after(() => rm(directory, {recursive: true, force: true}));
  const inputPath = path.join(fixtureRoot, 'full.dsl32.txt');
  const outputPath = path.join(directory, 'story.kamishibai.yaml');
  const poseModelMapPath = path.join(fixtureRoot, 'pose-models.json');
  const parsed = parseCliArguments([
    'convert-dsl4',
    '--input',
    inputPath,
    '--output',
    outputPath,
    '--pose-models',
    poseModelMapPath,
  ]);
  assert.deepEqual(parsed, {
    action: 'convert',
    options: {inputPath, outputPath, poseModelMapPath},
  });
  assert.throws(
    () => parseCliArguments(['convert-dsl4', '--input', inputPath]),
    /Missing required option: --output/u,
  );

  let stdout = '';
  let stderr = '';
  const result = await runCli(
    [
      'convert-dsl4',
      '--input',
      inputPath,
      '--output',
      outputPath,
      '--pose-models',
      poseModelMapPath,
    ],
    {
      stdout: {write: (chunk) => (stdout += chunk)},
      stderr: {write: (chunk) => (stderr += chunk)},
    },
  );
  assert.equal(result?.ok, true);
  assert.match(stdout, /Converted .*story\.kamishibai\.yaml/u);
  assert.match(stderr, /full\.dsl32\.txt:2:1: warning \[K4-CONVERT-VARIABLE-TYPE\]/u);
  const validated = frontend.parse(await readFile(outputPath, 'utf8'), {
    sourceId: outputPath,
  });
  assert.equal(validated.ok, true);
  assert.deepEqual(validated.diagnostics, []);

  const invalidPath = path.join(fixtureRoot, 'invalid-pose.dsl32.txt');
  await assert.rejects(
    runCli(['convert-dsl4', '--input', invalidPath, '--output', outputPath], {
      stdout: {write: () => true},
      stderr: {write: () => true},
    }),
    (error) => error instanceof Dsl32ConversionError && error.reported,
  );
});
