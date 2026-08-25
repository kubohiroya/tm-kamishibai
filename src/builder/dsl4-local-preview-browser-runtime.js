import {createDsl4BrowserPreviewRuntimeBridge} from '../dsl4/browser-preview-runtime-bridge.js';
import {
  createDsl4BrowserTurboWarpStage,
  dsl4BrowserTurboWarpStageDefaults,
  dsl4BrowserTurboWarpStageMaximumProjectBytes,
} from '../dsl4/browser-turbowarp-stage.js';
import {createDsl4TurboWarpPreviewSessionFactory} from '../dsl4/platform/turbowarp-preview-session.js';
import {
  createDsl4RuntimeApplicationMenu,
  dsl4RuntimeApplicationMenuDefaultIcons,
} from '../dsl4/platform/runtime-application-menu.js';
import {createDsl4RuntimeTitleControls} from '../dsl4/platform/runtime-title-controls.js';
import {deepFreeze} from '../dsl4/story-document.js';
import {loadDsl4BrowserRuntimeComponent} from './dsl4-browser-runtime-component.js';

const standardRuntimeExtensionId = 'kubohiroyakamishibai4';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name */
function requiredFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return /** @type {Function} */ (value);
}

/** @param {unknown} value @param {string} name */
function optionalFunction(value, name) {
  if (value !== undefined && typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
  return /** @type {Function | undefined} */ (value);
}

/** @param {Record<string, any>} vm */
function installStandardRuntimeMarker(vm) {
  const extensionManager = vm.extensionManager;
  if (!isRecord(extensionManager) || typeof extensionManager.addBuiltinExtension !== 'function') {
    throw new TypeError('TurboWarp VM must provide extensionManager.addBuiltinExtension');
  }
  class StandardRuntimeMarker {
    getInfo() {
      return {
        id: standardRuntimeExtensionId,
        name: 'Kamishibai DSL 4.0 local preview marker',
        blocks: [],
      };
    }
  }
  extensionManager.addBuiltinExtension(standardRuntimeExtensionId, StandardRuntimeMarker);
}

/** @param {unknown} value @param {string} name @param {number} maximum */
function boundedInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new TypeError(`${name} must be a safe integer between 1 and ${maximum}`);
  }
  return Number(value);
}

/** @param {unknown} value */
function validateTMRuntime(value) {
  if (
    !isRecord(value) ||
    typeof value.Webcam !== 'function' ||
    typeof value.loadFromFiles !== 'function'
  ) {
    throw new TypeError('runtimeOptions.tmPoseRuntime must provide Webcam and loadFromFiles');
  }
}

export class Dsl4LocalPreviewBrowserRuntimeError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'Dsl4LocalPreviewBrowserRuntimeError';
    this.code = code;
  }
}

/** @returns {Dsl4LocalPreviewBrowserRuntimeError} */
function disposedError() {
  return new Dsl4LocalPreviewBrowserRuntimeError(
    'K4-PREVIEW-RUNTIME-DISPOSED',
    'The local preview browser runtime is disposed',
  );
}

/** @param {Readonly<Record<string, any>>} result */
function componentError(result) {
  const first = Array.isArray(result.diagnostics) ? result.diagnostics[0] : null;
  const error = new Dsl4LocalPreviewBrowserRuntimeError(
    'K4-PREVIEW-RUNTIME-COMPONENT-001',
    'The local preview base runtime component is invalid',
  );
  Object.defineProperty(error, 'diagnostics', {
    value: deepFreeze(Array.isArray(result.diagnostics) ? [...result.diagnostics] : []),
  });
  if (isRecord(first) && typeof first.code === 'string') {
    Object.defineProperty(error, 'diagnosticCode', {value: first.code});
  }
  return error;
}

/**
 * Scope the legacy global expected by pinned block-free TurboWarp compositions to this page.
 * The exact prior value is restored when the browser runtime owner is disposed.
 *
 * @param {Record<string, any>} globalObject
 * @param {Record<string, any>} runtime
 */
