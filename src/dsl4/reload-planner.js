import {deepFreeze} from './story-document.js';

const zeroRange = deepFreeze({
  start: {line: 1, column: 1, offset: 0},
  end: {line: 1, column: 1, offset: 0},
});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string | number | boolean} */
function isPlainRuntimeValue(value) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {string} storyPath
 * @returns {unknown}
 */
function sourceRange(storyDocument, storyPath) {
  const sourceMap = /** @type {Record<string, unknown>} */ (storyDocument.sourceMap ?? {});
  return sourceMap[storyPath] ?? sourceMap['/'] ?? zeroRange;
}

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {object} input
 * @param {string} input.code
 * @param {'error' | 'warning'} input.severity
 * @param {string} input.message
 * @param {string} input.path
 * @param {string} [input.storyPath]
 * @param {Record<string, unknown>} [input.details]
 */
function diagnostic(storyDocument, {code, severity, message, path, storyPath = '/', details = {}}) {
  const metadata = /** @type {Record<string, unknown>} */ (storyDocument.metadata ?? {});
  return deepFreeze({
    version: 1,
    code,
    severity,
    message,
    sourceId: typeof metadata.sourceId === 'string' ? metadata.sourceId : 'main',
    range: sourceRange(storyDocument, storyPath),
    ...(storyPath !== '/' ? {storyPath} : {}),
    path,
    related: [],
    details,
  });
}

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @returns {ReadonlyArray<Readonly<Record<string, unknown>>>}
 */
function scenesOf(storyDocument) {
  return /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (storyDocument.scenes);
}

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @returns {ReadonlyArray<Readonly<Record<string, unknown>>>}
 */
function actionsOf(storyDocument) {
  return scenesOf(storyDocument).flatMap(
    (scene) => /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (scene.actions),
  );
}

/**
 * @param {Readonly<Record<string, unknown>>} scene
 * @param {number} actionIndex
 */
function destination(scene, actionIndex) {
  const actions = /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (scene.actions);
  const action = actions[actionIndex];
  return {
    sceneId: String(scene.id),
    actionIndex,
    actionPath: typeof action?.id === 'string' ? action.id : null,
  };
}

/**
 * @param {Readonly<Record<string, unknown>>} currentStoryDocument
 * @param {Readonly<Record<string, unknown>>} currentExecution
 */
