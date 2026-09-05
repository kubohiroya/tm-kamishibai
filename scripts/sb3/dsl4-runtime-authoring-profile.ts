import {createDsl4WebPreviewShell} from '../../dist/builder/dsl4-web-preview-shell.js';
import {
  createDsl4BrowserPreviewStoryFileProject,
  inspectDsl4BrowserPreviewSupport,
} from '../../dist/dsl4/browser-preview-source-adapter.js';
import {createDsl4DebugExecutionCoordinator} from '../../dist/dsl4/debug-execution.js';
import {dsl4NonEmbeddedDevelopmentFeatureFlags} from '../../dist/dsl4/feature-flags.js';
import {createDsl4LiveReloadSession} from '../../dist/dsl4/live-reload-session.js';
import {
  createDsl4BrowserDistributionFilename,
  createDsl4BrowserDistributionSb3,
  requestDsl4BrowserDistributionSaveTarget,
  saveDsl4BrowserDistributionSb3,
} from '../../dist/dsl4/platform/browser-distribution-build.js';
import {createDsl4BrowserPreviewRuntimeComponent} from '../../dist/dsl4/platform/browser-preview-runtime-component.js';
import {
  buildDsl4BrowserSelectedStoryProject,
  collectDsl4BrowserDroppedFiles,
} from '../../dist/dsl4/platform/browser-story-file-loader.js';
import {createDsl4RuntimeSourceChooser} from '../../dist/dsl4/platform/runtime-source-chooser.js';
import {createDsl4TurboWarpPreviewSessionFactory} from '../../dist/dsl4/platform/turbowarp-preview-session.js';
import {createDsl4PreviewProtocolSession} from '../../dist/dsl4/preview-protocol.js';
import {loadDsl4RuntimeComponent} from '../../dist/dsl4/runtime-artifact-loader.js';
import {appShellLocales} from './app-shell-locales.mjs';

function pickerWasCancelled(error: unknown) {
  return (
    typeof error === 'object' && error !== null && (error as {name?: unknown}).name === 'AbortError'
  );
}

function filePickerSupported() {
  const host = globalThis as Record<string, any>;
  if (host.isSecureContext !== true || typeof host.showOpenFilePicker !== 'function') {
    return false;
  }
  try {
    return globalThis.self === globalThis.top;
  } catch {
    return false;
  }
}

/**
 * Install the non-embedded authoring surface onto the runtime class.
 * The playback build removes this call at compile time, allowing the bundler to
 * tree-shake this module and its complete dependency graph.
 */
