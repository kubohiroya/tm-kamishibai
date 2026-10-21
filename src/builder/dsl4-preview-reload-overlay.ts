import type {Dsl4PreviewDocument, Dsl4PreviewElement} from '../dsl4/preview-dom.js';
import {dsl4PreviewReloadAnchors} from '../dsl4/preview-layout-coordinator.js';
import {previewReloadMessages} from './dsl4-preview-reload-messages.js';
import {deepFreeze} from '../dsl4/story-document.js';

const storageKey = 'dsl4.preview.reload.anchor.v1';
const anchorSet = new Set(dsl4PreviewReloadAnchors);
const surfaces = new Set(['web', 'cli']);
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
  return value as unknown as Dsl4PreviewDocument;
}

function requireElement(value: unknown) {
  if (!isRecord(value) || typeof value.appendChild !== 'function') {
    throw new TypeError('reload overlay mount must be a DOM element');
  }
  return value as unknown as Dsl4PreviewElement;
}

/**
 * The surfaces the overlay drives, named rather than indexed.
 *
 * Each one is validated at runtime just below, and the interface states exactly what the overlay
 * calls: an index signature would leave every member possibly undefined and say nothing about its
 * arguments.
 */
interface ReloadPolicySurface {
  getState(): unknown;
  subscribe(listener: (state: unknown) => unknown): () => void;
  openDialog(options?: Readonly<{inputId?: string}>): unknown;
  selectPosition(anchor: string): unknown;
  applyScope(scope: string, options?: Readonly<{inputId?: string}>): unknown;
  acknowledge(options?: Readonly<{inputId?: string}>): unknown;
  whenIdle(): Promise<unknown>;
}

interface ReloadLayoutSurface {
  resolve(anchor: string): unknown;
  setInteraction(interaction: Readonly<Record<string, unknown>>): unknown;
  getState(): ReloadLayoutState;
}

interface ReloadDebugExecutionSurface {
  getState(): unknown;
  subscribe(listener: (state: unknown) => unknown): () => void;
  setMode(mode: string): unknown;
  resume(): unknown;
}

interface ReloadPolicyState {
  readonly status: string;
  readonly preference: string;
  readonly dialog: Readonly<{
    open: boolean;
    step: string;
    targetRevision: number | null;
    stale?: boolean;
    selectedPreference?: string | null;
  }>;
  readonly diagnostic?: Readonly<{code: string; message: string}> | null;
  readonly lastSuccess?: Readonly<{
    acknowledgedAt?: number;
    actualAnchor?: string;
    fallbackReason?: string | null;
  }> | null;
}

interface ReloadLayoutResolution {
  readonly rect: Readonly<{x: number; y: number}>;
  readonly resolvedAnchor: string;
  readonly stacked: boolean;
  readonly collisionReason?: string | null;
}

export interface ReloadLayoutState {
  readonly interaction: Readonly<Record<string, unknown>>;
}

interface ReloadDebugState {
  readonly status: string;
  readonly mode: string;
  readonly paused?: boolean;
  readonly reason?: string;
  readonly sceneId?: string;
  readonly actionIndex?: number;
  readonly command?: string;
}

interface PreviewPointerEvent {
  readonly pointerId?: unknown;
}

interface PreviewKeyboardEvent {
  readonly defaultPrevented?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly code: string;
  preventDefault(): void;
  stopPropagation(): void;
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
  return value as unknown as ReloadPolicySurface;
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
  return value as unknown as ReloadLayoutSurface;
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
  return value as unknown as ReloadDebugExecutionSurface;
}

