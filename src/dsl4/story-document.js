import {dsl4ActorCoreActionNames} from './action-registry.js';
import {encodeDsl4StoryPathSegment} from './story-path.js';

const actorCoreActionNames = new Set(dsl4ActorCoreActionNames);

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

const zeroSourceRange = deepFreeze({
  start: {line: 1, column: 1, offset: 0},
  end: {line: 1, column: 1, offset: 0},
});

/**
 * Resolve the closest available source origin for a StoryDocument path.
 *
 * Included-source documents carry sourceOrigins. Legacy single-source documents fall back to
 * metadata.sourceId and sourceMap, preserving the existing diagnostic contract.
 *
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {string} [storyPath]
 */
export function sourceOriginForStoryPath(storyDocument, storyPath = '/') {
  const metadata = /** @type {Record<string, unknown>} */ (storyDocument.metadata ?? {});
  const sourceMap = /** @type {Record<string, unknown>} */ (storyDocument.sourceMap ?? {});
  const sourceOrigins = /** @type {Record<string, unknown>} */ (storyDocument.sourceOrigins ?? {});
  let candidatePath = storyPath.startsWith('/') ? storyPath : '/';
  while (true) {
    const origin = sourceOrigins[candidatePath];
    if (typeof origin === 'object' && origin !== null && !Array.isArray(origin)) {
      const record = /** @type {Record<string, unknown>} */ (origin);
      if (typeof record.sourceId === 'string' && record.range !== undefined) {
        return deepFreeze({sourceId: record.sourceId, range: record.range});
      }
    }
    if (candidatePath === '/') break;
    const separator = candidatePath.lastIndexOf('/');
    candidatePath = separator > 0 ? candidatePath.slice(0, separator) : '/';
  }
  candidatePath = storyPath.startsWith('/') ? storyPath : '/';
  while (sourceMap[candidatePath] === undefined && candidatePath !== '/') {
    const separator = candidatePath.lastIndexOf('/');
    candidatePath = separator > 0 ? candidatePath.slice(0, separator) : '/';
  }
  return deepFreeze({
    sourceId: typeof metadata.sourceId === 'string' ? metadata.sourceId : 'main',
    range: sourceMap[candidatePath] ?? sourceMap['/'] ?? zeroSourceRange,
  });
}

/**
 * @param {string} value
 * @returns {string}
 */
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
      retention: kind === 'poseModel' ? 'scene' : 'story',
      ...(target ? {target} : {}),
    };
  }
  const sourceAsset = /** @type {Record<string, unknown>} */ (cloneValue(asset));
  return {
    id,
    delivery: 'embedded',
    loading: 'eager',
    retention: sourceAsset.kind === 'poseModel' ? 'scene' : 'story',
    ...sourceAsset,
  };
}

/** @param {unknown} value */
function normalizePoseRecognition(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const source = /** @type {Record<string, unknown>} */ (cloneValue(value));
  const feedback = /** @type {Record<string, unknown>} */ (source.feedback ?? {});
  const navigation = /** @type {Record<string, unknown>} */ (source.navigation ?? {});
  const preview = /** @type {Record<string, unknown>} */ (source.preview ?? {});
  const controls =
    preview.controls && typeof preview.controls === 'object'
      ? /** @type {Record<string, Record<string, unknown>>} */ (preview.controls)
      : null;
  const normalizedControls = controls
    ? Object.fromEntries(
        Object.entries(controls).map(([name, control]) => [name, {opacity: 1, ...control}]),
      )
    : undefined;
  return {
    ...source,
    feedback: {mode: 'scratchMirror', ...feedback},
    navigation: {allowSkip: false, ...navigation},
    preview: {
      mirroring: 'mirrored',
      ...preview,
      ...(normalizedControls ? {controls: normalizedControls} : {}),
    },
  };
}

/**
 * @param {Record<string, SourceRange>} sourceMap
 * @param {any} document
 * @param {import('yaml').LineCounter} lineCounter
 */
