import assert from 'node:assert/strict';
import {test} from 'vitest';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {zipSync, strToU8} from 'fflate';
import {parse, stringify} from 'yaml';
import {createRuntimeExpressionComposition} from '@kubohiroya/turbowarp-runtime-expression/composition';
import contract from './fixtures/dsl4/narrative-control-contract.json' with {type: 'json'};
import {createDsl4TestProductionSourceFrontend} from './helpers/dsl4-test-frontend.ts';
import {createDsl4StructuredBlockSourceDeclaration} from '../src/dsl4/structured-block-source.js';
import {prepareDsl4EmbeddedBlockStoryProject} from '../src/dsl4/platform/embedded-block-story.js';
import {buildDsl4RuntimeComponent} from '../src/builder/dsl4-build.js';
import {authorDsl4BlockSourceSb3} from '../src/builder/dsl4-block-source-author.js';
import {readDsl4NarrativeRuntimeExtensionSource} from '../src/builder/dsl4-playback-runtime-source.js';
import {createDsl4RuntimeController} from '../src/dsl4/runtime-controller.js';

const frontend = createDsl4TestProductionSourceFrontend({narrativeControlEnabled: true});
const controls = {keymaps: {production: {Space: 'navigation.nextAction'}}};
const source = stringify({...parse(contract.threeVisits.source), controls});
const limits = {
  maxSourceBytes: 65536,
  maxAssetFiles: 10,
  maxAssetFileBytes: 65536,
  maxTotalAssetBytes: 65536,
};
const baseProject = {
  targets: [
    {
      name: 'Stage',
      isStage: true,
      blocks: {},
      variables: {},
      lists: {},
      broadcasts: {},
      costumes: [],
      sounds: [],
    },
  ],
  monitors: [],
  extensions: ['kubohiroyakamishibai4'],
  extensionURLs: {
    kubohiroyakamishibai4:
      'data:text/javascript;base64,' + Buffer.from('// old runner').toString('base64'),
  },
};
const baseBytes = zipSync({'project.json': strToU8(JSON.stringify(baseProject))});

test('embedded block diagnostics retain the actual nested reference and target for locate/highlight', async () => {
  const declarations = createDsl4StructuredBlockSourceDeclaration({
    source: parse(source),
    form: 'bundle',
    hatId: 'root',
  });
  const [id, reference] = Object.entries(declarations).find(([, block]) =>
    block.opcode.endsWith('_narrativeReference'),
  )!;
  reference.inputs.COLUMN = [1, [10, 'missing']];
  await assert.rejects(
    prepareDsl4EmbeddedBlockStoryProject(
      {targets: [{name: '物語', isStage: true, blocks: declarations}]},
      frontend,
      limits,
    ),
    (error: unknown) => {
      const diagnostic = error as Error & {code: string; targetName: string; blockId: string};
      assert.equal(diagnostic.code, 'K4-BLOCK-SOURCE-VALIDATION-001');
      assert.equal(diagnostic.targetName, '物語');
      assert.equal(diagnostic.blockId, id);
      return true;
    },
  );
});

test('authoring requires a capable runner and never silently combines narrative 4.0 with an old base', async () => {
  assert.throws(
    () => authorDsl4BlockSourceSb3({baseBytes, sourceText: source, sourceFrontend: frontend}),
    /matching development runner/,
  );
  const runtime = await readDsl4NarrativeRuntimeExtensionSource('authoring');
  assert(runtime.includes('// Kamishibai capabilities: narrative-control-v1'));
  const result = authorDsl4BlockSourceSb3({
    baseBytes,
    sourceText: source,
    sourceFrontend: frontend,
    narrativeRuntimeSource: runtime,
  });
  assert(result.ok, JSON.stringify(result));
});

test('ordinary 4.0 authoring does not require a narrative runner even with an enabled frontend', () => {
  const result = authorDsl4BlockSourceSb3({
    baseBytes,
    sourceText: stringify({kamishibai: '4.0', scenes: {opening: [{wait: 0}]}}),
    sourceFrontend: frontend,
  });
  assert(result.ok, JSON.stringify(result));
});

test('build fails with an old runner, then packages and validates the matching development playback', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'narrative-build-'));
  try {
    await writeFile(path.join(directory, 'story.k4.yml'), source);
    const options = {
      baseSb3Bytes: baseBytes,
      projectRoot: directory,
      sourceManifest: {formatVersion: 1, mode: 'external', sourceId: 'main', path: 'story.k4.yml'},
      sourceFrontend: frontend,
      controlProfile: 'production',
      channel: 'bundled' as const,
      ...limits,
      featureFlags: {dsl4NarrativeControl: true},
    };
    await assert.rejects(buildDsl4RuntimeComponent(options), {code: 'K4-NARRATIVE-RUNTIME-001'});
    const runtimeExtensionSource = await readDsl4NarrativeRuntimeExtensionSource();
    const built = await buildDsl4RuntimeComponent({...options, runtimeExtensionSource});
    assert(built.bytes.length > baseBytes.length);
    assert.equal(built.runtimeComponent.ok, true);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('declarative conditions use the actual bounded expression evaluator with typed variable values', async () => {
  const engine = createRuntimeExpressionComposition();
  try {
    const parsed = frontend.parse(
      stringify({
        kamishibai: '4.0',
        variables: {score: 2},
        scenes: {
          opening: [
            {
              if: {
                condition: {
                  all: [
                    {compare: {left: {variable: 'score'}, operator: '>=', right: 2}},
                    {not: false},
                  ],
                },
                then: [{wait: 1}],
                else: [{wait: 99}],
              },
            },
          ],
        },
      }),
    );
    assert(parsed.ok, JSON.stringify(parsed.diagnostics));
    const waits: unknown[] = [];
    const controller = createDsl4RuntimeController({
      storyDocument: parsed.storyDocument,
      narrativeControlEnabled: true,
      evaluateCondition: (expression, variables) => engine.evaluateCondition(expression, variables),
      port: {
        wait: (value: Record<string, unknown>) => {
          waits.push(value.seconds);
        },
      },
    });
    assert.equal((await controller.start()).status, 'finished');
    assert.deepEqual(waits, [1]);
  } finally {
    engine.releaseAll();
  }
});
