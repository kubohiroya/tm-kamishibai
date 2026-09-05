import {resolveAppShellLocale} from '@kubohiroya/turbowarp-app-shell';

const localeKeys = new Set(['en', 'ja']);
const interfaceLocales = Object.freeze({
  en: Object.freeze({
    code: 'Error code',
    source: 'File',
    location: 'Location',
    path: 'Invalid field',
    excerpt: 'Source line',
    returnToMenu: 'Back to menu',
  }),
  ja: Object.freeze({
    code: 'エラーコード',
    source: 'ファイル',
    location: '位置',
    path: '不正な記述箇所',
    excerpt: '該当行',
    returnToMenu: 'メニューに戻る',
  }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireElement(value: unknown, name: string) {
  if (!isRecord(value) || typeof value.appendChild !== 'function') {
    throw new TypeError(`${name} must be a DOM element`);
  }
  return value as any;
}

function requireDocument(value: unknown) {
  if (!isRecord(value) || typeof value.createElement !== 'function') {
    throw new TypeError('document must provide the DOM document contract');
  }
  return value as any;
}

function requireLocales(value: unknown) {
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
  return value as Readonly<Record<'en' | 'ja', {title: string}>>;
}

function boundedText(value: unknown) {
  const text = String(value ?? '');
  const scalars = [...text];
  return scalars.length <= 2_000 ? text : `${scalars.slice(0, 1_999).join('')}…`;
}

function positivePosition(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 1 ? Number(value) : null;
}

function diagnosticLocation(diagnostic: unknown) {
  if (!isRecord(diagnostic) || !isRecord(diagnostic.range) || !isRecord(diagnostic.range.start)) {
    return '';
  }
  const line = positivePosition(diagnostic.range.start.line);
  const column = positivePosition(diagnostic.range.start.column);
  if (line === null) return '';
  return column === null ? String(line) : `${line}:${column}`;
}

/** Display a fatal DSL 4.0 startup/runtime diagnostic inside the Scratch stage mount. */
export function createDsl4RuntimeErrorIndicator(options: {
  document: unknown;
  mount: unknown;
  locales: unknown;
  initialLocale?: 'en' | 'ja';
  onReturnToMenu?: () => unknown | Promise<unknown>;
}) {
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
  if (options.onReturnToMenu !== undefined && typeof options.onReturnToMenu !== 'function') {
    throw new TypeError('onReturnToMenu must be a function');
  }

  const root = document.createElement('section');
  const panel = document.createElement('div');
  const heading = document.createElement('h1');
  const content = document.createElement('div');
  const message = document.createElement('p');
  const details = document.createElement('dl');
  const excerpt = document.createElement('pre');
  const actions = document.createElement('div');
  const returnButton = document.createElement('button');
  for (const [element, name] of [
    [root, 'root'],
    [panel, 'panel'],
    [heading, 'heading'],
    [content, 'content'],
    [message, 'message'],
    [details, 'details'],
    [excerpt, 'excerpt'],
    [actions, 'actions'],
    [returnButton, 'returnButton'],
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
    'width:min(680px,94%);max-height:86%;display:flex;flex-direction:column;overflow:hidden;padding:24px;box-sizing:border-box;background:#fff4f4;border:2px solid #b00020;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.4);color:#5c0011;';
  heading.style.cssText = 'margin:0 0 14px;font-size:26px;line-height:1.3;';
  content.style.cssText = 'min-height:0;overflow:auto;padding-right:4px;';
  message.style.cssText =
    'margin:0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font-size:16px;line-height:1.5;';
  details.style.cssText =
    'display:none;grid-template-columns:max-content minmax(0,1fr);gap:8px 14px;margin:18px 0 0;padding:14px;background:#f5d9de;border-radius:6px;font-size:14px;line-height:1.45;';
  excerpt.style.cssText =
    'display:none;margin:14px 0 0;padding:10px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;background:#fff;border:1px solid #d9a8b1;border-radius:5px;color:#42000c;font:13px/1.5 monospace;';
  actions.style.cssText = 'display:none;justify-content:flex-end;margin-top:18px;';
  returnButton.style.cssText =
    'min-height:44px;padding:9px 18px;border:0;border-radius:6px;background:#b00020;color:#fff;font:700 16px/1.4 sans-serif;cursor:pointer;';
  root.setAttribute('data-dsl4-runtime-error', 'true');
  root.setAttribute('role', 'alertdialog');
  root.setAttribute('aria-live', 'assertive');
  root.setAttribute('aria-modal', 'true');
  heading.id = 'dsl4-runtime-error-title';
  message.id = 'dsl4-runtime-error-message';
  heading.setAttribute('data-dsl4-runtime-error-title', 'true');
  message.setAttribute('data-dsl4-runtime-error-message', 'true');
  root.setAttribute('aria-labelledby', heading.id);
  root.setAttribute('aria-describedby', message.id);
  returnButton.type = 'button';
  returnButton.setAttribute('data-dsl4-runtime-error-action', 'menu');
  content.appendChild(message);
  content.appendChild(details);
  content.appendChild(excerpt);
  actions.appendChild(returnButton);
  panel.appendChild(heading);
  panel.appendChild(content);
  panel.appendChild(actions);
  root.appendChild(panel);
  mount.appendChild(root);

  const locale = options.initialLocale ?? (resolveAppShellLocale() as 'en' | 'ja');
  const labels = interfaceLocales[locale];
  heading.textContent = locales[locale].title;
  returnButton.textContent = labels.returnToMenu;
  let disposed = false;

  const detailRows = Object.freeze(
    Object.fromEntries(
      [
        ['code', labels.code],
        ['source', labels.source],
        ['location', labels.location],
        ['path', labels.path],
      ].map(([key, label]) => {
        const term = document.createElement('dt');
        const value = document.createElement('dd');
        requireElement(term, `${key}Term`);
        requireElement(value, `${key}Value`);
        term.textContent = label;
        term.style.cssText = 'margin:0;font-weight:700;';
        value.style.cssText =
          'display:none;margin:0;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font-family:monospace;';
        value.setAttribute(`data-dsl4-runtime-error-${key}`, 'true');
        term.hidden = true;
        details.appendChild(term);
        details.appendChild(value);
        return [key, {term, value}];
      }),
    ),
  );
  excerpt.setAttribute('data-dsl4-runtime-error-excerpt', 'true');
  excerpt.setAttribute('aria-label', labels.excerpt);

  function renderDetail(key: string, value: unknown) {
    const row = detailRows[key];
    const rendered = boundedText(value);
    row.value.textContent = rendered;
    row.term.hidden = rendered.length === 0;
    row.value.style.display = rendered.length === 0 ? 'none' : 'block';
    return rendered.length > 0;
  }

  async function onReturn() {
    if (disposed || returnButton.disabled) return;
    returnButton.disabled = true;
    try {
      await options.onReturnToMenu?.();
    } finally {
      if (!disposed) returnButton.disabled = false;
    }
  }
  returnButton.addEventListener('click', onReturn);

  return Object.freeze({
    element: root,
    /**
     */
    show(diagnostic: Record<string, unknown>, showOptions: {returnToMenu?: boolean} = {}) {
      if (disposed) throw new TypeError('Runtime error indicator is disposed');
      if (!isRecord(diagnostic)) throw new TypeError('diagnostic must be an object');
      if (!isRecord(showOptions)) throw new TypeError('showOptions must be an object');
      if (showOptions.returnToMenu !== undefined && typeof showOptions.returnToMenu !== 'boolean') {
        throw new TypeError('showOptions.returnToMenu must be a boolean');
      }
      const renderedTitle = boundedText(diagnostic.title);
      heading.textContent = renderedTitle.length > 0 ? renderedTitle : locales[locale].title;
      const renderedMessage = boundedText(diagnostic.message);
      message.textContent = renderedMessage.length > 0 ? renderedMessage : locales[locale].title;
      const hasDetails = [
        renderDetail('code', diagnostic.code),
        renderDetail('source', diagnostic.displayName ?? diagnostic.sourceId),
        renderDetail('location', diagnosticLocation(diagnostic)),
        renderDetail('path', diagnostic.path ?? diagnostic.storyPath),
      ].some(Boolean);
      details.style.display = hasDetails ? 'grid' : 'none';
      const renderedExcerpt = boundedText(diagnostic.excerpt);
      excerpt.textContent = renderedExcerpt;
      excerpt.style.display = renderedExcerpt.length > 0 ? 'block' : 'none';
      actions.style.display = showOptions.returnToMenu === true ? 'flex' : 'none';
      returnButton.disabled = false;
      root.style.display = 'flex';
      if (showOptions.returnToMenu === true) returnButton.focus?.();
    },
    hide() {
      if (!disposed) root.style.display = 'none';
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      returnButton.removeEventListener('click', onReturn);
      if (typeof root.remove === 'function') root.remove();
      restoreMountPosition?.();
    },
  });
}
