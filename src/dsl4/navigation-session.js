import {resolveDsl4ControlProfile} from './control-profile-resolver.js';
import {createDsl4ActionQuiesceResolver} from './action-quiesce.js';
import {createDsl4HistoryReducer} from './history-reducer.js';
import {createDsl4KamishibaiStructuredDataSession} from './kamishibai-structured-data.js';
import {createDsl4KeymapInputAdapter} from './keymap-input-adapter.js';
import {createDsl4RuntimeController} from './runtime-controller.js';
import {deepFreeze} from './story-document.js';

/**
 * @typedef {Readonly<{ok: true, profile: string, keymap: Readonly<Record<string, string>>, canonicalKeymap: string, historyEnabled: boolean, diagnostics: ReadonlyArray<never>}>} ResolvedControlProfile
 * @typedef {ReturnType<typeof createDsl4HistoryReducer>} HistoryReducer
 * @typedef {ReturnType<HistoryReducer['initialState']>} HistoryState
 * @typedef {ReturnType<typeof createDsl4RuntimeController>} RuntimeController
 * @typedef {ReturnType<typeof diagnostic>} SessionDiagnostic
 */

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 */
function diagnostic(storyDocument, code, message, details = {}) {
  const metadata = /** @type {Record<string, unknown>} */ (storyDocument.metadata ?? {});
  const sourceMap = /** @type {Record<string, unknown>} */ (storyDocument.sourceMap ?? {});
  return deepFreeze({
    version: 1,
    code,
    severity: 'error',
    message,
    sourceId: typeof metadata.sourceId === 'string' ? metadata.sourceId : 'main',
    range:
      sourceMap['/'] ??
      deepFreeze({
        start: {line: 1, column: 1, offset: 0},
        end: {line: 1, column: 1, offset: 0},
      }),
    related: [],
    details,
  });
}

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 */
function creationFailure(storyDocument, code, message, details = {}) {
  return deepFreeze({ok: false, diagnostics: [diagnostic(storyDocument, code, message, details)]});
}

/**
 * @param {unknown} result
 * @returns {{code: string, message: string, details: Record<string, unknown>}}
 */
function historyFailure(result) {
  return /** @type {{diagnostic: {code: string, message: string, details: Record<string, unknown>}}} */ (
    result
  ).diagnostic;
}

/**
 * @param {object} options
 * @param {Readonly<Record<string, unknown>>} options.storyDocument
 * @param {string} options.controlProfile
 * @param {boolean} [options.historyNavigationAvailable]
 * @param {{maxActionEntries: number, maxSceneVisits: number}} [options.historyLimits]
 * @param {Record<string, Function>} options.port
 * @param {{prepare: Function, setLoading: Function, releaseAssets: Function, release: Function}} [options.assetLifecycle]
 * @param {() => {prepare: Function, setLoading: Function, releaseAssets: Function, release: Function}} [options.createAssetLifecycle]
 * @param {(expression: string, variables: Readonly<Record<string, string | number | boolean>>, context: Record<string, unknown>) => boolean | Promise<boolean>} [options.evaluateCondition]
 * @param {(event: Readonly<Record<string, unknown>>) => void} [options.onEvent]
 * @param {(error: unknown, context: Readonly<{command: string, code: string}>) => unknown | Promise<unknown>} [options.onInputError]
 * @param {boolean} [options.structuredDataIntegrationEnabled]
 * @param {boolean} [options.posePreviewMirroringEnabled]
 * @param {boolean} [options.cameraPreviewControlsEnabled]
 * @param {(action: Readonly<Record<string, unknown>> | null) => 'finish-only' | 'cancel-replay-safe'} [options.resolveActionQuiesceMode]
 * @param {unknown} [options.actionRegistrySnapshot]
 * @param {number} [options.quiesceTimeoutMs]
 * @param {(callback: () => void, milliseconds: number) => (() => void)} [options.scheduleQuiesceTimeout]
 */
export function createDsl4NavigationSession({
  storyDocument,
  controlProfile,
  historyNavigationAvailable = false,
  historyLimits,
  port,
  assetLifecycle,
  createAssetLifecycle,
  evaluateCondition,
  onEvent,
  onInputError,
  structuredDataIntegrationEnabled = false,
  posePreviewMirroringEnabled = false,
  cameraPreviewControlsEnabled = false,
  resolveActionQuiesceMode,
  actionRegistrySnapshot,
  quiesceTimeoutMs,
  scheduleQuiesceTimeout,
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
  const profile = /** @type {ResolvedControlProfile} */ (/** @type {unknown} */ (profileResult));

  /** @type {HistoryReducer | null} */
  let historyReducer = null;
  /** @type {HistoryState | null} */
  let historyState = null;
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
  /** @type {SessionDiagnostic | null} */
  let sessionDiagnostic = null;
  /** @type {RuntimeController} */
  let controller;

  function resetHistory() {
    if (historyReducer) historyState = historyReducer.initialState();
  }

  /**
   * @param {Readonly<Record<string, unknown>>} event
   */
  function handleRuntimeEvent(event) {
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
      assetLifecycle: resolvedAssetLifecycle,
      evaluateCondition,
      onEvent: handleRuntimeEvent,
      structuredDataIntegration: structuredDataIntegration ?? undefined,
      posePreviewMirroringEnabled,
      cameraPreviewControlsEnabled,
      quiesceTimeoutMs,
      scheduleQuiesceTimeout,
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

  /**
   * @param {string} code
   * @param {string} message
   */
  function commandFailure(code, message) {
    return deepFreeze({
      ok: false,
      changed: false,
      state: snapshot(),
      diagnostics: [diagnostic(storyDocument, code, message)],
    });
  }

  /**
   * @param {string} command
   */
  function dispatchCommand(command) {
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
        void controller.advance(command);
      }
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
    onError: onInputError,
  });

  const actionsByPath = new Map(
    /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (storyDocument.scenes).flatMap(
      (scene) =>
        /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (scene.actions).map(
          (action) => [action.id, action],
        ),
    ),
  );

  const session = Object.freeze({
    /** @param {{sceneId?: string, actionIndex?: number, variables?: Readonly<Record<string, string | number | boolean>>}} [options] */
    start(options = {}) {
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
    dispatchCommand,
    attach: inputAdapter.attach,
    detach: inputAdapter.detach,
    handleKeyDown: inputAdapter.handleKeyDown,
    whenInputIdle: inputAdapter.whenIdle,
    getState: snapshot,
    getRunPromise: controller.getRunPromise,
    /** @param {{candidateId: number}} options */
    quiesce({candidateId}) {
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
    /** @param {number} candidateId */
    resumeQuiesce(candidateId) {
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
