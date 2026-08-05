/**
 * @typedef {object} SourcePosition
 * @property {number} line
 * @property {number} column
 * @property {number} offset
 *
 * @typedef {object} SourceRange
 * @property {SourcePosition} start
 * @property {SourcePosition} end
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
 * @template T
 * @param {T} value
 * @returns {Readonly<T>}
 */
export function deepFreeze(value) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * @param {any} node
 * @param {import('yaml').LineCounter} lineCounter
 * @returns {SourceRange}
 */
export function sourceRangeForNode(node, lineCounter) {
  const startOffset = node?.range?.[0] ?? 0;
  const endOffset = node?.range?.[1] ?? startOffset;
  const start = lineCounter.linePos(startOffset);
  const end = lineCounter.linePos(endOffset);
  return {
    start: {line: start.line, column: start.col, offset: startOffset},
    end: {line: end.line, column: end.col, offset: endOffset},
  };
}

/**
 * @param {string} value
 * @returns {string}
 */
function storyPathSegment(value) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * @param {unknown} asset
 * @param {string} id
 * @returns {Record<string, unknown>}
 */
function normalizeAsset(asset, id) {
  if (typeof asset === 'string') {
    const [kind, target] = asset.split(':');
    return {
      id,
      kind,
      name: id,
      delivery: 'embedded',
      loading: 'eager',
      ...(target ? {target} : {}),
    };
  }
  return {
    id,
    delivery: 'embedded',
    loading: 'eager',
    .../** @type {Record<string, unknown>} */ (cloneValue(asset)),
  };
}

/**
 * @param {Record<string, unknown>} sourceAction
 * @param {string} sceneId
 * @param {number} actionIndex
 * @param {any} actionNode
 * @param {import('yaml').LineCounter} lineCounter
 * @param {Record<string, SourceRange>} sourceMap
 * @returns {Record<string, unknown>}
 */
function normalizeAction(sourceAction, sceneId, actionIndex, actionNode, lineCounter, sourceMap) {
  const [sourceCommand] = Object.keys(sourceAction);
  const separator = sourceCommand.lastIndexOf('.');
  const target = separator === -1 ? null : sourceCommand.slice(0, separator);
  const command = separator === -1 ? sourceCommand : sourceCommand.slice(separator + 1);
  const sourceArguments = sourceAction[sourceCommand];
  const actionPath = `/scenes/${storyPathSegment(sceneId)}/actions/${actionIndex}`;
  const actionRange = sourceRangeForNode(actionNode, lineCounter);
  const argumentNode = actionNode?.get?.(sourceCommand, true);
  /** @type {Record<string, unknown>} */
  let args;

  if (typeof sourceArguments === 'object' && sourceArguments !== null) {
    const routeCommand =
      command === 'keyInputToChangeScene' || command === 'touchInputToChangeScene';
    const argumentRecord = /** @type {Record<string, unknown>} */ (sourceArguments);
    args = /** @type {Record<string, unknown>} */ (
      cloneValue(routeCommand && !argumentRecord.routes ? {routes: argumentRecord} : argumentRecord)
    );
  } else {
    const argumentName = {
      bgm: 'sound',
      branch: 'branch',
      goto: 'scene',
      setSkin: 'skin',
      sound: 'sound',
      stage: 'backdrop',
      wait: 'seconds',
    }[command];
    if (!argumentName) throw new Error(`Cannot normalize scalar arguments for ${command}`);
    args = {[argumentName]: sourceArguments};
  }

  const stableId = typeof args.stableId === 'string' ? args.stableId : undefined;
  delete args.stableId;
  sourceMap[actionPath] = actionRange;
  sourceMap[`${actionPath}/args`] = sourceRangeForNode(argumentNode, lineCounter);

  for (const field of Object.keys(args)) {
    let fieldNode = argumentNode;
    if (argumentNode?.get && typeof sourceArguments === 'object' && sourceArguments !== null) {
      const sourceField =
        field === 'routes' && !Object.hasOwn(sourceArguments, 'routes') ? undefined : field;
      if (sourceField) fieldNode = argumentNode.get(sourceField, true);
    }
    sourceMap[`${actionPath}/args/${storyPathSegment(field)}`] = sourceRangeForNode(
      fieldNode,
      lineCounter,
    );
  }
  if (stableId) {
    sourceMap[`${actionPath}/stableId`] = sourceRangeForNode(
      argumentNode?.get?.('stableId', true),
      lineCounter,
    );
  }

  return {
    kind: 'Action',
    id: actionPath,
    target,
    command,
    args,
    ...(stableId ? {stableId} : {}),
    sourceRange: actionRange,
  };
}

/**
 * @param {Record<string, unknown>} story
 * @param {any} document
 * @param {import('yaml').LineCounter} lineCounter
 * @param {string} sourceId
 * @returns {Readonly<Record<string, unknown>>}
 */
export function createStoryDocument(story, document, lineCounter, sourceId) {
  /** @type {Record<string, SourceRange>} */
  const sourceMap = {'/': sourceRangeForNode(document.contents, lineCounter)};
  const sourceAssets = /** @type {Record<string, unknown>} */ (story.assets ?? {});
  const assets = Object.fromEntries(
    Object.entries(sourceAssets).map(([id, asset]) => {
      sourceMap[`/assets/${storyPathSegment(id)}`] = sourceRangeForNode(
        document.getIn(['assets', id], true),
        lineCounter,
      );
      return [id, normalizeAsset(asset, id)];
    }),
  );

  const sourceScenes = /** @type {Record<string, unknown>} */ (story.scenes);
  const scenes = Object.entries(sourceScenes).map(([sceneId, sourceScene]) => {
    const sourceScenePath = ['scenes', sceneId];
    const sceneNode = document.getIn(sourceScenePath, true);
    const isShortScene = Array.isArray(sourceScene);
    const sourceActions = /** @type {Record<string, unknown>[]} */ (
      isShortScene ? sourceScene : /** @type {Record<string, unknown>} */ (sourceScene).actions
    );
    const scenePath = `/scenes/${storyPathSegment(sceneId)}`;
    sourceMap[scenePath] = sourceRangeForNode(sceneNode, lineCounter);
    const actions = sourceActions.map((action, actionIndex) => {
      const actionSourcePath = isShortScene
        ? [...sourceScenePath, actionIndex]
        : [...sourceScenePath, 'actions', actionIndex];
      return normalizeAction(
        action,
        sceneId,
        actionIndex,
        document.getIn(actionSourcePath, true),
        lineCounter,
        sourceMap,
      );
    });
    const longScene = /** @type {Record<string, unknown>} */ (sourceScene);
    const poseModel = isShortScene ? null : (longScene.poseModel ?? null);
    if (poseModel) {
      sourceMap[`${scenePath}/poseModel`] = sourceRangeForNode(
        document.getIn([...sourceScenePath, 'poseModel'], true),
        lineCounter,
      );
    }
    return {kind: 'Scene', id: sceneId, poseModel, actions};
  });

  const result = {
    kind: 'StoryDocument',
    version: '4.0',
    metadata: {sourceId},
    assets,
    actors: cloneValue(story.actors ?? {}),
    cover: cloneValue(story.cover ?? null),
    textStyles: cloneValue(story.textStyles ?? {}),
    variables: cloneValue(story.variables ?? {}),
    loading: cloneValue(story.loading ?? null),
    poseRecognition: cloneValue(story.poseRecognition ?? null),
    controls: cloneValue(story.controls ?? null),
    branches: cloneValue(story.branches ?? {}),
    scenes,
    sourceMap,
  };
  return deepFreeze(result);
}
