import {deepFreeze} from '../dsl4/story-document.js';
import {resolveDsl4FeatureFlags} from '../dsl4/feature-flags.js';
import {hasDsl4SourceFilenameSuffix} from '../dsl4/source-filename.js';
import {createDsl4PreviewReloadSurface} from './dsl4-preview-reload-surface.js';

const optionKeys = new Set([
  'document',
  'environment',
  'mount',
  'nonBlockingCandidates',
  'onDefer',
  'onError',
  'onInitialValid',
  'onReloadChoice',
]);
const requiredOptionKeys = new Set(['document', 'environment', 'mount']);
const viewKeys = new Set([
  'anchor',
  'candidateIntegrity',
  'changeCategories',
  'choices',
  'counts',
  'currentIntegrity',
  'formatVersion',
  'phase',
  'safeStatusMessage',
  'sourceDisplayName',
  'validationStatus',
  'warningCount',
]);
const countKeys = new Set(['actions', 'assets', 'scenes']);
const anchorKeys = new Set(['actionId', 'sceneId']);
const choiceKeys = new Set(['enabled', 'reason']);
const phases = new Set(['candidate', 'finished', 'invalid', 'ready', 'running', 'watching']);
const validationStatuses = new Set(['invalid', 'missing', 'valid']);
const allowedChangeCategories = Object.freeze([
  'source',
  'scenes',
  'actions',
  'assets',
  'controls',
  'metadata',
]);
const sha256SRI = /^sha256-[A-Za-z0-9+/]{43}=$/u;

export const dsl4DevelopmentPreviewShellManifest = deepFreeze({
  formatVersion: 1,
  production: false,
  extensionId: null,
  module: 'src/builder/dsl4-preview-shell.js',
  forbiddenProductionExtensionIds: ['kubohiroyakamishibai4preview'],
  forbiddenProductionOpcodePrefixes: ['kubohiroyakamishibai4preview_'],
  forbiddenProductionPersistedFields: [
    'previewBridge',
    'previewToken',
    'reloadCandidate',
    'reloadModalState',
    'browserPreviewHandle',
    'browserPreviewTimer',
    'browserPreviewObserver',
    'browserPreviewPendingRead',
    'browserPreviewCandidate',
    'browserPreviewModalState',
    'previewReloadOverlay',
    'reloadPreference',
    'reloadTimestamp',
    'reloadDialogState',
    'reloadLayoutState',
    'reloadCandidateRevision',
  ],
});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {Set<string>} keys @param {string} name */
function exactRecord(value, keys, name) {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.has(key));
  const missing = [...keys].filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new TypeError(
      `${name} keys are invalid (unknown: ${unknown.sort().join(', ') || 'none'}; missing: ${missing.sort().join(', ') || 'none'})`,
    );
  }
  return value;
}

/** @param {unknown} value */
function previewShellOptions(value) {
  if (!isRecord(value)) throw new TypeError('preview shell options must be an object');
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !optionKeys.has(key));
  const missing = [...requiredOptionKeys].filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new TypeError(
      `preview shell option keys are invalid (unknown: ${unknown.sort().join(', ') || 'none'}; missing: ${missing.sort().join(', ') || 'none'})`,
    );
  }
  return value;
}

