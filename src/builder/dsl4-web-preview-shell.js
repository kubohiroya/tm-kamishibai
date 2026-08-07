import {createDsl4BrowserAssetReloadPipeline} from '../dsl4/browser-asset-reload-pipeline.js';
import {createDsl4BrowserPreviewCoordinator} from '../dsl4/browser-preview-coordinator.js';
import {resolveDsl4FeatureFlags} from '../dsl4/feature-flags.js';
import {deepFreeze} from '../dsl4/story-document.js';
import {createDsl4PreviewReloadSurface} from './dsl4-preview-reload-surface.js';
import {createDsl4DevelopmentPreviewShell} from './dsl4-preview-shell.js';

const optionKeys = new Set([
  'assetPipelineOptions',
  'capabilities',
  'createAssetPipeline',
  'createCoordinator',
  'createReloadSurface',
  'document',
  'environment',
  'featureFlags',
  'maxSourceBytes',
  'mount',
  'onError',
  'protocolSession',
  'previewFormatTime',
  'previewReducedMotion',
  'previewSafeArea',
  'previewStorage',
  'previewViewport',
  'sessionId',
  'sourceFrontend',
  'sourceOptions',
]);
const requiredEnabledKeys = new Set([
  'document',
  'environment',
  'maxSourceBytes',
  'mount',
  'protocolSession',
  'sessionId',
  'sourceFrontend',
]);
const restartChoiceNames = Object.freeze({
  1: 'storyStart',
  2: 'currentScene',
  3: 'currentAction',
});
const restartAnchorNames = Object.freeze({
  story: 'storyStart',
  scene: 'currentScene',
  action: 'currentAction',
});
const fallbackDiagnosticCodes = new Set([
  'K4-WEB-PREVIEW-INSECURE-CONTEXT',
  'K4-WEB-PREVIEW-PERMISSION-DENIED',
  'K4-WEB-PREVIEW-PERMISSION-REVOKED',
  'K4-WEB-PREVIEW-UNSUPPORTED',
]);
const missingDiagnosticCodes = new Set(['K4-SOURCE-MISSING', 'K4-WEB-PREVIEW-MANIFEST-MISSING']);

export const dsl4WebPreviewShellManifest = deepFreeze({
  formatVersion: 1,
  production: false,
  module: 'src/builder/dsl4-web-preview-shell.js',
  featureFlags: [
    'dsl4Runtime',
    'dsl4AppShell',
    'dsl4WebPreviewAdapter',
    'dsl4WebPreviewAssetLiveReload',
    'dsl4PreviewReloadOverlay',
  ],
  fallbackCommands: ['tmpose-kamishibai validate-dsl4', 'tmpose-kamishibai build-dsl4'],
});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name */
function requireElement(value, name) {
  if (!isRecord(value) || typeof value.appendChild !== 'function') {
    throw new TypeError(`${name} must be a DOM element`);
  }
  return /** @type {any} */ (value);
}

/** @param {unknown} value */
function requireDocument(value) {
  if (!isRecord(value) || typeof value.createElement !== 'function') {
    throw new TypeError('document must provide the DOM document contract');
  }
  return /** @type {any} */ (value);
}

