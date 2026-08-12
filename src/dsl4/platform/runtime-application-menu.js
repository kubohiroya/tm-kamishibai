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
  build:
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cGF0aCBkPSJNOCAxMWgzMnYyN0g4eiIgZmlsbD0iI2Q4NTY1NiIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIuNSIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPjxwYXRoIGQ9Ik0yNCA3djIybS04LTggOCA4IDgtOE0xNSAzNmgxOCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjMiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPjwvc3ZnPg==',
  about:
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij4KICA8Y2lyY2xlIGN4PSIyNCIgY3k9IjI0IiByPSIxOSIgZmlsbD0iI2Q4NTY1NiIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjIuNSIvPgogIDxjaXJjbGUgY3g9IjI0IiBjeT0iMTUiIHI9IjIuNSIgZmlsbD0iIzAwMCIvPgogIDxwYXRoIGQ9Ik0yNCAyMnYxMyIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K',
  language:
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij4KICA8Y2lyY2xlIGN4PSIyNCIgY3k9IjI0IiByPSIxOSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjUuNSIvPgogIDxjaXJjbGUgY3g9IjI0IiBjeT0iMjQiIHI9IjE5IiBmaWxsPSJub25lIiBzdHJva2U9IiNkODU2NTYiIHN0cm9rZS13aWR0aD0iMi41Ii8+CiAgPHBhdGggZD0iTTUuNSAyNGgzN004LjUgMTVoMzFNOC41IDMzaDMxTTI0IDVjNSA1IDcgMTEgNyAxOXMtMiAxNC03IDE5Yy01LTUtNy0xMS03LTE5czItMTQgNy0xOVoiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzAwMCIgc3Ryb2tlLXdpZHRoPSI1IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KICA8cGF0aCBkPSJNNS41IDI0aDM3TTguNSAxNWgzMU04LjUgMzNoMzFNMjQgNWM1IDUgNyAxMSA3IDE5cy0yIDE0LTcgMTljLTUtNS03LTExLTctMTlzMi0xNCA3LTE5WiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZDg1NjU2IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgo8L3N2Zz4K',
});