function mapPoseRecognitionSource(sourceMap, document, lineCounter) {
  const poseRecognitionNode = document.getIn(['poseRecognition'], true);
  if (!poseRecognitionNode) return;
  sourceMap['/poseRecognition'] = sourceRangeForNode(poseRecognitionNode, lineCounter);
  for (const field of [
    'idleSound',
    'chargeSound',
    'sequence',
    'selection',
    'feedback',
    'navigation',
    'preview',
  ]) {
    const fieldNode = document.getIn(['poseRecognition', field], true);
    if (!fieldNode) continue;
    sourceMap[`/poseRecognition/${field}`] = sourceRangeForNode(fieldNode, lineCounter);
    const nestedFields = {
      sequence: ['confidenceThreshold', 'fullConfidenceHoldSeconds', 'idleChargePerSecond'],
      selection: ['accumulationPerSecond', 'decayPerSecond', 'scoreThreshold'],
      feedback: ['mode'],
      navigation: ['allowSkip'],
      preview: ['mirroring', 'controls'],
    }[field];
    for (const nestedField of nestedFields ?? []) {
      const nestedNode = document.getIn(['poseRecognition', field, nestedField], true);
      if (nestedNode) {
        sourceMap[`/poseRecognition/${field}/${nestedField}`] = sourceRangeForNode(
          nestedNode,
          lineCounter,
        );
      }
    }
    if (field === 'preview') {
      for (const controlName of ['mirroring', 'cameraMenu']) {
        const controlPath = ['poseRecognition', 'preview', 'controls', controlName];
        const controlNode = document.getIn(controlPath, true);
        if (!controlNode) continue;
        sourceMap[`/poseRecognition/preview/controls/${controlName}`] = sourceRangeForNode(
          controlNode,
          lineCounter,
        );
        const controlFields =
          controlName === 'mirroring'
            ? ['position', 'opacity', 'assets']
            : ['position', 'opacity', 'buttonAsset'];
        for (const controlField of controlFields) {
          const controlFieldNode = document.getIn([...controlPath, controlField], true);
          if (controlFieldNode) {
            sourceMap[`/poseRecognition/preview/controls/${controlName}/${controlField}`] =
              sourceRangeForNode(controlFieldNode, lineCounter);
          }
        }
        if (controlName === 'mirroring') {
          for (const assetField of ['showMirrored', 'showUnmirrored']) {
            const assetNode = document.getIn([...controlPath, 'assets', assetField], true);
            if (assetNode) {
              sourceMap[`/poseRecognition/preview/controls/mirroring/assets/${assetField}`] =
                sourceRangeForNode(assetNode, lineCounter);
            }
          }
        }
      }
    }
  }
}

/**
 * @param {Record<string, SourceRange>} sourceMap
 * @param {Record<string, unknown>} branches
 * @param {any} document
 * @param {import('yaml').LineCounter} lineCounter
 */
