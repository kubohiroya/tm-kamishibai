import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDsl4IndeterminateProgressIndicator,
  createDsl4StandardAppShell,
} from '../src/dsl4/platform/index.js';
import {createFakeDocument, findByAttribute} from './helpers/fake-dom.mjs';

test('renders an indeterminate progressbar while asset and camera waits overlap', async () => {
  const document = createFakeDocument();
  const indicator = createDsl4IndeterminateProgressIndicator({
    document,
    mount: document.body,
  });

  indicator.setBusy({visible: true, source: 'assets', label: 'Loading assets'});
  const root = findByAttribute(document.body, 'role', 'progressbar')[0];
  assert.ok(root);
  assert.equal(root.hidden, false);
  assert.equal(root.getAttribute('aria-busy'), 'true');
  assert.equal(root.getAttribute('aria-label'), 'Loading assets');
  assert.equal(root.getAttribute('aria-valuenow'), null);
  assert.equal(root.dataset.dsl4IndeterminateProgress, 'true');
  assert.equal(root.dataset.dsl4IndeterminateProgressVariant, 'circular');
  assert.equal(root.style.position, 'fixed');
  assert.equal(root.style.zIndex, '2147483647');
  assert.equal(root.style.background, 'rgba(0, 0, 0, 0.12)');

  indicator.setVariant('bar');
  assert.equal(root.dataset.dsl4IndeterminateProgressVariant, 'bar');
  assert.equal(root.children[1].dataset.dsl4IndeterminateProgressTrack, 'true');
  assert.equal(root.children[1].children[0].dataset.dsl4IndeterminateProgressFill, 'true');

  indicator.setBusy({visible: true, source: 'camera', label: 'Starting camera'});
  indicator.setBusy({visible: false, source: 'assets', label: 'Loading assets'});
  assert.equal(root.hidden, false);
  assert.equal(root.getAttribute('aria-label'), 'Starting camera');

  indicator.setBusy({visible: false, source: 'camera', label: 'Starting camera'});
  assert.equal(root.hidden, true);
  assert.equal(root.getAttribute('aria-busy'), 'false');

  indicator.setCursor({visible: true, source: 'pose', cursor: 'progress'});
  assert.equal(document.body.dataset.dsl4CursorSurface, 'true');
  assert.equal(document.body.dataset.dsl4Cursor, 'progress');
  indicator.setCursor({visible: true, source: 'camera', cursor: 'wait'});
  assert.equal(document.body.dataset.dsl4Cursor, 'wait');
  indicator.setCursor({visible: false, source: 'camera', cursor: 'wait'});
  assert.equal(document.body.dataset.dsl4Cursor, 'progress');
  indicator.setCursor({visible: false, source: 'pose', cursor: 'progress'});
  assert.equal(document.body.dataset.dsl4Cursor, 'auto');

  indicator.dispose();
  assert.equal(document.body.children.length, 0);
});

test('Standard app shell wires loading and camera waits to the shared indicator', async () => {
  const document = createFakeDocument();
  let hostOptions = null;
  const shell = await createDsl4StandardAppShell({
    featureFlags: {dsl4Runtime: true, dsl4AppShell: true},
    surface: 'developmentPreview',
    document,
    mount: document.body,
    progressIndicator: {variant: 'bar'},
    runtimeHostOptions: {
      setLoading() {},
    },
    createRuntimeHost(options) {
      hostOptions = options;
      return {
        ok: true,
        enabled: true,
        diagnostics: [],
        host: {dispose() {}},
      };
    },
  });

  assert.equal(typeof hostOptions.setLoading, 'function');
  assert.equal(typeof hostOptions.setBusy, 'function');
  assert.equal(typeof hostOptions.setCursor, 'function');
  hostOptions.setLoading({visible: true}, {});
  const root = findByAttribute(document.body, 'role', 'progressbar')[0];
  assert.ok(root);
  assert.equal(root.dataset.dsl4IndeterminateProgressVariant, 'bar');
  assert.equal(root.hidden, false);
  hostOptions.setBusy({visible: true, source: 'camera', label: 'Starting camera'});
  hostOptions.setLoading({visible: false}, {});
  assert.equal(root.hidden, false);
  hostOptions.setBusy({visible: false, source: 'camera', label: 'Starting camera'});
  assert.equal(root.hidden, true);
  hostOptions.setCursor({visible: true, source: 'pose', cursor: 'progress'});
  assert.equal(document.body.dataset.dsl4Cursor, 'progress');
  hostOptions.setCursor({visible: false, source: 'pose', cursor: 'progress'});
  assert.equal(document.body.dataset.dsl4Cursor, 'auto');

  await shell.dispose('indicator-test');
  assert.equal(document.body.children.length, 0);
});
