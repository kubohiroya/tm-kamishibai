import {dsl4ActorCoreActionNames} from './action-registry.js';
import {encodeDsl4StoryPathSegment} from './story-path.js';
import {normalizeDsl4AudioTransition, normalizeDsl4VisualTransition} from './transition-spec.js';

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
 * @param {Record<string, SourceRange>} sourceMap
 * @param {unknown} value
 * @param {any} document
 * @param {import('yaml').LineCounter} lineCounter
 * @param {Array<string | number>} yamlPath
 * @param {string} storyPath
 * @param {any} [node]
 */
function mapNestedSource(sourceMap, value, document, lineCounter, yamlPath, storyPath, node) {
  if (typeof value !== 'object' || value === null) return;
  const entries = Array.isArray(value)
    ? value.map((child, index) => [index, child])
    : Object.entries(/** @type {Record<string, unknown>} */ (value));
  for (const [key, child] of entries) {
    const segment = encodeDsl4StoryPathSegment(String(key));
    const childStoryPath = `${storyPath}/${segment}`;
    const childYamlPath = [...yamlPath, key];
    const childNode = document.getIn(childYamlPath, true) ?? node;
    sourceMap[childStoryPath] = sourceRangeForNode(childNode, lineCounter);
    mapNestedSource(
      sourceMap,
      child,
      document,
      lineCounter,
      childYamlPath,
      childStoryPath,
      childNode,
    );
  }
}

/**
 * @param {Record<string, SourceRange>} sourceMap
 * @param {unknown} value
 * @param {any} node
 * @param {import('yaml').LineCounter} lineCounter
 * @param {string} storyPath
 */
function mapNestedNode(sourceMap, value, node, lineCounter, storyPath) {
  if (typeof value !== 'object' || value === null) return;
  const entries = Array.isArray(value)
    ? value.map((child, index) => [index, child])
    : Object.entries(/** @type {Record<string, unknown>} */ (value));
  for (const [key, child] of entries) {
    const segment = encodeDsl4StoryPathSegment(String(key));
    const childPath = `${storyPath}/${segment}`;
    const childNode = node?.get?.(key, true) ?? node;
    sourceMap[childPath] = sourceRangeForNode(childNode, lineCounter);
    mapNestedNode(sourceMap, child, childNode, lineCounter, childPath);
  }
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
      ...(kind === 'backdrop' || kind === 'costume' ? {bitmapResolution: 1} : {}),
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
    ...(sourceAsset.kind === 'backdrop' || sourceAsset.kind === 'costume'
      ? {bitmapResolution: sourceAsset.bitmapResolution ?? 1}
      : {}),
    ...sourceAsset,
  };
}

/** @param {unknown} value */
function normalizePoseRecognition(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const source = /** @type {Record<string, unknown>} */ (cloneValue(value));
  const modelInitialization = /** @type {Record<string, unknown>} */ (
    source.modelInitialization ?? {}
  );
  const feedback = /** @type {Record<string, unknown>} */ (source.feedback ?? {});
  const navigation = /** @type {Record<string, unknown>} */ (source.navigation ?? {});
  const preview = /** @type {Record<string, unknown>} */ (source.preview ?? {});
  const overlay =
    preview.overlay && typeof preview.overlay === 'object' && !Array.isArray(preview.overlay)
      ? /** @type {Record<string, unknown>} */ (preview.overlay)
      : null;
  const jointStyles =
    overlay?.jointStyles &&
    typeof overlay.jointStyles === 'object' &&
    !Array.isArray(overlay.jointStyles)
      ? /** @type {Record<string, Record<string, unknown>>} */ (overlay.jointStyles)
      : null;
  const boneStyle =
    overlay?.boneStyle && typeof overlay.boneStyle === 'object' && !Array.isArray(overlay.boneStyle)
      ? /** @type {Record<string, unknown>} */ (overlay.boneStyle)
      : null;
  const confidenceScaling =
    overlay?.confidenceScaling &&
    typeof overlay.confidenceScaling === 'object' &&
    !Array.isArray(overlay.confidenceScaling)
      ? /** @type {Record<string, unknown>} */ (overlay.confidenceScaling)
      : {};
  const normalizedOverlay = overlay
    ? {
        visible: true,
        minimumConfidence: 0.5,
        ...overlay,
        ...(jointStyles
          ? {
              jointStyles: Object.fromEntries(
                Object.entries(jointStyles).map(([name, style]) => [
                  name,
                  {color: '#00e5ff', opacity: 1, radius: 4, ...style},
                ]),
              ),
            }
          : {}),
        ...(boneStyle ? {boneStyle: {color: '#00e5ff', opacity: 0.9, width: 3, ...boneStyle}} : {}),
        confidenceScaling: {
          jointOpacity: false,
          jointRadius: false,
          boneOpacity: false,
          boneWidth: false,
          ...confidenceScaling,
        },
      }
    : undefined;
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
    modelInitialization: {policy: 'legacy', parallel: false, ...modelInitialization},
    feedback: {mode: 'scratchMirror', ...feedback},
    navigation: {allowSkip: false, ...navigation},
    preview: {
      mirroring: 'mirrored',
      ...preview,
      ...(normalizedOverlay ? {overlay: normalizedOverlay} : {}),
      ...(normalizedControls ? {controls: normalizedControls} : {}),
    },
  };
}