function installScratchCompatibility(globalObject, runtime) {
  const hadScratch = Object.hasOwn(globalObject, 'Scratch');
  const previousScratch = globalObject.Scratch;
  const inheritedScratch = isRecord(previousScratch)
    ? /** @type {Record<string, any>} */ (previousScratch)
    : {};
  const inheritedVm = isRecord(inheritedScratch.vm)
    ? /** @type {Record<string, any>} */ (inheritedScratch.vm)
    : {};
  const inheritedCast = isRecord(inheritedScratch.Cast)
    ? /** @type {Record<string, any>} */ (inheritedScratch.Cast)
    : {};
  globalObject.Scratch = Object.freeze({
    ...inheritedScratch,
    vm: Object.freeze({...inheritedVm, runtime}),
    Cast: Object.freeze({
      ...inheritedCast,
      toString:
        typeof inheritedCast.toString === 'function'
          ? inheritedCast.toString.bind(inheritedCast)
          : /** @param {unknown} value */ (value) => String(value ?? ''),
    }),
    translate:
      typeof inheritedScratch.translate === 'function'
        ? inheritedScratch.translate.bind(inheritedScratch)
        : /** @param {unknown} value */ (value) => String(value ?? ''),
  });
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (hadScratch) globalObject.Scratch = previousScratch;
    else delete globalObject.Scratch;
  };
}

/**
 * Own the validated base component, one visible TurboWarp stage, and the generation bridge.
 * External source text and paths never cross this browser boundary.
 *
 * @param {object} optionsInput
 */
