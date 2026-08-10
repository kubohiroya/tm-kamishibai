import {resolveDsl4FeatureFlags} from '../feature-flags.js';
import {deepFreeze} from '../story-document.js';
import {createDsl4IndeterminateProgressIndicator} from './indeterminate-progress-indicator.js';
import {createDsl4LoadingScreenPresenter} from './loading-screen-presenter.js';
import {createDsl4TurboWarpRuntimeHost} from './turbowarp-runtime-host.js';

const optionKeys = new Set([
  'createRuntimeHost',
  'document',
  'featureFlags',
  'mount',
  'progressIndicator',
  'poseFeedbackLabels',
  'runtimeHostOptions',
  'surface',
  'title',
]);
const runtimeHostReservedKeys = new Set(['featureFlags', 'poseFeedbackPresenter']);
const supportedSurfaces = new Set(['webPlayer', 'regularEditor', 'packager', 'developmentPreview']);

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

/** @param {unknown} value */
function requireSurface(value) {
  if (typeof value !== 'string' || !supportedSurfaces.has(value)) {
    throw new TypeError(`surface must be one of ${[...supportedSurfaces].sort().join(', ')}`);
  }
  return value;
}

/** @param {unknown} value */
function requireRuntimeHostOptions(value) {
  if (!isRecord(value)) throw new TypeError('runtimeHostOptions must be an object');
  const reserved = Object.keys(value).filter((key) => runtimeHostReservedKeys.has(key));
  if (reserved.length > 0) {
    throw new TypeError(
      `runtimeHostOptions cannot override Standard app-shell option: ${reserved.sort().join(', ')}`,
    );
  }
  return value;
}

/** @param {unknown} value */
function requireProgressIndicatorOptions(value) {
  if (!isRecord(value)) throw new TypeError('progressIndicator must be an object');
  return value;
}

/** @param {unknown} value */
function requireTitleOptions(value) {
  if (!isRecord(value)) throw new TypeError('title must be an object');
  const locales = value.locales;
  if (!isRecord(locales)) throw new TypeError('title.locales must be an object');
  for (const locale of ['en', 'ja']) {
    const localized = locales[locale];
    if (!isRecord(localized)) throw new TypeError(`title.locales.${locale} must be an object`);
    for (const key of ['title', 'officialWebsite', 'close', 'language']) {
      if (typeof localized[key] !== 'string' || localized[key].length === 0) {
        throw new TypeError(`title.locales.${locale}.${key} must be a non-empty string`);
      }
    }
  }
  if (typeof value.version !== 'string' || value.version.length === 0) {
    throw new TypeError('title.version must be a non-empty string');
  }
  if (typeof value.officialWebsiteUrl !== 'string' || value.officialWebsiteUrl.length === 0) {
    throw new TypeError('title.officialWebsiteUrl must be a non-empty string');
  }
  if (
    value.initialLocale !== undefined &&
    (typeof value.initialLocale !== 'string' || !['en', 'ja'].includes(value.initialLocale))
  ) {
    throw new TypeError('title.initialLocale must be en or ja');
  }
  return /** @type {Readonly<Record<string, any>>} */ (value);
}

/** @returns {'en' | 'ja'} */
function resolveBrowserTitleLocale() {
  const browserNavigator = globalThis.navigator;
  const preferred =
    typeof browserNavigator?.language === 'string'
      ? browserNavigator.language
      : Array.isArray(browserNavigator?.languages) &&
          typeof browserNavigator.languages[0] === 'string'
        ? browserNavigator.languages[0]
        : '';
  return /^ja(?:-|$)/iu.test(preferred) ? 'ja' : 'en';
}

/** @param {unknown} value */
function isRuntimeHostResult(value) {
  if (
    !isRecord(value) ||
    typeof value.ok !== 'boolean' ||
    value.enabled !== true ||
    !Array.isArray(value.diagnostics)
  ) {
    return false;
  }
  if (!value.ok) return value.host === null || value.host === undefined;
  return isRecord(value.host) && typeof value.host.dispose === 'function';
}

