import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  createDsl4DevelopmentPreviewShell,
  dsl4DevelopmentPreviewShellManifest,
  inspectDsl4ProductionPreviewExclusion,
  validateDsl4PreviewShellView,
} from '../src/builder/index.js';
import {createFakeDocument, findByAttribute, findById} from './helpers/fake-dom.mjs';

const productionContract = JSON.parse(
  await readFile(
    new URL('fixtures/dsl4/preview-production-exclusion.json', import.meta.url),
    'utf8',
  ),
);
const productionProject = JSON.parse(
  await readFile(new URL('../app/project.source.json', import.meta.url), 'utf8'),
);

function sri(value) {
  return `sha256-${createHash('sha256').update(value).digest('base64')}`;
}

function baseView(overrides = {}) {
  return {
    formatVersion: 1,
    phase: 'running',
    sourceDisplayName: 'story.kamishibai.yaml',
    currentIntegrity: sri('current'),
    candidateIntegrity: null,
    validationStatus: 'valid',
    counts: {scenes: 3, actions: 12, assets: 4},
    anchor: {sceneId: 'opening', actionId: '/scenes/0/actions/2'},
    choices: null,
    warningCount: 0,
    changeCategories: [],
    safeStatusMessage: 'The current immutable source is running.',
    ...overrides,
  };
}

function candidateView(overrides = {}) {
  return baseView({
    phase: 'candidate',
    candidateIntegrity: sri('candidate'),
    choices: {
      1: {enabled: true, reason: null},
      2: {enabled: true, reason: null},
      3: {enabled: false, reason: 'The current action has no compatible anchor.'},
    },
    warningCount: 2,
    changeCategories: ['actions', 'source'],
    safeStatusMessage: 'A valid changed source is ready for review.',
    ...overrides,
  });
}

function createShell(callbacks = {}) {
  const document = createFakeDocument();
  const before = document.createElement('button');
  before.id = 'before-preview';
  document.body.appendChild(before);
  before.focus();
  const calls = [];
  const shell = createDsl4DevelopmentPreviewShell({
    environment: 'development',
    document,
    mount: document.body,
    onInitialValid: (view) => calls.push(['initial', view]),
    onReloadChoice: (choice, view) => calls.push(['choice', choice, view]),
    onDefer: (view) => calls.push(['defer', view]),
    onError: (error) => calls.push(['error', error]),
    ...callbacks,
  });
  return {document, before, calls, shell};
}

test('keeps missing and invalid initial source visible, then auto-starts first valid without a modal', () => {
  const {document, calls, shell} = createShell();
  const dialog = findById(shell.element, 'dsl4-preview-reload-dialog');
  const status = findById(shell.element, 'dsl4-preview-status');
  const liveError = findById(shell.element, 'dsl4-preview-live-error');

  shell.update(
    baseView({
      phase: 'watching',
      currentIntegrity: null,
      validationStatus: 'missing',
      counts: null,
      anchor: null,
      safeStatusMessage: 'Waiting for story.kamishibai.yaml.',
    }),
  );
  assert.equal(shell.element.parentNode, document.body);
  assert.equal(dialog.hidden, true);
  assert.match(status.textContent, /^MISSING:/u);
  assert.match(liveError.textContent, /cannot start/u);
  assert.equal(calls.length, 0);

  shell.update(
    baseView({
      phase: 'invalid',
      currentIntegrity: null,
      validationStatus: 'invalid',
      counts: null,
      anchor: null,
      warningCount: 1,
      safeStatusMessage: 'K4-SCHEMA-001: The source is invalid.',
    }),
  );
  assert.equal(dialog.hidden, true);
  assert.equal(calls.length, 0);
  assert.match(liveError.textContent, /K4-SCHEMA-001/u);

  const ready = shell.update(
    baseView({
      phase: 'ready',
      currentIntegrity: null,
      candidateIntegrity: sri('first-valid'),
      anchor: null,
      safeStatusMessage: 'The first valid source is ready.',
    }),
  );
  assert.equal(dialog.hidden, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'initial');
  assert.equal(calls[0][1], ready);
  shell.update(ready);
  assert.equal(calls.length, 1);
});

test('renders the fixed semantic summary without source text, runtime values, or an editor', () => {
  const {shell} = createShell();
  const view = shell.update(candidateView());
  const values = Object.fromEntries(
    findByAttribute(shell.element, 'data-summary-value', 'source')
      .concat(
        ...[
          'currentIntegrity',
          'candidateIntegrity',
          'validation',
          'scenes',
          'actions',
          'assets',
          'anchor',
          'warnings',
          'changes',
        ].map((key) => findByAttribute(shell.element, 'data-summary-value', key)),
      )
      .map((element) => [element.getAttribute('data-summary-value'), element.textContent]),
  );
  assert.deepEqual(values, {
    source: 'story.kamishibai.yaml',
    currentIntegrity: `${view.currentIntegrity.slice(0, 19)}…`,
    candidateIntegrity: `${view.candidateIntegrity.slice(0, 19)}…`,
    validation: 'valid',
    scenes: '3',
    actions: '12',
    assets: '4',
    anchor: 'opening / /scenes/0/actions/2',
    warnings: '2',
    changes: 'source, actions',
  });
  assert.equal(findByAttribute(shell.element, 'contenteditable', 'true').length, 0);
  assert.equal(JSON.stringify(view).includes('sourceText'), false);
  assert.equal(JSON.stringify(view).includes('runtimeVariables'), false);
});

