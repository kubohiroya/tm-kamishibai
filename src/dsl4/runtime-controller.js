import {deepFreeze} from './story-document.js';

const terminalStatuses = new Set(['failed', 'finished', 'stopped']);

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
 * @param {string | null} actionPath
 * @param {string} code
 * @param {string} message
 * @returns {Readonly<Record<string, unknown>>}
 */
function runtimeDiagnostic(storyDocument, actionPath, code, message) {
  const sourceMap = /** @type {Record<string, unknown>} */ (storyDocument.sourceMap ?? {});
  const metadata = /** @type {Record<string, unknown>} */ (storyDocument.metadata ?? {});
  return deepFreeze({
    version: 1,
    code,
    severity: 'error',
    message,
    sourceId: typeof metadata.sourceId === 'string' ? metadata.sourceId : 'main',
    range: actionPath ? (sourceMap[actionPath] ?? sourceMap['/']) : sourceMap['/'],
    ...(actionPath ? {storyPath: actionPath} : {}),
    related: [],
  });
}

/**
 * @param {object} options
 * @param {Readonly<Record<string, unknown>>} options.storyDocument
 * @param {Record<string, Function>} options.port
 * @param {(expression: string, variables: Readonly<Record<string, string | number | boolean>>, context: ActionContext) => boolean | Promise<boolean>} [options.evaluateCondition]
 * @param {(event: RuntimeEvent) => void} [options.onEvent]
 */
export function createDsl4RuntimeController({storyDocument, port, evaluateCondition, onEvent}) {
  if (storyDocument.kind !== 'StoryDocument' || storyDocument.version !== '4.0') {
    throw new TypeError('DSL 4.0 runtime requires a StoryDocument version 4.0');
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

  function currentScene() {
    return scenes[currentSceneIndex];
  }

  function currentAction() {
    const actions = /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (
      currentScene()?.actions ?? []
    );
    return actions[currentActionIndex];
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
   */
  function transitionTo(sceneId, reason) {
    const nextIndex = sceneIndex.get(sceneId);
    if (nextIndex === undefined) {
      const error = new Error(`Unknown scene: ${sceneId}`);
      Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-SCENE-001'});
      throw error;
    }
    const from = currentScene()?.id ?? null;
    currentSceneIndex = nextIndex;
    currentActionIndex = -1;
    emit('scene.transition', {from, to: sceneId, reason});
    emit('scene.enter', {reason});
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
    if (command === 'pose') {
      const choices = /** @type {ReadonlyArray<Readonly<Record<string, string>>>} */ (args.choices);
      const selected = await invokePort(command, {target, choices: cloneValue(choices)}, context);
      ensureActive(context);
      const choice = choices.find(({pose}) => pose === selected);
      if (!choice) {
        const error = new Error(`Invalid pose result: ${String(selected)}`);
        Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-RESULT-001'});
        throw error;
      }
      await invokePort('setSkin', {target, skin: choice.skin}, context);
      ensureActive(context);
      await invokePort('sound', {sound: choice.sound}, context);
      return null;
    }
    await invokePort(command, target === null ? {...args} : {target, ...args}, context);
    return null;
  }

  /**
   * @param {unknown} error
   */
  function fail(error) {
    if (terminalStatuses.has(status)) return;
    status = 'failed';
    actionAbortController?.abort('runtime-failed');
    const actionPath = typeof currentAction()?.id === 'string' ? String(currentAction().id) : null;
    const errorRecord =
      typeof error === 'object' && error !== null
        ? /** @type {Record<string, unknown>} */ (error)
        : {};
    const code = typeof errorRecord.code === 'string' ? errorRecord.code : 'K4-RUNTIME-ACTION-001';
    failureDiagnostic = runtimeDiagnostic(storyDocument, actionPath, code, safeErrorMessage(error));
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
        const actions = /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (
          scene.actions
        );
        if (currentActionIndex + 1 >= actions.length) {
          if (currentSceneIndex + 1 >= scenes.length) {
            status = 'finished';
            currentActionIndex = actions.length;
            emit('runtime.finish');
            break;
          }
          transitionTo(String(scenes[currentSceneIndex + 1].id), 'sequential');
          continue;
        }

        currentActionIndex += 1;
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
        emit('action.commit');
        actionAbortController = null;
        if (transition) transitionTo(transition.sceneId, transition.reason);
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
   * @param {{sceneId?: string}} [options]
   * @returns {Promise<Readonly<Record<string, unknown>>>}
   */
  function start({sceneId} = {}) {
    if (status === 'running' || status === 'paused') stop('restart');
    variables = /** @type {Record<string, string | number | boolean>} */ (
      cloneValue(initialVariables)
    );
    failureDiagnostic = null;
    currentSceneIndex = -1;
    currentActionIndex = -1;
    status = 'running';
    generation += 1;
    sequence = 0;
    trace.length = 0;
    emit('runtime.start');
    const entrySceneId = sceneId ?? String(scenes[0]?.id ?? '');
    if (!entrySceneId || !sceneIndex.has(entrySceneId)) {
      fail(
        Object.assign(new Error(`Unknown entry scene: ${entrySceneId}`), {
          code: 'K4-RUNTIME-SCENE-001',
        }),
      );
      return Promise.resolve(snapshot());
    }
    transitionTo(entrySceneId, 'start');
    runId += 1;
    runPromise = run(runId);
    return runPromise;
  }

  /**
   * @param {string} [reason]
   * @returns {Readonly<Record<string, unknown>>}
   */
  function stop(reason = 'stop') {
    if (status !== 'running' && status !== 'paused') return snapshot();
    const action = currentAction();
    const wasRunning = status === 'running';
    if (wasRunning) actionAbortController?.abort(reason);
    generation += 1;
    if (wasRunning && action) emit('action.cancel', {reason});
    status = 'stopped';
    emit('runtime.stop', {reason});
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
      transitionTo(nextSceneId, reason);
      runPromise = run(runId);
      return runPromise;
    }

    status = 'finished';
    currentActionIndex = actions.length;
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
    if (status !== 'running' && status !== 'paused') return snapshot();
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
    actionAbortController = null;
    runId += 1;
    runPromise = null;
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
    transitionTo(sceneId, reason);
    currentActionIndex = actionIndex - 1;
    runId += 1;
    runPromise = run(runId);
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
  });
}
