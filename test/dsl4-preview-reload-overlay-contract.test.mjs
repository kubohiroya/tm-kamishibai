import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const contract = JSON.parse(
  await readFile(
    new URL('fixtures/dsl4/preview-reload-overlay-contract.json', import.meta.url),
    'utf8',
  ),
);
const screenshotContract = JSON.parse(
  await readFile(
    new URL('fixtures/dsl4/preview-reload-overlay-screenshot.json', import.meta.url),
    'utf8',
  ),
);
const design = await readFile(
  new URL('../docs/design/dsl-4-preview-reload-overlay.md', import.meta.url),
  'utf8',
);

test('freezes the #394 shared default-off rollout and rollback boundary', () => {
  assert.deepEqual(contract.featureFlag, {
    name: 'dsl4PreviewReloadOverlay',
    default: false,
    startupFixed: true,
    requires: ['dsl4Runtime', 'dsl4AppShell'],
    webPreviewSpecific: false,
  });
  assert.equal(contract.rollbackFlag, 'dsl4PreviewReloadOverlay');
  assert.match(design, /dsl4PreviewReloadOverlay=false/u);
  assert.match(design, /Web and CLI browser hosts construct\s+the same component/u);
});

test('fixes state priority, fallback, two-stage scopes, and acknowledgement timing', () => {
  assert.deepEqual(contract.displayPriority, [
    'diagnostic',
    'applying',
    'reloaded',
    'stabilizing',
    'paused',
    'disconnected',
    'watching',
  ]);
  assert.deepEqual(contract.fallbackOrder, ['action', 'scene', 'story']);
  assert.equal(contract.defaultPreference, 'action');
  assert.deepEqual(contract.manualScopes, [
    'reload-once',
    'reload-and-save',
    'save-next',
    'cancel',
  ]);
  assert.equal(contract.minimumSuccessDisplayMs, 2000);
  assert.match(design, /initiating input cannot acknowledge/u);
});

test('fixes all eight peripheral anchors, deterministic layout, and target size', () => {
  assert.deepEqual(contract.anchors, [
    'top-left',
    'top-center',
    'top-right',
    'right-center',
    'bottom-right',
    'bottom-center',
    'bottom-left',
    'left-center',
  ]);
  assert.equal(contract.anchors.includes('center'), false);
  assert.equal(contract.defaultAnchor, 'top-right');
  assert.equal(contract.targetCssPixels, 44);
  assert.equal(contract.minimumTargetCssPixels, 24);
  assert.match(design, /closest non-intersecting anchor/u);
});

test('keeps every transient overlay field out of production artifacts', () => {
  assert.deepEqual(contract.productionExclusions, [
    'previewReloadOverlay',
    'reloadPreference',
    'reloadTimestamp',
    'reloadDialogState',
    'reloadLayoutState',
    'reloadCandidateRevision',
  ]);
  for (const field of contract.productionExclusions) assert.match(design, new RegExp(field, 'u'));
});

test('provides a deterministic reduced-motion screenshot contract to docs #31', () => {
  assert.equal(screenshotContract.consumerIssue, 'kubohiroya/tmpose-kamishibai-docs#31');
  assert.deepEqual(screenshotContract.capture.viewport, {width: 1280, height: 720});
  assert.equal(screenshotContract.capture.reducedMotion, true);
  assert.equal(screenshotContract.capture.sourcePathsVisible, false);
  assert.deepEqual(screenshotContract.requiredAnchorsInDialog, contract.anchors);
  assert.deepEqual(
    screenshotContract.frames.map(({id}) => id),
    [
      'watching-top-right',
      'reloaded-action',
      'diagnostic-last-known-good',
      'dialog-position-selector',
      'dialog-scope-selector',
      'camera-control-collision',
    ],
  );
});
