import schema from '../../schema/dsl-4.schema.json' with {type: 'json'};

import {createDsl4ProductionSourceFrontend} from '../../src/builder/dsl4-source-frontend.js';
import {dsl4StandardProductionFeatureFlags} from '../../src/dsl4/feature-flags.js';
import {createDsl4BrowserRemoteAssetLoader} from '../../src/dsl4/platform/browser-remote-asset-loader.js';
import {
  buildDsl4BrowserSelectedStoryProject,
  collectDsl4BrowserDroppedFiles,
} from '../../src/dsl4/platform/browser-story-file-loader.js';
import {createDsl4BundledTMPoseRuntime} from '../../src/dsl4/platform/posenet-bundle.js';
import {createDsl4RuntimeErrorIndicator} from '../../src/dsl4/platform/runtime-error-indicator.js';
import {createDsl4RuntimeApplicationMenu} from '../../src/dsl4/platform/runtime-application-menu.js';
import {createDsl4RuntimeTitleControls} from '../../src/dsl4/platform/runtime-title-controls.js';
import {createDsl4StandardAppShell} from '../../src/dsl4/platform/standard-app-shell.js';
import {createDsl4TurboWarpTransitionPort} from '../../src/dsl4/platform/turbowarp-transition-port.js';
import {dsl4RuntimeProvenance} from '../../src/dsl4/runtime-provenance.js';
import {appShellCommon, appShellLocales} from './app-shell-locales.mjs';

/* global DSL4_APPLICATION_MENU_ICONS, DSL4_OFFICIAL_WEBSITE_ICON, Scratch, tmPose */

const extensionId = 'kubohiroyakamishibai4';
const extensionVersion = '4.0.0-dev';
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
  'K4-ASSET-REMOTE-URL',
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

/** @param {Record<string, any>} project */
function packagedRuntimeComponent(project) {
  return project?.extensionStorage?.kubohiroyakamishibai4?.components?.kubohiroyakamishibairuntime4;
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
    this.shell = null;
    this.errorIndicator = null;
    this.pendingStart = null;
    this.operation = Promise.resolve();
    this.status = 'ready';
    this.lastError = '';
    this.titleLocale = 'en';
    this.selectedProject = null;
    this.fileInput = null;
    this.applicationMenu = null;
    this.titleControls = null;

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
    return {
      id: extensionId,
      name: 'Kamishibai DSL 4.0 Runtime',
      description:
        'Participatory AI Kamishibai runtime. This source-composed extension preserves the original component notices in its source header.',
      docsURI: 'https://kubohiroya.github.io/tmpose-kamishibai/',
      creator: 'Hiroya Kubo',
      license: 'MPL-2.0',
      credits: dsl4RuntimeProvenance
        .map(
          (component) =>
            `${component.title} — ${component.copyright} — ${component.license} (${component.source}@${component.version})`,
        )
        .join('\n'),
      blocks: [
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
        onAbout: () => this.showAbout(),
        onLocaleChange: (locale) => {
          this.titleLocale = locale;
          this.showScratchMenu(locale);
        },
        onError: (error) => this.reportFailure(error, 'application-menu'),
        reloadEnabled: this.selectedProject !== null || this.shell !== null,
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

  openStoryFile() {
    if (this.status !== 'menu') return undefined;
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
    this.setTargetCostume(stage, locale === 'ja' ? 'MenuRuntime' : 'Menu');
    const menu = this.ensureApplicationMenu();
    menu?.setReloadEnabled(this.selectedProject !== null || this.shell !== null);
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

  showFailure(failure) {
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
    try {
      this.errorIndicator ??= createDsl4RuntimeErrorIndicator({
        document: globalThis.document,
        mount: resolveRuntimeMount(this.Scratch),
        locales: {
          en: {title: appShellLocales.en.ui.invalidScript},
          ja: {title: appShellLocales.ja.ui.invalidScript},
        },
      });
      this.errorIndicator.show({message, code, title});
    } catch (indicatorError) {
      console.error('Kamishibai DSL 4.0 error indicator failed.', indicatorError);
    }
  }

  async stop(reason) {
    this.pendingStart = null;
    this.hideScratchTitle();
    this.hideScratchMenu();
    const errorIndicator = this.errorIndicator;
    this.errorIndicator = null;
    errorIndicator?.dispose();
    const shell = this.shell;
    this.shell = null;
    if (shell) await shell.dispose(reason);
    if (['running', 'starting', 'title'].includes(this.status)) this.status = 'stopped';
  }

  async restart({projectOverride = null, showTitle = true, forceStory = false} = {}) {
    await this.stop('project-restart');
    this.status = 'starting';
    this.lastError = '';

    const Scratch = this.Scratch;
    const packagedProject = JSON.parse(Scratch.vm.toJSON());
    const project = projectOverride ?? this.selectedProject ?? packagedProject;
    const applicationMode =
      forceStory || this.selectedProject ? 'story' : packagedApplicationMode(project);
    this.titleLocale = browserLocale();
    if (applicationMode === 'menu') {
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
          this.reportFailure(
            result.diagnostic ?? 'DSL 4.0 story execution failed.',
            'story-runtime',
          );
          return;
        }
        if (result.status === 'finished') {
          await shell.runtimeHost.showCover();
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
        this.reportFailure(error, 'story-runtime');
      }
    };
    shell = await createDsl4StandardAppShell({
      featureFlags: dsl4StandardProductionFeatureFlags,
      surface: 'regularEditor',
      document: globalThis.document,
      mount: resolveRuntimeMount(Scratch),
      runtimeHostOptions: {
        project,
        sourceFrontend: this.frontend,
        ...limits,
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
    shell.runtimeHost.attach(globalThis.document);

    this.shell = shell;
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
