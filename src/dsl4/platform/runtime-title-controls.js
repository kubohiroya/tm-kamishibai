import {createAppShellTitleControls} from '@kubohiroya/turbowarp-app-shell';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name */
function requireElement(value, name) {
  if (!isRecord(value) || typeof value.appendChild !== 'function') {
    throw new TypeError(`${name} must be a DOM element`);
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value */
function requireDocument(value) {
  if (!isRecord(value) || typeof value.createElement !== 'function') {
    throw new TypeError('document must provide createElement');
  }
  return /** @type {Record<string, any>} */ (value);
}

/**
 * Render title actions above the Stage without adding Scratch sprites or clones.
 * Pointer events pass through the empty overlay so the Stage itself remains clickable.
 *
 * The overlay mechanics live in `@kubohiroya/turbowarp-app-shell`. This module injects the
 * Kamishibai copy, website icon, stage-relative close glyph metrics, and `data-dsl4-*` hooks.
 *
 * @param {object} options
 * @param {unknown} options.document
 * @param {unknown} options.mount
 * @param {Readonly<Record<'en' | 'ja', Readonly<{website: string, close: string}>>>} options.locales
 * @param {string} [options.websiteIconUrl]
 * @param {() => unknown | Promise<unknown>} options.onWebsite
 * @param {() => unknown | Promise<unknown>} options.onClose
 * @param {(error: unknown) => unknown} [options.onError]
 */
export function createDsl4RuntimeTitleControls(options) {
  if (!isRecord(options)) throw new TypeError('title control options are required');
  const document = requireDocument(options.document);
  const mount = requireElement(options.mount, 'mount');
  if (typeof options.onWebsite !== 'function') throw new TypeError('onWebsite must be a function');
  if (typeof options.onClose !== 'function') throw new TypeError('onClose must be a function');
  for (const locale of /** @type {const} */ (['en', 'ja'])) {
    if (
      !isRecord(options.locales?.[locale]) ||
      typeof options.locales[locale].website !== 'string' ||
      typeof options.locales[locale].close !== 'string'
    ) {
      throw new TypeError(`locales.${locale} must provide website and close`);
    }
  }

  const controls = createAppShellTitleControls({
    document: /** @type {any} */ (document),
    mount: /** @type {any} */ (mount),
    locales: /** @type {any} */ (options.locales),
    // Kamishibai starts every surface in English and switches from the application menu.
    initialLocale: 'en',
    fallbackLocale: 'en',
    ariaLabel: 'Kamishibai title controls',
    websiteIcon: options.websiteIconUrl
      ? {url: options.websiteIconUrl}
      : {text: '🌐', size: 'auto', fontSize: '5.5cqw'},
    // The stage scales with its container, so the close glyph is sized in container units.
    closeIconMetrics: {size: '4.1667cqw', thickness: '.625cqw', radius: '.3125cqw'},
    attributes: {
      root: {'data-dsl4-title-controls': 'true'},
      website: {'data-dsl4-title-action': 'website'},
      close: {'data-dsl4-title-action': 'close'},
      closeIcon: {'data-dsl4-close-icon': 'true'},
      closeIconLine: {'data-dsl4-close-icon-line': 'true'},
    },
    onWebsite: /** @type {() => unknown} */ (options.onWebsite),
    onClose: /** @type {() => unknown} */ (options.onClose),
    ...(options.onError === undefined
      ? {}
      : {onError: /** @type {(error: unknown) => unknown} */ (options.onError)}),
  });

  return Object.freeze({
    element: controls.element,
    /** @param {'en' | 'ja'} [nextLocale] */
    show(nextLocale) {
      return controls.show(
        nextLocale === 'ja' ? 'ja' : nextLocale === undefined ? undefined : 'en',
      );
    },
    hide: () => controls.hide(),
    dispose: () => controls.dispose(),
  });
}
