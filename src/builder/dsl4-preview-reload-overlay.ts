import {dsl4PreviewReloadAnchors} from '../dsl4/preview-layout-coordinator.js';
import {deepFreeze} from '../dsl4/story-document.js';

const storageKey = 'dsl4.preview.reload.anchor.v1';
const anchorSet = new Set(dsl4PreviewReloadAnchors);
const surfaces = new Set(['web', 'cli']);
const statePresentation = Object.freeze({
  watching: {icon: '↻', badge: 'Watching', label: 'Reload status: watching for changes'},
  stabilizing: {icon: '…', badge: 'Checking', label: 'Reload status: stabilizing changes'},
  applying: {icon: '↻', badge: 'Applying', label: 'Reload status: applying a validated change'},
  reloaded: {icon: '✓', badge: 'Reloaded', label: 'Reload status: reload completed'},
  diagnostic: {icon: '!', badge: 'Error', label: 'Reload status: preview needs attention'},
  paused: {icon: 'Ⅱ', badge: 'Paused', label: 'Reload status: watching is paused'},
  disconnected: {icon: '×', badge: 'Offline', label: 'Reload status: preview is disconnected'},
}) as Readonly<Record<string, Readonly<{icon: string; badge: string; label: string}>>>;
const anchorLabels = Object.freeze({
  'top-left': '左上',
  'top-center': '上中央',
  'top-right': '右上',
  'right-center': '右中央',
  'bottom-right': '右下',
  'bottom-center': '下中央',
  'bottom-left': '左下',
  'left-center': '左中央',
}) as Readonly<Record<string, string>>;
const anchorNeighbors = Object.freeze({
  'top-left': {ArrowRight: 'top-center', ArrowDown: 'left-center'},
  'top-center': {ArrowLeft: 'top-left', ArrowRight: 'top-right', ArrowDown: 'bottom-center'},
  'top-right': {ArrowLeft: 'top-center', ArrowDown: 'right-center'},
  'right-center': {ArrowUp: 'top-right', ArrowDown: 'bottom-right', ArrowLeft: 'left-center'},
  'bottom-right': {ArrowUp: 'right-center', ArrowLeft: 'bottom-center'},
  'bottom-center': {ArrowLeft: 'bottom-left', ArrowRight: 'bottom-right', ArrowUp: 'top-center'},
  'bottom-left': {ArrowUp: 'left-center', ArrowRight: 'bottom-center'},
  'left-center': {ArrowUp: 'top-left', ArrowDown: 'bottom-left', ArrowRight: 'right-center'},
}) as Readonly<Record<string, Readonly<Record<string, string>>>>;
const positionShortcuts = Object.freeze({
  Digit1: 'story',
  Digit2: 'scene',
  Digit3: 'action',
}) as Readonly<Record<string, string>>;

export const dsl4PreviewReloadOverlayManifest = deepFreeze({
  formatVersion: 1,
  production: false,
  module: 'src/builder/dsl4-preview-reload-overlay.js',
  surfaces: ['web', 'cli'],
  featureFlag: 'dsl4PreviewReloadOverlay',
  storageKey,
  targetCssPixels: 44,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireDocument(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.createElement !== 'function' ||
    typeof value.addEventListener !== 'function' ||
    typeof value.removeEventListener !== 'function'
  ) {
    throw new TypeError('reload overlay requires a DOM document');
  }
  return value as Record<string, any>;
}

function requireElement(value: unknown) {
  if (!isRecord(value) || typeof value.appendChild !== 'function') {
    throw new TypeError('reload overlay mount must be a DOM element');
  }
  return value as Record<string, any>;
}

function validatePolicy(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.getState !== 'function' ||
    typeof value.subscribe !== 'function' ||
    typeof value.openDialog !== 'function' ||
    typeof value.selectPosition !== 'function' ||
    typeof value.applyScope !== 'function' ||
    typeof value.acknowledge !== 'function' ||
    typeof value.whenIdle !== 'function'
  ) {
    throw new TypeError('reload overlay requires a reload policy');
  }
  return value as Record<string, Function>;
}

function validateLayout(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.resolve !== 'function' ||
    typeof value.setInteraction !== 'function' ||
    typeof value.getState !== 'function'
  ) {
    throw new TypeError('reload overlay requires a layout coordinator');
  }
  return value as Record<string, Function>;
}