/**
 * Create the shared Standard app-shell composition for production and development surfaces.
 *
 * The pose feedback mount is created lazily. The TurboWarp host only reads the presenter
 * configuration for `feedback.mode: presenter`, so flag-off and Scratch modes do not inspect DOM.
 *
 * @param {object} [options]
 * @param {unknown} [options.featureFlags]
 * @param {'webPlayer' | 'regularEditor' | 'packager' | 'developmentPreview'} [options.surface]
 * @param {unknown} [options.document]
 * @param {unknown} [options.mount]
 * @param {Readonly<Record<string, unknown>>} [options.progressIndicator]
 * @param {Readonly<Record<string, unknown>>} [options.poseFeedbackLabels]
 * @param {Readonly<Record<string, unknown>>} [options.runtimeHostOptions]
 * @param {Readonly<Record<string, unknown>>} [options.title]
 * @param {(options: Record<string, unknown>) => Promise<Readonly<Record<string, any>>>} [options.createRuntimeHost]
 */
export async function createDsl4StandardAppShell(options = {}) {
  if (!isRecord(options)) throw new TypeError('Standard app-shell options must be an object');
  const unknown = Object.keys(options).filter((key) => !optionKeys.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown Standard app-shell option: ${unknown.sort().join(', ')}`);
  }
  const featureFlags = resolveDsl4FeatureFlags(options.featureFlags);
  if (!featureFlags.dsl4AppShell) {
    const snapshot = deepFreeze({
      version: 1,
      enabled: false,
      disposed: false,
      surface: null,
      featureFlags,
    });
    return Object.freeze({
      ok: true,
      enabled: false,
      featureFlags,
      surface: null,
      element: null,
      titleElement: null,
      runtimeHost: null,
      diagnostics: [],
      getSnapshot: () => snapshot,
      dispose: async () => snapshot,
    });
  }

  const surface = requireSurface(options.surface);
  const progressIndicatorOptions =
    options.progressIndicator === undefined
      ? {}
      : requireProgressIndicatorOptions(options.progressIndicator);
  const runtimeHostOptions = requireRuntimeHostOptions(options.runtimeHostOptions);
  const titleOptions = options.title === undefined ? null : requireTitleOptions(options.title);
  const createRuntimeHost = options.createRuntimeHost ?? createDsl4TurboWarpRuntimeHost;
  if (typeof createRuntimeHost !== 'function') {
    throw new TypeError('createRuntimeHost must be a function');
  }

  let disposed = false;
  /** @type {any | null} */
  let root = null;
  /** @type {any | null} */
  let poseFeedbackMount = null;
  /** @type {any | null} */
  let titleMount = null;
  /** @type {(() => void) | null} */
  let disposeTitle = null;
  /** @type {Readonly<Record<string, any>> | null} */
  let runtimeResult = null;
  /** @type {Promise<Readonly<Record<string, unknown>>> | null} */
  let disposePromise = null;
  /** @type {ReturnType<typeof createDsl4IndeterminateProgressIndicator> | null} */
  let progressIndicator = null;
  /** @type {ReturnType<typeof createDsl4LoadingScreenPresenter> | null} */
  let loadingPresenter = null;

  function ensureTitleMount() {
    if (disposed || titleOptions === null || titleMount) return titleMount;
    if (options.document === undefined) return null;
    let document;
    let mount;
    try {
      document = requireDocument(options.document);
      mount = requireElement(options.mount ?? document.body, 'mount');
    } catch {
      return null;
    }
    // The embedded extension loader supplies a minimal script-only document while it bootstraps.
    // Do not treat that loader shim as a browser UI surface.
    if (Array.isArray(document.scripts)) return null;
    /** @param {string} tagName @returns {any} */
    const create = (tagName) => {
      const element = document.createElement(tagName);
      return isRecord(element) && typeof element.appendChild === 'function' ? element : null;
    };
    const rootElement = /** @type {any} */ (create('section'));
    if (!rootElement) return null;
    const panel = /** @type {any} */ (document.createElement('div'));
    const heading = /** @type {any} */ (document.createElement('h1'));
    const version = /** @type {any} */ (document.createElement('p'));
    const official = /** @type {any} */ (document.createElement('button'));
    const close = /** @type {any} */ (document.createElement('button'));
    const language = /** @type {any} */ (document.createElement('button'));
    const elements = [panel, heading, version, official, close, language];
    if (
      elements.some(
        (element) =>
          !isRecord(element) ||
          typeof element.appendChild !== 'function' ||
          typeof element.addEventListener !== 'function',
      )
    ) {
      return null;
    }
    let restoreMountPosition = null;
    if (mount !== document.body && isRecord(mount.style)) {
      const previousPosition = mount.style.position;
      if (previousPosition === undefined || previousPosition === '') {
        mount.style.position = 'relative';
        restoreMountPosition = () => {
          mount.style.position = previousPosition ?? '';
        };
      }
    }
    /** @param {any} element @param {string} value */
    const style = (element, value) => {
      if (isRecord(element) && isRecord(element.style)) element.style.cssText = value;
    };
    style(
      rootElement,
      'position:absolute;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.35);font-family:sans-serif;',
    );
    rootElement.style.display = 'none';
    rootElement.style.position = 'absolute';
    rootElement.style.cursor = 'pointer';
    style(
      panel,
      'position:static;min-width:280px;max-width:90%;padding:36px 28px 28px;text-align:center;background:#f4fffb;border:1px solid #007d66;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.3);color:#006b58;',
    );
    panel.style.position = 'static';
    panel.style.cursor = 'pointer';
    style(
      close,
      'position:absolute;top:16px;right:16px;width:32px;height:32px;border:0;border-radius:50%;background:#007d66;color:#fff;font-size:22px;line-height:28px;cursor:pointer;',
    );
    close.style.position = 'absolute';
    close.style.cursor = 'pointer';
    style(
      language,
      'position:absolute;top:18px;left:16px;border:0;background:transparent;color:#007d66;font-size:14px;cursor:pointer;',
    );
    language.style.position = 'absolute';
    language.style.cursor = 'pointer';
    style(
      official,
      'display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:8px 18px;border:0;border-radius:10px;background:#007d66;color:#fff;font-size:16px;cursor:pointer;',
    );
    official.style.cursor = 'pointer';
    style(heading, 'margin:0 24px 8px;font-size:30px;font-weight:600;');
    style(version, 'margin:0 0 22px;font-size:14px;');
    close.type = 'button';
    language.type = 'button';
    official.type = 'button';
    close.textContent = '×';
    rootElement.setAttribute('data-dsl4-title-shell', 'true');
    rootElement.setAttribute('role', 'dialog');
    rootElement.setAttribute('aria-modal', 'true');
    panel.appendChild(language);
    panel.appendChild(close);
    panel.appendChild(heading);
    panel.appendChild(version);
    panel.appendChild(official);
    rootElement.appendChild(panel);
    mount.appendChild(rootElement);

    let locale = titleOptions.initialLocale ?? resolveBrowserTitleLocale();
    let titleStarted = false;
    const render = () => {
      const localized = titleOptions.locales[locale];
      heading.textContent = localized.title;
      version.textContent = titleOptions.version;
      official.textContent = localized.officialWebsite;
      official.setAttribute('aria-label', localized.officialWebsite);
      close.setAttribute('aria-label', localized.close);
      language.textContent = localized.language;
      language.setAttribute('aria-label', localized.language);
    };
    const openOfficialWebsite = () => {
      const opener = globalThis.open;
      if (typeof opener === 'function') {
        opener(titleOptions.officialWebsiteUrl, '_blank', 'noopener,noreferrer');
      } else if (isRecord(globalThis.location)) {
        globalThis.location.href = titleOptions.officialWebsiteUrl;
      }
    };
    const hideTitle = () => {
      if (isRecord(rootElement.style)) rootElement.style.display = 'none';
    };
    const closeTitle = () => {
      if (typeof runtimeHostOptions.onCloseTitle === 'function') {
        runtimeHostOptions.onCloseTitle();
      }
      startTitle();
    };
    const startTitle = () => {
      if (titleStarted) {
        hideTitle();
        return;
      }
      titleStarted = true;
      hideTitle();
      if (typeof runtimeHostOptions.onTitleStart === 'function') {
        runtimeHostOptions.onTitleStart();
      }
    };
    const toggleTitleLanguage = () => {
      locale = locale === 'ja' ? 'en' : 'ja';
      render();
      if (typeof runtimeHostOptions.onLanguageChange === 'function') {
        runtimeHostOptions.onLanguageChange(locale);
      }
    };
    /** @param {any} event */
    const startFromBackground = (event) => {
      const target = event?.target;
      if (target === official || target === close || target === language) return;
      startTitle();
    };
    official.addEventListener('click', openOfficialWebsite);
    language.addEventListener('click', toggleTitleLanguage);
    close.addEventListener('click', closeTitle);
    rootElement.addEventListener('click', startFromBackground);
    render();
    titleMount = rootElement;
    disposeTitle = () => {
      official.removeEventListener('click', openOfficialWebsite);
      language.removeEventListener('click', toggleTitleLanguage);
      close.removeEventListener('click', closeTitle);
      rootElement.removeEventListener('click', startFromBackground);
      if (typeof rootElement.remove === 'function') rootElement.remove();
      restoreMountPosition?.();
      titleMount = null;
    };
    return titleMount;
  }

  function ensurePoseFeedbackMount() {
    if (disposed) throw new TypeError('Standard app shell is disposed');
    if (poseFeedbackMount) return poseFeedbackMount;
    const document = requireDocument(options.document);
    const mount = requireElement(options.mount, 'mount');
    root = document.createElement('section');
    root.setAttribute('data-dsl4-app-shell', 'standard');
    root.setAttribute('data-dsl4-surface', surface);
    poseFeedbackMount = document.createElement('div');
    poseFeedbackMount.setAttribute('data-dsl4-pose-feedback-mount', 'true');
    root.appendChild(poseFeedbackMount);
    mount.appendChild(root);
    return poseFeedbackMount;
  }

  function ensureProgressIndicator() {
    if (progressIndicator) return progressIndicator;
    if (options.document === undefined) return null;
    const document = requireDocument(options.document);
    const mount = options.mount ?? document.body;
    if (mount === undefined || mount === null) return null;
    progressIndicator = createDsl4IndeterminateProgressIndicator({
      document,
      mount,
      ...progressIndicatorOptions,
    });
    return progressIndicator;
  }

  function ensureLoadingPresenter() {
    if (loadingPresenter) return loadingPresenter;
    if (options.document === undefined) return null;
    const document = requireDocument(options.document);
    const mount = options.mount ?? document.body;
    if (mount === undefined || mount === null) return null;
    loadingPresenter = createDsl4LoadingScreenPresenter({document, mount});
    return loadingPresenter;
  }

  /** @param {Readonly<Record<string, unknown>>} payload @param {Readonly<Record<string, unknown>>} context */
  function setLoading(payload, context) {
    const visible = isRecord(payload) && payload.visible === true;
    if (!disposed && (visible || loadingPresenter)) {
      ensureLoadingPresenter()?.setLoading(payload);
    }
    if (!disposed && (visible || progressIndicator)) {
      ensureProgressIndicator()?.setBusy({
        visible,
        source: 'assets',
        label: 'Loading assets',
        cursor: 'wait',
      });
    }
    const delegate = runtimeHostOptions.setLoading;
    if (typeof delegate !== 'function') throw new TypeError('setLoading must be a function');
    return delegate(payload, context);
  }

  /** @param {Readonly<{visible: boolean, source: string, label: string, cursor?: string}>} payload */
  function setBusy(payload) {
    try {
      if (!disposed) ensureProgressIndicator()?.setBusy(payload);
    } catch {
      // Busy indicators are non-authoritative and cannot change runtime execution.
    }
    const delegate = runtimeHostOptions.setBusy;
    if (typeof delegate !== 'function') return undefined;
    try {
      return delegate(payload);
    } catch {
      return undefined;
    }
  }

  /** @param {Readonly<{visible: boolean, source?: string, cursor: string}>} payload */
  function setCursor(payload) {
    try {
      if (!disposed && payload?.visible) ensureProgressIndicator()?.setCursor(payload);
      else if (!disposed && progressIndicator) progressIndicator.setCursor(payload);
    } catch {
      // Cursor styling is non-authoritative and cannot change runtime execution semantics.
    }
    const delegate = runtimeHostOptions.setCursor;
    if (typeof delegate !== 'function') return undefined;
    try {
      return delegate(payload);
    } catch {
      return undefined;
    }
  }

  function disposeProgressIndicator() {
    const indicator =
      /** @type {ReturnType<typeof createDsl4IndeterminateProgressIndicator> | null} */ (
        progressIndicator
      );
    progressIndicator = null;
    indicator?.dispose();
  }

  function disposeLoadingPresenter() {
    const presenter = loadingPresenter;
    loadingPresenter = null;
    presenter?.dispose();
  }

  function disposeTitleMount() {
    const dispose = disposeTitle;
    disposeTitle = null;
    if (typeof dispose === 'function') dispose();
  }

  ensureTitleMount();

  const poseFeedbackPresenter = {};
  Object.defineProperty(poseFeedbackPresenter, 'container', {
    enumerable: true,
    get: ensurePoseFeedbackMount,
  });
  if (Object.hasOwn(options, 'poseFeedbackLabels')) {
    Object.defineProperty(poseFeedbackPresenter, 'labels', {
      enumerable: true,
      get() {
        return options.poseFeedbackLabels;
      },
    });
  }

  try {
    const hostOptions = {
      ...runtimeHostOptions,
      setBusy,
      setCursor,
      /** @param {Readonly<Record<string, unknown>>} event */
      onEvent(event) {
        if (event?.type === 'runtime.start' && isRecord(titleMount?.style)) {
          titleMount.style.display = 'none';
        }
        return typeof runtimeHostOptions.onEvent === 'function'
          ? runtimeHostOptions.onEvent(event)
          : undefined;
      },
      ...(typeof runtimeHostOptions.setLoading === 'function' ? {setLoading} : {}),
    };
    runtimeResult = await createRuntimeHost({
      ...hostOptions,
      featureFlags,
      poseFeedbackPresenter,
    });
  } catch (error) {
    try {
      disposeProgressIndicator();
    } catch {
      // Preserve the original runtime-host creation error.
    }
    try {
      disposeLoadingPresenter();
    } catch {
      // Preserve the original runtime-host creation error.
    }
    try {
      disposeTitleMount();
    } catch {
      // Preserve the original runtime-host creation error.
    }
    if (typeof root?.remove === 'function') root.remove();
    root = null;
    poseFeedbackMount = null;
    throw error;
  }
  if (!isRuntimeHostResult(runtimeResult)) {
    /** @type {unknown[]} */
    const errors = [
      new TypeError('createRuntimeHost must return a valid enabled runtime host result'),
    ];
    try {
      if (
        isRecord(runtimeResult) &&
        isRecord(runtimeResult.host) &&
        typeof runtimeResult.host.dispose === 'function'
      ) {
        await runtimeResult.host.dispose('invalid-standard-app-shell-result');
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      if (typeof root?.remove === 'function') root.remove();
    } catch (error) {
      errors.push(error);
    }
    try {
      disposeProgressIndicator();
    } catch (error) {
      errors.push(error);
    }
    try {
      disposeLoadingPresenter();
    } catch (error) {
      errors.push(error);
    }
    try {
      disposeTitleMount();
    } catch (error) {
      errors.push(error);
    }
    root = null;
    poseFeedbackMount = null;
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, 'Invalid Standard app-shell runtime host cleanup failed');
  }

  function snapshot() {
    return deepFreeze({
      version: 1,
      enabled: true,
      disposed,
      surface,
      featureFlags,
      runtimeEnabled: runtimeResult?.enabled === true,
      runtimeOk: runtimeResult?.ok === true,
      poseFeedbackMounted: root !== null,
    });
  }

  async function dispose(reason = 'app-shell-dispose') {
    if (disposePromise) return disposePromise;
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new TypeError('dispose reason must be a non-empty string');
    }
    disposed = true;
    disposePromise = (async () => {
      const errors = [];
      try {
        await runtimeResult?.host?.dispose(reason);
      } catch (error) {
        errors.push(error);
      }
      try {
        disposeProgressIndicator();
      } catch (error) {
        errors.push(error);
      }
      try {
        disposeLoadingPresenter();
      } catch (error) {
        errors.push(error);
      }
      try {
        disposeTitleMount();
      } catch (error) {
        errors.push(error);
      }
      try {
        if (typeof root?.remove === 'function') root.remove();
      } catch (error) {
        errors.push(error);
      }
      root = null;
      poseFeedbackMount = null;
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Standard app-shell disposal failed');
      }
      return snapshot();
    })();
    return disposePromise;
  }

  return Object.freeze({
    ok: runtimeResult.ok,
    enabled: true,
    featureFlags,
    surface,
    get element() {
      return root ?? titleMount;
    },
    get titleElement() {
      return titleMount;
    },
    runtimeHost: runtimeResult.host ?? null,
    diagnostics: runtimeResult.diagnostics ?? [],
    showTitle() {
      if (titleMount) titleMount.style.display = 'flex';
    },
    hideTitle() {
      if (titleMount) titleMount.style.display = 'none';
    },
    openOfficialWebsite() {
      if (titleMount) {
        const button = titleMount.children?.[0]?.children?.[4];
        if (isRecord(button) && typeof button.click === 'function') button.click();
      }
    },
    toggleTitleLanguage() {
      if (titleMount) {
        const button = titleMount.children?.[0]?.children?.[0];
        if (isRecord(button) && typeof button.click === 'function') button.click();
      }
    },
    getSnapshot: snapshot,
    dispose,
  });
}
