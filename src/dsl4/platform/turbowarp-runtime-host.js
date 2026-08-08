import {createRuntimeExpressionComposition as createDefaultRuntimeExpressionComposition} from '@kubohiroya/turbowarp-runtime-expression/composition';

import {validateDsl4CacheIdentity} from '../cache-identity.js';
import {createDsl4InputArbitration} from '../input-arbitration.js';
import {createDsl4RuntimeStartup, resolveDsl4FeatureFlags} from '../runtime-startup.js';
import {deepFreeze} from '../story-document.js';
import {createDsl4ActorActionPort} from './actor-action-port.js';
import {createDsl4AsyncInputActionPort} from './async-input-action-port.js';
import {createDsl4CameraPreviewControls} from './camera-preview-controls.js';
import {createDsl4MediaActionPort} from './media-action-port.js';
import {createDsl4PlatformAssetSession} from './platform-asset-session.js';
import {createDsl4PoseFeedbackPresenter} from './pose-feedback-presenter.js';
import {createDsl4ScratchPoseFeedbackAdapter} from './scratch-pose-feedback-adapter.js';
import {createDsl4SvgTextPlatform} from './svg-text-action-port.js';
import {createDsl4TurboWarpActorPlatform} from './turbowarp-actor-adapter.js';

/**
 * @typedef {Readonly<{runtime: unknown, storyDocument: Readonly<Record<string, unknown>>}>} HostPortContext
 * @typedef {{wait?: Function, transition?: Function, keyInputToChangeScene?: Function, touchInputToChangeScene?: Function, dispose?: Function}} HostPort
 * @typedef {(expression: string, variables: Readonly<Record<string, string | number | boolean>>, context: Record<string, unknown>) => boolean | Promise<boolean>} RuntimeConditionEvaluator
 */

const hostPortMethods = new Set([
  'wait',
  'transition',
  'keyInputToChangeScene',
  'touchInputToChangeScene',
]);
const controllerCommands = new Set(['goto', 'branch', 'pose']);
const defaultCacheLeaseHeartbeatMs = 30_000;

/** @param {() => void} callback @param {number} milliseconds */
function defaultCacheLeaseHeartbeatSchedule(callback, milliseconds) {
  const timer = setInterval(callback, milliseconds);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} code @param {string} message */
function hostError(code, message) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

/** @param {string} message */
function abortError(message) {
  const error = hostError('K4-HOST-WAIT-002', message);
  error.name = 'AbortError';
  return error;
}

/** @param {unknown} value */
function validateSignal(value) {
  if (
    !isRecord(value) ||
    typeof value.aborted !== 'boolean' ||
    typeof value.addEventListener !== 'function' ||
    typeof value.removeEventListener !== 'function'
  ) {
    throw hostError('K4-HOST-WAIT-001', 'wait context must provide an AbortSignal');
  }
  return /** @type {AbortSignal} */ (/** @type {unknown} */ (value));
}

/** @param {() => void} callback @param {number} milliseconds */
function defaultWaitSchedule(callback, milliseconds) {
  const timer = setTimeout(callback, milliseconds);
  return () => clearTimeout(timer);
}

/**
 * @param {(callback: () => void, milliseconds: number) => () => void} schedule
 */
function createWaitPort(schedule) {
  return Object.freeze({
    /** @param {unknown} payload @param {unknown} context */
    wait(payload, context) {
      if (
        !isRecord(payload) ||
        Object.keys(payload).length !== 1 ||
        !Object.hasOwn(payload, 'seconds') ||
        typeof payload.seconds !== 'number' ||
        !Number.isFinite(payload.seconds) ||
        payload.seconds < 0
      ) {
        throw hostError(
          'K4-HOST-WAIT-001',
          'wait payload must provide one finite non-negative seconds value',
        );
      }
      const signal = validateSignal(isRecord(context) ? context.signal : undefined);
      if (signal.aborted) return Promise.reject(abortError('wait action was cancelled'));
      const milliseconds = payload.seconds * 1000;
      if (!Number.isFinite(milliseconds)) {
        throw hostError('K4-HOST-WAIT-001', 'wait duration is outside the supported range');
      }
      if (milliseconds === 0) return Promise.resolve();

      return new Promise((resolve, reject) => {
        let settled = false;
        let cancel = () => {};
        const cleanup = () => {
          signal.removeEventListener('abort', handleAbort);
          cancel();
        };
        const finish = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(undefined);
        };
        const handleAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(abortError('wait action was cancelled'));
        };
        signal.addEventListener('abort', handleAbort, {once: true});
        if (signal.aborted) {
          handleAbort();
          return;
        }
        try {
          const scheduledCancel = schedule(finish, milliseconds);
          if (typeof scheduledCancel !== 'function') {
            throw hostError(
              'K4-HOST-WAIT-001',
              'wait schedule must return a cancellation function',
            );
          }
          cancel = scheduledCancel;
          if (settled) cancel();
        } catch (error) {
          settled = true;
          cleanup();
          reject(error);
        }
      });
    },
  });
}

