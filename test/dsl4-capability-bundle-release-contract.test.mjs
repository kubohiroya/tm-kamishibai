import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {parse} from 'yaml';

import {downloadCatalog} from '../scripts/download-catalog.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const contract = JSON.parse(
  await readFile(
    new URL('fixtures/dsl4/capability-bundle-release-contract.json', import.meta.url),
    'utf8',
  ),
);

const readRepositoryFile = (filePath) => readFile(path.join(repositoryRoot, filePath), 'utf8');

test('freezes the #266 capability inventory to exact packages and lock integrity', async () => {
  const [packageJsonSource, lockfileSource, licenses] = await Promise.all([
    readRepositoryFile('package.json'),
    readRepositoryFile('pnpm-lock.yaml'),
    readRepositoryFile('LICENSES.md'),
  ]);
  const packageJson = JSON.parse(packageJsonSource);
  const lockfile = parse(lockfileSource);
  const ids = new Set();
  const extensionIds = new Set([contract.standardArtifact.extensionId]);

  for (const capability of contract.capabilities) {
    assert.equal(ids.has(capability.id), false, `duplicate capability: ${capability.id}`);
    ids.add(capability.id);
    assert.equal(
      extensionIds.has(capability.standaloneExtensionId),
      false,
      `duplicate extension ID: ${capability.standaloneExtensionId}`,
    );
    extensionIds.add(capability.standaloneExtensionId);
    if (capability.debugExtensionId) {
      assert.equal(extensionIds.has(capability.debugExtensionId), false);
      extensionIds.add(capability.debugExtensionId);
    }

    if (capability.provider !== 'npm') continue;
    assert.equal(packageJson.dependencies[capability.package], capability.version);
    const patchHash = lockfile.patchedDependencies?.[`${capability.package}@${capability.version}`];
    const lockedVersion = patchHash
      ? `${capability.version}(patch_hash=${patchHash})`
      : capability.version;
    const importerDependency = lockfile.importers['.'].dependencies[capability.package];
    assert.equal(importerDependency.specifier, capability.version);
    assert.equal(
      importerDependency.version === lockedVersion ||
        importerDependency.version.startsWith(`${lockedVersion}(`),
      true,
      `${capability.package} lock version`,
    );
    assert.match(
      lockfile.packages[`${capability.package}@${capability.version}`].resolution.integrity,
      /^sha512-/u,
    );
    assert.match(licenses, new RegExp(`${capability.package.replaceAll('/', '\\/')}\\s+\\|`));
  }

  for (const dependency of contract.supportPackages) {
    assert.equal(packageJson.dependencies[dependency.package], dependency.version);
    assert.match(licenses, new RegExp(`\\| ${dependency.package}\\s+\\|`));
  }
});

test('keeps every external capability on its reviewed composition boundary', async () => {
  for (const [specifier, filePaths] of Object.entries(contract.compositionImports)) {
    for (const filePath of filePaths) {
      const source = await readRepositoryFile(filePath);
      assert.match(source, new RegExp(`from ['\"]${specifier.replaceAll('/', '\\/')}['\"]`));
    }
  }
  assert.deepEqual(contract.apiCompatibility.sourceComposition, [
    'exact-package-version',
    'lockfile-integrity',
    'composition-export',
    'integration-tests',
  ]);
  assert.deepEqual(contract.apiCompatibility.staticBundleMember, [
    'api-manifest',
    'artifact-integrity',
    'saved-opcode-compatibility',
  ]);
});

