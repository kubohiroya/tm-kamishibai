import assert from 'node:assert/strict';
import test from 'node:test';

import {ESLint} from 'eslint';

const projectRoot = new URL('../', import.meta.url);

test('applies effective lint rules to every first-party JavaScript environment', async () => {
  const eslint = new ESLint({cwd: projectRoot.pathname});
  const firstPartyFiles = [
    'src/builder/index.js',
    'bin/tmpose-kamishibai.mjs',
    'scripts/build-site.mjs',
    'test/helpers/turbowarp-vm.mjs',
    'docs/config.mjs',
    'site/site-shell.js',
    'app/extensions/kubohiroyaweblink.js',
  ];

  for (const file of firstPartyFiles) {
    const config = await eslint.calculateConfigForFile(file);
    assert.equal(config.rules['no-undef'][0], 2, `${file} must reject undefined variables`);
    assert.equal(config.rules['no-unused-vars'][0], 2, `${file} must reject unused variables`);
  }
});

test('rejects undefined and unused variables in a newly added first-party script', async () => {
  const eslint = new ESLint({cwd: projectRoot.pathname});
  const [result] = await eslint.lintText('const unused = 1; missingFunction();\n', {
    filePath: 'scripts/lint-contract-probe.mjs',
  });

  assert.deepEqual(result.messages.map(({ruleId}) => ruleId).sort(), [
    'no-undef',
    'no-unused-vars',
  ]);
});

test('ignores extension artifacts maintained by standalone repositories', async () => {
  const eslint = new ESLint({cwd: projectRoot.pathname});

  assert.equal(await eslint.isPathIgnored('app/extensions/kubohiroyaassetmanager.js'), true);
  assert.equal(await eslint.isPathIgnored('app/extensions/kubohiroyaweblink.js'), false);
});