/** @param {unknown} value @returns {Readonly<HostPort> | HostPort} */
function validateHostPort(value) {
  if (value === undefined)
    return /** @type {Readonly<Record<string, Function>>} */ (Object.freeze({}));
  if (!isRecord(value)) throw new TypeError('DSL 4.0 host port must be an object');
  for (const [method, operation] of Object.entries(value)) {
    if (method === 'dispose') {
      if (typeof operation !== 'function') {
        throw new TypeError('DSL 4.0 host port dispose must be a function');
      }
      continue;
    }
    if (typeof operation !== 'function') {
      throw new TypeError(`DSL 4.0 host port ${method} must be a function`);
    }
  }
  return /** @type {HostPort} */ (value);
}

/** @param {unknown} value @param {string} label @param {string[]} methods */
function validateCompositionMethods(value, label, methods) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  const missing = methods.filter((method) => typeof value[method] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(`${label} must provide ${missing.join(', ')}`);
  }
  return /** @type {Record<string, Function>} */ (value);
}

/**
 * @param {Record<string, Function>} destination
 * @param {Record<string, Function>} source
 * @param {string[]} methods
 * @param {string} owner
 */
function addPortMethods(destination, source, methods, owner) {
  for (const method of methods) {
    if (typeof source[method] !== 'function') {
      throw new TypeError(`${owner} must provide ${method}`);
    }
    if (Object.hasOwn(destination, method)) {
      throw hostError('K4-HOST-PORT-COLLISION', `Runtime port method is duplicated: ${method}`);
    }
    destination[method] = source[method].bind(source);
  }
}

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {Record<string, Function>} port
 * @param {unknown} evaluateCondition
 */
function validateStoryCapabilities(storyDocument, port, evaluateCondition) {
  const scenes = Array.isArray(storyDocument.scenes) ? storyDocument.scenes : [];
  for (const scene of scenes) {
    if (!isRecord(scene) || !Array.isArray(scene.actions)) continue;
    for (const action of scene.actions) {
      if (!isRecord(action) || typeof action.command !== 'string') continue;
      if (action.command === 'branch' && typeof evaluateCondition !== 'function') {
        throw hostError(
          'K4-HOST-CONDITION-MISSING',
          'A condition evaluator is required by the DSL 4.0 story',
        );
      }
      if (controllerCommands.has(action.command)) continue;
      if (typeof port[action.command] !== 'function') {
        throw hostError(
          'K4-HOST-PORT-MISSING',
          `Runtime port method is required by the DSL 4.0 story: ${action.command}`,
        );
      }
    }
  }
}

/** @param {Readonly<Record<string, unknown>>} storyDocument */
function resolvePoseFeedbackMode(storyDocument) {
  const poseRecognition = isRecord(storyDocument.poseRecognition)
    ? storyDocument.poseRecognition
    : null;
  const feedback = isRecord(poseRecognition?.feedback) ? poseRecognition.feedback : null;
  const mode = feedback?.mode ?? 'scratchMirror';
  if (!['scratchMirror', 'scratchBinding', 'presenter'].includes(String(mode))) {
    throw hostError('K4-HOST-POSE-FEEDBACK-001', 'Pose feedback mode is unsupported');
  }
  return /** @type {'scratchMirror' | 'scratchBinding' | 'presenter'} */ (mode);
}

/**
 * @param {Record<string, any>} options
 * @param {Readonly<Record<string, unknown>>} runtimeComponent
 * @param {(cache: Record<string, any> | null) => void} publishVerifiedRemoteCache
 * @param {(observer: ((event: Readonly<Record<string, unknown>>) => void) | null) => void} publishRuntimeLifecycleObserver
 * @param {boolean} poseFeedbackEnabled
 * @param {boolean} posePreviewMirroringEnabled
 * @param {boolean} cameraPreviewControlsEnabled
 * @param {boolean} speechAdvanceTypewriterEnabled
 */
