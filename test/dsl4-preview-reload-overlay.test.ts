import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
  createDsl4PreviewReloadOverlay,
  dsl4PreviewReloadOverlayManifest,
} from '../src/builder/index.js';
import {
  createDsl4DebugExecutionCoordinator,
  createDsl4PreviewLayoutCoordinator,
  createDsl4PreviewReloadPolicy,
} from '../src/dsl4/index.js';
import {
  createFakeDocument,
  findByAttribute,
  requireById,
  requireFakeElement,
} from './helpers/fake-dom.ts';
import {requireRecord, requireString} from './helpers/require-value.ts';

/**
 * Read the overlay's mounted element as the fake this suite built it in.
 *
 * The overlay declares its element through the preview DOM port, which names only the members it
 * writes; these cases read back what it wrote.
 */
function overlayRoot(setup: {overlay: {element: unknown}}) {
  return requireFakeElement(setup.overlay.element, 'the overlay element');
}

/** Read the overlay's status button as the fake this suite mounted it in. */
function statusButton(setup: {overlay: {statusButton: unknown}}) {
  return requireFakeElement(setup.overlay.statusButton, 'the overlay status button');
}

/** Read one element of the mounted overlay by id. */
function overlayElement(setup: {overlay: {element: unknown}}, id: string) {
  return requireById(overlayRoot(setup), id);
}

function candidate(revision: number, overrides: Record<string, unknown> = {}) {
  return {
    revision,
    availability: {
      story: {available: true, reason: null},
      scene: {available: true, reason: null},
      action: {available: true, replaySafe: true, reason: null},
    },
    summary: {category: 'source', changedIds: [`scene-${revision}`]},
    initiatingInputId: null,
    ...overrides,
  };
}

type OverlayOptions = Parameters<typeof createDsl4PreviewReloadOverlay>[0];

/** What one overlay case varies. */
interface SetupOptions {
  surface?: 'web' | 'cli';
  storage?: unknown;
  reducedMotion?: boolean;
  debugExecution?: unknown;
}

function createSetup({
  surface = 'web',
  storage,
  reducedMotion = false,
  debugExecution,
}: SetupOptions = {}) {
  const document = createFakeDocument();
  const before = document.createElement('button');
  before.id = 'preview-content-control';
  document.body.appendChild(before);
  before.focus();
  const applies: Record<string, unknown>[] = [];
  const restarts: Record<string, unknown>[] = [];
  const errors: unknown[] = [];
  const policy = createDsl4PreviewReloadPolicy({
    applyGeneration(request: Readonly<Record<string, unknown>>) {
      applies.push(request);
      return {
        revision: request.revision,
        actualAnchor: request.actualAnchor,
        fallbackReason: request.fallbackReason,
      };
    },
    restartGeneration(request: Readonly<Record<string, unknown>>) {
      restarts.push(request);
      return {
        revision: request.revision,
        actualAnchor: request.actualAnchor,
        fallbackReason: request.fallbackReason,
      };
    },
  });
  const layout = createDsl4PreviewLayoutCoordinator({
    viewport: {width: 400, height: 300},
  });
  const overlay = createDsl4PreviewReloadOverlay({
    surface,
    document,
    mount: document.body,
    policy,
    layoutCoordinator: layout,
    // Both are injected ports the cases stub; the overlay validates them itself.
    ...(debugExecution === undefined
      ? {}
      : {debugExecution: debugExecution as OverlayOptions['debugExecution']}),
    ...(storage === undefined ? {} : {storage: storage as OverlayOptions['storage']}),
    reducedMotion,
    formatTime: (timestamp) => `time:${timestamp}`,
    onError: (error) => errors.push(error),
  });
  return {applies, before, debugExecution, document, errors, layout, overlay, policy, restarts};
}

