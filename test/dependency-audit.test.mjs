import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('removes documentation-only dependencies and overrides', async () => {
  const [packageJson, workspace] = await Promise.all([
    readFile(new URL('package.json', root), 'utf8').then(JSON.parse),
    readFile(new URL('pnpm-workspace.yaml', root), 'utf8'),
  ]);
  const overrideSection = workspace.slice(workspace.indexOf('overrides:'));
  const removedOverrides = [
    '@vivliostyle/cli>dompurify',
    'press-ready>uuid',
    'prismjs',
    'trim',
    'valibot',
  ];

  assert.equal(packageJson.devDependencies['@vivliostyle/cli'], undefined);
  assert.equal(packageJson.devDependencies.rubygana, undefined);
  for (const name of removedOverrides) {
    assert.doesNotMatch(overrideSection, new RegExp(`['"]?${name}['"]?:`, 'u'));
  }
  assert.match(overrideSection, /['"]scratch-vm>uuid['"]:\s*11\.1\.1/u);
  assert.match(overrideSection, /['"]scratch-vm>worker-loader['"]:\s*['"]-['"]/u);
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
