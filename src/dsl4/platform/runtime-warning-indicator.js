/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name */
function requireElement(value, name) {
  if (!isRecord(value) || typeof value.appendChild !== 'function') {
    throw new TypeError(`${name} must be a DOM element`);
  }
  return value;
}

/** @param {unknown} value */
function boundedText(value) {
  const scalars = [...String(value ?? '')];
  return scalars.length <= 2_000 ? scalars.join('') : `${scalars.slice(0, 1_999).join('')}…`;
}

/**
 * Display a bounded, non-modal runtime warning inside the Scratch stage mount.
 *
 * @param {{document: unknown, mount: unknown}} options
 */
export function createDsl4RuntimeWarningIndicator(options) {
  if (!isRecord(options)) throw new TypeError('Runtime warning indicator options are required');
  const document = options.document;
  if (!isRecord(document) || typeof document.createElement !== 'function') {
    throw new TypeError('document must provide the DOM document contract');
  }
  const mount = requireElement(options.mount, 'mount');
  const root = requireElement(document.createElement('section'), 'root');
  const message = requireElement(document.createElement('p'), 'message');
  const code = requireElement(document.createElement('code'), 'code');
  const close = requireElement(document.createElement('button'), 'close');
  if (typeof close.addEventListener !== 'function') {
    throw new TypeError('close must support DOM events');
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
    'position:absolute;left:50%;bottom:18px;z-index:2147483646;display:none;align-items:flex-start;gap:12px;width:min(620px,90%);padding:14px 16px;box-sizing:border-box;transform:translateX(-50%);background:rgba(255,248,225,.96);border:2px solid #9a6700;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);color:#4d3500;font-family:sans-serif;cursor:auto;';
  root.style.display = 'none';
  root.style.position = 'absolute';
  message.style.cssText = 'flex:1;margin:0;white-space:pre-wrap;font-size:14px;line-height:1.45;';
  code.style.cssText =
    'display:none;flex:none;padding:3px 5px;background:#f1dfac;border-radius:4px;font:12px monospace;';
  close.style.cssText =
    'flex:none;margin:-4px -4px 0 0;padding:4px 8px;border:0;background:transparent;color:inherit;font-size:20px;line-height:1;cursor:pointer;';
  close.style.cursor = 'pointer';
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss warning');
  root.setAttribute('data-dsl4-runtime-warning', 'true');
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.appendChild(message);
  root.appendChild(code);
  root.appendChild(close);
  mount.appendChild(root);

  let disposed = false;
  close.addEventListener('click', () => {
    if (!disposed) root.style.display = 'none';
  });

  return Object.freeze({
    element: root,
    /** @param {{message: unknown, code?: unknown}} diagnostic */
    show(diagnostic) {
      if (disposed) throw new TypeError('Runtime warning indicator is disposed');
      if (!isRecord(diagnostic)) throw new TypeError('diagnostic must be an object');
      message.textContent = boundedText(diagnostic.message);
      code.textContent = boundedText(diagnostic.code);
      code.style.display = code.textContent.length > 0 ? 'inline-block' : 'none';
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
