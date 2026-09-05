import {deepFreeze, sourceOriginForStoryPath} from './story-document.js';

const zeroRange = deepFreeze({
  start: {line: 1, column: 1, offset: 0},
  end: {line: 1, column: 1, offset: 0},
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainRuntimeValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function runtimeReferenceKind(
  value: unknown,
  isException: ((value: unknown) => boolean) | undefined,
) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('@os1.')) return 'object-store';
  if (isException?.(value)) return 'exception';
  return null;
}

function diagnostic(
  storyDocument: Readonly<Record<string, unknown>>,
  {
    code,
    severity,
    message,
    path,
    storyPath = '/',
    details = {},
  }: {
    code: string;
    severity: 'error' | 'warning';
    message: string;
    path: string;
    storyPath?: string;
    details?: Record<string, unknown>;
  },
) {
  const origin = sourceOriginForStoryPath(storyDocument, storyPath);
  return deepFreeze({
    version: 1,
    code,
    severity,
    message,
    sourceId: origin.sourceId,
    range: origin.range ?? zeroRange,
    ...(storyPath !== '/' ? {storyPath} : {}),
    path,
    related: [],
    details,
  });
}

function scenesOf(
  storyDocument: Readonly<Record<string, unknown>>,
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return storyDocument.scenes as ReadonlyArray<Readonly<Record<string, unknown>>>;
}

function actionsOf(
  storyDocument: Readonly<Record<string, unknown>>,
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return scenesOf(storyDocument).flatMap(
    (scene) => scene.actions as ReadonlyArray<Readonly<Record<string, unknown>>>,
  );
}

function destination(scene: Readonly<Record<string, unknown>>, actionIndex: number) {
  const actions = scene.actions as ReadonlyArray<Readonly<Record<string, unknown>>>;
  const action = actions[actionIndex];
  return {
    sceneId: String(scene.id),
    actionIndex,
    actionPath: typeof action?.id === 'string' ? action.id : null,
  };
}

function currentActionOf(
  currentStoryDocument: Readonly<Record<string, unknown>>,
  currentExecution: Readonly<Record<string, unknown>>,
) {
  const actionPath = currentExecution.actionPath;
  if (typeof actionPath !== 'string') return null;
  const matches = actionsOf(currentStoryDocument).filter((action) => action.id === actionPath);
  const [onlyMatch] = matches;
  return matches.length === 1 && onlyMatch ? onlyMatch : null;
}

function hasCompatibleSignature(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
) {
  return (
    left.command === right.command &&
    left.target === right.target &&
    (left.handler ?? 'core') === (right.handler ?? 'core')
  );
}

function migrateVariables(
  currentStoryDocument: Readonly<Record<string, unknown>>,
  candidateStoryDocument: Readonly<Record<string, unknown>>,
  currentExecution: Readonly<Record<string, unknown>>,
  diagnostics: Readonly<Record<string, unknown>>[],
  isException: ((value: unknown) => boolean) | undefined,
) {
  const currentDeclarations = (currentStoryDocument.variables ?? {}) as Readonly<
    Record<string, string | number | boolean>
  >;
  const initialVariables = (candidateStoryDocument.variables ?? {}) as Readonly<
    Record<string, string | number | boolean>
  >;
  const currentVariables = isRecord(currentExecution.variables) ? currentExecution.variables : {};
  const variables: Record<string, string | number | boolean> = {};

  for (const [name, initialValue] of Object.entries(initialVariables)) {
    const currentValue = currentVariables[name];
    const referenceKind = runtimeReferenceKind(currentValue, isException);
    if (
      Object.hasOwn(currentDeclarations, name) &&
      Object.hasOwn(currentVariables, name) &&
      isPlainRuntimeValue(currentValue) &&
      referenceKind === null &&
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
          code: referenceKind ? 'K4-RELOAD-VARIABLE-REFERENCE-RESET' : 'K4-RELOAD-VARIABLE-RESET',
          severity: 'warning',
          message: referenceKind
            ? `Runtime variable ${JSON.stringify(name)} contains a runtime-only reference and will use its new initial value`
            : `Runtime variable ${JSON.stringify(name)} is incompatible and will use its new initial value`,
          path: `$.variables.${name}`,
          details: {name, ...(referenceKind ? {referenceKind} : {})},
        }),
      );
    }
  }
  return variables;
}

function resolveActionAnchor(
  candidateStoryDocument: Readonly<Record<string, unknown>>,
  currentAction: Readonly<Record<string, unknown>> | null,
) {
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

  const [action] = matches;
  // The count checks above leave exactly one match.
  if (!action) {
    return {code: 'K4-RELOAD-ANCHOR-MISSING', message: 'No action matches the current anchor'};
  }
  if (!hasCompatibleSignature(currentAction, action)) {
    return {
      code: 'K4-RELOAD-ANCHOR-INCOMPATIBLE',
      message: 'The matched action has a different command or target',
      storyPath: typeof action.id === 'string' ? action.id : '/',
      details: {strategy},
    };
  }

  const scene = scenesOf(candidateStoryDocument).find((candidateScene) =>
    (candidateScene.actions as ReadonlyArray<Readonly<Record<string, unknown>>>).includes(action),
  );
  if (!scene) {
    return {code: 'K4-RELOAD-ANCHOR-MISSING', message: 'The matched action has no scene'};
  }
  const actionIndex = (scene.actions as ReadonlyArray<Readonly<Record<string, unknown>>>).indexOf(
    action,
  );
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

/** Plan the three author-visible live reload choices without reading source files or mutating a runtime. */
export function createDsl4ReloadPlan({
  currentStoryDocument,
  candidateStoryDocument,
  currentExecution,
  isException,
}: {
  currentStoryDocument: Readonly<Record<string, unknown>>;
  candidateStoryDocument: Readonly<Record<string, unknown>>;
  currentExecution: Readonly<Record<string, unknown>>;
  isException?: (value: unknown) => boolean;
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
  if (isException !== undefined && typeof isException !== 'function') {
    throw new TypeError('isException must be a function');
  }

  const diagnostics: Readonly<Record<string, unknown>>[] = [];
  const candidateScenes = scenesOf(candidateStoryDocument);
  const firstScene = candidateScenes[0];
  if (!firstScene) throw new TypeError('candidateStoryDocument must contain at least one scene');

  const candidateInitialVariables = (candidateStoryDocument.variables ?? {}) as Readonly<
    Record<string, string | number | boolean>
  >;
  const migratedVariables = migrateVariables(
    currentStoryDocument,
    candidateStoryDocument,
    currentExecution,
    diagnostics,
    isException,
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
      ...(anchorResult.storyPath === undefined ? {} : {storyPath: anchorResult.storyPath}),
      ...(anchorResult.details === undefined ? {} : {details: anchorResult.details}),
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