export function installDsl4RuntimeAuthoringProfile(
  RuntimeExtension: new (...args: any[]) => any,
  {
    runtimeVersion,
    limits,
    resolveRuntimeMount,
    resolveBundledTMRuntime,
    loggedError,
    createRemoteAssetLoader,
    createProjectTMRuntime,
    createTransitionPort,
  }: {
    runtimeVersion: string;
    limits: Readonly<Record<string, number>>;
    resolveRuntimeMount: (Scratch: any) => any;
    resolveBundledTMRuntime: () => any;
    loggedError: (failure: unknown) => Error;
    createRemoteAssetLoader: (options: object) => any;
    createProjectTMRuntime: (options: object) => any;
    createTransitionPort: (options: object) => Promise<any>;
  },
) {
  const authoringProfile: Record<string, any> = {
    isDistributionBuildEnabled() {
      return dsl4NonEmbeddedDevelopmentFeatureFlags.dsl4BrowserDistributionBuild;
    },

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
    },

    installDropTarget() {
      const mount = resolveRuntimeMount(this.Scratch);
      if (
        !mount ||
        typeof mount.addEventListener !== 'function' ||
        typeof mount.removeEventListener !== 'function'
      ) {
        return;
      }
      const onDragOver = (event: any) => {
        if (this.status !== 'menu') return;
        event.preventDefault?.();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      };
      const onDrop = (event: any) => {
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
    },

    async initializeNonEmbeddedPreview(project: any) {
      if (this.previewShell) return this.previewShell;
      const document = globalThis.document;
      if (!document || Array.isArray(document.scripts)) return null;
      const component = await loadDsl4RuntimeComponent(project, this.frontend, {
        ...limits,
        subtleCrypto: globalThis.crypto?.subtle,
      } as unknown as Parameters<typeof loadDsl4RuntimeComponent>[2]);
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
      const loadRemoteAsset = createRemoteAssetLoader({maxBytes: limits.maxAssetBytes});
      let previewProjectRoot: Record<string, any> | null = null;
      const generationComponents = new WeakMap();
      const debugExecution = createDsl4DebugExecutionCoordinator({
        enabled: dsl4NonEmbeddedDevelopmentFeatureFlags.dsl4Debugger,
      });
      // eslint-disable-next-line prefer-const -- assigned after the observer closes over it
      let liveReload: any;
      const createSession = createDsl4TurboWarpPreviewSessionFactory({
        featureFlags: dsl4NonEmbeddedDevelopmentFeatureFlags,
        runtimeVersion,
        runtimeComponent: component,
        debugExecution,
        resolveRuntimeComponent({storyDocument}: {storyDocument: any}) {
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
        createHostPort: async ({runtime}: {runtime: any}) => createTransitionPort({runtime}),
        tmPoseRuntime: createProjectTMRuntime({
          runtime: resolveBundledTMRuntime(),
          globalObject: globalThis,
          project,
        }),
        setLoading() {},
        loadRemoteAsset,
        subtleCrypto: globalThis.crypto?.subtle,
        onEvent: (event: any) => {
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
          onProjectRoot: (projectRoot: any) => {
            previewProjectRoot = projectRoot;
          },
          prepareSourceResult: async (result: any) => {
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
          onDistributionBuildState: (state: any) => {
            if (this.status !== 'menu' || !this.applicationMenu) return;
            this.distributionBuildStatus =
              state.enabled === true
                ? ''
                : (appShellLocales as Record<string, any>)[this.titleLocale].ui.buildUnavailable;
            this.applicationMenu.setBuildState({
              visible: true,
              enabled: state.enabled === true,
              status: this.distributionBuildStatus,
            });
          },
          onDiagnostic: (diagnostic: any) => {
            if (diagnostic?.severity === 'error' && this.status === 'starting') {
              this.showFailure(diagnostic, {returnToMenu: true});
            }
          },
          ...(previewStorage === undefined ? {} : {previewStorage}),
          onError: (error: any) => this.reportFailure(error, 'preview-shell'),
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
    },

    openStoryFile() {
      if (this.status !== 'menu') return undefined;
      const projectSupported = inspectDsl4BrowserPreviewSupport({
        globalObject: globalThis,
      }).supported;
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
    },

    async completeWatchedSourceOpen(opening: any) {
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
    },

    openWatchedProjectDirectory() {
      if (this.status !== 'menu' || !this.previewShell) return undefined;
      const picker = (globalThis as Record<string, any>).showDirectoryPicker;
      if (typeof picker !== 'function')
        throw new Error('This browser cannot open a project folder.');
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
    },

    async startNewWatchedSource(projectRoot: any) {
      if (this.previewShell?.getSnapshot()?.coordinator?.source?.started === true) {
        await this.restart({showTitle: false});
      }
      if (!this.previewShell) throw new Error('The watched story preview is unavailable.');
      this.hideScratchMenu();
      this.status = 'starting';
      return this.completeWatchedSourceOpen(this.previewShell.start(projectRoot));
    },

    async openWatchedStoryFile() {
      if (this.status !== 'menu' || !this.previewShell) return undefined;
      const picker = (globalThis as Record<string, any>).showOpenFilePicker;
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
    },

    cancelSourceChoice() {
      this.sourceChooser?.hide();
      if (this.status !== 'error') {
        this.status = 'menu';
        this.showScratchMenu(this.titleLocale);
      }
    },

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
              entries.some(
                ({path}) => path.split('/').length - 1 > limits.maxSelectedDirectoryDepth,
              )
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
    },

    async loadSelectedEntries(entries: any) {
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
    },

    async buildDistributionSb3() {
      if (this.status !== 'menu' || !this.previewShell || !this.previewGenerationComponents) {
        return undefined;
      }
      const menu = this.ensureApplicationMenu();
      const ui = (appShellLocales as Record<string, any>)[this.titleLocale].ui;
      this.status = 'building';
      this.distributionBuildStatus = ui.buildPreparing;
      menu?.setBuildState({visible: true, enabled: false, status: this.distributionBuildStatus});
      this.setStageCursor('wait');
      try {
        const suggestedFilename = createDsl4BrowserDistributionFilename(
          this.previewShell.getSnapshot().sourceDisplayName,
        );
        const saveTarget = await requestDsl4BrowserDistributionSaveTarget({
          filename: suggestedFilename,
          globalObject: globalThis,
        });
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
          const error = new Error(
            'Project files changed during the distribution build. Try again.',
          );
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
          const error = new Error(
            'Project assets changed during the distribution build. Try again.',
          );
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
          const error = new Error(
            'Project files changed during the distribution build. Try again.',
          );
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
    },

    async startAuthoringMenu(project: any, {showTitle}: {showTitle: any}) {
      try {
        await this.initializeNonEmbeddedPreview(project);
      } catch (error) {
        console.warn(
          '[Kamishibai DSL 4.0] development preview is unavailable; using one-shot file loading.',
          loggedError(error),
        );
      }
      const Scratch = this.Scratch;
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
    },
  };
  Object.assign(RuntimeExtension.prototype, authoringProfile);
}