/** @param {Record<string, any>} document @param {string} tag @param {string} [text] */
function element(document, tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @param {unknown} value */
function safeMessage(value) {
  const message = String(value ?? 'Web Preview status changed')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .trim();
  return (message || 'Web Preview status changed').slice(0, 500);
}

/** @param {unknown} value */
function warningCount(value) {
  if (!Array.isArray(value)) return 0;
  return value.filter((diagnostic) => isRecord(diagnostic) && diagnostic.severity === 'warning')
    .length;
}

/** @param {unknown} value */
function collectionSize(value) {
  if (Array.isArray(value)) return value.length;
  return isRecord(value) ? Object.keys(value).length : 0;
}

/** @param {unknown} result */
function sourceDetails(result) {
  if (!isRecord(result)) return null;
  const snapshot = isRecord(result.sourceSnapshot) ? result.sourceSnapshot : null;
  const storyDocument = isRecord(result.storyDocument) ? result.storyDocument : null;
  if (!snapshot || typeof snapshot.integrity !== 'string' || !storyDocument) return null;
  const scenes = Array.isArray(storyDocument.scenes) ? storyDocument.scenes : [];
  return deepFreeze({
    integrity: snapshot.integrity,
    sourceDisplayName:
      typeof snapshot.displayName === 'string' ? snapshot.displayName : 'story.kamishibai.yaml',
    counts: {
      scenes: scenes.length,
      actions: scenes.reduce(
        (total, scene) =>
          total + (isRecord(scene) && Array.isArray(scene.actions) ? scene.actions.length : 0),
        0,
      ),
      assets: Math.max(
        collectionSize(storyDocument.assets),
        collectionSize(storyDocument.assetReferences),
      ),
    },
    warningCount: warningCount(result.diagnostics),
  });
}

/** @param {unknown} value @param {boolean} requireRestart */
function validateCoordinator(value, requireRestart) {
  if (
    !isRecord(value) ||
    typeof value.openProject !== 'function' ||
    typeof value.start !== 'function' ||
    typeof value.pollNow !== 'function' ||
    typeof value.commit !== 'function' ||
    typeof value.defer !== 'function' ||
    typeof value.dispose !== 'function' ||
    typeof value.getState !== 'function' ||
    typeof value.whenIdle !== 'function' ||
    (requireRestart && typeof value.restart !== 'function')
  ) {
    throw new TypeError('browser preview coordinator does not implement the required contract');
  }
  return /** @type {Record<string, Function>} */ (value);
}

/** @param {unknown} value */
function validateAssetPipeline(value) {
  if (
    !isRecord(value) ||
    typeof value.start !== 'function' ||
    typeof value.updateSource !== 'function' ||
    typeof value.pollNow !== 'function' ||
    typeof value.dispose !== 'function' ||
    typeof value.getState !== 'function' ||
    typeof value.whenIdle !== 'function'
  ) {
    throw new TypeError('browser asset pipeline does not implement the required contract');
  }
  return /** @type {Record<string, Function>} */ (value);
}

/** @param {unknown} value */
function restartChoice(value) {
  if (typeof value !== 'string' || !Object.hasOwn(restartAnchorNames, value)) {
    throw new TypeError('preview reload anchor is invalid');
  }
  return restartAnchorNames[/** @type {'story' | 'scene' | 'action'} */ (value)];
}

/** @param {unknown} value */
function validateReloadSurface(value) {
  if (
    !isRecord(value) ||
    typeof value.submitCandidate !== 'function' ||
    typeof value.setDiagnostic !== 'function' ||
    typeof value.setWatchState !== 'function' ||
    typeof value.acknowledgePreviewInput !== 'function' ||
    typeof value.registerReservedRect !== 'function' ||
    typeof value.updateReservedRect !== 'function' ||
    typeof value.unregisterReservedRect !== 'function' ||
    typeof value.updateViewport !== 'function' ||
    typeof value.dispose !== 'function' ||
    typeof value.getSnapshot !== 'function' ||
    typeof value.whenIdle !== 'function'
  ) {
    throw new TypeError('preview reload surface does not implement the required contract');
  }
  return /** @type {Record<string, Function>} */ (value);
}

/** @param {unknown} value */
function validateAssetPipelineOptions(value) {
  if (!isRecord(value)) throw new TypeError('assetPipelineOptions must be an object');
  if (
    typeof value.structuralFingerprint !== 'string' ||
    !/^sha256-[A-Za-z0-9+/]{43}=$/u.test(value.structuralFingerprint)
  ) {
    throw new TypeError('assetPipelineOptions.structuralFingerprint must be canonical SHA-256 SRI');
  }
  if (!isRecord(value.adapterOptions) || typeof value.prepareGeneration !== 'function') {
    throw new TypeError('assetPipelineOptions must provide adapterOptions and prepareGeneration');
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value @param {Readonly<Record<string, number>>} fallback */
function geometry(value, fallback) {
  return isRecord(value) ? value : fallback;
}

/** @param {unknown} value */
function reloadAvailability(value) {
  if (!isRecord(value)) throw new TypeError('preview reload choices are invalid');
  /** @param {unknown} choice @param {string} fallbackReason */
  function available(choice, fallbackReason) {
    if (!isRecord(choice) || typeof choice.enabled !== 'boolean') {
      throw new TypeError('preview reload choice is invalid');
    }
    return {
      available: choice.enabled,
      reason:
        choice.enabled === true
          ? null
          : safeMessage(
              typeof choice.reason === 'string' && choice.reason.length > 0
                ? choice.reason
                : fallbackReason,
            ).slice(0, 300),
    };
  }
  const story = available(value.storyStart, 'The story restart anchor is unavailable.');
  if (!story.available) throw new TypeError('story reload anchor must always be available');
  const scene = available(value.currentScene, 'The current scene is unavailable.');
  const action = available(value.currentAction, 'The current action is unavailable.');
  return deepFreeze({
    story,
    scene,
    action: {...action, replaySafe: action.available},
  });
}

/**
 * Mount the development-only browser project picker and connect it to the reload shell.
 *
 * @param {unknown} input
 */
export function createDsl4WebPreviewShell(input = {}) {
  if (!isRecord(input)) throw new TypeError('web preview shell options must be an object');
  const unknown = Object.keys(input).filter((key) => !optionKeys.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown web preview shell option: ${unknown.sort().join(', ')}`);
  }
  const featureFlags = resolveDsl4FeatureFlags(input.featureFlags);
  if (!featureFlags.dsl4WebPreviewAdapter) {
    const snapshot = deepFreeze({version: 1, enabled: false, disposed: false, featureFlags});
    return Object.freeze({
      enabled: false,
      element: null,
      featureFlags,
      getSnapshot: () => snapshot,
      dispose: () => snapshot,
    });
  }

  const missing = [...requiredEnabledKeys].filter((key) => !Object.hasOwn(input, key));
  if (missing.length > 0) {
    throw new TypeError(`Web Preview requires options: ${missing.sort().join(', ')}`);
  }
  if (input.environment !== 'development') {
    throw new TypeError('Web Preview shell is available only in the development environment');
  }
  const document = requireDocument(input.document);
  const mount = requireElement(input.mount, 'mount');
  if (input.onError !== undefined && typeof input.onError !== 'function') {
    throw new TypeError('onError must be a function');
  }
  const errorObserver = /** @type {Function | undefined} */ (input.onError);
  const createCoordinator = input.createCoordinator ?? createDsl4BrowserPreviewCoordinator;
  if (typeof createCoordinator !== 'function') {
    throw new TypeError('createCoordinator must be a function');
  }
  const assetPipelineOptions = featureFlags.dsl4WebPreviewAssetLiveReload
    ? validateAssetPipelineOptions(input.assetPipelineOptions)
    : null;
  const createAssetPipeline = featureFlags.dsl4WebPreviewAssetLiveReload
    ? (input.createAssetPipeline ?? createDsl4BrowserAssetReloadPipeline)
    : null;
  if (createAssetPipeline !== null && typeof createAssetPipeline !== 'function') {
    throw new TypeError('createAssetPipeline must be a function');
  }
  const createReloadSurface = featureFlags.dsl4PreviewReloadOverlay
    ? (input.createReloadSurface ?? createDsl4PreviewReloadSurface)
    : null;
  if (createReloadSurface !== null && typeof createReloadSurface !== 'function') {
    throw new TypeError('createReloadSurface must be a function');
  }

  const host = element(document, 'section');
  host.id = 'dsl4-web-preview-shell';
  host.setAttribute('data-dsl4-development-only', 'true');
  host.setAttribute('aria-labelledby', 'dsl4-web-preview-title');
  const title = element(document, 'h1', 'DSL 4.0 Web Preview');
  title.id = 'dsl4-web-preview-title';
  const introduction = element(
    document,
    'p',
    'Select a project directory to validate and reload its DSL 4.0 source.',
  );
  const openButton = element(document, 'button', 'Open project directory');
  openButton.id = 'dsl4-web-preview-open-project';
  openButton.type = 'button';
  const watchStatus = element(document, 'p', 'Web Preview is idle.');
  watchStatus.id = 'dsl4-web-preview-watch-status';
  watchStatus.setAttribute('role', 'status');
  watchStatus.setAttribute('aria-live', 'polite');
  const diagnosticStatus = element(document, 'p');
  diagnosticStatus.id = 'dsl4-web-preview-diagnostic';
  diagnosticStatus.setAttribute('role', 'alert');
  diagnosticStatus.setAttribute('aria-live', 'assertive');
  const fallback = element(
    document,
    'p',
    'Browser folder access is unavailable. Use `tmpose-kamishibai validate-dsl4` and `tmpose-kamishibai build-dsl4` from a terminal.',
  );
  fallback.id = 'dsl4-web-preview-fallback';
  fallback.hidden = true;
  const reloadMount = element(document, 'div');
  reloadMount.id = 'dsl4-web-preview-reload-mount';
  host.appendChild(title);
  host.appendChild(introduction);
  host.appendChild(openButton);
  host.appendChild(watchStatus);
  host.appendChild(diagnosticStatus);
  host.appendChild(fallback);
  host.appendChild(reloadMount);
  mount.appendChild(host);

  let disposed = false;
  /** @type {string | null} */
  let diagnosticCode = null;
  let sourceDisplayName = 'story.kamishibai.yaml';
  /** @type {Readonly<Record<string, any>> | null} */
  let activeDetails = null;
  /** @type {Readonly<Record<string, any>> | null} */
  let candidateDetails = null;
  /** @type {Promise<unknown> | null} */
  let disposePromise = null;
  const detailsByIntegrity = new Map();
  /** @type {Record<string, any> | null} */
  let selectedProjectRoot = null;
  /** @type {Readonly<Record<string, any>> | null} */
  let latestValidSourceResult = null;
  /** @type {Record<string, Function> | null} */
  let assetPipeline = null;
  let assetPipelineStarted = false;
  let assetSourceQueue = Promise.resolve();
  /** @type {Record<string, Function> | null} */
  let reloadSurface = null;
  let manualRestartDepth = 0;

  /** @param {unknown} error */
  function reportError(error) {
    diagnosticStatus.textContent = safeMessage(
      isRecord(error) && typeof error.message === 'string' ? error.message : error,
    );
    try {
      errorObserver?.(error);
    } catch {
      // Error observers cannot change Web Preview state.
    }
  }

  /** @param {Promise<unknown> | unknown} operation */
  function observe(operation) {
    Promise.resolve(operation).catch(reportError);
  }

  /** @param {string} name @param {...unknown} values */
  async function notifyAssetObserver(name, ...values) {
    const observer = assetPipelineOptions?.[name];
    if (typeof observer !== 'function') return;
    try {
      await observer(...values);
    } catch (error) {
      reportError(error);
    }
  }

  /** @param {Readonly<Record<string, any>>} result */
  function queueAssetSource(result) {
    if (!assetPipeline || !assetPipelineOptions || !selectedProjectRoot || disposed) return;
    const context = {
      sourceResult: result,
      structuralFingerprint: assetPipelineOptions.structuralFingerprint,
    };
    assetSourceQueue = assetSourceQueue.then(async () => {
      if (disposed || !assetPipeline) return;
      if (assetPipelineStarted) await assetPipeline.updateSource(context);
      else {
        assetPipelineStarted = true;
        await assetPipeline.start(selectedProjectRoot, context);
      }
    });
    observe(assetSourceQueue);
  }

  /** @param {Readonly<Record<string, any>>} projectRoot */
  function setProjectRoot(projectRoot) {
    selectedProjectRoot = projectRoot;
    if (latestValidSourceResult) queueAssetSource(latestValidSourceResult);
  }

  /** @param {Readonly<Record<string, any>>} view */
  function render(view) {
    if (disposed) return;
    try {
      previewShell.update(view);
    } catch (error) {
      reportError(error);
    }
  }

  /** @param {Record<string, any>} diagnostic */
  function renderDiagnostic(diagnostic) {
    diagnosticCode = typeof diagnostic.code === 'string' ? diagnostic.code : null;
    const message = safeMessage(
      diagnosticCode
        ? `${diagnosticCode}: ${String(diagnostic.message ?? 'Web Preview failed')}`
        : diagnostic.message,
    );
    diagnosticStatus.textContent = message;
    if (reloadSurface) observe(reloadSurface.setDiagnostic('source', diagnostic));
    fallback.hidden = !diagnosticCode || !fallbackDiagnosticCodes.has(diagnosticCode);
    if (diagnostic.severity !== 'error') return;
    const currentIntegrity = coordinator?.getState()?.protocol?.current?.integrity ?? null;
    render({
      formatVersion: 1,
      phase: 'invalid',
      sourceDisplayName,
      currentIntegrity,
      candidateIntegrity: null,
      validationStatus:
        diagnosticCode && missingDiagnosticCodes.has(diagnosticCode) ? 'missing' : 'invalid',
      counts: null,
      anchor: null,
      choices: null,
      warningCount: diagnostic.severity === 'warning' ? 1 : 0,
      changeCategories: [],
      safeStatusMessage: message,
    });
  }

  /** @param {Readonly<Record<string, any>>} event */
  function onProtocolEvent(event) {
    if (disposed) return;
    if (event.type === 'preview.handshake.ack') {
      watchStatus.textContent = 'Preview protocol connected. Select a project directory.';
      return;
    }
    if (event.type === 'preview.source.staged') {
      const diagnostics = Array.isArray(event.diagnostics) ? event.diagnostics : [];
      const blocking = diagnostics.find(
        (diagnostic) => isRecord(diagnostic) && diagnostic.severity === 'error',
      );
      if (blocking) {
        renderDiagnostic(/** @type {Record<string, any>} */ (blocking));
        return;
      }
      const details = detailsByIntegrity.get(event.sourceIntegrity) ?? null;
      if (!details) return;
      sourceDisplayName = details.sourceDisplayName;
      diagnosticCode = null;
      diagnosticStatus.textContent = '';
      fallback.hidden = true;
      if (reloadSurface) observe(reloadSurface.setDiagnostic('source', null));
      if (event.candidate) {
        candidateDetails = details;
        const choices = event.candidate.options;
        if (reloadSurface) {
          if (manualRestartDepth === 0) {
            observe(
              reloadSurface.submitCandidate({
                channel: 'source',
                channelRevision: event.revision,
                availability: reloadAvailability(choices),
                changedIds: ['source-generation'],
                initiatingInputId: null,
                async apply(/** @type {Readonly<Record<string, any>>} */ request) {
                  const choice = restartChoice(request.actualAnchor);
                  await coordinator.commit(choice);
                },
                async restart(/** @type {Readonly<Record<string, any>>} */ request) {
                  const choice = restartChoice(request.actualAnchor);
                  manualRestartDepth += 1;
                  try {
                    await coordinator.restart(choice);
                  } finally {
                    manualRestartDepth -= 1;
                  }
                },
              }),
            );
          }
          return;
        }
        render({
          formatVersion: 1,
          phase: 'candidate',
          sourceDisplayName,
          currentIntegrity: event.current?.integrity ?? null,
          candidateIntegrity: details.integrity,
          validationStatus: 'valid',
          counts: details.counts,
          anchor: null,
          choices: {
            1: choices.storyStart,
            2: choices.currentScene,
            3: choices.currentAction,
          },
          warningCount: details.warningCount,
          changeCategories: ['source'],
          safeStatusMessage: 'A valid source change is ready. Choose where to restart.',
        });
        return;
      }
      if (event.current?.integrity) {
        activeDetails = details;
        candidateDetails = null;
        render({
          formatVersion: 1,
          phase: 'running',
          sourceDisplayName,
          currentIntegrity: event.current.integrity,
          candidateIntegrity: null,
          validationStatus: 'valid',
          counts: details.counts,
          anchor: null,
          choices: null,
          warningCount: details.warningCount,
          changeCategories: [],
          safeStatusMessage: 'The current immutable source is running.',
        });
      }
      return;
    }
    if (event.type === 'preview.source.committed') {
      activeDetails = candidateDetails ?? activeDetails;
      candidateDetails = null;
      if (!activeDetails || !event.current?.integrity) return;
      render({
        formatVersion: 1,
        phase: 'running',
        sourceDisplayName: activeDetails.sourceDisplayName,
        currentIntegrity: event.current.integrity,
        candidateIntegrity: null,
        validationStatus: 'valid',
        counts: activeDetails.counts,
        anchor: null,
        choices: null,
        warningCount: activeDetails.warningCount,
        changeCategories: [],
        safeStatusMessage: 'The selected source revision is running.',
      });
      return;
    }
    if (event.type === 'preview.source.deferred') {
      candidateDetails = null;
      if (!activeDetails || !event.current?.integrity) return;
      render({
        formatVersion: 1,
        phase: 'running',
        sourceDisplayName: activeDetails.sourceDisplayName,
        currentIntegrity: event.current.integrity,
        candidateIntegrity: null,
        validationStatus: 'valid',
        counts: activeDetails.counts,
        anchor: null,
        choices: null,
        warningCount: activeDetails.warningCount,
        changeCategories: [],
        safeStatusMessage: 'The changed source was deferred; the current run continues.',
      });
    }
  }

  /** @param {Readonly<Record<string, any>>} state */
  function onSourceStatus(state) {
    if (disposed) return;
    /** @type {Readonly<Record<string, string>>} */
    const statusLabels = {
      idle: 'Web Preview is idle.',
      selecting: 'Waiting for project directory selection…',
      'loading-manifest': 'Reading the project source manifest…',
      stabilizing: 'Waiting for a stable source snapshot…',
      'watching-visible': 'Watching the selected project for changes.',
      'background-throttled': 'Preview is in the background; polling is throttled.',
      diagnostic: 'Web Preview needs attention. See the diagnostic below.',
      disposed: 'Web Preview stopped.',
    };
    watchStatus.textContent = statusLabels[state.status] ?? 'Web Preview status changed.';
    if (reloadSurface) {
      const reloadWatchState = /** @type {Readonly<Record<string, string>>} */ ({
        stabilizing: 'stabilizing',
        'watching-visible': 'watching',
        'background-throttled': 'paused',
        disposed: 'disconnected',
      })[state.status];
      if (reloadWatchState) observe(reloadSurface.setWatchState('source', reloadWatchState));
    }
    if (typeof state.sourceDisplayName === 'string') sourceDisplayName = state.sourceDisplayName;
    openButton.disabled = state.started === true || state.status === 'selecting';
  }

  const previewShell = createDsl4DevelopmentPreviewShell({
    environment: 'development',
    document,
    mount: reloadMount,
    onReloadChoice(/** @type {number} */ choice) {
      const name = restartChoiceNames[/** @type {1 | 2 | 3} */ (choice)];
      if (name) observe(coordinator.commit(name));
    },
    onDefer() {
      observe(coordinator.defer());
    },
    onError: reportError,
  });

  if (createAssetPipeline && assetPipelineOptions) {
    try {
      assetPipeline = validateAssetPipeline(
        createAssetPipeline({
          ...assetPipelineOptions,
          sessionId: input.sessionId,
          onEvent: (/** @type {Readonly<Record<string, unknown>>} */ event) =>
            notifyAssetObserver('onEvent', event),
          onDiagnostic: async (
            /** @type {Readonly<Record<string, unknown>> | null} */ diagnostic,
          ) => {
            await notifyAssetObserver('onDiagnostic', diagnostic);
            if (disposed) return;
            if (diagnostic === null) {
              if (diagnosticCode?.startsWith('K4-ASSET-')) {
                diagnosticCode = null;
                diagnosticStatus.textContent = '';
              }
              return;
            }
            renderDiagnostic(/** @type {Record<string, any>} */ (diagnostic));
          },
          onWatchStatus: (/** @type {Readonly<Record<string, unknown>>} */ state) =>
            notifyAssetObserver('onWatchStatus', state),
          onError: (/** @type {unknown} */ error) => {
            void notifyAssetObserver('onError', error);
            reportError(error);
          },
        }),
      );
    } catch (error) {
      previewShell.dispose();
      if (typeof host.remove === 'function') host.remove();
      throw error;
    }
  }

  /** @type {Record<string, Function>} */
  let coordinator;
  try {
    coordinator = validateCoordinator(
      createCoordinator({
        protocolSession: input.protocolSession,
        sessionId: input.sessionId,
        sourceFrontend: input.sourceFrontend,
        maxSourceBytes: input.maxSourceBytes,
        capabilities: input.capabilities,
        sourceOptions: input.sourceOptions,
        onProjectRoot: setProjectRoot,
        onSourceResult(/** @type {Readonly<Record<string, unknown>>} */ result) {
          const details = sourceDetails(result);
          if (details) detailsByIntegrity.set(details.integrity, details);
          if (result.ok === true) {
            latestValidSourceResult = /** @type {Readonly<Record<string, any>>} */ (result);
            queueAssetSource(latestValidSourceResult);
          }
        },
        onProtocolEvent,
        onSourceStatus,
        onSourceDiagnostic(/** @type {Readonly<Record<string, unknown>> | null} */ diagnostic) {
          if (disposed) return;
          if (diagnostic === null) {
            diagnosticCode = null;
            diagnosticStatus.textContent = '';
            fallback.hidden = true;
            if (reloadSurface) observe(reloadSurface.setDiagnostic('source', null));
            return;
          }
          renderDiagnostic(/** @type {Record<string, any>} */ (diagnostic));
        },
        onError: reportError,
      }),
      featureFlags.dsl4PreviewReloadOverlay,
    );
  } catch (error) {
    previewShell.dispose();
    if (typeof host.remove === 'function') host.remove();
    throw error;
  }

  if (featureFlags.dsl4PreviewReloadOverlay) {
    try {
      reloadSurface = validateReloadSurface(
        createReloadSurface({
          surface: 'web',
          environment: 'development',
          document,
          mount: host,
          viewport: geometry(input.previewViewport, {
            width: Math.max(44, Number(mount.clientWidth) || 800),
            height: Math.max(44, Number(mount.clientHeight) || 600),
          }),
          safeArea: geometry(input.previewSafeArea, {top: 0, right: 0, bottom: 0, left: 0}),
          storage: input.previewStorage,
          reducedMotion: input.previewReducedMotion,
          formatTime: input.previewFormatTime,
          onError: reportError,
        }),
      );
    } catch (error) {
      previewShell.dispose();
      observe(coordinator.dispose());
      if (typeof host.remove === 'function') host.remove();
      throw error;
    }
  }

  function openProject() {
    if (disposed) throw new TypeError('Web Preview shell is disposed');
    openButton.disabled = true;
    try {
      const operation = coordinator.openProject();
      return Promise.resolve(operation).finally(() => {
        if (!disposed) openButton.disabled = coordinator.getState().source.started === true;
      });
    } catch (error) {
      openButton.disabled = false;
      throw error;
    }
  }

  function onOpenProject() {
    try {
      observe(openProject());
    } catch (error) {
      reportError(error);
    }
  }
  openButton.addEventListener('click', onOpenProject);

  function snapshot() {
    return deepFreeze({
      version: 1,
      enabled: true,
      disposed,
      featureFlags,
      diagnosticCode,
      sourceDisplayName,
      preview: previewShell.getSnapshot(),
      assetPipeline: assetPipeline?.getState() ?? null,
      reloadOverlay: reloadSurface?.getSnapshot() ?? null,
      coordinator: coordinator.getState(),
    });
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    if (disposed) return Promise.resolve(snapshot());
    disposed = true;
    if (typeof openButton.removeEventListener === 'function') {
      openButton.removeEventListener('click', onOpenProject);
    }
    previewShell.dispose();
    const reloadDisposal = reloadSurface?.dispose();
    if (typeof host.remove === 'function') host.remove();
    detailsByIntegrity.clear();
    activeDetails = null;
    candidateDetails = null;
    selectedProjectRoot = null;
    latestValidSourceResult = null;
    const assetDisposal = assetPipeline?.dispose();
    assetPipeline = null;
    reloadSurface = null;
    disposePromise = Promise.all([coordinator.dispose(), assetDisposal, reloadDisposal]).then(
      snapshot,
    );
    return disposePromise;
  }

  return Object.freeze({
    enabled: true,
    element: host,
    featureFlags,
    openProject,
    /** @param {unknown} projectRoot */
    start(projectRoot) {
      if (disposed) throw new TypeError('Web Preview shell is disposed');
      openButton.disabled = true;
      if (assetPipeline) setProjectRoot(/** @type {Record<string, any>} */ (projectRoot));
      return coordinator.start(projectRoot);
    },
    async pollNow() {
      await coordinator.pollNow();
      await assetSourceQueue;
      if (assetPipelineStarted && assetPipeline) await assetPipeline.pollNow();
      return snapshot();
    },
    async whenIdle() {
      await coordinator.whenIdle();
      await assetSourceQueue;
      if (assetPipelineStarted && assetPipeline) await assetPipeline.whenIdle();
      await reloadSurface?.whenIdle();
      return snapshot();
    },
    /** @param {unknown} candidate */
    submitReloadCandidate(candidate) {
      if (!reloadSurface) throw new TypeError('preview reload overlay is disabled');
      return reloadSurface.submitCandidate(candidate);
    },
    /** @param {'source' | 'asset'} channel @param {unknown} diagnostic */
    setReloadDiagnostic(channel, diagnostic) {
      if (!reloadSurface) throw new TypeError('preview reload overlay is disabled');
      return reloadSurface.setDiagnostic(channel, diagnostic);
    },
    /** @param {'source' | 'asset'} channel @param {unknown} status */
    setReloadWatchState(channel, status) {
      if (!reloadSurface) throw new TypeError('preview reload overlay is disabled');
      return reloadSurface.setWatchState(channel, status);
    },
    /** @param {string} inputId */
    acknowledgePreviewInput(inputId) {
      return reloadSurface?.acknowledgePreviewInput(inputId) ?? snapshot();
    },
    /** @param {string} owner @param {unknown} rect */
    registerPreviewControlRect(owner, rect) {
      if (!reloadSurface) throw new TypeError('preview reload overlay is disabled');
      return reloadSurface.registerReservedRect(owner, rect);
    },
    /** @param {string} owner @param {unknown} rect */
    updatePreviewControlRect(owner, rect) {
      if (!reloadSurface) throw new TypeError('preview reload overlay is disabled');
      return reloadSurface.updateReservedRect(owner, rect);
    },
    /** @param {string} owner */
    unregisterPreviewControlRect(owner) {
      if (!reloadSurface) throw new TypeError('preview reload overlay is disabled');
      return reloadSurface.unregisterReservedRect(owner);
    },
    /** @param {unknown} viewport @param {unknown} [safeArea] */
    updatePreviewViewport(viewport, safeArea) {
      if (!reloadSurface) throw new TypeError('preview reload overlay is disabled');
      return reloadSurface.updateViewport(viewport, safeArea);
    },
    getSnapshot: snapshot,
    dispose,
  });
}
