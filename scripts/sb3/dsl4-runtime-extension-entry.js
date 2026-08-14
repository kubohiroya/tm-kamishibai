import schema from '../../schema/dsl-4.schema.json' with {type: 'json'};

import {createDsl4ProductionSourceFrontend} from '../../src/builder/dsl4-source-frontend.js';
import {createDsl4WebPreviewShell} from '../../src/builder/dsl4-web-preview-shell.js';
import {
  createDsl4BrowserPreviewStoryFileProject,
  inspectDsl4BrowserPreviewSupport,
} from '../../src/dsl4/browser-preview-source-adapter.js';
import {
  dsl4NonEmbeddedDevelopmentFeatureFlags,
  dsl4StandardProductionFeatureFlags,
} from '../../src/dsl4/feature-flags.js';
import {createDsl4DebugExecutionCoordinator} from '../../src/dsl4/debug-execution.js';
import {
  createDsl4BrowserDistributionFilename,
  createDsl4BrowserDistributionSb3,
  requestDsl4BrowserDistributionSaveTarget,
  saveDsl4BrowserDistributionSb3,
} from '../../src/dsl4/platform/browser-distribution-build.js';
import {createDsl4LiveReloadSession} from '../../src/dsl4/live-reload-session.js';
import {createDsl4BrowserRemoteAssetLoader} from '../../src/dsl4/platform/browser-remote-asset-loader.js';
import {createDsl4BrowserPreviewRuntimeComponent} from '../../src/dsl4/platform/browser-preview-runtime-component.js';
import {
  buildDsl4BrowserSelectedStoryProject,
  collectDsl4BrowserDroppedFiles,
} from '../../src/dsl4/platform/browser-story-file-loader.js';
import {createDsl4BundledTMPoseRuntime} from '../../src/dsl4/platform/posenet-bundle.js';
import {createDsl4PackagedBinaryRuntimeBridge} from '../../src/dsl4/platform/packaged-binary-runtime.js';
import {createDsl4RuntimeErrorIndicator} from '../../src/dsl4/platform/runtime-error-indicator.js';
import {createDsl4RuntimeApplicationMenu} from '../../src/dsl4/platform/runtime-application-menu.js';
import {createDsl4RuntimeSourceChooser} from '../../src/dsl4/platform/runtime-source-chooser.js';
import {createDsl4RuntimeTitleControls} from '../../src/dsl4/platform/runtime-title-controls.js';
import {createDsl4RuntimeWarningIndicator} from '../../src/dsl4/platform/runtime-warning-indicator.js';
import {
  createDsl4SessionBackingFatalDiagnostic,
  createDsl4SessionBackingWarningDiagnostic,
} from '../../src/dsl4/platform/session-backing-diagnostic.js';
import {createDsl4StandardAppShell} from '../../src/dsl4/platform/standard-app-shell.js';
import {createDsl4TurboWarpPreviewSessionFactory} from '../../src/dsl4/platform/turbowarp-preview-session.js';
import {
  createDsl4TurboWarpCoreActionBlockAdapter,
  createDsl4TurboWarpCoreActionBlockSurface,
} from '../../src/dsl4/platform/turbowarp-core-action-block.js';
import {createDsl4TurboWarpTransitionPort} from '../../src/dsl4/platform/turbowarp-transition-port.js';
import {createDsl4PreviewProtocolSession} from '../../src/dsl4/preview-protocol.js';
import {loadDsl4RuntimeComponent} from '../../src/dsl4/runtime-artifact-loader.js';
import {dsl4RuntimeProvenance} from '../../src/dsl4/runtime-provenance.js';
import {appShellCommon, appShellLocales} from './app-shell-locales.mjs';

/* global DSL4_APPLICATION_MENU_ICONS, DSL4_OFFICIAL_WEBSITE_ICON, Scratch, tmPose */