test('supports buttons, digits, disabled reasons, focus trap, Esc, and focus restore', () => {
  const {document, before, calls, shell} = createShell();
  shell.update(candidateView());
  const dialog = findById(shell.element, 'dsl4-preview-reload-dialog');
  const button1 = findById(shell.element, 'dsl4-preview-reload-1');
  const button2 = findById(shell.element, 'dsl4-preview-reload-2');
  const button3 = findById(shell.element, 'dsl4-preview-reload-3');
  const reason3 = findById(shell.element, 'dsl4-preview-reload-3-reason');
  assert.equal(dialog.hidden, false);
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(document.activeElement, button1);
  assert.equal(button3.disabled, true);
  assert.match(reason3.textContent, /Unavailable/u);
  assert.equal(button3.getAttribute('aria-describedby'), reason3.id);
  assert.equal(document.dispatchKey('ArrowLeft').defaultPrevented, false);
  assert.equal(document.dispatchKey('Digit1', {shiftKey: true}).defaultPrevented, false);
  assert.equal(calls.length, 0);

  assert.equal(document.dispatchKey('Tab').defaultPrevented, true);
  assert.equal(document.activeElement, button2);
  assert.equal(document.dispatchKey('Tab').defaultPrevented, true);
  assert.equal(document.activeElement, button1);
  assert.equal(document.dispatchKey('Tab', {shiftKey: true}).defaultPrevented, true);
  assert.equal(document.activeElement, button2);

  const disabledDigit = document.dispatchKey('Digit3');
  assert.equal(disabledDigit.defaultPrevented, true);
  assert.equal(calls.length, 0);
  assert.match(findById(shell.element, 'dsl4-preview-live-status').textContent, /unavailable/u);

  const escape = document.dispatchKey('Escape');
  assert.equal(escape.defaultPrevented, true);
  assert.equal(dialog.hidden, true);
  assert.equal(document.activeElement, before);
  assert.equal(calls[0][0], 'defer');

  shell.update(candidateView({candidateIntegrity: sri('next-candidate')}));
  assert.equal(document.activeElement, button1);
  const digit = document.dispatchKey('Digit2');
  assert.equal(digit.defaultPrevented, true);
  assert.equal(dialog.hidden, true);
  assert.equal(document.activeElement, before);
  assert.deepEqual(
    calls.slice(1).map((entry) => entry.slice(0, 2)),
    [['choice', 2]],
  );

  shell.update(candidateView({candidateIntegrity: sri('button-candidate')}));
  button1.click();
  assert.equal(calls.at(-1)[0], 'choice');
  assert.equal(calls.at(-1)[1], 1);

  shell.update(candidateView({candidateIntegrity: sri('enter-candidate')}));
  assert.equal(document.dispatchKey('Enter').defaultPrevented, true);
  assert.equal(calls.at(-1)[1], 1);

  shell.update(candidateView({candidateIntegrity: sri('space-candidate')}));
  assert.equal(document.dispatchKey('Space').defaultPrevented, true);
  assert.equal(calls.at(-1)[1], 1);

  shell.update(
    candidateView({
      candidateIntegrity: sri('disabled-candidate'),
      choices: {
        1: {enabled: false, reason: 'Restart is temporarily unavailable.'},
        2: {enabled: false, reason: 'The scene anchor is unavailable.'},
        3: {enabled: false, reason: 'The action anchor is unavailable.'},
      },
    }),
  );
  const dialogTitle = findById(shell.element, 'dsl4-preview-reload-title');
  assert.equal(document.activeElement, dialogTitle);
  assert.equal(document.dispatchKey('Tab').defaultPrevented, true);
  assert.equal(document.activeElement, dialogTitle);
  document.dispatchKey('Escape');
});

test('uses polite and assertive live regions and does not capture keys outside a modal', () => {
  const {document, shell} = createShell();
  const polite = findById(shell.element, 'dsl4-preview-live-status');
  const assertive = findById(shell.element, 'dsl4-preview-live-error');
  assert.equal(polite.getAttribute('aria-live'), 'polite');
  assert.equal(assertive.getAttribute('aria-live'), 'assertive');

  shell.update(baseView());
  for (const code of ['ArrowLeft', 'ArrowUp', 'Digit1', 'Space']) {
    assert.equal(document.dispatchKey(code).defaultPrevented, false, code);
  }
  shell.update(
    baseView({
      phase: 'invalid',
      validationStatus: 'invalid',
      safeStatusMessage: 'K4-SCHEMA-001: The changed source is invalid.',
    }),
  );
  assert.equal(assertive.textContent, '');
  assert.match(polite.textContent, /K4-SCHEMA-001/u);
});

