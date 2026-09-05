import {resolveDsl4ControlProfile} from './control-profile-resolver.js';
import {createDsl4ActionQuiesceResolver} from './action-quiesce.js';
import {createDsl4HistoryReducer} from './history-reducer.js';
import {createDsl4KamishibaiStructuredDataSession} from './kamishibai-structured-data.js';
import {createDsl4KeymapInputAdapter} from './keymap-input-adapter.js';
import {createDsl4RuntimeController} from './runtime-controller.js';
import type {ActionContext, RuntimeEvent} from './runtime-controller.js';
import {deepFreeze, sourceOriginForStoryPath} from './story-document.js';

export type ResolvedControlProfile = Readonly<{
  ok: true;
  profile: string;
  keymap: Readonly<Record<string, string>>;
  canonicalKeymap: string;
  historyEnabled: boolean;
  diagnostics: ReadonlyArray<never>;
}>;

export type HistoryReducer = ReturnType<typeof createDsl4HistoryReducer>;

export type HistoryState = ReturnType<HistoryReducer['initialState']>;

export type RuntimeController = ReturnType<typeof createDsl4RuntimeController>;

export type SessionDiagnostic = ReturnType<typeof diagnostic>;

function diagnostic(
  storyDocument: Readonly<Record<string, unknown>>,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  const origin = sourceOriginForStoryPath(storyDocument);
  return deepFreeze({
    version: 1,
    code,
    severity: 'error',
    message,
    sourceId: origin.sourceId,
    range: origin.range,
    related: [],
    details,
  });
}

function creationFailure(
  storyDocument: Readonly<Record<string, unknown>>,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return deepFreeze({ok: false, diagnostics: [diagnostic(storyDocument, code, message, details)]});
}

function historyFailure(result: unknown): {
  code: string;
  message: string;
  details: Record<string, unknown>;
} {
  return (result as {diagnostic: {code: string; message: string; details: Record<string, unknown>}})
    .diagnostic;
}

