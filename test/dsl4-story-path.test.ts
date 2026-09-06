import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
  decodeDsl4StoryPathSegment,
  encodeDsl4StoryPathSegment,
  isCanonicalDsl4StoryPath,
} from '../src/dsl4/index.js';

test('round-trips literal IDs without exposing control characters in StoryPaths', () => {
  const literal = ' name.%/~\u0000\u001f\u007f ';
  const encoded = encodeDsl4StoryPathSegment(literal);

  assert.equal(encoded, ' name.%25~1~0%00%1F%7F ');
  assert.equal(decodeDsl4StoryPathSegment(encoded), literal);
  assert.equal(isCanonicalDsl4StoryPath(`/assets/${encoded}`), true);
  assert.equal(/[\u0000-\u001f\u007f]/u.test(encoded), false);
});

test('uses a single-pass percent decoder so literal escape-looking names remain distinct', () => {
  assert.equal(encodeDsl4StoryPathSegment('%00'), '%2500');
  assert.equal(decodeDsl4StoryPathSegment('%2500'), '%00');
  assert.equal(decodeDsl4StoryPathSegment('%00'), '\u0000');
  assert.equal(isCanonicalDsl4StoryPath('/assets/%00'), true);
  assert.equal(isCanonicalDsl4StoryPath('/assets/%2500'), true);
});

test('rejects non-canonical StoryPath spellings', () => {
  for (const path of ['/assets/raw%name', '/assets/%2f', '/assets/%2F', '/assets/~2', '/assets/']) {
    assert.equal(isCanonicalDsl4StoryPath(path), false, path);
  }
  assert.throws(() => decodeDsl4StoryPathSegment('raw/name'), /not canonical/u);
});
