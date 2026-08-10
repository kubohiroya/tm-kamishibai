const defaultLabels = Object.freeze({
  assets: 'Loading assets',
  camera: 'Starting camera',
  default: 'Loading',
});

const progressVariants = new Set(['circular', 'bar']);
const cursorValues = new Set(['auto', 'wait', 'pointer', 'progress']);
const cursorPriority = Object.freeze({auto: 0, pointer: 1, progress: 2, wait: 3});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} label */
function requireElement(value, label) {
  if (!isRecord(value) || typeof value.appendChild !== 'function') {
    throw new TypeError(`${label} must be a DOM element`);
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
function resolveSource(value) {
  if (value === undefined) return 'default';
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('progress indicator source must be a non-empty string');
  }
  return value;
}

/** @param {unknown} value */
function resolveLabel(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('progress indicator label must be a non-empty string');
  }
  return value;
}

/** @param {unknown} value */
function resolveVariant(value) {
  const variant = value ?? 'circular';
  if (typeof variant !== 'string' || !progressVariants.has(variant)) {
    throw new TypeError('progress indicator variant must be circular or bar');
  }
  return /** @type {'circular' | 'bar'} */ (variant);
}

/** @param {unknown} value */
function resolveCursor(value) {
  const cursor = value ?? 'auto';
  if (typeof cursor !== 'string' || !cursorValues.has(cursor)) {
    throw new TypeError('progress indicator cursor must be auto, wait, pointer, or progress');
  }
  return /** @type {'auto' | 'wait' | 'pointer' | 'progress'} */ (cursor);
}

/**
 * Create a DOM-owned indeterminate progress indicator.
 *
 * Visibility is reference-counted by source so overlapping asset and camera waits do not hide
 * one another. The progressbar intentionally has no aria-valuenow/aria-valuemax attributes.
 *
 * @param {object} options
 * @param {unknown} options.document
 * @param {unknown} options.mount
 * @param {'circular' | 'bar'} [options.variant]
 * @param {Readonly<Record<string, string>>} [options.labels]
 */
