import {dsl4CoreActionManifest} from './core-action-manifest.js';

const coreActionNames = new Set(dsl4CoreActionManifest.map(({command}) => command));

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {unknown} */
function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
}

/** @param {string} message */
function invalidResult(message) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-RESULT-001'});
  return error;
}

/** @param {unknown} value @param {string} name */
function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

/**
 * Create the command dispatcher shared by YAML execution and the TurboWarp
 * action surface. Callers must pass an already normalized StoryDocument action;
 * source- and block-specific validation stays outside this semantic boundary.
 *
 * @param {object} options
 * @param {(method: string, payload: Record<string, unknown>, context: any) => unknown | Promise<unknown>} options.invokePort
 * @param {(branchId: string, context: any) => string | Promise<string>} options.resolveBranch
 * @param {(command: 'say' | 'think', args: Record<string, unknown>) => Record<string, unknown>} options.resolveSpeechStyle
 * @param {() => string} options.getPoseModel
 * @param {Readonly<Record<string, unknown>>} options.poseSelectionRecognition
 * @param {(payload: Readonly<{target: string | null, args: Record<string, unknown>}>, context: any) => unknown | Promise<unknown>} options.dispatchPose
 */
export function createDsl4RuntimeActionDispatcher(options) {
  if (!isRecord(options))
    throw new TypeError('Runtime action dispatcher options must be an object');
  const invokePort = requireFunction(options.invokePort, 'invokePort');
  const resolveBranch = requireFunction(options.resolveBranch, 'resolveBranch');
  const resolveSpeechStyle = requireFunction(options.resolveSpeechStyle, 'resolveSpeechStyle');
  const getPoseModel = requireFunction(options.getPoseModel, 'getPoseModel');
  const dispatchPose = requireFunction(options.dispatchPose, 'dispatchPose');
  if (!isRecord(options.poseSelectionRecognition)) {
    throw new TypeError('poseSelectionRecognition must be an object');
  }
  const poseSelectionRecognition = cloneValue(options.poseSelectionRecognition);

  /**
   * @param {Readonly<Record<string, unknown>>} action
   * @param {any} context
   * @param {{rehearsalSceneSkip?: boolean}} [dispatchOptions]
   * @returns {Promise<{sceneId: string, reason: string} | null>}
   */
  async function dispatch(action, context, {rehearsalSceneSkip = false} = {}) {
    if (!isRecord(action)) throw new TypeError('Runtime action must be an object');
    const command = String(action.command);
    const target = action.target === null ? null : String(action.target);
    const args = /** @type {Record<string, unknown>} */ (action.args);
    if (!isRecord(args)) throw new TypeError('Runtime action args must be an object');

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
      throw invalidResult('Invalid custom action runtime result');
    }
    if (!coreActionNames.has(command)) {
      const error = new Error(`Unknown DSL 4.0 runtime action: ${command}`);
      Object.defineProperty(error, 'code', {value: 'K4-RUNTIME-DISPATCH-001'});
      throw error;
    }
    if (command === 'debugger') return null;
    if (command === 'goto') return {sceneId: String(args.scene), reason: 'goto'};
    if (command === 'branch') {
      return {sceneId: await resolveBranch(String(args.branch), context), reason: 'branch'};
    }
    if (command === 'keyInputToChangeScene') {
      const routes = /** @type {Record<string, string>} */ (args.routes);
      const selected = await invokePort(command, {codes: Object.keys(routes)}, context);
      if (typeof selected !== 'string' || !Object.hasOwn(routes, selected)) {
        throw invalidResult(`Invalid key input result: ${String(selected)}`);
      }
      return {sceneId: routes[selected], reason: 'keyInput'};
    }
    if (command === 'touchInputToChangeScene') {
      const routes = /** @type {Record<string, string>} */ (args.routes);
      const selected = await invokePort(command, {actors: Object.keys(routes)}, context);
      if (typeof selected !== 'string' || !Object.hasOwn(routes, selected)) {
        throw invalidResult(`Invalid touch input result: ${String(selected)}`);
      }
      return {sceneId: routes[selected], reason: 'touchInput'};
    }
    if (command === 'poseInputToChangeScene') {
      const routes = /** @type {Record<string, string>} */ (args.routes);
      const selected = await invokePort(
        command,
        {
          poses: Object.keys(routes),
          poseModel: getPoseModel(),
          recognition: cloneValue(poseSelectionRecognition),
        },
        context,
      );
      if (typeof selected !== 'string' || !Object.hasOwn(routes, selected)) {
        throw invalidResult(`Invalid pose input result: ${String(selected)}`);
      }
      return {sceneId: routes[selected], reason: 'poseInput'};
    }
    if (command === 'pose') {
      await dispatchPose({target, args}, context);
      return null;
    }
    const portArgs =
      command === 'say' || command === 'think'
        ? resolveSpeechStyle(command, args)
        : rehearsalSceneSkip && command === 'transition'
          ? {...args, seconds: 0}
          : args;
    await invokePort(command, target === null ? {...portArgs} : {target, ...portArgs}, context);
    return null;
  }

  return Object.freeze({dispatch});
}
