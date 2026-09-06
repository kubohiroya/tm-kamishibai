import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
  extractDsl4BlockSourcesFromProject,
  Dsl4BlockSourceError,
} from '../src/dsl4/turbowarp-yaml-json-block-source.js';

const runtimePrefix = 'kubohiroyakamishibairuntime4_';
const yamlJsonPrefix = 'kubohiroyayamljson_';

/** @param {string} value */
function literal(value) {
  return [1, [10, value]];
}

/** @param {string} blockId */
function reporter(blockId) {
  return [3, blockId, [10, '']];
}

/** @param {string} id @param {string} next */
function hat(id, next) {
  return [
    id,
    {
      opcode: `${runtimePrefix}whenDsl4Source`,
      next,
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
    },
  ];
}

/** @param {string} id @param {string} fragment */
function sourceCommand(id, fragment) {
  return [
    id,
    {
      opcode: `${runtimePrefix}dsl4SourceFromYamlJson`,
      next: null,
      parent: 'hat',
      inputs: {FRAGMENT: reporter(fragment)},
      fields: {},
      shadow: false,
      topLevel: false,
    },
  ];
}

/** @param {string} id @param {string} key @param {string} valueBlock */
function pair(id, key, valueBlock) {
  return [
    id,
    {
      opcode: `${yamlJsonPrefix}pair`,
      next: null,
      parent: null,
      inputs: {KEY: literal(key), VALUE: reporter(valueBlock)},
      fields: {},
      shadow: false,
      topLevel: false,
    },
  ];
}

/** @param {string} id @param {string} left @param {string} right */
function concat(id, left, right) {
  return [
    id,
    {
      opcode: `${yamlJsonPrefix}concat`,
      next: null,
      parent: null,
      inputs: {LEFT: reporter(left), RIGHT: reporter(right)},
      fields: {},
      shadow: false,
      topLevel: false,
    },
  ];
}

/** @param {string} id @param {string} entries */
function map(id, entries) {
  return [
    id,
    {
      opcode: `${yamlJsonPrefix}map`,
      next: null,
      parent: null,
      inputs: {ENTRIES: reporter(entries)},
      fields: {},
      shadow: false,
      topLevel: false,
    },
  ];
}

/** @param {string} id */
function sequence(id) {
  return [
    id,
    {
      opcode: `${yamlJsonPrefix}sequence`,
      next: null,
      parent: null,
      inputs: {ITEMS: [1, [10, '']]},
      fields: {},
      shadow: false,
      topLevel: false,
    },
  ];
}

/** @param {string} id @param {string} value */
function stringValue(id, value) {
  return [
    id,
    {
      opcode: `${yamlJsonPrefix}string`,
      next: null,
      parent: null,
      inputs: {VALUE: literal(value)},
      fields: {},
      shadow: false,
      topLevel: false,
    },
  ];
}

test('extracts Stage root and sprite include sources from YAML/JSON reporter blocks', () => {
  const project = {
    targets: [
      {
        name: 'Stage',
        isStage: true,
        blocks: Object.fromEntries([
          hat('hat', 'cmd'),
          sourceCommand('cmd', 'rootMap'),
          pair('includePair', 'include', 'includeValue'),
          stringValue('includeValue', 'Chapter.k4.yml'),
          pair('versionPair', 'kamishibai', 'versionValue'),
          stringValue('versionValue', '4.0'),
          pair('scenePair', 'scenes', 'sceneMap'),
          map('sceneMap', 'openingPair'),
          pair('openingPair', 'opening', 'emptyActions'),
          sequence('emptyActions'),
          concat('firstPairs', 'includePair', 'versionPair'),
          concat('rootPairs', 'firstPairs', 'scenePair'),
          map('rootMap', 'rootPairs'),
        ]),
      },
      {
        name: 'Chapter',
        isStage: false,
        blocks: Object.fromEntries([
          hat('chapterHat', 'chapterCmd'),
          sourceCommand('chapterCmd', 'chapterMap'),
          pair('chapterScenesPair', 'scenes', 'chapterScenes'),
          map('chapterScenes', 'endingPair'),
          pair('endingPair', 'ending', 'endingActions'),
          sequence('endingActions'),
          map('chapterMap', 'chapterScenesPair'),
        ]),
      },
    ],
  };

  const extracted = extractDsl4BlockSourcesFromProject(project);
  assert.equal(extracted.entryPath, 'Stage.k4.yml');
  assert.deepEqual(Object.keys(extracted.sources), ['Chapter.k4.yml', 'Stage.k4.yml']);
  assert.equal(
    extracted.sources['Stage.k4.yml'],
    ['include: "Chapter.k4.yml"', 'kamishibai: "4.0"', 'scenes:', '  opening:', '    []', ''].join(
      '\n',
    ),
  );
  assert.equal(
    extracted.sources['Chapter.k4.yml'],
    ['scenes:', '  ending:', '    []', ''].join('\n'),
  );
});

test('rejects duplicate DSL source hats on the same target', () => {
  const project = {
    targets: [
      {
        name: 'Stage',
        isStage: true,
        blocks: Object.fromEntries([hat('hat', 'cmd'), hat('hat2', 'cmd')]),
      },
    ],
  };

  assert.throws(
    () => extractDsl4BlockSourcesFromProject(project),
    (error) =>
      error instanceof Dsl4BlockSourceError && error.code === 'K4-BLOCK-SOURCE-DUPLICATE-001',
  );
});
