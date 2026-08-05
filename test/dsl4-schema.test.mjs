import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {compileDsl4Schema, normalizeDsl4Story, validateDsl4Source} from './helpers/dsl4-schema.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = path.join(projectRoot, 'test', 'fixtures', 'dsl4');
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const validateSchema = compileDsl4Schema(schema);

async function validateFixture(group, name) {
  const source = await readFile(path.join(fixtureRoot, group, name), 'utf8');
  return validateDsl4Source(source, validateSchema);
}

test('the approved comprehensive DSL 4.0 example satisfies schema and semantics', async () => {
  const result = await validateFixture('valid', 'comprehensive.kamishibai.yaml');
  assert.deepEqual(result.errors, []);
});

test('compact and named actions plus short and long scenes normalize identically', async () => {
  const compact = await validateFixture('valid', 'compact-normalization.kamishibai.yaml');
  const named = await validateFixture('valid', 'named-normalization.kamishibai.yaml');
  assert.deepEqual(compact.errors, []);
  assert.deepEqual(named.errors, []);
  assert.deepEqual(normalizeDsl4Story(compact.story), normalizeDsl4Story(named.story));
});

for (const name of [
  'modifier-key.kamishibai.yaml',
  'multiple-action-keys.kamishibai.yaml',
  'unknown-action-argument.kamishibai.yaml',
  'list-for-scalar.kamishibai.yaml',
  'long-scene-missing-actions.kamishibai.yaml',
  'long-scene-mixed-action.kamishibai.yaml',
  'deprecated-text-asset.kamishibai.yaml',
  'non-scalar-variable.kamishibai.yaml',
  'cover-missing-backdrop.kamishibai.yaml',
  'pose-recognition-missing-sound.kamishibai.yaml',
  'top-level-pose-models.kamishibai.yaml',
  'invalid-loading-policy.kamishibai.yaml',
  'positional-multi-argument.kamishibai.yaml',
  'remote-asset.kamishibai.yaml',
  'unknown-top-level-key.kamishibai.yaml',
]) {
  test(`schema rejects ${name}`, async () => {
    const result = await validateFixture('invalid', name);
    assert.ok(result.errors.length > 0);
    assert.equal(result.story, undefined);
  });
}

for (const [name, code] of [
  ['version-number.kamishibai.yaml', 'K4-VERSION-001'],
  ['invalid-id.kamishibai.yaml', 'K4-ID-INVALID'],
  ['unknown-top-level-key.kamishibai.yaml', 'K4-SCHEMA-UNKNOWN-KEY'],
  ['modifier-key.kamishibai.yaml', 'K4-KEY-UNSUPPORTED'],
]) {
  test(`${name} reports ${code}`, async () => {
    const result = await validateFixture('invalid', name);
    assert.ok(result.errors.some((error) => error.code === code));
  });
}

for (const [name, code] of [
  ['duplicate-stable-id.kamishibai.yaml', 'K4-STABLE-ID-001'],
  ['else-not-last.kamishibai.yaml', 'K4-BRANCH-001'],
  ['keymap-collision.kamishibai.yaml', 'K4-KEY-001'],
  ['missing-reference.kamishibai.yaml', 'K4-REF-001'],
  ['path-traversal.kamishibai.yaml', 'K4-ASSET-001'],
  ['wrong-asset-kind.kamishibai.yaml', 'K4-REF-002'],
]) {
  test(`semantic validation rejects ${name}`, async () => {
    const result = await validateFixture('invalid', name);
    assert.ok(result.errors.some((error) => error.code === code));
  });
}

test('restricted YAML rejects aliases, anchors, merge keys, tags, duplicates, and multiple documents', () => {
  const sources = [
    "kamishibai: '4.0'\nscenes: &scenes\n  opening: []\ncopy: *scenes\n",
    "kamishibai: '4.0'\nbase: &base {opening: []}\nscenes:\n  <<: *base\n",
    "kamishibai: '4.0'\nscenes: !custom {opening: []}\n",
    "kamishibai: '4.0'\nscenes: {}\nscenes: {}\n",
    "kamishibai: '4.0'\nscenes: {}\n---\nkamishibai: '4.0'\nscenes: {}\n",
  ];
  for (const source of sources) {
    const result = validateDsl4Source(source, validateSchema);
    assert.ok(result.errors.some((error) => error.code.startsWith('K4-YAML-')));
  }
});

test('YAML 1.2 keeps yes, no, and dates as strings while preserving booleans', () => {
  const result = validateDsl4Source(
    [
      "kamishibai: '4.0'",
      'variables:',
      '  yesValue: yes',
      '  noValue: no',
      '  dateValue: 2026-08-06',
      '  enabled: true',
      '  disabled: false',
      'scenes:',
      '  opening: []',
    ].join('\n'),
    validateSchema,
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.story.variables, {
    yesValue: 'yes',
    noValue: 'no',
    dateValue: '2026-08-06',
    enabled: true,
    disabled: false,
  });
});