/**
 * @param {Record<string, SourceRange>} sourceMap
 * @param {unknown} value
 * @param {any} document
 * @param {import('yaml').LineCounter} lineCounter
 */
function mapPoseRecognitionSource(sourceMap, value, document, lineCounter) {
  const poseRecognitionNode = document.getIn(['poseRecognition'], true);
  if (!poseRecognitionNode) return;
  sourceMap['/poseRecognition'] = sourceRangeForNode(poseRecognitionNode, lineCounter);
  for (const field of [
    'idleSound',
    'chargeSound',
    'modelInitialization',
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
      modelInitialization: ['policy', 'parallel'],
      sequence: ['confidenceThreshold', 'fullConfidenceHoldSeconds', 'idleChargePerSecond'],
      selection: ['accumulationPerSecond', 'decayPerSecond', 'scoreThreshold'],
      feedback: ['mode'],
      navigation: ['allowSkip'],
      preview: ['mirroring', 'overlay', 'controls'],
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
      const poseRecognition =
        typeof value === 'object' && value !== null && !Array.isArray(value)
          ? /** @type {Record<string, unknown>} */ (value)
          : {};
      const preview =
        typeof poseRecognition.preview === 'object' &&
        poseRecognition.preview !== null &&
        !Array.isArray(poseRecognition.preview)
          ? /** @type {Record<string, unknown>} */ (poseRecognition.preview)
          : {};
      if (
        typeof preview.overlay === 'object' &&
        preview.overlay !== null &&
        !Array.isArray(preview.overlay)
      ) {
        mapNestedSource(
          sourceMap,
          preview.overlay,
          document,
          lineCounter,
          ['poseRecognition', 'preview', 'overlay'],
          '/poseRecognition/preview/overlay',
        );
      }
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
  } else if (command === 'debugger' && sourceArguments === null) {
    args = {};
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
      broadcastMessageAndWait: 'message',
    }[command];
    if (!argumentName) throw new Error(`Cannot normalize scalar arguments for ${command}`);
    args = {[argumentName]: sourceArguments};
  }

  const stableId =
    typeof argumentRecord?.stableId === 'string' ? argumentRecord.stableId : undefined;
  delete args.stableId;
  if (!customAction && Object.hasOwn(args, 'transition')) {
    args.transition =
      command === 'bgm'
        ? normalizeDsl4AudioTransition(args.transition, `${actionPath}/args/transition`)
        : normalizeDsl4VisualTransition(args.transition, `${actionPath}/args/transition`);
  }
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
    if (field === 'transition') {
      mapNestedNode(
        sourceMap,
        args[field],
        fieldNode,
        lineCounter,
        `${actionPath}/args/transition`,
      );
    }
    if (field === 'styles' && Array.isArray(args[field])) {
      args[field].forEach((_, styleIndex) => {
        sourceMap[`${actionPath}/args/styles/${styleIndex}`] = sourceRangeForNode(
          fieldNode?.get?.(styleIndex, true) ?? fieldNode,
          lineCounter,
        );
      });
    }
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
  mapPoseRecognitionSource(sourceMap, story.poseRecognition, document, lineCounter);
  const sourceBranches = /** @type {Record<string, unknown>} */ (story.branches ?? {});
  mapBranchSources(sourceMap, sourceBranches, document, lineCounter);
  const sourceAssets = /** @type {Record<string, unknown>} */ (story.assets ?? {});
  const assets = Object.fromEntries(
    Object.entries(sourceAssets).map(([id, asset]) => {
      const assetPath = `/assets/${encodeDsl4StoryPathSegment(id)}`;
      sourceMap[assetPath] = sourceRangeForNode(document.getIn(['assets', id], true), lineCounter);
      mapNestedSource(sourceMap, asset, document, lineCounter, ['assets', id], assetPath);
      return [id, normalizeAsset(asset, id)];
    }),
  );

  const sourceBubbleStyles = /** @type {Record<string, Record<string, unknown>>} */ (
    story.bubbleStyles ?? {}
  );
  const bubbleStyles = cloneValue(sourceBubbleStyles);
  const bubbleStylesNode = document.getIn(['bubbleStyles'], true);
  if (bubbleStylesNode) {
    sourceMap['/bubbleStyles'] = sourceRangeForNode(bubbleStylesNode, lineCounter);
    for (const [styleId, style] of Object.entries(sourceBubbleStyles)) {
      const stylePath = `/bubbleStyles/${encodeDsl4StoryPathSegment(styleId)}`;
      const styleNode = document.getIn(['bubbleStyles', styleId], true);
      sourceMap[stylePath] = sourceRangeForNode(styleNode, lineCounter);
      mapNestedSource(
        sourceMap,
        style,
        document,
        lineCounter,
        ['bubbleStyles', styleId],
        stylePath,
      );
    }
  }

  const sourceBubbleClosePolicies = /** @type {Record<string, Record<string, unknown>>} */ (
    story.bubbleClosePolicies ?? {}
  );
  const bubbleClosePolicies = cloneValue(sourceBubbleClosePolicies);
  const bubbleClosePoliciesNode = document.getIn(['bubbleClosePolicies'], true);
  if (bubbleClosePoliciesNode) {
    sourceMap['/bubbleClosePolicies'] = sourceRangeForNode(bubbleClosePoliciesNode, lineCounter);
    for (const [policyId, policy] of Object.entries(sourceBubbleClosePolicies)) {
      const policyPath = `/bubbleClosePolicies/${encodeDsl4StoryPathSegment(policyId)}`;
      const policyNode = document.getIn(['bubbleClosePolicies', policyId], true);
      sourceMap[policyPath] = sourceRangeForNode(policyNode, lineCounter);
      mapNestedSource(
        sourceMap,
        policy,
        document,
        lineCounter,
        ['bubbleClosePolicies', policyId],
        policyPath,
      );
    }
  }
  const presentation = Object.hasOwn(story, 'presentation')
    ? /** @type {Record<string, unknown>} */ (cloneValue(story.presentation))
    : undefined;
  const audio = Object.hasOwn(story, 'audio')
    ? /** @type {Record<string, unknown>} */ (cloneValue(story.audio))
    : undefined;
  if (
    presentation &&
    typeof presentation.transitions === 'object' &&
    presentation.transitions !== null
  ) {
    const transitions = /** @type {Record<string, unknown>} */ (presentation.transitions);
    for (const field of ['scene', 'backdrop', 'actorSkin', 'actorVisibility']) {
      if (!Object.hasOwn(transitions, field)) continue;
      transitions[field] = normalizeDsl4VisualTransition(
        transitions[field],
        `/presentation/transitions/${field}`,
      );
    }
  }
  if (audio && typeof audio.bgm === 'object' && audio.bgm !== null) {
    const bgm = /** @type {Record<string, unknown>} */ (audio.bgm);
    if (Object.hasOwn(bgm, 'transition')) {
      bgm.transition = normalizeDsl4AudioTransition(bgm.transition, '/audio/bgm/transition');
    }
  }
  for (const [
    field,
    value,
  ] of /** @type {Array<[string, Record<string, unknown> | undefined]>} */ ([
    ['presentation', presentation],
    ['audio', audio],
  ])) {
    if (value === undefined) continue;
    const node = document.getIn([field], true);
    sourceMap[`/${field}`] = sourceRangeForNode(node, lineCounter);
    mapNestedSource(sourceMap, value, document, lineCounter, [field], `/${field}`);
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
    const entryTransition =
      !isShortScene && Object.hasOwn(longScene, 'entryTransition')
        ? normalizeDsl4VisualTransition(longScene.entryTransition, `${scenePath}/entryTransition`)
        : undefined;
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
    if (entryTransition !== undefined) {
      const entryTransitionNode = document.getIn([...sourceScenePath, 'entryTransition'], true);
      sourceMap[`${scenePath}/entryTransition`] = sourceRangeForNode(
        entryTransitionNode,
        lineCounter,
      );
      mapNestedNode(
        sourceMap,
        entryTransition,
        entryTransitionNode,
        lineCounter,
        `${scenePath}/entryTransition`,
      );
    }
    return {
      kind: 'Scene',
      id: sceneId,
      poseModel,
      posePreview,
      ...(entryTransition === undefined ? {} : {entryTransition}),
      actions,
    };
  });

  const result = {
    kind: 'StoryDocument',
    version: '4.0',
    metadata: {sourceId},
    assets,
    actors: cloneValue(story.actors ?? {}),
    cover: cloneValue(story.cover ?? null),
    textStyles: cloneValue(story.textStyles ?? {}),
    bubbleStyles,
    bubbleClosePolicies,
    variables: cloneValue(story.variables ?? {}),
    loading: cloneValue(story.loading ?? null),
    poseRecognition: normalizePoseRecognition(story.poseRecognition ?? null),
    controls: cloneValue(story.controls ?? null),
    branches: cloneValue(sourceBranches),
    ...(presentation === undefined ? {} : {presentation}),
    ...(audio === undefined ? {} : {audio}),
    scenes,
    sourceMap,
  };
  return deepFreeze(result);
}
