import {deepFreeze} from './story-document.js';

/** @param {Iterable<string>} values */
function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** @param {unknown} value @param {Set<string>} dependencies */
function addDependency(value, dependencies) {
  if (typeof value === 'string') dependencies.add(value);
}

/**
 * @param {Readonly<Record<string, unknown>>} action
 * @param {Set<string>} dependencies
 * @param {Readonly<Record<string, Readonly<Record<string, unknown>>>>} speechStyles
 * @returns {boolean}
 */
function addActionDependencies(action, dependencies, speechStyles) {
  const command = String(action.command);
  const args = /** @type {Readonly<Record<string, unknown>>} */ (action.args ?? {});
  if (command === 'stage') addDependency(args.backdrop, dependencies);
  if (command === 'bgm' || command === 'sound') addDependency(args.sound, dependencies);
  if (command === 'say' || command === 'think') {
    addDependency(args.startSound, dependencies);
    addDependency(args.characterSound, dependencies);
    const style =
      typeof args.style === 'string'
        ? /** @type {Readonly<Record<string, unknown>> | undefined} */ (speechStyles[args.style])
        : undefined;
    addDependency(style?.characterSound, dependencies);
  }
  if (command === 'show' || command === 'setSkin') addDependency(args.skin, dependencies);
  if (command === 'loop' && Array.isArray(args.steps)) {
    for (const step of args.steps) {
      if (typeof step === 'object' && step !== null && !Array.isArray(step)) {
        addDependency(/** @type {Readonly<Record<string, unknown>>} */ (step).skin, dependencies);
      }
    }
  }
  if (command !== 'pose') return false;

  const steps = /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (args.steps ?? []);
  for (const step of steps) {
    addDependency(step.skin, dependencies);
    addDependency(step.sound, dependencies);
  }
  return true;
}

/**
 * Build the immutable preparation index consumed by runtime asset lifecycle adapters.
 *
 * Scene `eager` means the asset is already covered by the startup preparation set. Scene
 * `lazy` contains only direct dependencies that still need background preparation.
 *
 * @param {Readonly<Record<string, unknown>>} storyDocument
 */
export function createDsl4AssetDependencyIndex(storyDocument) {
  if (storyDocument.kind !== 'StoryDocument' || storyDocument.version !== '4.0') {
    throw new TypeError('DSL 4.0 asset dependency index requires a StoryDocument version 4.0');
  }

  const assets = /** @type {Readonly<Record<string, Readonly<Record<string, unknown>>>>} */ (
    storyDocument.assets ?? {}
  );
  const speechStyles = /** @type {Readonly<Record<string, Readonly<Record<string, unknown>>>>} */ (
    storyDocument.speechStyles ?? {}
  );
  const sceneRetainedAssets = new Set(
    Object.entries(assets)
      .filter(([, asset]) => asset.retention === 'scene')
      .map(([assetId]) => assetId),
  );
  const startup = new Set(
    Object.entries(assets)
      .filter(([, asset]) => asset.loading !== 'lazy')
      .map(([assetId]) => assetId),
  );

  const loading = /** @type {Readonly<Record<string, unknown>> | null} */ (
    storyDocument.loading ?? null
  );
  const loadingDependencies = new Set();
  if (loading) {
    addDependency(loading.backdrop, loadingDependencies);
    for (const costume of /** @type {ReadonlyArray<unknown>} */ (loading.costumes ?? [])) {
      addDependency(costume, loadingDependencies);
    }
    for (const assetId of loadingDependencies) startup.add(assetId);
  }

  const coverDependencies = new Set();
  const cover = /** @type {Readonly<Record<string, unknown>> | null} */ (
    storyDocument.cover ?? null
  );
  if (cover) {
    addDependency(cover.backdrop, coverDependencies);
    addDependency(cover.bgm, coverDependencies);
  }

  const actorDependencies = new Set();
  for (const costume of Object.values(
    /** @type {Readonly<Record<string, unknown>>} */ (storyDocument.actors ?? {}),
  )) {
    addDependency(costume, actorDependencies);
  }

  const poseRecognition = /** @type {Readonly<Record<string, unknown>> | null} */ (
    storyDocument.poseRecognition ?? null
  );
  const poseRecognitionDependencies = new Set();
  const posePreviewControlDependencies = new Set();
  if (poseRecognition) {
    addDependency(poseRecognition.idleSound, poseRecognitionDependencies);
    addDependency(poseRecognition.chargeSound, poseRecognitionDependencies);
    const preview = /** @type {Readonly<Record<string, unknown>>} */ (
      poseRecognition.preview ?? {}
    );
    const controls = /** @type {Readonly<Record<string, unknown>>} */ (preview.controls ?? {});
    const mirroring = /** @type {Readonly<Record<string, unknown>>} */ (controls.mirroring ?? {});
    const mirroringAssets = /** @type {Readonly<Record<string, unknown>>} */ (
      mirroring.assets ?? {}
    );
    const cameraMenu = /** @type {Readonly<Record<string, unknown>>} */ (controls.cameraMenu ?? {});
    addDependency(mirroringAssets.showMirrored, posePreviewControlDependencies);
    addDependency(mirroringAssets.showUnmirrored, posePreviewControlDependencies);
    addDependency(cameraMenu.buttonAsset, posePreviewControlDependencies);
    for (const assetId of posePreviewControlDependencies) startup.add(assetId);
  }

  const startupAssets = sortedUnique(startup);
  /** @type {Record<string, Readonly<Record<string, ReadonlyArray<string>>>>} */
  const scenes = {};
  for (const scene of /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (
    storyDocument.scenes ?? []
  )) {
    const dependencies = new Set();
    addDependency(scene.poseModel, dependencies);
    let usesPoseRecognition = false;
    for (const action of /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (
      scene.actions ?? []
    )) {
      usesPoseRecognition =
        addActionDependencies(action, dependencies, speechStyles) || usesPoseRecognition;
    }
    if (usesPoseRecognition) {
      for (const assetId of poseRecognitionDependencies) dependencies.add(assetId);
    }
    const all = sortedUnique(dependencies);
    scenes[String(scene.id)] = deepFreeze({
      all,
      eager: all.filter((assetId) => startup.has(assetId)),
      lazy: all.filter((assetId) => !startup.has(assetId)),
      sceneRetained: all.filter((assetId) => sceneRetainedAssets.has(assetId)),
    });
  }

  return deepFreeze({
    formatVersion: 1,
    startup: startupAssets,
    cover: sortedUnique(coverDependencies),
    actors: sortedUnique(actorDependencies),
    loading: sortedUnique(loadingDependencies),
    poseRecognition: sortedUnique(poseRecognitionDependencies),
    posePreviewControls: sortedUnique(posePreviewControlDependencies),
    sceneRetained: sortedUnique(sceneRetainedAssets),
    scenes,
  });
}
