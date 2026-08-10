import schema from '../../schema/dsl-4.schema.json' with {type: 'json'};

import {createDsl4ProductionSourceFrontend} from '../../src/builder/dsl4-source-frontend.js';
import {dsl4StandardProductionFeatureFlags} from '../../src/dsl4/feature-flags.js';
import {createDsl4BrowserRemoteAssetLoader} from '../../src/dsl4/platform/browser-remote-asset-loader.js';
import {createDsl4BundledTMPoseRuntime} from '../../src/dsl4/platform/posenet-bundle.js';
import {createDsl4RuntimeErrorIndicator} from '../../src/dsl4/platform/runtime-error-indicator.js';
import {createDsl4StandardAppShell} from '../../src/dsl4/platform/standard-app-shell.js';
import {createDsl4TurboWarpTransitionPort} from '../../src/dsl4/platform/turbowarp-transition-port.js';
import {dsl4RuntimeProvenance} from '../../src/dsl4/runtime-provenance.js';
import {appShellCommon, appShellLocales} from './app-shell-locales.mjs';

/* global Scratch, tmPose */

const extensionId = 'kubohiroyakamishibai4';
const extensionVersion = '4.0.0-dev';
const limits = Object.freeze({
  maxSourceBytes: 64 * 1024,
  maxAssetFiles: 64,
  maxAssetBytes: 64 * 1024 * 1024,
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
function packagedApplicationMode(project) {
  const mode =
    project?.extensionStorage?.kubohiroyakamishibai4?.components?.kubohiroyakamishibairuntime4
      ?.application?.mode;
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

    const runtime = Scratch.vm.runtime;
    runtime.on('PROJECT_STOP_ALL', () =>
      this.enqueue(() => this.stop('project-stop-all'), 'shutdown'),
    );
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
      return undefined;
    }
    return pendingStart.start();
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
    const website = runtime.getSpriteTargetByName('officialWebsiteButton');
    const close = runtime.getSpriteTargetByName('closeTitleButton');
    this.setTargetCostume(stage, locale === 'ja' ? 'TitleRuntime' : 'Title');
    this.setTargetCostume(
      website,
      locale === 'ja' ? 'official-website-button-runtime' : 'official-website-button',
    );
    website?.setVisible?.(true);
    close?.setVisible?.(true);
    this.setStageCursor('pointer');
  }

  hideScratchTitle() {
    for (const name of ['officialWebsiteButton', 'closeTitleButton']) {
      this.Scratch.vm.runtime.getSpriteTargetByName(name)?.setVisible?.(false);
    }
    this.setStageCursor('');
  }

  showScratchMenu(locale) {
    const stage = this.Scratch.vm.runtime.getTargetForStage();
    this.setTargetCostume(stage, locale === 'ja' ? 'MenuRuntime' : 'Menu');
    this.setStageCursor('pointer');
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
    const errorIndicator = this.errorIndicator;
    this.errorIndicator = null;
    errorIndicator?.dispose();
    const shell = this.shell;
    this.shell = null;
    if (shell) await shell.dispose(reason);
    if (['running', 'starting', 'title'].includes(this.status)) this.status = 'stopped';
  }

  async restart() {
    await this.stop('project-restart');
    this.status = 'starting';
    this.lastError = '';

    const Scratch = this.Scratch;
    const project = JSON.parse(Scratch.vm.toJSON());
    const applicationMode = packagedApplicationMode(project);
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
          const covered = await shell.runtimeHost.showCover();
          Scratch.vm.runtime.startHats('event_whenbroadcastreceived', {
            BROADCAST_OPTION: 'showCover',
          });
          Scratch.vm.runtime.startHats('event_whenbroadcastreceived', {
            BROADCAST_OPTION: 'showMenu',
          });
          this.status = covered ? 'cover' : 'menu';
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
    this.pendingStart = {shell, start: startAfterTitle};
    this.status = 'title';
    this.titleLocale = browserLocale();
    this.showScratchTitle(this.titleLocale);
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
