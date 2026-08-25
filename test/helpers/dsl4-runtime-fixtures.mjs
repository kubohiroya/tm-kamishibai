import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

import {installDsl4PackagedRuntimeComponent} from '../../src/builder/index.js';
import {
  createDsl4EmbeddedAssetBundle,
  createDsl4EmbeddedSourceDescriptor,
  createDsl4RuntimeArtifactDescriptor,
} from '../../src/dsl4/index.js';

export const dsl4TestSubtleCrypto = webcrypto.subtle;

export function createDsl4EmptyProject() {
  return {extensionStorage: {}, targets: [], monitors: []};
}

export function createDsl4EmbeddedAssetSnapshot(storyDocument) {
  return Object.values(storyDocument.assets)
    .map((asset) => {
      const source =
        asset.delivery === 'remote'
          ? {type: 'remote', ...asset.source}
          : {type: 'project', name: asset.name};
      return {
        id: asset.id,
        kind: asset.kind,
        loading: asset.loading,
        ...(typeof asset.target === 'string' ? {target: asset.target} : {}),
        source,
      };
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export async function createDsl4PackagedRuntimeFixture(
  sourceText,
  {
    sourceFrontend,
    profile = 'production',
    historyNavigationAvailable = false,
    limits,
    sourceId = 'main',
    displayName = 'story.kamishibai.yaml',
    cacheIdentity,
    subtleCrypto = dsl4TestSubtleCrypto,
    assetSnapshot,
  },
) {
  const parsed = sourceFrontend.parse(sourceText, {
    sourceId,
    ...(historyNavigationAvailable ? {historyNavigationAvailable} : {}),
  });
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const sourceDescriptor = await createDsl4EmbeddedSourceDescriptor(sourceText, {
    sourceId,
    displayName,
    maxSourceBytes: limits.maxSourceBytes,
    ...(cacheIdentity === undefined ? {} : {cacheIdentity}),
    subtleCrypto,
  });
  const artifactResult = await createDsl4RuntimeArtifactDescriptor(
    parsed.storyDocument,
    sourceDescriptor,
    profile,
    {maxSourceBytes: limits.maxSourceBytes, historyNavigationAvailable, subtleCrypto},
  );
  assert.equal(artifactResult.ok, true, JSON.stringify(artifactResult.diagnostics));
  const assetBundle = await createDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    {
      manifest: {
        formatVersion: 1,
        assets: assetSnapshot ?? createDsl4EmbeddedAssetSnapshot(parsed.storyDocument),
      },
      getFile() {},
    },
    {maxFiles: limits.maxAssetFiles, maxTotalBytes: limits.maxAssetBytes, subtleCrypto},
  );
  return Object.freeze({
    storyDocument: parsed.storyDocument,
    sourceDescriptor,
    runtimeArtifact: artifactResult.artifact,
    assetBundle,
  });
}

export async function createDsl4PackagedRuntimeProject(
  sourceText,
  {
    baseProject = createDsl4EmptyProject(),
    channel = 'unbundled',
    sourceFrontend,
    profile = 'production',
    historyNavigationAvailable = false,
    limits,
    sourceId,
    displayName,
    cacheIdentity,
    subtleCrypto = dsl4TestSubtleCrypto,
    assetSnapshot,
  },
) {
  const {project} = await createDsl4InstalledRuntimeFixture(sourceText, {
    baseProject,
    channel,
    sourceFrontend,
    profile,
    historyNavigationAvailable,
    limits,
    sourceId,
    displayName,
    cacheIdentity,
    subtleCrypto,
    assetSnapshot,
  });
  return project;
}

export async function createDsl4InstalledRuntimeFixture(
  sourceText,
  {
    baseProject = createDsl4EmptyProject(),
    channel = 'unbundled',
    sourceFrontend,
    profile = 'production',
    historyNavigationAvailable = false,
    limits,
    sourceId,
    displayName,
    cacheIdentity,
    subtleCrypto = dsl4TestSubtleCrypto,
    assetSnapshot,
  },
) {
  const fixture = await createDsl4PackagedRuntimeFixture(sourceText, {
    sourceFrontend,
    profile,
    historyNavigationAvailable,
    limits,
    sourceId,
    displayName,
    cacheIdentity,
    subtleCrypto,
    assetSnapshot,
  });
  const project = await installDsl4PackagedRuntimeComponent(
    baseProject,
    fixture.storyDocument,
    fixture.sourceDescriptor,
    fixture.runtimeArtifact,
    fixture.assetBundle,
    {
      channel,
      ...limits,
      historyNavigationAvailable,
      subtleCrypto,
    },
  );
  return Object.freeze({...fixture, project});
}
