import {createDsl4AssetPreloadCoordinator} from './asset-preload-coordinator.js';
import {deepFreeze} from './story-document.js';

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
 * @property {number} generation
 * @property {string} sceneId
 * @property {string} actionPath
 * @property {Readonly<Record<string, string | number | boolean>>} variables
 * @property {Readonly<{actionScopeRef: string, actionViewRef: string}>} [structuredData]
 * @property {(name: string) => string | number | boolean | undefined} getVariable
 * @property {(name: string, value: string | number | boolean) => boolean} setVariable
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
function storyPathSegment(value) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {string | null} storyPath
 * @param {string} code
 * @param {string} message
 * @returns {Readonly<Record<string, unknown>>}
 */
function runtimeDiagnostic(storyDocument, storyPath, code, message) {
  const sourceMap = /** @type {Record<string, unknown>} */ (storyDocument.sourceMap ?? {});
  const metadata = /** @type {Record<string, unknown>} */ (storyDocument.metadata ?? {});
  return deepFreeze({
    version: 1,
    code,
    severity: 'error',
    message,
    sourceId: typeof metadata.sourceId === 'string' ? metadata.sourceId : 'main',
    range: storyPath ? (sourceMap[storyPath] ?? sourceMap['/']) : sourceMap['/'],
    ...(storyPath ? {storyPath} : {}),
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
 */
export function createDsl4RuntimeController({
  storyDocument,
  port,
  assetLifecycle,
  evaluateCondition,
  onEvent,
  structuredDataIntegration,
}) {
  if (storyDocument.kind !== 'StoryDocument' || storyDocument.version !== '4.0') {
    throw new TypeError('DSL 4.0 runtime requires a StoryDocument version 4.0');
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

  const scenes = /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (
    storyDocument.scenes
  );
  const sceneIndex = new Map(scenes.map((scene, index) => [scene.id, index]));
  const branches = /** @type {Record<string, ReadonlyArray<Readonly<Record<string, string>>>>} */ (
    storyDocument.branches ?? {}
  );
  const initialVariables = /** @type {Record<string, string | number | boolean>} */ (
    storyDocument.variables ?? {}
  );
  const poseRecognition = /** @type {Readonly<Record<string, unknown>>} */ (
    storyDocument.poseRecognition ?? {}
  );
  const poseSequenceRecognition = deepFreeze({
    ...defaultPoseSequenceRecognition,
    .../** @type {Readonly<Record<string, number>>} */ (poseRecognition.sequence ?? {}),
    idleSound: typeof poseRecognition.idleSound === 'string' ? poseRecognition.idleSound : null,
    chargeSound:
      typeof poseRecognition.chargeSound === 'string' ? poseRecognition.chargeSound : null,
  });
  const poseSelectionRecognition = deepFreeze({
    ...defaultPoseSelectionRecognition,
    .../** @type {Readonly<Record<string, number>>} */ (poseRecognition.selection ?? {}),
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
  /** @type {Promise<Readonly<Record<string, unknown>>> | null} */
  let runPromise = null;
  /** @type {Readonly<Record<string, unknown>> | null} */
  let failureDiagnostic = null;
  /** @type {RuntimeEvent[]} */
  const trace = [];
  const assetCoordinator = assetLifecycle
    ? createDsl4AssetPreloadCoordinator({
        storyDocument,
        lifecycle: assetLifecycle,
        onEvent: (type, details) => emit(type, details),
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

  /** @param {string} reason */
  function releaseStructuredAction(reason) {
    if (!structuredDataIntegration || !structuredActionActive) return;
    try {
      structuredDataIntegration.releaseAction(reason);
    } finally {
      structuredActionActive = false;
      structuredAction = null;
      structuredActionResources = null;
    }
  }

  /** @param {string} reason */
  function endStructuredStory(reason) {
    if (!structuredDataIntegration || !structuredStoryActive) return;
    try {
      structuredDataIntegration.endStory(reason);
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
      : `/scenes/${storyPathSegment(String(scene.id))}`;
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
    const scenePath = typeof scene?.id === 'string' ? `/scenes/${storyPathSegment(scene.id)}` : '/';
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
    };
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
    const from = currentScene()?.id ?? null;
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
    for (const rule of rules) {
      if (rule.else) return rule.else;
      if (typeof evaluateCondition !== 'function') {
        const error = new Error('Runtime condition evaluator is not available');
        Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-PORT-001'});
        throw error;
      }
      const matches = await evaluateCondition(rule.if, context.variables, context);
      ensureActive(context);
      if (matches) return rule.goto;
    }
    const error = new Error(`Branch ${branchId} has no matching destination`);
    Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-BRANCH-002'});
    throw error;
  }

  /**
   * @param {Readonly<Record<string, unknown>>} action
   * @param {ActionContext} context
   * @returns {Promise<{sceneId: string, reason: string} | null>}
   */
  async function dispatch(action, context) {
    const command = String(action.command);
    const target = action.target === null ? null : String(action.target);
    const args = /** @type {Record<string, unknown>} */ (action.args);
    if (action.handler === 'custom') {
      const outcome = await invokePort(
        'customAction',
        {name: command, target, arguments: cloneValue(args)},
        context,
      );
      if (outcome === undefined || outcome === null) return null;
      if (isRecord(outcome) && outcome.outcome === 'completed' && Object.keys(outcome).length === 1)
        return null;
      if (
        isRecord(outcome) &&
        outcome.outcome === 'transitioned' &&
        typeof outcome.sceneId === 'string' &&
        Object.keys(outcome).length === 2
      ) {
        return {sceneId: outcome.sceneId, reason: 'customAction'};
      }
      const error = new Error('Invalid custom action runtime result');
      Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-RESULT-001'});
      throw error;
    }
    if (command === 'goto') return {sceneId: String(args.scene), reason: 'goto'};
    if (command === 'branch') {
      return {sceneId: await resolveBranch(String(args.branch), context), reason: 'branch'};
    }
    if (command === 'keyInputToChangeScene') {
      const routes = /** @type {Record<string, string>} */ (args.routes);
      const selected = await invokePort(command, {codes: Object.keys(routes)}, context);
      if (typeof selected !== 'string' || !Object.hasOwn(routes, selected)) {
        const error = new Error(`Invalid key input result: ${String(selected)}`);
        Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-RESULT-001'});
        throw error;
      }
      return {sceneId: routes[selected], reason: 'keyInput'};
    }
    if (command === 'touchInputToChangeScene') {
      const routes = /** @type {Record<string, string>} */ (args.routes);
      const selected = await invokePort(command, {actors: Object.keys(routes)}, context);
      if (typeof selected !== 'string' || !Object.hasOwn(routes, selected)) {
        const error = new Error(`Invalid touch input result: ${String(selected)}`);
        Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-RESULT-001'});
        throw error;
      }
      return {sceneId: routes[selected], reason: 'touchInput'};
    }
    if (command === 'poseInputToChangeScene') {
      const routes = /** @type {Record<string, string>} */ (args.routes);
      const poseModel = String(currentScene()?.poseModel ?? '');
      const selected = await invokePort(
        command,
        {
          poses: Object.keys(routes),
          poseModel,
          recognition: cloneValue(poseSelectionRecognition),
        },
        context,
      );
      if (typeof selected !== 'string' || !Object.hasOwn(routes, selected)) {
        const error = new Error(`Invalid pose input result: ${String(selected)}`);
        Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-RESULT-001'});
        throw error;
      }
      return {sceneId: routes[selected], reason: 'poseInput'};
    }
    if (command === 'pose') {
      const steps = /** @type {ReadonlyArray<Readonly<Record<string, string>>>} */ (args.steps);
      const poseModel = String(currentScene()?.poseModel ?? '');
      for (const step of steps) {
        if (typeof step.skin === 'string') {
          await invokePort('setSkin', {target, skin: step.skin}, context);
          ensureActive(context);
        }
        await invokePort(
          'waitForPose',
          {
            target,
            pose: step.pose,
            poseModel,
            recognition: cloneValue(poseSequenceRecognition),
          },
          context,
        );
        ensureActive(context);
        if (typeof step.sound === 'string') {
          await invokePort('sound', {sound: step.sound}, context);
          ensureActive(context);
        }
      }
      return null;
    }
    await invokePort(command, target === null ? {...args} : {target, ...args}, context);
    return null;
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
    if (cleanupStructuredData && structuredDataIntegration) {
      try {
        endStructuredStory('runtime-failed');
      } catch (cleanupError) {
        terminalError = cleanupError;
      }
    }
    status = 'failed';
    actionAbortController?.abort('runtime-failed');
    const actionPath = typeof currentAction()?.id === 'string' ? String(currentAction().id) : null;
    const errorRecord =
      typeof terminalError === 'object' && terminalError !== null
        ? /** @type {Record<string, unknown>} */ (terminalError)
        : {};
    const code = typeof errorRecord.code === 'string' ? errorRecord.code : 'K4-RUNTIME-ACTION-001';
    const errorStoryPath =
      typeof errorRecord.storyPath === 'string' ? errorRecord.storyPath : actionPath;
    failureDiagnostic = runtimeDiagnostic(
      storyDocument,
      errorStoryPath,
      code,
      safeErrorMessage(terminalError),
    );
    emit('runtime.fail', {code});
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
            break;
          }
          if (
            !(await enterScene(String(scenes[currentSceneIndex + 1].id), 'sequential', activeRunId))
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
        generation += 1;
        const actionGeneration = generation;
        actionAbortController = new AbortController();
        const context = actionContext(actionGeneration, actionAbortController.signal);
        emit('action.start');
        let transition = null;
        try {
          transition = await dispatch(currentAction(), context);
        } catch (error) {
          if (!isCurrent(actionGeneration) || actionAbortController.signal.aborted) break;
          fail(error);
          break;
        }
        if (!isCurrent(actionGeneration) || actionAbortController.signal.aborted) break;
        try {
          releaseStructuredAction('action-complete');
        } catch (error) {
          fail(error);
          break;
        }
        emit('action.commit');
        actionAbortController = null;
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
    if (status === 'running' || status === 'paused') stop('restart');
    else if (previousStatus === 'failed' || previousStatus === 'finished') releaseAssets('restart');
    variables = nextVariables;
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

  /**
   * Cancel the current action and continue at the next normal execution boundary.
   *
   * @param {string} [reason]
   * @returns {Promise<Readonly<Record<string, unknown>>>}
   */
  function advance(reason = 'navigation.nextAction') {
    if (status !== 'running') return Promise.resolve(snapshot());
    const scene = currentScene();
    const actions = /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (
      scene?.actions ?? []
    );
    const fromStoryPath = storyPathAt(currentSceneIndex, currentActionIndex);
    const action = currentAction();
    actionAbortController?.abort(reason);
    generation += 1;
    if (action) emit('action.cancel', {reason});
    try {
      releaseStructuredAction(reason);
    } catch (error) {
      fail(error);
      return Promise.resolve(snapshot());
    }
    actionAbortController = null;
    runId += 1;
    runPromise = null;

    const nextActionIndex = currentActionIndex + 1;
    if (nextActionIndex < actions.length) {
      emit('navigation.advance', {
        fromStoryPath,
        toStoryPath: storyPathAt(currentSceneIndex, nextActionIndex),
        reason,
      });
      runPromise = run(runId);
      return runPromise;
    }
    if (currentSceneIndex + 1 < scenes.length) {
      const nextSceneId = String(scenes[currentSceneIndex + 1].id);
      emit('navigation.advance', {
        fromStoryPath,
        toStoryPath: storyPathAt(currentSceneIndex + 1, 0),
        reason,
      });
      const activeRunId = runId;
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
    if (wasRunning) actionAbortController?.abort(reason);
    generation += 1;
    if (wasRunning && action) emit('action.cancel', {reason});
    try {
      beginStructuredStory();
      releaseStructuredAction(reason);
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
    actionAbortController?.abort(reason);
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
    if (!assetCoordinator) {
      try {
        transitionTo(sceneId, reason, actionIndex);
      } catch (error) {
        fail(error);
        return Promise.resolve(snapshot());
      }
      runPromise = run(activeRunId);
      return runPromise;
    }
    runPromise = (async () => {
      if (!(await enterScene(sceneId, reason, activeRunId, actionIndex))) return snapshot();
      return run(activeRunId);
    })();
    return runPromise;
  }

  return Object.freeze({
    start,
    stop,
    advance,
    navigate,
    reposition,
    resume,
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
