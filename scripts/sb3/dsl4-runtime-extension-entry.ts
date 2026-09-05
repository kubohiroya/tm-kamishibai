import {createTurboWarpRuntimeHost} from '@kubohiroya/turbowarp-runtime-host';

import schema from '../../schema/dsl-4.schema.json' with {type: 'json'};

import {createDsl4ProductionSourceFrontend} from '../../dist/builder/dsl4-source-frontend.js';
import {
  dsl4StandardProductionFeatureFlags,
  resolveDsl4FeatureFlags,
} from '../../dist/dsl4/feature-flags.js';
import {createDsl4BrowserRemoteAssetLoader} from '../../dist/dsl4/platform/browser-remote-asset-loader.js';
import {createDsl4ProjectTMRuntime} from '../../dist/dsl4/platform/posenet-bundle.js';
import {createDsl4PackagedBinaryRuntimeBridge} from '../../dist/dsl4/platform/packaged-binary-runtime.js';
import {createDsl4RuntimeErrorIndicator} from '../../dist/dsl4/platform/runtime-error-indicator.js';
import {createDsl4RuntimeApplicationMenu} from '../../dist/dsl4/platform/runtime-application-menu.js';
import {createDsl4RuntimeTitleControls} from '../../dist/dsl4/platform/runtime-title-controls.js';
import {createDsl4RuntimeWarningIndicator} from '../../dist/dsl4/platform/runtime-warning-indicator.js';
import {
  createDsl4SessionBackingFatalDiagnostic,
  createDsl4SessionBackingWarningDiagnostic,
} from '../../dist/dsl4/platform/session-backing-diagnostic.js';
import {createDsl4StandardAppShell} from '../../dist/dsl4/platform/standard-app-shell.js';
import {
  createDsl4TurboWarpBlockSourceSurface,
  createDsl4TurboWarpCoreActionBlockAdapter,
  createDsl4TurboWarpCoreActionBlockSurface,
} from '../../dist/dsl4/platform/turbowarp-core-action-block.js';
import {
  coerceDsl4StoryVariableBlockValue,
  createDsl4TurboWarpRuntimeVariableBlockSurface,
} from '../../dist/dsl4/platform/turbowarp-runtime-variable-block.js';
import {createDsl4TurboWarpTransitionPort} from '../../dist/dsl4/platform/turbowarp-transition-port.js';
import {dsl4RuntimeProvenance} from '../../dist/dsl4/runtime-provenance.js';
import {appShellCommon, appShellLocales} from './app-shell-locales.mjs';
import {installDsl4RuntimeAuthoringProfile} from './dsl4-runtime-authoring-profile.js';