function mapBranchSources(sourceMap, branches, document, lineCounter) {
  for (const [branchId, value] of Object.entries(branches)) {
    if (!Array.isArray(value)) continue;
    const branchPath = `/branches/${encodeDsl4StoryPathSegment(branchId)}`;
    sourceMap[branchPath] = sourceRangeForNode(
      document.getIn(['branches', branchId], true),
      lineCounter,
    );
    value.forEach((rule, index) => {
      const rulePath = `${branchPath}/${index}`;
      sourceMap[rulePath] = sourceRangeForNode(
        document.getIn(['branches', branchId, index], true),
        lineCounter,
      );
      if (typeof rule === 'object' && rule !== null && Object.hasOwn(rule, 'if')) {
        sourceMap[`${rulePath}/if`] = sourceRangeForNode(
          document.getIn(['branches', branchId, index, 'if'], true),
          lineCounter,
        );
      }
    });
  }
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
  const customAction = separator !== -1 && !actorCoreActionNames.has(command);
  const actionPath = `/scenes/${encodeDsl4StoryPathSegment(sceneId)}/actions/${actionIndex}`;
  const actionRange = sourceRangeForNode(actionNode, lineCounter);
  const argumentNode = actionNode?.get?.(sourceCommand, true);
  const argumentRecord =
    typeof sourceArguments === 'object' && sourceArguments !== null
      ? /** @type {Record<string, unknown>} */ (sourceArguments)
      : null;
  /** @type {Record<string, unknown>} */
  let args;

  if (customAction) {
    args = /** @type {Record<string, unknown>} */ (
      cloneValue(/** @type {Record<string, unknown>} */ (argumentRecord?.arguments ?? {}))
    );
  } else if (argumentRecord) {
    const routeCommand = [
      'keyInputToChangeScene',
      'touchInputToChangeScene',
      'poseInputToChangeScene',
    ].includes(command);
    args = /** @type {Record<string, unknown>} */ (
      cloneValue(routeCommand && !argumentRecord.routes ? {routes: argumentRecord} : argumentRecord)
    );
  } else {
    const argumentName = {
      bgm: 'sound',
      branch: 'branch',
      goto: 'scene',
      setSkin: 'skin',
      setLayer: 'layer',
      setTransparency: 'transparency',
      sound: 'sound',
      stage: 'backdrop',
      wait: 'seconds',
    }[command];
    if (!argumentName) throw new Error(`Cannot normalize scalar arguments for ${command}`);
    args = {[argumentName]: sourceArguments};
  }

  const stableId =
    typeof argumentRecord?.stableId === 'string' ? argumentRecord.stableId : undefined;
  delete args.stableId;
  const argsNode = customAction
    ? (argumentNode?.get?.('arguments', true) ?? argumentNode)
    : argumentNode;
  sourceMap[actionPath] = actionRange;
  sourceMap[`${actionPath}/args`] = sourceRangeForNode(argsNode, lineCounter);

  for (const field of Object.keys(args)) {
    let fieldNode = argsNode;
    if (customAction) {
      fieldNode = argsNode?.get?.(field, true) ?? argsNode;
    } else if (argumentNode?.get && argumentRecord) {
      const sourceField =
        field === 'routes' && !Object.hasOwn(argumentRecord, 'routes') ? undefined : field;
      if (sourceField) fieldNode = argumentNode.get(sourceField, true);
    }
    sourceMap[`${actionPath}/args/${encodeDsl4StoryPathSegment(field)}`] = sourceRangeForNode(
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
    ...(customAction ? {handler: 'custom'} : {}),
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
  mapPoseRecognitionSource(sourceMap, document, lineCounter);
  const sourceBranches = /** @type {Record<string, unknown>} */ (story.branches ?? {});
  mapBranchSources(sourceMap, sourceBranches, document, lineCounter);
  const sourceAssets = /** @type {Record<string, unknown>} */ (story.assets ?? {});
  const assets = Object.fromEntries(
    Object.entries(sourceAssets).map(([id, asset]) => {
      sourceMap[`/assets/${encodeDsl4StoryPathSegment(id)}`] = sourceRangeForNode(
        document.getIn(['assets', id], true),
        lineCounter,
      );
      return [id, normalizeAsset(asset, id)];
    }),
  );

  const sourceSpeechStyles = /** @type {Record<string, Record<string, unknown>>} */ (
    story.speechStyles ?? {}
  );
  const speechStyles = cloneValue(sourceSpeechStyles);
  const speechStylesNode = document.getIn(['speechStyles'], true);
  if (speechStylesNode) {
    sourceMap['/speechStyles'] = sourceRangeForNode(speechStylesNode, lineCounter);
    for (const [styleId, style] of Object.entries(sourceSpeechStyles)) {
      const stylePath = `/speechStyles/${encodeDsl4StoryPathSegment(styleId)}`;
      const styleNode = document.getIn(['speechStyles', styleId], true);
      sourceMap[stylePath] = sourceRangeForNode(styleNode, lineCounter);
      for (const field of Object.keys(style)) {
        sourceMap[`${stylePath}/${encodeDsl4StoryPathSegment(field)}`] = sourceRangeForNode(
          document.getIn(['speechStyles', styleId, field], true),
          lineCounter,
        );
      }
    }
  }

  const sourceScenes = /** @type {Record<string, unknown>} */ (story.scenes);
  const scenes = Object.entries(sourceScenes).map(([sceneId, sourceScene]) => {
    const sourceScenePath = ['scenes', sceneId];
    const sceneNode = document.getIn(sourceScenePath, true);
    const isShortScene = Array.isArray(sourceScene);
    const sourceActions = /** @type {Record<string, unknown>[]} */ (
      isShortScene ? sourceScene : /** @type {Record<string, unknown>} */ (sourceScene).actions
    );
    const scenePath = `/scenes/${encodeDsl4StoryPathSegment(sceneId)}`;
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
    const posePreview = isShortScene ? null : cloneValue(longScene.posePreview ?? null);
    if (poseModel) {
      sourceMap[`${scenePath}/poseModel`] = sourceRangeForNode(
        document.getIn([...sourceScenePath, 'poseModel'], true),
        lineCounter,
      );
    }
    if (posePreview) {
      const posePreviewNode = document.getIn([...sourceScenePath, 'posePreview'], true);
      sourceMap[`${scenePath}/posePreview`] = sourceRangeForNode(posePreviewNode, lineCounter);
      sourceMap[`${scenePath}/posePreview/mirroring`] = sourceRangeForNode(
        document.getIn([...sourceScenePath, 'posePreview', 'mirroring'], true),
        lineCounter,
      );
    }
    return {kind: 'Scene', id: sceneId, poseModel, posePreview, actions};
  });

  const result = {
    kind: 'StoryDocument',
    version: '4.0',
    metadata: {sourceId},
    assets,
    actors: cloneValue(story.actors ?? {}),
    cover: cloneValue(story.cover ?? null),
    textStyles: cloneValue(story.textStyles ?? {}),
    speechStyles,
    variables: cloneValue(story.variables ?? {}),
    loading: cloneValue(story.loading ?? null),
    poseRecognition: normalizePoseRecognition(story.poseRecognition ?? null),
    controls: cloneValue(story.controls ?? null),
    branches: cloneValue(sourceBranches),
    scenes,
    sourceMap,
  };
  return deepFreeze(result);
}