function validateLayoutResolution(value: unknown): ReloadLayoutResolution {
  if (!isRecord(value) || !isRecord(value.rect)) {
    throw new TypeError('reload overlay layout resolution is invalid');
  }
  const {rect} = value;
  if (
    typeof rect.x !== 'number' ||
    typeof rect.y !== 'number' ||
    typeof value.resolvedAnchor !== 'string' ||
    typeof value.stacked !== 'boolean' ||
    (value.collisionReason !== undefined &&
      value.collisionReason !== null &&
      typeof value.collisionReason !== 'string')
  ) {
    throw new TypeError('reload overlay layout resolution is invalid');
  }
  return {
    rect: {x: rect.x, y: rect.y},
    resolvedAnchor: value.resolvedAnchor,
    stacked: value.stacked,
    ...(value.collisionReason === undefined ? {} : {collisionReason: value.collisionReason}),
  };
}

function validatePolicyDiagnostic(value: unknown): ReloadPolicyState['diagnostic'] {
  if (value === undefined || value === null) return value;
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string') {
    throw new TypeError('reload policy diagnostic state is invalid');
  }
  return {code: value.code, message: value.message};
}

function validatePolicyLastSuccess(value: unknown): ReloadPolicyState['lastSuccess'] {
  if (value === undefined || value === null) return value;
  if (
    !isRecord(value) ||
    (value.acknowledgedAt !== undefined && typeof value.acknowledgedAt !== 'number') ||
    (value.actualAnchor !== undefined && typeof value.actualAnchor !== 'string') ||
    (value.fallbackReason !== undefined &&
      value.fallbackReason !== null &&
      typeof value.fallbackReason !== 'string')
  ) {
    throw new TypeError('reload policy success state is invalid');
  }
  return {
    ...(typeof value.acknowledgedAt === 'number' ? {acknowledgedAt: value.acknowledgedAt} : {}),
    ...(typeof value.actualAnchor === 'string' ? {actualAnchor: value.actualAnchor} : {}),
    ...(typeof value.fallbackReason === 'string' ? {fallbackReason: value.fallbackReason} : {}),
  };
}

function validatePolicyState(value: unknown): ReloadPolicyState {
  if (!isRecord(value) || !isRecord(value.dialog)) {
    throw new TypeError('reload policy state is invalid');
  }
  if (
    typeof value.status !== 'string' ||
    typeof value.preference !== 'string' ||
    typeof value.dialog.open !== 'boolean' ||
    typeof value.dialog.step !== 'string'
  ) {
    throw new TypeError('reload policy state is invalid');
  }
  const diagnostic = validatePolicyDiagnostic(value.diagnostic);
  const lastSuccess = validatePolicyLastSuccess(value.lastSuccess);
  return {
    status: value.status,
    preference: value.preference,
    dialog: {
      open: value.dialog.open,
      step: value.dialog.step,
      targetRevision:
        typeof value.dialog.targetRevision === 'number' ? value.dialog.targetRevision : null,
      ...(typeof value.dialog.stale === 'boolean' ? {stale: value.dialog.stale} : {}),
      ...(typeof value.dialog.selectedPreference === 'string' ||
      value.dialog.selectedPreference === null
        ? {selectedPreference: value.dialog.selectedPreference}
        : {}),
    },
    ...(diagnostic === undefined ? {} : {diagnostic}),
    ...(lastSuccess === undefined ? {} : {lastSuccess}),
  };
}

function validateDebugState(value: unknown): ReloadDebugState {
  if (!isRecord(value) || typeof value.status !== 'string' || typeof value.mode !== 'string') {
    throw new TypeError('reload debug state is invalid');
  }
  return {
    status: value.status,
    mode: value.mode,
    ...(typeof value.paused === 'boolean' ? {paused: value.paused} : {}),
    ...(typeof value.reason === 'string' ? {reason: value.reason} : {}),
    ...(typeof value.sceneId === 'string' ? {sceneId: value.sceneId} : {}),
    ...(typeof value.actionIndex === 'number' ? {actionIndex: value.actionIndex} : {}),
    ...(typeof value.command === 'string' ? {command: value.command} : {}),
  };
}