function validateDebugExecution(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.getState !== 'function' ||
    typeof value.subscribe !== 'function' ||
    typeof value.setMode !== 'function' ||
    typeof value.resume !== 'function'
  ) {
    throw new TypeError(
      'reload overlay debug execution must provide state, subscription, mode, and resume controls',
    );
  }
  return value as Record<string, Function>;
}

function element(document: Record<string, any>, tag: string, text?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function preferredAnchor(value: unknown) {
  return typeof value === 'string' && anchorSet.has(value) ? value : 'top-right';
}

/** Create one shared Web/CLI browser reload overlay around a transport-neutral policy. */
export function createDsl4PreviewReloadOverlay(options: {
  surface: 'web' | 'cli';
  document: unknown;
  mount: unknown;
  policy: Record<string, Function>;
  layoutCoordinator: Record<string, Function>;
  debugExecution?: Record<string, Function> | undefined;
  storage?: {getItem?: Function; setItem?: Function};
  formatTime?: (timestamp: number) => string;
  reducedMotion?: boolean;
  onError?: (error: unknown) => unknown;
}) {
  if (!isRecord(options)) throw new TypeError('reload overlay options are required');
  if (typeof options.surface !== 'string' || !surfaces.has(options.surface)) {
    throw new TypeError('reload overlay surface must be web or cli');
  }
  const document = requireDocument(options.document);
  const mount = requireElement(options.mount);
  const policy = validatePolicy(options.policy);
  const layout = validateLayout(options.layoutCoordinator);
  const debugExecution =
    options.debugExecution === undefined ? null : validateDebugExecution(options.debugExecution);
  if (options.storage !== undefined && !isRecord(options.storage)) {
    throw new TypeError('reload overlay storage must be an object');
  }
  if (options.formatTime !== undefined && typeof options.formatTime !== 'function') {
    throw new TypeError('formatTime must be a function');
  }
  if (options.reducedMotion !== undefined && typeof options.reducedMotion !== 'boolean') {
    throw new TypeError('reducedMotion must be boolean');
  }
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new TypeError('onError must be a function');
  }
  const formatTime =
    options.formatTime ??
    ((value: number) =>
      new Intl.DateTimeFormat(undefined, {dateStyle: 'short', timeStyle: 'medium'}).format(value));
  const storage = (options.storage ?? {}) as Record<string, Function>;

  function reportError(error: unknown) {
    try {
      options.onError?.(error);
    } catch {
      // Error observers cannot change overlay state.
    }
  }

  let selectedAnchor: string = 'top-right';
  try {
    selectedAnchor = preferredAnchor(storage.getItem?.(storageKey));
  } catch (error) {
    reportError(error);
  }

  const host = element(document, 'section');
  host.id = 'dsl4-preview-reload-overlay';
  host.setAttribute('data-dsl4-development-only', 'true');
  host.setAttribute('data-preview-surface', options.surface);
  host.setAttribute('data-reduced-motion', options.reducedMotion === true ? 'true' : 'false');

  const statusButton = element(document, 'button');
  statusButton.id = 'dsl4-preview-reload-status-button';
  statusButton.type = 'button';
  statusButton.style.position = 'fixed';
  statusButton.style.boxSizing = 'border-box';
  statusButton.style.width = '44px';
  statusButton.style.height = '44px';
  statusButton.style.minWidth = '44px';
  statusButton.style.minHeight = '44px';
  statusButton.style.margin = '0';
  statusButton.style.padding = '0';
  statusButton.style.overflow = 'hidden';
  statusButton.style.zIndex = '20';
  statusButton.style.color = '#ffffff';
  statusButton.style.background = 'rgba(31, 41, 55, 0.82)';
  statusButton.style.border = '2px solid #ffffff';
  statusButton.style.outline = '3px solid #facc15';
  statusButton.style.outlineOffset = '2px';
  statusButton.style.boxShadow = '0 0 0 2px #111827';
  statusButton.setAttribute('aria-haspopup', 'dialog');
  statusButton.setAttribute('aria-controls', 'dsl4-preview-reload-status-dialog');
  const icon = element(document, 'span');
  icon.id = 'dsl4-preview-reload-status-icon';
  icon.setAttribute('aria-hidden', 'true');
  const badge = element(document, 'span');
  badge.id = 'dsl4-preview-reload-status-badge';
  statusButton.append(icon, badge);

  const polite = element(document, 'p');
  polite.id = 'dsl4-preview-reload-live-status';
  polite.setAttribute('role', 'status');
  polite.setAttribute('aria-live', 'polite');
  polite.setAttribute('aria-atomic', 'true');
  const assertive = element(document, 'p');
  assertive.id = 'dsl4-preview-reload-live-diagnostic';
  assertive.setAttribute('role', 'alert');
  assertive.setAttribute('aria-live', 'assertive');
  assertive.setAttribute('aria-atomic', 'true');

  const dialog = element(document, 'div');
  dialog.id = 'dsl4-preview-reload-status-dialog';
  dialog.hidden = true;
  dialog.style.zIndex = '30';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'dsl4-preview-reload-dialog-title');
  const title = element(document, 'h2', 'Reload status and preferences');
  title.id = 'dsl4-preview-reload-dialog-title';
  title.tabIndex = -1;
  const close = element(document, 'button', 'キャンセル');
  close.id = 'dsl4-preview-reload-dialog-close';
  close.type = 'button';
  close.setAttribute('aria-label', '未確定の変更を破棄して閉じる');
  const latest = element(document, 'p');
  latest.id = 'dsl4-preview-reload-latest';
  const currentPreference = element(document, 'p');
  currentPreference.id = 'dsl4-preview-reload-current-preference';
  const actualAnchor = element(document, 'p');
  actualAnchor.id = 'dsl4-preview-reload-actual-anchor';
  const stale = element(document, 'p');
  stale.id = 'dsl4-preview-reload-stale';
  stale.setAttribute('role', 'status');

  const positionGroup = element(document, 'div');
  positionGroup.id = 'dsl4-preview-reload-position-step';
  positionGroup.setAttribute('role', 'radiogroup');
  positionGroup.setAttribute('aria-label', '再開位置');
  const positionButtons = new Map();
  for (const [value, label] of [
    ['story', 'ストーリーの最初から'],
    ['scene', 'このsceneの最初から'],
    ['action', 'このactionから'],
  ]) {
    const button = element(document, 'button', label);
    button.id = `dsl4-preview-reload-position-${value}`;
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');
    button.setAttribute('data-reload-position', value);
    positionButtons.set(value, button);
    positionGroup.appendChild(button);
  }

  const scopeGroup = element(document, 'div');
  scopeGroup.id = 'dsl4-preview-reload-scope-step';
  scopeGroup.hidden = true;
  const scopeButtons = new Map();
  for (const [value, label] of [
    ['reload-once', 'この位置から今回だけreload'],
    ['reload-and-save', 'この位置からreloadし、次回以降も使用'],
    ['save-next', '今はreloadせず、次回以降に使用'],
    ['cancel', 'キャンセル'],
  ]) {
    const button = element(document, 'button', label);
    button.id = `dsl4-preview-reload-scope-${value}`;
    button.type = 'button';
    button.setAttribute('data-reload-scope', value);
    scopeButtons.set(value, button);
    scopeGroup.appendChild(button);
  }

  const anchorTitle = element(document, 'h3', 'Reload button position');
  const anchorGroup = element(document, 'div');
  anchorGroup.id = 'dsl4-preview-reload-anchor-selector';
  anchorGroup.setAttribute('role', 'radiogroup');
  anchorGroup.setAttribute('aria-label', 'Reload button position');
  const anchorButtons = new Map();
  for (const value of dsl4PreviewReloadAnchors) {
    const button = element(document, 'button', anchorLabels[value]);
    button.id = `dsl4-preview-reload-anchor-${value}`;
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('data-reload-anchor', value);
    anchorButtons.set(value, button);
    anchorGroup.appendChild(button);
  }
  const anchorSummary = element(document, 'p');
  anchorSummary.id = 'dsl4-preview-reload-anchor-summary';
  const resetAnchor = element(document, 'button', '既定位置へ戻す');
  resetAnchor.id = 'dsl4-preview-reload-anchor-reset';
  resetAnchor.type = 'button';

  const debugTitle = element(document, 'h3', 'デバッグ実行');
  const debugModeGroup = element(document, 'div');
  debugModeGroup.id = 'dsl4-preview-debug-mode-selector';
  debugModeGroup.setAttribute('role', 'radiogroup');
  debugModeGroup.setAttribute('aria-label', 'デバッグ実行モード');
  const debugModeButtons = new Map();
  for (const [value, label] of [
    ['breakpoints', 'debugger で停止'],
    ['step', '1 action ずつ実行'],
  ]) {
    const button = element(document, 'button', label);
    button.id = `dsl4-preview-debug-mode-${value}`;
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');
    button.setAttribute('data-debug-mode', value);
    debugModeButtons.set(value, button);
    debugModeGroup.appendChild(button);
  }
  const debugSummary = element(document, 'p');
  debugSummary.id = 'dsl4-preview-debug-summary';
  debugSummary.setAttribute('role', 'status');
  debugSummary.setAttribute('aria-live', 'polite');
  const debugResume = element(document, 'button', 'この action を実行');
  debugResume.id = 'dsl4-preview-debug-resume';
  debugResume.type = 'button';
  debugResume.hidden = true;

  dialog.append(
    title,
    close,
    latest,
    currentPreference,
    actualAnchor,
    stale,
    positionGroup,
    scopeGroup,
    anchorTitle,
    anchorGroup,
    anchorSummary,
    resetAnchor,
    ...(debugExecution ? [debugTitle, debugModeGroup, debugSummary, debugResume] : []),
  );
  host.append(statusButton, polite, assertive, dialog);
  mount.appendChild(host);

  let disposed = false;
  let lastStatus = '';
  let lastDiagnosticCode: string | null = null;
  let pending: Promise<unknown>[] = [];
  let lastPolicyState = policy.getState();
  let lastDebugState = debugExecution?.getState() ?? null;
  let activePointerId: number | null = null;

  function observe(operation: unknown) {
    const observed = Promise.resolve(operation).catch((error) => {
      reportError(error);
      throw error;
    });
    const contained = observed.catch(() => {});
    pending.push(contained);
    void contained.then(() => {
      pending = pending.filter((entry) => entry !== contained);
    });
    return observed;
  }

  function resolveLayout() {
    const resolved = layout.resolve(selectedAnchor);
    statusButton.style.left = `${resolved.rect.x}px`;
    statusButton.style.top = `${resolved.rect.y}px`;
    statusButton.setAttribute('data-preferred-anchor', selectedAnchor);
    statusButton.setAttribute('data-resolved-anchor', resolved.resolvedAnchor);
    statusButton.setAttribute('data-layout-stacked', resolved.stacked ? 'true' : 'false');
    anchorSummary.textContent = resolved.collisionReason
      ? `希望: ${anchorLabels[selectedAnchor]} / 表示: ${anchorLabels[resolved.resolvedAnchor]}（${resolved.collisionReason}）`
      : `希望・表示: ${anchorLabels[selectedAnchor]}`;
    for (const [value, button] of anchorButtons) {
      button.setAttribute('aria-checked', value === selectedAnchor ? 'true' : 'false');
    }
    return resolved;
  }

  function setPreferredAnchor(value: string) {
    selectedAnchor = preferredAnchor(value);
    try {
      storage.setItem?.(storageKey, selectedAnchor);
    } catch (error) {
      reportError(error);
    }
    return resolveLayout();
  }

  function renderStatusPresentation() {
    const debugPaused = lastDebugState?.paused === true;
    const presentation = debugPaused
      ? {
          icon: 'Ⅱ',
          badge: 'Debug',
          label: `Debug paused before ${lastDebugState.command} in ${lastDebugState.sceneId}`,
        }
      : (statePresentation[lastPolicyState.status] ?? statePresentation.watching);
    const statusKey = debugPaused ? 'debug-paused' : lastPolicyState.status;
    statusButton.setAttribute('data-reload-state', lastPolicyState.status);
    statusButton.setAttribute(
      'data-debug-state',
      lastDebugState?.status ?? (debugExecution ? 'running' : 'disabled'),
    );
    statusButton.setAttribute('aria-label', presentation.label);
    icon.textContent = presentation.icon;
    badge.textContent = presentation.badge;
    if (lastStatus !== statusKey) {
      polite.textContent = debugPaused
        ? `Debug paused: ${lastDebugState.sceneId}, action ${Number(lastDebugState.actionIndex) + 1}, ${lastDebugState.command}`
        : `Reload status: ${presentation.badge}`;
      lastStatus = statusKey;
    }
  }

  function renderDebug(state: Readonly<Record<string, any>>) {
    if (disposed || !debugExecution) return;
    lastDebugState = state;
    host.setAttribute('data-debug-state', state.status);
    for (const [value, button] of debugModeButtons) {
      button.setAttribute('aria-checked', value === state.mode ? 'true' : 'false');
    }
    if (state.paused) {
      debugSummary.textContent = `${state.reason === 'debugger' ? 'debugger' : 'ステップ実行'}で停止中: ${state.sceneId} / action ${Number(state.actionIndex) + 1} (${state.command})`;
      debugResume.hidden = false;
      debugResume.disabled = false;
    } else {
      debugSummary.textContent =
        state.mode === 'step'
          ? 'ステップ実行: 各 action の直前で停止します。'
          : 'ブレークポイント実行: debugger action の直前で停止します。';
      debugResume.hidden = true;
      debugResume.disabled = true;
    }
    renderStatusPresentation();
  }

  function render(state: Readonly<Record<string, any>>) {
    if (disposed) return;
    const previousDialogStep = lastPolicyState.dialog.step;
    lastPolicyState = state;
    renderStatusPresentation();
    const diagnosticCode = state.diagnostic?.code ?? null;
    if (diagnosticCode && diagnosticCode !== lastDiagnosticCode) {
      assertive.textContent = `${diagnosticCode}: ${state.diagnostic.message}`;
    } else if (!diagnosticCode) {
      assertive.textContent = '';
    }
    lastDiagnosticCode = diagnosticCode;

    const wasOpen = !dialog.hidden;
    dialog.hidden = !state.dialog.open;
    if (state.dialog.open) {
      latest.textContent = state.lastSuccess
        ? `Latest successful reload: ${formatTime(state.lastSuccess.acknowledgedAt)}`
        : 'まだ reload されていません';
      currentPreference.textContent = `次回方針: ${state.preference}`;
      actualAnchor.textContent = state.lastSuccess
        ? `直近の実表示: ${state.lastSuccess.actualAnchor}${
            state.lastSuccess.fallbackReason ? ` (${state.lastSuccess.fallbackReason})` : ''
          }`
        : '直近の実表示: なし';
      stale.textContent = state.dialog.stale
        ? '新しいgenerationが到着しました。再開位置を選び直してください。'
        : '';
      positionGroup.hidden = state.dialog.step !== 'position';
      scopeGroup.hidden = state.dialog.step !== 'scope';
      for (const [value, button] of positionButtons) {
        button.setAttribute(
          'aria-checked',
          state.dialog.selectedPreference === value ? 'true' : 'false',
        );
      }
      if (
        !wasOpen ||
        previousDialogStep !== state.dialog.step ||
        !dialog.contains(document.activeElement)
      ) {
        (state.dialog.step === 'scope'
          ? scopeButtons.get('reload-once')
          : positionButtons.get('story')
        ).focus();
      }
    } else if (wasOpen) {
      statusButton.focus();
    }
    resolveLayout();
  }

  const unsubscribe = policy.subscribe(render);
  const unsubscribeDebug = debugExecution?.subscribe(renderDebug) ?? (() => {});
  render(lastPolicyState);
  if (lastDebugState) renderDebug(lastDebugState);

  statusButton.addEventListener('focus', () => {
    const interaction = layout.getState().interaction;
    layout.setInteraction({...interaction, focused: true});
  });
  statusButton.addEventListener('blur', () => {
    const interaction = layout.getState().interaction;
    layout.setInteraction({...interaction, focused: false});
    resolveLayout();
  });
  function onStatusPointerDown(event: any) {
    const pointerId = Number.isSafeInteger(event.pointerId) ? Number(event.pointerId) : null;
    activePointerId = pointerId;
    let pointerCaptured = false;
    if (pointerId !== null && typeof statusButton.setPointerCapture === 'function') {
      try {
        statusButton.setPointerCapture(pointerId);
        pointerCaptured = true;
      } catch (error) {
        reportError(error);
      }
    }
    layout.setInteraction({
      pressed: true,
      pointerCaptured,
      focused: document.activeElement === statusButton,
    });
  }
  function finishPointerInteraction(event: any) {
    const pointerId = Number.isSafeInteger(event?.pointerId) ? Number(event.pointerId) : null;
    if (activePointerId !== null && pointerId !== null && pointerId !== activePointerId) return;
    if (
      activePointerId !== null &&
      typeof statusButton.hasPointerCapture === 'function' &&
      statusButton.hasPointerCapture(activePointerId) &&
      typeof statusButton.releasePointerCapture === 'function'
    ) {
      try {
        statusButton.releasePointerCapture(activePointerId);
      } catch (error) {
        reportError(error);
      }
    }
    activePointerId = null;
    layout.setInteraction({
      pressed: false,
      pointerCaptured: false,
      focused: document.activeElement === statusButton,
    });
    resolveLayout();
  }
  statusButton.addEventListener('pointerdown', onStatusPointerDown);
  statusButton.addEventListener('pointerup', finishPointerInteraction);
  statusButton.addEventListener('pointercancel', finishPointerInteraction);
  document.addEventListener('pointerup', finishPointerInteraction, true);
  document.addEventListener('pointercancel', finishPointerInteraction, true);
  statusButton.addEventListener('click', () => {
    observe(policy.openDialog({inputId: 'status-button'}));
  });
  close.addEventListener('click', () => observe(policy.applyScope('cancel')));
  for (const [value, button] of positionButtons) {
    button.addEventListener('click', () => observe(policy.selectPosition(value)));
  }
  for (const [value, button] of scopeButtons) {
    button.addEventListener('click', () =>
      observe(policy.applyScope(value, {inputId: `scope-${value}`})),
    );
  }
  for (const [value, button] of anchorButtons) {
    button.addEventListener('click', () => setPreferredAnchor(value));
  }
  resetAnchor.addEventListener('click', () => setPreferredAnchor('top-right'));
  for (const [value, button] of debugModeButtons) {
    button.addEventListener('click', () => {
      try {
        debugExecution?.setMode(value);
      } catch (error) {
        reportError(error);
      }
    });
  }
  debugResume.addEventListener('click', () => {
    try {
      debugExecution?.resume();
    } catch (error) {
      reportError(error);
    }
  });

  function focusableDialogButtons() {
    const stage = lastPolicyState.dialog.step;
    return [
      close,
      ...(stage === 'position' ? [...positionButtons.values()] : [...scopeButtons.values()]),
      ...anchorButtons.values(),
      resetAnchor,
      ...(debugExecution ? [...debugModeButtons.values(), debugResume] : []),
    ].filter((button) => !button.disabled && !button.hidden);
  }

  function onKeyDown(event: any) {
    if (disposed || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey)
      return;
    if (!lastPolicyState.dialog.open) {
      if (!/^(?:Tab|Shift|Control|Alt|Meta)(?:Left|Right)?$/u.test(event.code)) {
        observe(policy.acknowledge({inputId: `key-${event.code}`}));
      }
      return;
    }
    if (event.code === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      observe(policy.applyScope('cancel'));
      return;
    }
    if (
      lastPolicyState.dialog.step === 'position' &&
      ['Digit1', 'Digit2', 'Digit3'].includes(event.code) &&
      !event.shiftKey
    ) {
      event.preventDefault();
      const value = positionShortcuts[event.code];
      observe(policy.selectPosition(value));
      return;
    }
    const activeAnchor = [...anchorButtons.entries()].find(
      ([, button]) => button === document.activeElement,
    );
    if (activeAnchor && Object.hasOwn(anchorNeighbors[activeAnchor[0]], event.code)) {
      event.preventDefault();
      const next = anchorNeighbors[activeAnchor[0]][event.code];
      anchorButtons.get(next).focus();
      return;
    }
    if (activeAnchor && ['Enter', 'Space'].includes(event.code)) {
      event.preventDefault();
      setPreferredAnchor(activeAnchor[0]);
      return;
    }
    if (event.code !== 'Tab') return;
    event.preventDefault();
    const focusable = focusableDialogButtons();
    const index = focusable.indexOf(document.activeElement);
    const next = event.shiftKey
      ? index <= 0
        ? focusable.length - 1
        : index - 1
      : index < 0 || index === focusable.length - 1
        ? 0
        : index + 1;
    focusable[next].focus();
  }
  document.addEventListener('keydown', onKeyDown, true);

  function onPreviewPointer(event: any) {
    if (disposed || lastPolicyState.dialog.open) return;
    const inputId = Number.isSafeInteger(event.pointerId)
      ? `pointer-${event.pointerId}`
      : 'pointer-primary';
    observe(policy.acknowledge({inputId}));
  }
  document.addEventListener('pointerdown', onPreviewPointer, true);

  return Object.freeze({
    element: host,
    statusButton,
    setPreferredAnchor,
    refreshLayout: resolveLayout,
    acknowledgePreviewInput(inputId: string) {
      return policy.acknowledge({inputId});
    },
    getSnapshot() {
      return deepFreeze({
        version: 1,
        surface: options.surface,
        preferredAnchor: selectedAnchor,
        policy: policy.getState(),
        layout: layout.getState(),
        debug: debugExecution?.getState() ?? null,
        disposed,
      });
    },
    async whenIdle() {
      await Promise.all([...pending]);
      await policy.whenIdle();
      return this.getSnapshot();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      unsubscribeDebug();
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPreviewPointer, true);
      document.removeEventListener('pointerup', finishPointerInteraction, true);
      document.removeEventListener('pointercancel', finishPointerInteraction, true);
      if (typeof host.remove === 'function') host.remove();
    },
  });
}
