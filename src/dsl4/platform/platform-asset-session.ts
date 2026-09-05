import {createAssetManagerComposition as createDefaultAssetManagerComposition} from '@kubohiroya/turbowarp-asset-manager/composition';
import {createAsyncInputComposition as createDefaultAsyncInputComposition} from '@kubohiroya/turbowarp-async-input/composition';

import {validateCompositionMethods} from './composition-contract.js';
import {
  createDsl4EmbeddedAssetLifecycle,
  createDsl4RemoteAssetLifecycle,
} from '../embedded-asset-lifecycle.js';
import {validateDsl4CacheIdentity} from '../cache-identity.js';
import type {Dsl4SubtleCrypto} from '../subtle-crypto.js';
import {createDsl4AssetManagerAdapter} from './asset-manager-adapter.js';
import {createDsl4PlatformAssetAdapter} from './asset-adapter-router.js';
import {createDsl4BinaryEntryBacking} from './binary-entry-backing.js';
import {createDsl4PoseActionPort} from './pose-action-port.js';
import {
  createDsl4PoseArchiveExtractor,
  dsl4PoseArchiveDefaultLimits,
  isDsl4RemotePoseArchiveUrl,
} from './pose-archive-extractor.js';
import {createDsl4TMPlatform} from './tm-model-adapter.js';
import {
  createDsl4StoryCameraLifecycle,
  storyUsesPoseRecognition,
} from './story-camera-lifecycle.js';
import {encodeDsl4StoryPathSegment} from '../story-path.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const posePreviewMirroringModes = new Set(['mirrored', 'unmirrored']);

function validateRuntimeComponent(value: unknown, binaryEntryEnabled: boolean) {
  const component = isRecord(value) ? value : {};
  const storyDocument = isRecord(component.storyDocument) ? component.storyDocument : null;
  const assetBundle = isRecord(component.assetBundle) ? component.assetBundle : null;
  const manifest = isRecord(assetBundle?.manifest) ? assetBundle.manifest : null;
  if (
    storyDocument?.kind !== 'StoryDocument' ||
    storyDocument.version !== '4.0' ||
    !Array.isArray(manifest?.assets) ||
    (binaryEntryEnabled
      ? typeof assetBundle?.integrity !== 'string' || !Array.isArray(assetBundle?.files)
      : typeof component.getAssetFile !== 'function')
  ) {
    throw new TypeError('runtimeComponent must provide a validated StoryDocument and asset bundle');
  }
  const ids = new Set();
  for (const asset of manifest.assets) {
    if (!isRecord(asset) || typeof asset.id !== 'string' || ids.has(asset.id)) {
      throw new TypeError('asset bundle manifest must contain unique asset records');
    }
    ids.add(asset.id);
  }
  return component;
}

function validateTMRuntime(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.Webcam !== 'function' ||
    typeof value.loadFromFiles !== 'function'
  ) {
    throw new TypeError('tmPoseRuntime must provide Webcam and loadFromFiles');
  }
  return value;
}

/**
 * Release compositions created before a complete session could be published.
 *
 * Async cleanup cannot be awaited by this synchronous factory, but each composition is still
 * empty at this point. Rejections are contained to avoid an unhandled cleanup failure.
 */
function failCreation(compositions: unknown[], failure: unknown): never {
  const cleanupErrors = [];
  for (const composition of [...compositions].reverse()) {
    if (!isRecord(composition) || typeof composition.releaseAll !== 'function') continue;
    try {
      void Promise.resolve(composition.releaseAll()).catch(() => {});
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [failure, ...cleanupErrors],
      'DSL 4.0 platform asset session creation failed during cleanup',
    );
  }
  throw failure;
}

function disposedError() {
  const error = new Error('DSL 4.0 platform asset session is disposing or disposed');
  Object.defineProperty(error, 'code', {value: 'K4-PLATFORM-ASSET-SESSION-001'});
  return error;
}

