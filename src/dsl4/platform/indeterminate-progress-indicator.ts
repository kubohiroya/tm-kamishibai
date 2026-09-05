const defaultLabels = Object.freeze({
  assets: 'Loading assets',
  camera: 'Starting camera',
  default: 'Loading',
});

const progressVariants = new Set(['circular', 'bar']);
const cursorValues = new Set(['auto', 'wait', 'pointer', 'progress']);
const cursorPriority = Object.freeze({auto: 0, pointer: 1, progress: 2, wait: 3});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireElement(value: unknown, label: string) {
  if (!isRecord(value) || typeof value.appendChild !== 'function') {
    throw new TypeError(`${label} must be a DOM element`);
  }
  return value as any;
}

function requireDocument(value: unknown) {
  if (!isRecord(value) || typeof value.createElement !== 'function') {
    throw new TypeError('document must provide the DOM document contract');
  }
  return value as any;
}

function resolveSource(value: unknown) {
  if (value === undefined) return 'default';
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('progress indicator source must be a non-empty string');
  }
  return value;
}

function resolveLabel(value: unknown) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('progress indicator label must be a non-empty string');
  }
  return value;
}

function resolveVariant(value: unknown) {
  const variant = value ?? 'circular';
  if (typeof variant !== 'string' || !progressVariants.has(variant)) {
    throw new TypeError('progress indicator variant must be circular or bar');
  }
  return variant as 'circular' | 'bar';
}

function resolveCursor(value: unknown) {
  const cursor = value ?? 'auto';
  if (typeof cursor !== 'string' || !cursorValues.has(cursor)) {
    throw new TypeError('progress indicator cursor must be auto, wait, pointer, or progress');
  }
  return cursor as 'auto' | 'wait' | 'pointer' | 'progress';
}

/**
 * Create a DOM-owned indeterminate progress indicator.
 * Visibility is reference-counted by source so overlapping asset and camera waits do not hide
 * one another. The progressbar intentionally has no aria-valuenow/aria-valuemax attributes.
 */
export function createDsl4IndeterminateProgressIndicator(options: {
  document: unknown;
  mount: unknown;
  variant?: 'circular' | 'bar';
  labels?: Readonly<Record<string, string>>;
}) {
  if (!isRecord(options)) {
    throw new TypeError('indeterminate progress indicator options must be an object');
  }
  const document = requireDocument(options.document);
  const mount = requireElement(options.mount, 'progress indicator mount');
  const previousMountPosition = mount.style?.position;
  if (
    mount !== document.body &&
    isRecord(mount.style) &&
    (previousMountPosition === undefined || previousMountPosition === '')
  ) {
    mount.style.position = 'relative';
  }
  const initialVariant = resolveVariant(options.variant);
  const labels: Record<string, string> = {...defaultLabels};
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
  let root: HTMLElement | null = null;
  const activeSources: Map<string, number> = new Map();
  let activeLabel: string | null = null;
  let variant: 'circular' | 'bar' = initialVariant;
  const activeCursors: Map<string, 'auto' | 'wait' | 'pointer' | 'progress'> = new Map();
  let cursorStyle: HTMLElement | null = null;

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
      const track = document.createElement('span') as HTMLElement;
      track.dataset.dsl4IndeterminateProgressTrack = 'true';
      Object.assign(track.style, {
        display: 'block',
        width: 'min(28rem, 70vw)',
        height: '0.45rem',
        overflow: 'hidden',
        borderRadius: '999px',
        background: 'rgba(255, 255, 255, 0.4)',
      });
      const fill = document.createElement('span') as HTMLElement;
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
    const spinner = document.createElement('span') as HTMLElement;
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
    cursorStyle = document.createElement('style') as HTMLElement;
    cursorStyle.dataset.dsl4CursorStyles = 'true';
    cursorStyle.textContent = [
      '[data-dsl4-cursor-surface="true"]{cursor:auto}',
      '[data-dsl4-cursor-surface="true"][data-dsl4-cursor="wait"]{cursor:wait}',
      '[data-dsl4-cursor-surface="true"][data-dsl4-cursor="progress"]{cursor:progress}',
      '[data-dsl4-cursor-surface="true"][data-dsl4-cursor="pointer"]{cursor:pointer}',
      '[data-dsl4-cursor-surface="true"][data-dsl4-cursor="wait"] canvas{cursor:wait!important}',
      '[data-dsl4-cursor-surface="true"][data-dsl4-cursor="progress"] canvas{cursor:progress!important}',
      '[data-dsl4-cursor-surface="true"][data-dsl4-cursor="pointer"] canvas{cursor:pointer!important}',
      '[data-dsl4-cursor-surface="true"][data-dsl4-cursor] button:not(:disabled):not([aria-disabled="true"]),[data-dsl4-cursor-surface="true"][data-dsl4-cursor] [data-dsl4-tappable-actor="true"]{cursor:pointer}',
      '[data-dsl4-cursor-surface="true"][data-dsl4-cursor] button:disabled,[data-dsl4-cursor-surface="true"][data-dsl4-cursor] button[aria-disabled="true"]{cursor:not-allowed}',
    ].join('');
    mount.appendChild(cursorStyle);
    mount.dataset.dsl4CursorSurface = 'true';
  }

  function currentCursor() {
    let selected = 'auto' as 'auto' | 'wait' | 'pointer' | 'progress';
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
    const element = document.createElement('div') as HTMLElement;
    element.dataset.dsl4IndeterminateProgress = 'true';
    element.setAttribute('role', 'progressbar');
    element.setAttribute('aria-busy', 'true');
    element.setAttribute('aria-label', labels.default);
    element.hidden = true;
    Object.assign(element.style, {
      position: 'absolute',
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

  function setCursor(input: unknown) {
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

  function setBusy(input: unknown) {
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

  function setVariant(value: unknown) {
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
      if (
        mount !== document.body &&
        isRecord(mount.style) &&
        (previousMountPosition === undefined || previousMountPosition === '')
      ) {
        mount.style.position = previousMountPosition ?? '';
      }
    } finally {
      root = null;
      cursorStyle = null;
    }
  }

  return Object.freeze({setBusy, setCursor, setVariant, dispose});
}
