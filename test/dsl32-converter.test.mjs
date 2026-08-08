import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {strToU8, zipSync} from 'fflate';

import {embedDsl4SourceInSb3} from '../src/builder/index.js';
import {parseCliArguments, runCli} from '../src/builder/cli.js';
import {
  convertDsl32File,
  convertDsl32ToDsl4,
  Dsl32ConversionError,
} from '../src/converter/index.js';
import {createDsl4EmbeddedSourceDescriptor, createDsl4SourceFrontend} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = path.join(projectRoot, 'test', 'fixtures', 'converter');
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const poseModels = JSON.parse(await readFile(path.join(fixtureRoot, 'pose-models.json'), 'utf8'));
const subtleCrypto = webcrypto.subtle;

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

test('preserves literal asset, Scratch source, and scene names without generated aliases', () => {
  const assetId = 'Backdrop ./%\u0001 x';
  const sourceName = 'Scratch.name/\u0002 x';
  const sceneId = 'Opening ./%\u0003 x';
  const result = convertDsl32ToDsl4(
    [
      'kamishibai=3.2',
      `asset=${assetId},backdrop:${sourceName}`,
      `sceneLabel=${sceneId}`,
      `action=stage:${assetId}`,
    ].join('\n'),
    {sourceId: 'literal-names.txt'},
  );

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(Object.keys(result.document.assets), [assetId]);
  assert.deepEqual(result.document.assets[assetId], {kind: 'backdrop', name: sourceName});
  assert.deepEqual(Object.keys(result.document.scenes), [sceneId]);
  assert.equal(result.document.scenes[sceneId][0].stage, assetId);
  assert.match(result.yaml, /\\x01|\\u0001/u);
  assert.match(result.yaml, /\\x02|\\u0002/u);
  assert.match(result.yaml, /\\x03|\\u0003/u);

  const validated = frontend.parse(result.yaml, {sourceId: 'literal-names.k4.yml'});
  assert.equal(validated.ok, true, JSON.stringify(validated.diagnostics));
  assert.equal(validated.storyDocument.assets[assetId].name, sourceName);
  assert.equal(validated.storyDocument.scenes[0].id, sceneId);
});

test('converts DSL 3.1 through the maintained compatibility grammar with an explicit warning', async () => {
  const [source, expected] = await Promise.all([
    readFile(path.join(fixtureRoot, 'full.dsl32.txt'), 'utf8'),
    readFile(path.join(fixtureRoot, 'full.kamishibai.yaml'), 'utf8'),
  ]);
  const result = convertDsl32ToDsl4(source.replace('kamishibai=3.2', 'kamishibai=3.1'), {
    sourceId: 'full.dsl31.txt',
    poseModels,
  });

  assert.equal(result.ok, true);
  assert.equal(result.yaml, expected);
  assert.deepEqual(
    result.diagnostics.filter(({code}) => code === 'K4-CONVERT-VERSION-31-COMPAT'),
    [
      {
        code: 'K4-CONVERT-VERSION-31-COMPAT',
        severity: 'warning',
        message:
          'DSL 3.1 is interpreted through the maintained DSL 3.2 compatibility grammar; review every conversion warning before replacing the original work.',
        sourceId: 'full.dsl31.txt',
        range: {
          start: {line: 1, column: 1},
          end: {line: 1, column: 15},
        },
        command: 'kamishibai',
      },
    ],
  );
});

test('rejects versions outside the maintained DSL 3.1 and 3.2 migration inputs', () => {
  for (const version of ['3.0', '4.0']) {
    const result = convertDsl32ToDsl4(
      `kamishibai=${version}\nsceneLabel=opening\naction=wait:1\n`,
      {sourceId: `unsupported-${version}.txt`},
    );
    assert.equal(result.ok, false);
    assert.ok(
      result.diagnostics.some(
        ({code, severity, range}) =>
          code === 'K4-CONVERT-VERSION-001' && severity === 'error' && range.start.line === 1,
      ),
    );
  }
});