/** Keep the pose overlay source opt-in at the DSL boundary. */
function configurePoseOverlay(
  composition: Record<
    | 'hidePoseOverlay'
    | 'showPoseOverlay'
    | 'setPoseJointStyle'
    | 'setPoseBoneStyle'
    | 'setPoseOverlayMinimumConfidence'
    | 'setPoseOverlayConfidenceScaling',
    (...parameters: any[]) => any
  >,
  overlay: Record<string, unknown> | null,
) {
  if (!overlay) {
    composition.hidePoseOverlay?.();
    return;
  }
  const jointStyles = isRecord(overlay.jointStyles) ? overlay.jointStyles : {};
  for (const [part, style] of Object.entries(jointStyles)) {
    composition.setPoseJointStyle(part, style);
  }
  if (isRecord(overlay.boneStyle)) composition.setPoseBoneStyle(overlay.boneStyle);
  if (typeof overlay.minimumConfidence === 'number') {
    composition.setPoseOverlayMinimumConfidence(overlay.minimumConfidence);
  }
  if (isRecord(overlay.confidenceScaling)) {
    composition.setPoseOverlayConfidenceScaling(overlay.confidenceScaling);
  }
  if (overlay.visible === false) composition.hidePoseOverlay();
  else composition.showPoseOverlay();
}

/**
 * Create one app-shell-scoped asset session after the DSL 4.0 runtime component is validated.
 * This module intentionally remains outside the default-off core index. The app shell creates a
 * session only from the enabled startup path and captures both compositions for later action-port
 * construction.
 */
