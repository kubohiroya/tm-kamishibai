import {createDsl4AssetPreloadCoordinator} from './asset-preload-coordinator.js';
import {createDsl4AssetDependencyIndex} from './asset-dependency-index.js';
import {bubbleStyleNameForStyleIds, composeBubbleStyles} from './bubble-style.js';
import {deepFreeze, sourceOriginForStoryPath} from './story-document.js';
import {mapDsl4RuntimeExpressionError} from './expression-diagnostics.js';
import {encodeDsl4StoryPathSegment} from './story-path.js';
import {createDsl4RuntimeActionDispatcher} from './runtime-action-dispatcher.js';
import {
  dsl4CutTransition,
  dsl4StoryUsesCrossfade,
  resolveDsl4TransitionDefaults,
} from './transition-spec.js';

const defaultPoseSequenceRecognition = Object.freeze({
  confidenceThreshold: 0.5,
  fullConfidenceHoldSeconds: 1,
  idleChargePerSecond: 0,
});
const defaultPoseSelectionRecognition = Object.freeze({
  accumulationPerSecond: 1,
  decayPerSecond: 0.9,
  scoreThreshold: 0,
});
const posePreviewMirroringModes = new Set(['mirrored', 'unmirrored']);
const speechPresentationArgumentNames = Object.freeze([
  'characterIntervalSeconds',
  'characterSound',
  'noSoundCharacters',
  'restCharacters',
  'restCharacterIntervalSeconds',
]);
const advancedBubbleStyleNames = Object.freeze([
  'reveal',
  'audio',
  'showAnimation',
  'hideAnimation',
  'visibleAnimations',
]);
export const dsl4RuntimeQuiesceDefaults = Object.freeze({
  quiesceTimeoutMs: 5_000,
  minimumQuiesceTimeoutMs: 100,
  maximumQuiesceTimeoutMs: 30_000,
});

/** @param {() => void} callback @param {number} milliseconds */
function defaultScheduleQuiesceTimeout(callback, milliseconds) {
  const timer = setTimeout(callback, milliseconds);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
}

function deferred() {
  /** @type {(value: unknown) => void} */
  let resolve = () => {};
  /** @type {(reason: unknown) => void} */
  let reject = () => {};
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

/**
 * @typedef {'idle' | 'running' | 'paused' | 'failed' | 'finished' | 'stopped'} RuntimeStatus
 *
 * @typedef {object} RuntimeEvent
 * @property {number} sequence
 * @property {string} type
 * @property {string | null} sceneId
 * @property {string} storyPath
 * @property {string | null} actionPath
 * @property {number} generation
 * @property {Readonly<Record<string, unknown>>} details
 *
 * @typedef {object} ActionContext
 * @property {AbortSignal} signal
 * @property {AbortSignal} [actionSignal]
 * @property {number} generation
 * @property {string} sceneId
 * @property {number} actionIndex
 * @property {string} actionPath
 * @property {Readonly<Record<string, string | number | boolean>>} variables
 * @property {Readonly<{actionScopeRef: string, actionViewRef: string}>} [structuredData]
 * @property {(name: string) => string | number | boolean | undefined} getVariable
 * @property {(name: string, value: string | number | boolean) => boolean} setVariable
 * @property {() => Readonly<{promise: Promise<Readonly<Record<string, unknown>>>, cancel: () => void}>} createAdvanceWait
 */

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(/** @type {Record<string, unknown>} */ (value)).map(([key, child]) => [
      key,
      cloneValue(child),
    ]),
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function safeErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return 'DSL 4.0 runtime operation failed';
}

/**
 * @param {string} value
 * @returns {string}
 */
/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {string | null} storyPath
 * @param {string} sourcePath
 * @param {string} code
 * @param {string} message
 * @returns {Readonly<Record<string, unknown>>}
 */
function runtimeDiagnostic(storyDocument, storyPath, sourcePath, code, message) {
  const origin = sourceOriginForStoryPath(storyDocument, storyPath ?? '/');
  return deepFreeze({
    version: 1,
    code,
    severity: 'error',
    message,
    sourceId: origin.sourceId,
    range: origin.range,
    ...(storyPath ? {storyPath} : {}),
    path: sourcePath,
    related: [],
  });
}

/**
 * @param {object} options
 * @param {Readonly<Record<string, unknown>>} options.storyDocument
 * @param {Record<string, Function>} options.port
 * @param {{prepare: Function, setLoading: Function, releaseAssets: Function, release: Function}} [options.assetLifecycle]
 * @param {(expression: string, variables: Readonly<Record<string, string | number | boolean>>, context: ActionContext) => boolean | Promise<boolean>} [options.evaluateCondition]
 * @param {(event: RuntimeEvent) => void} [options.onEvent]
 * @param {Record<string, Function>} [options.structuredDataIntegration]
 * @param {{beforeAction: Function, getState: Function}} [options.debugExecution]
 * @param {boolean} [options.posePreviewMirroringEnabled]
 * @param {boolean} [options.cameraPreviewControlsEnabled]
 * @param {boolean} [options.poseNavigationPolicyEnabled]
 * @param {boolean} [options.speechAdvanceTypewriterEnabled]
 * @param {boolean} [options.bubbleAdvanceIndicatorEnabled]
 * @param {boolean} [options.turboWarpBubbleEnabled]
 * @param {boolean} [options.turboWarpBubbleAdvancedPresentationEnabled]
 * @param {boolean} [options.broadcastMessageAndWaitEnabled]
 * @param {boolean} [options.storyVariableWriteEnabled]
 * @param {boolean} [options.crossfadeTransitionsEnabled]
 * @param {number} [options.quiesceTimeoutMs]
 * @param {(callback: () => void, milliseconds: number) => (() => void)} [options.scheduleQuiesceTimeout]
 */
