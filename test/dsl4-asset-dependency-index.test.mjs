import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {createDsl4AssetDependencyIndex, createDsl4SourceFrontend} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);

function parse(source) {
  const result = frontend.parse(source, {sourceId: 'asset-index-test'});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.storyDocument;
}

test('indexes every direct dependency in the comprehensive DSL 4.0 fixture', async () => {
  const source = await readFile(
    path.join(projectRoot, 'test', 'fixtures', 'dsl4', 'valid', 'comprehensive.kamishibai.yaml'),
    'utf8',
  );
  const index = createDsl4AssetDependencyIndex(parse(source));

  assert.deepEqual(index.startup, [
    'Beach',
    'CaptionIdle',
    'ClockTicking',
    'HeroHappy',
    'HeroHelp',
    'HeroIdle',
    'Loading1',
    'Loading2',
    'LoadingBackground',
    'Success',
  ]);
  assert.deepEqual(index.cover, ['Beach', 'OpeningSound']);
  assert.deepEqual(index.actors, ['CaptionIdle', 'HeroIdle']);
  assert.deepEqual(index.poseRecognition, ['ClockTicking', 'Success']);
  assert.deepEqual(index.scenes, {
    opening: {
      all: ['Beach', 'HeroHappy', 'OpeningSound'],
      eager: ['Beach', 'HeroHappy'],
      lazy: ['OpeningSound'],
    },
    rescue: {
      all: ['ClockTicking', 'HeroHappy', 'HeroHelp', 'Ocean', 'Success', '救助Pose'],
      eager: ['ClockTicking', 'HeroHappy', 'HeroHelp', 'Success'],
      lazy: ['Ocean', '救助Pose'],
    },
    seaRoute: {all: [], eager: [], lazy: []},
    ending: {all: ['Beach'], eager: ['Beach'], lazy: []},
  });
});

test('forces lazy loading UI assets into startup without preloading unrelated lazy assets', () => {
  const storyDocument = parse(`
kamishibai: '4.0'
assets:
  LoadingBackdrop:
    kind: backdrop
    name: LoadingBackdrop
    loading: lazy
  LoadingCostume:
    kind: costume
    target: Loading
    name: LoadingCostume
    loading: lazy
  CoverBackdrop:
    kind: backdrop
    name: CoverBackdrop
    loading: lazy
  HeroInitial:
    kind: costume
    target: Hero
    name: HeroInitial
    loading: lazy
  SceneBackdrop:
    kind: backdrop
    name: SceneBackdrop
    loading: lazy
  Unused:
    kind: sound
    name: Unused
    loading: lazy
actors:
  Hero: HeroInitial
cover:
  backdrop: CoverBackdrop
loading:
  backdrop: LoadingBackdrop
  costumes: [LoadingCostume]
scenes:
  first:
    - stage: SceneBackdrop
`);
  const index = createDsl4AssetDependencyIndex(storyDocument);

  assert.deepEqual(index.startup, ['LoadingBackdrop', 'LoadingCostume']);
  assert.deepEqual(index.cover, ['CoverBackdrop']);
  assert.deepEqual(index.actors, ['HeroInitial']);
  assert.deepEqual(index.scenes.first, {
    all: ['SceneBackdrop'],
    eager: [],
    lazy: ['SceneBackdrop'],
  });
  assert.equal(index.startup.includes('Unused'), false);
});

test('deduplicates and stably sorts scene dependencies', () => {
  const storyDocument = parse(`
kamishibai: '4.0'
assets:
  Zed: sound
  Alpha: sound
scenes:
  first:
    - sound: Zed
    - bgm: Alpha
    - sound: Zed
`);
  const index = createDsl4AssetDependencyIndex(storyDocument);

  assert.deepEqual(index.scenes.first, {
    all: ['Alpha', 'Zed'],
    eager: ['Alpha', 'Zed'],
    lazy: [],
  });
});

test('returns a deeply immutable index and rejects non-StoryDocument input', () => {
  const index = createDsl4AssetDependencyIndex(
    parse(`
kamishibai: '4.0'
scenes:
  first: []
`),
  );
  assert.equal(Object.isFrozen(index), true);
  assert.equal(Object.isFrozen(index.startup), true);
  assert.equal(Object.isFrozen(index.scenes), true);
  assert.equal(Object.isFrozen(index.scenes.first), true);
  assert.equal(Object.isFrozen(index.scenes.first.lazy), true);
  assert.throws(
    () => createDsl4AssetDependencyIndex({kind: 'StoryDocument', version: '3.2'}),
    /StoryDocument version 4\.0/u,
  );
});

test('asset dependency index has no browser, filesystem, network, VM, or Scratch dependency', async () => {
  const implementation = await readFile(
    path.join(projectRoot, 'src', 'dsl4', 'asset-dependency-index.js'),
    'utf8',
  );
  assert.doesNotMatch(implementation, /(?:node:fs|node:http|node:https|\bfetch\s*\()/u);
  assert.doesNotMatch(implementation, /(?:globalThis\.(?:document|window)|KeyboardEvent)/u);
  assert.doesNotMatch(implementation, /(?:\bScratch\b|scratch-vm|vm\.runtime|startHats)/u);
});