export function createDsl4NavigationSession({
  storyDocument,
  controlProfile,
  historyNavigationAvailable = false,
  historyLimits,
  port,
  debugExecution,
  assetLifecycle,
  createAssetLifecycle,
  evaluateCondition,
  onEvent,
  onInputError,
  structuredDataIntegrationEnabled = false,
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
  inputArbitration,
  resolveActionQuiesceMode,
  actionRegistrySnapshot,
  quiesceTimeoutMs,
  scheduleQuiesceTimeout,
}: {
  storyDocument: Readonly<Record<string, unknown>>;
  controlProfile: string;
  historyNavigationAvailable?: boolean;
  historyLimits?: {maxActionEntries: number; maxSceneVisits: number};
  port: Record<string, (...parameters: any[]) => unknown>;
  debugExecution?: {beforeAction: Function; getState: Function};
  assetLifecycle?: {
    prepare: Function;
    setLoading: Function;
    releaseAssets: Function;
    release: Function;
  };
  createAssetLifecycle?: () => {
    prepare: Function;
    setLoading: Function;
    releaseAssets: Function;
    release: Function;
  };
  evaluateCondition?: (
    expression: string,
    variables: Readonly<Record<string, string | number | boolean>>,
    context: Readonly<Record<string, unknown>>,
  ) => boolean | Promise<boolean>;
  onEvent?: (event: Readonly<Record<string, unknown>>) => void;
  onInputError?: (
    error: unknown,
    context: Readonly<{command: string; code: string}>,
  ) => unknown | Promise<unknown>;
  structuredDataIntegrationEnabled?: boolean;
  posePreviewMirroringEnabled?: boolean;
  cameraPreviewControlsEnabled?: boolean;
  poseNavigationPolicyEnabled?: boolean;
  speechAdvanceTypewriterEnabled?: boolean;
  bubbleAdvanceIndicatorEnabled?: boolean;
  turboWarpBubbleEnabled?: boolean;
  turboWarpBubbleAdvancedPresentationEnabled?: boolean;
  broadcastMessageAndWaitEnabled?: boolean;
  storyVariableWriteEnabled?: boolean;
  crossfadeTransitionsEnabled?: boolean;
  inputArbitration?: unknown;
  resolveActionQuiesceMode?: (
    action: Readonly<Record<string, unknown>> | null,
  ) => 'finish-only' | 'cancel-replay-safe';
  actionRegistrySnapshot?: unknown;
  quiesceTimeoutMs?: number;
  scheduleQuiesceTimeout?: (callback: () => void, milliseconds: number) => () => void;
}) {
  if (typeof structuredDataIntegrationEnabled !== 'boolean') {
    throw new TypeError('structuredDataIntegrationEnabled must be boolean');
  }
  if (typeof posePreviewMirroringEnabled !== 'boolean') {
    throw new TypeError('posePreviewMirroringEnabled must be boolean');
  }
  if (typeof cameraPreviewControlsEnabled !== 'boolean') {
    throw new TypeError('cameraPreviewControlsEnabled must be boolean');
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
  if (
    inputArbitration !== undefined &&
    (typeof inputArbitration !== 'object' ||
      inputArbitration === null ||
      typeof (inputArbitration as Record<string, unknown>).shouldDeferNavigationKey !==
        'function' ||
      typeof (inputArbitration as Record<string, unknown>).arbitrateNavigationPointer !==
        'function' ||
      typeof (inputArbitration as Record<string, unknown>).cancelNavigationPointer !== 'function')
  ) {
    throw new TypeError(
      'inputArbitration must provide key, pointer, and pointer cancellation arbitration',
    );
  }
  const arbitration = inputArbitration as Record<string, Function> | undefined;
  if (assetLifecycle !== undefined && createAssetLifecycle !== undefined) {
    throw new TypeError('Provide either assetLifecycle or createAssetLifecycle, not both');
  }
  if (createAssetLifecycle !== undefined && typeof createAssetLifecycle !== 'function') {
    throw new TypeError('createAssetLifecycle must be a function');
  }
  if (resolveActionQuiesceMode !== undefined && typeof resolveActionQuiesceMode !== 'function') {
    throw new TypeError('resolveActionQuiesceMode must be a function');
  }
  if (resolveActionQuiesceMode !== undefined && actionRegistrySnapshot !== undefined) {
    throw new TypeError('Provide resolveActionQuiesceMode or actionRegistrySnapshot, not both');
  }
  const actionQuiesceMode =
    resolveActionQuiesceMode ??
    createDsl4ActionQuiesceResolver(
      actionRegistrySnapshot === undefined ? undefined : {registrySnapshot: actionRegistrySnapshot},
    );
  const profileResult = resolveDsl4ControlProfile(storyDocument, controlProfile, {
    historyNavigationAvailable,
  });
  if (!profileResult.ok) return profileResult;
  const profile = profileResult as unknown as ResolvedControlProfile;

  let historyReducer: HistoryReducer | null = null;
  let historyState: HistoryState | null = null;
  if (profile.historyEnabled) {
    if (
      !historyLimits ||
      !Number.isInteger(historyLimits.maxActionEntries) ||
      historyLimits.maxActionEntries < 1 ||
      !Number.isInteger(historyLimits.maxSceneVisits) ||
      historyLimits.maxSceneVisits < 1
    ) {
      return creationFailure(
        storyDocument,
        'K4-HISTORY-LIMIT-CONFIG-001',
        'History-enabled profiles require finite positive history limits',
      );
    }
    historyReducer = createDsl4HistoryReducer(historyLimits);
    historyState = historyReducer.initialState();
  }

  const resolvedAssetLifecycle = createAssetLifecycle ? createAssetLifecycle() : assetLifecycle;
  if (
    (createAssetLifecycle || resolvedAssetLifecycle !== undefined) &&
    (!resolvedAssetLifecycle ||
      typeof resolvedAssetLifecycle.prepare !== 'function' ||
      typeof resolvedAssetLifecycle.setLoading !== 'function' ||
      typeof resolvedAssetLifecycle.releaseAssets !== 'function' ||
      typeof resolvedAssetLifecycle.release !== 'function')
  ) {
    throw new TypeError(
      'asset lifecycle must provide prepare, setLoading, releaseAssets, and release methods',
    );
  }

  let disposed = false;
  let sessionDiagnostic: SessionDiagnostic | null = null;
  let controller: RuntimeController;

  function resetHistory() {
    if (historyReducer) historyState = historyReducer.initialState();
  }

  function handleRuntimeEvent(event: Readonly<Record<string, unknown>>) {
    if (
      historyReducer &&
      historyState &&
      (event.type === 'scene.enter' || event.type === 'action.commit')
    ) {
      const result = historyReducer.reduce(historyState, event);
      if (result.ok) {
        historyState = result.state;
      } else {
        const failure = historyFailure(result);
        sessionDiagnostic = diagnostic(
          storyDocument,
          failure.code,
          failure.message,
          failure.details,
        );
        controller?.stop('history-failure');
      }
    }
    onEvent?.(event);
  }

  const structuredDataIntegration = structuredDataIntegrationEnabled
    ? createDsl4KamishibaiStructuredDataSession({storyDocument})
    : null;
  try {
    controller = createDsl4RuntimeController({
      storyDocument,
      port,
      ...(debugExecution === undefined ? {} : {debugExecution}),
      ...(resolvedAssetLifecycle === undefined ? {} : {assetLifecycle: resolvedAssetLifecycle}),
      ...(evaluateCondition === undefined
        ? {}
        : {
            // The controller narrows the action context; the session holds the wider record type.
            evaluateCondition: evaluateCondition as unknown as (
              expression: string,
              variables: Readonly<Record<string, string | number | boolean>>,
              context: ActionContext,
            ) => boolean | Promise<boolean>,
          }),
      onEvent: (event: RuntimeEvent) =>
        handleRuntimeEvent(event as unknown as Readonly<Record<string, unknown>>),
      ...(structuredDataIntegration ? {structuredDataIntegration} : {}),
      posePreviewMirroringEnabled,
      cameraPreviewControlsEnabled,
      poseNavigationPolicyEnabled,
      speechAdvanceTypewriterEnabled,
      bubbleAdvanceIndicatorEnabled,
      turboWarpBubbleEnabled,
      turboWarpBubbleAdvancedPresentationEnabled,
      broadcastMessageAndWaitEnabled,
      storyVariableWriteEnabled,
      crossfadeTransitionsEnabled,
      ...(quiesceTimeoutMs === undefined ? {} : {quiesceTimeoutMs}),
      ...(scheduleQuiesceTimeout === undefined ? {} : {scheduleQuiesceTimeout}),
    });
  } catch (error) {
    structuredDataIntegration?.dispose();
    throw error;
  }

  function snapshot() {
    return deepFreeze({
      controlProfile: profile.profile,
      keymap: profile.keymap,
      canonicalKeymap: profile.canonicalKeymap,
      historyEnabled: profile.historyEnabled,
      runtime: controller.getState(),
      history: historyState,
      diagnostic: sessionDiagnostic,
      disposed,
    });
  }

  function commandFailure(code: string, message: string) {
    return deepFreeze({
      ok: false,
      changed: false,
      state: snapshot(),
      diagnostics: [diagnostic(storyDocument, code, message)],
    });
  }

  function dispatchCommand(command: string) {
    if (disposed) return commandFailure('K4-NAVIGATION-DISPOSED', 'Navigation session is disposed');
    if (!Object.values(profile.keymap).includes(command)) {
      return commandFailure(
        'K4-KEYMAP-COMMAND-INACTIVE',
        `Navigation command ${command} is not active in profile ${profile.profile}`,
      );
    }
    if (sessionDiagnostic) {
      return commandFailure(
        String(sessionDiagnostic.code),
        'Navigation session stopped after a history failure',
      );
    }

    if (command === 'navigation.nextAction') {
      if (historyReducer && historyState?.mode === 'history') {
        const result = historyReducer.reduce(historyState, {type: 'resume'});
        if (!result.ok) {
          const failure = historyFailure(result);
          return commandFailure(failure.code, failure.message);
        }
        historyState = result.state;
        void controller.resume(command);
      } else {
        if (poseNavigationPolicyEnabled && !controller.canAdvance(command)) {
          return deepFreeze({ok: true, changed: false, state: snapshot(), diagnostics: []});
        }
        void controller.advance(command);
      }
      return deepFreeze({ok: true, changed: true, state: snapshot(), diagnostics: []});
    }

    if (command === 'navigation.nextScene') {
      void controller.advanceScene(command);
      return deepFreeze({ok: true, changed: true, state: snapshot(), diagnostics: []});
    }

    if (
      command === 'rehearsal.skipPose' ||
      command === 'rehearsal.skipAction' ||
      command === 'rehearsal.skipScene'
    ) {
      if (!controller.canRehearsalSkip(command)) {
        return deepFreeze({ok: true, changed: false, state: snapshot(), diagnostics: []});
      }
      if (command === 'rehearsal.skipPose') void controller.skipPose();
      else if (command === 'rehearsal.skipAction') void controller.skipAction();
      else void controller.skipScene();
      return deepFreeze({ok: true, changed: true, state: snapshot(), diagnostics: []});
    }

    if (!historyReducer || !historyState) {
      return commandFailure(
        'K4-HISTORY-DISABLED',
        'History navigation is disabled for the selected profile',
      );
    }
    const result = historyReducer.reduce(historyState, {type: command});
    if (!result.ok) {
      const failure = historyFailure(result);
      return commandFailure(failure.code, failure.message);
    }
    historyState = result.state;
    if (!result.changed || !result.destination) {
      return deepFreeze({ok: true, changed: false, state: snapshot(), diagnostics: []});
    }
    controller.reposition(result.destination.sceneId, {
      actionIndex: result.destination.actionIndex,
      reason: command,
    });
    return deepFreeze({ok: true, changed: true, state: snapshot(), diagnostics: []});
  }

  const inputAdapter = createDsl4KeymapInputAdapter({
    keymap: profile.keymap,
    dispatchCommand,
    ...(arbitration
      ? {
          shouldDeferKey({code}) {
            return arbitration.shouldDeferNavigationKey({
              code,
              historyPaused: historyState?.mode === 'history',
            });
          },
        }
      : {}),
    ...(speechAdvanceTypewriterEnabled
      ? {
          consumeAnyKey({code}) {
            return controller.consumeAdvanceInput({kind: 'key', code});
          },
          consumePointer({pointerType}) {
            return controller.consumeAdvanceInput({kind: 'pointer', pointerType});
          },
          ...(arbitration
            ? {
                arbitratePointer({pointerType}) {
                  return arbitration.arbitrateNavigationPointer({
                    pointerType,
                    historyPaused: historyState?.mode === 'history',
                  });
                },
                cancelPointer({pointerType}) {
                  arbitration.cancelNavigationPointer({pointerType});
                },
              }
            : {}),
        }
      : {}),
    shouldConsumeCommand(command) {
      if (command.startsWith('rehearsal.')) return controller.canRehearsalSkip(command);
      if (
        poseNavigationPolicyEnabled &&
        command === 'navigation.nextAction' &&
        !(historyReducer && historyState?.mode === 'history')
      ) {
        return controller.canAdvance(command);
      }
      if (poseNavigationPolicyEnabled) return true;
      return undefined;
    },
    dispatchImmediately: true,
    ...(onInputError === undefined ? {} : {onError: onInputError}),
  });

  const actionsByPath = new Map(
    (storyDocument.scenes as ReadonlyArray<Readonly<Record<string, unknown>>>).flatMap((scene) =>
      (scene.actions as ReadonlyArray<Readonly<Record<string, unknown>>>).map((action) => [
        action.id,
        action,
      ]),
    ),
  );

  const session = Object.freeze({
    start(
      options: {
        sceneId?: string;
        actionIndex?: number;
        variables?: Readonly<Record<string, string | number | boolean>>;
      } = {},
    ) {
      if (disposed) return Promise.resolve(snapshot());
      sessionDiagnostic = null;
      resetHistory();
      return controller.start(options);
    },
    stop(reason = 'stop') {
      const state = controller.stop(reason);
      resetHistory();
      return state;
    },
    invokeAction(action: Readonly<Record<string, unknown>>) {
      if (disposed) {
        const error = new Error('Navigation session is disposed');
        Object.defineProperty(error, 'code', {value: 'K4-NAVIGATION-DISPOSED'});
        return Promise.reject(error);
      }
      if (sessionDiagnostic) {
        const error = new Error('Navigation session stopped after a history failure');
        Object.defineProperty(error, 'code', {value: String(sessionDiagnostic.code)});
        return Promise.reject(error);
      }
      return controller.invokeAction(action);
    },
    queueVariableWrite(request: unknown) {
      if (disposed) return deepFreeze({accepted: false, code: 'K4-VARIABLE-WRITE-INACTIVE'});
      if (sessionDiagnostic) {
        return deepFreeze({accepted: false, code: 'K4-VARIABLE-WRITE-INACTIVE'});
      }
      return controller.queueVariableWrite(request);
    },
    rejectActionInvocation(error: unknown) {
      if (disposed) return Promise.reject(new TypeError('Navigation session is disposed'));
      return controller.rejectActionInvocation(error);
    },
    dispatchCommand,
    attach: inputAdapter.attach,
    attachStagePointer: inputAdapter.attachPointer,
    detach: inputAdapter.detach,
    detachStagePointer: inputAdapter.detachPointer,
    handleKeyDown: inputAdapter.handleKeyDown,
    handlePointerUp: inputAdapter.handlePointerUp,
    handlePointerCancel: inputAdapter.handlePointerCancel,
    whenInputIdle: inputAdapter.whenIdle,
    getState: snapshot,
    getRunPromise: controller.getRunPromise,
    quiesce({candidateId}: {candidateId: number}) {
      const runtime = controller.getState();
      const action =
        typeof runtime.actionPath === 'string'
          ? (actionsByPath.get(runtime.actionPath) ?? null)
          : null;
      const mode = actionQuiesceMode(action);
      if (mode !== 'finish-only' && mode !== 'cancel-replay-safe') {
        return Promise.reject(new TypeError('resolveActionQuiesceMode returned an invalid mode'));
      }
      return controller.quiesce({candidateId, mode});
    },
    resumeQuiesce(candidateId: number) {
      return controller.resumeQuiesce(candidateId);
    },
    dispose() {
      if (disposed) return;
      inputAdapter.dispose();
      controller.dispose();
      resetHistory();
      disposed = true;
    },
  });

  return deepFreeze({ok: true, session, diagnostics: []});
}
