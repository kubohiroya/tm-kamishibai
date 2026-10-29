import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'vitest';
import {strToU8, zipSync} from 'fflate';
import {stringify} from 'yaml';
import {authorDsl4BlockSourceSb3} from '../src/builder/dsl4-block-source-author.js';
import {buildDsl4RuntimeComponent} from '../src/builder/dsl4-build.js';
import {exportDsl4BlockSourcesToYaml} from '../src/builder/dsl4-block-source-export.js';
import {auditDsl4ProjectDefinitions} from '../src/builder/dsl4-definition-audit.js';
import {readSb3} from '../src/builder/sb3.js';
import {definitionRecord} from '../src/dsl4/definition-references.js';
import {prepareDsl4EmbeddedBlockStoryProject} from '../src/dsl4/platform/embedded-block-story.js';
import {loadDsl4RuntimeComponent} from '../src/dsl4/runtime-artifact-loader.js';
import {createDsl4EmbeddedAssetBundle} from '../src/dsl4/asset-bundle-descriptor.js';
import {createDsl4EmbeddedSourceDescriptor} from '../src/dsl4/source-descriptor.js';
import {createDsl4CompiledStoryArtifact} from '../src/dsl4/compiled-story-artifact.js';
import {createDsl4RuntimeArtifactDescriptor} from '../src/dsl4/runtime-artifact-descriptor.js';
import {
  dsl4TestProductionSourceFrontend as sourceFrontend,
  dsl4TestSchema as schema,
} from './helpers/dsl4-test-frontend.ts';
import {okResult} from './helpers/result-outcome.ts';

const project = {
  targets: [
    {
      isStage: true,
      name: 'Stage',
      variables: {},
      lists: {},
      blocks: {},
      costumes: [{name: 'Backdrop'}],
      sounds: [{name: 'Music'}],
    },
    {
      isStage: false,
      name: 'Cat',
      variables: {},
      lists: {},
      blocks: {},
      costumes: [{name: 'Idle'}, {name: 'Walk'}],
      sounds: [{name: 'Meow'}],
    },
  ],
  monitors: [],
  extensions: ['kubohiroyakamishibai4'],
};
const sourceText = stringify({
  kamishibai: '4.0',
  controls: {keymaps: {production: {Space: 'navigation.nextAction'}}},
  scenes: {
    opening: [
      {stage: 'Backdrop'},
      {'Cat.show': {skin: 'Walk', x: 0, y: 0, scale: 100}},
      {sound: 'Music'},
      {sound: 'Meow'},
    ],
  },
});
const baseBytes = zipSync({'project.json': strToU8(JSON.stringify(project))});
const limits = {
  maxSourceBytes: 1024 * 1024,
  maxAssetFiles: 16,
  maxAssetFileBytes: 65536,
  maxTotalAssetBytes: 65536,
  subtleCrypto: webcrypto.subtle,
};

