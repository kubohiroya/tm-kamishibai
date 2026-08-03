import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('documents every security override and its removal condition', async () => {
  const [audit, workspace] = await Promise.all([
    readFile(new URL('docs/development/dependency-audit.md', root), 'utf8'),
    readFile(new URL('pnpm-workspace.yaml', root), 'utf8'),
  ]);
  const overrideSection = workspace.slice(workspace.indexOf('overrides:'));
  const expectedOverrides = [
    '@vivliostyle/cli>dompurify',
    'press-ready>uuid',
    'scratch-vm>uuid',
    'scratch-vm>worker-loader',
    'prismjs',
    'trim',
    'valibot',
  ];

  for (const name of expectedOverrides) {
    assert.match(overrideSection, new RegExp(`['"]?${name}['"]?:`, 'u'));
  }
  assert.match(overrideSection, /['"]scratch-vm>worker-loader['"]:\s*['"]-['"]/u);
  for (const name of ['dompurify', 'prismjs', 'trim', 'valibot', 'uuid', 'worker-loader']) {
    assert.ok(audit.includes('| `' + name + '`'));
  }
  assert.match(audit, /解除条件/u);
  assert.match(audit, /#212/u);
});

test('removes the unused scratch-vm legacy Webpack toolchain', async () => {
  const lockfile = await readFile(new URL('pnpm-lock.yaml', root), 'utf8');

  for (const packageVersion of [
    'worker-loader@1.1.1',
    'webpack@4.47.0',
    'micromatch@3.1.10',
    'serialize-javascript@4.0.0',
    'elliptic@6.6.1',
  ]) {
    assert.ok(!lockfile.includes(packageVersion), `${packageVersion} must not be in the lockfile`);
  }
});

test('enables weekly npm and GitHub Actions dependency monitoring', async () => {
  const dependabot = await readFile(new URL('.github/dependabot.yml', root), 'utf8');

  assert.match(dependabot, /package-ecosystem: npm/u);
  assert.match(dependabot, /package-ecosystem: github-actions/u);
  assert.equal((dependabot.match(/interval: weekly/gu) ?? []).length, 2);
  assert.equal((dependabot.match(/timezone: Asia\/Tokyo/gu) ?? []).length, 2);
});
