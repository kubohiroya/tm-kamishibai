import {validateDsl4AssetBundleManifest} from './asset-bundle-descriptor.js';
import {createDsl4AssetDependencyIndex} from './asset-dependency-index.js';
import {computeDsl4Sha256Integrity} from './source-descriptor.js';
import {deepFreeze} from './story-document.js';

const sha256SRI = /^sha256-[A-Za-z0-9+/]{43}=$/u;
const liveReloadKinds = new Set(['backdrop', 'costume', 'image', 'recognitionModel', 'sound']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integrity(value: unknown, name: string) {
  if (typeof value !== 'string' || !sha256SRI.test(value)) {
    throw new TypeError(`${name} must be a canonical SHA-256 SRI value`);
  }
  return value;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

function graphSource(asset: Readonly<Record<string, any>>) {
  if (asset.source.type === 'file') {
    return {
      type: 'file',
      inputPath: asset.source.inputPath,
      mode: asset.source.mode,
      files: asset.source.files.map((file: Readonly<Record<string, any>>) => file.path),
    };
  }
  if (asset.source.type === 'remote') {
    return {
      type: 'remote',
      url: asset.source.url,
      contentType: asset.source.contentType,
      size: asset.source.size,
      integrity: asset.source.integrity,
    };
  }
  return {type: 'project', name: asset.source.name};
}

function contentSource(asset: Readonly<Record<string, any>>) {
  if (asset.source.type !== 'file') return graphSource(asset);
  return {
    ...graphSource(asset),
    files: asset.source.files.map((file: Readonly<Record<string, any>>) => ({
      path: file.path,
      size: file.size,
      integrity: file.integrity,
    })),
  };
}

function normalizeAsset(asset: Readonly<Record<string, any>>, source: Function) {
  return {
    id: asset.id,
    kind: asset.kind,
    loading: asset.loading,
    ...(asset.target === undefined ? {} : {target: asset.target}),
    ...(asset.bitmapResolution === undefined ? {} : {bitmapResolution: asset.bitmapResolution}),
    source: source(asset),
  };
}

function assetsById(assets: ReadonlyArray<Readonly<Record<string, any>>>) {
  return new Map(assets.map((asset) => [String(asset.id), asset]));
}

function validateSnapshot(snapshot: Readonly<Record<string, any>>) {
  if (
    !isRecord(snapshot) ||
    snapshot.kind !== 'Dsl4AssetReloadSnapshot' ||
    snapshot.formatVersion !== 1 ||
    !Array.isArray(snapshot.graph) ||
    !Array.isArray(snapshot.content) ||
    !isRecord(snapshot.dependencies)
  ) {
    throw new TypeError('asset reload snapshot is invalid');
  }
  integrity(snapshot.structuralFingerprint, 'snapshot.structuralFingerprint');
  integrity(snapshot.sourceIntegrity, 'snapshot.sourceIntegrity');
  integrity(snapshot.graphIntegrity, 'snapshot.graphIntegrity');
  integrity(snapshot.contentIntegrity, 'snapshot.contentIntegrity');
  return snapshot as Readonly<Record<string, any>>;
}

/**
 * Build the redacted immutable snapshot used by the reload classifier. Asset bytes and local
 * absolute paths are deliberately excluded.
 */
export async function createDsl4AssetReloadSnapshot({
  storyDocument,
  manifest: inputManifest,
  structuralFingerprint,
  sourceIntegrity,
  subtleCrypto = globalThis.crypto?.subtle,
}: {
  storyDocument: Readonly<Record<string, unknown>>;
  manifest: unknown;
  structuralFingerprint: string;
  sourceIntegrity: string;
  subtleCrypto?: {digest: Function} | undefined;
}) {
  if (storyDocument.kind !== 'StoryDocument' || storyDocument.version !== '4.0') {
    throw new TypeError('asset reload snapshot requires a DSL 4.0 StoryDocument');
  }
  const manifest = validateDsl4AssetBundleManifest(storyDocument, inputManifest);
  const graph = manifest.assets.map((asset) => normalizeAsset(asset, graphSource));
  const content = manifest.assets.map((asset) => normalizeAsset(asset, contentSource));
  const graphIntegrity = await computeDsl4Sha256Integrity(
    new TextEncoder().encode(canonicalJson({formatVersion: 1, assets: graph})),
    subtleCrypto,
  );
  const contentIntegrity = await computeDsl4Sha256Integrity(
    new TextEncoder().encode(canonicalJson({formatVersion: 1, assets: content})),
    subtleCrypto,
  );
  return deepFreeze({
    kind: 'Dsl4AssetReloadSnapshot',
    formatVersion: 1,
    structuralFingerprint: integrity(structuralFingerprint, 'structuralFingerprint'),
    sourceIntegrity: integrity(sourceIntegrity, 'sourceIntegrity'),
    graphIntegrity,
    contentIntegrity,
    graph,
    content,
    dependencies: createDsl4AssetDependencyIndex(storyDocument),
  });
}

function affectedScenes(snapshot: Readonly<Record<string, any>>, ids: ReadonlySet<string>) {
  return Object.entries(snapshot.dependencies.scenes)
    .filter(([, scene]) =>
      (scene as Readonly<Record<string, any>>).all.some((assetId: string) => ids.has(assetId)),
    )
    .map(([sceneId]) => sceneId)
    .sort();
}

function changedAsset(
  before: Readonly<Record<string, any>> | null,
  after: Readonly<Record<string, any>>,
) {
  const beforeFiles = before?.source.type === 'file' ? before.source.files : [];
  const afterFiles = after.source.type === 'file' ? after.source.files : [];
  return {
    id: after.id,
    kind: after.kind,
    change: before ? 'content' : 'added',
    fileCount: afterFiles.length,
    beforeIntegrity: beforeFiles.length === 1 ? beforeFiles[0].integrity : before ? 'bundle' : null,
    afterIntegrity: afterFiles.length === 1 ? afterFiles[0].integrity : 'bundle',
  };
}

function liveReloadResult(
  kind: string,
  changedAssets: ReadonlyArray<unknown>,
  scenes: ReadonlyArray<string>,
) {
  return deepFreeze({
    formatVersion: 1,
    kind,
    requiresFullRebuild: false,
    requiresNewPreviewSession: false,
    changedAssets,
    affectedScenes: scenes,
  });
}

function fullRebuild(reason: string) {
  return deepFreeze({
    formatVersion: 1,
    kind: 'full-rebuild',
    requiresFullRebuild: true,
    requiresNewPreviewSession: true,
    reason,
    changedAssets: [],
    affectedScenes: [],
  });
}

/** Classify source and asset changes without consulting file metadata or mutable runtime state. */
export function classifyDsl4AssetReload({
  active: inputActive,
  candidate: inputCandidate,
}: {
  active: Readonly<Record<string, unknown>>;
  candidate: Readonly<Record<string, unknown>>;
}) {
  const active = validateSnapshot(inputActive);
  const candidate = validateSnapshot(inputCandidate);
  if (active.structuralFingerprint !== candidate.structuralFingerprint) {
    return fullRebuild('runtime-structure-changed');
  }

  const activeGraph = assetsById(active.graph);
  const candidateGraph = assetsById(candidate.graph);
  const removed = [...activeGraph.keys()].filter((assetId) => !candidateGraph.has(assetId));
  if (removed.length > 0) return fullRebuild('asset-removed');
  for (const [assetId, before] of activeGraph) {
    if (canonicalJson(before) !== canonicalJson(candidateGraph.get(assetId))) {
      return fullRebuild('asset-graph-changed');
    }
  }

  const addedIds = [...candidateGraph.keys()].filter((assetId) => !activeGraph.has(assetId));
  for (const assetId of addedIds) {
    const added = candidateGraph.get(assetId);
    if (
      !added ||
      !liveReloadKinds.has(String(added.kind)) ||
      added.source.type !== 'file' ||
      active.sourceIntegrity === candidate.sourceIntegrity
    ) {
      return fullRebuild('asset-addition-is-not-safe');
    }
  }

  const activeContent = assetsById(active.content);
  const candidateContent = assetsById(candidate.content);
  const changed = [];
  for (const [assetId, after] of candidateContent) {
    const before = activeContent.get(assetId) ?? null;
    if (canonicalJson(before) !== canonicalJson(after)) changed.push(changedAsset(before, after));
  }
  const changedIds = new Set(changed.map((asset) => asset.id));
  const scenes = affectedScenes(candidate, changedIds);
  const sourceChanged = active.sourceIntegrity !== candidate.sourceIntegrity;

  if (changed.length === 0 && !sourceChanged) {
    return liveReloadResult('no-change', [], []);
  }
  if (changed.length === 0) return liveReloadResult('source-live-reload', [], []);
  if (addedIds.length > 0) {
    return liveReloadResult('additive-composite-live-reload', changed, scenes);
  }
  if (sourceChanged) return liveReloadResult('composite-live-reload', changed, scenes);
  return liveReloadResult('asset-live-reload', changed, scenes);
}