test('uses one non-blocking 44px status component for Web and CLI browser surfaces', () => {
  for (const surface of ['web', 'cli'] as const) {
    const setup = createSetup({surface});
    const button = statusButton(setup);
    assert.equal(button.style.width, '44px');
    assert.equal(button.style.height, '44px');
    assert.equal(button.style.minWidth, '44px');
    assert.equal(button.style.minHeight, '44px');
    assert.match(requireString(button.style.background, 'the button background'), /rgba/u);
    assert.match(requireString(button.style.outline, 'the button outline'), /solid/u);
    assert.equal(button.getAttribute('data-reload-state'), 'watching');
    assert.match(requireString(button.getAttribute('aria-label'), 'the button label'), /watching/u);
    assert.equal(overlayRoot(setup).getAttribute('data-preview-surface'), surface);
    assert.equal(setup.document.activeElement, setup.before);
    setup.overlay.dispose();
  }
  assert.deepEqual(dsl4PreviewReloadOverlayManifest, {
    formatVersion: 1,
    production: false,
    module: 'src/builder/dsl4-preview-reload-overlay.js',
    surfaces: ['web', 'cli'],
    featureFlag: 'dsl4PreviewReloadOverlay',
    storageKey: 'dsl4.preview.reload.anchor.v1',
    targetCssPixels: 44,
  });
});

test('announces commit acknowledgement without stealing focus and keeps diagnostics assertive', async () => {
  const setup = createSetup();
  await setup.policy.submitCandidate(candidate(1));
  assert.equal(statusButton(setup).getAttribute('data-reload-state'), 'reloaded');
  assert.equal(overlayElement(setup, 'dsl4-preview-reload-status-icon').textContent, '✓');
  assert.equal(setup.document.activeElement, setup.before);
  assert.match(overlayElement(setup, 'dsl4-preview-reload-live-status').textContent, /Reloaded/u);

  await setup.policy.setDiagnostic({
    code: 'K4-ASSET-MISSING',
    severity: 'error',
    message: 'Referenced asset is missing.',
  });
  const alert = overlayElement(setup, 'dsl4-preview-reload-live-diagnostic');
  assert.equal(statusButton(setup).getAttribute('data-reload-state'), 'diagnostic');
  assert.match(alert.textContent, /K4-ASSET-MISSING/u);
  const firstAnnouncement = alert.textContent;
  await setup.policy.setDiagnostic({
    code: 'K4-ASSET-MISSING',
    severity: 'error',
    message: 'Do not re-announce this duplicate code.',
  });
  assert.equal(alert.textContent, firstAnnouncement);
  await setup.policy.acknowledge({inputId: 'ordinary-key'});
  assert.equal(statusButton(setup).getAttribute('data-reload-state'), 'diagnostic');
  setup.overlay.dispose();
});

test('selects a session-only step mode and resumes a debugger pause from the settings dialog', async () => {
  const writes: unknown[][] = [];
  const debugExecution = createDsl4DebugExecutionCoordinator({enabled: true});
  const setup = createSetup({
    debugExecution,
    storage: {setItem: (...entry: unknown[]) => writes.push(entry)},
  });
  const controller = new AbortController();
  const paused = debugExecution.beforeAction({
    command: 'debugger',
    sceneId: 'opening',
    actionIndex: 2,
    actionPath: '/scenes/opening/actions/2',
    signal: controller.signal,
  });
  assert.equal(statusButton(setup).getAttribute('data-debug-state'), 'paused');
  assert.equal(overlayElement(setup, 'dsl4-preview-reload-status-badge').textContent, 'Debug');

  await setup.policy.submitCandidate(candidate(1));
  statusButton(setup).click();
  await setup.overlay.whenIdle();
  const step = overlayElement(setup, 'dsl4-preview-debug-mode-step');
  step.click();
  assert.equal(debugExecution.getState().mode, 'step');
  assert.equal(step.getAttribute('aria-checked'), 'true');
  assert.match(overlayElement(setup, 'dsl4-preview-debug-summary').textContent, /opening/u);
  assert.deepEqual(writes, []);

  const resume = overlayElement(setup, 'dsl4-preview-debug-resume');
  assert.equal(resume.hidden, false);
  resume.click();
  await paused;
  assert.equal(debugExecution.getState().paused, false);
  assert.equal(resume.hidden, true);
  assert.equal(
    requireRecord(
      requireRecord(setup.overlay.getSnapshot(), 'the overlay snapshot').debug,
      'its debug',
    ).mode,
    'step',
  );
  setup.overlay.dispose();
  debugExecution.dispose();
});