export async function createDsl4TurboWarpRuntimeEnvironment(
  options,
  runtimeComponent,
  publishVerifiedRemoteCache,
  publishRuntimeLifecycleObserver,
  poseFeedbackEnabled,
  posePreviewMirroringEnabled,
  cameraPreviewControlsEnabled,
  speechAdvanceTypewriterEnabled,
) {
  const component =
    /** @type {Readonly<{storyDocument: Readonly<Record<string, unknown>>, sourceDescriptor?: Readonly<Record<string, unknown>>}>} */ (
      /** @type {unknown} */ (runtimeComponent)
    );
  /** @type {ReturnType<typeof createDsl4PlatformAssetSession> | null} */
  let assetSession = null;
  /** @type {ReturnType<typeof createDsl4TurboWarpActorPlatform> | null} */
  let actorPlatform = null;
  /** @type {ReturnType<typeof createDsl4MediaActionPort> | null} */
  let mediaPort = null;
  /** @type {ReturnType<typeof createDsl4SvgTextPlatform> | null} */
  let svgTextPlatform = null;
  /** @type {ReturnType<typeof createDsl4ScratchPoseFeedbackAdapter> | null} */
  let scratchPoseFeedbackAdapter = null;
  /** @type {ReturnType<typeof createDsl4PoseFeedbackPresenter> | null} */
  let poseFeedbackPresenter = null;
  /** @type {Record<string, Function> | null} */
  let runtimeExpressionComposition = null;
  /** @type {ReturnType<typeof createDsl4CameraPreviewControls> | null} */
  let cameraPreviewControls = null;
  const inputArbitration = createDsl4InputArbitration();
  /** @type {Readonly<Record<string, Function>> | Record<string, Function>} */
  let hostPort = Object.freeze({});
  const preview = isRecord(component.storyDocument.poseRecognition)
    ? /** @type {Record<string, any>} */ (component.storyDocument.poseRecognition).preview
    : null;
  const hasConfiguredPreviewControls =
    cameraPreviewControlsEnabled && isRecord(preview) && isRecord(preview.controls);
  const configuredPreviewControls = hasConfiguredPreviewControls
    ? /** @type {Record<string, any>} */ (preview.controls)
    : {};
  const effectivePosePreviewMirroringEnabled =
    posePreviewMirroringEnabled || isRecord(configuredPreviewControls.mirroring);
  const embeddedCacheIdentity =
    component.sourceDescriptor?.cacheIdentity === undefined
      ? undefined
      : validateDsl4CacheIdentity(component.sourceDescriptor.cacheIdentity);
  const injectedCacheIdentity =
    options.cacheIdentity === undefined
      ? undefined
      : validateDsl4CacheIdentity(options.cacheIdentity);
  if (
    injectedCacheIdentity !== undefined &&
    embeddedCacheIdentity !== undefined &&
    (injectedCacheIdentity.id !== embeddedCacheIdentity.id ||
      injectedCacheIdentity.label !== embeddedCacheIdentity.label ||
      injectedCacheIdentity.databaseName !== embeddedCacheIdentity.databaseName)
  ) {
    throw hostError(
      'K4-HOST-CACHE-IDENTITY-001',
      'Injected cache identity does not match the packaged story identity',
    );
  }
  const cacheIdentity = injectedCacheIdentity ?? embeddedCacheIdentity;

  try {
    actorPlatform = createDsl4TurboWarpActorPlatform({
      runtime: options.runtime,
      ...(speechAdvanceTypewriterEnabled
        ? {
            speechAdvanceTypewriterEnabled: true,
            playSpeechSound(sound) {
              if (!assetSession) throw new Error('Asset session is unavailable');
              return assetSession.assetManagerComposition.playSound(sound);
            },
            stopSpeechSound(sound) {
              return assetSession?.assetManagerComposition.stopSound(sound);
            },
          }
        : {}),
      ...(options.actorScheduler === undefined ? {} : {scheduler: options.actorScheduler}),
      ...(options.actorFrameMilliseconds === undefined
        ? {}
        : {frameMilliseconds: options.actorFrameMilliseconds}),
    });
    const feedbackMode = poseFeedbackEnabled
      ? resolvePoseFeedbackMode(component.storyDocument)
      : null;
    if (feedbackMode === 'scratchMirror' || feedbackMode === 'scratchBinding') {
      scratchPoseFeedbackAdapter = createDsl4ScratchPoseFeedbackAdapter({
        runtime: options.runtime,
        mode: feedbackMode,
      });
    }
    /** @type {((event: Readonly<Record<string, unknown>>) => unknown) | undefined} */
    let poseStateObserver = scratchPoseFeedbackAdapter?.onPoseState;
    if (feedbackMode === 'presenter') {
      if (options.poseFeedbackPresenter !== undefined) {
        poseFeedbackPresenter = createDsl4PoseFeedbackPresenter(options.poseFeedbackPresenter);
      }
      const externalObserver = options.onPoseState;
      if (externalObserver !== undefined && typeof externalObserver !== 'function') {
        throw new TypeError('onPoseState must be a function');
      }
      /** @type {Array<(event: Readonly<Record<string, unknown>>) => unknown>} */
      const observers = [];
      if (poseFeedbackPresenter !== null) observers.push(poseFeedbackPresenter.onPoseState);
      if (typeof externalObserver === 'function') observers.push(externalObserver);
      if (observers.length > 0) {
        poseStateObserver = (event) => {
          for (const observer of observers) {
            try {
              Promise.resolve(observer(event)).catch(() => {});
            } catch {
              // Presenter observers are non-authoritative and isolated from pose execution.
            }
          }
        };
      }
    }
    const poseStateBinding =
      feedbackMode === 'scratchBinding'
        ? scratchPoseFeedbackAdapter?.readPoseStateBinding
        : undefined;
    assetSession = createDsl4PlatformAssetSession({
      runtimeComponent,
      tmPoseRuntime: options.tmPoseRuntime,
      setLoading: options.setLoading,
      ...(options.loadRemoteAsset === undefined ? {} : {loadRemoteAsset: options.loadRemoteAsset}),
      ...(cacheIdentity === undefined ? {} : {cacheIdentity}),
      ...(options.verifiedRemoteCacheOptions === undefined
        ? {}
        : {verifiedRemoteCacheOptions: options.verifiedRemoteCacheOptions}),
      ...(options.poseArchiveLimits === undefined
        ? {}
        : {poseArchiveLimits: options.poseArchiveLimits}),
      ...(options.subtleCrypto === undefined ? {} : {subtleCrypto: options.subtleCrypto}),
      ...(options.createFile === undefined ? {} : {createFile: options.createFile}),
      ...(options.createAssetManagerComposition === undefined
        ? {}
        : {createAssetManagerComposition: options.createAssetManagerComposition}),
      ...(options.binaryEntryProvider === undefined
        ? {}
        : {binaryEntryProvider: options.binaryEntryProvider}),
      ...(options.binaryBundleStoreOptions === undefined
        ? {}
        : {binaryBundleStoreOptions: options.binaryBundleStoreOptions}),
      ...(options.createTMPoseComposition === undefined
        ? {}
        : {createTMPoseComposition: options.createTMPoseComposition}),
      ...(options.createAsyncInputComposition === undefined
        ? {}
        : {createAsyncInputComposition: options.createAsyncInputComposition}),
      ...(options.keySource === undefined ? {} : {keySource: options.keySource}),
      ...(options.actorTouchSource === undefined
        ? {}
        : {actorTouchSource: options.actorTouchSource}),
      ...(options.poseSchedule === undefined ? {} : {poseSchedule: options.poseSchedule}),
      ...(options.poseNow === undefined ? {} : {poseNow: options.poseNow}),
      ...(poseFeedbackEnabled
        ? {
            poseFeedbackEnabled: true,
            onPoseState: poseStateObserver,
            ...(poseStateBinding === undefined ? {} : {readPoseStateBinding: poseStateBinding}),
          }
        : {}),
      ...(effectivePosePreviewMirroringEnabled ? {posePreviewMirroringEnabled: true} : {}),
      ...(hasConfiguredPreviewControls ? {cameraPreviewControlsEnabled: true} : {}),
      ...(hasConfiguredPreviewControls
        ? {
            cameraPreviewMirroringControlEnabled: isRecord(configuredPreviewControls.mirroring),
            cameraMenuControlEnabled: isRecord(configuredPreviewControls.cameraMenu),
          }
        : {}),
      ...(hasConfiguredPreviewControls && options.createObjectURL !== undefined
        ? {createObjectURL: options.createObjectURL}
        : {}),
      ...(hasConfiguredPreviewControls && options.revokeObjectURL !== undefined
        ? {revokeObjectURL: options.revokeObjectURL}
        : {}),
      ...(isRecord(configuredPreviewControls.mirroring)
        ? {
            /** @param {'mirrored' | 'unmirrored'} mode */
            onPreviewMirroringChange(mode) {
              cameraPreviewControls?.setMirroring(mode);
            },
          }
        : {}),
    });
    mediaPort = createDsl4MediaActionPort({
      composition: assetSession.assetManagerComposition,
      resolveActor: actorPlatform.resolveActor,
      setActorScale: actorPlatform.host.setActorScale,
      ...(options.actorScheduler === undefined ? {} : {scheduler: options.actorScheduler}),
      ...(options.onBackgroundActionError === undefined
        ? {}
        : {onBackgroundError: options.onBackgroundActionError}),
    });
    const actorPort = createDsl4ActorActionPort({
      composition: assetSession.assetManagerComposition,
      resolveActor: actorPlatform.resolveActor,
      host: actorPlatform.host,
      stopActorLoop: mediaPort.stopActorLoop,
      ...(speechAdvanceTypewriterEnabled ? {speechAdvanceTypewriterEnabled: true} : {}),
    });
    const asyncInputPort = createDsl4AsyncInputActionPort({
      composition: assetSession.asyncInputComposition,
      inputArbitration,
    });
    svgTextPlatform = createDsl4SvgTextPlatform({
      enabled: true,
      runtime: options.runtime,
      storyDocument: component.storyDocument,
      resolveActor: actorPlatform.resolveActor,
      ...(options.createSvgTextComposition === undefined
        ? {}
        : {createComposition: options.createSvgTextComposition}),
    });
    hostPort = validateHostPort(
      typeof options.createHostPort === 'function'
        ? await options.createHostPort(
            Object.freeze({runtime: options.runtime, storyDocument: component.storyDocument}),
          )
        : undefined,
    );

    /** @type {RuntimeConditionEvaluator | undefined} */
    let evaluateCondition = options.evaluateCondition;
    if (evaluateCondition === undefined) {
      const createRuntimeExpression =
        options.createRuntimeExpressionComposition ?? createDefaultRuntimeExpressionComposition;
      const candidate = createRuntimeExpression();
      if (isRecord(candidate)) {
        runtimeExpressionComposition = /** @type {Record<string, Function>} */ (candidate);
      }
      const composition = validateCompositionMethods(candidate, 'Runtime Expression composition', [
        'evaluateCondition',
        'releaseAll',
      ]);
      runtimeExpressionComposition = composition;
      evaluateCondition = (expression, variables) =>
        composition.evaluateCondition(expression, variables);
    }

    const port = /** @type {Record<string, Function>} */ ({});
    addPortMethods(
      port,
      mediaPort,
      ['stage', 'bgm', 'sound', 'setSkin', 'loop'],
      'media action port',
    );
    addPortMethods(
      port,
      actorPort,
      [
        'show',
        'hide',
        'setLayer',
        'setTransparency',
        'moveTo',
        'say',
        ...(speechAdvanceTypewriterEnabled ? ['think'] : []),
      ],
      'actor action port',
    );
    port.finishPresentationTransitions = actorPlatform.finishTransparencyTransitions;
    addPortMethods(port, svgTextPlatform.port, ['setText'], 'SVG text action port');
    addPortMethods(
      port,
      assetSession.poseActionPort,
      ['waitForPose', 'poseInputToChangeScene'],
      'pose action port',
    );
    if (assetSession.posePreviewPort) {
      addPortMethods(
        port,
        assetSession.posePreviewPort,
        ['setPosePreviewMirroring'],
        'pose preview port',
      );
    }
    if (options.keySource !== undefined) {
      addPortMethods(port, asyncInputPort, ['keyInputToChangeScene'], 'async input action port');
    }
    if (options.actorTouchSource !== undefined) {
      addPortMethods(port, asyncInputPort, ['touchInputToChangeScene'], 'async input action port');
    }

    for (const method of Object.keys(hostPort)) {
      if (method === 'dispose') continue;
      if (Object.hasOwn(port, method)) {
        throw hostError('K4-HOST-PORT-COLLISION', `Runtime port method is duplicated: ${method}`);
      }
      if (!hostPortMethods.has(method)) {
        throw hostError(
          'K4-HOST-PORT-UNSUPPORTED',
          `Injected runtime port is unsupported: ${method}`,
        );
      }
      port[method] = /** @type {Function} */ (hostPort[method]).bind(hostPort);
    }
    if (!Object.hasOwn(port, 'wait')) {
      const schedule = options.waitSchedule ?? defaultWaitSchedule;
      if (typeof schedule !== 'function') throw new TypeError('waitSchedule must be a function');
      addPortMethods(port, createWaitPort(schedule), ['wait'], 'wait action port');
    }
    validateStoryCapabilities(component.storyDocument, port, evaluateCondition);
    Object.freeze(port);

    const activeAssetSession = assetSession;
    const baseAssetLifecycle = activeAssetSession.lifecycle;
    const previewControls = configuredPreviewControls;
    const controlAssetIds = hasConfiguredPreviewControls
      ? [
          previewControls.mirroring?.assets?.showMirrored,
          previewControls.mirroring?.assets?.showUnmirrored,
          previewControls.cameraMenu?.buttonAsset,
        ].filter((value) => typeof value === 'string')
      : [];
    /** @param {() => unknown} releaseBase @param {string} message */
    async function releaseCameraPreviewControls(releaseBase, message) {
      const renderer = cameraPreviewControls;
      cameraPreviewControls = null;
      const errors = [];
      try {
        renderer?.dispose();
      } catch (error) {
        errors.push(error);
      }
      try {
        await releaseBase();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, message);
    }
    const assetLifecycle = hasConfiguredPreviewControls
      ? Object.freeze({
          /** @param {Record<string, any>} payload @param {Record<string, any>} context */
          async prepare(payload, context) {
            await baseAssetLifecycle.prepare(payload, context);
            if (
              cameraPreviewControls ||
              !controlAssetIds.every((assetId) => payload.assetIds.includes(assetId))
            ) {
              return;
            }
            if (!isRecord(options.cameraPreviewControls)) {
              throw new TypeError(
                'cameraPreviewControls app-shell options are required when preview controls are configured',
              );
            }
            const assetUrls = Object.fromEntries(
              controlAssetIds.map((assetId) => {
                const resource = activeAssetSession.getAssetResource(assetId);
                if (!isRecord(resource) || typeof resource.objectUrl !== 'string') {
                  throw new TypeError(
                    `Camera preview control asset is not materialized: ${assetId}`,
                  );
                }
                return [assetId, resource.objectUrl];
              }),
            );
            cameraPreviewControls = createDsl4CameraPreviewControls(
              /** @type {any} */ ({
                ...options.cameraPreviewControls,
                preview,
                assetUrls: Object.freeze(assetUrls),
                port: activeAssetSession.cameraPreviewControlsPort,
              }),
            );
            cameraPreviewControls.start();
          },
          /** @param {Record<string, any>} payload @param {Record<string, any>} context */
          setLoading(payload, context) {
            return baseAssetLifecycle.setLoading(payload, context);
          },
          /** @param {Record<string, any>} payload */
          async releaseAssets(payload) {
            if (controlAssetIds.some((assetId) => payload.assetIds.includes(assetId))) {
              return releaseCameraPreviewControls(
                () => baseAssetLifecycle.releaseAssets(payload),
                'Camera preview controls and selected assets could not be released',
              );
            }
            return baseAssetLifecycle.releaseAssets(payload);
          },
          /** @param {Record<string, any>} payload */
          async release(payload) {
            return releaseCameraPreviewControls(
              () => baseAssetLifecycle.release(payload),
              'Camera preview controls and assets could not be released',
            );
          },
        })
      : baseAssetLifecycle;

    publishRuntimeLifecycleObserver((event) => {
      if (
        event.type === 'runtime.finish' ||
        event.type === 'runtime.fail' ||
        event.type === 'runtime.stop'
      ) {
        mediaPort?.stopAllLoops();
        cameraPreviewControls?.stop();
        return;
      }
      if (
        hasConfiguredPreviewControls &&
        (event.type === 'navigation.reposition' || event.type === 'runtime.resume')
      ) {
        cameraPreviewControls?.start();
      }
    });

    /** @type {Promise<void> | null} */
    let disposePromise = null;
    const environment = {
      port,
      assetLifecycle,
      evaluateCondition,
      inputArbitration,
      /** @param {string} [reason] */
      dispose(reason = 'dispose') {
        if (disposePromise) return disposePromise;
        publishRuntimeLifecycleObserver(null);
        disposePromise = (async () => {
          const errors = [];
          for (const release of [
            () => mediaPort?.dispose(),
            () => actorPlatform?.dispose(),
            () => scratchPoseFeedbackAdapter?.dispose(),
            () => poseFeedbackPresenter?.dispose(),
            () => cameraPreviewControls?.dispose(),
            () => hostPort.dispose?.(),
            () => runtimeExpressionComposition?.releaseAll(),
            () => svgTextPlatform?.releaseAll(),
            () => inputArbitration.dispose(),
            () => assetSession?.dispose(reason),
          ]) {
            try {
              await release();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0) {
            throw new AggregateError(errors, 'DSL 4.0 TurboWarp environment disposal failed');
          }
        })();
        return disposePromise;
      },
    };
    publishVerifiedRemoteCache(assetSession.verifiedRemoteCache);
    return Object.freeze(environment);
  } catch (error) {
    const cleanupErrors = [];
    for (const release of [
      () => mediaPort?.dispose(),
      () => actorPlatform?.dispose(),
      () => scratchPoseFeedbackAdapter?.dispose(),
      () => poseFeedbackPresenter?.dispose(),
      () => cameraPreviewControls?.dispose(),
      () => hostPort.dispose?.(),
      () => runtimeExpressionComposition?.releaseAll(),
      () => svgTextPlatform?.releaseAll(),
      () => inputArbitration.dispose(),
      () => assetSession?.dispose('partial-creation-failed'),
    ]) {
      try {
        await release();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'DSL 4.0 TurboWarp environment creation and cleanup failed',
      );
    }
    throw error;
  }
}

/**
 * Create one host-owned, default-off TurboWarp session for a packaged DSL 4.0 component.
 *
 * The returned host never starts the story or attaches a key listener automatically.
 *
 * @param {object} [options]
 * @param {unknown} [options.featureFlags]
 * @param {unknown} [options.project]
 * @param {{parse(source: string, options?: {sourceId?: string}): Readonly<Record<string, any>>}} [options.sourceFrontend]
 * @param {number} [options.maxSourceBytes]
 * @param {number} [options.maxAssetFiles]
 * @param {number} [options.maxAssetFileBytes]
 * @param {number} [options.maxAssetBytes]
 * @param {'embedded-base64' | 'binary-entry'} [options.assetBundleFormat]
 * @param {unknown} [options.binaryEntryProvider]
 * @param {Readonly<Record<string, unknown>>} [options.binaryBundleStoreOptions]
 * @param {boolean} [options.historyNavigationAvailable]
 * @param {{maxActionEntries: number, maxSceneVisits: number}} [options.historyLimits]
 * @param {unknown} [options.runtime]
 * @param {unknown} [options.tmPoseRuntime]
 * @param {Function} [options.setLoading]
 * @param {Function} [options.loadRemoteAsset]
 * @param {unknown} [options.cacheIdentity]
 * @param {number} [options.cacheLeaseHeartbeatMs]
 * @param {(callback: () => void, milliseconds: number) => (() => void)} [options.scheduleCacheLeaseHeartbeat]
 * @param {Readonly<Record<string, unknown>>} [options.verifiedRemoteCacheOptions]
 * @param {Readonly<Record<string, unknown>>} [options.poseArchiveLimits]
 * @param {(context: HostPortContext) => HostPort | Promise<HostPort>} [options.createHostPort]
 * @param {Function} [options.waitSchedule]
 * @param {Function} [options.createFile]
 * @param {Function} [options.createAssetManagerComposition]
 * @param {Function} [options.createTMPoseComposition]
 * @param {Function} [options.createAsyncInputComposition]
 * @param {unknown} [options.keySource]
 * @param {unknown} [options.actorTouchSource]
 * @param {Function} [options.createRuntimeExpressionComposition]
 * @param {Function} [options.createSvgTextComposition]
 * @param {unknown} [options.actorScheduler]
 * @param {(error: unknown) => unknown} [options.onBackgroundActionError]
 * @param {number} [options.actorFrameMilliseconds]
 * @param {Function} [options.poseSchedule]
 * @param {Function} [options.poseNow]
 * @param {Readonly<Record<string, unknown>>} [options.poseFeedbackPresenter] Standard app-shell presenter options
 * @param {(event: Readonly<Record<string, unknown>>) => unknown} [options.onPoseState] additional presenter observer
 * @param {Readonly<Record<string, unknown>>} [options.cameraPreviewControls]
 * @param {(blob: Blob) => string} [options.createObjectURL]
 * @param {(url: string) => void} [options.revokeObjectURL]
 * @param {(expression: string, variables: Readonly<Record<string, string | number | boolean>>, context: Record<string, unknown>) => boolean | Promise<boolean>} [options.evaluateCondition]
 * @param {(event: Readonly<Record<string, unknown>>) => void} [options.onEvent]
 * @param {(error: unknown, context: Readonly<{command: string, code: string}>) => unknown | Promise<unknown>} [options.onInputError]
 * @param {{digest: Function}} [options.subtleCrypto]
 */
export async function createDsl4TurboWarpRuntimeHost(options = {}) {
  if (!isRecord(options)) throw new TypeError('DSL 4.0 TurboWarp host options must be an object');
  const featureFlags = resolveDsl4FeatureFlags(options.featureFlags);
  if (!featureFlags.dsl4Runtime) {
    const disabled = await createDsl4RuntimeStartup({featureFlags});
    return deepFreeze({...disabled, host: null});
  }
  const assetBundleFormat = options.assetBundleFormat ?? 'embedded-base64';
  if (assetBundleFormat !== 'embedded-base64' && assetBundleFormat !== 'binary-entry') {
    throw new TypeError('assetBundleFormat must be embedded-base64 or binary-entry');
  }
  if (assetBundleFormat === 'binary-entry' && options.binaryEntryProvider === undefined) {
    throw new TypeError('binaryEntryProvider is required for binary-entry runtime startup');
  }
  if (assetBundleFormat === 'embedded-base64' && options.binaryEntryProvider !== undefined) {
    throw new TypeError('binaryEntryProvider requires assetBundleFormat binary-entry');
  }
  if (options.createHostPort !== undefined && typeof options.createHostPort !== 'function') {
    throw new TypeError('createHostPort must be a function');
  }
  if (options.evaluateCondition !== undefined && typeof options.evaluateCondition !== 'function') {
    throw new TypeError('evaluateCondition must be a function');
  }
  const cacheLeaseHeartbeatMs = options.cacheLeaseHeartbeatMs ?? defaultCacheLeaseHeartbeatMs;
  if (!Number.isSafeInteger(cacheLeaseHeartbeatMs) || cacheLeaseHeartbeatMs < 1) {
    throw new TypeError('cacheLeaseHeartbeatMs must be a positive safe integer');
  }
  const scheduleCacheLeaseHeartbeat =
    options.scheduleCacheLeaseHeartbeat ?? defaultCacheLeaseHeartbeatSchedule;
  if (typeof scheduleCacheLeaseHeartbeat !== 'function') {
    throw new TypeError('scheduleCacheLeaseHeartbeat must be a function');
  }

  /** @type {Record<string, any> | null} */
  let verifiedRemoteCache = null;
  /** @type {((event: Readonly<Record<string, unknown>>) => void) | null} */
  let runtimeLifecycleObserver = null;
  if (
    options.createRuntimeExpressionComposition !== undefined &&
    typeof options.createRuntimeExpressionComposition !== 'function'
  ) {
    throw new TypeError('createRuntimeExpressionComposition must be a function');
  }
  if (
    options.evaluateCondition !== undefined &&
    options.createRuntimeExpressionComposition !== undefined
  ) {
    throw new TypeError(
      'Provide either evaluateCondition or createRuntimeExpressionComposition, not both',
    );
  }

  const startup = await createDsl4RuntimeStartup({
    featureFlags,
    project: options.project,
    sourceFrontend: options.sourceFrontend,
    maxSourceBytes: options.maxSourceBytes,
    maxAssetFiles: options.maxAssetFiles,
    maxAssetFileBytes: options.maxAssetFileBytes,
    maxAssetBytes: options.maxAssetBytes,
    assetBundleFormat,
    historyNavigationAvailable: options.historyNavigationAvailable,
    historyLimits: options.historyLimits,
    evaluateCondition: options.evaluateCondition,
    onEvent(event) {
      try {
        runtimeLifecycleObserver?.(event);
      } catch {
        // Internal UI observers cannot change runtime execution or suppress consumer events.
      }
      options.onEvent?.(event);
    },
    onInputError: options.onInputError,
    subtleCrypto: options.subtleCrypto,
    async createRuntimeEnvironment(
      /** @type {Readonly<Record<string, unknown>>} */ runtimeComponent,
      /** @type {Readonly<Record<string, any>>} */ startupContext,
    ) {
      return createDsl4TurboWarpRuntimeEnvironment(
        options,
        runtimeComponent,
        (/** @type {any} */ cache) => {
          verifiedRemoteCache = cache;
        },
        (observer) => {
          runtimeLifecycleObserver = observer;
        },
        startupContext.featureFlags.dsl4PoseFeedbackModes,
        startupContext.featureFlags.dsl4PosePreviewMirroring,
        startupContext.featureFlags.dsl4CameraPreviewControls,
        startupContext.featureFlags.dsl4SpeechAdvanceTypewriter,
      );
    },
  });
  if (!startup.ok) return deepFreeze({...startup, host: null});

  const successfulStartup =
    /** @type {Readonly<{featureFlags: Readonly<{dsl4Runtime: boolean, dsl4AppShell: boolean, dsl4WebPreviewAdapter: boolean, dsl4WebPreviewAssetLiveReload: boolean, dsl4PreviewReloadOverlay: boolean, dsl4PoseFeedbackModes: boolean, dsl4PosePreviewMirroring: boolean, dsl4CameraPreviewControls: boolean, dsl4SpeechAdvanceTypewriter: boolean, structuredDataIntegrationEnabled: boolean}>, channel: 'bundled' | 'unbundled', runtimeComponent: Readonly<Record<string, unknown>>, session: Readonly<Record<string, Function>>}>} */ (
      /** @type {unknown} */ (startup)
    );
  const session = successfulStartup.session;
  const cachePort = /** @type {Record<string, any> | null} */ (
    /** @type {unknown} */ (verifiedRemoteCache)
  );
  /** @type {Promise<void> | null} */
  let disposePromise = null;
  /** @type {null | (() => void)} */
  let cancelCacheHeartbeat = null;
  let cacheLeaseOperation = Promise.resolve();
  /** @type {unknown} */
  let cacheLeaseError = null;
  let cacheLeaseActive = cachePort !== null;
  let cacheExecutionId = 0;

  /** @param {() => unknown | Promise<unknown>} operation */
  function queueCacheLeaseOperation(operation, clearErrorOnSuccess = false) {
    if (!cachePort) return cacheLeaseOperation;
    cacheLeaseOperation = cacheLeaseOperation.then(async () => {
      try {
        await operation();
        if (clearErrorOnSuccess) cacheLeaseError = null;
      } catch (error) {
        cacheLeaseError = error;
      }
    });
    return cacheLeaseOperation;
  }

  function startCacheHeartbeat() {
    if (!cachePort || cancelCacheHeartbeat) return;
    const cancel = scheduleCacheLeaseHeartbeat(() => {
      void queueCacheLeaseOperation(() => cachePort.renewLease(), true);
    }, cacheLeaseHeartbeatMs);
    if (typeof cancel !== 'function') {
      throw new TypeError('scheduleCacheLeaseHeartbeat must return a cancellation function');
    }
    cancelCacheHeartbeat = cancel;
  }

  async function activateCacheLease() {
    if (!cachePort) return;
    await queueCacheLeaseOperation(() => cachePort.renewLease(), true);
    cacheLeaseActive = true;
    startCacheHeartbeat();
  }

  async function deactivateCacheLease() {
    const cancel = cancelCacheHeartbeat;
    cancelCacheHeartbeat = null;
    try {
      cancel?.();
    } catch (error) {
      cacheLeaseError = error;
    }
    if (!cachePort || !cacheLeaseActive) return;
    cacheLeaseActive = false;
    await queueCacheLeaseOperation(() => cachePort.releaseLease());
  }
  function ensureActive() {
    if (disposePromise) throw hostError('K4-HOST-DISPOSED', 'DSL 4.0 TurboWarp host is disposed');
  }
  const host = Object.freeze({
    /** @param {{sceneId?: string}} [startOptions] */
    start(startOptions) {
      ensureActive();
      cacheExecutionId += 1;
      const activeCacheExecutionId = cacheExecutionId;
      return (async () => {
        try {
          await activateCacheLease();
          if (cacheExecutionId !== activeCacheExecutionId) return session.getState().runtime;
          ensureActive();
          return await session.start(startOptions);
        } finally {
          if (cacheExecutionId === activeCacheExecutionId) await deactivateCacheLease();
        }
      })();
    },
    /** @param {string} [reason] */
    stop(reason) {
      ensureActive();
      cacheExecutionId += 1;
      const state = session.stop(reason);
      void deactivateCacheLease();
      return state;
    },
    /** @param {unknown} target */
    attach(target) {
      ensureActive();
      return session.attach(target);
    },
    /** @param {unknown} target */
    attachStagePointer(target) {
      ensureActive();
      return session.attachStagePointer(target);
    },
    detach() {
      ensureActive();
      return session.detach();
    },
    detachStagePointer() {
      ensureActive();
      return session.detachStagePointer();
    },
    /** @param {string} command */
    dispatchCommand(command) {
      ensureActive();
      return session.dispatchCommand(command);
    },
    /** @param {Record<string, unknown>} event */
    handleKeyDown(event) {
      ensureActive();
      return session.handleKeyDown(event);
    },
    /** @param {Record<string, unknown>} event */
    handlePointerUp(event) {
      ensureActive();
      return session.handlePointerUp(event);
    },
    whenInputIdle() {
      return session.whenInputIdle();
    },
    getState() {
      return session.getState();
    },
    getRunPromise() {
      return session.getRunPromise();
    },
    verifiedRemoteCache:
      cachePort === null
        ? null
        : Object.freeze({
            identity: cachePort.identity,
            getWarnings: cachePort.getWarnings,
            takeWarnings: cachePort.takeWarnings,
            getStats: cachePort.getStats,
            prune: cachePort.prune,
            clear: cachePort.clear,
            listStoryCaches: cachePort.listStoryCaches,
            pruneStoryCaches: cachePort.pruneStoryCaches,
            deleteStoryCache: cachePort.deleteStoryCache,
            getHeartbeatError() {
              return cacheLeaseError;
            },
          }),
    /** @param {string} [reason] */
    dispose(reason = 'dispose') {
      if (disposePromise) return disposePromise;
      if (typeof reason !== 'string' || reason.length === 0) {
        return Promise.reject(new TypeError('dispose reason must be a non-empty string'));
      }
      cacheExecutionId += 1;
      disposePromise = (async () => {
        const errors = [];
        const pending = [];
        try {
          const activeRun = session.getRunPromise();
          if (activeRun) pending.push(Promise.resolve(activeRun));
        } catch (error) {
          errors.push(error);
        }
        try {
          const sessionDisposal = session.dispose(reason);
          if (sessionDisposal) pending.push(Promise.resolve(sessionDisposal));
        } catch (error) {
          errors.push(error);
        }
        try {
          pending.push(Promise.resolve(session.whenInputIdle()));
        } catch (error) {
          errors.push(error);
        }
        try {
          pending.push(Promise.resolve(deactivateCacheLease()));
        } catch (error) {
          errors.push(error);
        }
        const settlements = await Promise.allSettled(pending);
        for (const settlement of settlements) {
          if (settlement.status === 'rejected') errors.push(settlement.reason);
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'DSL 4.0 TurboWarp host disposal failed');
        }
      })();
      return disposePromise;
    },
  });

  return deepFreeze({
    ok: true,
    enabled: true,
    featureFlags: successfulStartup.featureFlags,
    channel: successfulStartup.channel,
    runtimeComponent: successfulStartup.runtimeComponent,
    host,
    diagnostics: [],
  });
}