const extensionId = 'kubohiroyakamishibairuntime4';
const extensionVersion = '4.0.0-rc.4';
const blockIconURI = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="10" width="48" height="44" rx="4"/><path d="M8 21h48"/></g><path fill="#fff" d="m27 29 15 8-15 8Z"/></svg>',
)}`;
const applicationMenuIcons = DSL4_APPLICATION_MENU_ICONS;
const officialWebsiteIcon = DSL4_OFFICIAL_WEBSITE_ICON;
const limits = Object.freeze({
  maxSourceBytes: 64 * 1024,
  maxAssetFiles: 64,
  maxAssetBytes: 64 * 1024 * 1024,
  maxSelectedEntries: 1024,
  maxSelectedDirectoryDepth: 32,
});
const runtimeErrorTitles = Object.freeze({
  en: 'Kamishibai runtime error',
  ja: '紙芝居の実行エラー',
});
const sourceDiagnosticPrefixes = Object.freeze([
  'K4-ACTION-LIMIT',
  'K4-ASSET-001',
  'K4-ASSET-IMAGE-MIME',
  'K4-ASSET-LIMIT',
  'K4-ASSET-MISSING',
  'K4-ASSET-PATH',
  'K4-ASSET-PERMISSION',
  'K4-ASSET-POSE',
  'K4-ASSET-PREPARE',
  'K4-ASSET-PROJECT',
  'K4-ASSET-REMOTE-URL',
  'K4-ASSET-UNSTABLE',
  'K4-BRANCH',
  'K4-COMMAND',
  'K4-EXPRESSION',
  'K4-ID',
  'K4-INCLUDE',
  'K4-KEY',
  'K4-POSE-MODEL',
  'K4-REF',
  'K4-SCENE-LIMIT',
  'K4-SCHEMA',
  'K4-SOURCE',
  'K4-SPEECH-STYLE',
  'K4-STABLE-ID',
  'K4-VERSION',
  'K4-YAML',
]);

/** @param {any} Scratch */
function resolveRuntimeMount(Scratch) {
  const canvas = Scratch?.vm?.renderer?.canvas;
  const parent = canvas?.parentElement ?? canvas?.parentNode;
  if (parent && typeof parent.appendChild === 'function') return parent;
  return globalThis.document?.body;
}

function resolveBundledTMPoseRuntime() {
  const runtime = typeof tmPose === 'object' && tmPose !== null ? tmPose : globalThis.tmPose;
  if (
    typeof runtime !== 'object' ||
    runtime === null ||
    typeof runtime.Webcam !== 'function' ||
    typeof runtime.loadFromFiles !== 'function'
  ) {
    throw new Error('The bundled Teachable Machine Pose runtime is unavailable.');
  }
  return runtime;
}

function browserLocale() {
  return /^ja(?:-|$)/iu.test(globalThis.navigator?.language ?? '') ? 'ja' : 'en';
}

/** @param {unknown} error */
function pickerWasCancelled(error) {
  return (
    typeof error === 'object' &&
    error !== null &&
    /** @type {{name?: unknown}} */ (error).name === 'AbortError'
  );
}

function filePickerSupported() {
  if (globalThis.isSecureContext !== true || typeof globalThis.showOpenFilePicker !== 'function') {
    return false;
  }
  try {
    return globalThis.self === globalThis.top;
  } catch {
    return false;
  }
}

/** @param {Record<string, any>} project */
function packagedRuntimeComponent(project) {
  return (
    project?.extensionStorage?.kubohiroyakamishibai4?.components?.kubohiroyakamishibairuntime4 ??
    project?.extensionStorage?.kubohiroyakamishibairuntime4
  );
}

/** @param {Record<string, any>} project */
function packagedApplicationMode(project) {
  const mode = packagedRuntimeComponent(project)?.application?.mode;
  return mode === 'menu' ? 'menu' : 'story';
}

/** @param {string} code */
function isSourceDiagnostic(code) {
  return sourceDiagnosticPrefixes.some((prefix) => code.startsWith(prefix));
}

function loggedError(failure) {
  if (failure instanceof Error) return failure;
  const error = new Error(
    String(failure?.message ?? failure ?? 'DSL 4.0 story execution failed.'),
    {cause: failure},
  );
  if (typeof failure?.code === 'string') {
    Object.defineProperty(error, 'code', {value: failure.code});
  }
  return error;
}

class KamishibaiDsl4RuntimeExtension {
  constructor(Scratch) {
    this.Scratch = Scratch;
    this.frontend = createDsl4ProductionSourceFrontend(schema);
    this.coreActionBlockAdapter = createDsl4TurboWarpCoreActionBlockAdapter(schema);
    this.shell = null;
    this.errorIndicator = null;
    this.warningIndicator = null;
    this.binaryRuntimeSurface = null;
    this.pendingStart = null;
    this.operation = Promise.resolve();
    this.status = 'ready';
    this.lastError = '';
    this.titleLocale = 'en';
    this.selectedProject = null;
    this.previewShell = null;
    this.previewLiveReload = null;
    this.previewDebugExecution = null;
    this.previewGenerationComponents = null;
    this.previewHasCurrent = false;
    this.distributionBuildStatus = '';
    this.fileInput = null;
    this.applicationMenu = null;
    this.titleControls = null;
    this.sourceChooser = null;

    const runtime = Scratch.vm.runtime;
    runtime.on('PROJECT_STOP_ALL', () =>
      this.enqueue(() => this.stop('project-stop-all'), 'shutdown'),
    );
    this.installDropTarget();
    this.ensureTitleControls()?.show('en');
    this.setStageCursor('pointer');
  }

  getInfo() {
    const {ArgumentType, BlockType} = this.Scratch;
    const coreActionSurface = createDsl4TurboWarpCoreActionBlockSurface(
      {ArgumentType, BlockType},
      {visible: dsl4StandardProductionFeatureFlags.dsl4TurboWarpActionSurface},
    );
    return {
      id: extensionId,
      name: 'Kamishibai DSL 4.0 Runtime',
      description:
        'Participatory AI Kamishibai runtime. This source-composed extension preserves the original component notices in its source header.',
      docsURI: 'https://kubohiroya.github.io/tmpose-kamishibai/',
      blockIconURI,
      creator: 'Hiroya Kubo',
      license: 'MPL-2.0',
      credits: dsl4RuntimeProvenance
        .map(
          (component) =>
            `${component.title} — ${component.copyright} — ${component.license} (${component.source}@${component.version})`,
        )
        .join('\n'),
      blocks: [
        ...coreActionSurface.blocks,
        {
          opcode: 'versionReporter',
          blockType: BlockType.REPORTER,
          text: 'Kamishibai DSL 4.0 runtime version',
          hideFromPalette: true,
          disableMonitor: true,
        },
        {
          opcode: 'statusReporter',
          blockType: BlockType.REPORTER,
          text: 'Kamishibai DSL 4.0 runtime status',
          hideFromPalette: true,
          disableMonitor: true,
        },
        {
          opcode: 'lastErrorReporter',
          blockType: BlockType.REPORTER,
          text: 'Kamishibai DSL 4.0 runtime error',
          hideFromPalette: true,
          disableMonitor: true,
        },
        {
          opcode: 'binaryBackingStatusReporter',
          blockType: BlockType.REPORTER,
          text: 'Kamishibai DSL 4.0 binary backing status',
          hideFromPalette: true,
          disableMonitor: true,
        },
        {
          opcode: 'runtimeDiagnosticsReporter',
          blockType: BlockType.REPORTER,
          text: 'Kamishibai DSL 4.0 runtime diagnostics',
          hideFromPalette: true,
          disableMonitor: true,
        },
        {
          opcode: 'setTextValue',
          blockType: BlockType.COMMAND,
          text: 'set internal text [NAME] to [VALUE]',
          arguments: {
            NAME: {type: ArgumentType.STRING, defaultValue: ''},
            VALUE: {type: ArgumentType.STRING, defaultValue: ''},
          },
          hideFromPalette: true,
        },
        {
          opcode: 'showTitle',
          blockType: BlockType.COMMAND,
          text: 'show title screen',
          hideFromPalette: true,
        },
        {
          opcode: 'closeTitle',
          blockType: BlockType.COMMAND,
          text: 'close title screen',
          hideFromPalette: true,
        },
        {
          opcode: 'openOfficialWebsite',
          blockType: BlockType.COMMAND,
          text: 'open official website',
          hideFromPalette: true,
        },
        {
          opcode: 'toggleTitleLanguage',
          blockType: BlockType.COMMAND,
          text: 'toggle title language',
          hideFromPalette: true,
        },
      ],
      menus: coreActionSurface.menus,
    };
  }

  versionReporter() {
    return extensionVersion;
  }

  statusReporter() {
    return this.status;
  }

  lastErrorReporter() {
    return this.lastError;
  }

  binaryBackingStatusReporter() {
    const backing = this.shell?.runtimeHost?.sessionBinaryBacking;
    return JSON.stringify({
      surface: this.binaryRuntimeSurface,
      backing: backing?.getState?.() ?? null,
    });
  }

  runtimeDiagnosticsReporter() {
    const runtimeHost = this.shell?.runtimeHost;
    return JSON.stringify({
      status: this.status,
      surface: this.binaryRuntimeSurface,
      runtime: runtimeHost?.getState?.().runtime ?? null,
      resources: runtimeHost?.diagnostics?.getState?.() ?? null,
      backing: runtimeHost?.sessionBinaryBacking?.getState?.() ?? null,
    });
  }

  setTextValue() {}

  showTitle() {
    return this.enqueue(() => this.restart(), 'initialization');
  }

  closeTitle() {
    const pendingStart = this.pendingStart;
    if (!pendingStart || pendingStart.shell !== this.shell) {
      if (this.status === 'title') this.hideScratchTitle();
      if (this.status === 'ready') {
        return this.enqueue(async () => {
          await this.restart();
          return this.pendingStart?.start();
        }, 'initial-title-close');
      }
      return undefined;
    }
    return pendingStart.start();
  }

  requestCloseTitle() {
    const threads = this.Scratch.vm.runtime.startHats('event_whenbroadcastreceived', {
      BROADCAST_OPTION: 'closeTitle',
    });
    if (!Array.isArray(threads) || threads.length === 0) return this.closeTitle();
    return undefined;
  }

  openOfficialWebsite() {
    if (this.shell?.titleElement) {
      this.shell.openOfficialWebsite();
      return;
    }
    const opener = globalThis.open;
    if (typeof opener === 'function') {
      opener(appShellCommon.about.officialWebsite.url, '_blank', 'noopener,noreferrer');
    }
  }

  toggleTitleLanguage() {
    this.titleLocale = this.titleLocale === 'ja' ? 'en' : 'ja';
    this.showScratchTitle(this.titleLocale);
  }

  actionInvoker() {
    const invoker = this.shell?.runtimeHost ?? this.previewLiveReload;
    if (
      !invoker ||
      typeof invoker.invokeAction !== 'function' ||
      typeof invoker.rejectActionInvocation !== 'function'
    ) {
      const error = new Error('A running DSL 4.0 story is required for action blocks');
      Object.defineProperty(error, 'code', {value: 'K4-BLOCK-RUNTIME-INACTIVE'});
      throw error;
    }
    return invoker;
  }

  async invokeCoreActionBlock(command, args) {
    let invoker;
    try {
      invoker = this.actionInvoker();
      const action = this.coreActionBlockAdapter.createAction(command, args);
      return await invoker.invokeAction(action);
    } catch (error) {
      if (invoker) {
        try {
          await invoker.rejectActionInvocation(error);
        } catch {
          // The original normalized block failure remains authoritative.
        }
      }
      this.reportFailure(error, `action-${command}`);
      return undefined;
    }
  }

  stage(args) {
    return this.invokeCoreActionBlock('stage', args);
  }

  bgm(args) {
    return this.invokeCoreActionBlock('bgm', args);
  }

  sound(args) {
    return this.invokeCoreActionBlock('sound', args);
  }

  wait(args) {
    return this.invokeCoreActionBlock('wait', args);
  }

  debugger(args) {
    return this.invokeCoreActionBlock('debugger', args);
  }

  broadcastMessageAndWait(args) {
    return this.invokeCoreActionBlock('broadcastMessageAndWait', args);
  }

  transition(args) {
    return this.invokeCoreActionBlock('transition', args);
  }

  goto(args) {
    return this.invokeCoreActionBlock('goto', args);
  }

  branch(args) {
    return this.invokeCoreActionBlock('branch', args);
  }

  keyInputToChangeScene(args) {
    return this.invokeCoreActionBlock('keyInputToChangeScene', args);
  }

  touchInputToChangeScene(args) {
    return this.invokeCoreActionBlock('touchInputToChangeScene', args);
  }

  poseInputToChangeScene(args) {
    return this.invokeCoreActionBlock('poseInputToChangeScene', args);
  }

  show(args) {
    return this.invokeCoreActionBlock('show', args);
  }

  hide(args) {
    return this.invokeCoreActionBlock('hide', args);
  }

  setTransparency(args) {
    return this.invokeCoreActionBlock('setTransparency', args);
  }

  moveTo(args) {
    return this.invokeCoreActionBlock('moveTo', args);
  }

  say(args) {
    return this.invokeCoreActionBlock('say', args);
  }

  think(args) {
    return this.invokeCoreActionBlock('think', args);
  }

  setSkin(args) {
    return this.invokeCoreActionBlock('setSkin', args);
  }

  setLayer(args) {
    return this.invokeCoreActionBlock('setLayer', args);
  }

  loop(args) {
    return this.invokeCoreActionBlock('loop', args);
  }

  setText(args) {
    return this.invokeCoreActionBlock('setText', args);
  }

  pose(args) {
    return this.invokeCoreActionBlock('pose', args);
  }

  ensureApplicationMenu() {
    if (this.applicationMenu) return this.applicationMenu;
    const document = globalThis.document;
    if (!document || Array.isArray(document.scripts)) return null;
    try {
      this.applicationMenu = createDsl4RuntimeApplicationMenu({
        document,
        mount: resolveRuntimeMount(this.Scratch),
        locales: {
          en: appShellLocales.en.ui,
          ja: appShellLocales.ja.ui,
        },
        icons: applicationMenuIcons,
        onOpen: () => this.openStoryFile(),
        onReload: () => this.reloadStory(),
        onBuild: () => this.buildDistributionSb3(),
        onAbout: () => this.showAbout(),
        onLocaleChange: (locale) => {
          this.titleLocale = locale;
          this.showScratchMenu(locale);
        },
        onError: (error) => this.reportFailure(error, 'application-menu'),
        reloadEnabled: this.selectedProject !== null || this.shell !== null,
        buildVisible: false,
        buildEnabled: false,
      });
    } catch (error) {
      console.error('[Kamishibai DSL 4.0] application-menu failed.', loggedError(error));
      return null;
    }
    return this.applicationMenu;
  }

  ensureTitleControls() {
    if (this.titleControls) return this.titleControls;
    const document = globalThis.document;
    if (!document || Array.isArray(document.scripts)) return null;
    try {
      this.titleControls = createDsl4RuntimeTitleControls({
        document,
        mount: resolveRuntimeMount(this.Scratch),
        locales: {
          en: {
            website: appShellLocales.en.about.officialWebsite.name,
            close: appShellLocales.en.ui.close,
          },
          ja: {
            website: appShellLocales.ja.about.officialWebsite.name,
            close: appShellLocales.ja.ui.close,
          },
        },
        websiteIconUrl: officialWebsiteIcon,
        onWebsite: () => this.openOfficialWebsite(),
        onClose: () => this.requestCloseTitle(),
        onError: (error) => this.reportFailure(error, 'title-controls'),
      });
    } catch (error) {
      console.error('[Kamishibai DSL 4.0] title-controls failed.', loggedError(error));
      return null;
    }
    return this.titleControls;
  }

  ensureSourceChooser() {
    if (this.sourceChooser) return this.sourceChooser;
    const document = globalThis.document;
    if (!document || Array.isArray(document.scripts)) return null;
    try {
      this.sourceChooser = createDsl4RuntimeSourceChooser({
        document,
        mount: resolveRuntimeMount(this.Scratch),
        locales: {
          en: appShellLocales.en.ui,
          ja: appShellLocales.ja.ui,
        },
        onFile: () => this.openWatchedStoryFile(),
        onProject: () => this.openWatchedProjectDirectory(),
        onCancel: () => this.cancelSourceChoice(),
        onError: (error) => this.reportFailure(error, 'source-chooser'),
      });
    } catch (error) {
      console.error('[Kamishibai DSL 4.0] source chooser failed.', loggedError(error));
      return null;
    }
    return this.sourceChooser;
  }

  installDropTarget() {
    const mount = resolveRuntimeMount(this.Scratch);
    if (
      !mount ||
      typeof mount.addEventListener !== 'function' ||
      typeof mount.removeEventListener !== 'function'
    ) {
      return;
    }
    const onDragOver = (event) => {
      if (this.status !== 'menu') return;
      event.preventDefault?.();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (event) => {
      if (this.status !== 'menu') return;
      event.preventDefault?.();
      const collecting = collectDsl4BrowserDroppedFiles(event.dataTransfer, {
        maxEntries: limits.maxSelectedEntries,
        maxDepth: limits.maxSelectedDirectoryDepth,
      });
      this.enqueue(async () => this.loadSelectedEntries(await collecting), 'file-drop');
    };
    mount.addEventListener('dragover', onDragOver);
    mount.addEventListener('drop', onDrop);
  }

  async initializeNonEmbeddedPreview(project) {
    if (this.previewShell) return this.previewShell;
    const document = globalThis.document;
    if (!document || Array.isArray(document.scripts)) return null;
    const component = await loadDsl4RuntimeComponent(project, this.frontend, {
      ...limits,
      subtleCrypto: globalThis.crypto?.subtle,
    });
    if (!component.ok) {
      const diagnostic = component.diagnostics?.[0];
      const error = new Error(
        diagnostic?.message ?? 'The non-embedded DSL 4.0 preview component is invalid.',
      );
      if (typeof diagnostic?.code === 'string') {
        Object.defineProperty(error, 'code', {value: diagnostic.code});
      }
      throw error;
    }

    const Scratch = this.Scratch;
    const mount = resolveRuntimeMount(Scratch);
    const loadRemoteAsset = createDsl4BrowserRemoteAssetLoader({maxBytes: limits.maxAssetBytes});
    /** @type {Record<string, any> | null} */
    let previewProjectRoot = null;
    const generationComponents = new WeakMap();
    const debugExecution = createDsl4DebugExecutionCoordinator({
      enabled: dsl4NonEmbeddedDevelopmentFeatureFlags.dsl4Debugger,
    });
    let liveReload;
    const createSession = createDsl4TurboWarpPreviewSessionFactory({
      featureFlags: dsl4NonEmbeddedDevelopmentFeatureFlags,
      runtimeComponent: component,
      debugExecution,
      resolveRuntimeComponent({storyDocument}) {
        const generation = generationComponents.get(storyDocument);
        if (!generation) {
          throw new TypeError('The preview source generation has no prepared runtime component');
        }
        return generation;
      },
      runtime: Scratch.vm.runtime,
      resetManagedPresentation: () => {
        this.hideScratchTitle();
        this.hideScratchMenu();
        this.hideAllDisplayTargets();
      },
      inputTarget: Scratch.vm.renderer?.canvas,
      stagePointerTarget: Scratch.vm.renderer?.canvas,
      createHostPort: async ({runtime}) => createDsl4TurboWarpTransitionPort({runtime}),
      tmPoseRuntime: createDsl4BundledTMPoseRuntime({
        runtime: resolveBundledTMPoseRuntime(),
        globalObject: globalThis,
      }),
      setLoading() {},
      loadRemoteAsset,
      subtleCrypto: globalThis.crypto?.subtle,
      onEvent: (event) => {
        if (this.previewLiveReload !== liveReload) return;
        if (event.type === 'runtime.start' || event.type === 'runtime.resume') {
          this.previewHasCurrent = true;
          this.hideScratchTitle();
          this.hideScratchMenu();
          this.status = 'running';
          return;
        }
        if (event.type === 'runtime.finish') {
          this.status = 'menu';
          this.showScratchMenu(this.titleLocale);
          Scratch.vm.runtime.startHats('event_whenbroadcastreceived', {
            BROADCAST_OPTION: 'showMenu',
          });
          return;
        }
        if (event.type === 'runtime.fail') {
          this.reportFailure(event.diagnostic ?? 'DSL 4.0 preview execution failed.', 'preview');
        }
      },
    });
    liveReload = createDsl4LiveReloadSession({
      createSession,
      onRunError: (error) => this.reportFailure(error, 'preview-runtime'),
    });
    const protocolSession = createDsl4PreviewProtocolSession({liveReloadSession: liveReload});
    let previewStorage;
    try {
      previewStorage = globalThis.localStorage;
    } catch {
      previewStorage = undefined;
    }
    let previewShell;
    try {
      previewShell = createDsl4WebPreviewShell({
        environment: 'development',
        presentation: 'runtime',
        document,
        mount,
        featureFlags: dsl4NonEmbeddedDevelopmentFeatureFlags,
        protocolSession,
        sessionId: 'nonembedded-sb3',
        sourceFrontend: this.frontend,
        debugExecution,
        maxSourceBytes: limits.maxSourceBytes,
        onProjectRoot: (projectRoot) => {
          previewProjectRoot = projectRoot;
        },
        prepareSourceResult: async (result) => {
          if (result.ok !== true) return;
          const generation = await createDsl4BrowserPreviewRuntimeComponent({
            baseComponent: component,
            sourceResult: result,
            projectRoot: previewProjectRoot,
            maxAssetFileBytes: limits.maxAssetBytes,
            maxAssetFiles: limits.maxAssetFiles,
            maxAssetBytes: limits.maxAssetBytes,
            subtleCrypto: globalThis.crypto?.subtle,
          });
          generationComponents.set(result.storyDocument, generation);
        },
        onDistributionBuildState: (state) => {
          if (this.status !== 'menu' || !this.applicationMenu) return;
          this.distributionBuildStatus =
            state.enabled === true ? '' : appShellLocales[this.titleLocale].ui.buildUnavailable;
          this.applicationMenu.setBuildState({
            visible: true,
            enabled: state.enabled === true,
            status: this.distributionBuildStatus,
          });
        },
        onDiagnostic: (diagnostic) => {
          if (diagnostic?.severity === 'error' && this.status === 'starting') {
            this.showFailure(diagnostic, {returnToMenu: true});
          }
        },
        ...(previewStorage === undefined ? {} : {previewStorage}),
        onError: (error) => this.reportFailure(error, 'preview-shell'),
      });
    } catch (error) {
      await liveReload.dispose();
      debugExecution.dispose();
      throw error;
    }
    this.previewLiveReload = liveReload;
    this.previewDebugExecution = debugExecution;
    this.previewGenerationComponents = generationComponents;
    this.previewShell = previewShell;
    this.previewHasCurrent = false;
    return previewShell;
  }

  openStoryFile() {
    if (this.status !== 'menu') return undefined;
    const projectSupported = inspectDsl4BrowserPreviewSupport({globalObject: globalThis}).supported;
    const storyFileSupported = filePickerSupported();
    if (this.previewShell && (storyFileSupported || projectSupported)) {
      this.hideScratchMenu();
      const chooser = this.ensureSourceChooser();
      if (chooser) {
        chooser.show(this.titleLocale, {
          fileEnabled: storyFileSupported,
          projectEnabled: projectSupported,
        });
        return undefined;
      }
      this.showScratchMenu(this.titleLocale);
    }
    return this.openOneShotStoryFile();
  }

  async completeWatchedSourceOpen(opening) {
    try {
      const state = await opening;
      if (state?.source?.started !== true && this.status !== 'error') {
        this.cancelSourceChoice();
      }
      return state;
    } catch (error) {
      if (pickerWasCancelled(error)) {
        this.cancelSourceChoice();
        return undefined;
      }
      if (this.status !== 'error') this.cancelSourceChoice();
      throw error;
    }
  }

  openWatchedProjectDirectory() {
    if (this.status !== 'menu' || !this.previewShell) return undefined;
    const picker = globalThis.showDirectoryPicker;
    if (typeof picker !== 'function') throw new Error('This browser cannot open a project folder.');
    this.sourceChooser?.hide();
    this.status = 'starting';
    let selection;
    try {
      selection = Promise.resolve(picker.call(globalThis, {mode: 'read'}));
    } catch (error) {
      selection = Promise.reject(error);
    }
    return selection.then(
      (projectRoot) => this.startNewWatchedSource(projectRoot),
      (error) => {
        if (pickerWasCancelled(error)) {
          this.cancelSourceChoice();
          return undefined;
        }
        this.cancelSourceChoice();
        throw error;
      },
    );
  }

  async startNewWatchedSource(projectRoot) {
    if (this.previewShell?.getSnapshot()?.coordinator?.source?.started === true) {
      await this.restart({showTitle: false});
    }
    if (!this.previewShell) throw new Error('The watched story preview is unavailable.');
    this.hideScratchMenu();
    this.status = 'starting';
    return this.completeWatchedSourceOpen(this.previewShell.start(projectRoot));
  }

  async openWatchedStoryFile() {
    if (this.status !== 'menu' || !this.previewShell) return undefined;
    const picker = globalThis.showOpenFilePicker;
    if (typeof picker !== 'function') throw new Error('This browser cannot watch a story file.');
    this.sourceChooser?.hide();
    this.status = 'starting';
    let handles;
    try {
      handles = await picker({
        multiple: false,
        types: [
          {
            description: 'Kamishibai DSL 4.0 YAML',
            accept: {'application/yaml': ['.yml', '.yaml']},
          },
        ],
      });
    } catch (error) {
      if (pickerWasCancelled(error)) {
        this.cancelSourceChoice();
        return undefined;
      }
      throw error;
    }
    if (!Array.isArray(handles) || handles.length !== 1) {
      throw new TypeError('Select exactly one DSL 4.0 story file');
    }
    const projectRoot = createDsl4BrowserPreviewStoryFileProject(handles[0]);
    return this.startNewWatchedSource(projectRoot);
  }

  cancelSourceChoice() {
    this.sourceChooser?.hide();
    if (this.status !== 'error') {
      this.status = 'menu';
      this.showScratchMenu(this.titleLocale);
    }
  }

  openOneShotStoryFile() {
    const document = globalThis.document;
    if (!document || typeof document.createElement !== 'function') {
      throw new Error('This browser cannot open a DSL 4.0 story file.');
    }
    const input = document.createElement('input');
    if (
      !input ||
      typeof input.addEventListener !== 'function' ||
      typeof input.click !== 'function'
    ) {
      throw new Error('This browser cannot open a DSL 4.0 story file.');
    }
    input.type = 'file';
    input.accept = '.yml,.yaml';
    input.multiple = false;
    if (input.style) input.style.display = 'none';
    input.addEventListener(
      'change',
      () => {
        const selectedFiles = input.files ?? [];
        input.remove?.();
        this.fileInput = null;
        if (selectedFiles.length === 0) return;
        this.enqueue(() => {
          if (selectedFiles.length > limits.maxSelectedEntries) {
            throw new TypeError(
              `Selected project exceeds the ${limits.maxSelectedEntries} entry limit`,
            );
          }
          const entries = Array.from(selectedFiles).map((file) => ({
            path: file.webkitRelativePath || file.name,
            file,
          }));
          if (
            entries.some(({path}) => path.split('/').length - 1 > limits.maxSelectedDirectoryDepth)
          ) {
            throw new TypeError(
              `Selected project exceeds the ${limits.maxSelectedDirectoryDepth} directory depth limit`,
            );
          }
          return this.loadSelectedEntries(entries);
        }, 'file-open');
      },
      {once: true},
    );
    this.fileInput?.remove?.();
    this.fileInput = input;
    document.body?.appendChild?.(input);
    input.click();
    return undefined;
  }

  async loadSelectedEntries(entries) {
    this.status = 'starting';
    this.hideScratchMenu();
    this.setStageCursor('wait');
    const baseProject = JSON.parse(this.Scratch.vm.toJSON());
    const selected = await buildDsl4BrowserSelectedStoryProject({
      project: baseProject,
      entries,
      sourceFrontend: this.frontend,
      maxSourceBytes: limits.maxSourceBytes,
      maxAssetFileBytes: limits.maxAssetBytes,
      maxAssetFiles: limits.maxAssetFiles,
      maxAssetBytes: limits.maxAssetBytes,
      subtleCrypto: globalThis.crypto?.subtle,
    });
    this.selectedProject = selected.project;
    await this.restart({projectOverride: selected.project, showTitle: false, forceStory: true});
  }

  reloadStory() {
    if (this.status !== 'menu') return undefined;
    if (this.previewShell && this.previewHasCurrent) {
      const previewShell = this.previewShell;
      this.hideScratchMenu();
      this.status = 'starting';
      return this.enqueue(async () => {
        try {
          await previewShell.restart('storyStart');
        } catch (error) {
          if (this.status !== 'error') {
            this.status = 'menu';
            this.showScratchMenu(this.titleLocale);
          }
          throw error;
        }
      }, 'story-reload');
    }
    const packagedProject = JSON.parse(this.Scratch.vm.toJSON());
    const project =
      this.selectedProject ??
      (packagedApplicationMode(packagedProject) === 'story' ? packagedProject : null);
    if (!project) return undefined;
    return this.enqueue(
      () => this.restart({projectOverride: project, showTitle: false, forceStory: true}),
      'story-reload',
    );
  }

  async buildDistributionSb3() {
    if (this.status !== 'menu' || !this.previewShell || !this.previewGenerationComponents) {
      return undefined;
    }
    const menu = this.ensureApplicationMenu();
    const ui = appShellLocales[this.titleLocale].ui;
    this.status = 'building';
    this.distributionBuildStatus = ui.buildPreparing;
    menu?.setBuildState({visible: true, enabled: false, status: this.distributionBuildStatus});
    this.setStageCursor('wait');
    try {
      const suggestedFilename = createDsl4BrowserDistributionFilename(
        this.previewShell.getSnapshot().sourceDisplayName,
      );
      const saveTargetPromise = requestDsl4BrowserDistributionSaveTarget({
        filename: suggestedFilename,
        globalObject: globalThis,
      });
      const saveTarget = await saveTargetPromise;
      if (saveTarget?.method === 'cancelled') {
        this.status = 'menu';
        this.distributionBuildStatus = ui.buildCancelled;
        this.showScratchMenu(this.titleLocale);
        return saveTarget;
      }
      const prepared = await this.previewShell.prepareDistributionBuild();
      this.distributionBuildStatus = ui.buildVerifying;
      menu?.setBuildState({visible: true, enabled: false, status: this.distributionBuildStatus});
      const initialRuntimeComponent = await createDsl4BrowserPreviewRuntimeComponent({
        baseComponent: this.previewGenerationComponents.get(prepared.sourceResult.storyDocument),
        sourceResult: prepared.sourceResult,
        projectRoot: prepared.projectRoot,
        maxAssetFileBytes: limits.maxAssetBytes,
        maxAssetFiles: limits.maxAssetFiles,
        maxAssetBytes: limits.maxAssetBytes,
        subtleCrypto: globalThis.crypto?.subtle,
      });
      const projectFiles = await this.Scratch.vm.saveProjectSb3DontZip();
      const confirmedBeforeBuild = await this.previewShell.prepareDistributionBuild();
      if (confirmedBeforeBuild.integrity !== prepared.integrity) {
        const error = new Error('Project files changed during the distribution build. Try again.');
        Object.defineProperty(error, 'code', {value: 'K4-BROWSER-BUILD-GENERATION-CHANGED'});
        throw error;
      }
      const runtimeComponent = await createDsl4BrowserPreviewRuntimeComponent({
        baseComponent: this.previewGenerationComponents.get(
          confirmedBeforeBuild.sourceResult.storyDocument,
        ),
        sourceResult: confirmedBeforeBuild.sourceResult,
        projectRoot: confirmedBeforeBuild.projectRoot,
        maxAssetFileBytes: limits.maxAssetBytes,
        maxAssetFiles: limits.maxAssetFiles,
        maxAssetBytes: limits.maxAssetBytes,
        subtleCrypto: globalThis.crypto?.subtle,
      });
      if (
        runtimeComponent.assetBundle.integrity !== initialRuntimeComponent.assetBundle.integrity
      ) {
        const error = new Error('Project assets changed during the distribution build. Try again.');
        Object.defineProperty(error, 'code', {value: 'K4-BROWSER-BUILD-GENERATION-CHANGED'});
        throw error;
      }
      const built = await createDsl4BrowserDistributionSb3({
        projectFiles,
        runtimeComponent,
        sourceFrontend: this.frontend,
        maxSourceBytes: limits.maxSourceBytes,
        maxAssetFiles: limits.maxAssetFiles,
        maxAssetBytes: limits.maxAssetBytes,
        subtleCrypto: globalThis.crypto?.subtle,
      });
      const confirmed = await this.previewShell.prepareDistributionBuild();
      if (confirmed.integrity !== prepared.integrity) {
        const error = new Error('Project files changed during the distribution build. Try again.');
        Object.defineProperty(error, 'code', {value: 'K4-BROWSER-BUILD-GENERATION-CHANGED'});
        throw error;
      }
      this.distributionBuildStatus = built.delivery.networkRequired
        ? ui.buildSavingRemote
        : ui.buildSaving;
      menu?.setBuildState({visible: true, enabled: false, status: this.distributionBuildStatus});
      const saved = await saveDsl4BrowserDistributionSb3({
        bytes: built.bytes,
        filename: built.filename,
        target: saveTarget,
        globalObject: globalThis,
      });
      this.status = 'menu';
      this.distributionBuildStatus = built.delivery.networkRequired
        ? saved.method === 'file-system'
          ? ui.buildSavedRemote
          : ui.buildDoneRemote
        : saved.method === 'file-system'
          ? ui.buildSaved
          : ui.buildDone;
      this.showScratchMenu(this.titleLocale);
      return built;
    } catch (error) {
      if (this.status !== 'error') this.status = 'menu';
      throw error;
    } finally {
      if (this.status === 'menu') this.setStageCursor('pointer');
    }
  }

  showAbout() {
    if (this.status !== 'menu') return undefined;
    const shell = this.shell;
    this.hideScratchMenu();
    this.pendingStart = {
      shell,
      start: async () => {
        if (this.shell !== shell) return;
        this.pendingStart = null;
        this.hideScratchTitle();
        this.showScratchMenu(this.titleLocale);
        this.status = 'menu';
      },
    };
    this.status = 'title';
    this.showScratchTitle(this.titleLocale);
    return undefined;
  }

  setTargetCostume(target, costumeName) {
    const costumes = target?.sprite?.costumes;
    const index = Array.isArray(costumes)
      ? costumes.findIndex((costume) => costume?.name === costumeName)
      : -1;
    if (index < 0 || typeof target?.setCostume !== 'function') {
      throw new Error(`The packaged title costume is unavailable: ${costumeName}`);
    }
    target.setCostume(index);
  }

  setStageCursor(cursor) {
    const canvas = this.Scratch?.vm?.renderer?.canvas;
    if (canvas?.style) canvas.style.cursor = cursor;
    const mount = resolveRuntimeMount(this.Scratch);
    if (mount?.style) mount.style.cursor = cursor;
  }

  hideAllDisplayTargets() {
    const targets = this.Scratch?.vm?.runtime?.targets;
    if (!Array.isArray(targets)) return;
    for (const target of targets) {
      if (target?.isStage === true) continue;
      if (typeof target?.setVisible === 'function') target.setVisible(false);
    }
  }

  showScratchTitle(locale) {
    const runtime = this.Scratch.vm.runtime;
    const stage = runtime.getTargetForStage();
    this.shell?.hideTitle();
    this.hideScratchMenu();
    this.setTargetCostume(stage, locale === 'ja' ? 'TitleRuntime' : 'Title');
    this.ensureTitleControls()?.show(locale);
    this.setStageCursor('pointer');
  }

  hideScratchTitle() {
    this.titleControls?.hide();
    this.setStageCursor('auto');
  }

  showScratchMenu(locale) {
    const runtime = this.Scratch.vm.runtime;
    const stage = runtime.getTargetForStage();
    this.hideScratchTitle();
    this.sourceChooser?.hide();
    this.setTargetCostume(stage, locale === 'ja' ? 'MenuRuntime' : 'Menu');
    const menu = this.ensureApplicationMenu();
    menu?.setReloadEnabled(
      this.selectedProject !== null || this.shell !== null || this.previewHasCurrent,
    );
    const buildVisible =
      this.previewShell !== null &&
      dsl4NonEmbeddedDevelopmentFeatureFlags.dsl4BrowserDistributionBuild;
    const buildState = buildVisible
      ? this.previewShell.getDistributionBuildState()
      : {enabled: false, reason: null};
    menu?.setBuildState({
      visible: buildVisible,
      enabled: buildState.enabled === true,
      status:
        this.distributionBuildStatus ||
        (buildVisible && buildState.enabled !== true
          ? appShellLocales[locale].ui.buildUnavailable
          : ''),
    });
    menu?.show(locale);
    this.setStageCursor('pointer');
  }

  hideScratchMenu() {
    this.applicationMenu?.hide();
    this.setStageCursor('auto');
  }

  enqueue(operation, phase = 'operation') {
    this.operation = this.operation.then(operation, operation).catch((error) => {
      this.reportFailure(error, phase);
    });
    return this.operation;
  }

  reportFailure(failure, phase) {
    this.showFailure(failure);
    console.error(`[Kamishibai DSL 4.0] ${phase} failed.`, loggedError(failure));
  }

  showSessionBackingWarning(warning) {
    const diagnostic = createDsl4SessionBackingWarningDiagnostic(warning, browserLocale());
    try {
      this.warningIndicator ??= createDsl4RuntimeWarningIndicator({
        document: globalThis.document,
        mount: resolveRuntimeMount(this.Scratch),
      });
      this.warningIndicator.show(diagnostic);
    } catch (indicatorError) {
      console.error('Kamishibai DSL 4.0 warning indicator failed.', indicatorError);
    }
    console.warn('[Kamishibai DSL 4.0] session-binary-backing warning.', warning);
  }

  showSessionBackingFatal(failure) {
    const diagnostic = createDsl4SessionBackingFatalDiagnostic(failure, browserLocale());
    this.warningIndicator?.hide();
    this.reportFailure(diagnostic, 'session-binary-backing');
  }

  showFailure(failure, {returnToMenu = false} = {}) {
    const message = String(failure?.message ?? failure ?? 'DSL 4.0 story execution failed.');
    const code = typeof failure?.code === 'string' ? failure.code : '';
    const locale = browserLocale();
    const title = isSourceDiagnostic(code)
      ? appShellLocales[locale].ui.invalidScript
      : runtimeErrorTitles[locale];
    this.status = 'error';
    this.lastError = message;
    this.hideScratchTitle();
    this.hideScratchMenu();
    this.sourceChooser?.hide();
    try {
      this.errorIndicator ??= createDsl4RuntimeErrorIndicator({
        document: globalThis.document,
        mount: resolveRuntimeMount(this.Scratch),
        locales: {
          en: {title: appShellLocales.en.ui.invalidScript},
          ja: {title: appShellLocales.ja.ui.invalidScript},
        },
        onReturnToMenu: () =>
          this.enqueue(() => this.restart({showTitle: false}), 'project-diagnostic-menu'),
      });
      const details = typeof failure === 'object' && failure !== null ? failure : {};
      this.errorIndicator.show({...details, message, code, title}, {returnToMenu});
    } catch (indicatorError) {
      console.error('Kamishibai DSL 4.0 error indicator failed.', indicatorError);
    }
  }

  async stop(reason) {
    this.pendingStart = null;
    this.hideScratchTitle();
    this.hideScratchMenu();
    this.sourceChooser?.hide();
    const errorIndicator = this.errorIndicator;
    this.errorIndicator = null;
    errorIndicator?.dispose();
    const warningIndicator = this.warningIndicator;
    this.warningIndicator = null;
    warningIndicator?.dispose();
    const shell = this.shell;
    this.shell = null;
    this.binaryRuntimeSurface = null;
    const previewShell = this.previewShell;
    const previewLiveReload = this.previewLiveReload;
    const previewDebugExecution = this.previewDebugExecution;
    this.previewShell = null;
    this.previewLiveReload = null;
    this.previewDebugExecution = null;
    this.previewGenerationComponents = null;
    this.previewHasCurrent = false;
    this.distributionBuildStatus = '';
    const failures = [];
    for (const dispose of [
      shell ? () => shell.dispose(reason) : null,
      previewShell ? () => previewShell.dispose() : null,
      previewLiveReload ? () => previewLiveReload.dispose() : null,
      previewDebugExecution ? () => previewDebugExecution.dispose() : null,
    ]) {
      if (!dispose) continue;
      try {
        await dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'DSL 4.0 runtime cleanup failed');
    }
    if (['running', 'starting', 'title'].includes(this.status)) this.status = 'stopped';
  }

  async restart({projectOverride = null, showTitle = true, forceStory = false} = {}) {
    await this.stop('project-restart');
    this.hideAllDisplayTargets();
    this.status = 'starting';
    this.lastError = '';

    const Scratch = this.Scratch;
    const packagedProject = JSON.parse(Scratch.vm.toJSON());
    const project = projectOverride ?? this.selectedProject ?? packagedProject;
    const applicationMode =
      forceStory || this.selectedProject ? 'story' : packagedApplicationMode(project);
    this.titleLocale = browserLocale();
    if (applicationMode === 'menu') {
      try {
        await this.initializeNonEmbeddedPreview(project);
      } catch (error) {
        console.warn(
          '[Kamishibai DSL 4.0] development preview is unavailable; using one-shot file loading.',
          loggedError(error),
        );
      }
      const showMenu = async () => {
        if (this.shell !== null) return;
        this.pendingStart = null;
        this.hideScratchTitle();
        this.showScratchMenu(this.titleLocale);
        Scratch.vm.runtime.startHats('event_whenbroadcastreceived', {
          BROADCAST_OPTION: 'showMenu',
        });
        this.status = 'menu';
      };
      if (showTitle) {
        this.pendingStart = {shell: null, start: showMenu};
        this.status = 'title';
        this.showScratchTitle(this.titleLocale);
      } else {
        await showMenu();
      }
      return;
    }
    const loadRemoteAsset = createDsl4BrowserRemoteAssetLoader({maxBytes: limits.maxAssetBytes});
    let binaryRuntime = await createDsl4PackagedBinaryRuntimeBridge({
      project,
      sourceFrontend: this.frontend,
      ...limits,
      globalObject: globalThis,
      subtleCrypto: globalThis.crypto?.subtle,
    });
    let shell;
    let started = false;
    const startRuntime = async () => {
      if (started || this.shell !== shell) return;
      started = true;
      this.pendingStart = null;
      shell.hideTitle();
      this.hideScratchTitle();
      this.status = 'running';
      try {
        const result = await shell.runtimeHost.start();
        if (this.shell !== shell) return;
        if (result.status === 'failed') {
          if (this.status !== 'error') {
            this.reportFailure(
              result.diagnostic ?? 'DSL 4.0 story execution failed.',
              'story-runtime',
            );
          }
          return;
        }
        if (result.status === 'finished') {
          await shell.runtimeHost.prepareMenu();
          Scratch.vm.runtime.startHats('event_whenbroadcastreceived', {
            BROADCAST_OPTION: 'showCover',
          });
          this.showScratchMenu(this.titleLocale);
          Scratch.vm.runtime.startHats('event_whenbroadcastreceived', {
            BROADCAST_OPTION: 'showMenu',
          });
          this.status = 'menu';
          return;
        }
        this.status = result.status;
      } catch (error) {
        if (this.shell !== shell) return;
        if (this.status !== 'error') this.reportFailure(error, 'story-runtime');
      }
    };
    try {
      shell = await createDsl4StandardAppShell({
        featureFlags: binaryRuntime
          ? {
              ...dsl4StandardProductionFeatureFlags,
              dsl4SessionBinaryBacking: binaryRuntime.sessionBackingEnabled,
            }
          : dsl4StandardProductionFeatureFlags,
        surface: binaryRuntime ? 'packager' : 'regularEditor',
        document: globalThis.document,
        mount: resolveRuntimeMount(Scratch),
        runtimeHostOptions: {
          project,
          sourceFrontend: this.frontend,
          ...limits,
          ...(binaryRuntime
            ? {
                ...binaryRuntime.runtimeLimits,
                assetBundleFormat: binaryRuntime.assetBundleFormat,
                binaryEntryProvider: binaryRuntime.binaryEntryProvider,
                sessionBacking: binaryRuntime.sessionBacking,
                onSessionBackingWarning: (warning) => this.showSessionBackingWarning(warning),
                onSessionBackingFatalError: (failure) => this.showSessionBackingFatal(failure),
              }
            : {}),
          runtime: Scratch.vm.runtime,
          onTitleStart() {
            Scratch.vm.runtime.startHats('event_whenbroadcastreceived', {
              BROADCAST_OPTION: 'closeTitle',
            });
          },
          createHostPort: async ({runtime}) => createDsl4TurboWarpTransitionPort({runtime}),
          tmPoseRuntime: createDsl4BundledTMPoseRuntime({
            runtime: resolveBundledTMPoseRuntime(),
            globalObject: globalThis,
          }),
          setLoading() {},
          loadRemoteAsset,
          subtleCrypto: globalThis.crypto?.subtle,
        },
      });
      if (!shell.ok || !shell.runtimeHost) {
        const diagnostic = shell.diagnostics[0];
        throw new Error(diagnostic?.message ?? 'The packaged DSL 4.0 story is invalid.');
      }
    } catch (error) {
      if (binaryRuntime) {
        try {
          await binaryRuntime.binaryEntryProvider.release();
        } catch (releaseError) {
          throw new AggregateError(
            [error, releaseError],
            'Packaged DSL 4.0 startup and entry source release failed',
          );
        } finally {
          binaryRuntime = null;
        }
      }
      throw error;
    }
    shell.runtimeHost.attach(globalThis.document);

    this.shell = shell;
    this.binaryRuntimeSurface = binaryRuntime?.surface ?? null;
    const startAfterTitle =
      applicationMode === 'story'
        ? startRuntime
        : async () => {
            if (this.shell !== shell) return;
            this.pendingStart = null;
            this.hideScratchTitle();
            this.showScratchMenu(this.titleLocale);
            Scratch.vm.runtime.startHats('event_whenbroadcastreceived', {
              BROADCAST_OPTION: 'showMenu',
            });
            this.status = 'menu';
          };
    if (showTitle) {
      this.pendingStart = {shell, start: startAfterTitle};
      this.status = 'title';
      this.showScratchTitle(this.titleLocale);
    } else {
      await startAfterTitle();
    }
  }
}

try {
  if (!Scratch?.extensions?.unsandboxed) {
    throw new Error('Kamishibai DSL 4.0 Runtime must run unsandboxed.');
  }
  Scratch.extensions.register(new KamishibaiDsl4RuntimeExtension(Scratch));
} catch (error) {
  console.error('[Kamishibai DSL 4.0] extension-bootstrap failed.', loggedError(error));
  throw error;
}
