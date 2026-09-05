import assert from 'node:assert/strict';
import {test} from 'vitest';

import {ESLint} from 'eslint';

const projectRoot = new URL('../', import.meta.url);
const expectedRules = ['eqeqeq', 'no-undef', 'no-unused-vars'];
// TypeScript reports undefined and unused identifiers through the compiler and its own ESLint rule.
const expectedTypeScriptRules = ['eqeqeq', '@typescript-eslint/no-unused-vars'];
const firstPartyFiles = [
  'bin/tm-kamishibai.mjs',
  'eslint.config.mjs',
  'scripts/build-site.mjs',
  'scripts/download-catalog.mjs',
  'scripts/sb3/downloadable-releases.mjs',
  'site/site-shell.js',
  'src/builder/index.js',
  'test/dsl4-turbowarp-runtime-host.test.mjs',
  'test/dsl4-runtime-error-indicator.test.mjs',
];
const firstPartyTypeScriptFiles = [
  'src/builder/hash.ts',
  'src/dsl4/story-path.ts',
  'vitest.config.ts',
];

test('applies static quality rules to every first-party code area', async () => {
  const eslint = new ESLint({cwd: new URL('.', projectRoot).pathname});
  for (const filename of firstPartyFiles) {
    const config = await eslint.calculateConfigForFile(filename);
    for (const rule of expectedRules) {
      assert.equal(config.rules[rule][0], 2, `${rule} is not enabled for ${filename}`);
    }
  }
});

test('applies static quality rules to first-party TypeScript', async () => {
  const eslint = new ESLint({cwd: new URL('.', projectRoot).pathname});
  for (const filename of firstPartyTypeScriptFiles) {
    assert.equal(await eslint.isPathIgnored(filename), false, `${filename} is ignored`);
    const config = await eslint.calculateConfigForFile(filename);
    for (const rule of expectedTypeScriptRules) {
      assert.equal(config.rules[rule][0], 2, `${rule} is not enabled for ${filename}`);
    }
  }
});

test('does not ignore current release workflow sources', async () => {
  const eslint = new ESLint({cwd: new URL('.', projectRoot).pathname});
  assert.equal(await eslint.isPathIgnored('scripts/sb3/downloadable-releases.mjs'), false);
  assert.equal(await eslint.isPathIgnored('scripts/sb3/dsl4-release-workflow.mjs'), false);
  assert.equal(await eslint.isPathIgnored('scripts/sb3/dsl4-release-policy.mjs'), false);
});