export function createDsl4IndeterminateProgressIndicator(options) {
  if (!isRecord(options)) {
    throw new TypeError('indeterminate progress indicator options must be an object');
  }
  const document = requireDocument(options.document);
  const mount = requireElement(options.mount, 'progress indicator mount');
  const initialVariant = resolveVariant(options.variant);
  /** @type {Record<string, string>} */
  const labels = {...defaultLabels};
  if (options.labels !== undefined) {
    if (!isRecord(options.labels))
      throw new TypeError('progress indicator labels must be an object');
    for (const [source, label] of Object.entries(options.labels)) {
      const resolved = resolveLabel(label);
      if (resolved === null)
        throw new TypeError('progress indicator label must be a non-empty string');
      labels[source] = resolved;
    }
  }

  let disposed = false;
  /** @type {HTMLElement | null} */
  let root = null;
  /** @type {Map<string, number>} */
  const activeSources = new Map();
  /** @type {string | null} */
  let activeLabel = null;
  /** @type {'circular' | 'bar'} */
  let variant = initialVariant;
  /** @type {Map<string, 'auto' | 'wait' | 'pointer' | 'progress'>} */
  const activeCursors = new Map();
  /** @type {HTMLElement | null} */
  let cursorStyle = null;

  function createRootStyle() {
    const style = document.createElement('style');
    style.textContent = [
      '@keyframes dsl4-indeterminate-progress-spin{to{transform:rotate(360deg)}}',
      '@keyframes dsl4-indeterminate-progress-slide{0%{transform:translateX(-120%)}100%{transform:translateX(280%)}}',
    ].join('');
    return style;
  }

  function createProgressContent() {
    if (variant === 'bar') {
      const track = /** @type {HTMLElement} */ (document.createElement('span'));
      track.dataset.dsl4IndeterminateProgressTrack = 'true';
      Object.assign(track.style, {
        display: 'block',
        width: 'min(28rem, 70vw)',
        height: '0.45rem',
        overflow: 'hidden',
        borderRadius: '999px',
        background: 'rgba(255, 255, 255, 0.4)',
      });
      const fill = /** @type {HTMLElement} */ (document.createElement('span'));
      fill.dataset.dsl4IndeterminateProgressFill = 'true';
      Object.assign(fill.style, {
        display: 'block',
        width: '42%',
        height: '100%',
        borderRadius: 'inherit',
        background: '#ffffff',
        animation: 'dsl4-indeterminate-progress-slide 1.1s ease-in-out infinite',
      });
      track.appendChild(fill);
      return track;
    }
    const spinner = /** @type {HTMLElement} */ (document.createElement('span'));
    spinner.dataset.dsl4IndeterminateProgressSpinner = 'true';
    spinner.setAttribute('aria-hidden', 'true');
    Object.assign(spinner.style, {
      display: 'block',
      width: '2.25rem',
      height: '2.25rem',
      border: '0.3rem solid rgba(255, 255, 255, 0.4)',
      borderTopColor: '#ffffff',
      borderRadius: '50%',
      animation: 'dsl4-indeterminate-progress-spin 0.8s linear infinite',
    });
    return spinner;
  }

  function renderProgressContent() {
    if (!root) return;
    const style = createRootStyle();
    root.replaceChildren(style, createProgressContent());
    root.dataset.dsl4IndeterminateProgressVariant = variant;
  }

  function ensureCursorStyles() {
    if (cursorStyle) return;
    cursorStyle = /** @type {HTMLElement} */ (document.createElement('style'));
    cursorStyle.dataset.dsl4CursorStyles = 'true';
    cursorStyle.textContent = [
      '[data-dsl4-cursor-surface="true"]{cursor:auto}',
      '[data-dsl4-cursor-surface="true"][data-dsl4-cursor="wait"]{cursor:wait}',
      '[data-dsl4-cursor-surface="true"][data-dsl4-cursor="progress"]{cursor:progress}',
      '[data-dsl4-cursor-surface="true"][data-dsl4-cursor="pointer"]{cursor:pointer}',
      '[data-dsl4-cursor-surface="true"][data-dsl4-cursor] button,[data-dsl4-cursor-surface="true"][data-dsl4-cursor] [data-dsl4-tappable-actor="true"]{cursor:pointer}',
    ].join('');
    mount.appendChild(cursorStyle);
    mount.dataset.dsl4CursorSurface = 'true';
  }

  function currentCursor() {
    let selected = /** @type {'auto' | 'wait' | 'pointer' | 'progress'} */ ('auto');
    for (const cursor of activeCursors.values()) {
      if (cursorPriority[cursor] > cursorPriority[selected]) selected = cursor;
    }
    return selected;
  }

  function renderCursor() {
    if (!cursorStyle) return;
    mount.dataset.dsl4Cursor = currentCursor();
  }

  function ensureRoot() {
    if (root) return root;
    const element = /** @type {HTMLElement} */ (document.createElement('div'));
    element.dataset.dsl4IndeterminateProgress = 'true';
    element.setAttribute('role', 'progressbar');
    element.setAttribute('aria-busy', 'true');
    element.setAttribute('aria-label', labels.default);
    element.hidden = true;
    Object.assign(element.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      isolation: 'isolate',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      pointerEvents: 'none',
      background: 'rgba(0, 0, 0, 0.12)',
      cursor: 'wait',
    });
    mount.appendChild(element);
    root = element;
    renderProgressContent();
    return element;
  }

  function activeCount() {
    let count = 0;
    for (const value of activeSources.values()) count += value;
    return count;
  }

  function render() {
    if (!root) return;
    const visible = activeCount() > 0;
    root.hidden = !visible;
    root.style.display = visible ? 'flex' : 'none';
    root.setAttribute('aria-busy', String(visible));
    if (visible) root.setAttribute('aria-label', activeLabel ?? labels.default);
  }

  /** @param {unknown} input */
  function setCursor(input) {
    if (disposed) return;
    if (!isRecord(input)) throw new TypeError('progress indicator cursor state must be an object');
    if (typeof input.visible !== 'boolean') {
      throw new TypeError('progress indicator cursor visible must be boolean');
    }
    const source = resolveSource(input.source);
    const cursor = resolveCursor(input.cursor);
    if (input.visible) {
      ensureCursorStyles();
      activeCursors.set(source, cursor);
    } else {
      activeCursors.delete(source);
    }
    renderCursor();
  }

  /** @param {unknown} input */
  function setBusy(input) {
    if (disposed) return;
    if (!isRecord(input)) throw new TypeError('progress indicator state must be an object');
    if (typeof input.visible !== 'boolean') {
      throw new TypeError('progress indicator visible must be boolean');
    }
    const source = resolveSource(input.source);
    const label = resolveLabel(input.label) ?? labels[source] ?? labels.default;
    setCursor({
      visible: input.visible,
      source,
      cursor: input.cursor ?? 'wait',
    });
    const current = activeSources.get(source) ?? 0;
    if (input.visible) {
      activeSources.set(source, current + 1);
      activeLabel = label;
      ensureRoot();
    } else if (current > 0) {
      if (current === 1) activeSources.delete(source);
      else activeSources.set(source, current - 1);
      if (activeCount() === 0) activeLabel = null;
    }
    render();
  }

  /** @param {unknown} value */
  function setVariant(value) {
    if (disposed) return;
    variant = resolveVariant(value);
    renderProgressContent();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    activeSources.clear();
    activeCursors.clear();
    activeLabel = null;
    try {
      root?.remove();
      cursorStyle?.remove();
      delete mount.dataset.dsl4CursorSurface;
      delete mount.dataset.dsl4Cursor;
    } finally {
      root = null;
      cursorStyle = null;
    }
  }

  return Object.freeze({setBusy, setCursor, setVariant, dispose});
}