test('acknowledges a later meaningful preview touch but ignores the initiating pointer', async () => {
  const setup = createSetup();
  await setup.policy.submitCandidate(candidate(1, {initiatingInputId: 'pointer-7'}));
  setup.document.dispatchPointer(7);
  await setup.overlay.whenIdle();
  assert.equal(
    requireRecord(setup.policy.getState().lastSuccess, 'the last success').acknowledged,
    false,
  );
  setup.document.dispatchPointer(8);
  await setup.overlay.whenIdle();
  assert.equal(
    requireRecord(setup.policy.getState().lastSuccess, 'the last success').acknowledged,
    true,
  );
  setup.overlay.dispose();
  await setup.policy.dispose();
});

test('keeps selection side-effect free and maps Escape, scopes, focus trap, and shortcuts', async () => {
  const setup = createSetup();
  await setup.policy.submitCandidate(candidate(1));
  statusButton(setup).click();
  await setup.overlay.whenIdle();
  const dialog = overlayElement(setup, 'dsl4-preview-reload-status-dialog');
  const story = overlayElement(setup, 'dsl4-preview-reload-position-story');
  const scene = overlayElement(setup, 'dsl4-preview-reload-position-scene');
  assert.equal(dialog.hidden, false);
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(setup.document.activeElement, story);

  scene.click();
  await setup.overlay.whenIdle();
  assert.equal(setup.restarts.length, 0);
  assert.equal(setup.policy.getState().preference, 'action');
  const reloadOnce = overlayElement(setup, 'dsl4-preview-reload-scope-reload-once');
  assert.equal(setup.document.activeElement, reloadOnce);
  assert.equal(setup.document.dispatchKey('Tab').defaultPrevented, true);
  assert.notEqual(setup.document.activeElement, setup.before);

  const escape = setup.document.dispatchKey('Escape');
  assert.equal(escape.defaultPrevented, true);
  await setup.overlay.whenIdle();
  assert.equal(dialog.hidden, true);
  assert.equal(setup.document.activeElement, statusButton(setup));
  assert.equal(setup.restarts.length, 0);
  assert.equal(setup.policy.getState().preference, 'action');

  statusButton(setup).click();
  await setup.overlay.whenIdle();
  assert.equal(setup.document.dispatchKey('Digit3').defaultPrevented, true);
  await setup.overlay.whenIdle();
  overlayElement(setup, 'dsl4-preview-reload-scope-reload-and-save').click();
  await setup.overlay.whenIdle();
  assert.equal(setup.restarts.length, 1);
  assert.equal(setup.policy.getState().preference, 'action');
  assert.equal(dialog.hidden, true);
  setup.overlay.dispose();
});

test('returns stale dialogs to position selection when a newer generation arrives', async () => {
  const setup = createSetup();
  await setup.policy.submitCandidate(candidate(1));
  statusButton(setup).click();
  await setup.overlay.whenIdle();
  overlayElement(setup, 'dsl4-preview-reload-position-action').click();
  await setup.overlay.whenIdle();
  await setup.policy.submitCandidate(candidate(2));
  assert.equal(overlayElement(setup, 'dsl4-preview-reload-position-step').hidden, false);
  assert.equal(overlayElement(setup, 'dsl4-preview-reload-scope-step').hidden, true);
  assert.match(overlayElement(setup, 'dsl4-preview-reload-stale').textContent, /新しい/u);
  setup.overlay.dispose();
});