/** @param {unknown} value @param {string} name @param {number} maximum */
function safeInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new TypeError(`${name} must be a safe integer between 0 and ${maximum}`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} name @param {number} maximum */
function safeText(value, name, maximum) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${name} must be bounded non-empty text without unsafe controls`);
  }
  return value;
}

/** @param {unknown} value @param {string} name */
function nullableIntegrity(value, name) {
  if (value === null) return null;
  if (typeof value !== 'string' || !sha256SRI.test(value)) {
    throw new TypeError(`${name} must be null or a canonical SHA-256 SRI value`);
  }
  return value;
}

/** @param {unknown} value */
function displayName(value) {
  const name = safeText(value, 'sourceDisplayName', 200);
  if (name.includes('/') || name.includes('\\') || !hasDsl4SourceFilenameSuffix(name)) {
    throw new TypeError('sourceDisplayName must be one DSL 4 source basename');
  }
  return name;
}

/** @param {unknown} value */
function normalizeCounts(value) {
  if (value === null) return null;
  const counts = exactRecord(value, countKeys, 'counts');
  return deepFreeze({
    scenes: safeInteger(counts.scenes, 'counts.scenes', 100_000),
    actions: safeInteger(counts.actions, 'counts.actions', 1_000_000),
    assets: safeInteger(counts.assets, 'counts.assets', 100_000),
  });
}

/** @param {unknown} value */
function normalizeAnchor(value) {
  if (value === null) return null;
  const anchor = exactRecord(value, anchorKeys, 'anchor');
  return deepFreeze({
    sceneId: safeText(anchor.sceneId, 'anchor.sceneId', 200),
    actionId: anchor.actionId === null ? null : safeText(anchor.actionId, 'anchor.actionId', 500),
  });
}

/** @param {unknown} value @param {string} number */
function normalizeChoice(value, number) {
  const choice = exactRecord(value, choiceKeys, `choices.${number}`);
  if (typeof choice.enabled !== 'boolean') {
    throw new TypeError(`choices.${number}.enabled must be boolean`);
  }
  if (choice.enabled && choice.reason !== null) {
    throw new TypeError(`choices.${number}.reason must be null when enabled`);
  }
  if (!choice.enabled && choice.reason === null) {
    throw new TypeError(`choices.${number}.reason is required when disabled`);
  }
  return deepFreeze({
    enabled: choice.enabled,
    reason:
      choice.reason === null ? null : safeText(choice.reason, `choices.${number}.reason`, 500),
  });
}

/** @param {unknown} value @param {string} phase */
function normalizeChoices(value, phase) {
  if (phase !== 'candidate') {
    if (value !== null) throw new TypeError('choices must be null outside the candidate phase');
    return null;
  }
  const choices = exactRecord(value, new Set(['1', '2', '3']), 'choices');
  return deepFreeze({
    1: normalizeChoice(choices[1], '1'),
    2: normalizeChoice(choices[2], '2'),
    3: normalizeChoice(choices[3], '3'),
  });
}

/** @param {unknown} value */
function normalizeCategories(value) {
  if (!Array.isArray(value)) throw new TypeError('changeCategories must be an array');
  if (value.length > allowedChangeCategories.length) {
    throw new TypeError('changeCategories contains too many entries');
  }
  const categories = value.map((category) => {
    if (typeof category !== 'string' || !allowedChangeCategories.includes(category)) {
      throw new TypeError('changeCategories contains an unsupported category');
    }
    return category;
  });
  if (new Set(categories).size !== categories.length) {
    throw new TypeError('changeCategories must not contain duplicates');
  }
  return deepFreeze(allowedChangeCategories.filter((category) => categories.includes(category)));
}

/** @param {unknown} input */
export function validateDsl4PreviewShellView(input) {
  const view = exactRecord(input, viewKeys, 'preview shell view');
  if (view.formatVersion !== 1) throw new TypeError('preview shell view formatVersion must be 1');
  if (typeof view.phase !== 'string' || !phases.has(view.phase)) {
    throw new TypeError('preview shell phase is unsupported');
  }
  if (typeof view.validationStatus !== 'string' || !validationStatuses.has(view.validationStatus)) {
    throw new TypeError('preview shell validationStatus is unsupported');
  }
  const currentIntegrity = nullableIntegrity(view.currentIntegrity, 'currentIntegrity');
  const candidateIntegrity = nullableIntegrity(view.candidateIntegrity, 'candidateIntegrity');
  if (view.phase === 'candidate' && (!currentIntegrity || !candidateIntegrity)) {
    throw new TypeError('candidate phase requires current and candidate integrity');
  }
  if (view.phase === 'ready' && !candidateIntegrity) {
    throw new TypeError('ready phase requires candidate integrity');
  }
  if ((view.phase === 'running' || view.phase === 'finished') && !currentIntegrity) {
    throw new TypeError(`${view.phase} phase requires current integrity`);
  }
  if ((view.phase === 'candidate' || view.phase === 'ready') && view.validationStatus !== 'valid') {
    throw new TypeError(`${view.phase} phase requires valid source status`);
  }
  const counts = normalizeCounts(view.counts);
  if (view.validationStatus === 'valid' && counts === null) {
    throw new TypeError('valid source status requires counts');
  }
  return deepFreeze({
    formatVersion: 1,
    phase: view.phase,
    sourceDisplayName: displayName(view.sourceDisplayName),
    currentIntegrity,
    candidateIntegrity,
    validationStatus: view.validationStatus,
    counts,
    anchor: normalizeAnchor(view.anchor),
    choices: normalizeChoices(view.choices, view.phase),
    warningCount: safeInteger(view.warningCount, 'warningCount', 10_000),
    changeCategories: normalizeCategories(view.changeCategories),
    safeStatusMessage: safeText(view.safeStatusMessage, 'safeStatusMessage', 500),
  });
}

/** @param {string | null} value */
function abbreviatedIntegrity(value) {
  return value === null ? 'none' : `${value.slice(0, 19)}…`;
}

/** @param {unknown} callback @param {string} name @returns {Function | undefined} */
function optionalCallback(callback, name) {
  if (callback !== undefined && typeof callback !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
  return callback;
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
  if (
    !isRecord(value) ||
    typeof value.createElement !== 'function' ||
    typeof value.addEventListener !== 'function' ||
    typeof value.removeEventListener !== 'function'
  ) {
    throw new TypeError('document must provide the DOM document contract');
  }
  return /** @type {any} */ (value);
}

/** @param {Record<string, any>} document @param {string} tag @param {string} [text] */
function element(document, tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Create the development-only, host-owned preview status and reload-choice shell.
 *
 * @param {unknown} input
 */
export function createDsl4DevelopmentPreviewShell(input) {
  const options = previewShellOptions(input);
  if (options.environment !== 'development') {
    throw new TypeError('preview shell is available only in the development environment');
  }
  const document = requireDocument(options.document);
  const mount = requireElement(options.mount, 'mount');
  const onInitialValid = optionalCallback(options.onInitialValid, 'onInitialValid');
  const onReloadChoice = optionalCallback(options.onReloadChoice, 'onReloadChoice');
  const onDefer = optionalCallback(options.onDefer, 'onDefer');
  const onError = optionalCallback(options.onError, 'onError');
  if (
    options.nonBlockingCandidates !== undefined &&
    typeof options.nonBlockingCandidates !== 'boolean'
  ) {
    throw new TypeError('nonBlockingCandidates must be boolean');
  }
  const nonBlockingCandidates = options.nonBlockingCandidates === true;

  const host = element(document, 'section');
  host.id = 'dsl4-development-preview-shell';
  host.setAttribute('data-dsl4-development-only', 'true');
  host.setAttribute('aria-labelledby', 'dsl4-preview-title');
  const title = element(document, 'h1', 'DSL 4.0 development preview');
  title.id = 'dsl4-preview-title';
  const status = element(document, 'p');
  status.id = 'dsl4-preview-status';
  const summary = element(document, 'dl');
  summary.id = 'dsl4-preview-summary';
  /** @type {Map<string, any>} */
  const summaryValues = new Map();
  for (const [key, label] of [
    ['source', 'Source'],
    ['currentIntegrity', 'Current integrity'],
    ['candidateIntegrity', 'Candidate integrity'],
    ['validation', 'Validation'],
    ['scenes', 'Scenes'],
    ['actions', 'Actions'],
    ['assets', 'Assets'],
    ['anchor', 'Current anchor'],
    ['warnings', 'Warnings'],
    ['changes', 'Change categories'],
  ]) {
    const term = element(document, 'dt', label);
    const description = element(document, 'dd');
    description.setAttribute('data-summary-value', key);
    summaryValues.set(key, description);
    summary.appendChild(term);
    summary.appendChild(description);
  }
  const polite = element(document, 'p');
  polite.id = 'dsl4-preview-live-status';
  polite.setAttribute('role', 'status');
  polite.setAttribute('aria-live', 'polite');
  polite.setAttribute('aria-atomic', 'true');
  const assertive = element(document, 'p');
  assertive.id = 'dsl4-preview-live-error';
  assertive.setAttribute('role', 'alert');
  assertive.setAttribute('aria-live', 'assertive');
  assertive.setAttribute('aria-atomic', 'true');

  const dialog = element(document, 'div');
  dialog.id = 'dsl4-preview-reload-dialog';
  dialog.hidden = true;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'dsl4-preview-reload-title');
  dialog.setAttribute('aria-describedby', 'dsl4-preview-reload-description');
  const dialogTitle = element(document, 'h2', 'Choose where to restart');
  dialogTitle.id = 'dsl4-preview-reload-title';
  dialogTitle.tabIndex = -1;
  const dialogDescription = element(
    document,
    'p',
    'Choose one option. Escape defers this candidate and continues the current run.',
  );
  dialogDescription.id = 'dsl4-preview-reload-description';
  dialog.appendChild(dialogTitle);
  dialog.appendChild(dialogDescription);
  /** @type {Map<string, any>} */
  const buttons = new Map();
  /** @type {Map<string, any>} */
  const reasons = new Map();
  for (const [number, label] of [
    ['1', '1. Restart from the beginning'],
    ['2', '2. Restart from the current scene'],
    ['3', '3. Restart from the current action'],
  ]) {
    const button = element(document, 'button', label);
    button.id = `dsl4-preview-reload-${number}`;
    button.type = 'button';
    const reason = element(document, 'p');
    reason.id = `dsl4-preview-reload-${number}-reason`;
    button.setAttribute('aria-describedby', reason.id);
    buttons.set(number, button);
    reasons.set(number, reason);
    dialog.appendChild(button);
    dialog.appendChild(reason);
  }
  host.appendChild(title);
  host.appendChild(status);
  host.appendChild(summary);
  host.appendChild(polite);
  host.appendChild(assertive);
  host.appendChild(dialog);
  mount.appendChild(host);

  let disposed = false;
  let modalOpen = false;
  let initialValidPublished = false;
  /** @type {any} */
  let previousFocus = null;
  /** @type {Readonly<Record<string, any>> | null} */
  let currentView = null;

  /** @param {unknown} error */
  function reportError(error) {
    if (!onError) return;
    try {
      const observed = onError(error);
      Promise.resolve(observed).catch(() => {});
    } catch {
      // Error observers cannot change preview shell behavior.
    }
  }

  /** @param {Function | undefined} callback @param {...any} arguments_ */
  function invoke(callback, ...arguments_) {
    if (!callback) return;
    try {
      Promise.resolve(callback(...arguments_)).catch(reportError);
    } catch (error) {
      reportError(error);
    }
  }

  function enabledButtons() {
    return [...buttons.values()].filter((button) => !button.disabled);
  }

  function restoreFocus() {
    const target = previousFocus;
    previousFocus = null;
    if (target && typeof target.focus === 'function') target.focus();
  }

  function closeModal() {
    if (!modalOpen) return;
    modalOpen = false;
    dialog.hidden = true;
    restoreFocus();
  }

  /** @param {string} number */
  function commitChoice(number) {
    if (!modalOpen || !currentView?.choices) return;
    const choice = currentView.choices[number];
    if (!choice.enabled) {
      polite.textContent = `Reload option ${number} is unavailable: ${choice.reason}`;
      return;
    }
    const selectedView = currentView;
    closeModal();
    invoke(onReloadChoice, Number(number), selectedView);
  }

  function deferCandidate() {
    if (!modalOpen || !currentView) return;
    const deferredView = currentView;
    closeModal();
    invoke(onDefer, deferredView);
  }

  for (const [number, button] of buttons) {
    button.addEventListener('click', () => commitChoice(number));
  }

  /** @param {any} event */
  function onKeyDown(event) {
    if (!modalOpen || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    if (event.code === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      deferCandidate();
      return;
    }
    if (event.code === 'Digit1' || event.code === 'Digit2' || event.code === 'Digit3') {
      if (event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      commitChoice(event.code.slice(-1));
      return;
    }
    if (event.code === 'Enter' || event.code === 'Space') {
      const entry = [...buttons.entries()].find(([, button]) => button === document.activeElement);
      if (!entry) return;
      event.preventDefault();
      event.stopPropagation();
      commitChoice(entry[0]);
      return;
    }
    if (event.code !== 'Tab') return;
    const focusable = enabledButtons();
    event.preventDefault();
    if (focusable.length === 0) {
      dialogTitle.focus();
      return;
    }
    const active = document.activeElement;
    const currentIndex = focusable.indexOf(active);
    const nextIndex = event.shiftKey
      ? currentIndex <= 0
        ? focusable.length - 1
        : currentIndex - 1
      : currentIndex < 0 || currentIndex === focusable.length - 1
        ? 0
        : currentIndex + 1;
    focusable[nextIndex].focus();
  }
  document.addEventListener('keydown', onKeyDown, true);

  /** @param {string} key @param {string} value */
  function setSummary(key, value) {
    summaryValues.get(key).textContent = value;
  }

  /** @param {Readonly<Record<string, any>>} view */
  function render(view) {
    status.setAttribute('data-validation-status', view.validationStatus);
    status.textContent = `${view.validationStatus.toUpperCase()}: ${view.safeStatusMessage}`;
    setSummary('source', view.sourceDisplayName);
    setSummary('currentIntegrity', abbreviatedIntegrity(view.currentIntegrity));
    setSummary('candidateIntegrity', abbreviatedIntegrity(view.candidateIntegrity));
    setSummary('validation', view.validationStatus);
    setSummary('scenes', view.counts ? String(view.counts.scenes) : 'unavailable');
    setSummary('actions', view.counts ? String(view.counts.actions) : 'unavailable');
    setSummary('assets', view.counts ? String(view.counts.assets) : 'unavailable');
    setSummary(
      'anchor',
      view.anchor
        ? view.anchor.actionId
          ? `${view.anchor.sceneId} / ${view.anchor.actionId}`
          : view.anchor.sceneId
        : 'none',
    );
    setSummary('warnings', String(view.warningCount));
    setSummary(
      'changes',
      view.changeCategories.length > 0 ? view.changeCategories.join(', ') : 'none',
    );
    polite.textContent = `Preview status changed to ${view.phase}. ${view.safeStatusMessage}`;
    const blocksInitialStart =
      view.currentIntegrity === null &&
      (view.validationStatus === 'invalid' || view.validationStatus === 'missing');
    assertive.textContent = blocksInitialStart
      ? `Preview cannot start this source: ${view.safeStatusMessage}`
      : '';

    if (view.phase !== 'candidate' || nonBlockingCandidates) {
      closeModal();
      return;
    }
    for (const number of ['1', '2', '3']) {
      const choice = view.choices[number];
      const button = buttons.get(number);
      const reason = reasons.get(number);
      button.disabled = !choice.enabled;
      reason.textContent = choice.enabled ? 'Available' : `Unavailable: ${choice.reason}`;
    }
    if (!modalOpen) {
      previousFocus = document.activeElement ?? null;
      modalOpen = true;
      dialog.hidden = false;
    }
    const focusable = enabledButtons();
    if (!dialog.contains(document.activeElement) || document.activeElement?.disabled) {
      (focusable[0] ?? dialogTitle).focus();
    }
  }

  return Object.freeze({
    element: host,
    /** @param {unknown} nextView */
    update(nextView) {
      if (disposed) throw new TypeError('preview shell is disposed');
      const view = validateDsl4PreviewShellView(nextView);
      currentView = view;
      render(view);
      if (view.phase === 'ready' && !initialValidPublished) {
        initialValidPublished = true;
        invoke(onInitialValid, view);
      }
      return view;
    },
    getSnapshot() {
      return currentView;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      document.removeEventListener('keydown', onKeyDown, true);
      closeModal();
      if (typeof host.remove === 'function') host.remove();
      currentView = null;
    },
  });
}

const cliPreviewOptionKeys = new Set([
  'createReloadSurface',
  'document',
  'environment',
  'featureFlags',
  'mount',
  'onDefer',
  'onError',
  'onInitialValid',
  'onReloadChoice',
  'previewFormatTime',
  'previewReducedMotion',
  'previewSafeArea',
  'previewStorage',
  'previewViewport',
]);

/** @param {unknown} value */
function validateReloadSurface(value) {
  if (
    !isRecord(value) ||
    typeof value.submitCandidate !== 'function' ||
    typeof value.setDiagnostic !== 'function' ||
    typeof value.setWatchState !== 'function' ||
    typeof value.acknowledgePreviewInput !== 'function' ||
    typeof value.registerReservedRect !== 'function' ||
    typeof value.updateReservedRect !== 'function' ||
    typeof value.unregisterReservedRect !== 'function' ||
    typeof value.updateViewport !== 'function' ||
    typeof value.dispose !== 'function' ||
    typeof value.getSnapshot !== 'function' ||
    typeof value.whenIdle !== 'function'
  ) {
    throw new TypeError('CLI reload surface does not implement the shared preview contract');
  }
  return /** @type {Record<string, Function>} */ (value);
}

/** @param {unknown} value @param {Readonly<Record<string, number>>} fallback */
function previewGeometry(value, fallback) {
  return isRecord(value) ? value : fallback;
}

/**
 * Create the browser page shell owned by the CLI preview host.
 * The startup flag selects either the shared non-blocking surface or the legacy candidate dialog.
 *
 * @param {unknown} input
 */
export function createDsl4CliPreviewShell(input = {}) {
  if (!isRecord(input)) throw new TypeError('CLI preview shell options must be an object');
  const unknown = Object.keys(input).filter((key) => !cliPreviewOptionKeys.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown CLI preview shell option: ${unknown.sort().join(', ')}`);
  }
  if (input.environment !== 'development') {
    throw new TypeError('CLI preview shell is available only in the development environment');
  }
  const document = requireDocument(input.document);
  const mount = requireElement(input.mount, 'mount');
  const featureFlags = resolveDsl4FeatureFlags(input.featureFlags);
  const createReloadSurface = featureFlags.dsl4PreviewReloadOverlay
    ? (input.createReloadSurface ?? createDsl4PreviewReloadSurface)
    : null;
  if (createReloadSurface !== null && typeof createReloadSurface !== 'function') {
    throw new TypeError('createReloadSurface must be a function');
  }

  const host = element(document, 'section');
  host.id = 'dsl4-cli-preview-shell';
  host.setAttribute('data-dsl4-development-only', 'true');
  host.setAttribute('data-preview-host', 'cli');
  const detailsMount = element(document, 'div');
  detailsMount.id = 'dsl4-cli-preview-details';
  host.appendChild(detailsMount);
  mount.appendChild(host);

  const previewShell = createDsl4DevelopmentPreviewShell({
    environment: 'development',
    document,
    mount: detailsMount,
    nonBlockingCandidates: featureFlags.dsl4PreviewReloadOverlay,
    onInitialValid: input.onInitialValid,
    onReloadChoice: input.onReloadChoice,
    onDefer: input.onDefer,
    onError: input.onError,
  });
  /** @type {Record<string, Function> | null} */
  let reloadSurface = null;
  let disposed = false;
  /** @type {Promise<unknown> | null} */
  let disposePromise = null;

  if (createReloadSurface) {
    try {
      reloadSurface = validateReloadSurface(
        createReloadSurface({
          surface: 'cli',
          environment: 'development',
          document,
          mount: host,
          viewport: previewGeometry(input.previewViewport, {
            width: Math.max(44, Number(mount.clientWidth) || 800),
            height: Math.max(44, Number(mount.clientHeight) || 600),
          }),
          safeArea: previewGeometry(input.previewSafeArea, {
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
          }),
          storage: input.previewStorage,
          reducedMotion: input.previewReducedMotion,
          formatTime: input.previewFormatTime,
          onError: input.onError,
        }),
      );
    } catch (error) {
      previewShell.dispose();
      if (typeof host.remove === 'function') host.remove();
      throw error;
    }
  }

  function requireReloadSurface() {
    if (!reloadSurface) throw new TypeError('preview reload overlay is disabled');
    return reloadSurface;
  }

  function snapshot() {
    return deepFreeze({
      version: 1,
      surface: 'cli',
      disposed,
      featureFlags,
      preview: previewShell.getSnapshot(),
      reloadOverlay: reloadSurface?.getSnapshot() ?? null,
    });
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    if (disposed) return Promise.resolve(snapshot());
    disposed = true;
    previewShell.dispose();
    const reloadDisposal = reloadSurface?.dispose();
    if (typeof host.remove === 'function') host.remove();
    disposePromise = Promise.resolve(reloadDisposal).then(snapshot);
    return disposePromise;
  }

  return Object.freeze({
    enabled: true,
    element: host,
    featureFlags,
    update: previewShell.update,
    /** @param {unknown} candidate */
    submitReloadCandidate(candidate) {
      return requireReloadSurface().submitCandidate(candidate);
    },
    /** @param {'source' | 'asset'} channel @param {unknown} diagnostic */
    setReloadDiagnostic(channel, diagnostic) {
      return requireReloadSurface().setDiagnostic(channel, diagnostic);
    },
    /** @param {'source' | 'asset'} channel @param {unknown} status */
    setReloadWatchState(channel, status) {
      return requireReloadSurface().setWatchState(channel, status);
    },
    /** @param {string} inputId */
    acknowledgePreviewInput(inputId) {
      return reloadSurface?.acknowledgePreviewInput(inputId) ?? snapshot();
    },
    /** @param {string} owner @param {unknown} rect */
    registerReservedRect(owner, rect) {
      return requireReloadSurface().registerReservedRect(owner, rect);
    },
    /** @param {string} owner @param {unknown} rect */
    updateReservedRect(owner, rect) {
      return requireReloadSurface().updateReservedRect(owner, rect);
    },
    /** @param {string} owner */
    unregisterReservedRect(owner) {
      return requireReloadSurface().unregisterReservedRect(owner);
    },
    /** @param {unknown} viewport @param {unknown} [safeArea] */
    updatePreviewViewport(viewport, safeArea) {
      return requireReloadSurface().updateViewport(viewport, safeArea);
    },
    async whenIdle() {
      await reloadSurface?.whenIdle();
      return snapshot();
    },
    getSnapshot: snapshot,
    dispose,
  });
}

