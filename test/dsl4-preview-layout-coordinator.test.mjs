import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
  createDsl4PreviewLayoutCoordinator,
  dsl4PreviewReloadAnchors,
  resolveDsl4PreviewReloadLayout,
} from '../src/dsl4/index.js';

const viewport = {width: 400, height: 300};
const safeArea = {top: 0, right: 0, bottom: 0, left: 0};

function anchorLayouts() {
  return Object.fromEntries(
    dsl4PreviewReloadAnchors.map((anchor) => [
      anchor,
      resolveDsl4PreviewReloadLayout({
        preferredAnchor: anchor,
        viewport,
        safeArea,
      }),
    ]),
  );
}

test('resolves every peripheral anchor to one distinct 44px safe-area target', () => {
  const layouts = anchorLayouts();
  assert.equal(dsl4PreviewReloadAnchors.length, 8);
  assert.equal(dsl4PreviewReloadAnchors.includes('center'), false);
  assert.equal(new Set(Object.values(layouts).map(({rect}) => `${rect.x},${rect.y}`)).size, 8);
  for (const [anchor, layout] of Object.entries(layouts)) {
    assert.equal(layout.preferredAnchor, anchor);
    assert.equal(layout.resolvedAnchor, anchor);
    assert.equal(layout.rect.width, 44);
    assert.equal(layout.rect.height, 44);
    assert.equal(layout.collisionReason, null);
  }

  const safe = resolveDsl4PreviewReloadLayout({
    preferredAnchor: 'top-left',
    viewport,
    safeArea: {top: 20, right: 10, bottom: 30, left: 15},
  });
  assert.deepEqual(safe.rect, {x: 23, y: 28, width: 44, height: 44});
});

test('chooses the nearest free anchor with the fixed tie-break order', () => {
  const layouts = anchorLayouts();
  const result = resolveDsl4PreviewReloadLayout({
    preferredAnchor: 'top-right',
    viewport,
    safeArea,
    reservedRects: [layouts['top-right'].rect],
  });
  assert.equal(result.resolvedAnchor, 'top-center');
  assert.match(result.collisionReason, /preferred anchor is occupied/u);

  const next = resolveDsl4PreviewReloadLayout({
    preferredAnchor: 'top-right',
    viewport,
    safeArea,
    reservedRects: [layouts['top-right'].rect, layouts['top-center'].rect],
  });
  assert.equal(next.resolvedAnchor, 'right-center');
});

test('stacks without overlap when all anchors are reserved', () => {
  const reservedRects = Object.values(anchorLayouts()).map(({rect}) => rect);
  const result = resolveDsl4PreviewReloadLayout({
    preferredAnchor: 'top-right',
    viewport,
    safeArea,
    reservedRects,
  });
  assert.equal(result.stacked, true);
  assert.equal(result.resolvedAnchor, 'top-right');
  for (const reserved of reservedRects) {
    const separated =
      result.rect.x + result.rect.width <= reserved.x ||
      reserved.x + reserved.width <= result.rect.x ||
      result.rect.y + result.rect.height <= reserved.y ||
      reserved.y + reserved.height <= result.rect.y;
    assert.equal(separated, true);
  }
});

test('coordinates explicit owners, returns to preference, and defers movement during interaction', () => {
  const changes = [];
  const coordinator = createDsl4PreviewLayoutCoordinator({
    viewport,
    safeArea,
    onChange: (layout) => changes.push(layout),
  });
  const initial = coordinator.resolve('top-right');
  coordinator.register('camera-controls', initial.rect);
  coordinator.setInteraction({pressed: false, pointerCaptured: false, focused: true});
  const deferred = coordinator.resolve('top-right');
  assert.equal(deferred.movementDeferred, true);
  assert.deepEqual(deferred.rect, initial.rect);

  coordinator.setInteraction({pressed: false, pointerCaptured: false, focused: false});
  const fallback = coordinator.resolve('top-right');
  assert.equal(fallback.resolvedAnchor, 'top-center');
  coordinator.unregister('camera-controls');
  const restored = coordinator.resolve('top-right');
  assert.equal(restored.resolvedAnchor, 'top-right');
  assert.equal(restored.movementDeferred, false);
  assert.deepEqual(coordinator.getState().reservedOwners, []);
  assert.equal(changes.length >= 3, true);
});

test('recomputes for viewport changes and rejects implicit DOM or malformed geometry', () => {
  const coordinator = createDsl4PreviewLayoutCoordinator({viewport});
  coordinator.resolve('bottom-right');
  coordinator.updateViewport({width: 240, height: 180}, {top: 10, right: 10, bottom: 10, left: 10});
  const resized = coordinator.resolve('bottom-right');
  assert.deepEqual(resized.rect, {x: 178, y: 118, width: 44, height: 44});
  assert.throws(() => coordinator.register('camera controls', {}), TypeError);
  assert.throws(() => coordinator.update('missing', {x: 0, y: 0, width: 1, height: 1}), TypeError);
  assert.throws(
    () =>
      resolveDsl4PreviewReloadLayout({
        preferredAnchor: 'center',
        viewport,
        safeArea,
      }),
    TypeError,
  );
  assert.throws(
    () =>
      resolveDsl4PreviewReloadLayout({
        preferredAnchor: 'top-right',
        viewport,
        safeArea,
        targetSize: 24,
      }),
    /at least 44/u,
  );
});

test('keeps a 44px target usable in the narrowest supported viewport', () => {
  assert.deepEqual(
    resolveDsl4PreviewReloadLayout({
      preferredAnchor: 'top-right',
      viewport: {width: 44, height: 44},
      safeArea: {top: 0, right: 0, bottom: 0, left: 0},
    }).rect,
    {x: 0, y: 0, width: 44, height: 44},
  );
});