test('persists only the preferred anchor, resolves camera collisions, and supports keyboard movement', async () => {
  const writes: unknown[][] = [];
  const storage = {
    getItem: () => 'bottom-left',
    setItem: (key: string, value: string) => writes.push([key, value]),
  };
  const setup = createSetup({storage, reducedMotion: true});
  const button = statusButton(setup);
  assert.equal(button.getAttribute('data-preferred-anchor'), 'bottom-left');
  assert.equal(overlayRoot(setup).getAttribute('data-reduced-motion'), 'true');
  setup.layout.register('camera-controls', {
    x: Number.parseFloat(requireString(button.style.left, 'the button left')),
    y: Number.parseFloat(requireString(button.style.top, 'the button top')),
    width: 44,
    height: 44,
  });
  setup.overlay.refreshLayout();
  assert.notEqual(button.getAttribute('data-resolved-anchor'), 'bottom-left');
  assert.match(overlayElement(setup, 'dsl4-preview-reload-anchor-summary').textContent, /希望/u);

  button.click();
  await setup.overlay.whenIdle();
  const anchorButtons = findByAttribute(overlayRoot(setup), 'role', 'radio').filter((element) =>
    element.getAttribute('data-reload-anchor'),
  );
  assert.equal(anchorButtons.length, 8);
  assert.equal(
    anchorButtons.some(({textContent}) => textContent === '中央'),
    false,
  );
  const topLeft = overlayElement(setup, 'dsl4-preview-reload-anchor-top-left');
  topLeft.focus();
  assert.equal(setup.document.dispatchKey('ArrowRight').defaultPrevented, true);
  assert.equal(button.getAttribute('data-preferred-anchor'), 'bottom-left');
  assert.equal(setup.document.dispatchKey('Space').defaultPrevented, true);
  assert.equal(button.getAttribute('data-preferred-anchor'), 'top-center');
  assert.deepEqual(writes.at(-1), ['dsl4.preview.reload.anchor.v1', 'top-center']);
  assert.equal(setup.restarts.length, 0);
  assert.equal(setup.policy.getState().preference, 'action');
  overlayElement(setup, 'dsl4-preview-reload-anchor-reset').click();
  assert.equal(button.getAttribute('data-preferred-anchor'), 'top-right');
  setup.overlay.dispose();
});

test('falls back to session memory when browser storage is unavailable and cleans listeners', () => {
  const setup = createSetup({
    storage: {
      getItem() {
        throw new Error('storage denied');
      },
      setItem() {
        throw new Error('storage denied');
      },
    },
  });
  assert.equal(setup.overlay.getSnapshot().preferredAnchor, 'top-right');
  setup.overlay.setPreferredAnchor('left-center');
  assert.equal(setup.overlay.getSnapshot().preferredAnchor, 'left-center');
  assert.equal(setup.errors.length, 2);
  assert.equal(setup.document.listenerCount('keydown'), 1);
  assert.equal(setup.document.listenerCount('pointerdown'), 1);
  assert.equal(setup.document.listenerCount('pointerup'), 1);
  const button = statusButton(setup);
  button.dispatch('pointerdown', {pointerId: 17});
  assert.equal(button.hasPointerCapture(17), true);
  assert.deepEqual(setup.layout.getState().interaction, {
    pressed: true,
    pointerCaptured: true,
    focused: false,
  });
  setup.document.dispatchPointerEvent('pointerup', 17);
  assert.equal(button.hasPointerCapture(17), false);
  assert.equal(setup.layout.getState().interaction.pointerCaptured, false);
  setup.overlay.dispose();
  setup.overlay.dispose();
  assert.equal(setup.document.listenerCount('keydown'), 0);
  assert.equal(setup.document.listenerCount('pointerdown'), 0);
  assert.equal(setup.document.listenerCount('pointerup'), 0);
  assert.equal(overlayRoot(setup).parentNode, null);
});