test('embeds converted source without adding a Scratch block to the project fixture', async () => {
  const [source, baseProject] = await Promise.all([
    readFile(path.join(fixtureRoot, 'full.dsl32.txt')),
    readFile(path.join(fixtureRoot, 'block-zero-project.json'), 'utf8').then((text) =>
      JSON.parse(text),
    ),
  ]);
  const converted = convertDsl32ToDsl4(source, {sourceId: 'full.dsl32.txt', poseModels});
  assert.equal(converted.ok, true);
  const maxSourceBytes = 64 * 1024;
  const descriptor = await createDsl4EmbeddedSourceDescriptor(converted.yaml, {
    sourceId: 'converted',
    displayName: 'converted.kamishibai.yaml',
    maxSourceBytes,
    subtleCrypto,
  });
  const beforeBlocks = baseProject.targets.map(({blocks}) => structuredClone(blocks));
  const baseSb3 = Buffer.from(
    zipSync({'project.json': strToU8(`${JSON.stringify(baseProject)}\n`)}),
  );

  const embedded = await embedDsl4SourceInSb3(baseSb3, descriptor, {
    channel: 'bundled',
    maxSourceBytes,
    subtleCrypto,
  });

  assert.deepEqual(
    embedded.project.targets.map(({blocks}) => blocks),
    beforeBlocks,
  );
  assert.equal(
    embedded.project.targets.reduce((count, {blocks}) => count + Object.keys(blocks).length, 0),
    beforeBlocks.reduce((count, blocks) => count + Object.keys(blocks).length, 0),
  );
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

test('treats a scene separator as the end of the current scene', () => {
  const result = convertDsl32ToDsl4(
    ['kamishibai=3.2', 'sceneLabel=opening', 'action=wait:1', '---', 'action=wait:2'].join('\n'),
    {sourceId: 'missing-scene-label.txt'},
  );

  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'K4-CONVERT-ACTION-SCENE' && diagnostic.range.start.line === 5,
    ),
  );
});

test('does not hoist scene-local variables or ignore a non-default start scene', () => {
  const sceneLocal = convertDsl32ToDsl4(
    ['kamishibai=3.2', 'sceneLabel=opening', 'setRuntimeVariable=score:1', 'action=wait:1'].join(
      '\n',
    ),
    {sourceId: 'scene-variable.txt'},
  );
  assert.equal(sceneLocal.ok, false);
  assert.ok(
    sceneLocal.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'K4-CONVERT-SCENE-VARIABLE' && diagnostic.range.start.line === 3,
    ),
  );

  const alternateStart = convertDsl32ToDsl4(
    [
      'kamishibai=3.2',
      'setRuntimeVariable=startSceneIndex:2',
      'sceneLabel=opening',
      'action=wait:1',
      'sceneLabel=ending',
      'action=wait:1',
    ].join('\n'),
    {sourceId: 'alternate-start.txt'},
  );
  assert.equal(alternateStart.ok, false);
  assert.ok(
    alternateStart.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'K4-CONVERT-START-SCENE' && diagnostic.range.start.line === 2,
    ),
  );
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

test('maps DSL 3.2 pose runtime tuning to elapsed-time sequence configuration', () => {
  const result = convertDsl32ToDsl4(
    [
      'kamishibai=3.2',
      'setRuntimeVariable=poseRecog:0.75',
      'setRuntimeVariable=poseCharge:20',
      'setRuntimeVariable=poseIdle:0',
      'asset=Hero,costume',
      'asset=Idle,sound',
      'asset=Charge,sound',
      'actor=Hero,Hero',
      'setPoseRecognitionSound=Idle,Charge',
      'sceneLabel=rescue',
      'TMPoseURL=https://example.com/models/rescue/',
      'action=Hero:pose:Hero:help:',
    ].join('\n'),
    {sourceId: 'pose-config.txt', poseModels},
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.document?.poseRecognition.sequence, {
    confidenceThreshold: 0.75,
    fullConfidenceHoldSeconds: 0.5,
    idleChargePerSecond: 0,
  });
  assert.equal(result.document?.variables.poseCharge, 20);

  const incompatible = convertDsl32ToDsl4(
    [
      'kamishibai=3.2',
      'setRuntimeVariable=poseIdle:1',
      'asset=Hero,costume',
      'actor=Hero,Hero',
      'sceneLabel=rescue',
      'TMPoseURL=https://example.com/models/rescue/',
      'action=Hero:pose:Hero:help:',
    ].join('\n'),
    {sourceId: 'pose-idle.txt', poseModels},
  );
  assert.equal(incompatible.ok, false);
  assert.ok(
    incompatible.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'K4-CONVERT-POSE-CONFIG' && diagnostic.range.start.line === 2,
    ),
  );
});

test('preserves TMPoseURL as a lazy remote pose model unless an embedded replacement is selected', async () => {
  const source = await readFile(path.join(fixtureRoot, 'full.dsl32.txt'));
  const remote = convertDsl32ToDsl4(source, {sourceId: 'full.dsl32.txt'});
  assert.equal(remote.ok, true, JSON.stringify(remote.diagnostics));
  assert.deepEqual(remote.document?.assets.PoseModel1, {
    kind: 'poseModel',
    delivery: 'remote',
    source: {url: 'https://example.com/models/rescue/'},
    loading: 'lazy',
  });
  assert.equal(remote.document?.scenes.rescue.poseModel, 'PoseModel1');

  const literalId = ' Rescue.pose/\u0001 model ';
  const embedded = convertDsl32ToDsl4(source, {
    sourceId: 'full.dsl32.txt',
    poseModels: {
      'https://example.com/models/rescue/': {
        id: literalId,
        file: 'pose-models/rescue',
      },
    },
  });
  assert.equal(embedded.ok, true, JSON.stringify(embedded.diagnostics));
  assert.equal(embedded.document?.scenes.rescue.poseModel, literalId);
  assert.equal(embedded.document?.assets[literalId].file, 'pose-models/rescue');

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
      'action=Hero:setScale:100',
    ].join('\n'),
    {sourceId: 'legacy.txt'},
  );

  assert.equal(result.ok, false);
  const legacyText = result.diagnostics.find(
    (diagnostic) =>
      diagnostic.code === 'K4-CONVERT-LEGACY-TEXT' && diagnostic.range.start.line === 3,
  );
  assert.equal(legacyText?.severity, 'error');
  assert.match(legacyText?.message ?? '', /textStyles and Actor\.setText/u);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'K4-CONVERT-ACTION-UNSUPPORTED' && diagnostic.range.start.line === 6,
    ),
  );
});