/** @param {unknown} project */
export function inspectDsl4ProductionPreviewExclusion(project) {
  if (!isRecord(project)) throw new TypeError('production project must be an object');
  const violations = new Set();
  const forbiddenFields = new Set(
    dsl4DevelopmentPreviewShellManifest.forbiddenProductionPersistedFields,
  );

  /** @param {unknown} value @param {string} path */
  function visit(value, path) {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (forbiddenFields.has(key)) violations.add(childPath);
      if (
        key === 'opcode' &&
        typeof child === 'string' &&
        dsl4DevelopmentPreviewShellManifest.forbiddenProductionOpcodePrefixes.some((prefix) =>
          child.startsWith(prefix),
        )
      ) {
        violations.add(`${childPath}:${child}`);
      }
      visit(child, childPath);
    }
  }
  visit(project, '$');

  for (const field of ['extensions', 'extensionIDs']) {
    const extensionIds = Array.isArray(project[field]) ? project[field] : [];
    for (const id of extensionIds) {
      if (dsl4DevelopmentPreviewShellManifest.forbiddenProductionExtensionIds.includes(id)) {
        violations.add(`$.${field}:${id}`);
      }
    }
  }
  if (isRecord(project.extensionURLs)) {
    for (const id of Object.keys(project.extensionURLs)) {
      if (dsl4DevelopmentPreviewShellManifest.forbiddenProductionExtensionIds.includes(id)) {
        violations.add(`$.extensionURLs.${id}`);
      }
    }
  }
  return deepFreeze({
    ok: violations.size === 0,
    violations: [...violations].sort(),
  });
}