export function createDsl4LocalPreviewBrowserRuntime(optionsInput) {
  if (!isRecord(optionsInput)) {
    throw new TypeError('local preview browser runtime options are required');
  }
  const options = /** @type {Record<string, any>} */ (optionsInput);
  if (!(options.projectBytes instanceof Uint8Array) || options.projectBytes.byteLength < 1) {
    throw new TypeError('projectBytes must be a non-empty Uint8Array');
  }
  const maxProjectBytes = boundedInteger(
    options.maxProjectBytes ?? dsl4BrowserTurboWarpStageDefaults.maxProjectBytes,
    'maxProjectBytes',
    dsl4BrowserTurboWarpStageMaximumProjectBytes,
  );
  if (options.projectBytes.byteLength > maxProjectBytes) {
    throw new TypeError(`projectBytes must contain 1-${maxProjectBytes} bytes`);
  }
  if (!isRecord(options.sourceFrontend) || typeof options.sourceFrontend.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse');
  }
  if (!isRecord(options.runtimeOptions)) {
    throw new TypeError('runtimeOptions must be an object');
  }
  const globalObject = isRecord(options.globalObject)
    ? /** @type {Record<string, any>} */ (options.globalObject)
    : /** @type {Record<string, any>} */ (globalThis);
  if (typeof options.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(options.sessionId)) {
    throw new TypeError('sessionId must contain 1-128 URL-safe characters');
  }
  optionalFunction(options.onBridgeEvent, 'onBridgeEvent');
  optionalFunction(options.onRuntimeEvent, 'onRuntimeEvent');
  optionalFunction(options.onError, 'onError');
  optionalFunction(options.onApplicationOpen, 'onApplicationOpen');
  const featureFlags = options.featureFlags ?? {dsl4Runtime: true};
  let retainedProjectBytes = new Uint8Array(options.projectBytes);

  let status = 'idle';
  let disposed = false;
  let disposeRequested = false;
  /** @type {ReturnType<typeof createDsl4BrowserTurboWarpStage> | null} */
  let stage = null;
  /** @type {ReturnType<typeof createDsl4BrowserPreviewRuntimeBridge> | null} */
  let bridge = null;
  /** @type {ReturnType<typeof createDsl4RuntimeApplicationMenu> | null} */
  let applicationMenu = null;
  /** @type {ReturnType<typeof createDsl4RuntimeTitleControls> | null} */
  let titleControls = null;
  /** @type {'en' | 'ja'} */
  let applicationLocale = /^ja(?:-|$)/iu.test(globalObject.navigator?.language ?? '') ? 'ja' : 'en';
  /** @type {(() => void) | null} */
  let restoreScratchCompatibility = null;
  /** @type {Promise<Readonly<Record<string, unknown>>> | null} */
  let startPromise = null;
  /** @type {Promise<void> | null} */
  let cleanupPromise = null;
  /** @type {Promise<Readonly<Record<string, unknown>>> | null} */
  let disposePromise = null;

  function snapshot() {
    return deepFreeze({
      version: 1,
      status,
      ready: status === 'ready',
      disposed,
      stage: stage?.getState() ?? null,
      bridge: bridge?.getState() ?? null,
    });
  }

  /** @param {unknown} error */
  function reportError(error) {
    try {
      options.onError?.(error);
    } catch {
      // Error observers cannot change runtime ownership.
    }
  }

  function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const errors = [];
      const activeApplicationMenu = applicationMenu;
      applicationMenu = null;
      try {
        activeApplicationMenu?.dispose();
      } catch (error) {
        errors.push(error);
      }
      const activeTitleControls = titleControls;
      titleControls = null;
      try {
        activeTitleControls?.dispose();
      } catch (error) {
        errors.push(error);
      }
      const activeBridge = bridge;
      bridge = null;
      if (activeBridge) {
        try {
          await activeBridge.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      const activeStage = stage;
      stage = null;
      if (activeStage) {
        try {
          await activeStage.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (restoreScratchCompatibility) {
        try {
          restoreScratchCompatibility();
        } catch (error) {
          errors.push(error);
        }
        restoreScratchCompatibility = null;
      }
      retainedProjectBytes.fill(0);
      retainedProjectBytes = new Uint8Array(0);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Local preview browser runtime cleanup failed');
      }
    })();
    return cleanupPromise;
  }

  function start() {
    if (disposed || disposeRequested) throw disposedError();
    if (startPromise) return startPromise;
    status = 'starting';
    startPromise = (async () => {
      try {
        const component = await loadDsl4BrowserRuntimeComponent({
          projectBytes: retainedProjectBytes,
          sourceFrontend: options.sourceFrontend,
          maxProjectBytes,
          maxArchiveEntries: options.maxArchiveEntries,
          maxProjectJsonBytes: options.maxProjectJsonBytes,
          maxSourceBytes: options.maxSourceBytes,
          maxAssetFiles: options.maxAssetFiles,
          maxAssetBytes: options.maxAssetBytes,
          historyNavigationAvailable: options.historyNavigationAvailable,
          subtleCrypto: options.subtleCrypto,
        });
        if (!component.ok) throw componentError(component);
        if (disposeRequested) throw disposedError();
        const runtimeOptions = {...options.runtimeOptions};
        validateTMRuntime(runtimeOptions.tmPoseRuntime);
        requiredFunction(runtimeOptions.setLoading, 'runtimeOptions.setLoading');

        const activeStage = createDsl4BrowserTurboWarpStage({
          document: options.document,
          mount: options.mount,
          projectBytes: retainedProjectBytes,
          platform: options.platform,
          maxProjectBytes,
          stageWidth: options.stageWidth,
          stageHeight: options.stageHeight,
          async prepareVm(vm) {
            if (
              /** @type {Readonly<Record<string, any>>} */ (component)
                .standardRuntimeMarkerRequired === true
            ) {
              installStandardRuntimeMarker(vm);
            }
            await options.prepareVm?.(vm);
          },
        });
        stage = activeStage;
        await activeStage.start();
        if (disposeRequested) throw disposedError();

        const canvas = activeStage.getCanvas();
        const showApplicationMenu = () => {
          titleControls?.hide();
          activeStage.showApplicationMenu(applicationLocale);
          applicationMenu?.show(applicationLocale);
        };
        const hideApplicationUi = () => {
          applicationMenu?.hide();
          titleControls?.hide();
          activeStage.hideApplicationOverlay();
        };
        applicationMenu = createDsl4RuntimeApplicationMenu({
          document: options.document,
          mount: options.mount,
          locales: {
            en: {open: 'Open', reload: 'Reload', about: 'About', language: 'Language'},
            ja: {
              open: '台本を開く',
              reload: 'もう一度',
              about: 'アプリ情報',
              language: '言語',
            },
          },
          icons: dsl4RuntimeApplicationMenuDefaultIcons,
          onOpen() {
            const hostOpenButton = options.document.querySelector?.(
              '#dsl4-web-preview-open-project',
            );
            if (typeof hostOpenButton?.click === 'function') return hostOpenButton.click();
            if (options.onApplicationOpen) return options.onApplicationOpen();
            throw new Error('This preview host does not provide a project-open action.');
          },
          async onReload() {
            hideApplicationUi();
            try {
              await bridge?.restart('storyStart');
            } catch (error) {
              showApplicationMenu();
              throw error;
            }
          },
          onAbout() {
            applicationMenu?.hide();
            activeStage.showApplicationTitle(applicationLocale);
            titleControls?.show(applicationLocale);
          },
          onLocaleChange(locale) {
            applicationLocale = locale;
            showApplicationMenu();
          },
          onError: reportError,
        });
        titleControls = createDsl4RuntimeTitleControls({
          document: options.document,
          mount: options.mount,
          locales: {
            en: {website: 'Official Website', close: 'Close'},
            ja: {website: '公式Webサイト', close: '閉じる'},
          },
          onWebsite() {
            globalObject.open?.(
              'https://kubohiroya.github.io/tm-kamishibai/',
              '_blank',
              'noopener,noreferrer',
            );
          },
          onClose: showApplicationMenu,
          onError: reportError,
        });
        restoreScratchCompatibility = installScratchCompatibility(
          globalObject,
          activeStage.getRuntime(),
        );
        const createSession = createDsl4TurboWarpPreviewSessionFactory({
          ...runtimeOptions,
          featureFlags,
          runtimeComponent: component,
          runtime: activeStage.getRuntime(),
          resetManagedPresentation: () => activeStage.resetManagedPresentation(),
          inputTarget: canvas,
          stagePointerTarget: canvas,
          historyNavigationAvailable: options.historyNavigationAvailable,
          /** @param {Readonly<Record<string, any>>} event */
          onEvent(event) {
            if (event?.type === 'runtime.finish') {
              showApplicationMenu();
            }
            options.onRuntimeEvent?.(event);
          },
        });
        const activeBridge = createDsl4BrowserPreviewRuntimeBridge({
          createSession,
          sessionId: options.sessionId,
          maxGenerationMessageBytes: options.maxGenerationMessageBytes,
          onEvent: options.onBridgeEvent,
          onError: reportError,
        });
        bridge = activeBridge;
        await activeBridge.start();
        if (disposeRequested) throw disposedError();

        retainedProjectBytes.fill(0);
        retainedProjectBytes = new Uint8Array(0);
        status = 'ready';
        return snapshot();
      } catch (error) {
        if (!disposeRequested) status = 'failed';
        try {
          await cleanup();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Local preview browser runtime startup and cleanup failed',
          );
        }
        throw error;
      }
    })();
    return startPromise;
  }

  function activeBridge() {
    if (disposed || disposeRequested) throw disposedError();
    if (status !== 'ready' || !bridge) {
      throw new Dsl4LocalPreviewBrowserRuntimeError(
        'K4-PREVIEW-RUNTIME-NOT-READY',
        'The local preview browser runtime is not ready',
      );
    }
    return bridge;
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    if (disposed) return Promise.resolve(snapshot());
    disposeRequested = true;
    status = 'disposing';
    disposePromise = (async () => {
      if (startPromise) {
        try {
          await startPromise;
        } catch {
          // Startup owns partial cleanup and its caller owns the original failure.
        }
      }
      await cleanup();
      disposed = true;
      status = 'disposed';
      return snapshot();
    })();
    return disposePromise;
  }

  return Object.freeze({
    start,
    /** @param {unknown} record */
    accept(record) {
      return activeBridge().accept(record);
    },
    /** @param {unknown} choice */
    commit(choice) {
      return activeBridge().commit(choice);
    },
    /** @param {unknown} choice */
    restart(choice) {
      return activeBridge().restart(choice);
    },
    defer() {
      return activeBridge().defer();
    },
    async whenIdle() {
      await activeBridge().whenIdle();
      return snapshot();
    },
    dispose,
    getState: snapshot,
  });
}