const extensionId = 'kubohiroyakamishibairuntime4';
const extensionVersion = '4.0.0-rc.12';
const blockIconURI = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="10" width="48" height="44" rx="4"/><path d="M8 21h48"/></g><path fill="#fff" d="m27 29 15 8-15 8Z"/></svg>',
)}`;
const applicationMenuIcons = DSL4_APPLICATION_MENU_ICONS;
const officialWebsiteIcon = DSL4_OFFICIAL_WEBSITE_ICON;
const limits = Object.freeze({
  maxSourceBytes: 1024 * 1024,
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

function resolveRuntimeMount(Scratch: any) {
  const canvas = Scratch?.vm?.renderer?.canvas;
  const parent = canvas?.parentElement ?? canvas?.parentNode;
  if (parent && typeof parent.appendChild === 'function') return parent;
  return globalThis.document?.body;
}

function resolveBundledTMRuntime() {
  const runtime =
    typeof tmPose === 'object' && tmPose !== null
      ? tmPose
      : (globalThis as Record<string, any>).tmPose;
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

function packagedRuntimeComponent(project: Record<string, any>) {
  return (
    project?.extensionStorage?.kubohiroyakamishibai4?.components?.kubohiroyakamishibairuntime4 ??
    project?.extensionStorage?.kubohiroyakamishibairuntime4
  );
}

function packagedApplicationMode(project: Record<string, any>) {
  const mode = packagedRuntimeComponent(project)?.application?.mode;
  return mode === 'menu' ? 'menu' : 'story';
}

function isSourceDiagnostic(code: string) {
  return sourceDiagnosticPrefixes.some((prefix) => code.startsWith(prefix));
}

function loggedError(failure: any) {
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

const productionFeatureFlags = resolveDsl4FeatureFlags(dsl4StandardProductionFeatureFlags);

declare const DSL4_APPLICATION_MENU_ICONS: Readonly<Record<string, string>>;
declare const DSL4_OFFICIAL_WEBSITE_ICON: string;
declare const DSL4_AUTHORING_PROFILE: boolean;
declare const tmPose: Record<string, any>;
declare const Scratch: Record<string, any>;

class KamishibaiDsl4RuntimeExtension {
  storyVariableWriteResults: any;
  Scratch: any;
  turboWarpHost: any;
  declare buildDistributionSb3: any;
  coreActionBlockAdapter: any;
  frontend: any;
  declare installDropTarget: any;
  declare isDistributionBuildEnabled: any;
  declare openStoryFile: any;
  operation: any;
  declare startAuthoringMenu: any;
  shell: any;
  errorIndicator: any;
  warningIndicator: any;
  binaryRuntimeSurface: any;
  pendingStart: any;
  status: string;
  lastError: string;
  titleLocale: string;
  selectedProject: any;
  previewShell: any;
  previewLiveReload: any;
  previewDebugExecution: any;
  previewGenerationComponents: any;
  previewHasCurrent: boolean;
  distributionBuildStatus: string;
  fileInput: any;
  applicationMenu: any;
  titleControls: any;
  sourceChooser: any;
  lastStoryVariableWriteResult: boolean;

  constructor(Scratch: any) {
    this.Scratch = Scratch;
    this.frontend = createDsl4ProductionSourceFrontend(schema, {
      runtimeStateExpressionsEnabled: productionFeatureFlags.dsl4ExpressionRuntimeState,
    });
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
    this.lastStoryVariableWriteResult = false;
    this.storyVariableWriteResults = new WeakMap();

    this.turboWarpHost = createTurboWarpRuntimeHost({Scratch, requireUnsandboxed: true});
    this.turboWarpHost.onRuntimeEvent('PROJECT_STOP_ALL', () =>
      this.enqueue(() => this.stop('project-stop-all'), 'shutdown'),
    );
    if (DSL4_AUTHORING_PROFILE) this.installDropTarget();
    this.ensureTitleControls()?.show('en');
    this.setStageCursor('pointer');
  }

  getInfo() {
    const {ArgumentType, BlockType} = this.Scratch;
    const coreActionSurface = createDsl4TurboWarpCoreActionBlockSurface(
      {ArgumentType, BlockType},
      {visible: productionFeatureFlags.dsl4TurboWarpActionSurface},
    );
    const runtimeVariableSurface = createDsl4TurboWarpRuntimeVariableBlockSurface(
      {ArgumentType, BlockType},
      {
        stateVisible: productionFeatureFlags.dsl4TurboWarpStateSurface === true,
        writeVisible: productionFeatureFlags.dsl4TurboWarpStoryVariableWrite === true,
      },
    );
    const blockSourceSurface = createDsl4TurboWarpBlockSourceSurface(
      {ArgumentType, BlockType},
      {visible: productionFeatureFlags.dsl4TurboWarpActionSurface},
    );
    return {
      id: extensionId,
      name: 'Kamishibai DSL 4.0 Runtime',
      description:
        'Participatory AI Kamishibai runtime. This source-composed extension preserves the original component notices in its source header.',
      docsURI:
        'https://kubohiroya.github.io/tm-kamishibai-docs/4.0/turbowarp-programmer-guides/dsl-4.0-runtime-block-reference/',
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
        ...blockSourceSurface.blocks,
        ...coreActionSurface.blocks,
        ...runtimeVariableSurface.blocks,
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
      menus: {...coreActionSurface.menus, ...runtimeVariableSurface.menus},
    };
  }

  versionReporter() {
    return extensionVersion;
  }

  whenDsl4Source() {
    return false;
  }

  dsl4SourceFromYamlJson() {
    return undefined;
  }

  runtimeVersionReporter() {
    return extensionVersion;
  }

  runtimeVariableInvoker() {
    return this.shell?.runtimeHost ?? this.previewLiveReload;
  }

  runtimeVariableSnapshot() {
    if (!productionFeatureFlags.dsl4TurboWarpStateSurface) return null;
    return this.runtimeVariableInvoker()?.getRuntimeVariableSnapshot?.() ?? null;
  }

  storyVariableReporter(args: any) {
    const variables = this.runtimeVariableSnapshot()?.storyVariables;
    const name = String(args?.NAME ?? '');
    return variables && Object.hasOwn(variables, name) ? variables[name] : '';
  }

  storyVariableExists(args: any) {
    const variables = this.runtimeVariableSnapshot()?.storyVariables;
    return Boolean(variables && Object.hasOwn(variables, String(args?.NAME ?? '')));
  }

  storyVariableType(args: any) {
    const variables = this.runtimeVariableSnapshot()?.storyVariables;
    const name = String(args?.NAME ?? '');
    return variables && Object.hasOwn(variables, name) ? typeof variables[name] : 'unknown';
  }

  storyStatusReporter() {
    return this.runtimeVariableSnapshot()?.runtime?.status ?? 'idle';
  }

  currentSceneIdReporter() {
    return this.runtimeVariableSnapshot()?.runtime?.['scene.id'] ?? '';
  }

  currentActionNumberReporter() {
    return this.runtimeVariableSnapshot()?.runtime?.['action.number'] ?? 0;
  }

  currentActionPathReporter() {
    return this.runtimeVariableSnapshot()?.runtime?.['action.path'] ?? '';
  }

  lastRuntimeErrorCodeReporter() {
    return this.runtimeVariableSnapshot()?.diagnostic?.code ?? '';
  }

  lastRuntimeErrorStoryPathReporter() {
    return this.runtimeVariableSnapshot()?.diagnostic?.storyPath ?? '';
  }

  posePhaseReporter() {
    return this.runtimeVariableSnapshot()?.runtime?.['pose.phase'] ?? 'inactive';
  }

  poseTargetReporter() {
    return this.runtimeVariableSnapshot()?.runtime?.['pose.target'] ?? '';
  }

  poseNameReporter() {
    return this.runtimeVariableSnapshot()?.runtime?.['pose.name'] ?? '';
  }

  poseStepNumberReporter() {
    return this.runtimeVariableSnapshot()?.runtime?.['pose.stepNumber'] ?? 0;
  }

  applicationStatusReporter() {
    return productionFeatureFlags.dsl4TurboWarpStateSurface ? this.status : 'ready';
  }

  canNavigateToPreviousAction() {
    if (!productionFeatureFlags.dsl4TurboWarpStateSurface) return false;
    const state = this.runtimeVariableInvoker()?.getState?.();
    return Boolean(state?.historyEnabled && state?.history?.actionCursor > 0);
  }

  canNavigateToNextAction() {
    if (!productionFeatureFlags.dsl4TurboWarpStateSurface) return false;
    const state = this.runtimeVariableInvoker()?.getState?.();
    if (state?.historyEnabled && state?.history?.mode === 'history') {
      return state.history.actionCursor < state.history.actionEntries.length;
    }
    return state?.runtime?.status === 'running';
  }

  rememberStoryVariableWrite(result: any, util: any) {
    const accepted = result?.accepted === true;
    this.lastStoryVariableWriteResult = accepted;
    if (util?.thread && typeof util.thread === 'object') {
      this.storyVariableWriteResults.set(util.thread, accepted);
    }
    return result;
  }

  setStoryVariable(args: any, util: any) {
    if (!productionFeatureFlags.dsl4TurboWarpStoryVariableWrite) {
      return this.rememberStoryVariableWrite({accepted: false}, util);
    }
    const converted = coerceDsl4StoryVariableBlockValue(args?.VALUE, String(args?.TYPE ?? ''));
    if (!converted.ok) return this.rememberStoryVariableWrite({accepted: false}, util);
    const result = this.runtimeVariableInvoker()?.queueVariableWrite?.({
      operation: 'set',
      name: String(args?.NAME ?? ''),
      value: converted.value,
    });
    return this.rememberStoryVariableWrite(result, util);
  }

  changeNumberStoryVariable(args: any, util: any) {
    if (!productionFeatureFlags.dsl4TurboWarpStoryVariableWrite) {
      return this.rememberStoryVariableWrite({accepted: false}, util);
    }
    const delta = Number(args?.DELTA);
    const result = Number.isFinite(delta)
      ? this.runtimeVariableInvoker()?.queueVariableWrite?.({
          operation: 'change',
          name: String(args?.NAME ?? ''),
          value: delta,
        })
      : {accepted: false};
    return this.rememberStoryVariableWrite(result, util);
  }

  lastStoryVariableWriteAccepted(_args: any, util: any) {
    if (!productionFeatureFlags.dsl4TurboWarpStoryVariableWrite) return false;
    return util?.thread && typeof util.thread === 'object'
      ? (this.storyVariableWriteResults.get(util.thread) ?? false)
      : this.lastStoryVariableWriteResult;
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
    const threads = this.turboWarpHost.startHats('event_whenbroadcastreceived', {
      BROADCAST_OPTION: 'closeTitle',
    });
    if (threads.length === 0) return this.closeTitle();
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

  async invokeCoreActionBlock(command: any, args: any) {
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

  stage(args: any) {
    return this.invokeCoreActionBlock('stage', args);
  }

  bgm(args: any) {
    return this.invokeCoreActionBlock('bgm', args);
  }

  sound(args: any) {
    return this.invokeCoreActionBlock('sound', args);
  }

  wait(args: any) {
    return this.invokeCoreActionBlock('wait', args);
  }

  debugger(args: any) {
    return this.invokeCoreActionBlock('debugger', args);
  }

  broadcastMessageAndWait(args: any) {
    return this.invokeCoreActionBlock('broadcastMessageAndWait', args);
  }

  transition(args: any) {
    return this.invokeCoreActionBlock('transition', args);
  }

  goto(args: any) {
    return this.invokeCoreActionBlock('goto', args);
  }

  branch(args: any) {
    return this.invokeCoreActionBlock('branch', args);
  }

  keyInputToChangeScene(args: any) {
    return this.invokeCoreActionBlock('keyInputToChangeScene', args);
  }

  touchInputToChangeScene(args: any) {
    return this.invokeCoreActionBlock('touchInputToChangeScene', args);
  }

  poseInputToChangeScene(args: any) {
    return this.invokeCoreActionBlock('poseInputToChangeScene', args);
  }

  imageInputToChangeScene(args: any) {
    return this.invokeCoreActionBlock('imageInputToChangeScene', args);
  }

  show(args: any) {
    return this.invokeCoreActionBlock('show', args);
  }

  hide(args: any) {
    return this.invokeCoreActionBlock('hide', args);
  }

  setTransparency(args: any) {
    return this.invokeCoreActionBlock('setTransparency', args);
  }

  moveTo(args: any) {
    return this.invokeCoreActionBlock('moveTo', args);
  }

  say(args: any) {
    return this.invokeCoreActionBlock('say', args);
  }

  think(args: any) {
    return this.invokeCoreActionBlock('think', args);
  }

  setSkin(args: any) {
    return this.invokeCoreActionBlock('setSkin', args);
  }

  setLayer(args: any) {
    return this.invokeCoreActionBlock('setLayer', args);
  }

  loop(args: any) {
    return this.invokeCoreActionBlock('loop', args);
  }

  setText(args: any) {
    return this.invokeCoreActionBlock('setText', args);
  }

  pose(args: any) {
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
        openVisible: DSL4_AUTHORING_PROFILE,
        ...(DSL4_AUTHORING_PROFILE ? {onOpen: () => this.openStoryFile()} : {}),
        onReload: () => this.reloadStory(),
        ...(DSL4_AUTHORING_PROFILE ? {onBuild: () => this.buildDistributionSb3()} : {}),
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

  setTargetCostume(target: any, costumeName: any) {
    const costumes = target?.sprite?.costumes;
    const index = Array.isArray(costumes)
      ? costumes.findIndex((costume) => costume?.name === costumeName)
      : -1;
    if (index < 0 || typeof target?.setCostume !== 'function') {
      throw new Error(`The packaged title costume is unavailable: ${costumeName}`);
    }
    target.setCostume(index);
  }

  setStageCursor(cursor: any) {
    const canvas = this.Scratch?.vm?.renderer?.canvas;
    if (canvas?.style) canvas.style.cursor = cursor;
    const mount = resolveRuntimeMount(this.Scratch);
    if (mount?.style) mount.style.cursor = cursor;
  }

  hideAllDisplayTargets() {
    const targets = this.turboWarpHost.runtime.targets;
    if (!Array.isArray(targets)) return;
    for (const target of targets) {
      if (target?.isStage === true) continue;
      if (typeof target?.setVisible === 'function') target.setVisible(false);
    }
  }

  showScratchTitle(locale: any) {
    const stage = this.turboWarpHost.getStageTarget();
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

  showScratchMenu(locale: any) {
    const stage = this.turboWarpHost.getStageTarget();
    this.hideScratchTitle();
    this.sourceChooser?.hide();
    this.setTargetCostume(stage, locale === 'ja' ? 'MenuRuntime' : 'Menu');
    const menu = this.ensureApplicationMenu();
    menu?.setReloadEnabled(
      this.selectedProject !== null || this.shell !== null || this.previewHasCurrent,
    );
    const buildVisible =
      DSL4_AUTHORING_PROFILE && this.previewShell !== null && this.isDistributionBuildEnabled();
    const buildState = buildVisible
      ? this.previewShell.getDistributionBuildState()
      : {enabled: false, reason: null};
    menu?.setBuildState({
      visible: buildVisible,
      enabled: buildState.enabled === true,
      status:
        this.distributionBuildStatus ||
        (buildVisible && buildState.enabled !== true
          ? (appShellLocales as Record<string, any>)[locale].ui.buildUnavailable
          : ''),
    });
    menu?.show(locale);
    this.setStageCursor('pointer');
  }

  hideScratchMenu() {
    this.applicationMenu?.hide();
    this.setStageCursor('auto');
  }

  enqueue(operation: any, phase = 'operation') {
    this.operation = this.operation.then(operation, operation).catch((error: any) => {
      this.reportFailure(error, phase);
    });
    return this.operation;
  }

  reportFailure(failure: any, phase: any) {
    this.showFailure(failure);
    console.error(`[Kamishibai DSL 4.0] ${phase} failed.`, loggedError(failure));
  }

  showSessionBackingWarning(warning: any) {
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

  showSessionBackingFatal(failure: any) {
    const diagnostic = createDsl4SessionBackingFatalDiagnostic(failure, browserLocale());
    this.warningIndicator?.hide();
    this.reportFailure(diagnostic, 'session-binary-backing');
  }

  showFailure(failure: any, {returnToMenu = false} = {}) {
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

  async stop(reason: any) {
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
    const turboWarpHost = this.turboWarpHost;
    const packagedProject = JSON.parse(Scratch.vm.toJSON());
    const project = projectOverride ?? this.selectedProject ?? packagedProject;
    const applicationMode =
      forceStory || this.selectedProject ? 'story' : packagedApplicationMode(project);
    this.titleLocale = browserLocale();
    if (applicationMode === 'menu') {
      if (!DSL4_AUTHORING_PROFILE) {
        throw new Error('The playback runtime cannot open a non-embedded authoring project.');
      }
      await this.startAuthoringMenu(project, {showTitle});
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
    let shell: any;
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
          turboWarpHost.startHats('event_whenbroadcastreceived', {
            BROADCAST_OPTION: 'showCover',
          });
          this.showScratchMenu(this.titleLocale);
          turboWarpHost.startHats('event_whenbroadcastreceived', {
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
          runtimeVersion: extensionVersion,
          project,
          sourceFrontend: this.frontend,
          ...limits,
          ...(binaryRuntime
            ? {
                ...binaryRuntime.runtimeLimits,
                assetBundleFormat: binaryRuntime.assetBundleFormat,
                binaryEntryProvider: binaryRuntime.binaryEntryProvider,
                sessionBacking: binaryRuntime.sessionBacking,
                onSessionBackingWarning: (warning: any) => this.showSessionBackingWarning(warning),
                onSessionBackingFatalError: (failure: any) => this.showSessionBackingFatal(failure),
              }
            : {}),
          runtime: turboWarpHost.runtime,
          onTitleStart() {
            turboWarpHost.startHats('event_whenbroadcastreceived', {
              BROADCAST_OPTION: 'closeTitle',
            });
          },
          createHostPort: async ({runtime}: {runtime: any}) =>
            createDsl4TurboWarpTransitionPort({runtime}),
          tmPoseRuntime: createDsl4ProjectTMRuntime({
            runtime: resolveBundledTMRuntime(),
            globalObject: globalThis,
            project,
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
            turboWarpHost.startHats('event_whenbroadcastreceived', {
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

if (DSL4_AUTHORING_PROFILE) {
  installDsl4RuntimeAuthoringProfile(KamishibaiDsl4RuntimeExtension, {
    runtimeVersion: extensionVersion,
    limits,
    resolveRuntimeMount,
    resolveBundledTMRuntime,
    loggedError,
    createRemoteAssetLoader: createDsl4BrowserRemoteAssetLoader as (options: object) => any,
    createProjectTMRuntime: createDsl4ProjectTMRuntime as unknown as (options: object) => any,
    createTransitionPort: createDsl4TurboWarpTransitionPort as unknown as (
      options: object,
    ) => Promise<any>,
  });
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
