const localeKeys = new Set(['en', 'ja']);

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
function requireLocales(value) {
  if (!isRecord(value)) throw new TypeError('locales must be an object');
  for (const locale of localeKeys) {
    const localized = value[locale];
    if (
      !isRecord(localized) ||
      typeof localized.title !== 'string' ||
      localized.title.length === 0
    ) {
      throw new TypeError(`locales.${locale}.title must be a non-empty string`);
    }
  }
  return /** @type {Readonly<Record<'en' | 'ja', {title: string}>>} */ (value);
}

/** @returns {'en' | 'ja'} */
function resolveBrowserLocale() {
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
function boundedText(value) {
  const text = String(value ?? '');
  const scalars = [...text];
  return scalars.length <= 2_000 ? text : `${scalars.slice(0, 1_999).join('')}…`;
}

/**
 * Display a fatal DSL 4.0 startup/runtime diagnostic inside the Scratch stage mount.
 *
 * @param {object} options
 * @param {unknown} options.document
 * @param {unknown} options.mount
 * @param {unknown} options.locales
 * @param {'en' | 'ja'} [options.initialLocale]
 */
export function createDsl4RuntimeErrorIndicator(options) {
  if (!isRecord(options)) throw new TypeError('Runtime error indicator options must be an object');
  const document = requireDocument(options.document);
  const mount = requireElement(options.mount, 'mount');
  const locales = requireLocales(options.locales);
  if (
    options.initialLocale !== undefined &&
    (typeof options.initialLocale !== 'string' || !localeKeys.has(options.initialLocale))
  ) {
    throw new TypeError('initialLocale must be en or ja');
  }

  const root = document.createElement('section');
  const panel = document.createElement('div');
  const heading = document.createElement('h1');
  const message = document.createElement('p');
  const code = document.createElement('code');
  for (const [element, name] of [
    [root, 'root'],
    [panel, 'panel'],
    [heading, 'heading'],
    [message, 'message'],
    [code, 'code'],
  ]) {
    requireElement(element, name);
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
  root.style.cssText =
    'position:absolute;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;background:rgba(20,0,0,.72);font-family:sans-serif;cursor:auto;';
  root.style.display = 'none';
  root.style.position = 'absolute';
  root.style.cursor = 'auto';
  panel.style.cssText =
    'width:min(560px,90%);max-height:80%;overflow:auto;padding:24px;box-sizing:border-box;background:#fff4f4;border:2px solid #b00020;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.4);color:#5c0011;';
  heading.style.cssText = 'margin:0 0 14px;font-size:26px;line-height:1.3;';
  message.style.cssText = 'margin:0;white-space:pre-wrap;font-size:16px;line-height:1.5;';
  code.style.cssText =
    'display:none;margin-top:14px;padding:6px 8px;background:#f5d9de;border-radius:4px;font-family:monospace;';
  root.setAttribute('data-dsl4-runtime-error', 'true');
  root.setAttribute('role', 'alertdialog');
  root.setAttribute('aria-live', 'assertive');
  panel.appendChild(heading);
  panel.appendChild(message);
  panel.appendChild(code);
  root.appendChild(panel);
  mount.appendChild(root);

  const locale = /** @type {'en' | 'ja'} */ (options.initialLocale ?? resolveBrowserLocale());
  heading.textContent = locales[locale].title;
  let disposed = false;

  return Object.freeze({
    element: root,
    /** @param {{message: unknown, code?: unknown, title?: unknown}} diagnostic */
    show(diagnostic) {
      if (disposed) throw new TypeError('Runtime error indicator is disposed');
      if (!isRecord(diagnostic)) throw new TypeError('diagnostic must be an object');
      const renderedTitle = boundedText(diagnostic.title);
      heading.textContent = renderedTitle.length > 0 ? renderedTitle : locales[locale].title;
      const renderedMessage = boundedText(diagnostic.message);
      message.textContent = renderedMessage.length > 0 ? renderedMessage : locales[locale].title;
      const renderedCode = boundedText(diagnostic.code);
      code.textContent = renderedCode;
      code.style.display = renderedCode.length > 0 ? 'inline-block' : 'none';
      root.style.display = 'flex';
    },
    hide() {
      if (!disposed) root.style.display = 'none';
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (typeof root.remove === 'function') root.remove();
      restoreMountPosition?.();
    },
  });
}
