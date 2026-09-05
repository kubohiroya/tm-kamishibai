import type {Dsl4PreviewReloadSurface} from '../dsl4/preview-reload-surface-contract.js';
import {createDsl4BrowserAssetReloadPipeline} from '../dsl4/browser-asset-reload-pipeline.js';
import {createDsl4BrowserPreviewCoordinator} from '../dsl4/browser-preview-coordinator.js';
import {createDsl4DiagnosticUiProjection} from '../dsl4/diagnostic-projection.js';
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
  'debugExecution',
  'environment',
  'featureFlags',
  'maxSourceBytes',
  'maxSourceFiles',
  'maxTotalSourceBytes',
  'maxIncludeDepth',
  'mount',
  'onError',
  'onDiagnostic',
  'onDistributionBuildState',
  'onProjectRoot',
  'prepareSourceResult',
  'protocolSession',
  'previewFormatTime',
  'previewReducedMotion',
  'previewSafeArea',
  'previewStorage',
  'previewViewport',
  'presentation',
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
    'dsl4SourceIncludes',
    'dsl4AppShell',
    'dsl4WebPreviewAdapter',
    'dsl4BrowserDistributionBuild',
    'dsl4WebPreviewAssetLiveReload',
    'dsl4PreviewReloadOverlay',
    'dsl4Debugger',
  ],
  fallbackCommands: [
    'tm-kamishibai preview-dsl4 --watch',
    'tm-kamishibai validate-dsl4',
    'tm-kamishibai build-dsl4',
  ],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireElement(value: unknown, name: string) {
  if (!isRecord(value) || typeof value.appendChild !== 'function') {
    throw new TypeError(`${name} must be a DOM element`);
  }
  return value as any;
}

function requireDocument(value: unknown) {
  if (!isRecord(value) || typeof value.createElement !== 'function') {
    throw new TypeError('document must provide the DOM document contract');
  }
  return value as any;
}