test('fails closed for unsafe view data and contains callback failures', async () => {
  for (const [field, value] of [
    ['sourceText', 'secret source'],
    ['runtimeVariables', {score: 1}],
    ['fullDiff', 'large diff'],
    ['editorState', {}],
  ]) {
    assert.throws(() => validateDsl4PreviewShellView({...baseView(), [field]: value}), /unknown/u);
  }
  assert.throws(() => validateDsl4PreviewShellView(candidateView({choices: null})), TypeError);
  assert.throws(
    () => validateDsl4PreviewShellView(baseView({safeStatusMessage: 'x'.repeat(501)})),
    TypeError,
  );

  const observed = [];
  const {shell} = createShell({
    onReloadChoice() {
      throw new Error('observer failure');
    },
    onError(error) {
      observed.push(error.message);
    },
  });
  shell.update(candidateView());
  findById(shell.element, 'dsl4-preview-reload-1').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, ['observer failure']);
});

test('is development-only and scans production projects for preview persistence', () => {
  assert.deepEqual(dsl4DevelopmentPreviewShellManifest, {
    formatVersion: productionContract.formatVersion,
    production: false,
    extensionId: productionContract.extensionId,
    module: productionContract.developmentOnlyModule,
    forbiddenProductionExtensionIds: productionContract.forbiddenProductionExtensionIds,
    forbiddenProductionOpcodePrefixes: productionContract.forbiddenProductionOpcodePrefixes,
    forbiddenProductionPersistedFields: productionContract.forbiddenProductionPersistedFields,
  });
  assert.throws(
    () =>
      createDsl4DevelopmentPreviewShell({
        environment: 'production',
        document: null,
        mount: null,
        onInitialValid: undefined,
        onReloadChoice: undefined,
        onDefer: undefined,
        onError: undefined,
      }),
    /only in the development/u,
  );
  const document = createFakeDocument();
  const callbackFreeShell = createDsl4DevelopmentPreviewShell({
    environment: 'development',
    document,
    mount: document.body,
  });
  callbackFreeShell.dispose();
  assert.deepEqual(inspectDsl4ProductionPreviewExclusion(productionProject), {
    ok: true,
    violations: [],
  });

  const invalid = structuredClone(productionProject);
  invalid.extensions.push('kubohiroyakamishibai4preview');
  invalid.extensionURLs.kubohiroyakamishibai4preview = 'embedded-extension:preview.js';
  invalid.extensionStorage.previewBridge = {previewToken: 'secret'};
  const firstTarget = invalid.targets[0];
  firstTarget.blocks.preview = {opcode: 'kubohiroyakamishibai4preview_openModal'};
  firstTarget.reloadCandidate = {revision: 1};
  invalid.reloadModalState = {choice: null};
  invalid.browserPreviewHandle = {name: 'must-not-persist'};
  invalid.browserPreviewTimer = 1;
  invalid.browserPreviewObserver = {connected: true};
  invalid.browserPreviewPendingRead = {revision: 2};
  invalid.browserPreviewCandidate = {revision: 2};
  invalid.browserPreviewModalState = {choice: null};
  invalid.previewReloadOverlay = {status: 'reloaded'};
  invalid.reloadPreference = 'action';
  invalid.reloadTimestamp = 1;
  invalid.reloadDialogState = {open: false};
  invalid.reloadLayoutState = {resolvedAnchor: 'top-right'};
  invalid.reloadCandidateRevision = 3;
  const result = inspectDsl4ProductionPreviewExclusion(invalid);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => violation.includes('extensions')));
  assert.ok(result.violations.some((violation) => violation.includes('extensionURLs')));
  assert.ok(result.violations.some((violation) => violation.includes('previewBridge')));
  assert.ok(result.violations.some((violation) => violation.includes('previewToken')));
  assert.ok(result.violations.some((violation) => violation.includes('reloadCandidate')));
  assert.ok(result.violations.some((violation) => violation.includes('reloadModalState')));
  for (const field of [
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
  ]) {
    assert.ok(
      result.violations.some((violation) => violation.includes(field)),
      field,
    );
  }
  assert.ok(result.violations.some((violation) => violation.includes('openModal')));
});

test('removes listeners and UI idempotently on dispose', () => {
  const {document, shell} = createShell();
  assert.equal(document.listenerCount('keydown'), 1);
  shell.update(candidateView());
  shell.dispose();
  shell.dispose();
  assert.equal(document.listenerCount('keydown'), 0);
  assert.equal(shell.element.parentNode, null);
  assert.equal(shell.getSnapshot(), null);
  assert.throws(() => shell.update(baseView()), /disposed/u);
});