test('authors, audits and exports undeclared project names while the runtime compiles and reloads the same blocks', async () => {
  const authored = await authorDsl4BlockSourceSb3({baseBytes, sourceText, sourceFrontend});
  assert.equal(authored.ok, true, JSON.stringify(authored));
  if (!authored.ok) return;
  const inputProject = readSb3(authored.bytes).project;
  const prepared = await prepareDsl4EmbeddedBlockStoryProject(inputProject, sourceFrontend, limits);
  const loaded = await loadDsl4RuntimeComponent(prepared, sourceFrontend, limits);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
  if (!loaded.ok) return;
  const story = definitionRecord(okResult(loaded, 'runtime reload').storyDocument);
  assert.equal(definitionRecord(story.variables).startSceneIndex, 1);
  const assets = definitionRecord(story.assets);
  const meow = Object.values(assets)
    .map(definitionRecord)
    .find((asset) => asset.name === 'Meow');
  assert.equal(meow?.target, 'Cat');
  const root = await mkdtemp(path.join(os.tmpdir(), 'implicit-block-chain-'));
  try {
    const input = path.join(root, 'work.sb3');
    await writeFile(input, authored.bytes);
    const audit = await auditDsl4ProjectDefinitions({input, schema, sourceFrontend});
    assert.equal(audit.ok, true, JSON.stringify(audit.diagnostics));
    assert.ok(audit.implicitReferences.length >= 4);
    const exported = await exportDsl4BlockSourcesToYaml({
      input,
      outputDir: path.join(root, 'export'),
      sourceFrontend,
      maxSourceBytes: limits.maxSourceBytes,
    });
    assert.ok(exported);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('external-source builds and source/compiled runtime loads share native asset resolution and defaults', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'implicit-source-chain-'));
  try {
    await writeFile(path.join(root, 'main.k4.yml'), sourceText);
    await writeFile(
      path.join(root, 'assets.config.json'),
      JSON.stringify({
        formatVersion: 1,
        providers: {},
        profiles: {native: {network: 'forbidden', defaultDelivery: 'embedded'}},
      }),
    );
    await writeFile(
      path.join(root, 'assets.lock.json'),
      JSON.stringify({formatVersion: 1, assets: {}}),
    );
    for (const variant of ['source', 'compiled', 'source-locked', 'compiled-locked'] as const) {
      const distributionProfile = variant.startsWith('compiled') ? 'compiled' : 'source';
      const built = await buildDsl4RuntimeComponent({
        baseSb3Bytes: baseBytes,
        projectRoot: root,
        sourceManifest: {
          formatVersion: 1,
          mode: 'external',
          sourceId: 'main',
          path: 'main.k4.yml',
          cacheId: 'implicit00000001',
          cacheDatabaseName: 'tw-kamishibai-assets-v1--story--implicit00000001',
        },
        sourceFrontend,
        controlProfile: 'production',
        channel: 'bundled',
        distributionProfile,
        ...(variant.endsWith('-locked')
          ? {
              assetConfig: path.join(root, 'assets.config.json'),
              assetLock: path.join(root, 'assets.lock.json'),
              assetProfile: 'native',
              maxAssetConfigBytes: 65536,
              maxAssetLockBytes: 65536,
            }
          : {}),
        ...limits,
        featureFlags: {dsl4Runtime: true},
      });
      assert.equal(built.runtimeComponent.ok, true);
      const loaded = await loadDsl4RuntimeComponent(
        readSb3(built.bytes).project,
        sourceFrontend,
        limits,
      );
      assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
      if (loaded.ok) {
        const story = definitionRecord(okResult(loaded, 'runtime reload').storyDocument);
        assert.equal(definitionRecord(story.variables).startSceneIndex, 1);
        assert.ok(definitionRecord(story.cover).backdrop);
      }
    }
    assert.equal(await readFile(path.join(root, 'main.k4.yml'), 'utf8'), sourceText);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('loads a legacy bundle without default cover assets only after authenticating its stored bytes', async () => {
  const text = stringify({
    kamishibai: '4.0',
    controls: {keymaps: {production: {Space: 'navigation.nextAction'}}},
    scenes: {opening: [{wait: 0}]},
  });
  const parsed = sourceFrontend.parse(text);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const source = await createDsl4EmbeddedSourceDescriptor(text, {
    sourceId: 'main',
    displayName: 'main.k4.yml',
    ...limits,
  });
  const artifact = okResult(
    await createDsl4RuntimeArtifactDescriptor(parsed.storyDocument, source, 'production', limits),
    'legacy artifact',
  ).artifact;
  const assets = await createDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    {
      manifest: {formatVersion: 1, assets: []},
      getFile() {
        throw new Error('No payloads');
      },
    },
    {maxFiles: 16, maxTotalBytes: 65536, subtleCrypto: webcrypto.subtle},
  );
  const legacy = {
    ...structuredClone(project),
    extensionStorage: {kubohiroyakamishibairuntime4: {source, artifact, assets}},
  };
  const original = structuredClone(legacy);
  const loaded = okResult(
    await loadDsl4RuntimeComponent(legacy, sourceFrontend, limits),
    'legacy runtime',
  );
  assert.equal(
    definitionRecord(definitionRecord(loaded.storyDocument).cover).backdrop !== undefined,
    true,
  );
  assert.deepEqual(legacy, original);
  const compiled = await createDsl4CompiledStoryArtifact(parsed.storyDocument!, {
    sourceIntegrity: source.integrity,
    subtleCrypto: webcrypto.subtle,
  });
  const compiledProject = {
    ...structuredClone(project),
    extensionStorage: {kubohiroyakamishibairuntime4: {compiled, artifact, assets}},
  };
  const stored = structuredClone(compiledProject);
  const compiledLoaded = okResult(
    await loadDsl4RuntimeComponent(compiledProject, sourceFrontend, limits),
    'legacy compiled runtime',
  );
  const compiledStory = definitionRecord(compiledLoaded.storyDocument);
  assert.deepEqual(compiledStory.cover, definitionRecord(loaded.storyDocument).cover);
  assert.deepEqual(compiledStory.variables, definitionRecord(loaded.storyDocument).variables);
  assert.deepEqual(compiledProject, stored, 'the authenticated stored artifacts stay unchanged');
  const again = okResult(
    await loadDsl4RuntimeComponent(compiledProject, sourceFrontend, limits),
    'repeated compiled load',
  );
  assert.deepEqual(definitionRecord(again.storyDocument).assets, compiledStory.assets);
  const corrupt = structuredClone(legacy);
  corrupt.extensionStorage.kubohiroyakamishibairuntime4.assets = {
    ...corrupt.extensionStorage.kubohiroyakamishibairuntime4.assets,
    integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  };
  const refused = await loadDsl4RuntimeComponent(corrupt, sourceFrontend, limits);
  assert.equal(refused.ok, false);
});

test('reports an unused SB3 definition with its target and original definition block', async () => {
  const authored = await authorDsl4BlockSourceSb3({
    baseBytes,
    sourceFrontend,
    sourceText: sourceText + 'assets:\n  Spare:\n    kind: sound\n    name: Music\n',
  });
  assert.equal(authored.ok, true);
  if (!authored.ok) return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'implicit-block-diagnostic-'));
  try {
    const input = path.join(root, 'work.sb3');
    await writeFile(input, authored.bytes);
    const result = await auditDsl4ProjectDefinitions({input, schema, sourceFrontend});
    const warning = definitionRecord(
      result.diagnostics.find((diagnostic) => diagnostic.code === 'K4-DEFINITION-UNUSED'),
    );
    assert.equal(warning.targetName, 'Stage');
    assert.equal(typeof warning.blockId, 'string');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('legacy compiled defaults preserve explicit cover and variable values and reject corrupt IR', async () => {
  const text = stringify({
    kamishibai: '4.0',
    assets: {Chosen: {kind: 'backdrop', name: 'Backdrop'}},
    cover: {backdrop: 'Chosen'},
    variables: {startSceneIndex: 2},
    controls: {keymaps: {production: {Space: 'navigation.nextAction'}}},
    scenes: {opening: [{wait: 0}]},
  });
  const parsed = sourceFrontend.parse(text);
  assert(parsed.ok);
  const source = await createDsl4EmbeddedSourceDescriptor(text, {
    sourceId: 'main',
    displayName: 'main.k4.yml',
    ...limits,
  });
  const artifact = okResult(
    await createDsl4RuntimeArtifactDescriptor(parsed.storyDocument!, source, 'production', limits),
    'legacy explicit artifact',
  ).artifact;
  const assets = await createDsl4EmbeddedAssetBundle(
    parsed.storyDocument!,
    {
      manifest: {
        formatVersion: 1,
        assets: [
          {
            id: 'Chosen',
            kind: 'backdrop',
            loading: 'eager',
            bitmapResolution: 1,
            source: {type: 'project', name: 'Backdrop'},
          },
        ],
      },
      getFile() {
        throw new Error('No payloads');
      },
    },
    {maxFiles: 16, maxTotalBytes: 65536, subtleCrypto: webcrypto.subtle},
  );
  const compiled = await createDsl4CompiledStoryArtifact(parsed.storyDocument!, {
    sourceIntegrity: source.integrity,
    subtleCrypto: webcrypto.subtle,
  });
  const component = {
    ...structuredClone(project),
    extensionStorage: {kubohiroyakamishibairuntime4: {compiled, artifact, assets}},
  };
  const loaded = okResult(
    await loadDsl4RuntimeComponent(component, sourceFrontend, limits),
    'legacy explicit compiled',
  );
  assert.deepEqual(definitionRecord(loaded.storyDocument).cover, {backdrop: 'Chosen'});
  assert.equal(
    definitionRecord(definitionRecord(loaded.storyDocument).variables).startSceneIndex,
    2,
  );
  const corrupt = structuredClone(component);
  (
    corrupt.extensionStorage.kubohiroyakamishibairuntime4.compiled.story as Record<string, unknown>
  ).cover = null;
  assert.equal((await loadDsl4RuntimeComponent(corrupt, sourceFrontend, limits)).ok, false);
});
