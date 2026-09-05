import {createAppShellSourceChooser} from '@kubohiroya/turbowarp-app-shell';

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

/** @type {ReadonlyArray<readonly ['file' | 'project' | 'cancel', 'openFile' | 'openProject' | 'cancel']>} */
const choiceLabelKeys = Object.freeze([
  Object.freeze(/** @type {const} */ (['file', 'openFile'])),
  Object.freeze(/** @type {const} */ (['project', 'openProject'])),
  Object.freeze(/** @type {const} */ (['cancel', 'cancel'])),
]);

/**
 * Let an author choose the watched source shape while preserving the browser click activation
 * needed by File System Access pickers.
 *
 * The dialog mechanics live in `@kubohiroya/turbowarp-app-shell`. This module owns the Kamishibai
 * source choices, their copy, the picker callbacks, and the `data-dsl4-*` hooks.
 *
 * @param {object} options
 * @param {unknown} options.document
 * @param {unknown} options.mount
 * @param {Readonly<Record<'en' | 'ja', Readonly<Record<'openFile' | 'openProject' | 'cancel', string>>>>} options.locales
 * @param {() => unknown | Promise<unknown>} options.onFile
 * @param {() => unknown | Promise<unknown>} options.onProject
 * @param {() => unknown | Promise<unknown>} options.onCancel
 * @param {(error: unknown) => unknown} [options.onError]
 */
export function createDsl4RuntimeSourceChooser(options) {
  if (!isRecord(options)) throw new TypeError('runtime source chooser options are required');
  const document = isRecord(options.document)
    ? /** @type {Record<string, any>} */ (options.document)
    : null;
  if (!document || typeof document.createElement !== 'function') {
    throw new TypeError('document must provide createElement');
  }
  const mount = requireElement(options.mount, 'mount');
  for (const callback of /** @type {const} */ (['onFile', 'onProject', 'onCancel'])) {
    if (typeof options[callback] !== 'function') {
      throw new TypeError(`${callback} must be a function`);
    }
  }
  for (const locale of /** @type {const} */ (['en', 'ja'])) {
    for (const key of /** @type {const} */ (['openFile', 'openProject', 'cancel'])) {
      if (typeof options.locales?.[locale]?.[key] !== 'string') {
        throw new TypeError(`locales.${locale}.${key} must be a string`);
      }
    }
  }

  const callbacks = {
    file: options.onFile,
    project: options.onProject,
    cancel: options.onCancel,
  };
  const chooser = createAppShellSourceChooser({
    document: /** @type {any} */ (document),
    mount: /** @type {any} */ (mount),
    initialLocale: 'en',
    fallbackLocale: 'en',
    ariaLabel: 'Kamishibai source chooser',
    choices: choiceLabelKeys.map(([choice, labelKey]) => ({
      id: choice,
      labels: Object.freeze({
        en: options.locales.en[labelKey],
        ja: options.locales.ja[labelKey],
      }),
      // Cancel is the quiet way out, so it keeps the secondary treatment.
      primary: choice !== 'cancel',
      align: /** @type {const} */ ('center'),
      attributes: {'data-dsl4-source-choice': choice},
      onSelect: /** @type {any} */ (callbacks[choice]),
    })),
    attributes: {root: {'data-dsl4-source-chooser': 'true'}},
    ...(options.onError === undefined
      ? {}
      : {onError: /** @type {(error: unknown) => unknown} */ (options.onError)}),
  });

  return Object.freeze({
    element: chooser.element,
    /** @param {'en' | 'ja'} nextLocale @param {{fileEnabled?: boolean, projectEnabled?: boolean}} [availability] */
    show(nextLocale, availability = {}) {
      const fileEnabled = availability.fileEnabled ?? true;
      const projectEnabled = availability.projectEnabled ?? true;
      if (typeof fileEnabled !== 'boolean' || typeof projectEnabled !== 'boolean') {
        throw new TypeError('source chooser availability must be boolean');
      }
      chooser.show(nextLocale === 'ja' ? 'ja' : 'en', {
        file: {enabled: fileEnabled},
        project: {enabled: projectEnabled},
      });
    },
    hide: () => chooser.hide(),
    dispose: () => chooser.dispose(),
  });
}
