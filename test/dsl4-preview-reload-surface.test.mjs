import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDsl4PreviewReloadSurface,
  dsl4PreviewReloadSurfaceManifest,
} from '../src/builder/index.js';
import {findById, createFakeDocument} from './helpers/fake-dom.mjs';

function availability({replaySafe = true} = {}) {
  return {
    story: {available: true, reason: null},
    scene: {available: true, reason: null},
    action: {available: true, replaySafe, reason: null},
  };
}

function createSurface(surface = 'web') {
  const document = createFakeDocument();
  const operations = [];
  const errors = [];
  const instance = createDsl4PreviewReloadSurface({
    surface,
    environment: 'development',
    document,
    mount: document.body,
    viewport: {width: 640, height: 480},
    formatTime: (timestamp) => `time:${timestamp}`,
    onError: (error) => errors.push(error),
  });
  const submit = (channel, channelRevision, overrides = {}) =>
    instance.submitCandidate({
      channel,
      channelRevision,
      availability: availability(),
      changedIds: [`${channel}-${channelRevision}`],
      initiatingInputId: null,
      apply(request) {
        operations.push(['apply', request]);
      },
      restart(request) {
        operations.push(['restart', request]);
      },
      ...overrides,
    });
  return {document, errors, instance, operations, submit};
}

test('uses one surface contract and component for Web and CLI browser hosts', async () => {
  for (const surface of ['web', 'cli']) {
    const setup = createSurface(surface);
    assert.equal(setup.instance.element.getAttribute('data-preview-surface'), surface);
    assert.equal(setup.instance.getSnapshot().overlay.surface, surface);
    await setup.instance.dispose();
  }
  assert.deepEqual(dsl4PreviewReloadSurfaceManifest, {
    formatVersion: 1,
    production: false,
    featureFlag: 'dsl4PreviewReloadOverlay',
    surfaces: ['web', 'cli'],
    candidateChannels: ['source', 'asset'],
    ownsGlobalRevisionOrder: true,
  });
});

test('serializes source and asset channel revisions in one non-mixing generation order', async () => {
  const setup = createSurface();
  const source = setup.submit('source', 9, {availability: availability({replaySafe: false})});
  const asset = setup.submit('asset', 1);
  await Promise.all([source, asset]);

  assert.deepEqual(
    setup.operations.map(([operation, request]) => [
      operation,
      request.revision,
      request.channel,
      request.channelRevision,
    ]),
    [['apply', 2, 'asset', 1]],
  );
  assert.equal(setup.instance.getSnapshot().globalRevision, 2);
  assert.equal(setup.instance.policy.getState().latestAppliedRevision, 2);
  assert.equal(setup.errors.length, 0);
  await setup.instance.dispose();
});

test('routes manual restart to the active channel and keeps channel diagnostics independent', async () => {
  const setup = createSurface();
  await setup.submit('asset', 4);
  await setup.instance.policy.openDialog();
  await setup.instance.policy.selectPosition('scene');
  await setup.instance.policy.applyScope('reload-once');
  assert.deepEqual(
    setup.operations.map(([operation, request]) => [
      operation,
      request.channel,
      request.channelRevision,
    ]),
    [
      ['apply', 'asset', 4],
      ['restart', 'asset', 4],
    ],
  );

  await setup.instance.setDiagnostic('source', {
    code: 'K4-SOURCE-WARNING',
    severity: 'warning',
    message: 'Source warning.',
  });
  await setup.instance.setDiagnostic('asset', {
    code: 'K4-ASSET-MISSING',
    severity: 'error',
    message: 'Asset missing.',
  });
  assert.equal(setup.instance.policy.getState().diagnostic.code, 'K4-ASSET-MISSING');
  assert.match(
    findById(setup.instance.element, 'dsl4-preview-reload-live-diagnostic').textContent,
    /K4-ASSET-MISSING/u,
  );
  await setup.instance.setDiagnostic('asset', null);
  assert.equal(setup.instance.policy.getState().diagnostic.code, 'K4-SOURCE-WARNING');
  await setup.instance.dispose();
});

test('recomputes shared layout on browser resize, orientation, and fullscreen geometry', async () => {
  const document = createFakeDocument();
  const listeners = new Map();
  const browserWindow = {
    innerWidth: 640,
    innerHeight: 480,
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== listener),
      );
    },
    dispatch(type) {
      for (const listener of listeners.get(type) ?? []) listener({type});
    },
  };
  document.defaultView = browserWindow;
  const instance = createDsl4PreviewReloadSurface({
    surface: 'web',
    environment: 'development',
    document,
    mount: document.body,
    viewport: {width: 640, height: 480},
  });

  browserWindow.innerWidth = 900;
  browserWindow.innerHeight = 700;
  browserWindow.dispatch('resize');
  assert.deepEqual(instance.layoutCoordinator.getState().viewport, {width: 900, height: 700});

  browserWindow.innerWidth = 700;
  browserWindow.innerHeight = 900;
  browserWindow.dispatch('orientationchange');
  assert.deepEqual(instance.layoutCoordinator.getState().viewport, {width: 700, height: 900});

  document.fullscreenElement = {clientWidth: 1024, clientHeight: 768};
  document.dispatchPointerEvent('fullscreenchange', 1);
  assert.deepEqual(instance.layoutCoordinator.getState().viewport, {width: 1024, height: 768});
  await instance.dispose();
  assert.equal((listeners.get('resize') ?? []).length, 0);
  assert.equal((listeners.get('orientationchange') ?? []).length, 0);
});

test('rejects production construction and releases DOM and listeners on dispose', async () => {
  const document = createFakeDocument();
  assert.throws(
    () =>
      createDsl4PreviewReloadSurface({
        surface: 'web',
        environment: 'production',
        document,
        mount: document.body,
        viewport: {width: 640, height: 480},
      }),
    /development/u,
  );
  const setup = createSurface();
  assert.equal(setup.document.listenerCount('keydown'), 1);
  await setup.instance.dispose();
  assert.equal(setup.document.listenerCount('keydown'), 0);
  assert.equal(setup.instance.element.parentNode, null);
});