function element(document: Dsl4PreviewDocument, tag: string, text?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function preferredAnchor(value: unknown) {
  return typeof value === 'string' && anchorSet.has(value) ? value : 'top-right';
}

export interface Dsl4PreviewStageControls {
  addButton(options: {id: string; label: string; text?: string; icon?: string; onClick(): void}): {
    update(state: {label?: string; text?: string; visible?: boolean; expanded?: boolean}): void;
    focus(): void;
    dispose(): void;
    placePanel?(element: unknown): void;
  };
}

/** Create one shared Web/CLI browser reload overlay around a transport-neutral policy. */
export function createDsl4PreviewReloadOverlay(options: {
  surface: 'web' | 'cli';
  locale?: 'ja' | 'en';
  stageControls?: Dsl4PreviewStageControls;
  document: unknown;
  mount: unknown;
  policy: ReloadPolicySurface;
  layoutCoordinator: ReloadLayoutSurface;
  debugExecution?: ReloadDebugExecutionSurface | undefined;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | undefined;
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
  const rootLanguage =
    isRecord(options.document) && isRecord(options.document.documentElement)
      ? options.document.documentElement.lang
      : undefined;
  const locale = /^ja(?:-|$)/iu.test(
    String(
      options.locale ??
        (typeof rootLanguage === 'string' && rootLanguage.trim()
          ? rootLanguage
          : globalThis.navigator?.language) ??
        'en',
    ),
  )
    ? 'ja'
    : 'en';
  const text = previewReloadMessages(locale);
  const positionLabel = (value: string) =>
    text.positions[value as keyof typeof text.positions] ?? value;
  const anchorLabel = (value: string) => text.anchors[value as keyof typeof text.anchors] ?? value;
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
      new Intl.DateTimeFormat(locale, {dateStyle: 'short', timeStyle: 'medium'}).format(value));
  const storage = options.storage;

  function reportError(error: unknown) {
    try {
      options.onError?.(error);
    } catch {
      // Error observers cannot change overlay state.
    }
  }

  let selectedAnchor: string = 'top-right';
  try {
    selectedAnchor = preferredAnchor(storage?.getItem(storageKey));
  } catch (error) {
    reportError(error);
  }

  const host = element(document, 'section');
  host.id = 'dsl4-preview-reload-overlay';
  host.setAttribute('data-dsl4-development-only', 'true');
  host.setAttribute('data-preview-surface', options.surface);
  host.setAttribute('lang', locale);
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

  for (const live of [polite, assertive]) {
    Object.assign(live.style, {
      position: 'absolute',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      clipPath: 'inset(50%)',
    });
  }

  const dialog = element(document, 'div');
  dialog.id = 'dsl4-preview-reload-status-dialog';
  dialog.hidden = true;
  dialog.setAttribute('data-layout', 'editor');
  dialog.style.zIndex = '30';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'dsl4-preview-reload-dialog-title');
  const title = element(document, 'h2', text.title);
  title.id = 'dsl4-preview-reload-dialog-title';
  title.tabIndex = -1;
  const close = element(document, 'button', '×');
  close.id = 'dsl4-preview-reload-dialog-close';
  close.type = 'button';
  close.setAttribute('aria-label', text.closeLabel);
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
  positionGroup.setAttribute('aria-label', text.restartTitle);
  const positionButtons = new Map<string, Dsl4PreviewElement>();
  for (const [value, label] of Object.entries(text.positions)) {
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
  const scopeButtons = new Map<string, Dsl4PreviewElement>();
  for (const [value, label] of Object.entries(text.scopes)) {
    const button = element(document, 'button', label);
    button.id = `dsl4-preview-reload-scope-${value}`;
    button.type = 'button';
    button.setAttribute('data-reload-scope', value);
    scopeButtons.set(value, button);
    scopeGroup.appendChild(button);
  }

  const anchorTitle = element(document, 'h3', text.anchorTitle);
  const anchorGroup = element(document, 'div');
  anchorGroup.id = 'dsl4-preview-reload-anchor-selector';
  anchorGroup.setAttribute('role', 'radiogroup');
  anchorGroup.setAttribute('aria-label', text.anchorTitle);
  const anchorButtons = new Map<string, Dsl4PreviewElement>();
  for (const value of dsl4PreviewReloadAnchors) {
    const button = element(document, 'button', anchorLabel(value));
    button.id = `dsl4-preview-reload-anchor-${value}`;
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('data-reload-anchor', value);
    anchorButtons.set(value, button);
    anchorGroup.appendChild(button);
  }
  const anchorSummary = element(document, 'p');
  anchorSummary.id = 'dsl4-preview-reload-anchor-summary';
  const resetAnchor = element(document, 'button', text.resetAnchor);
  resetAnchor.id = 'dsl4-preview-reload-anchor-reset';
  resetAnchor.type = 'button';

  const debugTitle = element(document, 'h3', text.debugTitle);
  const debugModeGroup = element(document, 'div');
  debugModeGroup.id = 'dsl4-preview-debug-mode-selector';
  debugModeGroup.setAttribute('role', 'radiogroup');
  debugModeGroup.setAttribute('aria-label', text.debugTitle);
  const debugModeButtons = new Map<string, Dsl4PreviewElement>();
  for (const [value, label] of Object.entries(text.debugModes)) {
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
  const debugResume = element(document, 'button', text.resume);
  debugResume.id = 'dsl4-preview-debug-resume';
  debugResume.type = 'button';
  debugResume.hidden = true;

  const header = element(document, 'div');
  header.id = 'dsl4-preview-reload-dialog-header';
  header.append(title, close);
  const body = element(document, 'div');
  body.id = 'dsl4-preview-reload-dialog-body';
  const help = element(document, 'p', text.help);
  help.id = 'dsl4-preview-reload-help';
  const waiting = element(document, 'p', text.waiting);
  waiting.id = 'dsl4-preview-reload-waiting';
  const restartTitle = element(document, 'h3', text.restartTitle);
  body.append(
    help,
    waiting,
    latest,
    currentPreference,
    actualAnchor,
    stale,
    restartTitle,
    positionGroup,
    scopeGroup,
    anchorTitle,
    anchorGroup,
    anchorSummary,
    resetAnchor,
    ...(debugExecution ? [debugTitle, debugModeGroup, debugSummary, debugResume] : []),
  );
  const footer = element(document, 'div');
  footer.id = 'dsl4-preview-reload-dialog-footer';
  const immediate = element(document, 'p', text.immediate);
  const done = element(document, 'button', text.close);
  done.id = 'dsl4-preview-reload-dialog-done';
  done.type = 'button';
  done.addEventListener('click', () => observe(policy.applyScope('cancel')));
  footer.append(immediate, done);
  dialog.append(header, body, footer);
  host.append(statusButton, polite, assertive, dialog);
  mount.appendChild(host);

  let disposed = false;
  let lastStatus = '';
  let lastDiagnosticCode: string | null = null;
  let pending: Promise<unknown>[] = [];
  let lastPolicyState = validatePolicyState(policy.getState());
  let lastDebugState = debugExecution ? validateDebugState(debugExecution.getState()) : null;
  let activePointerId: number | null = null;
  const toolbar = options.stageControls?.addButton({
    id: 'kamishibai-preview-reload',
    label: text.title,
    icon: '↻',
    onClick: () => {
      observe(policy.openDialog({inputId: 'stage-control'}));
    },
  });
  if (toolbar) {
    statusButton.style.display = 'none';
    anchorTitle.hidden = true;
    anchorGroup.hidden = true;
    resetAnchor.hidden = true;
    immediate.textContent = text.immediateToolbar;
  }
  function focusStatusControl() {
    if (toolbar) toolbar.focus();
    else statusButton.focus();
  }

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
    const resolved = validateLayoutResolution(layout.resolve(selectedAnchor));
    statusButton.style.left = `${resolved.rect.x}px`;
    statusButton.style.top = `${resolved.rect.y}px`;
    statusButton.setAttribute('data-preferred-anchor', selectedAnchor);
    statusButton.setAttribute('data-resolved-anchor', resolved.resolvedAnchor);
    statusButton.setAttribute('data-layout-stacked', resolved.stacked ? 'true' : 'false');
    anchorSummary.textContent = toolbar
      ? text.toolbarPosition
      : text.anchorSummary(anchorLabel(selectedAnchor), anchorLabel(resolved.resolvedAnchor));
    for (const [value, button] of anchorButtons) {
      button.setAttribute('aria-checked', value === selectedAnchor ? 'true' : 'false');
    }
    if (!dialog.hidden) toolbar?.placePanel?.(dialog);
    return resolved;
  }

  function setPreferredAnchor(value: string) {
    selectedAnchor = preferredAnchor(value);
    try {
      storage?.setItem(storageKey, selectedAnchor);
    } catch (error) {
      reportError(error);
    }
    return resolveLayout();
  }

  function renderStatusPresentation() {
    const debugState = lastDebugState;
    const debugPaused = debugState?.paused === true;
    const presentation = debugPaused
      ? {
          icon: 'Ⅱ',
          badge: text.debugBadge,
          label: text.debugPaused(debugState?.sceneId ?? '', Number(debugState?.actionIndex) + 1),
        }
      : (() => {
          const [icon = '', badge = '', label = ''] =
            text.states[lastPolicyState.status as keyof typeof text.states] ?? text.states.idle;
          return {icon, badge, label};
        })();
    const statusKey = debugPaused ? 'debug-paused' : lastPolicyState.status;
    statusButton.setAttribute('data-reload-state', lastPolicyState.status);
    statusButton.setAttribute(
      'data-debug-state',
      lastDebugState?.status ?? (debugExecution ? 'running' : 'disabled'),
    );
    statusButton.setAttribute('aria-label', presentation.label);
    toolbar?.update({
      label: `${text.title} — ${presentation.label}`,
      text: presentation.badge,
      visible: !host.hidden,
      expanded: lastPolicyState.dialog.open,
    });
    icon.textContent = presentation.icon;
    badge.textContent = presentation.badge;
    if (lastStatus !== statusKey) {
      polite.textContent =
        locale === 'ja' ? presentation.label : `Reload status: ${presentation.badge}`;
      lastStatus = statusKey;
    }
  }

  function renderDebug(state: ReloadDebugState) {
    if (disposed || !debugExecution) return;
    lastDebugState = state;
    host.setAttribute('data-debug-state', state.status);
    for (const [value, button] of debugModeButtons) {
      button.setAttribute('aria-checked', value === state.mode ? 'true' : 'false');
    }
    if (state.paused) {
      debugSummary.textContent = text.debugPaused(
        state.sceneId ?? '',
        Number(state.actionIndex) + 1,
      );
      debugResume.hidden = false;
      debugResume.disabled = false;
    } else {
      debugSummary.textContent = state.mode === 'step' ? text.debugStep : text.debugBreakpoints;
      debugResume.hidden = true;
      debugResume.disabled = true;
    }
    renderStatusPresentation();
  }

  function render(state: ReloadPolicyState) {
    if (disposed) return;
    const previousDialogStep = lastPolicyState.dialog.step;
    lastPolicyState = state;
    renderStatusPresentation();
    const diagnostic = state.diagnostic ?? null;
    const diagnosticCode = diagnostic?.code ?? null;
    if (diagnostic && diagnosticCode && diagnosticCode !== lastDiagnosticCode) {
      assertive.textContent = `${diagnosticCode}: ${diagnostic.message}`;
    } else if (!diagnosticCode) {
      assertive.textContent = '';
    }
    lastDiagnosticCode = diagnosticCode;

    const wasOpen = !dialog.hidden;
    dialog.hidden = !state.dialog.open;
    host.setAttribute('data-dialog-open', String(state.dialog.open));
    waiting.hidden = state.status !== 'idle';
    for (const name of ['reload-once', 'reload-and-save']) {
      const button = scopeButtons.get(name);
      if (button) button.disabled = state.dialog.targetRevision === null;
    }
    if (state.dialog.open && !host.hidden) {
      latest.textContent =
        state.lastSuccess && typeof state.lastSuccess.acknowledgedAt === 'number'
          ? text.latest(formatTime(state.lastSuccess.acknowledgedAt))
          : text.latestEmpty;
      currentPreference.textContent = text.preference(positionLabel(state.preference));
      actualAnchor.textContent =
        state.lastSuccess && typeof state.lastSuccess.actualAnchor === 'string'
          ? text.previous(positionLabel(state.lastSuccess.actualAnchor)) +
            (state.lastSuccess.fallbackReason ? `（${text.fallback}）` : '')
          : text.previousEmpty;
      stale.textContent = state.dialog.stale ? text.stale : '';
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
          ? [...scopeButtons.values()].find((button) => !button.disabled)
          : positionButtons.get('story')
        )?.focus();
      }
      if (!wasOpen) body.scrollTop = 0;
    } else if (wasOpen && !host.hidden) {
      focusStatusControl();
    }
    resolveLayout();
  }

  const unsubscribe = policy.subscribe((state) => render(validatePolicyState(state)));
  const unsubscribeDebug =
    debugExecution?.subscribe((state) => renderDebug(validateDebugState(state))) ?? (() => {});
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
  function onStatusPointerDown(event: PreviewPointerEvent) {
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
  function finishPointerInteraction(event: PreviewPointerEvent) {
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
      ...(toolbar ? [] : [...anchorButtons.values(), resetAnchor]),
      ...(debugExecution ? [...debugModeButtons.values(), debugResume] : []),
      done,
    ].filter((button) => !button.disabled && !button.hidden);
  }

  function onKeyDown(event: PreviewKeyboardEvent) {
    if (
      disposed ||
      host.hidden ||
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
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
      // The code was matched against the shortcut list just above.
      const value = positionShortcuts[event.code] ?? 'top-right';
      observe(policy.selectPosition(value));
      return;
    }
    const activeAnchor = [...anchorButtons.entries()].find(
      ([, button]) => button === document.activeElement,
    );
    const activeNeighbors = activeAnchor ? anchorNeighbors[activeAnchor[0]] : undefined;
    if (activeNeighbors && Object.hasOwn(activeNeighbors, event.code)) {
      event.preventDefault();
      const next = activeNeighbors[event.code];
      const nextButton = next === undefined ? undefined : anchorButtons.get(next);
      nextButton?.focus();
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
    const activeElement = document.activeElement ?? null;
    const index = focusable.findIndex((button) => button === activeElement);
    const next = event.shiftKey
      ? index <= 0
        ? focusable.length - 1
        : index - 1
      : index < 0 || index === focusable.length - 1
        ? 0
        : index + 1;
    focusable[next]?.focus();
  }
  document.addEventListener('keydown', onKeyDown, true);

  function onPreviewPointer(event: PreviewPointerEvent) {
    if (disposed || host.hidden || lastPolicyState.dialog.open) return;
    const inputId = Number.isSafeInteger(event.pointerId)
      ? `pointer-${event.pointerId}`
      : 'pointer-primary';
    observe(policy.acknowledge({inputId}));
  }
  document.addEventListener('pointerdown', onPreviewPointer, true);

  return Object.freeze({
    element: host,
    statusButton,
    setVisible(visible: boolean) {
      if (disposed) return;
      host.hidden = !visible;
      toolbar?.update({visible});
      if (!visible) {
        host.setAttribute('data-dialog-open', 'false');
        dialog.hidden = true;
        if (lastPolicyState.dialog.open) observe(policy.applyScope('cancel'));
      }
    },
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
        placement: toolbar ? 'stage-controls' : 'overlay',
        visible: !host.hidden,
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
      toolbar?.dispose();
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPreviewPointer, true);
      document.removeEventListener('pointerup', finishPointerInteraction, true);
      document.removeEventListener('pointercancel', finishPointerInteraction, true);
      if (typeof host.remove === 'function') host.remove();
    },
  });
}
