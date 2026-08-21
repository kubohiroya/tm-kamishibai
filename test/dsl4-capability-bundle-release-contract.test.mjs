import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {parse} from 'yaml';

import {downloadCatalog} from '../scripts/download-catalog.mjs';
import {createDsl4ReleaseSourceFiles} from '../scripts/sb3/dsl4-downloadable-release.mjs';
import {dsl4CoreActionManifest} from '../src/dsl4/core-action-manifest.js';
import {dsl4TurboWarpCoreActionBlockSpecs} from '../src/dsl4/platform/turbowarp-core-action-block.js';

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
  assert.equal(packageJson.version, contract.standardArtifact.version);
  assert.equal(packageJson.publishConfig.tag, contract.releaseLifecycle.npmDistTag);
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

test('ships the Standard artifact as one compact static extension bundle', async () => {
  const generatedFiles = await createDsl4ReleaseSourceFiles();
  const [entrypoint, authoringProfile] = await Promise.all([
    readRepositoryFile(contract.standardArtifact.entrypoint),
    readRepositoryFile('scripts/sb3/dsl4-runtime-authoring-profile.js'),
  ]);
  const projectSource = generatedFiles.get('project.source.json').toString('utf8');
  const bundleManifestSource = generatedFiles.get('embedded-extensions.json').toString('utf8');
  const project = JSON.parse(projectSource);
  const bundleManifest = JSON.parse(bundleManifestSource);
  const {extensionId, memberExtensionIds, runtimeComponentId} = contract.standardArtifact;

  assert.equal(contract.standardArtifact.integration, 'static-extension-bundle');
  assert.equal(contract.standardArtifact.recoveryCapsule, false);
  assert.equal(contract.standardArtifact.blockIconPolicy, 'member-blockIconURI');
  assert.equal(contract.standardArtifact.memberDocumentation.policy, 'member-docsURI-button');
  assert.deepEqual(
    Object.keys(contract.standardArtifact.memberDocumentation.urls),
    memberExtensionIds,
  );
  assert.equal(contract.standardArtifact.includesPreviewSurface, true);
  assert.equal(contract.standardArtifact.previewActivation, 'nonembedded-menu-default');
  assert.equal(contract.standardArtifact.embeddedStoryPreview, false);
  assert.deepEqual(project.extensions, memberExtensionIds);
  assert.deepEqual(Object.keys(project.extensionURLs), memberExtensionIds);
  assert.deepEqual(Object.keys(project.extensionStorage), [runtimeComponentId]);
  assert.deepEqual(bundleManifest.extensionBundles, [
    {
      id: extensionId,
      name: 'Kamishibai DSL 4.0 Runtime',
      members: memberExtensionIds,
      recoveryCapsule: contract.standardArtifact.recoveryCapsule,
    },
  ]);
  assert.deepEqual(
    bundleManifest.extensions.map(({id}) => id),
    memberExtensionIds,
  );
  assert.equal((entrypoint.match(/Scratch\.extensions\.register\(/gu) ?? []).length, 1);
  assert.match(entrypoint, new RegExp(`const extensionId = '${runtimeComponentId}'`));
  assert.match(entrypoint, /installDsl4RuntimeAuthoringProfile/u);
  assert.doesNotMatch(entrypoint, /createDsl4RuntimeSourceChooser/u);
  assert.doesNotMatch(entrypoint, /createDsl4BrowserPreviewRuntimeComponent/u);
  assert.match(authoringProfile, /dsl4NonEmbeddedDevelopmentFeatureFlags/u);
  assert.match(authoringProfile, /createDsl4RuntimeSourceChooser/u);
  assert.match(authoringProfile, /createDsl4BrowserPreviewRuntimeComponent/u);
  assert.match(
    entrypoint,
    new RegExp(
      contract.standardArtifact.memberDocumentation.urls[runtimeComponentId].replaceAll('/', '\\/'),
      'u',
    ),
  );
  assert.doesNotMatch(entrypoint, /kubohiroyaweblink/u);

  const opcodes = [...entrypoint.matchAll(/opcode: '([^']+)'/gu)].map((match) => match[1]);
  assert.deepEqual(opcodes, contract.standardArtifact.runtimeHiddenOpcodes);
  assert.equal((entrypoint.match(/hideFromPalette: true/gu) ?? []).length, opcodes.length);
  assert.deepEqual(
    contract.standardArtifact.runtimeVisibleOpcodes,
    dsl4CoreActionManifest.map(({command}) => command),
  );
  assert.deepEqual(
    dsl4TurboWarpCoreActionBlockSpecs.map(({command}) => command),
    contract.standardArtifact.runtimeVisibleOpcodes,
  );
  assert.match(entrypoint, /createDsl4TurboWarpCoreActionBlockSurface/u);
  for (const opcode of contract.standardArtifact.runtimeVisibleOpcodes) {
    assert.match(entrypoint, new RegExp(`\\n  ${opcode}\\(args\\)`, 'u'));
  }
  assert.doesNotMatch(JSON.stringify(project.extensionURLs), /https?:/u);

  const persisted = JSON.stringify(project);
  for (const field of [
    'previewBridge',
    'previewToken',
    'reloadCandidate',
    'reloadModalState',
    'reloadPreference',
    'debugExecutionMode',
    'debugPauseState',
    'debugPauseLocation',
  ]) {
    assert.equal(persisted.includes(field), false, field);
  }
});

test('generates Standard 4.0 transiently and treats legacy 3.2 as a release asset', () => {
  assert.deepEqual(contract.bundleBoundaries.standard4, {
    kind: 'generated-extensionBundles',
    unbundle: 'regenerate-current-source',
    provenance: [
      'scripts/sb3/dsl4-downloadable-release.mjs',
      'release-metadata/4.0.0-rc.9.json',
      'package.json',
      'pnpm-lock.yaml',
      'LICENSES.md',
    ],
  });
  assert.deepEqual(contract.bundleBoundaries.legacy32, {
    kind: 'github-release-asset',
    unbundle: 'release-asset',
    provenance: [
      'https://github.com/kubohiroya/tmpose-kamishibai/releases/download/v3.2.3/kamishibai-3.2.sb3',
    ],
  });
  assert.equal(contract.assetPolicy.remoteExtensionCode, 'forbidden');
  assert.equal(contract.assetPolicy.remoteAssetBytes, 'explicit-opt-in');
  assert.deepEqual(contract.assetPolicy.remoteAssetRequirements, [
    'https',
    'bare-pose-directory-or-complete-verification-metadata',
  ]);
  assert.equal(contract.previewPolicy.remotePreview, 'forbidden');
  assert.equal(contract.previewPolicy.localPreviewHost, 'tracked-by-issue-258');
  assert.equal(contract.previewPolicy.nonembeddedStandard, 'development-by-default');
  assert.equal(contract.previewPolicy.embeddedStory, 'production-no-preview');
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
    'set-release-candidate-version',
    'update-release-candidate-atomically',
    'run-full-verification',
    'check-release-candidate-without-mutation',
    'merge-release-candidate',
    'rerun-release-verification',
    'freeze-release-source-identity-and-artifact-hash',
    'create-version-tag',
    'publish-npm-package-with-next-dist-tag',
    'publish-github-prerelease',
    'record-publication',
    'publish-site-with-stable-recommendation-unchanged',
    'verify-publication',
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
  const metadata = JSON.parse(await readRepositoryFile(contract.releaseLifecycle.metadata));
  assert.match(metadata.artifact.sha256, /^[0-9a-f]{64}$/u);
  assert.match(metadata.sourceIdentity, /^sha256:[0-9a-f]{64}$/u);
  assert.match(metadata.artifact.url, /\/releases\/download\/v4\.0\.0-rc\.9\//u);
  if (metadata.state === 'published') {
    assert.deepEqual(release.artifact, {
      buildDate: metadata.buildDate,
      ...metadata.artifact,
      sourceIdentity: metadata.sourceIdentity,
    });
  } else {
    assert.equal(
      release.artifact,
      undefined,
      'An unpublished release must not be offered before its release asset exists.',
    );
  }

  assert.deepEqual(contract.releaseLifecycle, {
    metadata: 'release-metadata/4.0.0-rc.9.json',
    states: ['candidate', 'frozen', 'published'],
    updateCommand: 'pnpm release:dsl4:update',
    checkCommand: 'pnpm release:dsl4:check',
    freezeCommand: 'pnpm release:dsl4:freeze',
    publicationCommand: 'pnpm release:dsl4:record-publication',
    immutableStates: ['frozen', 'published'],
    nextCandidateVersion: '4.0.0-rc.10',
    npmDistTag: 'next',
    gitTag: 'v4.0.0-rc.9',
    githubPrerelease: true,
    recommendedStableVersion: '3.2.3',
  });

  for (const evidencePath of contract.evidence) {
    assert.ok((await readRepositoryFile(evidencePath)).length > 0, evidencePath);
  }
});
