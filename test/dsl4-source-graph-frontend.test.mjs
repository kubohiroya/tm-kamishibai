import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {createDsl4SourceFrontend} from '../src/dsl4/source-frontend.js';
import {createDsl4SourceGraph} from '../src/dsl4/source-graph.js';
import {createDsl4SourceGraphFrontend} from '../src/dsl4/source-graph-frontend.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const singleSourceFrontend = createDsl4SourceFrontend(schema);
const graphFrontend = createDsl4SourceGraphFrontend(singleSourceFrontend);
const enabledOptions = {
  featureFlags: {dsl4Runtime: true, dsl4SourceIncludes: true},
};

function sourceLoader(sources) {
  const records = new Map(Object.entries(sources));
  return async (sourcePath) => {
    if (!records.has(sourcePath)) throw new Error(`missing fixture: ${sourcePath}`);
    return records.get(sourcePath);
  };
}

async function sourceGraph(sources) {
  return createDsl4SourceGraph('story.kamishibai.yaml', {
    readSource: sourceLoader(sources),
  });
}

test('composes fragments in root-first discovery order and preserves per-source Story origins', async () => {
  const graph = await sourceGraph({
    'story.kamishibai.yaml': `
include: chapters/chapter1/scenario.kamishibai.yml
kamishibai: '4.0'
assets:
  HeroSkin: costume:Hero
actors:
  Hero: HeroSkin
scenes:
  opening:
    - goto: chapter1
`,
    'chapters/chapter1/scenario.kamishibai.yml': `
assets:
  ChapterBackground:
    kind: backdrop
    file: image/background.svg
scenes:
  chapter1:
    - stage: ChapterBackground
`,
  });

  const result = graphFrontend.parse(graph, {...enabledOptions, sourceId: 'main'});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.storyDocument.metadata.sourceId, 'main');
  assert.deepEqual(
    result.storyDocument.scenes.map(({id}) => id),
    ['opening', 'chapter1'],
  );
  assert.equal(
    result.storyDocument.assets.ChapterBackground.file,
    'chapters/chapter1/image/background.svg',
  );
  const actionPath = '/scenes/chapter1/actions/0';
  assert.equal(
    result.storyDocument.sourceOrigins[actionPath].sourceId,
    'chapters/chapter1/scenario.kamishibai.yml',
  );
  assert.equal(result.storyDocument.sourceMap[actionPath].start.line, 8);
  assert.deepEqual(
    result.storyDocument.scenes[1].actions[0].sourceRange,
    result.storyDocument.sourceMap[actionPath],
  );
  assert.doesNotMatch(result.canonicalSource, /^include:/mu);
  assert.match(result.canonicalSource, /chapters\/chapter1\/image\/background\.svg/u);
  assert.equal(Object.isFrozen(result.storyDocument.sourceOrigins), true);
});

test('projects semantic diagnostics to the included source and original range', async () => {
  const graph = await sourceGraph({
    'story.kamishibai.yaml': `
include: chapter.kamishibai.yaml
kamishibai: '4.0'
scenes:
  opening:
    - goto: chapter1
`,
    'chapter.kamishibai.yaml': `
scenes:
  chapter1:
    - stage: MissingBackground
`,
  });
  const result = graphFrontend.parse(graph, enabledOptions);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, 'K4-REF-001');
  assert.equal(result.diagnostics[0].sourceId, 'chapter.kamishibai.yaml');
  assert.equal(result.diagnostics[0].range.start.line, 4);
});

test('rejects entry-only version declarations and unknown fragment fields at their source', async () => {
  const versionGraph = await sourceGraph({
    'story.kamishibai.yaml': `
include: chapter.kamishibai.yaml
kamishibai: '4.0'
scenes:
  opening: []
`,
    'chapter.kamishibai.yaml': `
kamishibai: '4.0'
scenes:
  chapter1: []
`,
  });
  const versionResult = graphFrontend.parse(versionGraph, enabledOptions);
  assert.equal(versionResult.ok, false);
  assert.equal(versionResult.diagnostics[0].code, 'K4-INCLUDE-ROOT-ONLY');
  assert.equal(versionResult.diagnostics[0].sourceId, 'chapter.kamishibai.yaml');
  assert.equal(versionResult.diagnostics[0].range.start.line, 2);

  const unknownGraph = await sourceGraph({
    'story.kamishibai.yaml': `
include: chapter.kamishibai.yaml
kamishibai: '4.0'
scenes:
  opening: []
`,
    'chapter.kamishibai.yaml': 'unknownFragmentField: true\n',
  });
  const unknownResult = graphFrontend.parse(unknownGraph, enabledOptions);
  assert.equal(unknownResult.ok, false);
  assert.equal(unknownResult.diagnostics[0].code, 'K4-SCHEMA-UNKNOWN-KEY');
  assert.equal(unknownResult.diagnostics[0].sourceId, 'chapter.kamishibai.yaml');
  assert.equal(unknownResult.diagnostics[0].range.start.line, 1);
});

test('applies restricted YAML rules independently to every included source', async () => {
  const graph = await sourceGraph({
    'story.kamishibai.yaml': `
include: chapter.kamishibai.yaml
kamishibai: '4.0'
scenes:
  opening: []
`,
    'chapter.kamishibai.yaml': `
scenes:
  chapter1: &actions []
  chapter2: *actions
`,
  });
  const result = graphFrontend.parse(graph, enabledOptions);
  assert.equal(result.ok, false);
  assert.equal(
    result.diagnostics.every(({code}) => code === 'K4-YAML-003'),
    true,
  );
  assert.equal(
    result.diagnostics.every(({sourceId}) => sourceId === 'chapter.kamishibai.yaml'),
    true,
  );
});

test('does not activate graph composition while the startup-fixed flag is off', async () => {
  const graph = await sourceGraph({
    'story.kamishibai.yaml': `
kamishibai: '4.0'
scenes:
  opening: []
`,
  });
  assert.throws(() => graphFrontend.parse(graph), /requires dsl4SourceIncludes/u);
  assert.throws(
    () => graphFrontend.parse(graph, {featureFlags: {dsl4Runtime: true}}),
    /requires dsl4SourceIncludes/u,
  );
});

test('fails closed for malformed graph topology and non-string fragment keys', async () => {
  const graph = await sourceGraph({
    'story.kamishibai.yaml': `
include: chapter.k4.yml
kamishibai: '4.0'
scenes:
  opening: []
`,
    'chapter.k4.yml': 'scenes: {chapter: []}\n',
  });
  const malformed = structuredClone(graph);
  malformed.order.pop();
  assert.throws(
    () => graphFrontend.parse(malformed, enabledOptions),
    /topology counts must match/u,
  );

  const invalidKeyGraph = await sourceGraph({
    'story.kamishibai.yaml': `
include: chapter.k4.yml
kamishibai: '4.0'
scenes:
  opening: []
`,
    'chapter.k4.yml': '? [invalid]\n: true\n',
  });
  const result = graphFrontend.parse(invalidKeyGraph, enabledOptions);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, 'K4-YAML-001');
  assert.equal(result.diagnostics[0].sourceId, 'chapter.k4.yml');
});
