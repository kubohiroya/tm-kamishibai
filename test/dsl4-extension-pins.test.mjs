import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {parse} from 'yaml';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const releasePins = JSON.parse(
  await readFile(new URL('fixtures/dsl4/release-pins.json', import.meta.url), 'utf8'),
);

test('pins every DSL4 extension to an exact npm release and matching lock entry', async () => {
  const [packageJsonSource, lockfileSource, workspaceSource] = await Promise.all([
    readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    readFile(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8'),
    readFile(path.join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageJsonSource);
  const lockfile = parse(lockfileSource);
  const workspace = parse(workspaceSource);
  const allowedBuilds = Object.keys(workspace.allowBuilds ?? {});
  const ageExclusions = new Set(workspace.minimumReleaseAgeExclude ?? []);

  assert.equal(releasePins.formatVersion, 1);
  for (const [name, version] of Object.entries(releasePins.extensions)) {
    assert.equal(packageJson.dependencies[name], version, `${name} package pin`);
    const patchHash = lockfile.patchedDependencies?.[`${name}@${version}`];
    const lockedVersion = patchHash ? `${version}(patch_hash=${patchHash})` : version;
    const importerDependency = lockfile.importers['.'].dependencies[name];
    assert.equal(importerDependency.specifier, version, `${name} lock specifier`);
    assert.equal(
      importerDependency.version === lockedVersion ||
        importerDependency.version.startsWith(`${lockedVersion}(`),
      true,
      `${name} lock version`,
    );
    const packageEntry = lockfile.packages[`${name}@${version}`];
    assert.equal(typeof packageEntry?.resolution?.integrity, 'string', `${name} lock integrity`);
    assert.match(packageEntry.resolution.integrity, /^sha512-/u);
    assert.equal(
      allowedBuilds.some((entry) => entry.startsWith(`${name}@`)),
      false,
      `${name} must use the prebuilt npm artifact`,
    );
    assert.equal(ageExclusions.has(`${name}@${version}`), true, `${name} exact age exception`);
  }
  assert.deepEqual(workspace.patchedDependencies ?? {}, {});
  assert.deepEqual(lockfile.patchedDependencies ?? {}, {});
});