function element(document: Record<string, any>, tag: string, text?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function safeMessage(value: unknown) {
  const message = String(value ?? 'Web Preview status changed')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .trim();
  return (message || 'Web Preview status changed').slice(0, 500);
}

function warningCount(value: unknown) {
  if (!Array.isArray(value)) return 0;
  return value.filter((diagnostic) => isRecord(diagnostic) && diagnostic.severity === 'warning')
    .length;
}

function collectionSize(value: unknown) {
  if (Array.isArray(value)) return value.length;
  return isRecord(value) ? Object.keys(value).length : 0;
}

function reloadDiagnostic(diagnostic: Readonly<Record<string, any>>) {
  return deepFreeze(
    Object.fromEntries(
      [
        'formatVersion',
        'version',
        'code',
        'severity',
        'message',
        'sourceId',
        'range',
        'storyPath',
        'path',
        'related',
      ]
        .filter((key) => Object.hasOwn(diagnostic, key))
        .map((key) => [key, diagnostic[key]]),
    ),
  );
}

function sourceDetails(result: unknown) {
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

/**
 * The collaborators the shell drives, named rather than indexed.
 *
 * Each interface lists exactly the members the validator below checks for and the shell calls. An
 * index signature would leave every one possibly undefined and say nothing about its arguments.
 */
interface PreviewCoordinatorSurface {
  openProject(handle?: unknown): unknown;
  start(projectRoot: unknown, context?: unknown): unknown;
  restart(anchor: unknown, context?: unknown): unknown;
  pollNow(): unknown;
  commit(choice: unknown, context?: unknown): unknown;
  defer(): unknown;
  dispose(): unknown;
  getState(): Readonly<Record<string, any>>;
  whenIdle(): Promise<unknown>;
}

interface PreviewAssetPipelineSurface {
  start(projectRoot: unknown, context?: unknown): unknown;
  updateSource(context: unknown): unknown;
  pollNow(): unknown;
  dispose(): unknown;
  getState(): Readonly<Record<string, any>>;
  whenIdle(): Promise<unknown>;
}

function validateCoordinator(value: unknown, requireRestart: boolean) {
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
  return value as unknown as PreviewCoordinatorSurface;
}

function validateAssetPipeline(value: unknown) {
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
  return value as unknown as PreviewAssetPipelineSurface;
}

function restartChoice(value: unknown) {
  if (typeof value !== 'string' || !Object.hasOwn(restartAnchorNames, value)) {
    throw new TypeError('preview reload anchor is invalid');
  }
  return restartAnchorNames[value as 'story' | 'scene' | 'action'];
}

function validateReloadSurface(value: unknown) {
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
  return value as unknown as Dsl4PreviewReloadSurface;
}

function validateAssetPipelineOptions(value: unknown, requireRestart: boolean) {
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
  if (requireRestart && typeof value.restartGeneration !== 'function') {
    throw new TypeError(
      'assetPipelineOptions.restartGeneration is required with the shared reload overlay',
    );
  }
  return value as Record<string, any>;
}

function geometry(value: unknown, fallback: Readonly<Record<string, number>>) {
  return isRecord(value) ? value : fallback;
}

function reloadAvailability(value: unknown) {
  if (!isRecord(value)) throw new TypeError('preview reload choices are invalid');
  function available(choice: unknown, fallbackReason: string) {
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

/** Mount the development-only browser project picker and connect it to the reload shell. */
export function createDsl4WebPreviewShell(input: unknown = {}) {
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
  const presentation = input.presentation ?? 'full';
  if (!['full', 'runtime'].includes(String(presentation))) {
    throw new TypeError('Web Preview presentation must be full or runtime');
  }
  if (input.onError !== undefined && typeof input.onError !== 'function') {
    throw new TypeError('onError must be a function');
  }
  if (input.onDiagnostic !== undefined && typeof input.onDiagnostic !== 'function') {
    throw new TypeError('onDiagnostic must be a function');
  }
  if (
    input.onDistributionBuildState !== undefined &&
    typeof input.onDistributionBuildState !== 'function'
  ) {
    throw new TypeError('onDistributionBuildState must be a function');
  }
  if (input.onProjectRoot !== undefined && typeof input.onProjectRoot !== 'function') {
    throw new TypeError('onProjectRoot must be a function');
  }
  if (input.prepareSourceResult !== undefined && typeof input.prepareSourceResult !== 'function') {
    throw new TypeError('prepareSourceResult must be a function');
  }
  if (
    featureFlags.dsl4Debugger &&
    (!isRecord(input.debugExecution) ||
      typeof input.debugExecution.beforeAction !== 'function' ||
      typeof input.debugExecution.getState !== 'function' ||
      typeof input.debugExecution.subscribe !== 'function' ||
      typeof input.debugExecution.setMode !== 'function' ||
      typeof input.debugExecution.resume !== 'function')
  ) {
    throw new TypeError('Web Preview requires debugExecution when dsl4Debugger is enabled');
  }
  const prepareSourceResult = input.prepareSourceResult;
  const projectRootObserver = input.onProjectRoot;
  const distributionBuildObserver = input.onDistributionBuildState;
  const errorObserver = input.onError as Function | undefined;
  const diagnosticObserver = input.onDiagnostic as Function | undefined;
  const createCoordinator = input.createCoordinator ?? createDsl4BrowserPreviewCoordinator;
  if (typeof createCoordinator !== 'function') {
    throw new TypeError('createCoordinator must be a function');
  }
  const assetPipelineOptions = featureFlags.dsl4WebPreviewAssetLiveReload
    ? validateAssetPipelineOptions(
        input.assetPipelineOptions,
        featureFlags.dsl4PreviewReloadOverlay,
      )
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
  host.setAttribute('data-preview-presentation', String(presentation));
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
    'Browser folder access is unavailable. Use `tm-kamishibai preview-dsl4 --watch`, `tm-kamishibai validate-dsl4`, or `tm-kamishibai build-dsl4` from a terminal.',
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
  if (presentation === 'runtime') {
    for (const element of [
      title,
      introduction,
      openButton,
      watchStatus,
      diagnosticStatus,
      fallback,
    ]) {
      element.hidden = true;
    }
    reloadMount.hidden = true;
  }
  mount.appendChild(host);

  let disposed = false;
  let diagnosticCode: string | null = null;
  let sourceDisplayName = 'story.kamishibai.yaml';
  let activeDetails: Readonly<Record<string, any>> | null = null;
  let candidateDetails: Readonly<Record<string, any>> | null = null;
  let disposePromise: Promise<unknown> | null = null;
  const detailsByIntegrity = new Map();
  let selectedProjectRoot: Record<string, any> | null = null;
  let latestValidSourceResult: Readonly<Record<string, any>> | null = null;
  let assetPipeline: PreviewAssetPipelineSurface | null = null;
  let assetPipelineStarted = false;
  let assetSourceQueue = Promise.resolve();
  let reloadSurface: Dsl4PreviewReloadSurface | null = null;
  let manualRestartDepth = 0;

  function reportError(error: unknown) {
    diagnosticStatus.textContent = safeMessage(
      isRecord(error) && typeof error.message === 'string' ? error.message : error,
    );
    try {
      errorObserver?.(error);
    } catch {
      // Error observers cannot change Web Preview state.
    }
  }

  function observe(operation: Promise<unknown> | unknown) {
    Promise.resolve(operation).catch(reportError);
  }

  async function notifyAssetObserver(name: string, ...values: unknown[]) {
    const observer = assetPipelineOptions?.[name];
    if (typeof observer !== 'function') return;
    try {
      await observer(...values);
    } catch (error) {
      reportError(error);
    }
  }

  function queueAssetSource(result: Readonly<Record<string, any>>) {
    if (!assetPipeline || !assetPipelineOptions || !selectedProjectRoot || disposed) {
      return Promise.resolve();
    }
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
    return assetSourceQueue;
  }

  async function prepareIncludedSourceAssets(result: Readonly<Record<string, any>>) {
    if (
      result.ok !== true ||
      !featureFlags.dsl4SourceIncludes ||
      !featureFlags.dsl4WebPreviewAssetLiveReload
    ) {
      await prepareSourceResult?.(result);
      return;
    }
    await queueAssetSource(result);
    const transaction = assetPipeline?.getState()?.transaction;
    if (!transaction || !['ready', 'active'].includes(transaction.status)) {
      throw new TypeError('Source Graph assets must be stable before source candidate staging');
    }
    await prepareSourceResult?.(result);
  }

  async function setProjectRoot(projectRoot: Readonly<Record<string, any>>) {
    selectedProjectRoot = projectRoot;
    await projectRootObserver?.(projectRoot);
    if (latestValidSourceResult) queueAssetSource(latestValidSourceResult);
    notifyDistributionBuildState();
  }

  function render(view: Readonly<Record<string, any>>) {
    if (disposed) return;
    try {
      previewShell.update(view);
    } catch (error) {
      reportError(error);
    }
  }

  function renderDiagnostic(
    diagnostic: Record<string, any>,
    channel: 'source' | 'asset' = 'source',
  ) {
    const visibleDiagnostic = deepFreeze({
      ...diagnostic,
      channel,
      ...(typeof diagnostic.displayName === 'string' ? {} : {displayName: sourceDisplayName}),
    }) as Readonly<Record<string, any>>;
    diagnosticCode = typeof visibleDiagnostic.code === 'string' ? visibleDiagnostic.code : null;
    const message = safeMessage(
      diagnosticCode
        ? `${diagnosticCode}: ${String(visibleDiagnostic.message ?? 'Web Preview failed')}`
        : visibleDiagnostic.message,
    );
    diagnosticStatus.textContent = message;
    try {
      diagnosticObserver?.(visibleDiagnostic, channel);
    } catch (error) {
      reportError(error);
    }
    if (reloadSurface) observe(reloadSurface.setDiagnostic(channel, reloadDiagnostic(diagnostic)));
    fallback.hidden = !diagnosticCode || !fallbackDiagnosticCodes.has(diagnosticCode);
    if (visibleDiagnostic.severity !== 'error') return;
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
      warningCount: visibleDiagnostic.severity === 'warning' ? 1 : 0,
      changeCategories: [],
      safeStatusMessage: message,
    });
  }

  function onProtocolEvent(event: Readonly<Record<string, any>>) {
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
        renderDiagnostic(blocking as Record<string, any>);
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
        notifyDistributionBuildState();
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
                async apply(request: Readonly<Record<string, any>>) {
                  const choice = restartChoice(request.actualAnchor);
                  await coordinator.commit(choice);
                },
                async restart(request: Readonly<Record<string, any>>) {
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
        notifyDistributionBuildState();
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
      notifyDistributionBuildState();
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
      notifyDistributionBuildState();
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

  function onSourceStatus(state: Readonly<Record<string, any>>) {
    if (disposed) return;
    const statusLabels: Readonly<Record<string, string>> = {
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
      const reloadWatchState = (
        {
          stabilizing: 'stabilizing',
          'watching-visible': 'watching',
          'background-throttled': 'paused',
          disposed: 'disconnected',
        } as Readonly<Record<string, string>>
      )[state.status];
      if (reloadWatchState) observe(reloadSurface.setWatchState('source', reloadWatchState));
    }
    if (typeof state.sourceDisplayName === 'string') sourceDisplayName = state.sourceDisplayName;
    openButton.disabled = state.started === true || state.status === 'selecting';
  }

  const previewShell = createDsl4DevelopmentPreviewShell({
    environment: 'development',
    document,
    mount: reloadMount,
    onReloadChoice(choice: number) {
      const name = restartChoiceNames[choice as 1 | 2 | 3];
      if (name) observe(coordinator.commit(name));
    },
    onDefer() {
      observe(coordinator.defer());
    },
    onError: reportError,
  });

  let coordinator: PreviewCoordinatorSurface;
  try {
    coordinator = validateCoordinator(
      createCoordinator({
        protocolSession: input.protocolSession,
        sessionId: input.sessionId,
        sourceFrontend: input.sourceFrontend,
        maxSourceBytes: input.maxSourceBytes,
        featureFlags,
        maxSourceFiles: input.maxSourceFiles,
        maxTotalSourceBytes: input.maxTotalSourceBytes,
        maxIncludeDepth: input.maxIncludeDepth,
        capabilities: input.capabilities,
        sourceOptions: input.sourceOptions,
        onProjectRoot: setProjectRoot,
        beforeSourceStage: prepareIncludedSourceAssets,
        onSourceResult(result: Readonly<Record<string, unknown>>) {
          const snapshot = isRecord(result.sourceSnapshot) ? result.sourceSnapshot : null;
          if (typeof snapshot?.displayName === 'string') {
            sourceDisplayName = snapshot.displayName;
          }
          const details = sourceDetails(result);
          if (details) detailsByIntegrity.set(details.integrity, details);
          if (result.ok === true) {
            latestValidSourceResult = result as Readonly<Record<string, any>>;
            if (!featureFlags.dsl4SourceIncludes) queueAssetSource(latestValidSourceResult);
          } else if (
            typeof result.canonicalSource === 'string' &&
            Array.isArray(result.diagnostics) &&
            result.diagnostics.length > 0
          ) {
            const projection = createDsl4DiagnosticUiProjection(result.diagnostics, {
              canonicalSource: result.canonicalSource,
              displayName: sourceDisplayName,
            });
            const blocking = projection.diagnostics.find(
              (diagnostic) => diagnostic.severity === 'error',
            );
            if (blocking) renderDiagnostic(blocking);
          }
          notifyDistributionBuildState();
        },
        onProtocolEvent,
        onSourceStatus,
        onSourceDiagnostic(diagnostic: Readonly<Record<string, unknown>> | null) {
          if (disposed) return;
          if (diagnostic === null) {
            diagnosticCode = null;
            diagnosticStatus.textContent = '';
            fallback.hidden = true;
            if (reloadSurface) observe(reloadSurface.setDiagnostic('source', null));
            try {
              diagnosticObserver?.(null, 'source');
            } catch (error) {
              reportError(error);
            }
            notifyDistributionBuildState();
            return;
          }
          renderDiagnostic(diagnostic as Record<string, any>);
          notifyDistributionBuildState();
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
        (createReloadSurface as Function)({
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
          debugExecution: featureFlags.dsl4Debugger ? input.debugExecution : undefined,
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

  if (createAssetPipeline && assetPipelineOptions) {
    try {
      assetPipeline = validateAssetPipeline(
        createAssetPipeline({
          ...assetPipelineOptions,
          sessionId: input.sessionId,
          ...(reloadSurface ? {reloadSurface} : {}),
          onEvent: (event: Readonly<Record<string, unknown>>) =>
            notifyAssetObserver('onEvent', event),
          onDiagnostic: async (diagnostic: Readonly<Record<string, unknown>> | null) => {
            await notifyAssetObserver('onDiagnostic', diagnostic);
            if (disposed) return;
            if (diagnostic === null) {
              if (diagnosticCode?.startsWith('K4-ASSET-')) {
                diagnosticCode = null;
                diagnosticStatus.textContent = '';
              }
              if (reloadSurface) observe(reloadSurface.setDiagnostic('asset', null));
              try {
                diagnosticObserver?.(null, 'asset');
              } catch (error) {
                reportError(error);
              }
              return;
            }
            renderDiagnostic(diagnostic as Record<string, any>, 'asset');
          },
          onWatchStatus: (state: Readonly<Record<string, unknown>>) =>
            notifyAssetObserver('onWatchStatus', state),
          onError: (error: unknown) => {
            void notifyAssetObserver('onError', error);
            reportError(error);
          },
        }),
      );
    } catch (error) {
      previewShell.dispose();
      observe(coordinator.dispose());
      observe(reloadSurface?.dispose());
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

  function distributionBuildState() {
    if (!featureFlags.dsl4BrowserDistributionBuild) {
      return deepFreeze({enabled: false, reason: 'Browser distribution build is disabled.'});
    }
    if (!selectedProjectRoot || coordinator.getState().source.started !== true) {
      return deepFreeze({enabled: false, reason: 'Open a project directory first.'});
    }
    if (selectedProjectRoot.dsl4SourceOnly === true) {
      return deepFreeze({enabled: false, reason: 'Open a complete project directory to build.'});
    }
    const coordinatorState = coordinator.getState();
    const publication = coordinatorState.source.lastPublication;
    const integrity = latestValidSourceResult?.sourceSnapshot?.integrity;
    if (
      diagnosticCode !== null ||
      publication?.kind !== 'source' ||
      publication.ok !== true ||
      typeof integrity !== 'string' ||
      publication.integrity !== integrity
    ) {
      return deepFreeze({
        enabled: false,
        reason: 'Fix the latest source or asset diagnostic before building.',
      });
    }
    if (
      coordinatorState.protocol.pendingStages !== 0 ||
      coordinatorState.protocol.candidate !== null ||
      ['connecting', 'staging', 'committing', 'deferring', 'failed'].includes(
        coordinatorState.protocol.status,
      )
    ) {
      return deepFreeze({enabled: false, reason: 'Wait for the latest validation to finish.'});
    }
    const assetTransaction = assetPipeline?.getState()?.transaction;
    if (
      assetTransaction?.diagnostic ||
      assetTransaction?.candidate ||
      ['preparing', 'applying', 'diagnostic', 'full-rebuild'].includes(assetTransaction?.status)
    ) {
      return deepFreeze({
        enabled: false,
        reason: 'Apply or fix the latest asset change before building.',
      });
    }
    return deepFreeze({enabled: true, reason: null, integrity});
  }

  function notifyDistributionBuildState() {
    try {
      distributionBuildObserver?.(distributionBuildState());
    } catch (error) {
      reportError(error);
    }
  }

  async function settleLatestProjectFiles() {
    await coordinator.pollNow();
    await assetSourceQueue;
    if (assetPipelineStarted && assetPipeline) await assetPipeline.pollNow();
    await coordinator.whenIdle();
    await assetSourceQueue;
    if (assetPipelineStarted && assetPipeline) await assetPipeline.whenIdle();
    await reloadSurface?.whenIdle();
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
    start(projectRoot: unknown) {
      if (disposed) throw new TypeError('Web Preview shell is disposed');
      openButton.disabled = true;
      if (assetPipeline) setProjectRoot(projectRoot as Record<string, any>);
      return coordinator.start(projectRoot);
    },
    async pollNow() {
      await settleLatestProjectFiles();
      return snapshot();
    },
    getDistributionBuildState: distributionBuildState,
    async prepareDistributionBuild() {
      if (disposed) throw new TypeError('Web Preview shell is disposed');
      await settleLatestProjectFiles();
      const state = distributionBuildState();
      if (state.enabled !== true || !selectedProjectRoot || !latestValidSourceResult) {
        const error = new Error(state.reason ?? 'Browser distribution build is unavailable');
        Object.defineProperty(error, 'code', {value: 'K4-BROWSER-BUILD-NOT-READY'});
        throw error;
      }
      return Object.freeze({
        projectRoot: selectedProjectRoot,
        sourceResult: latestValidSourceResult,
        integrity: latestValidSourceResult.sourceSnapshot.integrity,
      });
    },
    restart(choice: 'storyStart' | 'currentScene' | 'currentAction') {
      if (disposed) throw new TypeError('Web Preview shell is disposed');
      return coordinator.restart(choice);
    },
    async whenIdle() {
      await coordinator.whenIdle();
      await assetSourceQueue;
      if (assetPipelineStarted && assetPipeline) await assetPipeline.whenIdle();
      await reloadSurface?.whenIdle();
      return snapshot();
    },
    submitReloadCandidate(candidate: unknown) {
      if (!reloadSurface) throw new TypeError('preview reload overlay is disabled');
      return reloadSurface.submitCandidate(candidate);
    },
    setReloadDiagnostic(channel: 'source' | 'asset', diagnostic: unknown) {
      if (!reloadSurface) throw new TypeError('preview reload overlay is disabled');
      return reloadSurface.setDiagnostic(channel, diagnostic);
    },
    setReloadWatchState(channel: 'source' | 'asset', status: unknown) {
      if (!reloadSurface) throw new TypeError('preview reload overlay is disabled');
      return reloadSurface.setWatchState(channel, status);
    },
    acknowledgePreviewInput(inputId: string) {
      return reloadSurface?.acknowledgePreviewInput(inputId) ?? snapshot();
    },
    registerPreviewControlRect(owner: string, rect: unknown) {
      if (!reloadSurface) throw new TypeError('preview reload overlay is disabled');
      return reloadSurface.registerReservedRect(owner, rect);
    },
    updatePreviewControlRect(owner: string, rect: unknown) {
      if (!reloadSurface) throw new TypeError('preview reload overlay is disabled');
      return reloadSurface.updateReservedRect(owner, rect);
    },
    unregisterPreviewControlRect(owner: string) {
      if (!reloadSurface) throw new TypeError('preview reload overlay is disabled');
      return reloadSurface.unregisterReservedRect(owner);
    },
    registerReservedRect(owner: string, rect: unknown) {
      if (!reloadSurface) throw new TypeError('preview reload overlay is disabled');
      return reloadSurface.registerReservedRect(owner, rect);
    },
    updateReservedRect(owner: string, rect: unknown) {
      if (!reloadSurface) throw new TypeError('preview reload overlay is disabled');
      return reloadSurface.updateReservedRect(owner, rect);
    },
    unregisterReservedRect(owner: string) {
      if (!reloadSurface) throw new TypeError('preview reload overlay is disabled');
      return reloadSurface.unregisterReservedRect(owner);
    },
    updatePreviewViewport(viewport: unknown, safeArea?: unknown) {
      if (!reloadSurface) throw new TypeError('preview reload overlay is disabled');
      return reloadSurface.updateViewport(viewport, safeArea);
    },
    getSnapshot: snapshot,
    dispose,
  });
}