/**
 * Render the application actions above the stage without adding Scratch sprites or clones.
 * The overlay is owned by the stage mount, so it cannot escape into the surrounding editor UI.
 *
 * @param {object} options
 * @param {unknown} options.document
 * @param {unknown} options.mount
 * @param {Readonly<Record<'en' | 'ja', Readonly<Record<string, string>>>>} options.locales
 * @param {Readonly<Partial<Record<'open' | 'reload' | 'build' | 'about' | 'language', string>>>} [options.icons]
 * @param {() => unknown | Promise<unknown>} options.onOpen
 * @param {() => unknown | Promise<unknown>} options.onReload
 * @param {() => unknown | Promise<unknown>} [options.onBuild]
 * @param {() => unknown | Promise<unknown>} options.onAbout
 * @param {(locale: 'en' | 'ja') => unknown | Promise<unknown>} options.onLocaleChange
 * @param {(error: unknown) => unknown} [options.onError]
 * @param {boolean} [options.reloadEnabled]
 * @param {boolean} [options.buildVisible]
 * @param {boolean} [options.buildEnabled]
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
  if (options.onBuild !== undefined && typeof options.onBuild !== 'function') {
    throw new TypeError('onBuild must be a function');
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
    if (options.onBuild !== undefined && typeof options.locales[locale].build !== 'string') {
      throw new TypeError(`locales.${locale}.build must be a string`);
    }
  }
  const icons = {...dsl4RuntimeApplicationMenuDefaultIcons, ...(options.icons ?? {})};
  for (const action of /** @type {const} */ (['open', 'reload', 'build', 'about', 'language'])) {
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

  /** @type {Array<{action: 'open' | 'reload' | 'build' | 'about' | 'language', left: string, top: string, callback: null | Function}>} */
  const definitionList = [
    {action: 'open', left: '10%', top: '25.5556%', callback: options.onOpen},
    {action: 'reload', left: '53.3333%', top: '25.5556%', callback: options.onReload},
    {action: 'about', left: '10%', top: '58.8889%', callback: options.onAbout},
    {action: 'language', left: '53.3333%', top: '58.8889%', callback: null},
  ];
  if (options.onBuild !== undefined) {
    definitionList.splice(2, 0, {
      action: 'build',
      left: '10%',
      top: '45%',
      callback: options.onBuild,
    });
  }
  const definitions = Object.freeze(definitionList.map((definition) => Object.freeze(definition)));
  const buttons = new Map();
  /** @type {'en' | 'ja'} */
  let locale = 'en';
  let reloadEnabled = options.reloadEnabled ?? true;
  if (typeof reloadEnabled !== 'boolean') {
    throw new TypeError('reloadEnabled must be a boolean');
  }
  let buildVisible = options.onBuild !== undefined && (options.buildVisible ?? false);
  let buildEnabled = options.buildEnabled ?? false;
  if (typeof buildVisible !== 'boolean') throw new TypeError('buildVisible must be a boolean');
  if (typeof buildEnabled !== 'boolean') throw new TypeError('buildEnabled must be a boolean');
  let buildStatus = '';
  let disposed = false;
  const buttonShadow = '0 .625cqw 1.6667cqw rgba(0,0,0,.2)';

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
    button.style.cssText = `position:absolute;left:${definition.left};top:${definition.top};width:36.6667%;height:24.4444%;display:flex;min-width:0;min-height:0;align-items:center;justify-content:center;flex-direction:column;gap:.4167cqw;border:.4167cqw solid #005f50;border-radius:2.9167cqw;background:#007d66;color:#fff;box-shadow:${buttonShadow};cursor:pointer;font:inherit;`;
    button.style.cursor = 'pointer';
    icon.setAttribute('aria-hidden', 'true');
    icon.src = icons[definition.action];
    icon.alt = '';
    icon.style.cssText =
      'display:block;width:10cqw;height:10cqw;object-fit:contain;filter:invert(1) brightness(1.7) saturate(.35);';
    label.style.cssText = 'font-size:3.8cqw;line-height:1.15;text-align:center;';
    button.appendChild(icon);
    button.appendChild(label);
    const onClick = () => {
      if (
        (definition.action === 'reload' && !reloadEnabled) ||
        (definition.action === 'build' && (!buildVisible || !buildEnabled))
      ) {
        return;
      }
      if (definition.action === 'language') {
        locale = locale === 'ja' ? 'en' : 'ja';
        render();
        invoke(() => options.onLocaleChange(locale));
        return;
      }
      if (definition.callback) invoke(definition.callback);
    };
    button.addEventListener('click', onClick);
    root.appendChild(button);
    buttons.set(definition.action, {button, label, onClick});
  }
  const statusCandidate = document.createElement('p');
  if (!isRecord(statusCandidate) || typeof statusCandidate.appendChild !== 'function') {
    throw new TypeError('document must create application menu status elements');
  }
  const status = /** @type {Record<string, any>} */ (statusCandidate);
  status.setAttribute('data-dsl4-menu-build-status', 'true');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.style.cssText =
    'position:absolute;left:10%;top:93%;width:80%;margin:0;color:#004d40;font-size:2.7cqw;line-height:1.1;text-align:center;';
  root.appendChild(status);
  mount.appendChild(root);

  function render() {
    for (const [action, value] of buttons) {
      const label = options.locales[locale][action] ?? '';
      value.label.textContent = label;
      value.button.setAttribute('aria-label', label);
      const disabled =
        (action === 'reload' && !reloadEnabled) || (action === 'build' && !buildEnabled);
      const hidden = action === 'build' && !buildVisible;
      value.button.disabled = disabled;
      value.button.setAttribute('aria-disabled', String(disabled));
      value.button.hidden = hidden;
      value.button.style.display = hidden ? 'none' : 'flex';
      value.button.style.cursor = disabled ? 'not-allowed' : 'pointer';
      value.button.style.opacity = disabled ? '0.42' : '1';
      value.button.style.boxShadow = disabled ? 'none' : buttonShadow;
      if (buildVisible) {
        if (action === 'open' || action === 'reload') value.button.style.top = '18%';
        if (action === 'about' || action === 'language') value.button.style.top = '68%';
        if (action === 'build') {
          value.button.style.left = '10%';
          value.button.style.top = '43%';
          value.button.style.width = '80%';
          value.button.style.height = '20%';
        }
      } else if (action !== 'build') {
        const original = definitions.find((definition) => definition.action === action);
        value.button.style.top = original?.top ?? '';
      }
    }
    status.textContent = buildVisible ? buildStatus : '';
    status.hidden = !buildVisible || buildStatus.length === 0;
  }

  /** @param {boolean} enabled */
  function setReloadEnabled(enabled) {
    if (disposed) throw new TypeError('application menu is disposed');
    if (typeof enabled !== 'boolean') throw new TypeError('reload enabled state must be a boolean');
    reloadEnabled = enabled;
    render();
  }

  /** @param {{visible?: boolean, enabled?: boolean, status?: string}} state */
  function setBuildState(state) {
    if (disposed) throw new TypeError('application menu is disposed');
    if (!isRecord(state)) throw new TypeError('build state must be an object');
    if (state.visible !== undefined) {
      if (typeof state.visible !== 'boolean')
        throw new TypeError('build visible state must be boolean');
      buildVisible = options.onBuild !== undefined && state.visible;
    }
    if (state.enabled !== undefined) {
      if (typeof state.enabled !== 'boolean')
        throw new TypeError('build enabled state must be boolean');
      buildEnabled = state.enabled;
    }
    if (state.status !== undefined) {
      if (typeof state.status !== 'string') throw new TypeError('build status must be a string');
      buildStatus = state.status.slice(0, 500);
    }
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
  return Object.freeze({element: root, show, hide, setReloadEnabled, setBuildState, dispose});
}
