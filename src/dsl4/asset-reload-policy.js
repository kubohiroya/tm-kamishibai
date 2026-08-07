import {validateDsl4AssetBundleManifest} from './asset-bundle-descriptor.js';
import {createDsl4AssetDependencyIndex} from './asset-dependency-index.js';
import {computeDsl4Sha256Integrity} from './source-descriptor.js';
import {deepFreeze} from './story-document.js';

const sha256SRI = /^sha256-[A-Za-z0-9+/]{43}=$/u;
const liveReloadKinds = new Set(['backdrop', 'costume', 'image', 'poseModel', 'sound']);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name */
function integrity(value, name) {
  if (typeof value !== 'string' || !sha256SRI.test(value)) {
    throw new TypeError(`${name} must be a canonical SHA-256 SRI value`);
  }
  return value;
}

/** @param {unknown} value @returns {unknown} */
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

/** @param {unknown} value */
function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

/** @param {Readonly<Record<string, any>>} asset */
function graphSource(asset) {
  if (asset.source.type === 'file') {
    return {
      type: 'file',
      inputPath: asset.source.inputPath,
      mode: asset.source.mode,
      files: asset.source.files.map(
        (/** @type {Readonly<Record<string, any>>} */ file) => file.path,
      ),
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

/** @param {Readonly<Record<string, any>>} asset */
function contentSource(asset) {
  if (asset.source.type !== 'file') return graphSource(asset);
  return {
    ...graphSource(asset),
    files: asset.source.files.map((/** @type {Readonly<Record<string, any>>} */ file) => ({
      path: file.path,
      size: file.size,
      integrity: file.integrity,
    })),
  };
}

/** @param {Readonly<Record<string, any>>} asset @param {Function} source */
function normalizeAsset(asset, source) {
  return {
    id: asset.id,
    kind: asset.kind,
    loading: asset.loading,
    ...(asset.target === undefined ? {} : {target: asset.target}),
    source: source(asset),
  };
}

/** @param {ReadonlyArray<Readonly<Record<string, any>>>} assets */
function assetsById(assets) {
  return new Map(assets.map((asset) => [String(asset.id), asset]));
}

/** @param {Readonly<Record<string, any>>} snapshot */
function validateSnapshot(snapshot) {
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
  return /** @type {Readonly<Record<string, any>>} */ (snapshot);
}

/**
 * Build the redacted immutable snapshot used by the reload classifier. Asset bytes and local
 * absolute paths are deliberately excluded.
 *
 * @param {object} options
 * @param {Readonly<Record<string, unknown>>} options.storyDocument
 * @param {unknown} options.manifest
 * @param {string} options.structuralFingerprint
 * @param {string} options.sourceIntegrity
 * @param {{digest: Function}} [options.subtleCrypto]
 */
export async function createDsl4AssetReloadSnapshot({
  storyDocument,
  manifest: inputManifest,
  structuralFingerprint,
  sourceIntegrity,
  subtleCrypto = globalThis.crypto?.subtle,
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

/** @param {Readonly<Record<string, any>>} snapshot @param {ReadonlySet<string>} ids */
function affectedScenes(snapshot, ids) {
  return Object.entries(snapshot.dependencies.scenes)
    .filter(([, scene]) =>
      /** @type {Readonly<Record<string, any>>} */ (scene).all.some(
        (/** @type {string} */ assetId) => ids.has(assetId),
      ),
    )
    .map(([sceneId]) => sceneId)
    .sort();
}

/** @param {Readonly<Record<string, any>> | null} before @param {Readonly<Record<string, any>>} after */
function changedAsset(before, after) {
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

/** @param {string} kind @param {ReadonlyArray<unknown>} changedAssets @param {ReadonlyArray<string>} scenes */
function liveReloadResult(kind, changedAssets, scenes) {
  return deepFreeze({
    formatVersion: 1,
    kind,
    requiresFullRebuild: false,
    requiresNewPreviewSession: false,
    changedAssets,
    affectedScenes: scenes,
  });
}

/** @param {string} reason */
function fullRebuild(reason) {
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

/**
 * Classify source and asset changes without consulting file metadata or mutable runtime state.
 *
 * @param {object} options
 * @param {Readonly<Record<string, unknown>>} options.active
 * @param {Readonly<Record<string, unknown>>} options.candidate
 */
export function classifyDsl4AssetReload({active: inputActive, candidate: inputCandidate}) {
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
