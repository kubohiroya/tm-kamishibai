import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  classifyDsl4AssetReload,
  createDsl4AssetReloadSnapshot,
  createDsl4SourceFrontend,
} from '../src/dsl4/index.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);

function sri(value) {
  return `sha256-${createHash('sha256').update(value).digest('base64')}`;
}

function parse(source) {
  const result = frontend.parse(source, {sourceId: 'asset-reload-policy-test'});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.storyDocument;
}

function manifest(storyDocument, integrities = {}) {
  return {
    formatVersion: 1,
    assets: Object.entries(storyDocument.assets)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([id, asset]) => ({
        id,
        kind: asset.kind,
        loading: asset.loading,
        ...(asset.target === undefined ? {} : {target: asset.target}),
        source:
          typeof asset.file === 'string'
            ? {
                type: 'file',
                inputPath: asset.file,
                mode: asset.kind === 'poseModel' ? 'directory' : 'file',
                files:
                  asset.kind === 'poseModel'
                    ? [
                        {path: 'metadata.json', size: 20, integrity: sri(`${id}:metadata`)},
                        {path: 'model.json', size: 20, integrity: sri(`${id}:model`)},
                        {path: 'weights.bin', size: 20, integrity: sri(`${id}:weights`)},
                      ]
                    : [
                        {
                          path: asset.file.split('/').at(-1),
                          size: 20,
                          integrity: integrities[id] ?? sri(`${id}:v1`),
                        },
                      ],
              }
            : {type: 'project', name: asset.name},
      })),
  };
}

const baseStory = parse(`
kamishibai: '4.0'
assets:
  ProjectBackdrop: backdrop
  Ocean:
    kind: backdrop
    file: ocean.svg
    loading: lazy
  Hero:
    kind: costume
    target: Hero
    file: hero.png
actors:
  Hero: Hero
scenes:
  opening:
    - stage: Ocean
    - Hero.setSkin: Hero
`);

const additiveStory = parse(`
kamishibai: '4.0'
assets:
  ProjectBackdrop: backdrop
  Ocean:
    kind: backdrop
    file: ocean.svg
    loading: lazy
  Hero:
    kind: costume
    target: Hero
    file: hero.png
  Bell:
    kind: sound
    file: bell.wav
actors:
  Hero: Hero
scenes:
  opening:
    - stage: Ocean
    - Hero.setSkin: Hero
    - sound: Bell
`);

async function snapshot({
  storyDocument = baseStory,
  source = 'source-v1',
  structure = 'structure-v1',
  integrities,
} = {}) {
  return createDsl4AssetReloadSnapshot({
    storyDocument,
    manifest: manifest(storyDocument, integrities),
    sourceIntegrity: sri(source),
    structuralFingerprint: sri(structure),
    subtleCrypto: webcrypto.subtle,
  });
}

test('creates one deterministic redacted asset graph and content snapshot', async () => {
  const first = await snapshot();
  const second = await snapshot();

  assert.deepEqual(first, second);
  assert.equal(first.kind, 'Dsl4AssetReloadSnapshot');
  assert.equal(first.graph.find(({id}) => id === 'Ocean').source.inputPath, 'ocean.svg');
  assert.deepEqual(first.graph.find(({id}) => id === 'Ocean').source.files, ['ocean.svg']);
  assert.equal(
    first.content.find(({id}) => id === 'Ocean').source.files[0].integrity,
    sri('Ocean:v1'),
  );
  assert.deepEqual(first.dependencies.scenes.opening.all, ['Hero', 'Ocean']);
  assert.equal(JSON.stringify(first).includes(repositoryRoot), false);
  assert.equal(JSON.stringify(first).includes('<svg'), false);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.content), true);
});

test('classifies source, content, composite, and no-change candidates', async () => {
  const active = await snapshot();
  const cases = [
    {candidate: await snapshot(), kind: 'no-change', changed: []},
    {
      candidate: await snapshot({source: 'source-v2'}),
      kind: 'source-live-reload',
      changed: [],
    },
    {
      candidate: await snapshot({integrities: {Ocean: sri('ocean-v2')}}),
      kind: 'asset-live-reload',
      changed: ['Ocean'],
    },
    {
      candidate: await snapshot({source: 'source-v2', integrities: {Hero: sri('hero-v2')}}),
      kind: 'composite-live-reload',
      changed: ['Hero'],
    },
  ];

  for (const item of cases) {
    const result = classifyDsl4AssetReload({active, candidate: item.candidate});
    assert.equal(result.kind, item.kind);
    assert.deepEqual(
      result.changedAssets.map(({id}) => id),
      item.changed,
    );
    assert.equal(result.requiresFullRebuild, false);
    assert.equal(Object.isFrozen(result), true);
  }
  const content = classifyDsl4AssetReload({
    active,
    candidate: await snapshot({integrities: {Ocean: sri('ocean-v2')}}),
  });
  assert.deepEqual(content.affectedScenes, ['opening']);
});

test('accepts only source-backed safe additions as additive composite reload', async () => {
  const active = await snapshot();
  const candidate = await snapshot({storyDocument: additiveStory, source: 'source-v2'});
  const result = classifyDsl4AssetReload({active, candidate});

  assert.equal(result.kind, 'additive-composite-live-reload');
  assert.deepEqual(
    result.changedAssets.map(({id, change}) => [id, change]),
    [['Bell', 'added']],
  );
  assert.deepEqual(result.affectedScenes, ['opening']);

  const unchangedSource = structuredClone(candidate);
  unchangedSource.sourceIntegrity = active.sourceIntegrity;
  assert.equal(classifyDsl4AssetReload({active, candidate: unchangedSource}).kind, 'full-rebuild');
});

test('forces full rebuild for structural, removal, rename, kind, path, and bundle-shape changes', async () => {
  const active = await snapshot();
  const mutations = [
    (candidate) => (candidate.structuralFingerprint = sri('structure-v2')),
    (candidate) => candidate.graph.pop(),
    (candidate) => (candidate.graph[1].id = 'Renamed'),
    (candidate) => (candidate.graph[1].kind = 'sound'),
    (candidate) => (candidate.graph[1].source.inputPath = 'renamed.svg'),
    (candidate) => candidate.graph[1].source.files.push('extra.bin'),
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(active);
    mutate(candidate);
    const result = classifyDsl4AssetReload({active, candidate});
    assert.equal(result.kind, 'full-rebuild');
    assert.equal(result.requiresFullRebuild, true);
    assert.equal(result.requiresNewPreviewSession, true);
  }
});

test('does not classify mutable project asset state as a file asset reload', async () => {
  const active = await snapshot();
  const candidate = structuredClone(active);
  const projectAsset = candidate.content.find(({id}) => id === 'ProjectBackdrop');
  assert.deepEqual(projectAsset.source, {type: 'project', name: 'ProjectBackdrop'});
  assert.equal(classifyDsl4AssetReload({active, candidate}).kind, 'no-change');
});

test('rejects malformed or noncanonical snapshot boundaries', async () => {
  const active = await snapshot();
  assert.throws(
    () => classifyDsl4AssetReload({active, candidate: {...active, sourceIntegrity: 'invalid'}}),
    TypeError,
  );
  await assert.rejects(
    createDsl4AssetReloadSnapshot({
      storyDocument: baseStory,
      manifest: {...manifest(baseStory), extra: true},
      sourceIntegrity: sri('source'),
      structuralFingerprint: sri('structure'),
      subtleCrypto: webcrypto.subtle,
    }),
    (error) => error.code === 'K4-ASSET-BUNDLE-DESCRIPTOR-001',
  );
});