export function createDsl4RuntimeController({
  storyDocument,
  port,
  assetLifecycle,
  evaluateCondition,
  onEvent,
  structuredDataIntegration,
  debugExecution,
  posePreviewMirroringEnabled = false,
  cameraPreviewControlsEnabled = false,
  poseNavigationPolicyEnabled = false,
  speechAdvanceTypewriterEnabled = false,
  bubbleAdvanceIndicatorEnabled = false,
  turboWarpBubbleEnabled = false,
  turboWarpBubbleAdvancedPresentationEnabled = false,
  broadcastMessageAndWaitEnabled = false,
  storyVariableWriteEnabled = false,
  crossfadeTransitionsEnabled = false,
  quiesceTimeoutMs = dsl4RuntimeQuiesceDefaults.quiesceTimeoutMs,
  scheduleQuiesceTimeout = defaultScheduleQuiesceTimeout,
}) {
  if (storyDocument.kind !== 'StoryDocument' || storyDocument.version !== '4.0') {
    throw new TypeError('DSL 4.0 runtime requires a StoryDocument version 4.0');
  }
  if (
    debugExecution !== undefined &&
    (!isRecord(debugExecution) ||
      typeof debugExecution.beforeAction !== 'function' ||
      typeof debugExecution.getState !== 'function')
  ) {
    throw new TypeError('debugExecution must provide beforeAction and getState');
  }
  if (typeof posePreviewMirroringEnabled !== 'boolean') {
    throw new TypeError('posePreviewMirroringEnabled must be boolean');
  }
  if (typeof cameraPreviewControlsEnabled !== 'boolean') {
    throw new TypeError('cameraPreviewControlsEnabled must be boolean');
  }
  if (
    posePreviewMirroringEnabled &&
    typeof (/** @type {Record<string, unknown>} */ (port).setPosePreviewMirroring) !== 'function'
  ) {
    throw new TypeError(
      'setPosePreviewMirroring runtime port method is required when pose preview mirroring is enabled',
    );
  }
  if (structuredDataIntegration !== undefined) {
    if (!isRecord(structuredDataIntegration)) {
      throw new TypeError('structuredDataIntegration must be an object');
    }
    for (const method of [
      'beginStory',
      'enterScene',
      'beginNextAction',
      'currentActionResources',
      'releaseAction',
      'endStory',
      'dispose',
    ]) {
      if (typeof structuredDataIntegration[method] !== 'function') {
        throw new TypeError(`structuredDataIntegration.${method} is required`);
      }
    }
  }
  if (typeof poseNavigationPolicyEnabled !== 'boolean') {
    throw new TypeError('poseNavigationPolicyEnabled must be boolean');
  }
  if (typeof speechAdvanceTypewriterEnabled !== 'boolean') {
    throw new TypeError('speechAdvanceTypewriterEnabled must be boolean');
  }
  if (typeof bubbleAdvanceIndicatorEnabled !== 'boolean') {
    throw new TypeError('bubbleAdvanceIndicatorEnabled must be boolean');
  }
  if (bubbleAdvanceIndicatorEnabled && !speechAdvanceTypewriterEnabled) {
    throw new TypeError('bubbleAdvanceIndicatorEnabled requires speechAdvanceTypewriterEnabled');
  }
  if (typeof turboWarpBubbleEnabled !== 'boolean') {
    throw new TypeError('turboWarpBubbleEnabled must be boolean');
  }
  if (turboWarpBubbleEnabled && !speechAdvanceTypewriterEnabled) {
    throw new TypeError('turboWarpBubbleEnabled requires speechAdvanceTypewriterEnabled');
  }
  if (typeof turboWarpBubbleAdvancedPresentationEnabled !== 'boolean') {
    throw new TypeError('turboWarpBubbleAdvancedPresentationEnabled must be boolean');
  }
  if (turboWarpBubbleAdvancedPresentationEnabled && !turboWarpBubbleEnabled) {
    throw new TypeError(
      'turboWarpBubbleAdvancedPresentationEnabled requires turboWarpBubbleEnabled',
    );
  }
  if (typeof broadcastMessageAndWaitEnabled !== 'boolean') {
    throw new TypeError('broadcastMessageAndWaitEnabled must be boolean');
  }
  if (typeof storyVariableWriteEnabled !== 'boolean') {
    throw new TypeError('storyVariableWriteEnabled must be boolean');
  }
  if (typeof crossfadeTransitionsEnabled !== 'boolean') {
    throw new TypeError('crossfadeTransitionsEnabled must be boolean');
  }
  if (!crossfadeTransitionsEnabled && dsl4StoryUsesCrossfade(storyDocument)) {
    const error = new TypeError(
      'dsl4CrossfadeTransitions must be enabled for crossfade transitions',
    );
    Object.defineProperty(error, 'code', {value: 'K4-TRANSITION-FLAG-001'});
    throw error;
  }
  if (
    !Number.isSafeInteger(quiesceTimeoutMs) ||
    quiesceTimeoutMs < dsl4RuntimeQuiesceDefaults.minimumQuiesceTimeoutMs ||
    quiesceTimeoutMs > dsl4RuntimeQuiesceDefaults.maximumQuiesceTimeoutMs
  ) {
    throw new TypeError('quiesceTimeoutMs is outside the supported range');
  }
  if (typeof scheduleQuiesceTimeout !== 'function') {
    throw new TypeError('scheduleQuiesceTimeout must be a function');
  }
  if (
    port.finishPresentationTransitions !== undefined &&
    typeof port.finishPresentationTransitions !== 'function'
  ) {
    throw new TypeError('finishPresentationTransitions runtime port method must be a function');
  }
  if (port.hideSceneActors !== undefined && typeof port.hideSceneActors !== 'function') {
    throw new TypeError('hideSceneActors runtime port method must be a function');
  }
  if (port.createSceneCrossfade !== undefined && typeof port.createSceneCrossfade !== 'function') {
    throw new TypeError('createSceneCrossfade runtime port method must be a function');
  }

  const scenes = /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (
    storyDocument.scenes
  );
  const transitionDefaults = resolveDsl4TransitionDefaults(storyDocument);
  /** @type {{sceneId: string, prefixEnd: number, operation: Readonly<{start: Function, finish: Function}>} | null} */
  let pendingSceneCrossfade = null;
  if (
    !broadcastMessageAndWaitEnabled &&
    scenes.some((scene) =>
      /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (scene.actions ?? []).some(
        (action) => action.command === 'broadcastMessageAndWait',
      ),
    )
  ) {
    const error = new TypeError(
      'dsl4BroadcastMessageAndWait must be enabled for broadcastMessageAndWait actions',
    );
    Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-BROADCAST-FLAG-001'});
    throw error;
  }
  const storyActorsValue = storyDocument.actors ?? {};
  if (!isRecord(storyActorsValue)) {
    throw new TypeError('DSL 4.0 StoryDocument actors must be an object');
  }
  const storyActorIds = Object.freeze(Object.keys(storyActorsValue));
  const bubbleStylesValue = storyDocument.bubbleStyles ?? {};
  if (!isRecord(bubbleStylesValue)) {
    throw new TypeError('DSL 4.0 StoryDocument bubbleStyles must be an object');
  }
  const bubbleStyles = /** @type {Readonly<Record<string, Readonly<Record<string, unknown>>>>} */ (
    bubbleStylesValue
  );
  const bubbleClosePoliciesValue = storyDocument.bubbleClosePolicies ?? {};
  if (!isRecord(bubbleClosePoliciesValue)) {
    throw new TypeError('DSL 4.0 StoryDocument bubbleClosePolicies must be an object');
  }
  const bubbleClosePolicies =
    /** @type {Readonly<Record<string, Readonly<Record<string, unknown>>>>} */ (
      bubbleClosePoliciesValue
    );
  if (
    !bubbleAdvanceIndicatorEnabled &&
    !turboWarpBubbleEnabled &&
    Object.values(bubbleStyles).some((style) => Object.hasOwn(style, 'continueIndicator'))
  ) {
    throw new TypeError(
      'dsl4BubbleAdvanceIndicator must be enabled for bubbleStyles.continueIndicator',
    );
  }
  if (
    !turboWarpBubbleAdvancedPresentationEnabled &&
    Object.values(bubbleStyles).some((style) =>
      advancedBubbleStyleNames.some((field) => Object.hasOwn(style, field)),
    )
  ) {
    throw new TypeError(
      'dsl4TurboWarpBubbleAdvancedPresentation must be enabled for reveal, audio, or Bubble motion',
    );
  }
  if (!speechAdvanceTypewriterEnabled) {
    const extendedSpeechAction = scenes
      .flatMap(
        (scene) =>
          /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (scene.actions ?? []),
      )
      .find((action) => {
        if (action.command === 'think') return true;
        if (action.command !== 'say') return false;
        const args = /** @type {Readonly<Record<string, unknown>>} */ (action.args ?? {});
        return [
          'closePolicy',
          'waitFor',
          'startSound',
          'styles',
          ...speechPresentationArgumentNames,
        ].some((key) => Object.hasOwn(args, key));
      });
    if (extendedSpeechAction) {
      throw new TypeError(
        'dsl4SpeechAdvanceTypewriter must be enabled for think, waitFor, or extended speech',
      );
    }
  }
  const sceneIndex = new Map(scenes.map((scene, index) => [scene.id, index]));
  const branches = /** @type {Record<string, ReadonlyArray<Readonly<Record<string, string>>>>} */ (
    storyDocument.branches ?? {}
  );
  const initialVariables = /** @type {Record<string, string | number | boolean>} */ (
    storyDocument.variables ?? {}
  );
  const recognition = /** @type {Readonly<Record<string, unknown>>} */ (
    storyDocument.recognition ?? {}
  );
  const poseSequenceRecognition = deepFreeze({
    ...defaultPoseSequenceRecognition,
    .../** @type {Readonly<Record<string, number>>} */ (recognition.sequence ?? {}),
    idleSound: typeof recognition.idleSound === 'string' ? recognition.idleSound : null,
    chargeSound: typeof recognition.chargeSound === 'string' ? recognition.chargeSound : null,
    feedback: {
      mode:
        typeof (/** @type {Readonly<Record<string, unknown>>} */ (recognition.feedback)?.mode) ===
        'string'
          ? /** @type {Readonly<Record<string, string>>} */ (recognition.feedback).mode
          : 'scratchMirror',
    },
    navigation: {
      allowSkip:
        typeof (
          /** @type {Readonly<Record<string, unknown>>} */ (recognition.navigation)?.allowSkip
        ) === 'boolean'
          ? /** @type {Readonly<Record<string, boolean>>} */ (recognition.navigation).allowSkip
          : false,
    },
  });
  const poseSelectionRecognition = deepFreeze({
    ...defaultPoseSelectionRecognition,
    .../** @type {Readonly<Record<string, number>>} */ (recognition.selection ?? {}),
  });
  /** @type {Record<string, string | number | boolean>} */
  let variables = /** @type {Record<string, string | number | boolean>} */ (
    cloneValue(initialVariables)
  );
  /** @type {RuntimeStatus} */
  let status = 'idle';
  let currentSceneIndex = -1;
  let currentActionIndex = -1;
  let generation = 0;
  let sequence = 0;
  let runId = 0;
  /** @type {AbortController | null} */
  let actionAbortController = null;
  /** @type {ActionContext | null} */
  let activeActionContext = null;
  /** @type {{sceneId: string, reason: string} | null} */
  let nestedActionTransition = null;
  /** @type {string | null} */
  let nestedNavigationCommand = null;
  /** @type {Set<Promise<Readonly<Record<string, unknown>>>>} */
  const activeNestedInvocations = new Set();
  /** @type {Array<Readonly<{generation: number, operation: 'set' | 'change', name: string, value: string | number | boolean}>>} */
  let pendingVariableWrites = [];
  /** @type {Promise<Readonly<Record<string, unknown>>> | null} */
  let runPromise = null;
  /** @type {{generation: number, stepIndex: number, operation: Promise<Readonly<Record<string, unknown>>>} | null} */
  let poseAdvanceLock = null;
  /** @type {{generation: number, stepIndex: number, controller: AbortController, completion: ReturnType<typeof deferred>, cleanup: () => void, waitingForRecognition: boolean, skipRequested: boolean, skipReason: string | null} | null} */
  let activePoseWait = null;
  /** @type {{command: 'rehearsal.skipAction' | 'rehearsal.skipScene', sceneIndex: number, actionIndex: number, completion: ReturnType<typeof deferred>, operation: Promise<Readonly<Record<string, unknown>>>} | null} */
  let rehearsalSkipLock = null;
  /** @type {{sceneIndex: number, reason: 'rehearsal.skipScene'} | null} */
  let rehearsalSceneSkip = null;
  /** @type {{generation: number, armed: boolean, completion: ReturnType<typeof deferred>, cleanup: () => void} | null} */
  let activeAdvanceWait = null;
  /** @type {Record<string, any> | null} */
  let quiesceRequest = null;
  /** @type {Readonly<Record<string, unknown>> | null} */
  let failureDiagnostic = null;
  /** @type {RuntimeEvent[]} */
  const trace = [];
  const assetCoordinator = assetLifecycle
    ? createDsl4AssetPreloadCoordinator({
        storyDocument,
        lifecycle: assetLifecycle,
        onEvent: (type, details) => emit(type, details),
        ...(crossfadeTransitionsEnabled
          ? {persistentAssetIds: createDsl4AssetDependencyIndex(storyDocument).bgm}
          : {}),
        ...(cameraPreviewControlsEnabled
          ? {}
          : {
              excludedStartupAssetIds:
                createDsl4AssetDependencyIndex(storyDocument).posePreviewControls,
            }),
      })
    : null;
  let assetsReleased = true;
  let controllerDisposed = false;
  /** @type {Readonly<Record<string, any>> | null} */
  let structuredScene = null;
  /** @type {Readonly<Record<string, any>> | null} */
  let structuredAction = null;
  /** @type {Readonly<{actionScopeRef: string, actionViewRef: string}> | null} */
  let structuredActionResources = null;
  let structuredStoryActive = false;
  let structuredActionActive = false;

  /** @param {string} reason */
  function releaseAssets(reason) {
    if (!assetCoordinator || assetsReleased) return;
    assetsReleased = true;
    void assetCoordinator.release(reason);
  }

  function currentScene() {
    return structuredScene ?? scenes[currentSceneIndex];
  }

  function currentAction() {
    if (structuredAction) return structuredAction;
    const actions = /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (
      currentScene()?.actions ?? []
    );
    return actions[currentActionIndex];
  }

  /** @param {Readonly<Record<string, unknown>> | null} action */
  function isRehearsalSceneStatefulAction(action) {
    return action?.command === 'bgm' || action?.command === 'transition';
  }

  /** @param {typeof rehearsalSkipLock} lock */
  function settleRehearsalSkip(lock) {
    if (!lock || rehearsalSkipLock !== lock) return;
    rehearsalSkipLock = null;
    lock.completion.resolve(undefined);
  }

  /** @param {number} scenePosition @param {number} actionPosition */
  function actionAt(scenePosition, actionPosition) {
    const scene = scenes[scenePosition];
    const actions = /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (
      scene?.actions ?? []
    );
    return actions[actionPosition] ?? null;
  }

  /** @param {string} code @param {string} message */
  function quiesceError(code, message) {
    const error = new Error(message);
    Object.defineProperty(error, 'code', {value: code});
    const action = currentAction();
    if (typeof action?.id === 'string') {
      Object.defineProperty(error, 'storyPath', {value: action.id});
    }
    return error;
  }

  /** @param {Readonly<Record<string, unknown>>} token @param {number} candidateId */
  function retagQuiesceToken(token, candidateId) {
    return deepFreeze({...token, candidateId});
  }

  /**
   * @param {number} scenePosition
   * @param {number} actionPosition
   * @param {'next-action' | 'replay-action' | 'finished'} resumeMode
   * @param {boolean} pause
   */
  function completeQuiesce(scenePosition, actionPosition, resumeMode, pause) {
    const request = quiesceRequest;
    if (!request || request.phase !== 'quiescing') return null;
    if (pause) {
      status = 'paused';
      currentSceneIndex = scenePosition;
      currentActionIndex = actionPosition;
      actionAbortController = null;
    }
    const scene = scenes[scenePosition] ?? null;
    const action = actionAt(scenePosition, actionPosition);
    const sceneId = typeof scene?.id === 'string' ? scene.id : null;
    const storyPath =
      typeof action?.id === 'string'
        ? action.id
        : sceneId
          ? `/scenes/${encodeDsl4StoryPathSegment(sceneId)}`
          : '/';
    const token = deepFreeze({
      kind: 'Dsl4QuiesceToken',
      version: 1,
      candidateId: request.candidateId,
      runtimeGeneration: generation,
      storyPath,
      actionSignature: action
        ? {
            command: String(action.command),
            target: action.target === null ? null : String(action.target),
            handler: String(action.handler ?? 'core'),
          }
        : null,
      sceneId,
      actionIndex: actionPosition,
      variables: cloneValue(variables),
      resumeMode,
    });
    request.phase = 'token';
    request.token = token;
    try {
      request.cancelTimeout();
    } catch {
      // A timeout observer cannot change an already safe boundary.
    }
    request.cancelTimeout = () => {};
    if (pause) emit('runtime.quiesce', {candidateId: request.candidateId, resumeMode});
    request.completion.resolve(token);
    return token;
  }

  /** @param {unknown} error */
  function rejectQuiesce(error) {
    const request = quiesceRequest;
    if (!request || request.phase !== 'quiescing') return;
    request.phase = 'failed';
    try {
      request.cancelTimeout();
    } catch {
      // A timeout observer cannot replace the quiesce failure.
    }
    request.cancelTimeout = () => {};
    quiesceRequest = null;
    request.completion.reject(error);
  }

  /** @param {string} _reason */
  function abandonQuiesce(_reason) {
    const request = quiesceRequest;
    if (!request) return;
    if (request.phase === 'quiescing') {
      rejectQuiesce(
        quiesceError(
          'K4-RELOAD-QUIESCE-FAILED',
          'Runtime termination interrupted live reload quiesce',
        ),
      );
      return;
    }
    try {
      request.cancelTimeout();
    } catch {
      // Runtime termination remains authoritative.
    }
    quiesceRequest = null;
  }

  function pauseAtDispatchBoundary() {
    const request = quiesceRequest;
    if (!request || request.phase !== 'quiescing' || request.mode !== 'finish-only') {
      return false;
    }
    const scene = currentScene();
    const actions = /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (
      scene?.actions ?? []
    );
    const nextActionIndex = currentActionIndex + 1;
    if (nextActionIndex >= actions.length) return false;
    completeQuiesce(currentSceneIndex, nextActionIndex, 'next-action', true);
    return true;
  }

  /** @param {unknown} error @param {Readonly<Record<string, unknown>> | null} action */
  function normalizeStructuredCleanupError(error, action) {
    if (action?.handler !== 'custom') return error;
    const cleanupError = new Error('Custom action scope cleanup failed', {cause: error});
    Object.defineProperty(cleanupError, 'code', {value: 'K4-CUSTOM-CLEANUP-FAILED'});
    if (typeof action.id === 'string') {
      Object.defineProperty(cleanupError, 'storyPath', {value: action.id});
    }
    return cleanupError;
  }

  /** @param {string} reason */
  function releaseStructuredAction(reason) {
    if (!structuredDataIntegration || !structuredActionActive) return;
    const action = currentAction();
    try {
      structuredDataIntegration.releaseAction(reason);
    } catch (error) {
      throw normalizeStructuredCleanupError(error, action);
    } finally {
      structuredActionActive = false;
      structuredAction = null;
      structuredActionResources = null;
    }
  }

  /** @param {string} reason */
  function endStructuredStory(reason) {
    if (!structuredDataIntegration || !structuredStoryActive) return;
    const action = structuredActionActive ? currentAction() : null;
    try {
      structuredDataIntegration.endStory(reason);
    } catch (error) {
      throw normalizeStructuredCleanupError(error, action);
    } finally {
      structuredStoryActive = false;
      structuredActionActive = false;
      structuredScene = null;
      structuredAction = null;
      structuredActionResources = null;
    }
  }

  function beginStructuredStory() {
    if (!structuredDataIntegration || structuredStoryActive) return;
    structuredDataIntegration.beginStory();
    structuredStoryActive = true;
  }

  /** @param {string} sceneId @param {number} actionIndex */
  function bindStructuredScene(sceneId, actionIndex) {
    if (!structuredDataIntegration) return null;
    const entered = structuredDataIntegration.enterScene(sceneId, {actionIndex});
    if (!isRecord(entered) || !isRecord(entered.scene) || entered.scene.id !== sceneId) {
      const error = new Error('Structured Data integration returned an invalid scene');
      Object.defineProperty(error, 'code', {value: 'K4-STRUCTURED-DATA-001'});
      throw error;
    }
    structuredScene = /** @type {Readonly<Record<string, any>>} */ (entered.scene);
    structuredActionActive = false;
    structuredAction = null;
    structuredActionResources = null;
    return structuredScene;
  }

  /**
   * @param {number} scenePosition
   * @param {number} actionPosition
   * @returns {string}
   */
  function storyPathAt(scenePosition, actionPosition) {
    const scene = scenes[scenePosition];
    if (!scene) return '/';
    const actions = /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (
      scene.actions ?? []
    );
    const action = actions[actionPosition];
    return typeof action?.id === 'string'
      ? action.id
      : `/scenes/${encodeDsl4StoryPathSegment(String(scene.id))}`;
  }

  /**
   * @param {string} sceneId
   * @param {number} actionIndex
   * @returns {{sceneIndex: number} | null}
   */
  function resolvePosition(sceneId, actionIndex) {
    const nextSceneIndex = sceneIndex.get(sceneId);
    const nextScene = nextSceneIndex === undefined ? undefined : scenes[nextSceneIndex];
    const nextActions = /** @type {ReadonlyArray<unknown>} */ (nextScene?.actions ?? []);
    if (
      nextSceneIndex === undefined ||
      !Number.isInteger(actionIndex) ||
      actionIndex < 0 ||
      (nextActions.length > 0 && actionIndex >= nextActions.length) ||
      (nextActions.length === 0 && actionIndex !== 0)
    ) {
      return null;
    }
    return {sceneIndex: nextSceneIndex};
  }

  /**
   * Validate a planner-produced variable snapshot before interrupting the current run.
   *
   * @param {unknown} input
   * @returns {Record<string, string | number | boolean>}
   */
  function resolveStartVariables(input) {
    if (input === undefined) {
      return /** @type {Record<string, string | number | boolean>} */ (
        cloneValue(initialVariables)
      );
    }
    if (!isRecord(input)) throw new TypeError('runtime start variables must be an object');
    const expectedNames = Object.keys(initialVariables).sort();
    const actualNames = Object.keys(input).sort();
    if (
      expectedNames.length !== actualNames.length ||
      expectedNames.some((name, index) => name !== actualNames[index])
    ) {
      throw new TypeError('runtime start variables must match every declared story variable');
    }
    for (const name of expectedNames) {
      const value = input[name];
      if (
        (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') ||
        typeof value !== typeof initialVariables[name]
      ) {
        throw new TypeError(`runtime start variable ${JSON.stringify(name)} has the wrong type`);
      }
    }
    return /** @type {Record<string, string | number | boolean>} */ (cloneValue(input));
  }

  /**
   * @param {string} type
   * @param {Record<string, unknown>} [details]
   */
  function emit(type, details = {}) {
    const scene = currentScene();
    const action = currentAction();
    const scenePath =
      typeof scene?.id === 'string' ? `/scenes/${encodeDsl4StoryPathSegment(scene.id)}` : '/';
    const event = /** @type {RuntimeEvent} */ (
      deepFreeze({
        sequence: sequence++,
        type,
        sceneId: typeof scene?.id === 'string' ? scene.id : null,
        storyPath: typeof action?.id === 'string' ? action.id : scenePath,
        actionPath: typeof action?.id === 'string' ? action.id : null,
        generation,
        details: cloneValue(details),
      })
    );
    trace.push(event);
    const lock = rehearsalSkipLock;
    if (lock) {
      const enteredAnotherScene = type === 'scene.enter' && currentSceneIndex !== lock.sceneIndex;
      const startedAnotherAction =
        type === 'action.start' &&
        (currentSceneIndex !== lock.sceneIndex || currentActionIndex !== lock.actionIndex);
      const terminal =
        type === 'runtime.finish' || type === 'runtime.fail' || type === 'runtime.stop';
      if (
        terminal ||
        enteredAnotherScene ||
        (lock.command === 'rehearsal.skipAction' && startedAnotherAction)
      ) {
        settleRehearsalSkip(lock);
      }
    }
    if (
      rehearsalSceneSkip &&
      ((type === 'scene.enter' && currentSceneIndex !== rehearsalSceneSkip.sceneIndex) ||
        type === 'runtime.finish' ||
        type === 'runtime.fail' ||
        type === 'runtime.stop')
    ) {
      rehearsalSceneSkip = null;
    }
    try {
      onEvent?.(event);
    } catch {
      // Observers cannot change execution semantics.
    }
  }

  function snapshot() {
    const scene = currentScene();
    const action = currentAction();
    return deepFreeze({
      status,
      sceneId: typeof scene?.id === 'string' ? scene.id : null,
      actionIndex: currentActionIndex,
      actionPath: typeof action?.id === 'string' ? action.id : null,
      generation,
      variables: cloneValue(variables),
      diagnostic: failureDiagnostic,
    });
  }

  /**
   * @param {number} actionGeneration
   * @returns {boolean}
   */
  function isCurrent(actionGeneration) {
    return status === 'running' && generation === actionGeneration;
  }

  /**
   * @param {number} actionGeneration
   * @param {AbortSignal} signal
   * @returns {ActionContext}
   */
  function actionContext(actionGeneration, signal) {
    const scene = currentScene();
    const action = currentAction();
    const sceneId = String(scene.id);
    const actionPath = String(action.id);
    return {
      signal,
      generation: actionGeneration,
      sceneId,
      actionIndex: currentActionIndex,
      actionPath,
      variables: deepFreeze({...variables}),
      ...(structuredDataIntegration && structuredActionResources
        ? {structuredData: structuredActionResources}
        : {}),
      getVariable(name) {
        return variables[name];
      },
      setVariable(name, value) {
        if (!isCurrent(actionGeneration) || signal.aborted || !Object.hasOwn(variables, name)) {
          return false;
        }
        if (typeof variables[name] !== typeof value) return false;
        variables[name] = value;
        return true;
      },
      createAdvanceWait() {
        if (!speechAdvanceTypewriterEnabled) {
          throw new TypeError('Speech advance input is disabled');
        }
        if (!isCurrent(actionGeneration) || signal.aborted) {
          throw Object.assign(new Error('DSL 4.0 runtime action was cancelled'), {
            name: 'AbortError',
          });
        }
        if (activeAdvanceWait) {
          throw new Error('Only one speech advance wait may be active');
        }
        const completion = deferred();
        /** @type {{generation: number, armed: boolean, completion: ReturnType<typeof deferred>, cleanup: () => void}} */
        const wait = {
          generation: actionGeneration,
          armed: false,
          completion,
          cleanup: () => {},
        };
        const close = (outcome = 'cancelled', input = null) => {
          if (activeAdvanceWait !== wait) return;
          activeAdvanceWait = null;
          wait.cleanup();
          completion.resolve(deepFreeze({outcome, ...(input ? {input: cloneValue(input)} : {})}));
        };
        const handleAbort = () => close();
        wait.cleanup = () => signal.removeEventListener('abort', handleAbort);
        signal.addEventListener('abort', handleAbort, {once: true});
        activeAdvanceWait = wait;
        queueMicrotask(() => {
          if (activeAdvanceWait === wait && isCurrent(actionGeneration) && !signal.aborted) {
            wait.armed = true;
          }
        });
        return Object.freeze({
          promise: completion.promise,
          cancel: () => close(),
        });
      },
    };
  }

  /** @param {Readonly<Record<string, unknown>>} input */
  function acceptAdvanceInput(input) {
    if (!speechAdvanceTypewriterEnabled || !isRecord(input)) return false;
    const wait = activeAdvanceWait;
    if (!wait || !wait.armed || !isCurrent(wait.generation)) return false;
    activeAdvanceWait = null;
    wait.cleanup();
    wait.completion.resolve(deepFreeze({outcome: 'advance', input: cloneValue(input)}));
    emit('speech.advance', {input: cloneValue(input)});
    return true;
  }

  /**
   * Consume an eligible input while an advance wait is active, including the
   * unarmed interval that protects the speech-starting event from reuse.
   *
   * @param {Readonly<Record<string, unknown>>} input
   */
  function consumeAdvanceInput(input) {
    if (!speechAdvanceTypewriterEnabled || !isRecord(input)) return false;
    const wait = activeAdvanceWait;
    if (!wait || !isCurrent(wait.generation)) return false;
    if (!wait.armed) return true;
    return acceptAdvanceInput(input);
  }

  /**
   * @param {ActionContext} context
   */
  function ensureActive(context) {
    if (isCurrent(context.generation) && !context.signal.aborted) return;
    const error = new Error('DSL 4.0 runtime action was cancelled');
    error.name = 'AbortError';
    throw error;
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} payload
   * @param {ActionContext} context
   * @returns {Promise<unknown>}
   */
  async function invokePort(method, payload, context) {
    const operation = port[method];
    if (typeof operation !== 'function') {
      const error = new Error(`Runtime port method ${method} is not available`);
      Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-PORT-001'});
      throw error;
    }
    return operation(payload, context);
  }

  /** @param {string} reason */
  function finishPresentationTransitions(reason) {
    const errors = [];
    try {
      pendingSceneCrossfade?.operation.finish(reason);
    } catch (error) {
      errors.push(error);
    }
    pendingSceneCrossfade = null;
    try {
      port.finishPresentationTransitions?.(reason);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Presentation transition finalization failed');
    }
  }

  /** @param {Readonly<Record<string, unknown>>} scene */
  function sceneEntryPrefixEnd(scene) {
    const eligible = new Set([
      'stage',
      'bgm',
      'show',
      'hide',
      'setSkin',
      'setLayer',
      'setTransparency',
      'setText',
    ]);
    const actions = /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (
      scene.actions ?? []
    );
    let end = 0;
    for (const action of actions) {
      if (!eligible.has(String(action.command))) break;
      if (
        action.command === 'setTransparency' &&
        isRecord(action.args) &&
        Number(action.args.seconds ?? 0) > 0
      ) {
        break;
      }
      end += 1;
    }
    return end;
  }

  /** @param {string} reason @param {number} actionIndex */
  function sceneCrossfadeAllowed(reason, actionIndex) {
    if (actionIndex !== 0) return false;
    return ![
      'start',
      'restart',
      'rehearsal',
      'history',
      'live-reload',
      'resume',
      'reposition',
    ].some((token) => reason.includes(token));
  }

  /** @param {Readonly<Record<string, unknown>>} scene @param {string} reason @param {number} actionIndex */
  async function prepareSceneCrossfade(scene, reason, actionIndex) {
    if (!crossfadeTransitionsEnabled || !sceneCrossfadeAllowed(reason, actionIndex)) return null;
    const transition = scene.entryTransition ?? transitionDefaults.scene;
    if (!isRecord(transition) || transition.effect !== 'crossfade') return null;
    const prefixEnd = sceneEntryPrefixEnd(scene);
    if (typeof port.createSceneCrossfade !== 'function') {
      const error = new Error('Scene crossfade platform capability is unavailable');
      Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-PORT-001'});
      throw error;
    }
    const operation = await port.createSceneCrossfade(transition, {
      from: currentScene()?.id ?? null,
      to: scene.id,
      reason,
    });
    if (
      !isRecord(operation) ||
      typeof operation.start !== 'function' ||
      typeof operation.finish !== 'function'
    ) {
      const error = new Error('Scene crossfade operation is invalid');
      Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-PORT-001'});
      throw error;
    }
    return {
      sceneId: String(scene.id),
      prefixEnd,
      operation: /** @type {Readonly<{start: Function, finish: Function}>} */ (
        /** @type {unknown} */ (operation)
      ),
    };
  }

  async function startPendingSceneCrossfade() {
    const pending = pendingSceneCrossfade;
    if (!pending) return;
    pendingSceneCrossfade = null;
    await pending.operation.start();
  }

  /** @param {Readonly<Record<string, unknown>>} scene */
  function applyPosePreviewMirroring(scene) {
    if (!posePreviewMirroringEnabled) return;
    const operation = port.setPosePreviewMirroring;
    const storyPreview = isRecord(recognition.preview) ? recognition.preview : {};
    const scenePreview = isRecord(scene.posePreview) ? scene.posePreview : {};
    const mode = scenePreview.mirroring ?? storyPreview.mirroring ?? 'mirrored';
    if (typeof mode !== 'string' || !posePreviewMirroringModes.has(mode)) {
      const error = new Error('Pose preview mirroring mode is invalid');
      Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-POSE-PREVIEW-001'});
      throw error;
    }
    operation(mode);
  }

  /**
   * @param {string} sceneId
   * @param {string} reason
   * @param {number} [actionIndex]
   */
  function transitionTo(sceneId, reason, actionIndex = 0) {
    const nextIndex = sceneIndex.get(sceneId);
    if (nextIndex === undefined) {
      const error = new Error(`Unknown scene: ${sceneId}`);
      Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-SCENE-001'});
      throw error;
    }
    const nextScene = scenes[nextIndex];
    const from = currentScene()?.id ?? null;
    port.hideSceneActors?.(
      deepFreeze({
        actors: storyActorIds,
        from,
        to: sceneId,
        reason,
      }),
    );
    applyPosePreviewMirroring(nextScene);
    bindStructuredScene(sceneId, actionIndex);
    currentSceneIndex = nextIndex;
    currentActionIndex = actionIndex - 1;
    emit('scene.transition', {from, to: sceneId, reason});
    emit('scene.enter', {reason});
  }

  /**
   * Prepare the target while the current scene remains committed, then publish the transition.
   *
   * @param {string} sceneId
   * @param {string} reason
   * @param {number} activeRunId
   * @param {number} [actionIndex]
   * @returns {Promise<boolean>}
   */
  async function enterScene(sceneId, reason, activeRunId, actionIndex = 0) {
    if (assetCoordinator) {
      assetCoordinator.beginScene(sceneId, generation);
      const readiness = await assetCoordinator.waitForScene(sceneId);
      if (runId !== activeRunId || status !== 'running') return false;
      if (!readiness.ok) {
        if (!readiness.cancelled) fail(readiness.error);
        return false;
      }
    }
    const nextIndex = sceneIndex.get(sceneId);
    const nextScene = nextIndex === undefined ? null : scenes[nextIndex];
    let preparedSceneCrossfade = null;
    try {
      preparedSceneCrossfade = nextScene
        ? await prepareSceneCrossfade(nextScene, reason, actionIndex)
        : null;
    } catch (error) {
      if (runId === activeRunId && status === 'running') fail(error);
      return false;
    }
    if (runId !== activeRunId || status !== 'running') {
      try {
        preparedSceneCrossfade?.operation.finish(reason);
      } catch {
        // A superseded run cannot publish a cleanup failure into the active run.
      }
      return false;
    }
    pendingSceneCrossfade = preparedSceneCrossfade;
    try {
      transitionTo(sceneId, reason, actionIndex);
    } catch (error) {
      if (runId === activeRunId && status === 'running') fail(error);
      return false;
    }
    if (assetCoordinator) {
      try {
        await assetCoordinator.commitScene(sceneId, 'scene-transition');
      } catch (error) {
        if (runId === activeRunId && status === 'running') fail(error);
        return false;
      }
      if (runId !== activeRunId || status !== 'running') return false;
    }
    if (pendingSceneCrossfade?.prefixEnd === 0) {
      try {
        await startPendingSceneCrossfade();
      } catch (error) {
        if (runId === activeRunId && status === 'running') fail(error);
        return false;
      }
    }
    return true;
  }

  /**
   * @param {string} branchId
   * @param {ActionContext} context
   * @returns {Promise<string>}
   */
  async function resolveBranch(branchId, context) {
    const rules = branches[branchId];
    if (!rules) {
      const error = new Error(`Unknown branch: ${branchId}`);
      Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-BRANCH-001'});
      throw error;
    }
    for (const [ruleIndex, rule] of rules.entries()) {
      if (rule.else) return rule.else;
      if (typeof evaluateCondition !== 'function') {
        const error = new Error('Runtime condition evaluator is not available');
        Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-PORT-001'});
        throw error;
      }
      let matches;
      try {
        matches = await evaluateCondition(rule.if, context.variables, context);
      } catch (error) {
        throw mapDsl4RuntimeExpressionError(error, {
          storyPath: `/branches/${encodeDsl4StoryPathSegment(branchId)}/${ruleIndex}/if`,
          sourcePath: `$.branches[${JSON.stringify(branchId)}][${ruleIndex}].if`,
        });
      }
      ensureActive(context);
      if (matches) return rule.goto;
    }
    const error = new Error(`Branch ${branchId} has no matching destination`);
    Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-BRANCH-002'});
    throw error;
  }

  /**
   * @param {'say' | 'think'} command
   * @param {Record<string, unknown>} args
   */
  function resolveSpeechStyle(command, args) {
    let resolvedArgs = args;
    if (Object.hasOwn(args, 'closePolicy')) {
      const policyId = args.closePolicy;
      const policy = typeof policyId === 'string' ? bubbleClosePolicies[policyId] : undefined;
      if (!isRecord(policy)) {
        const error = new Error(`${command}.closePolicy is unavailable: ${String(policyId)}`);
        Object.defineProperty(error, 'code', {
          value: 'K4-RUNTIME-SPEECH-CLOSE-POLICY-001',
        });
        throw error;
      }
      const actionArgs = Object.fromEntries(
        Object.entries(args).filter(([key]) => key !== 'closePolicy'),
      );
      const resolvedPolicy = /** @type {Record<string, unknown>} */ (cloneValue(policy));
      resolvedArgs = {...resolvedPolicy, ...actionArgs};
    }
    if (!Object.hasOwn(resolvedArgs, 'styles')) return resolvedArgs;
    const styleIds = resolvedArgs.styles;
    if (
      !Array.isArray(styleIds) ||
      styleIds.length === 0 ||
      styleIds.some((styleId) => typeof styleId !== 'string') ||
      new Set(styleIds).size !== styleIds.length
    ) {
      const error = new Error(`${command}.styles must be an array of bubble style names`);
      Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-SPEECH-STYLE-001'});
      throw error;
    }
    const actionArgs = Object.fromEntries(
      Object.entries(resolvedArgs).filter(([key]) => key !== 'styles'),
    );
    const resolvedStyle = composeBubbleStyles(styleIds, bubbleStyles);
    const presentation = Object.fromEntries(
      speechPresentationArgumentNames
        .filter((field) => Object.hasOwn(resolvedStyle, field))
        .map((field) => [field, resolvedStyle[field]]),
    );
    return {
      ...presentation,
      ...(!turboWarpBubbleEnabled && Object.hasOwn(resolvedStyle, 'continueIndicator')
        ? {advanceIndicator: resolvedStyle.continueIndicator}
        : {}),
      ...(turboWarpBubbleAdvancedPresentationEnabled && Object.hasOwn(resolvedStyle, 'reveal')
        ? {bubbleReveal: resolvedStyle.reveal}
        : {}),
      ...(turboWarpBubbleAdvancedPresentationEnabled &&
      Object.hasOwn(resolvedStyle, 'visibleAnimations')
        ? {bubbleMotions: resolvedStyle.visibleAnimations}
        : {}),
      ...actionArgs,
      ...(turboWarpBubbleEnabled ? {bubbleStyle: bubbleStyleNameForStyleIds(styleIds)} : {}),
    };
  }

  /**
   * @param {Readonly<{target: string | null, args: Record<string, unknown>}>} payload
   * @param {ActionContext} context
   */
  async function dispatchPose({target, args}, context) {
    const steps = /** @type {ReadonlyArray<Readonly<Record<string, string>>>} */ (args.steps);
    const recognitionModel = String(currentScene()?.recognitionModel ?? '');
    for (const [stepIndex, step] of steps.entries()) {
      const stepController = new AbortController();
      const handleActionAbort = () => stepController.abort(context.signal.reason);
      if (context.signal.aborted) handleActionAbort();
      else context.signal.addEventListener('abort', handleActionAbort, {once: true});
      const poseWait = {
        generation: context.generation,
        stepIndex,
        controller: stepController,
        completion: deferred(),
        cleanup: () => context.signal.removeEventListener('abort', handleActionAbort),
        waitingForRecognition: false,
        skipRequested: false,
        skipReason: null,
      };
      if (
        poseAdvanceLock?.generation === context.generation &&
        poseAdvanceLock.stepIndex !== stepIndex
      ) {
        poseAdvanceLock = null;
      }
      activePoseWait = poseWait;
      const stepContext = {
        ...context,
        signal: stepController.signal,
        actionSignal: context.signal,
      };
      let skipped = false;
      try {
        if (typeof step.skin === 'string') {
          await invokePort('setSkin', {target, skin: step.skin}, stepContext);
          ensureActive(context);
        }
        poseWait.waitingForRecognition = true;
        await invokePort(
          'waitForPose',
          {
            target,
            pose: step.pose,
            stepIndex,
            stepCount: steps.length,
            recognitionModel,
            recognitionMode: 'pose',
            recognition: cloneValue(poseSequenceRecognition),
          },
          stepContext,
        );
        if (poseWait.skipRequested && !context.signal.aborted && isCurrent(context.generation)) {
          skipped = true;
        }
      } catch (error) {
        const errorRecord = isRecord(error) ? error : {};
        if (
          !poseWait.skipRequested ||
          context.signal.aborted ||
          !isCurrent(context.generation) ||
          errorRecord.name !== 'AbortError'
        ) {
          throw error;
        }
        skipped = true;
      } finally {
        poseWait.cleanup();
        if (activePoseWait === poseWait) activePoseWait = null;
        poseWait.completion.resolve(undefined);
      }
      if (skipped) {
        emit('pose.step.skip', {
          stepIndex,
          reason: poseWait.skipReason ?? 'navigation.nextAction',
        });
        continue;
      }
      ensureActive(context);
      if (typeof step.sound === 'string') {
        await invokePort('bgm', {sound: step.sound}, context);
        ensureActive(context);
      }
    }
  }

  const runtimeActionDispatcher = createDsl4RuntimeActionDispatcher({
    invokePort,
    resolveBranch,
    resolveSpeechStyle,
    getRecognitionModel: () => String(currentScene()?.recognitionModel ?? ''),
    poseSelectionRecognition,
    dispatchPose,
  });

  /**
   * @param {Readonly<Record<string, unknown>>} action
   * @param {ActionContext} context
   * @param {{rehearsalSceneSkip?: boolean, sceneEntryStaging?: boolean}} [options]
   */
  function dispatch(action, context, options) {
    const transitionKey =
      /** @type {'backdrop' | 'bgm' | 'actorVisibility' | 'actorSkin' | undefined} */ (
        {
          stage: 'backdrop',
          bgm: 'bgm',
          show: 'actorVisibility',
          hide: 'actorVisibility',
          setSkin: 'actorSkin',
        }[String(action.command)]
      );
    if (!crossfadeTransitionsEnabled || !transitionKey || !isRecord(action.args)) {
      return runtimeActionDispatcher.dispatch(action, context, options);
    }
    const args = action.args;
    const transition =
      options?.sceneEntryStaging && transitionKey !== 'bgm'
        ? dsl4CutTransition
        : (args.transition ?? transitionDefaults[transitionKey]);
    return runtimeActionDispatcher.dispatch(
      deepFreeze({
        ...action,
        args: {...args, transition, ...(transitionKey === 'bgm' ? {managed: true} : {})},
      }),
      context,
      options,
    );
  }

  /** @param {string} code @param {string} message */
  function invocationError(code, message) {
    const error = new Error(message);
    Object.defineProperty(error, 'code', {value: code});
    return error;
  }

  /**
   * Invoke one already-normalized action from a TurboWarp receiver while the
   * current DSL action remains active. The parent action owns cancellation,
   * variable access, diagnostics, and the eventual scene transition commit.
   *
   * @param {Readonly<Record<string, unknown>>} action
   * @returns {Promise<Readonly<Record<string, unknown>>>}
   */
  function invokeAction(action) {
    const context = activeActionContext;
    if (
      status !== 'running' ||
      !context ||
      context.signal.aborted ||
      !isCurrent(context.generation)
    ) {
      return Promise.reject(
        invocationError(
          'K4-RUNTIME-INVOKE-INACTIVE',
          'TurboWarp actions require an active DSL 4.0 action',
        ),
      );
    }

    const command = isRecord(action) ? String(action.command ?? '') : '';
    const navigationCommand = [
      'goto',
      'branch',
      'keyInputToChangeScene',
      'touchInputToChangeScene',
      'poseInputToChangeScene',
    ].includes(command);
    if (navigationCommand) {
      if (nestedNavigationCommand !== null) {
        const error = invocationError(
          'K4-RUNTIME-INVOKE-TRANSITION-CONFLICT',
          `TurboWarp action ${command} conflicts with active navigation action ${nestedNavigationCommand}`,
        );
        fail(error);
        return Promise.reject(error);
      }
      nestedNavigationCommand = command;
    }

    const operation = (async () => {
      try {
        const transition = await dispatch(action, context);
        if (!isCurrent(context.generation) || context.signal.aborted) {
          throw invocationError(
            'K4-RUNTIME-INVOKE-CANCELLED',
            'TurboWarp action was cancelled with its parent DSL 4.0 action',
          );
        }
        if (transition) nestedActionTransition = transition;
        return deepFreeze(
          transition
            ? {outcome: 'transitioned', sceneId: transition.sceneId, reason: transition.reason}
            : {outcome: 'completed'},
        );
      } catch (error) {
        if (isCurrent(context.generation) && !context.signal.aborted) fail(error);
        throw error;
      }
    })();
    activeNestedInvocations.add(operation);
    void operation.then(
      () => activeNestedInvocations.delete(operation),
      () => activeNestedInvocations.delete(operation),
    );
    return operation;
  }

  /**
   * Queue a typed story-variable mutation for the active action boundary.
   *
   * @param {unknown} request
   */
  function queueVariableWrite(request) {
    /** @param {string} code */
    const reject = (code) => deepFreeze({accepted: false, code});
    if (!storyVariableWriteEnabled) return reject('K4-VARIABLE-WRITE-DISABLED');
    const context = activeActionContext;
    if (
      status !== 'running' ||
      !context ||
      context.signal.aborted ||
      !isCurrent(context.generation)
    ) {
      return reject('K4-VARIABLE-WRITE-INACTIVE');
    }
    if (!isRecord(request)) return reject('K4-VARIABLE-WRITE-INPUT');
    const operation = request.operation;
    const name = request.name;
    const value = request.value;
    if (operation !== 'set' && operation !== 'change') {
      return reject('K4-VARIABLE-WRITE-INPUT');
    }
    if (typeof name !== 'string' || !Object.hasOwn(variables, name)) {
      return reject('K4-VARIABLE-WRITE-UNKNOWN');
    }
    if (operation === 'change') {
      if (typeof variables[name] !== 'number') return reject('K4-VARIABLE-WRITE-TYPE');
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return reject('K4-VARIABLE-WRITE-VALUE');
      }
    } else {
      if (typeof variables[name] !== typeof value) return reject('K4-VARIABLE-WRITE-TYPE');
      if (typeof value === 'number' && !Number.isFinite(value)) {
        return reject('K4-VARIABLE-WRITE-VALUE');
      }
      if (!['string', 'number', 'boolean'].includes(typeof value)) {
        return reject('K4-VARIABLE-WRITE-VALUE');
      }
    }
    pendingVariableWrites.push(
      Object.freeze({
        generation: context.generation,
        operation,
        name,
        value: /** @type {string | number | boolean} */ (value),
      }),
    );
    return deepFreeze({accepted: true, code: ''});
  }

  /** @param {number} actionGeneration */
  function commitVariableWrites(actionGeneration) {
    const writes = pendingVariableWrites;
    pendingVariableWrites = [];
    for (const write of writes) {
      if (write.generation !== actionGeneration) continue;
      if (write.operation === 'change') {
        const next = Number(variables[write.name]) + Number(write.value);
        if (Number.isFinite(next)) variables[write.name] = next;
        continue;
      }
      variables[write.name] = write.value;
    }
  }

  /** @param {unknown} error */
  function rejectActionInvocation(error) {
    const context = activeActionContext;
    if (
      status !== 'running' ||
      !context ||
      context.signal.aborted ||
      !isCurrent(context.generation)
    ) {
      return Promise.reject(
        invocationError(
          'K4-RUNTIME-INVOKE-INACTIVE',
          'TurboWarp actions require an active DSL 4.0 action',
        ),
      );
    }
    const failure =
      error instanceof Error
        ? error
        : invocationError('K4-BLOCK-ACTION-001', 'TurboWarp action input is invalid');
    fail(failure);
    return Promise.reject(failure);
  }

  async function waitForNestedInvocations() {
    while (activeNestedInvocations.size > 0) {
      await Promise.all([...activeNestedInvocations]);
    }
  }

  /**
   * @param {unknown} error
   * @param {boolean} [cleanupStructuredData]
   */
  function fail(error, cleanupStructuredData = true) {
    if (
      status === 'failed' ||
      status === 'stopped' ||
      (status === 'finished' && !structuredStoryActive)
    ) {
      return;
    }
    let terminalError = error;
    try {
      finishPresentationTransitions('runtime-failed');
    } catch {
      // The triggering runtime error remains authoritative after best-effort cleanup.
    }
    if (cleanupStructuredData && structuredDataIntegration) {
      try {
        endStructuredStory('runtime-failed');
      } catch (cleanupError) {
        terminalError = cleanupError;
      }
    }
    status = 'failed';
    pendingVariableWrites = [];
    actionAbortController?.abort('runtime-failed');
    const actionPath = typeof currentAction()?.id === 'string' ? String(currentAction().id) : null;
    const errorRecord =
      typeof terminalError === 'object' && terminalError !== null
        ? /** @type {Record<string, unknown>} */ (terminalError)
        : {};
    const code = typeof errorRecord.code === 'string' ? errorRecord.code : 'K4-RUNTIME-ACTION-001';
    const errorStoryPath =
      typeof errorRecord.storyPath === 'string' ? errorRecord.storyPath : actionPath;
    const errorSourcePath =
      typeof errorRecord.sourcePath === 'string' ? errorRecord.sourcePath : (errorStoryPath ?? '$');
    failureDiagnostic = runtimeDiagnostic(
      storyDocument,
      errorStoryPath,
      errorSourcePath,
      code,
      safeErrorMessage(terminalError),
    );
    releaseAssets('runtime-failed');
    emit('runtime.fail', {code});
    rejectQuiesce(
      terminalError instanceof Error
        ? terminalError
        : quiesceError('K4-RELOAD-QUIESCE-FAILED', 'Runtime failed while quiescing'),
    );
  }

  /**
   * @param {number} activeRunId
   */
  async function run(activeRunId) {
    try {
      while (status === 'running') {
        const scene = currentScene();
        if (!scene) {
          status = 'finished';
          emit('runtime.finish');
          break;
        }
        if (assetCoordinator) {
          const readiness = await assetCoordinator.waitForScene(String(scene.id));
          if (runId !== activeRunId || status !== 'running') break;
          if (!readiness.ok) {
            if (!readiness.cancelled) fail(readiness.error);
            break;
          }
          if (readiness.prepared) {
            try {
              await assetCoordinator.commitScene(String(scene.id), 'scene-resume');
            } catch (error) {
              if (runId === activeRunId && status === 'running') fail(error);
              break;
            }
            if (runId !== activeRunId || status !== 'running') break;
          }
        }
        const actions = /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (
          scene.actions
        );
        if (pauseAtDispatchBoundary()) break;
        if (currentActionIndex + 1 >= actions.length) {
          if (currentSceneIndex + 1 >= scenes.length) {
            try {
              endStructuredStory('runtime-finished');
            } catch (error) {
              fail(error, false);
              break;
            }
            status = 'finished';
            currentActionIndex = actions.length;
            emit('runtime.finish');
            completeQuiesce(currentSceneIndex, currentActionIndex, 'finished', false);
            break;
          }
          const sceneSkip =
            rehearsalSceneSkip?.sceneIndex === currentSceneIndex ? rehearsalSceneSkip : null;
          if (sceneSkip) {
            emit('navigation.advanceScene', {
              fromStoryPath: storyPathAt(currentSceneIndex, currentActionIndex),
              toStoryPath: storyPathAt(currentSceneIndex + 1, 0),
              reason: sceneSkip.reason,
            });
          }
          if (
            !(await enterScene(
              String(scenes[currentSceneIndex + 1].id),
              sceneSkip?.reason ?? 'sequential',
              activeRunId,
            ))
          ) {
            break;
          }
          continue;
        }

        currentActionIndex += 1;
        if (structuredDataIntegration) {
          try {
            const next = structuredDataIntegration.beginNextAction();
            if (
              !isRecord(next) ||
              next.status !== 'item' ||
              next.index !== currentActionIndex ||
              !isRecord(next.action) ||
              !isRecord(next.resources) ||
              typeof next.resources.actionScopeRef !== 'string' ||
              typeof next.resources.actionViewRef !== 'string'
            ) {
              const error = new Error('Structured Data action Iterator is inconsistent');
              Object.defineProperty(error, 'code', {value: 'K4-STRUCTURED-DATA-001'});
              throw error;
            }
            const currentResources = structuredDataIntegration.currentActionResources();
            if (
              !isRecord(currentResources) ||
              currentResources.actionScopeRef !== next.resources.actionScopeRef ||
              currentResources.actionViewRef !== next.resources.actionViewRef
            ) {
              const error = new Error('Structured Data action resources are inconsistent');
              Object.defineProperty(error, 'code', {value: 'K4-STRUCTURED-DATA-001'});
              throw error;
            }
            structuredActionActive = true;
            structuredAction = /** @type {Readonly<Record<string, any>>} */ (next.action);
            structuredActionResources = deepFreeze({
              actionScopeRef: currentResources.actionScopeRef,
              actionViewRef: currentResources.actionViewRef,
            });
          } catch (error) {
            fail(error);
            break;
          }
        }
        const applyingRehearsalSceneState = rehearsalSceneSkip?.sceneIndex === currentSceneIndex;
        if (applyingRehearsalSceneState && !isRehearsalSceneStatefulAction(currentAction())) {
          try {
            releaseStructuredAction('rehearsal.skipScene');
          } catch (error) {
            fail(error);
            break;
          }
          emit('action.skip', {reason: 'rehearsal.skipScene'});
          continue;
        }
        generation += 1;
        const actionGeneration = generation;
        actionAbortController = new AbortController();
        const context = actionContext(actionGeneration, actionAbortController.signal);
        if (debugExecution) {
          try {
            await debugExecution.beforeAction({
              command: String(currentAction()?.command ?? ''),
              sceneId: context.sceneId,
              actionIndex: currentActionIndex,
              actionPath: context.actionPath,
              signal: context.signal,
            });
          } catch (error) {
            if (!isCurrent(actionGeneration) || actionAbortController.signal.aborted) break;
            fail(error);
            break;
          }
          if (!isCurrent(actionGeneration) || actionAbortController.signal.aborted) break;
        }
        emit('action.start');
        let transition = null;
        activeActionContext = context;
        pendingVariableWrites = [];
        nestedActionTransition = null;
        nestedNavigationCommand = null;
        activeNestedInvocations.clear();
        try {
          const stagingTransition = pendingSceneCrossfade;
          transition = await dispatch(currentAction(), context, {
            rehearsalSceneSkip: applyingRehearsalSceneState,
            sceneEntryStaging:
              stagingTransition?.sceneId === scene.id &&
              currentActionIndex < (stagingTransition?.prefixEnd ?? 0),
          });
          await waitForNestedInvocations();
        } catch (error) {
          if (!isCurrent(actionGeneration) || actionAbortController.signal.aborted) break;
          fail(error);
          break;
        } finally {
          if (activeActionContext === context) activeActionContext = null;
          if (!isCurrent(actionGeneration) || actionAbortController.signal.aborted) {
            pendingVariableWrites = [];
          }
        }
        if (!isCurrent(actionGeneration) || actionAbortController.signal.aborted) break;
        transition = nestedActionTransition ?? transition;
        nestedActionTransition = null;
        nestedNavigationCommand = null;
        try {
          releaseStructuredAction('action-complete');
        } catch (error) {
          fail(error);
          break;
        }
        commitVariableWrites(actionGeneration);
        emit('action.commit');
        actionAbortController = null;
        const completingSceneTransition = pendingSceneCrossfade;
        if (
          completingSceneTransition?.sceneId === scene.id &&
          currentActionIndex + 1 >= (completingSceneTransition?.prefixEnd ?? Infinity)
        ) {
          try {
            await startPendingSceneCrossfade();
          } catch (error) {
            if (runId === activeRunId && status === 'running') fail(error);
            break;
          }
          if (runId !== activeRunId || status !== 'running') break;
        }
        if (transition && !(await enterScene(transition.sceneId, transition.reason, activeRunId))) {
          break;
        }
      }
    } finally {
      if (runId === activeRunId) {
        actionAbortController = null;
        runPromise = null;
      }
    }
    return snapshot();
  }

  /**
   * @param {string} entrySceneId
   * @param {number} entryActionIndex
   * @param {number} activeRunId
   */
  async function runWithAssetStartup(entrySceneId, entryActionIndex, activeRunId) {
    if (!assetCoordinator) throw new Error('Asset startup requires an asset coordinator');
    let delegatedToRun = false;
    try {
      const readiness = await assetCoordinator.prepareStartup(generation);
      if (runId !== activeRunId || status !== 'running') return snapshot();
      if (!readiness.ok) {
        if (!readiness.cancelled) fail(readiness.error);
        return snapshot();
      }
      if (!(await enterScene(entrySceneId, 'start', activeRunId, entryActionIndex))) {
        return snapshot();
      }
      delegatedToRun = true;
      return await run(activeRunId);
    } finally {
      if (!delegatedToRun && runId === activeRunId) runPromise = null;
    }
  }

  /**
   * @param {{sceneId?: string, actionIndex?: number, variables?: Readonly<Record<string, string | number | boolean>>}} [options]
   * @returns {Promise<Readonly<Record<string, unknown>>>}
   */
  function start({sceneId, actionIndex = 0, variables: startVariables} = {}) {
    if (controllerDisposed) return Promise.resolve(snapshot());
    const entrySceneId = sceneId ?? String(scenes[0]?.id ?? '');
    if (!entrySceneId || !resolvePosition(entrySceneId, actionIndex)) {
      throw new TypeError(`Invalid runtime start position: ${entrySceneId} action ${actionIndex}`);
    }
    const nextVariables = resolveStartVariables(startVariables);
    const previousStatus = status;
    finishPresentationTransitions('restart');
    abandonQuiesce('restart');
    if (status === 'running' || status === 'paused') stop('restart');
    else if (previousStatus === 'failed' || previousStatus === 'finished') releaseAssets('restart');
    variables = nextVariables;
    pendingVariableWrites = [];
    failureDiagnostic = null;
    currentSceneIndex = -1;
    currentActionIndex = -1;
    status = 'running';
    generation += 1;
    sequence = 0;
    trace.length = 0;
    emit('runtime.start');
    if (structuredDataIntegration) {
      try {
        beginStructuredStory();
      } catch (error) {
        fail(error);
        return Promise.resolve(snapshot());
      }
    }
    if (assetCoordinator) assetsReleased = false;
    runId += 1;
    if (assetCoordinator) {
      runPromise = runWithAssetStartup(entrySceneId, actionIndex, runId);
    } else {
      try {
        transitionTo(entrySceneId, 'start', actionIndex);
      } catch (error) {
        fail(error);
        return Promise.resolve(snapshot());
      }
      runPromise = run(runId);
    }
    return runPromise;
  }

  /**
   * @param {string} [reason]
   * @returns {Readonly<Record<string, unknown>>}
   */
  function stop(reason = 'stop') {
    abandonQuiesce(reason);
    finishPresentationTransitions(reason);
    if (status !== 'running' && status !== 'paused') {
      try {
        endStructuredStory(reason);
      } catch (error) {
        fail(error, false);
      }
      releaseAssets(reason);
      return snapshot();
    }
    const action = currentAction();
    const wasRunning = status === 'running';
    if (wasRunning) actionAbortController?.abort(reason);
    pendingVariableWrites = [];
    generation += 1;
    if (wasRunning && action) emit('action.cancel', {reason});
    try {
      endStructuredStory(reason);
    } catch (error) {
      fail(error, false);
      releaseAssets(reason);
      return snapshot();
    }
    status = 'stopped';
    emit('runtime.stop', {reason});
    releaseAssets(reason);
    return snapshot();
  }

  function hasActivePoseWait() {
    return (
      status === 'running' &&
      actionAbortController !== null &&
      activePoseWait?.generation === generation &&
      currentAction()?.command === 'pose'
    );
  }

  /** @param {string} reason */
  function isPoseNavigationAdvance(reason) {
    const poseWait = activePoseWait;
    return (
      hasActivePoseWait() &&
      (poseWait?.waitingForRecognition || poseSequenceRecognition.navigation.allowSkip) &&
      (reason === 'rehearsal.skipPose' ||
        (poseNavigationPolicyEnabled && reason === 'navigation.nextAction'))
    );
  }

  /** @param {string} command */
  function canRehearsalSkip(command) {
    if (status !== 'running') return false;
    if (poseAdvanceLock && poseAdvanceLock.generation !== generation) poseAdvanceLock = null;
    if (poseAdvanceLock || rehearsalSkipLock || rehearsalSceneSkip) return false;
    if (command === 'rehearsal.skipPose') {
      return hasActivePoseWait() && poseSequenceRecognition.navigation.allowSkip;
    }
    if (command === 'rehearsal.skipAction') {
      return actionAbortController !== null && currentAction() !== null;
    }
    if (command === 'rehearsal.skipScene') {
      return currentSceneIndex >= 0 && currentScene() !== null;
    }
    return false;
  }

  /** @param {string} [reason] */
  function canAdvance(reason = 'navigation.nextAction') {
    if (status !== 'running') return false;
    if (poseAdvanceLock && poseAdvanceLock.generation !== generation) poseAdvanceLock = null;
    if (poseAdvanceLock) return false;
    if (!isPoseNavigationAdvance(reason)) return true;
    return poseSequenceRecognition.navigation.allowSkip;
  }

  /**
   * Continue at the next normal execution boundary after the active action is cancelled.
   *
   * @param {string} reason
   * @param {string} fromStoryPath
   * @param {number} activeRunId
   */
  function continueAfterAdvanceCancellation(reason, fromStoryPath, activeRunId) {
    const scene = currentScene();
    const actions = /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (
      scene?.actions ?? []
    );
    try {
      releaseStructuredAction(reason);
    } catch (error) {
      fail(error);
      return Promise.resolve(snapshot());
    }
    actionAbortController = null;

    const nextActionIndex = currentActionIndex + 1;
    if (nextActionIndex < actions.length) {
      emit('navigation.advance', {
        fromStoryPath,
        toStoryPath: storyPathAt(currentSceneIndex, nextActionIndex),
        reason,
      });
      runPromise = run(activeRunId);
      return runPromise;
    }
    if (currentSceneIndex + 1 < scenes.length) {
      const nextSceneId = String(scenes[currentSceneIndex + 1].id);
      emit('navigation.advance', {
        fromStoryPath,
        toStoryPath: storyPathAt(currentSceneIndex + 1, 0),
        reason,
      });
      if (!assetCoordinator) {
        try {
          transitionTo(nextSceneId, reason);
        } catch (error) {
          fail(error);
          return Promise.resolve(snapshot());
        }
        runPromise = run(activeRunId);
        return runPromise;
      }
      runPromise = (async () => {
        if (!(await enterScene(nextSceneId, reason, activeRunId))) return snapshot();
        return run(activeRunId);
      })();
      return runPromise;
    }

    currentActionIndex = actions.length;
    try {
      endStructuredStory('runtime-finished');
    } catch (error) {
      fail(error, false);
      return Promise.resolve(snapshot());
    }
    status = 'finished';
    emit('navigation.advance', {fromStoryPath, toStoryPath: null, reason});
    emit('runtime.finish');
    return Promise.resolve(snapshot());
  }

  /**
   * Skip the active pose step or cancel the current action at the next execution boundary.
   *
   * @param {string} [reason]
   * @returns {Promise<Readonly<Record<string, unknown>>>}
   */
  function advance(reason = 'navigation.nextAction') {
    if (status !== 'running') return Promise.resolve(snapshot());
    if (poseAdvanceLock && poseAdvanceLock.generation !== generation) poseAdvanceLock = null;
    if (poseAdvanceLock) return poseAdvanceLock.operation;
    if (!canAdvance(reason)) return Promise.resolve(snapshot());
    if (isPoseNavigationAdvance(reason)) {
      const poseWait = activePoseWait;
      if (!poseWait) return Promise.resolve(snapshot());
      /** @type {{generation: number, stepIndex: number, operation: Promise<Readonly<Record<string, unknown>>>}} */
      const lock = {
        generation,
        stepIndex: poseWait.stepIndex,
        operation: Promise.resolve(snapshot()),
      };
      poseWait.skipRequested = true;
      poseWait.skipReason = reason;
      poseWait.controller.abort(reason);
      const operation = poseWait.completion.promise.then(() => snapshot());
      lock.operation = operation;
      poseAdvanceLock = lock;
      void operation
        .finally(() => {
          if (poseAdvanceLock === lock) poseAdvanceLock = null;
        })
        .catch(() => {});
      return operation;
    }
    const fromStoryPath = storyPathAt(currentSceneIndex, currentActionIndex);
    finishPresentationTransitions(reason);
    const action = currentAction();
    actionAbortController?.abort(reason);
    pendingVariableWrites = [];
    generation += 1;
    if (action) emit('action.cancel', {reason});
    runId += 1;
    runPromise = null;
    return continueAfterAdvanceCancellation(reason, fromStoryPath, runId);
  }

  function skipPose() {
    if (!canRehearsalSkip('rehearsal.skipPose')) return Promise.resolve(snapshot());
    return advance('rehearsal.skipPose');
  }

  /**
   * Complete the active action at its cancellation endpoint and resume at the next action boundary.
   *
   * @returns {Promise<Readonly<Record<string, unknown>>>}
   */
  function skipAction() {
    if (!canRehearsalSkip('rehearsal.skipAction')) return Promise.resolve(snapshot());
    const fromStoryPath = storyPathAt(currentSceneIndex, currentActionIndex);
    const staleRun = runPromise;
    const completion = deferred();
    const lock = {
      command: /** @type {const} */ ('rehearsal.skipAction'),
      sceneIndex: currentSceneIndex,
      actionIndex: currentActionIndex,
      completion,
      operation: Promise.resolve(snapshot()),
    };
    finishPresentationTransitions(lock.command);
    rehearsalSkipLock = lock;
    const action = currentAction();
    actionAbortController?.abort(lock.command);
    pendingVariableWrites = [];
    generation += 1;
    if (action) emit('action.cancel', {reason: lock.command});
    runId += 1;
    const activeRunId = runId;
    runPromise = null;
    const operation = (async () => {
      if (staleRun) await staleRun;
      if (status === 'running' && runId === activeRunId) {
        void continueAfterAdvanceCancellation(lock.command, fromStoryPath, activeRunId);
      } else {
        settleRehearsalSkip(lock);
      }
      await completion.promise;
      return snapshot();
    })();
    lock.operation = operation;
    void operation.catch(() => {});
    return operation;
  }

  /**
   * Fast-forward the current scene with the exact stateful tail allowed by the 3.2 runtime.
   *
   * @returns {Promise<Readonly<Record<string, unknown>>>}
   */
  function skipScene() {
    if (!canRehearsalSkip('rehearsal.skipScene')) return Promise.resolve(snapshot());
    const staleRun = runPromise;
    const completion = deferred();
    const lock = {
      command: /** @type {const} */ ('rehearsal.skipScene'),
      sceneIndex: currentSceneIndex,
      actionIndex: currentActionIndex,
      completion,
      operation: Promise.resolve(snapshot()),
    };
    finishPresentationTransitions(lock.command);
    rehearsalSkipLock = lock;
    rehearsalSceneSkip = {sceneIndex: currentSceneIndex, reason: lock.command};
    const action = currentAction();
    actionAbortController?.abort(lock.command);
    pendingVariableWrites = [];
    generation += 1;
    if (action) emit('action.cancel', {reason: lock.command});
    runId += 1;
    const activeRunId = runId;
    runPromise = null;
    const operation = (async () => {
      if (staleRun) await staleRun;
      if (status === 'running' && runId === activeRunId) {
        try {
          releaseStructuredAction(lock.command);
        } catch (error) {
          fail(error);
        }
        actionAbortController = null;
        if (status === 'running') runPromise = run(activeRunId);
      } else {
        rehearsalSceneSkip = null;
        settleRehearsalSkip(lock);
      }
      await completion.promise;
      return snapshot();
    })();
    lock.operation = operation;
    void operation.catch(() => {});
    return operation;
  }

  /**
   * Skip the remainder of the active scene and continue at the next scene boundary.
   *
   * @param {string} [reason]
   * @returns {Promise<Readonly<Record<string, unknown>>>}
   */
  function advanceScene(reason = 'navigation.nextScene') {
    if (status !== 'running') return Promise.resolve(snapshot());
    const nextScene = scenes[currentSceneIndex + 1];
    if (nextScene) return navigate(String(nextScene.id), {reason});

    const fromStoryPath = storyPathAt(currentSceneIndex, currentActionIndex);
    const action = currentAction();
    finishPresentationTransitions(reason);
    actionAbortController?.abort(reason);
    pendingVariableWrites = [];
    generation += 1;
    if (action) emit('action.cancel', {reason});
    runId += 1;
    runPromise = null;
    try {
      releaseStructuredAction(reason);
      endStructuredStory('runtime-finished');
    } catch (error) {
      fail(error);
      return Promise.resolve(snapshot());
    }
    currentActionIndex = /** @type {ReadonlyArray<unknown>} */ (currentScene()?.actions ?? [])
      .length;
    actionAbortController = null;
    status = 'finished';
    emit('navigation.advanceScene', {fromStoryPath, toStoryPath: null, reason});
    emit('runtime.finish');
    return Promise.resolve(snapshot());
  }

  /**
   * Move to an action start without executing it or restoring non-position state.
   *
   * @param {string} sceneId
   * @param {{actionIndex?: number, reason?: string}} [options]
   * @returns {Readonly<Record<string, unknown>>}
   */
  function reposition(sceneId, {actionIndex = 0, reason = 'navigation.reposition'} = {}) {
    if (status !== 'running' && status !== 'paused' && status !== 'finished') return snapshot();
    const target = resolvePosition(sceneId, actionIndex);
    if (!target) {
      fail(
        Object.assign(new Error(`Invalid navigation target: ${sceneId} action ${actionIndex}`), {
          code: 'K4-RUNTIME-NAVIGATION-001',
        }),
      );
      return snapshot();
    }

    const fromStoryPath = storyPathAt(currentSceneIndex, currentActionIndex);
    const wasRunning = status === 'running';
    const action = currentAction();
    finishPresentationTransitions(reason);
    if (wasRunning) actionAbortController?.abort(reason);
    pendingVariableWrites = [];
    generation += 1;
    if (wasRunning && action) emit('action.cancel', {reason});
    try {
      beginStructuredStory();
      releaseStructuredAction(reason);
      applyPosePreviewMirroring(scenes[target.sceneIndex]);
      bindStructuredScene(sceneId, actionIndex);
    } catch (error) {
      fail(error);
      return snapshot();
    }
    actionAbortController = null;
    runId += 1;
    runPromise = null;
    assetCoordinator?.beginScene(sceneId, generation);
    currentSceneIndex = target.sceneIndex;
    currentActionIndex = actionIndex;
    status = 'paused';
    emit('navigation.reposition', {
      fromStoryPath,
      toStoryPath: storyPathAt(currentSceneIndex, currentActionIndex),
      reason,
    });
    return snapshot();
  }

  /**
   * Resume normal execution from the action selected by reposition.
   *
   * @param {string} [reason]
   * @returns {Promise<Readonly<Record<string, unknown>>>}
   */
  function resume(reason = 'navigation.resume') {
    if (status !== 'paused') return Promise.resolve(snapshot());
    const targetActionIndex = currentActionIndex;
    generation += 1;
    emit('runtime.resume', {
      storyPath: storyPathAt(currentSceneIndex, targetActionIndex),
      reason,
    });
    status = 'running';
    currentActionIndex = targetActionIndex - 1;
    runId += 1;
    runPromise = run(runId);
    return runPromise;
  }

  /**
   * Move execution to a scene/action boundary without restoring non-position variables.
   *
   * @param {string} sceneId
   * @param {{actionIndex?: number, reason?: string}} [options]
   * @returns {Promise<Readonly<Record<string, unknown>>>}
   */
  function navigate(sceneId, {actionIndex = 0, reason = 'navigation'} = {}) {
    if (status !== 'running') return Promise.resolve(snapshot());
    const target = resolvePosition(sceneId, actionIndex);
    if (!target) {
      fail(
        Object.assign(new Error(`Invalid navigation target: ${sceneId} action ${actionIndex}`), {
          code: 'K4-RUNTIME-NAVIGATION-001',
        }),
      );
      return Promise.resolve(snapshot());
    }

    const action = currentAction();
    finishPresentationTransitions(reason);
    actionAbortController?.abort(reason);
    pendingVariableWrites = [];
    generation += 1;
    if (action) emit('action.cancel', {reason});
    try {
      releaseStructuredAction(reason);
    } catch (error) {
      fail(error);
      return Promise.resolve(snapshot());
    }
    runId += 1;
    const activeRunId = runId;
    runPromise = (async () => {
      if (!(await enterScene(sceneId, reason, activeRunId, actionIndex))) return snapshot();
      return run(activeRunId);
    })();
    return runPromise;
  }

  /** @param {Record<string, any>} request @param {Promise<Readonly<Record<string, unknown>>>} activeRun */
  function awaitCancelledActionCleanup(request, activeRun) {
    const timeout = deferred();
    try {
      const cancelTimeout = scheduleQuiesceTimeout(
        () => timeout.resolve('timeout'),
        quiesceTimeoutMs,
      );
      if (typeof cancelTimeout !== 'function') {
        throw new TypeError('scheduleQuiesceTimeout must return a cancel function');
      }
      request.cancelTimeout = cancelTimeout;
    } catch {
      fail(
        quiesceError(
          'K4-RELOAD-QUIESCE-FAILED',
          'Live reload quiesce timeout could not be scheduled',
        ),
      );
      return;
    }

    void Promise.race([Promise.resolve(activeRun).then(() => 'settled'), timeout.promise]).then(
      (outcome) => {
        if (quiesceRequest !== request || request.phase !== 'quiescing') return;
        if (outcome === 'timeout') {
          fail(
            quiesceError(
              'K4-RELOAD-QUIESCE-TIMEOUT',
              'Live reload action cleanup exceeded the quiesce timeout',
            ),
          );
          return;
        }
        if (request.resumeRequested) {
          const error = new Error('Live reload quiesce was cancelled');
          error.name = 'AbortError';
          rejectQuiesce(error);
          if (status === 'paused') void resume('live-reload-esc');
          return;
        }
        if (status !== 'paused') {
          rejectQuiesce(
            quiesceError(
              'K4-RELOAD-QUIESCE-FAILED',
              'Runtime did not reach a safe replay boundary',
            ),
          );
          return;
        }
        completeQuiesce(currentSceneIndex, currentActionIndex, 'replay-action', false);
      },
    );
  }

  /**
   * Close the next-action dispatch gate and publish one immutable cleanup-complete boundary.
   *
   * @param {{candidateId: number, mode: 'finish-only' | 'cancel-replay-safe'}} options
   */
  function quiesce({candidateId, mode}) {
    if (!Number.isSafeInteger(candidateId) || candidateId < 1) {
      return Promise.reject(new TypeError('quiesce candidateId must be a positive safe integer'));
    }
    if (mode !== 'finish-only' && mode !== 'cancel-replay-safe') {
      return Promise.reject(new TypeError('quiesce mode is invalid'));
    }
    if (controllerDisposed) {
      return Promise.reject(new TypeError('DSL 4.0 runtime controller is disposed'));
    }
    if (quiesceRequest) {
      quiesceRequest.candidateId = candidateId;
      if (quiesceRequest.phase === 'token') {
        quiesceRequest.token = retagQuiesceToken(quiesceRequest.token, candidateId);
        return Promise.resolve(quiesceRequest.token);
      }
      return quiesceRequest.completion.promise;
    }
    if (status === 'failed' || status === 'stopped' || status === 'idle') {
      return Promise.reject(
        quiesceError('K4-RELOAD-QUIESCE-FAILED', 'Runtime is not resumable for live reload'),
      );
    }

    const completion = deferred();
    const request = {
      candidateId,
      mode,
      phase: 'quiescing',
      token: null,
      completion,
      resumeRequested: false,
      cancelTimeout: () => {},
    };
    quiesceRequest = request;

    if (status === 'finished') {
      completeQuiesce(currentSceneIndex, currentActionIndex, 'finished', false);
      return completion.promise;
    }
    if (status === 'paused') {
      completeQuiesce(currentSceneIndex, currentActionIndex, 'next-action', false);
      return completion.promise;
    }

    const activeRun = runPromise;
    if (!activeRun) {
      rejectQuiesce(
        quiesceError('K4-RELOAD-QUIESCE-FAILED', 'Runtime has no active execution to quiesce'),
      );
      return completion.promise;
    }
    const hasActiveAction = actionAbortController !== null && currentAction() !== null;
    const debugPaused = debugExecution?.getState().paused === true;
    if (hasActiveAction && (mode === 'cancel-replay-safe' || debugPaused)) {
      const sceneId = String(currentScene()?.id ?? '');
      const actionIndex = currentActionIndex;
      reposition(sceneId, {actionIndex, reason: 'live-reload-quiesce'});
      if (quiesceRequest === request && request.phase === 'quiescing') {
        awaitCancelledActionCleanup(request, activeRun);
      }
      return completion.promise;
    }

    void Promise.resolve(activeRun).then(() => {
      if (quiesceRequest !== request || request.phase !== 'quiescing') return;
      if (status === 'finished') {
        completeQuiesce(currentSceneIndex, currentActionIndex, 'finished', false);
        return;
      }
      if (status !== 'paused') {
        rejectQuiesce(
          quiesceError(
            'K4-RELOAD-QUIESCE-FAILED',
            'Runtime did not reach a safe dispatch boundary',
          ),
        );
      }
    });
    return completion.promise;
  }

  /** @param {number} candidateId */
  async function resumeQuiesce(candidateId) {
    const request = quiesceRequest;
    if (!request || request.candidateId !== candidateId) {
      throw new TypeError('live reload quiesce candidate is stale or missing');
    }
    if (request.phase === 'quiescing') {
      request.resumeRequested = true;
      if (request.mode === 'finish-only') {
        const error = new Error('Live reload quiesce was cancelled');
        error.name = 'AbortError';
        rejectQuiesce(error);
        return snapshot();
      }
      try {
        await request.completion.promise;
      } catch {
        return snapshot();
      }
      return snapshot();
    }
    if (request.phase !== 'token') {
      throw new TypeError('live reload quiesce candidate is not resumable');
    }
    quiesceRequest = null;
    if (status === 'paused') void resume('live-reload-esc');
    return snapshot();
  }

  return Object.freeze({
    start,
    stop,
    invokeAction,
    queueVariableWrite,
    rejectActionInvocation,
    canAdvance,
    canRehearsalSkip,
    acceptAdvanceInput,
    consumeAdvanceInput,
    advance,
    skipPose,
    skipAction,
    skipScene,
    advanceScene,
    navigate,
    reposition,
    resume,
    quiesce,
    resumeQuiesce,
    getState: snapshot,
    getTrace() {
      return deepFreeze(trace.map((event) => cloneValue(event)));
    },
    getRunPromise() {
      return runPromise;
    },
    dispose() {
      if (controllerDisposed) return;
      stop('dispose');
      structuredDataIntegration?.dispose();
      structuredScene = null;
      structuredAction = null;
      structuredActionResources = null;
      structuredStoryActive = false;
      structuredActionActive = false;
      controllerDisposed = true;
    },
  });
}
