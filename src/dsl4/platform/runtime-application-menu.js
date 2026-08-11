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

export const dsl4RuntimeApplicationMenuDefaultIcons = Object.freeze({
  open: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij4KICA8cGF0aCBkPSJNNSAxMy41aDE0bDQuNSA1SDQzdjIySDV6IiBmaWxsPSIjZDg1NjU2IiBzdHJva2U9IiMwMDAiIHN0cm9rZS13aWR0aD0iMi41IiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CiAgPHBhdGggZD0iTTUgMTguNWgzOCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIuNSIvPgo8L3N2Zz4K',
  reload:
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij4KICA8cGF0aCBkPSJNMzguNSAxN0ExNiAxNiAwIDEgMCA0MCAyOCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgogIDxwYXRoIGQ9Ik0zOC41IDE3QTE2IDE2IDAgMSAwIDQwIDI4IiBmaWxsPSJub25lIiBzdHJva2U9IiNkODU2NTYiIHN0cm9rZS13aWR0aD0iMyIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+CiAgPHBhdGggZD0iTTI5IDcuNSA0MCA4bC0uNSAxMSIgZmlsbD0iI2Q4NTY1NiIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIuNSIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgo8L3N2Zz4K',
  about:
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij4KICA8Y2lyY2xlIGN4PSIyNCIgY3k9IjI0IiByPSIxOSIgZmlsbD0iI2Q4NTY1NiIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIuNSIvPgogIDxjaXJjbGUgY3g9IjI0IiBjeT0iMTUiIHI9IjIuNSIgZmlsbD0iIzAwMCIvPgogIDxwYXRoIGQ9Ik0yNCAyMnYxMyIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K',
  language:
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij4KICA8Y2lyY2xlIGN4PSIyNCIgY3k9IjI0IiByPSIxOSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjUuNSIvPgogIDxjaXJjbGUgY3g9IjI0IiBjeT0iMjQiIHI9IjE5IiBmaWxsPSJub25lIiBzdHJva2U9IiNkODU2NTYiIHN0cm9rZS13aWR0aD0iMi41Ii8+CiAgPHBhdGggZD0iTTUuNSAyNGgzN004LjUgMTVoMzFNOC41IDMzaDMxTTI0IDVjNSA1IDcgMTEgNyAxOXMtMiAxNC03IDE5Yy01LTUtNy0xMS03LTE5czItMTQgNy0xOVoiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzAwMCIgc3Ryb2tlLXdpZHRoPSI1IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KICA8cGF0aCBkPSJNNS41IDI0aDM3TTguNSAxNWgzMU04LjUgMzNoMzFNMjQgNWM1IDUgNyAxMSA3IDE5cy0yIDE0LTcgMTljLTUtNS03LTExLTctMTlzMi0xNCA3LTE5WiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZDg1NjU2IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgo8L3N2Zz4K',
});

/**
 * Render the four application actions above the stage without adding Scratch sprites or clones.
 * The overlay is owned by the stage mount, so it cannot escape into the surrounding editor UI.
 *
 * @param {object} options
 * @param {unknown} options.document
 * @param {unknown} options.mount
 * @param {Readonly<Record<'en' | 'ja', Readonly<Record<string, string>>>>} options.locales
 * @param {Readonly<Record<'open' | 'reload' | 'about' | 'language', string>>} [options.icons]
 * @param {() => unknown | Promise<unknown>} options.onOpen
 * @param {() => unknown | Promise<unknown>} options.onReload
 * @param {() => unknown | Promise<unknown>} options.onAbout
 * @param {(locale: 'en' | 'ja') => unknown | Promise<unknown>} options.onLocaleChange
 * @param {(error: unknown) => unknown} [options.onError]
 * @param {boolean} [options.reloadEnabled]
 */