test('ships the Standard artifact as one embedded runtime extension', async () => {
  const [projectSource, bundleManifestSource, entrypoint] = await Promise.all([
    readRepositoryFile(contract.standardArtifact.projectSource),
    readRepositoryFile(contract.standardArtifact.bundleManifest),
    readRepositoryFile(contract.standardArtifact.entrypoint),
  ]);
  const project = JSON.parse(projectSource);
  const bundleManifest = JSON.parse(bundleManifestSource);
  const {extensionId} = contract.standardArtifact;

  assert.equal(contract.standardArtifact.integration, 'single-embedded-extension');
  assert.deepEqual(project.extensions, [extensionId]);
  assert.deepEqual(project.extensionURLs, {
    [extensionId]: `embedded-extension:extensions/${extensionId}.js`,
  });
  assert.deepEqual(Object.keys(project.extensionStorage), [extensionId]);
  assert.equal(bundleManifest.extensionBundles, undefined);
  assert.deepEqual(
    bundleManifest.extensions.map(({id}) => id),
    [extensionId],
  );
  assert.equal((entrypoint.match(/Scratch\.extensions\.register\(/gu) ?? []).length, 1);
  assert.match(entrypoint, new RegExp(`const extensionId = '${extensionId}'`));
  assert.doesNotMatch(entrypoint, /kubohiroyaweblink/u);

  const opcodes = [...entrypoint.matchAll(/opcode: '([^']+)'/gu)].map((match) => match[1]);
  assert.deepEqual(opcodes, contract.standardArtifact.hiddenOpcodes);
  assert.equal((entrypoint.match(/hideFromPalette: true/gu) ?? []).length, opcodes.length);
  assert.deepEqual(contract.standardArtifact.visibleOpcodes, []);
  assert.doesNotMatch(JSON.stringify(project.extensionURLs), /https?:/u);

  const persisted = JSON.stringify(project);
  for (const field of [
    'previewBridge',
    'previewToken',
    'reloadCandidate',
    'reloadModalState',
    'reloadPreference',
  ]) {
    assert.equal(persisted.includes(field), false, field);
  }
});

test('uses one runtime extension for Standard 4.0 and keeps legacy 3.2 reversible', () => {
  assert.deepEqual(contract.bundleBoundaries.standard4, {
    kind: 'single-embedded-extension',
    unbundle: null,
    provenance: [
      'release-sources/4.0.0-dev/app/project.source.json',
      'release-sources/4.0.0-dev/app/embedded-extensions.json',
      'package.json',
      'pnpm-lock.yaml',
      'LICENSES.md',
    ],
  });
  assert.deepEqual(contract.bundleBoundaries.legacy32, {
    kind: 'extensionBundles',
    unbundle: 'recovery-capsule',
    provenance: ['app/project.source.json', 'app/embedded-extensions.json'],
  });
  assert.equal(contract.assetPolicy.remoteExtensionCode, 'forbidden');
  assert.equal(contract.assetPolicy.remoteAssetBytes, 'explicit-opt-in');
  assert.deepEqual(contract.assetPolicy.remoteAssetRequirements, [
    'https',
    'bare-pose-directory-or-complete-verification-metadata',
  ]);
  assert.equal(contract.previewPolicy.remotePreview, 'forbidden');
  assert.equal(contract.previewPolicy.localPreviewHost, 'tracked-by-issue-258');
});

test('keeps the 3.2 title state transition for Standard 4.0', () => {
  assert.match(contract.titleLifecycle.reference, /\/3\.2\/.*#%E7%8A%B6%E6%85%8B/u);
  assert.deepEqual(contract.titleLifecycle.greenFlag, ['initialize', 'showTitle', 'title']);
  assert.deepEqual(contract.titleLifecycle.closeInputs, ['stage-click', 'close-button']);
  assert.equal(contract.titleLifecycle.sharedBroadcast, 'closeTitle');
  assert.equal(contract.titleLifecycle.embeddedExit, 'startStory');
  assert.deepEqual(contract.titleLifecycle.externalExit, ['showCover', 'showMenu']);
  assert.deepEqual(contract.titleLifecycle.storyExit, ['stopStory', 'showCover', 'showMenu']);
  assert.equal(contract.titleLifecycle.storyExitShowsTitle, false);
});

test('pins a deterministic release, publication, and rollback sequence', async () => {
  assert.deepEqual(contract.releaseOrder, [
    'release-capability-packages',
    'update-exact-package-and-lock-pins',
    'set-release-version',
    'run-full-verification',
    'write-versioned-release-source',
    'verify-deterministic-sb3',
    'update-download-catalog-integrity-and-source-commit',
    'merge-with-provenance-preserving-strategy',
    'rerun-release-verification',
    'create-version-tag',
    'publish-npm-package',
    'publish-github-release',
    'publish-site',
  ]);
  assert.deepEqual(contract.rollbackOrder, [
    'disable-default-off-feature-surface',
    'deprecate-released-npm-version-if-required',
    'annotate-github-release',
    'restore-previous-recommended-download',
    'rerun-full-verification',
    'republish-site',
    'release-fix-as-next-patch',
  ]);

  const release = downloadCatalog.find(
    ({version}) => version === contract.standardArtifact.version,
  );
  assert.equal(release.artifact.sourceDirectory, 'release-sources/4.0.0/app');
  assert.match(release.artifact.sha256, /^[0-9a-f]{64}$/u);
  assert.match(release.artifact.sourceCommit, /^[0-9a-f]{40}$/u);

  for (const evidencePath of contract.evidence) {
    assert.ok((await readRepositoryFile(evidencePath)).length > 0, evidencePath);
  }
});