export function createDsl4PlatformAssetSession(options: {
  runtimeComponent: unknown;
  runtime?: unknown;
  binaryEntryProvider?: unknown;
  binarySessionBackingPolicy?: 'prefer' | 'required' | 'disabled';
  binarySessionId?: string;
  sessionBinaryBackingOptions?: Readonly<Record<string, unknown>>;
  onBinarySessionBackingWarning?: (warning: Readonly<Record<string, unknown>>) => unknown;
  onBinarySessionBackingFatalError?: (error: unknown) => unknown;
  tmPoseRuntime: unknown;
  setLoading: (
    payload: Readonly<Record<string, unknown>>,
    context: Readonly<Record<string, unknown>>,
  ) => unknown | Promise<unknown>;
  setBusy?: (
    payload: Readonly<{visible: boolean; source: string; label: string; cursor?: string}>,
  ) => unknown | Promise<unknown>;
  setCursor?: (
    payload: Readonly<{visible: boolean; source: string; cursor: string}>,
  ) => unknown | Promise<unknown>;
  loadRemoteAsset?: (
    payload: Readonly<Record<string, unknown>>,
    context: Readonly<Record<string, unknown>>,
  ) => unknown | Promise<unknown>;
  cacheIdentity?: unknown;
  verifiedRemoteCacheOptions?: Readonly<Record<string, unknown>>;
  poseArchiveLimits?: Readonly<Record<string, unknown>>;
  subtleCrypto?: Dsl4SubtleCrypto | undefined;
  createFile?: Function;
  createAssetManagerComposition?: Function;
  createTMComposition?: Function;
  createAsyncInputComposition?: Function;
  keySource?: unknown;
  actorTouchSource?: unknown;
  poseSchedule?: Function;
  poseNow?: Function;
  poseFeedbackEnabled?: boolean;
  onPoseState?: (event: Readonly<Record<string, unknown>>) => unknown | undefined;
  posePreviewMirroringEnabled?: boolean;
  readPoseStateBinding?: () => Readonly<{confidence?: number; progress?: number}> | null;
  cameraPreviewControlsEnabled?: boolean;
  cameraPreviewMirroringControlEnabled?: boolean;
  cameraMenuControlEnabled?: boolean;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  onPreviewMirroringChange?: (mode: 'mirrored' | 'unmirrored') => void;
}) {
  if (!isRecord(options)) throw new TypeError('platform asset session options must be an object');
  const binaryEntryEnabled = options.binaryEntryProvider !== undefined;
  const runtimeComponent = validateRuntimeComponent(options.runtimeComponent, binaryEntryEnabled);
  const tmPoseRuntime = validateTMRuntime(options.tmPoseRuntime);
  if (typeof options.setLoading !== 'function') {
    throw new TypeError('setLoading must be a function');
  }
  if (options.setBusy !== undefined && typeof options.setBusy !== 'function') {
    throw new TypeError('setBusy must be a function');
  }
  if (options.setCursor !== undefined && typeof options.setCursor !== 'function') {
    throw new TypeError('setCursor must be a function');
  }
  if (options.loadRemoteAsset !== undefined && typeof options.loadRemoteAsset !== 'function') {
    throw new TypeError('loadRemoteAsset must be a function');
  }
  const componentAssetBundle = runtimeComponent.assetBundle as Record<string, any>;
  const remoteRequired = componentAssetBundle.manifest.assets.some(
    (asset: unknown) => isRecord(asset) && isRecord(asset.source) && asset.source.type === 'remote',
  );
  const verifiedRemoteRequired = componentAssetBundle.manifest.assets.some(
    (asset: unknown) =>
      isRecord(asset) &&
      isRecord(asset.source) &&
      asset.source.type === 'remote' &&
      typeof asset.source.integrity === 'string',
  );
  const remoteEnabled = remoteRequired && typeof options.loadRemoteAsset === 'function';
  const verifiedRemoteEnabled = remoteEnabled && verifiedRemoteRequired;
  const remoteLoader = remoteEnabled
    ? (options.loadRemoteAsset as (
        payload: Readonly<Record<string, unknown>>,
        context: Readonly<Record<string, unknown>>,
      ) => unknown | Promise<unknown>)
    : null;
  let cacheIdentity = null;
  if (verifiedRemoteEnabled || binaryEntryEnabled) {
    if (options.cacheIdentity === undefined) {
      throw new TypeError(
        'cacheIdentity must be an object when verified remote or binary-entry loading is enabled',
      );
    }
    cacheIdentity = validateDsl4CacheIdentity(options.cacheIdentity);
  }
  const remotePoseArchiveRequired = componentAssetBundle.manifest.assets.some(
    (asset: unknown) =>
      isRecord(asset) &&
      asset.kind === 'recognitionModel' &&
      isRecord(asset.source) &&
      asset.source.type === 'remote' &&
      (typeof asset.source.integrity === 'string' || isDsl4RemotePoseArchiveUrl(asset.source.url)),
  );
  if (
    options.verifiedRemoteCacheOptions !== undefined &&
    !isRecord(options.verifiedRemoteCacheOptions)
  ) {
    throw new TypeError('verifiedRemoteCacheOptions must be an object');
  }
  if (
    options.sessionBinaryBackingOptions !== undefined &&
    !isRecord(options.sessionBinaryBackingOptions)
  ) {
    throw new TypeError('sessionBinaryBackingOptions must be an object');
  }
  if (binaryEntryEnabled) {
    if (
      typeof options.binarySessionBackingPolicy !== 'string' ||
      !['prefer', 'required', 'disabled'].includes(options.binarySessionBackingPolicy)
    ) {
      throw new TypeError(
        'binarySessionBackingPolicy must be prefer, required, or disabled for binary-entry loading',
      );
    }
    if (typeof options.binarySessionId !== 'string' || options.binarySessionId.length === 0) {
      throw new TypeError('binarySessionId must be a non-empty string for binary-entry loading');
    }
  }
  if (
    options.onBinarySessionBackingWarning !== undefined &&
    typeof options.onBinarySessionBackingWarning !== 'function'
  ) {
    throw new TypeError('onBinarySessionBackingWarning must be a function');
  }
  if (
    options.onBinarySessionBackingFatalError !== undefined &&
    typeof options.onBinarySessionBackingFatalError !== 'function'
  ) {
    throw new TypeError('onBinarySessionBackingFatalError must be a function');
  }
  if (options.createFile !== undefined && typeof options.createFile !== 'function') {
    throw new TypeError('createFile must be a function');
  }
  const poseArchiveExtractor =
    remoteEnabled && remotePoseArchiveRequired
      ? createDsl4PoseArchiveExtractor({
          limits: options.poseArchiveLimits ?? dsl4PoseArchiveDefaultLimits,
          subtleCrypto: options.subtleCrypto,
        })
      : null;
  const createAssetManager =
    options.createAssetManagerComposition ?? createDefaultAssetManagerComposition;
  if (typeof createAssetManager !== 'function') {
    throw new TypeError('createAssetManagerComposition must be a function');
  }
  if (
    options.createTMComposition !== undefined &&
    typeof options.createTMComposition !== 'function'
  ) {
    throw new TypeError('createTMComposition must be a function');
  }
  const createAsyncInput =
    options.createAsyncInputComposition ?? createDefaultAsyncInputComposition;
  if (typeof createAsyncInput !== 'function') {
    throw new TypeError('createAsyncInputComposition must be a function');
  }
  if (options.poseSchedule !== undefined && typeof options.poseSchedule !== 'function') {
    throw new TypeError('poseSchedule must be a function');
  }
  if (options.poseNow !== undefined && typeof options.poseNow !== 'function') {
    throw new TypeError('poseNow must be a function');
  }
  const poseFeedbackEnabled = options.poseFeedbackEnabled ?? false;
  if (typeof poseFeedbackEnabled !== 'boolean') {
    throw new TypeError('poseFeedbackEnabled must be boolean');
  }
  if (poseFeedbackEnabled && typeof options.onPoseState !== 'function') {
    throw new TypeError('onPoseState must be a function when pose feedback is enabled');
  }
  const posePreviewMirroringEnabled = options.posePreviewMirroringEnabled ?? false;
  if (typeof posePreviewMirroringEnabled !== 'boolean') {
    throw new TypeError('posePreviewMirroringEnabled must be boolean');
  }
  if (
    poseFeedbackEnabled &&
    options.readPoseStateBinding !== undefined &&
    typeof options.readPoseStateBinding !== 'function'
  ) {
    throw new TypeError('readPoseStateBinding must be a function');
  }
  const cameraPreviewControlsEnabled = options.cameraPreviewControlsEnabled ?? false;
  if (typeof cameraPreviewControlsEnabled !== 'boolean') {
    throw new TypeError('cameraPreviewControlsEnabled must be boolean');
  }
  const cameraPreviewMirroringControlEnabled =
    options.cameraPreviewMirroringControlEnabled ?? cameraPreviewControlsEnabled;
  const cameraMenuControlEnabled = options.cameraMenuControlEnabled ?? cameraPreviewControlsEnabled;
  if (typeof cameraPreviewMirroringControlEnabled !== 'boolean') {
    throw new TypeError('cameraPreviewMirroringControlEnabled must be boolean');
  }
  if (typeof cameraMenuControlEnabled !== 'boolean') {
    throw new TypeError('cameraMenuControlEnabled must be boolean');
  }
  if (posePreviewMirroringEnabled || cameraPreviewMirroringControlEnabled) {
    if (
      options.onPreviewMirroringChange !== undefined &&
      typeof options.onPreviewMirroringChange !== 'function'
    ) {
      throw new TypeError('onPreviewMirroringChange must be a function');
    }
  }

  function notifyCameraBusy(visible: boolean) {
    if (typeof options.setBusy !== 'function') return;
    try {
      void Promise.resolve(
        options.setBusy(
          Object.freeze({
            visible,
            source: 'camera',
            label: 'Starting camera',
            cursor: 'wait',
          }),
        ),
      ).catch(() => {});
    } catch {
      // Busy indicators are non-authoritative and cannot change camera selection semantics.
    }
  }

  async function withCameraBusy<T>(operation: () => Promise<T> | T) {
    notifyCameraBusy(true);
    try {
      return await operation();
    } finally {
      notifyCameraBusy(false);
    }
  }

  const created = [];
  try {
    const compositionOptions = {
      ...(verifiedRemoteEnabled
        ? {
            verifiedRemoteCache: {
              ...options.verifiedRemoteCacheOptions,
              cacheIdentity,
            },
          }
        : {}),
      ...(binaryEntryEnabled
        ? {
            sessionBinaryBacking: {
              ...options.sessionBinaryBackingOptions,
              ...(options.subtleCrypto === undefined ? {} : {subtleCrypto: options.subtleCrypto}),
            },
          }
        : {}),
    };
    const assetManagerCandidate =
      verifiedRemoteEnabled || binaryEntryEnabled
        ? createAssetManager(undefined, compositionOptions)
        : createAssetManager();
    created.push(assetManagerCandidate);
    const assetManagerBaseMethods = [
      'registerProjectAsset',
      'registerEmbeddedAsset',
      'releaseAsset',
      'releaseAll',
      'isRegistered',
      'getMimeType',
      'applyToStage',
      'applyToTarget',
      'playSound',
      'stopSound',
      'stopAllSounds',
    ] as const;
    const verifiedRemoteMethods = [
      'resolveVerifiedRemoteBinary',
      'getVerifiedRemoteCacheStats',
      'pruneVerifiedRemoteCache',
      'clearVerifiedRemoteCache',
      'listVerifiedRemoteStoryCaches',
      'pruneVerifiedRemoteStoryCaches',
      'deleteVerifiedRemoteStoryCache',
      'renewVerifiedRemoteStoryCacheLease',
      'releaseVerifiedRemoteStoryCacheLease',
    ] as const;
    const binaryEntryMethods = ['createSessionBinaryBacking'] as const;
    // The feature flags decide what has to be present, while the type names every method the
    // session can reach; each optional group is behind the same flag at its call sites.
    const assetManagerComposition = validateCompositionMethods<
      | (typeof assetManagerBaseMethods)[number]
      | (typeof verifiedRemoteMethods)[number]
      | (typeof binaryEntryMethods)[number],
      // Crossfade audio is used when the composition offers it and falls back when it does not.
      'createAudioVoice'
    >(assetManagerCandidate, 'Asset Manager composition', [
      ...assetManagerBaseMethods,
      ...(verifiedRemoteEnabled ? verifiedRemoteMethods : []),
      ...(binaryEntryEnabled ? binaryEntryMethods : []),
    ]);
    const binaryAssetBacking = binaryEntryEnabled
      ? createDsl4BinaryEntryBacking({
          runtimeComponent,
          provider: options.binaryEntryProvider,
          composition: assetManagerComposition,
          namespace: (cacheIdentity as Record<string, any>).id,
          policy: options.binarySessionBackingPolicy as 'prefer' | 'required' | 'disabled',
          sessionId: options.binarySessionId as string,
          ...(options.onBinarySessionBackingWarning === undefined
            ? {}
            : {onWarning: options.onBinarySessionBackingWarning}),
          ...(options.onBinarySessionBackingFatalError === undefined
            ? {}
            : {onFatalError: options.onBinarySessionBackingFatalError}),
        })
      : null;
    if (binaryAssetBacking) {
      created.push(Object.freeze({releaseAll: () => binaryAssetBacking.dispose()}));
    }
    const mediaAdapter = createDsl4AssetManagerAdapter({
      composition: assetManagerComposition,
      ...(options.runtime === undefined ? {} : {runtime: options.runtime}),
      ...(options.createObjectURL === undefined ? {} : {createObjectURL: options.createObjectURL}),
      ...(options.revokeObjectURL === undefined ? {} : {revokeObjectURL: options.revokeObjectURL}),
    });

    const storyDocument = runtimeComponent.storyDocument as Record<string, unknown>;
    const recognition = isRecord(storyDocument.recognition) ? storyDocument.recognition : {};
    const posePreview = isRecord(recognition.preview) ? recognition.preview : {};
    const poseOverlay = isRecord(posePreview.overlay) ? posePreview.overlay : null;
    const modelInitialization = isRecord(recognition.modelInitialization)
      ? recognition.modelInitialization
      : {};
    const modelInitializationPolicy =
      modelInitialization.policy === 'latest-needed' ? 'latest-needed' : 'legacy';
    const parallelModelInitialization =
      typeof modelInitialization.parallel === 'boolean' ? modelInitialization.parallel : false;

    const tmPlatform = createDsl4TMPlatform({
      runtime: tmPoseRuntime,
      modelInitializationPolicy,
      parallelModelInitialization,
      ...(options.createFile === undefined ? {} : {createFile: options.createFile}),
      ...(options.createTMComposition === undefined
        ? {}
        : {createComposition: options.createTMComposition}),
    });
    created.push(tmPlatform.composition);
    const tmBaseMethods = [
      'registerPoseModel',
      'activatePoseModel',
      'releasePoseModel',
      'releaseAll',
      'isPoseModelRegistered',
      'getActivePoseModelName',
      'showPreview',
      'hidePreview',
      'isPreviewVisible',
      'setPreviewPosition',
      'startCamera',
      'stopCamera',
      'isCameraRunning',
      'startRecognition',
      'stopRecognition',
      'isRecognizing',
      'currentPose',
      'confidence',
      'confidenceOf',
      'configureAccumulatedPose',
      'resetAccumulatedPose',
      'subscribeAccumulatedPose',
    ] as const;
    const tmMirroringMethods = ['setPreviewMirroring'] as const;
    const tmPoseOverlayMethods = [
      'showPoseOverlay',
      'hidePoseOverlay',
      'setPoseJointStyle',
      'setPoseBoneStyle',
      'setPoseOverlayMinimumConfidence',
      'setPoseOverlayConfidenceScaling',
    ] as const;
    const tmCameraMenuMethods = [
      'listCameraDevices',
      'selectCamera',
      'getCameraSelection',
      'getActiveCamera',
    ] as const;
    // As above: the flags decide what must exist, the type names everything the session can reach.
    const tmComposition = validateCompositionMethods<
      | (typeof tmBaseMethods)[number]
      | (typeof tmMirroringMethods)[number]
      | (typeof tmPoseOverlayMethods)[number]
      | (typeof tmCameraMenuMethods)[number]
    >(tmPlatform.composition, 'TM composition', [
      ...tmBaseMethods,
      ...(posePreviewMirroringEnabled || cameraPreviewMirroringControlEnabled
        ? tmMirroringMethods
        : []),
      ...(poseOverlay ? tmPoseOverlayMethods : []),
      ...(cameraMenuControlEnabled ? tmCameraMenuMethods : []),
    ]);
    configurePoseOverlay(tmComposition, poseOverlay);
    const storyCameraLifecycle = storyUsesPoseRecognition(runtimeComponent.storyDocument)
      ? createDsl4StoryCameraLifecycle({
          composition: tmComposition,
          ...(options.setBusy === undefined ? {} : {setBusy: options.setBusy}),
        })
      : null;
    const asyncInputCandidate = createAsyncInput({
      poseSource: tmComposition,
      ...(options.keySource === undefined ? {} : {keySource: options.keySource}),
      ...(options.actorTouchSource === undefined
        ? {}
        : {actorTouchSource: options.actorTouchSource}),
    });
    created.push(asyncInputCandidate);
    const asyncInputComposition = validateCompositionMethods(
      asyncInputCandidate,
      'Async Input composition',
      ['waitForPoseCandidate', 'waitForKeyCandidate', 'waitForActorTouchCandidate', 'releaseAll'],
    );
    const poseActionPort = createDsl4PoseActionPort({
      tmComposition,
      asyncInputComposition,
      getPoseModelLabels: (poseModel) => tmPlatform.adapter.getPoseModelLabels(poseModel),
      playSound: (sound, playOptions) => assetManagerComposition.playSound(sound, playOptions),
      stopSound: (sound) => assetManagerComposition.stopSound(sound),
      ...(options.poseSchedule === undefined
        ? {}
        : {
            schedule: options.poseSchedule as (
              callback: () => void,
              delayMilliseconds: number,
            ) => () => void,
          }),
      ...(options.poseNow === undefined ? {} : {now: options.poseNow as () => number}),
      ...(options.setBusy === undefined ? {} : {setBusy: options.setBusy}),
      ...(options.setCursor === undefined ? {} : {setCursor: options.setCursor}),
      ...(storyCameraLifecycle === null
        ? {}
        : {ensureCameraStarted: () => storyCameraLifecycle.start()}),
      ...(poseFeedbackEnabled ? {onPoseState: options.onPoseState} : {}),
      ...(poseFeedbackEnabled && options.readPoseStateBinding !== undefined
        ? {readPoseStateBinding: options.readPoseStateBinding}
        : {}),
    });
    const adapter = createDsl4PlatformAssetAdapter({
      mediaAdapter,
      poseAdapter: tmPlatform.adapter,
    });
    const cacheWarnings: Readonly<Record<string, unknown>>[] = [];

    async function resolveVerifiedRemoteAsset(
      payload: Readonly<Record<string, any>>,
      context: Readonly<Record<string, any>>,
    ) {
      async function loadVerifiedRemote(
        input: Readonly<Record<string, any>>,
        loadContext: Readonly<Record<string, any>>,
      ) {
        if (!remoteLoader) throw new TypeError('Remote loader is unavailable');
        const loaded = await remoteLoader(
          Object.freeze({assetId: payload.assetId, ...input}),
          Object.freeze({...context, signal: loadContext.signal}),
        );
        if (!isRecord(loaded)) return loaded;
        return {
          bytes: loaded.bytes,
          contentType: loaded.contentType,
          ...(loaded.transferOwnership === true ? {transferOwnership: true} : {}),
        };
      }
      const result = await assetManagerComposition.resolveVerifiedRemoteBinary(
        {
          url: payload.url,
          integrity: payload.integrity,
          size: payload.size,
          contentType: payload.contentType,
        },
        {
          signal: context.signal,
          load: loadVerifiedRemote,
        },
      );
      if (Array.isArray(result.cacheWarnings)) {
        for (const warning of result.cacheWarnings) {
          if (!isRecord(warning)) continue;
          cacheWarnings.push(
            Object.freeze({
              assetId: payload.assetId,
              storyPath: `/assets/${encodeDsl4StoryPathSegment(String(payload.assetId))}`,
              operation: warning.operation,
              code: warning.code,
            }),
          );
        }
        if (cacheWarnings.length > 128) cacheWarnings.splice(0, cacheWarnings.length - 128);
      }
      return result;
    }
    const lifecycleOptions = {
      runtimeComponent,
      adapter,
      setLoading: options.setLoading,
      ...(binaryAssetBacking
        ? {
            resolveEmbeddedAssetFiles(assetId: string, context: Readonly<Record<string, any>>) {
              return binaryAssetBacking.getAssetFiles(assetId, {signal: context.signal});
            },
          }
        : {}),
      ...(verifiedRemoteEnabled ? {resolveVerifiedRemoteAsset} : {}),
      ...(remoteEnabled
        ? {
            loadRemoteAsset: remoteLoader as (
              payload: Readonly<Record<string, unknown>>,
              context: Readonly<Record<string, unknown>>,
            ) => unknown | Promise<unknown>,
          }
        : {}),
      ...(poseArchiveExtractor ? {extractRemotePoseArchive: poseArchiveExtractor} : {}),
    };
    const assetLifecycle = remoteEnabled
      ? createDsl4RemoteAssetLifecycle(lifecycleOptions)
      : createDsl4EmbeddedAssetLifecycle(lifecycleOptions);

    let disposePromise: Promise<void> | null = null;
    const posePreviewPort = posePreviewMirroringEnabled
      ? Object.freeze({
          setPosePreviewMirroring(mode: unknown) {
            if (disposePromise) throw disposedError();
            if (typeof mode !== 'string' || !posePreviewMirroringModes.has(mode)) {
              throw new TypeError('pose preview mirroring mode is invalid');
            }
            tmComposition.setPreviewMirroring(mode);
            options.onPreviewMirroringChange?.(mode as 'mirrored' | 'unmirrored');
          },
        })
      : null;
    const cameraPreviewControlsPort = cameraPreviewControlsEnabled
      ? Object.freeze({
          ...(cameraPreviewMirroringControlEnabled
            ? {
                setPreviewMirroring(mode: unknown) {
                  if (disposePromise) throw disposedError();
                  if (typeof mode !== 'string' || !posePreviewMirroringModes.has(mode)) {
                    throw new TypeError('pose preview mirroring mode is invalid');
                  }
                  const result = tmComposition.setPreviewMirroring(mode);
                  options.onPreviewMirroringChange?.(mode as 'mirrored' | 'unmirrored');
                  return result;
                },
              }
            : {}),
          ...(cameraMenuControlEnabled
            ? {
                listCameraDevices() {
                  if (disposePromise) throw disposedError();
                  return withCameraBusy(() => tmComposition.listCameraDevices());
                },
                selectCamera(selection: unknown) {
                  if (disposePromise) throw disposedError();
                  return withCameraBusy(() => tmComposition.selectCamera(selection));
                },
                getCameraSelection() {
                  if (disposePromise) throw disposedError();
                  return tmComposition.getCameraSelection();
                },
                getActiveCamera() {
                  if (disposePromise) throw disposedError();
                  return tmComposition.getActiveCamera();
                },
              }
            : {}),
          isCameraRunning() {
            if (disposePromise) return false;
            return tmComposition.isCameraRunning();
          },
        })
      : null;
    const verifiedRemoteCache = verifiedRemoteEnabled
      ? Object.freeze({
          identity: cacheIdentity,
          getWarnings() {
            return Object.freeze([...cacheWarnings]);
          },
          takeWarnings() {
            const warnings = Object.freeze([...cacheWarnings]);
            cacheWarnings.length = 0;
            return warnings;
          },
          renewLease() {
            if (disposePromise) throw disposedError();
            return assetManagerComposition.renewVerifiedRemoteStoryCacheLease();
          },
          releaseLease() {
            if (disposePromise) throw disposedError();
            return assetManagerComposition.releaseVerifiedRemoteStoryCacheLease();
          },
          getStats() {
            if (disposePromise) throw disposedError();
            return assetManagerComposition.getVerifiedRemoteCacheStats();
          },
          prune() {
            if (disposePromise) throw disposedError();
            return assetManagerComposition.pruneVerifiedRemoteCache();
          },
          clear() {
            if (disposePromise) throw disposedError();
            return assetManagerComposition.clearVerifiedRemoteCache();
          },
          listStoryCaches() {
            if (disposePromise) throw disposedError();
            return assetManagerComposition.listVerifiedRemoteStoryCaches();
          },
          pruneStoryCaches() {
            if (disposePromise) throw disposedError();
            return assetManagerComposition.pruneVerifiedRemoteStoryCaches();
          },
          deleteStoryCache(databaseName: string) {
            if (disposePromise) throw disposedError();
            return assetManagerComposition.deleteVerifiedRemoteStoryCache(databaseName);
          },
        })
      : null;
    const lifecycle = Object.freeze({
      prepare(
        payload: Readonly<Record<string, unknown>>,
        context: Readonly<Record<string, unknown>>,
      ) {
        if (disposePromise) throw disposedError();
        return assetLifecycle.prepare(payload, context);
      },
      setLoading(
        payload: Readonly<Record<string, unknown>>,
        context: Readonly<Record<string, unknown>>,
      ) {
        if (disposePromise) throw disposedError();
        return assetLifecycle.setLoading(payload, context);
      },
      releaseAssets(payload: Readonly<Record<string, unknown>>) {
        if (disposePromise) return disposePromise;
        return assetLifecycle.releaseAssets(payload);
      },
      release(payload: Readonly<Record<string, unknown>>) {
        if (disposePromise) return disposePromise;
        return assetLifecycle.release(payload);
      },
    });

    function dispose(reason: string = 'dispose') {
      if (disposePromise) return disposePromise;
      if (typeof reason !== 'string' || reason.length === 0) {
        return Promise.reject(new TypeError('dispose reason must be a non-empty string'));
      }
      disposePromise = (async () => {
        const errors = [];
        for (const release of [
          () => poseActionPort.dispose(),
          ...(storyCameraLifecycle ? [() => storyCameraLifecycle.dispose()] : []),
          ...(binaryAssetBacking ? [() => binaryAssetBacking.dispose()] : []),
          () => assetLifecycle.release({reason}),
          () => asyncInputComposition.releaseAll(),
          () => tmComposition.releaseAll(),
          ...(verifiedRemoteEnabled
            ? [() => assetManagerComposition.releaseVerifiedRemoteStoryCacheLease()]
            : []),
          () => assetManagerComposition.releaseAll(),
        ]) {
          try {
            await release();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'DSL 4.0 platform asset session disposal failed');
        }
      })();
      return disposePromise;
    }

    return Object.freeze({
      lifecycle,
      assetManagerComposition,
      tmComposition,
      asyncInputComposition,
      poseActionPort,
      storyCameraLifecycle,
      posePreviewPort,
      cameraPreviewControlsPort,
      getAssetResource(assetId: unknown) {
        if (disposePromise) throw disposedError();
        return assetLifecycle.getResource(assetId);
      },
      binaryAssetBacking,
      verifiedRemoteCache,
      dispose,
    });
  } catch (error) {
    failCreation(created, error);
  }
}