function currentActionOf(currentStoryDocument, currentExecution) {
  const actionPath = currentExecution.actionPath;
  if (typeof actionPath !== 'string') return null;
  const matches = actionsOf(currentStoryDocument).filter((action) => action.id === actionPath);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * @param {Readonly<Record<string, unknown>>} left
 * @param {Readonly<Record<string, unknown>>} right
 */
function hasCompatibleSignature(left, right) {
  return left.command === right.command && left.target === right.target;
}

/**
 * @param {Readonly<Record<string, unknown>>} currentStoryDocument
 * @param {Readonly<Record<string, unknown>>} candidateStoryDocument
 * @param {Readonly<Record<string, unknown>>} currentExecution
 * @param {Readonly<Record<string, unknown>>[]} diagnostics
 */
function migrateVariables(
  currentStoryDocument,
  candidateStoryDocument,
  currentExecution,
  diagnostics,
) {
  const currentDeclarations = /** @type {Readonly<Record<string, string | number | boolean>>} */ (
    currentStoryDocument.variables ?? {}
  );
  const initialVariables = /** @type {Readonly<Record<string, string | number | boolean>>} */ (
    candidateStoryDocument.variables ?? {}
  );
  const currentVariables = isRecord(currentExecution.variables) ? currentExecution.variables : {};
  /** @type {Record<string, string | number | boolean>} */
  const variables = {};

  for (const [name, initialValue] of Object.entries(initialVariables)) {
    const currentValue = currentVariables[name];
    if (
      Object.hasOwn(currentDeclarations, name) &&
      Object.hasOwn(currentVariables, name) &&
      isPlainRuntimeValue(currentValue) &&
      typeof currentDeclarations[name] === typeof initialValue &&
      typeof currentValue === typeof initialValue
    ) {
      variables[name] = currentValue;
      continue;
    }
    variables[name] = initialValue;
    if (Object.hasOwn(currentVariables, name)) {
      diagnostics.push(
        diagnostic(candidateStoryDocument, {
          code: 'K4-RELOAD-VARIABLE-RESET',
          severity: 'warning',
          message: `Runtime variable ${JSON.stringify(name)} is incompatible and will use its new initial value`,
          path: `$.variables.${name}`,
          details: {name},
        }),
      );
    }
  }
  return variables;
}

/**
 * @param {Readonly<Record<string, unknown>>} candidateStoryDocument
 * @param {Readonly<Record<string, unknown>> | null} currentAction
 */
function resolveActionAnchor(candidateStoryDocument, currentAction) {
  if (!currentAction) {
    return {code: 'K4-RELOAD-ANCHOR-MISSING', message: 'The current action is not available'};
  }

  const candidateActions = actionsOf(candidateStoryDocument);
  const stableId = currentAction.stableId;
  const strategy = typeof stableId === 'string' ? 'stableId' : 'storyPath+signature';
  const matches = candidateActions.filter((action) =>
    strategy === 'stableId' ? action.stableId === stableId : action.id === currentAction.id,
  );

  if (matches.length === 0) {
    const label = strategy === 'stableId' ? `stableId ${JSON.stringify(stableId)}` : 'StoryPath';
    return {
      code: 'K4-RELOAD-ANCHOR-MISSING',
      message: `No action matches the current ${label}`,
      details: {strategy, value: strategy === 'stableId' ? stableId : currentAction.id},
    };
  }
  if (matches.length > 1) {
    return {
      code: 'K4-RELOAD-ANCHOR-AMBIGUOUS',
      message: 'The current action anchor matches more than one action',
      details: {strategy, matchCount: matches.length},
    };
  }

  const action = matches[0];
  if (!hasCompatibleSignature(currentAction, action)) {
    return {
      code: 'K4-RELOAD-ANCHOR-INCOMPATIBLE',
      message: 'The matched action has a different command or target',
      storyPath: typeof action.id === 'string' ? action.id : '/',
      details: {strategy},
    };
  }

  const scene = scenesOf(candidateStoryDocument).find((candidateScene) =>
    /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (
      candidateScene.actions
    ).includes(action),
  );
  if (!scene) {
    return {code: 'K4-RELOAD-ANCHOR-MISSING', message: 'The matched action has no scene'};
  }
  const actionIndex = /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (
    scene.actions
  ).indexOf(action);
  return {
    action,
    scene,
    actionIndex,
    anchor: {
      strategy,
      value: strategy === 'stableId' ? stableId : currentAction.id,
    },
  };
}

/**
 * Plan the three author-visible live reload choices without reading source files or mutating a runtime.
 *
 * @param {object} options
 * @param {Readonly<Record<string, unknown>>} options.currentStoryDocument
 * @param {Readonly<Record<string, unknown>>} options.candidateStoryDocument
 * @param {Readonly<Record<string, unknown>>} options.currentExecution
 */
export function createDsl4ReloadPlan({
  currentStoryDocument,
  candidateStoryDocument,
  currentExecution,
}) {
  for (const [name, storyDocument] of Object.entries({
    currentStoryDocument,
    candidateStoryDocument,
  })) {
    if (storyDocument?.kind !== 'StoryDocument' || storyDocument.version !== '4.0') {
      throw new TypeError(`${name} must be a DSL 4.0 StoryDocument`);
    }
  }
  if (!isRecord(currentExecution)) throw new TypeError('currentExecution must be an object');

  /** @type {Readonly<Record<string, unknown>>[]} */
  const diagnostics = [];
  const candidateScenes = scenesOf(candidateStoryDocument);
  const firstScene = candidateScenes[0];
  if (!firstScene) throw new TypeError('candidateStoryDocument must contain at least one scene');

  const candidateInitialVariables =
    /** @type {Readonly<Record<string, string | number | boolean>>} */ (
      candidateStoryDocument.variables ?? {}
    );
  const migratedVariables = migrateVariables(
    currentStoryDocument,
    candidateStoryDocument,
    currentExecution,
    diagnostics,
  );
  const currentSceneId = currentExecution.sceneId;
  const candidateScene =
    typeof currentSceneId === 'string'
      ? candidateScenes.find((scene) => scene.id === currentSceneId)
      : undefined;

  let currentSceneOption;
  if (candidateScene) {
    currentSceneOption = {
      enabled: true,
      destination: destination(candidateScene, 0),
      variables: migratedVariables,
      preserveManagedPresentation: false,
    };
  } else {
    const sceneDiagnostic = diagnostic(candidateStoryDocument, {
      code: 'K4-RELOAD-SCENE-MISSING',
      severity: 'error',
      message: 'The current scene does not exist in the new story',
      path: '$.reload.options.currentScene',
      details: {sceneId: typeof currentSceneId === 'string' ? currentSceneId : null},
    });
    diagnostics.push(sceneDiagnostic);
    currentSceneOption = {enabled: false, reason: sceneDiagnostic.code};
  }

  const anchorResult = resolveActionAnchor(
    candidateStoryDocument,
    currentActionOf(currentStoryDocument, currentExecution),
  );
  let currentActionOption;
  if (
    'action' in anchorResult &&
    anchorResult.action &&
    anchorResult.scene &&
    typeof anchorResult.actionIndex === 'number' &&
    anchorResult.anchor
  ) {
    currentActionOption = {
      enabled: true,
      destination: destination(anchorResult.scene, anchorResult.actionIndex),
      variables: migratedVariables,
      preserveManagedPresentation: true,
      anchor: anchorResult.anchor,
    };
  } else {
    const anchorDiagnostic = diagnostic(candidateStoryDocument, {
      code: anchorResult.code,
      severity: 'error',
      message: anchorResult.message,
      path: '$.reload.options.currentAction',
      storyPath: anchorResult.storyPath,
      details: anchorResult.details,
    });
    diagnostics.push(anchorDiagnostic);
    currentActionOption = {enabled: false, reason: anchorDiagnostic.code};
  }

  return deepFreeze({
    version: 1,
    options: {
      storyStart: {
        enabled: true,
        destination: destination(firstScene, 0),
        variables: {...candidateInitialVariables},
        preserveManagedPresentation: false,
      },
      currentScene: currentSceneOption,
      currentAction: currentActionOption,
    },
    diagnostics,
  });
}