export function createDsl4RuntimeApplicationMenu(options) {
  if (!isRecord(options)) throw new TypeError('application menu options are required');
  const document = requireDocument(options.document);
  const mount = requireElement(options.mount, 'mount');
  for (const callback of /** @type {const} */ ([
    'onOpen',
    'onReload',
    'onAbout',
    'onLocaleChange',
  ])) {
    if (typeof options[callback] !== 'function') {
      throw new TypeError(`${callback} must be a function`);
    }
  }
  for (const locale of /** @type {const} */ (['en', 'ja'])) {
    if (!isRecord(options.locales?.[locale])) {
      throw new TypeError(`locales.${locale} must be an object`);
    }
    for (const key of ['open', 'reload', 'about', 'language']) {
      if (typeof options.locales[locale][key] !== 'string') {
        throw new TypeError(`locales.${locale}.${key} must be a string`);
      }
    }
  }
  const icons = options.icons ?? dsl4RuntimeApplicationMenuDefaultIcons;
  for (const action of /** @type {const} */ (['open', 'reload', 'about', 'language'])) {
    if (typeof icons?.[action] !== 'string' || icons[action].length === 0) {
      throw new TypeError(`icons.${action} must be a non-empty string`);
    }
  }

  const rootCandidate = document.createElement('section');
  if (!isRecord(rootCandidate) || typeof rootCandidate.addEventListener !== 'function') {
    throw new TypeError('document must create event-capable elements');
  }
  const root = /** @type {Record<string, any>} */ (rootCandidate);
  root.setAttribute('data-dsl4-application-menu', 'true');
  root.setAttribute('aria-label', 'Kamishibai application menu');
  root.style.cssText =
    'position:absolute;inset:0;z-index:2147483600;display:none;box-sizing:border-box;overflow:hidden;pointer-events:auto;font-family:sans-serif;container-type:inline-size;';
  root.style.position = 'absolute';
  root.style.display = 'none';
  root.style.cursor = 'pointer';

  /** @type {null | (() => void)} */
  let restoreMountPosition = null;
  if (isRecord(mount.style)) {
    const previous = mount.style.position;
    if (previous === undefined || previous === '' || previous === 'static') {
      mount.style.position = 'relative';
      restoreMountPosition = () => {
        mount.style.position = previous ?? '';
      };
    }
  }

  /** @type {ReadonlyArray<Readonly<{action: 'open' | 'reload' | 'about' | 'language', left: string, top: string, callback: null | Function}>>} */
  const definitions = Object.freeze([
    {action: 'open', left: '10%', top: '25.5556%', callback: options.onOpen},
    {action: 'reload', left: '53.3333%', top: '25.5556%', callback: options.onReload},
    {action: 'about', left: '10%', top: '58.8889%', callback: options.onAbout},
    {action: 'language', left: '53.3333%', top: '58.8889%', callback: null},
  ]);
  const buttons = new Map();
  /** @type {'en' | 'ja'} */
  let locale = 'en';
  let reloadEnabled = options.reloadEnabled ?? true;
  if (typeof reloadEnabled !== 'boolean') {
    throw new TypeError('reloadEnabled must be a boolean');
  }
  let disposed = false;

  /** @param {unknown} failure */
  const reportFailure = (failure) => {
    try {
      options.onError?.(failure);
    } catch {
      // Menu error observers cannot change the application lifecycle.
    }
  };
  /** @param {Function} operation */
  const invoke = (operation) => {
    try {
      Promise.resolve(operation()).catch(reportFailure);
    } catch (error) {
      reportFailure(error);
    }
  };

  for (const definition of definitions) {
    const button = document.createElement('button');
    const icon = document.createElement('img');
    const label = document.createElement('span');
    for (const element of [button, icon, label]) {
      if (!isRecord(element) || typeof element.appendChild !== 'function') {
        throw new TypeError('document must create application menu elements');
      }
    }
    button.type = 'button';
    button.setAttribute('data-dsl4-menu-action', definition.action);
    button.style.cssText = `position:absolute;left:${definition.left};top:${definition.top};width:36.6667%;height:24.4444%;display:flex;min-width:0;min-height:0;align-items:center;justify-content:center;flex-direction:column;gap:2px;border:2px solid #005f50;border-radius:14px;background:#007d66;color:#fff;box-shadow:0 3px 8px rgba(0,0,0,.2);cursor:pointer;font:inherit;`;
    button.style.cursor = 'pointer';
    icon.setAttribute('aria-hidden', 'true');
    icon.src = icons[definition.action];
    icon.alt = '';
    icon.style.cssText =
      'display:block;width:clamp(24px,10cqw,48px);height:clamp(24px,10cqw,48px);object-fit:contain;filter:invert(1) brightness(1.7) saturate(.35);';
    label.style.cssText = 'font-size:clamp(12px,3.8cqw,20px);line-height:1.15;text-align:center;';
    button.appendChild(icon);
    button.appendChild(label);
    const onClick = () => {
      if (definition.action === 'language') {
        locale = locale === 'ja' ? 'en' : 'ja';
        render();
        invoke(() => options.onLocaleChange(locale));
        return;
      }
      invoke(/** @type {Function} */ (definition.callback));
    };
    button.addEventListener('click', onClick);
    root.appendChild(button);
    buttons.set(definition.action, {button, label, onClick});
  }
  mount.appendChild(root);

  function render() {
    for (const [action, value] of buttons) {
      value.label.textContent = options.locales[locale][action];
      value.button.setAttribute('aria-label', options.locales[locale][action]);
      const disabled = action === 'reload' && !reloadEnabled;
      value.button.disabled = disabled;
      value.button.setAttribute('aria-disabled', String(disabled));
      value.button.style.cursor = disabled ? 'not-allowed' : 'pointer';
      value.button.style.opacity = disabled ? '0.42' : '1';
      value.button.style.boxShadow = disabled ? 'none' : '0 3px 8px rgba(0,0,0,.2)';
    }
  }

  /** @param {boolean} enabled */
  function setReloadEnabled(enabled) {
    if (disposed) throw new TypeError('application menu is disposed');
    if (typeof enabled !== 'boolean') throw new TypeError('reload enabled state must be a boolean');
    reloadEnabled = enabled;
    render();
  }

  function show(nextLocale = locale) {
    if (disposed) throw new TypeError('application menu is disposed');
    locale = nextLocale === 'ja' ? 'ja' : 'en';
    render();
    root.style.display = 'block';
    return locale;
  }

  function hide() {
    if (!disposed) root.style.display = 'none';
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const {button, onClick} of buttons.values()) {
      button.removeEventListener('click', onClick);
    }
    buttons.clear();
    root.remove?.();
    restoreMountPosition?.();
  }

  render();
  return Object.freeze({element: root, show, hide, setReloadEnabled, dispose});
}