test('converts timed think and rejects persistent or styled legacy speech', () => {
  const timed = convertDsl32ToDsl4(
    [
      'kamishibai=3.2',
      'asset=HeroIdle,costume:Actor:hero-idle',
      'actor=Hero,HeroIdle',
      'sceneLabel=opening',
      'action=Hero:think:どうしよう\\n困った:2',
    ].join('\n'),
    {sourceId: 'timed-think.txt'},
  );
  assert.equal(timed.ok, true);
  assert.deepEqual(timed.document?.scenes.opening, [
    {'Hero.think': {text: 'どうしよう\n困った', seconds: 2}},
  ]);

  for (const [sourceId, action, code] of [
    ['persistent-think.txt', 'action=Hero:think:待って', 'K4-CONVERT-PERSISTENT-SPEECH'],
    ['styled-think.txt', 'action=Hero:think:待って:2:balloonStyle', 'K4-CONVERT-SPEECH-STYLE'],
  ]) {
    const result = convertDsl32ToDsl4(
      [
        'kamishibai=3.2',
        'asset=HeroIdle,costume:Actor:hero-idle',
        'actor=Hero,HeroIdle',
        'sceneLabel=opening',
        action,
      ].join('\n'),
      {sourceId},
    );
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === code));
  }
});

test('preserves the Urashima clear, scale, visibility, layer, loop, and diagonal style semantics', () => {
  const result = convertDsl32ToDsl4(
    [
      'kamishibai=3.2',
      'asset=Fish1,costume:Fish:fish-1',
      'asset=Fish2,costume:Fish:fish-2',
      'svgTextStyle=default:#ffffff:#575e75:Helvetica:100:left:up-right',
      'actor=Fish,Fish1',
      'sceneLabel=dragon castle',
      'action=Fish:say:',
      'action=Fish:setSkin:Fish2:45',
      'action=Fish:setLayer:back',
      'action=Fish:loop:Fish1,Fish2:0.3,0.3',
      'action=Fish:hide',
    ].join('\n'),
    {sourceId: 'urashima-actions.txt'},
  );

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.document?.textStyles.default.direction, 'up-right');
  assert.deepEqual(result.document?.scenes['dragon castle'], [
    {'Fish.say': {text: '', seconds: 0}},
    {'Fish.setSkin': {skin: 'Fish2', scale: 45}},
    {'Fish.setLayer': 'back'},
    {
      'Fish.loop': {
        steps: [
          {skin: 'Fish1', seconds: 0.3},
          {skin: 'Fish2', seconds: 0.3},
        ],
      },
    },
    {'Fish.hide': {}},
  ]);
  const validated = frontend.parse(result.yaml, {sourceId: 'urashima-actions.k4.yml'});
  assert.equal(validated.ok, true, JSON.stringify(validated.diagnostics));
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

  const invalidManifestPath = path.join(directory, 'invalid-pose-models.json');
  await writeFile(invalidManifestPath, '{');
  let manifestStderr = '';
  await assert.rejects(
    runCli(
      [
        'convert-dsl4',
        '--input',
        inputPath,
        '--output',
        outputPath,
        '--pose-models',
        invalidManifestPath,
      ],
      {
        stdout: {write: () => true},
        stderr: {write: (chunk) => (manifestStderr += chunk)},
      },
    ),
    (error) => error instanceof Dsl32ConversionError && error.reported,
  );
  assert.match(manifestStderr, new RegExp(`${invalidManifestPath}:1:1`, 'u'));
  assert.equal(manifestStderr.includes(`${inputPath}:1:1`), false);

  await writeFile(
    invalidManifestPath,
    JSON.stringify({
      'https://example.com/models/rescue/': {id: '', file: 'pose-models/rescue'},
    }),
  );
  manifestStderr = '';
  await assert.rejects(
    runCli(
      [
        'convert-dsl4',
        '--input',
        inputPath,
        '--output',
        outputPath,
        '--pose-models',
        invalidManifestPath,
      ],
      {
        stdout: {write: () => true},
        stderr: {write: (chunk) => (manifestStderr += chunk)},
      },
    ),
    (error) => error instanceof Dsl32ConversionError && error.reported,
  );
  assert.match(manifestStderr, new RegExp(`${invalidManifestPath}:1:1`, 'u'));
});
