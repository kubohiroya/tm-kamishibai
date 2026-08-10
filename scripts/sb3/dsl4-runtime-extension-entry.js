import schema from '../../schema/dsl-4.schema.json' with {type: 'json'};

import {createDsl4ProductionSourceFrontend} from '../../src/builder/dsl4-source-frontend.js';
import {createDsl4BrowserRemoteAssetLoader} from '../../src/dsl4/platform/browser-remote-asset-loader.js';
import {createDsl4BundledTMPoseRuntime} from '../../src/dsl4/platform/posenet-bundle.js';
import {createDsl4RuntimeErrorIndicator} from '../../src/dsl4/platform/runtime-error-indicator.js';
import {createDsl4StandardAppShell} from '../../src/dsl4/platform/standard-app-shell.js';
import {dsl4RuntimeProvenance} from '../../src/dsl4/runtime-provenance.js';
import {appShellCommon, appShellLocales} from './app-shell-locales.mjs';

/* global Scratch */

const extensionId = 'kubohiroyakamishibai4';
const extensionVersion = '4.0.0-dev';
const limits = Object.freeze({
  maxSourceBytes: 64 * 1024,
  maxAssetFiles: 64,
  maxAssetBytes: 64 * 1024 * 1024,
});

/** @param {any} Scratch */
function resolveRuntimeMount(Scratch) {
  const canvas = Scratch?.vm?.renderer?.canvas;
  const parent = canvas?.parentElement ?? canvas?.parentNode;
  if (parent && typeof parent.appendChild === 'function') return parent;
  return globalThis.document?.body;
}

function fallbackTMPoseRuntime() {
  return Object.freeze({
    Webcam: class {},
    async loadFromFiles() {
      throw new Error('This story requires the Teachable Machine Pose runtime.');
    },
  });
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

    const runtime = Scratch.vm.runtime;
    runtime.on('PROJECT_STOP_ALL', () => this.enqueue(() => this.stop('project-stop-all')));
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
    return this.enqueue(() => this.restart());
  }

  closeTitle() {
    const pendingStart = this.pendingStart;
    if (!pendingStart || pendingStart.shell !== this.shell) {
      this.shell?.hideTitle?.();
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
    this.shell?.toggleTitleLanguage?.();
  }

  enqueue(operation) {
    this.operation = this.operation.then(operation, operation).catch((error) => {
      this.showFailure(error);
      console.error('Kamishibai DSL 4.0 runtime failed.', error);
    });
    return this.operation;
  }

  showFailure(failure) {
    const message = String(failure?.message ?? failure ?? 'DSL 4.0 story execution failed.');
    const code = typeof failure?.code === 'string' ? failure.code : '';
    this.status = 'error';
    this.lastError = message;
    this.shell?.hideTitle?.();
    for (const name of ['officialWebsiteButton', 'closeTitleButton']) {
      this.Scratch.vm.runtime.getSpriteTargetByName(name)?.setVisible?.(false);
    }
    try {
      this.errorIndicator ??= createDsl4RuntimeErrorIndicator({
        document: globalThis.document,
        mount: resolveRuntimeMount(this.Scratch),
        locales: {
          en: {title: appShellLocales.en.ui.invalidScript},
          ja: {title: appShellLocales.ja.ui.invalidScript},
        },
      });
      this.errorIndicator.show({message, code});
    } catch (indicatorError) {
      console.error('Kamishibai DSL 4.0 error indicator failed.', indicatorError);
    }
  }

  async stop(reason) {
    this.pendingStart = null;
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
    const loadRemoteAsset = createDsl4BrowserRemoteAssetLoader({maxBytes: limits.maxAssetBytes});
    let shell;
    let started = false;
    const startRuntime = async () => {
      if (started || this.shell !== shell) return;
      started = true;
      this.pendingStart = null;
      shell.hideTitle();
      for (const name of ['officialWebsiteButton', 'closeTitleButton']) {
        const target = Scratch.vm.runtime.getSpriteTargetByName(name);
        target?.setVisible?.(false);
      }
      this.status = 'running';
      try {
        const result = await shell.runtimeHost.start();
        if (this.shell !== shell) return;
        if (result.status === 'failed') {
          this.showFailure(result.diagnostic ?? 'DSL 4.0 story execution failed.');
          return;
        }
        this.status = result.status;
      } catch (error) {
        if (this.shell !== shell) return;
        this.showFailure(error);
      }
    };
    shell = await createDsl4StandardAppShell({
      featureFlags: {
        dsl4Runtime: true,
        dsl4AppShell: true,
        dsl4PoseFeedbackModes: true,
        dsl4SpeechAdvanceTypewriter: true,
      },
      surface: 'regularEditor',
      document: globalThis.document,
      mount: resolveRuntimeMount(Scratch),
      // The title overlay is created hidden until its click gate releases the runtime.
      title: {
        version: extensionVersion,
        officialWebsiteUrl: appShellCommon.about.officialWebsite.url,
        locales: {
          en: {
            title: appShellLocales.en.about.title,
            officialWebsite: appShellLocales.en.about.officialWebsite.name,
            close: appShellLocales.en.ui.close,
            language: '日本語',
          },
          ja: {
            title: appShellLocales.ja.about.title,
            officialWebsite: appShellLocales.ja.about.officialWebsite.name,
            close: appShellLocales.ja.ui.close,
            language: 'English',
          },
        },
      },
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
        // The packaged Scratch surface has no separate transition renderer yet. Keep the
        // transition command consumable so a valid DSL 4.0 story can still start and run.
        createHostPort: async () => ({
          transition: async () => {},
        }),
        tmPoseRuntime: globalThis.tmPose
          ? createDsl4BundledTMPoseRuntime({runtime: globalThis.tmPose, globalObject: globalThis})
          : fallbackTMPoseRuntime(),
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
    if (shell.element) {
      for (const name of ['officialWebsiteButton', 'closeTitleButton']) {
        const target = Scratch.vm.runtime.getSpriteTargetByName(name);
        target?.setVisible?.(false);
      }
    }
    this.pendingStart = {shell, start: startRuntime};
    this.status = 'title';
    if (shell.titleElement) {
      shell.showTitle();
    }
  }
}

if (!Scratch?.extensions?.unsandboxed) {
  throw new Error('Kamishibai DSL 4.0 Runtime must run unsandboxed.');
}
Scratch.extensions.register(new KamishibaiDsl4RuntimeExtension(Scratch));
