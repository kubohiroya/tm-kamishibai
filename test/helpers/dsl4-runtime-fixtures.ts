import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

import {installDsl4PackagedRuntimeComponent} from '../../src/builder/index.js';
import {
  createDsl4EmbeddedAssetBundle,
  createDsl4EmbeddedSourceDescriptor,
  createDsl4RuntimeArtifactDescriptor,
} from '../../src/dsl4/index.js';
import type {RuntimeArtifact} from '../../src/dsl4/runtime-artifact-descriptor.js';
import type {Dsl4SourceFrontend} from '../../src/dsl4/source-frontend.js';

export const dsl4TestSubtleCrypto = webcrypto.subtle;

/** One asset record the fixture stories declare, as this helper reads it. */
interface FixtureAsset {
  id: string;
  kind?: unknown;
  loading?: unknown;
  name?: unknown;
  target?: unknown;
  delivery?: unknown;
  source?: Record<string, unknown>;
}

/** The StoryDocument members the asset snapshot is built from. */
interface FixtureStoryDocument {
  assets: Record<string, FixtureAsset>;
}

/** The inputs every packaged runtime fixture takes. */
interface FixtureOptions {
  sourceFrontend: Dsl4SourceFrontend;
  profile?: string | undefined;
  historyNavigationAvailable?: boolean | undefined;
  limits: {maxSourceBytes: number; maxAssetFiles: number; maxAssetBytes: number};
  sourceId?: string | undefined;
  displayName?: string | undefined;
  cacheIdentity?: unknown;
  subtleCrypto?: typeof dsl4TestSubtleCrypto | undefined;
  assetSnapshot?: unknown;
  baseProject?: ReturnType<typeof createDsl4EmptyProject> | undefined;
  channel?: 'bundled' | 'unbundled' | undefined;
}

export function createDsl4EmptyProject() {
  return {extensionStorage: {}, targets: [], monitors: []};
}

export function createDsl4EmbeddedAssetSnapshot(storyDocument: FixtureStoryDocument) {
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
  sourceText: string,
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
  }: FixtureOptions,
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
        assets:
          assetSnapshot ??
          createDsl4EmbeddedAssetSnapshot(parsed.storyDocument as unknown as FixtureStoryDocument),
      },
      // The manifest declares no assets, so the bundle never reaches for a file.
      getFile: (() => {}) as unknown as (assetId: string, filePath: string) => Uint8Array,
    },
    {maxFiles: limits.maxAssetFiles, maxTotalBytes: limits.maxAssetBytes, subtleCrypto},
  );
  return Object.freeze({
    storyDocument: parsed.storyDocument,
    sourceDescriptor,
    // The assertion above already rejected a failed descriptor, which `assert.equal` cannot narrow.
    runtimeArtifact: (artifactResult as unknown as {artifact: RuntimeArtifact}).artifact,
    assetBundle,
  });
}

export async function createDsl4PackagedRuntimeProject(
  sourceText: string,
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
  }: FixtureOptions,
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
  sourceText: string,
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
  }: FixtureOptions,
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
