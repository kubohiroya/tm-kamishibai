import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
  dsl4ContentRunsNeedRichText,
  dsl4PlainTextFromContentRuns,
  normalizeDsl4ContentRuns,
} from '../src/dsl4/content-run.js';
import {thrown} from './helpers/thrown-error.ts';

test('normalizes a plain string and an authored run list into the same typed shape', () => {
  assert.deepEqual(normalizeDsl4ContentRuns('むかしむかし'), [
    {type: 'text', text: 'むかしむかし'},
  ]);

  assert.deepEqual(
    normalizeDsl4ContentRuns([
      'むかし',
      {ruby: {base: '竹取', reading: 'たけとり'}},
      'の翁がいました。',
    ]),
    [
      {type: 'text', text: 'むかし'},
      {type: 'ruby', base: '竹取', reading: 'たけとり'},
      {type: 'text', text: 'の翁がいました。'},
    ],
  );

  // Authored strings stay separate runs: nothing is merged, trimmed, or reordered.
  assert.deepEqual(normalizeDsl4ContentRuns(['a', 'b']), [
    {type: 'text', text: 'a'},
    {type: 'text', text: 'b'},
  ]);
});

test('normalization is idempotent so the YAML and block paths share one entry point', () => {
  const once = normalizeDsl4ContentRuns([
    'よい',
    {ruby: {base: '天気', reading: 'てんき'}},
    'ですね',
  ]);
  assert.deepEqual(normalizeDsl4ContentRuns(once), once);
});

test('projects ruby to its base only and keeps the projection deterministic', () => {
  const runs = normalizeDsl4ContentRuns([
    'きょうは',
    {ruby: {base: '快晴', reading: 'かいせい'}},
    'です',
  ]);

  // The reading is a sighted-reader aid. A backlog or screen reader that replayed both would say
  // the same word twice, so plain text keeps the base and drops the reading.
  assert.equal(dsl4PlainTextFromContentRuns(runs), 'きょうは快晴です');
  assert.equal(dsl4PlainTextFromContentRuns(runs), dsl4PlainTextFromContentRuns(runs));
  assert.equal(dsl4PlainTextFromContentRuns(normalizeDsl4ContentRuns('そのまま')), 'そのまま');
});

test('reports whether a run list needs the rich renderer', () => {
  assert.equal(dsl4ContentRunsNeedRichText(normalizeDsl4ContentRuns('ただの文')), false);
  assert.equal(dsl4ContentRunsNeedRichText(normalizeDsl4ContentRuns(['a', 'b'])), false);
  assert.equal(
    dsl4ContentRunsNeedRichText(normalizeDsl4ContentRuns([{ruby: {base: '漢', reading: 'かん'}}])),
    true,
  );
});

test('rejects malformed body text with the content run diagnostic', () => {
  assert.throws(() => normalizeDsl4ContentRuns(12), /string or a list/u);
  assert.throws(() => normalizeDsl4ContentRuns([]), /must not be empty/u);
  assert.throws(
    () => normalizeDsl4ContentRuns([{ruby: {base: '漢'}}]),
    /exactly base and reading/u,
  );
  assert.throws(
    () => normalizeDsl4ContentRuns([{ruby: {base: '', reading: 'かん'}}]),
    /base must be a non-empty string/u,
  );
  assert.throws(
    () => normalizeDsl4ContentRuns([{ruby: {base: '漢', reading: ''}}]),
    /reading must be a non-empty string/u,
  );
  assert.throws(() => normalizeDsl4ContentRuns([{bold: 'no'}]), /string or a ruby record/u);

  let caught: unknown;
  try {
    normalizeDsl4ContentRuns(12);
  } catch (error) {
    caught = error;
  }
  assert.equal(thrown(caught).code, 'K4-CONTENT-RUN-001');
});
