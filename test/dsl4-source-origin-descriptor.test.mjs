import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
  applyDsl4SourceOrigins,
  createDsl4SourceOriginDescriptor,
  Dsl4SourceOriginError,
  validateDsl4SourceOriginDescriptor,
} from '../src/dsl4/index.js';

const rootRange = {
  start: {line: 1, column: 1, offset: 0},
  end: {line: 4, column: 1, offset: 42},
};
const actionRange = {
  start: {line: 7, column: 5, offset: 80},
  end: {line: 7, column: 22, offset: 97},
};
const origins = {
  '/scenes/chapter/actions/0': {sourceId: 'chapters/chapter.k4.yml', range: actionRange},
  '/': {sourceId: 'story.k4.yml', range: rootRange},
};

function rejectsCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof Dsl4SourceOriginError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test('creates a canonical versioned descriptor and restores immutable source origins', () => {
  const descriptor = createDsl4SourceOriginDescriptor(origins);
  assert.deepEqual(
    descriptor.entries.map(({storyPath}) => storyPath),
    ['/', '/scenes/chapter/actions/0'],
  );
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.entries[0].range.start), true);
  assert.deepEqual(validateDsl4SourceOriginDescriptor(structuredClone(descriptor)), descriptor);

  const storyDocument = {
    kind: 'StoryDocument',
    version: '4.0',
    metadata: {sourceId: 'main'},
    sourceMap: {'/': rootRange, '/scenes/chapter/actions/0': actionRange},
    scenes: [
      {
        id: 'chapter',
        actions: [{id: '/scenes/chapter/actions/0', sourceRange: rootRange}],
      },
    ],
  };
  const restored = applyDsl4SourceOrigins(storyDocument, descriptor);
  assert.deepEqual(restored.sourceOrigins, origins);
  assert.deepEqual(restored.scenes[0].actions[0].sourceRange, actionRange);
  assert.equal(Object.isFrozen(restored), true);
});

test('accepts canonical percent escapes for literal controls and percent signs', () => {
  const literalOrigins = {
    '/assets/ name.%25~1~0%00%1F%7F ': {
      sourceId: 'story.k4.yml',
      range: rootRange,
    },
  };
  const descriptor = createDsl4SourceOriginDescriptor(literalOrigins);

  assert.deepEqual(validateDsl4SourceOriginDescriptor(structuredClone(descriptor)), descriptor);
  for (const invalid of ['/assets/raw%', '/assets/%2F', '/assets/%0a']) {
    rejectsCode(
      () =>
        createDsl4SourceOriginDescriptor({
          [invalid]: {sourceId: 'story.k4.yml', range: rootRange},
        }),
      'K4-SOURCE-ORIGIN-STORY-PATH-001',
    );
  }
});

test('rejects unsafe source IDs and non-canonical story paths', () => {
  for (const invalidSourceId of [
    '/absolute/story.k4.yml',
    '../story.k4.yml',
    'https://example.test/story.k4.yml',
    'story.yml',
    'chapters\\story.k4.yml',
  ]) {
    rejectsCode(
      () =>
        createDsl4SourceOriginDescriptor({
          '/': {sourceId: invalidSourceId, range: rootRange},
        }),
      'K4-SOURCE-ORIGIN-SOURCE-ID-001',
    );
  }
  rejectsCode(
    () =>
      createDsl4SourceOriginDescriptor({
        scenes: {sourceId: 'story.k4.yml', range: rootRange},
      }),
    'K4-SOURCE-ORIGIN-STORY-PATH-001',
  );
});

test('rejects unknown fields, duplicate or unordered entries, and invalid ranges', () => {
  const descriptor = structuredClone(createDsl4SourceOriginDescriptor(origins));
  descriptor.entries[0].extra = true;
  rejectsCode(() => validateDsl4SourceOriginDescriptor(descriptor), 'K4-SOURCE-ORIGIN-SCHEMA-001');

  const unordered = structuredClone(createDsl4SourceOriginDescriptor(origins));
  unordered.entries.reverse();
  rejectsCode(() => validateDsl4SourceOriginDescriptor(unordered), 'K4-SOURCE-ORIGIN-ORDER-001');

  const duplicate = structuredClone(createDsl4SourceOriginDescriptor(origins));
  duplicate.entries[1].storyPath = '/';
  rejectsCode(() => validateDsl4SourceOriginDescriptor(duplicate), 'K4-SOURCE-ORIGIN-ORDER-001');

  const invalidRange = structuredClone(createDsl4SourceOriginDescriptor(origins));
  invalidRange.entries[0].range.end.offset = -1;
  rejectsCode(() => validateDsl4SourceOriginDescriptor(invalidRange), 'K4-SOURCE-ORIGIN-RANGE-001');
});

test('enforces entry and encoded-byte limits before applying persisted origins', () => {
  rejectsCode(
    () => createDsl4SourceOriginDescriptor(origins, {maxEntries: 1}),
    'K4-SOURCE-ORIGIN-LIMIT-001',
  );
  rejectsCode(
    () => createDsl4SourceOriginDescriptor(origins, {maxDescriptorBytes: 32}),
    'K4-SOURCE-ORIGIN-LIMIT-001',
  );
});

test('requires exact coverage of the parsed StoryDocument sourceMap', () => {
  const storyDocument = {
    sourceMap: {'/': rootRange, '/scenes/chapter': actionRange},
    scenes: [],
  };
  rejectsCode(
    () =>
      applyDsl4SourceOrigins(storyDocument, createDsl4SourceOriginDescriptor({'/': origins['/']})),
    'K4-SOURCE-ORIGIN-COVERAGE-001',
  );
  rejectsCode(
    () =>
      applyDsl4SourceOrigins(
        {sourceMap: {'/': rootRange}, scenes: []},
        createDsl4SourceOriginDescriptor(origins),
      ),
    'K4-SOURCE-ORIGIN-COVERAGE-001',
  );
});
