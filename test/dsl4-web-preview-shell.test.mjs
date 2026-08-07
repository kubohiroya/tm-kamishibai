import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';

import {createDsl4WebPreviewShell, dsl4WebPreviewShellManifest} from '../src/builder/index.js';
import {createFakeDocument, findById} from './helpers/fake-dom.mjs';

const enabledFlags = Object.freeze({
  dsl4Runtime: true,
  dsl4AppShell: true,
  dsl4WebPreviewAdapter: true,
});
const assetEnabledFlags = Object.freeze({
  ...enabledFlags,
  dsl4WebPreviewAssetLiveReload: true,
});
const includedAssetEnabledFlags = Object.freeze({
  ...assetEnabledFlags,
  dsl4SourceIncludes: true,
});

function sri(value) {
  return `sha256-${createHash('sha256').update(value).digest('base64')}`;
}

function sourceResult(integrity, {warnings = 0} = {}) {
  return Object.freeze({
    ok: true,
    canonicalSource: 'canonical source',
    diagnostics: Array.from({length: warnings}, (_, index) => ({
      version: 1,
      code: `K4-TEST-WARNING-${index}`,
      severity: 'warning',
      message: 'Fixture warning',
      sourceId: 'main',
      range: {
        start: {line: 1, column: 1, offset: 0},
        end: {line: 1, column: 1, offset: 0},
      },
      path: '$',
      related: [],
    })),
    storyDocument: {
      kind: 'StoryDocument',
      version: '4.0',
      scenes: [
        {id: 'opening', actions: [{id: 'one'}, {id: 'two'}]},
        {id: 'ending', actions: []},
      ],
      assetReferences: [{id: 'backdrop'}],
    },
    sourceSnapshot: {
      integrity,
      displayName: 'story.kamishibai.yaml',
      text: 'must not escape the source callback',
    },
  });
}

function createCoordinatorFixture() {
  let options;
  const calls = [];
  let disposed = false;
  let sourceStarted = false;
  let current = null;
  const state = () => ({
    version: 1,
    disposed,
    source: {started: sourceStarted, status: 'idle'},
    protocol: {current},
  });
  const coordinator = {
    openProject() {
      calls.push(['openProject']);
      return Promise.resolve(state());
    },
    start(root) {
      calls.push(['start', root]);
      sourceStarted = true;
      return Promise.resolve(state());
    },
    pollNow() {
      calls.push(['pollNow']);
      return Promise.resolve(state());
    },
    commit(choice) {
      calls.push(['commit', choice]);
      return Promise.resolve(state());
    },
    restart(choice) {
      calls.push(['restart', choice]);
      return Promise.resolve(state());
    },
    defer() {
      calls.push(['defer']);
      return Promise.resolve(state());
    },
    dispose() {
      calls.push(['dispose']);
      disposed = true;
      return Promise.resolve(state());
    },
    getState() {
      return state();
    },
    whenIdle() {
      return Promise.resolve(state());
    },
  };
  return {
    calls,
    coordinator,
    get options() {
      return options;
    },
    get disposed() {
      return disposed;
    },
    setCurrent(value) {
      current = value;
    },
    createCoordinator(input) {
      options = input;
      return coordinator;
    },
  };
}

function createAssetPipelineFixture({transactionStatus} = {}) {
  let options;
  let started = false;
  let disposed = false;
  const calls = [];
  const state = () => ({
    version: 1,
    started,
    disposed,
    ...(transactionStatus === undefined ? {} : {transaction: {status: transactionStatus}}),
  });
  const pipeline = {
    start(root, context) {
      started = true;
      calls.push(['start', root, context]);
      return Promise.resolve(state());
    },
    updateSource(context) {
      calls.push(['updateSource', context]);
      return Promise.resolve(state());
    },
    pollNow() {
      calls.push(['pollNow']);
      return Promise.resolve(state());
    },
    dispose() {
      disposed = true;
      calls.push(['dispose']);
      return Promise.resolve(state());
    },
    getState: state,
    whenIdle() {
      calls.push(['whenIdle']);
      return Promise.resolve(state());
    },
  };
  return {
    calls,
    pipeline,
    get options() {
      return options;
    },
    createAssetPipeline(input) {
      options = input;
      return pipeline;
    },
  };
}

function createShell({featureFlags = enabledFlags} = {}) {
  const document = createFakeDocument();
  const fixture = createCoordinatorFixture();
  const errors = [];
  const shell = createDsl4WebPreviewShell({
    featureFlags,
    environment: 'development',
    document,
    mount: document.body,
    protocolSession: {},
    sessionId: 'web-preview-test',
    sourceFrontend: {parse() {}},
    maxSourceBytes: 8192,
    createCoordinator: fixture.createCoordinator,
    onError: (error) => errors.push(error),
  });
  return {document, errors, fixture, shell};
}

test('keeps Web Preview unregistered and unread when its startup flag is OFF', () => {
  let factoryCalls = 0;
  const shell = createDsl4WebPreviewShell({
    featureFlags: {dsl4Runtime: true, dsl4AppShell: true},
    document: new Proxy({}, {get: () => assert.fail('document must not be read')}),
    mount: new Proxy({}, {get: () => assert.fail('mount must not be read')}),
    createCoordinator() {
      factoryCalls += 1;
      assert.fail('coordinator must not be created');
    },
    createAssetPipeline() {
      assert.fail('asset pipeline must not be created');
    },
  });
  assert.equal(shell.enabled, false);
  assert.equal(shell.element, null);
  assert.equal(factoryCalls, 0);
  assert.equal(shell.getSnapshot().enabled, false);
  assert.equal(Object.isFrozen(shell.featureFlags), true);
  assert.deepEqual(shell.dispose(), shell.getSnapshot());
});

test('requires the runtime and App Shell flags and remains development-only', () => {
  assert.throws(
    () => createDsl4WebPreviewShell({featureFlags: {dsl4WebPreviewAdapter: true}}),
    /requires dsl4Runtime and dsl4AppShell/u,
  );
  assert.throws(
    () =>
      createDsl4WebPreviewShell({
        featureFlags: enabledFlags,
        environment: 'production',
        document: {},
        mount: {},
        protocolSession: {},
        sessionId: 'test',
        sourceFrontend: {},
        maxSourceBytes: 1,
      }),
    /development/u,
  );
  assert.deepEqual(dsl4WebPreviewShellManifest, {
    formatVersion: 1,
    production: false,
    module: 'src/builder/dsl4-web-preview-shell.js',
    featureFlags: [
      'dsl4Runtime',
      'dsl4SourceIncludes',
      'dsl4AppShell',
      'dsl4WebPreviewAdapter',
      'dsl4WebPreviewAssetLiveReload',
      'dsl4PreviewReloadOverlay',
    ],
    fallbackCommands: [
      'tmpose-kamishibai preview-dsl4 --watch',
      'tmpose-kamishibai validate-dsl4',
      'tmpose-kamishibai build-dsl4',
    ],
  });
});

test('stabilizes included assets before allowing a Source Graph candidate to stage', async () => {
  const document = createFakeDocument();
  const source = createCoordinatorFixture();
  const assets = createAssetPipelineFixture({transactionStatus: 'ready'});
  const shell = createDsl4WebPreviewShell({
    featureFlags: includedAssetEnabledFlags,
    environment: 'development',
    document,
    mount: document.body,
    protocolSession: {},
    sessionId: 'included-asset-shell-test',
    sourceFrontend: {parse() {}},
    maxSourceBytes: 8192,
    maxSourceFiles: 8,
    maxTotalSourceBytes: 32 * 1024,
    maxIncludeDepth: 4,
    createCoordinator: source.createCoordinator,
    createAssetPipeline: assets.createAssetPipeline,
    assetPipelineOptions: {
      structuralFingerprint: sri('included-structure'),
      adapterOptions: {},
      prepareGeneration() {},
    },
  });
  const root = {kind: 'directory'};
  await source.options.onProjectRoot(root);
  const result = sourceResult(sri('included-source'));
  await source.options.beforeSourceStage(result);

  assert.deepEqual(
    assets.calls.map(([name]) => name),
    ['start'],
  );
  assert.equal(assets.calls[0][1], root);
  assert.equal(assets.calls[0][2].sourceResult, result);
  assert.equal(
    assets.calls.some(([name]) => name === 'updateSource'),
    false,
  );
  await shell.dispose();
});

test('requires and owns the browser asset pipeline only behind its startup flag', async () => {
  assert.throws(
    () =>
      createDsl4WebPreviewShell({
        featureFlags: assetEnabledFlags,
        environment: 'development',
        document: createFakeDocument(),
        mount: createFakeDocument().body,
        protocolSession: {},
        sessionId: 'missing-asset-options',
        sourceFrontend: {parse() {}},
        maxSourceBytes: 8192,
      }),
    /assetPipelineOptions/u,
  );

  const document = createFakeDocument();
  const source = createCoordinatorFixture();
  const assets = createAssetPipelineFixture();
  const structuralFingerprint = sri('structure');
  const shell = createDsl4WebPreviewShell({
    featureFlags: assetEnabledFlags,
    environment: 'development',
    document,
    mount: document.body,
    protocolSession: {},
    sessionId: 'asset-shell-test',
    sourceFrontend: {parse() {}},
    maxSourceBytes: 8192,
    createCoordinator: source.createCoordinator,
    createAssetPipeline: assets.createAssetPipeline,
    assetPipelineOptions: {
      structuralFingerprint,
      adapterOptions: {},
      prepareGeneration() {},
    },
  });
  const root = {kind: 'directory'};
  await shell.start(root);
  const result = sourceResult(sri('asset-source'));
  source.options.onSourceResult(result);
  await shell.whenIdle();
  assert.equal(assets.options.sessionId, 'asset-shell-test');
  assert.equal(assets.calls[0][0], 'start');
  assert.equal(assets.calls[0][1], root);
  assert.equal(assets.calls[0][2].sourceResult, result);
  assert.equal(assets.calls[0][2].structuralFingerprint, structuralFingerprint);
  assert.deepEqual(shell.getSnapshot().assetPipeline, {
    version: 1,
    started: true,
    disposed: false,
  });
  await shell.pollNow();
  assert.equal(
    assets.calls.some(([name]) => name === 'pollNow'),
    true,
  );
  await shell.dispose();
  assert.equal(
    assets.calls.some(([name]) => name === 'dispose'),
    true,
  );
});

test('connects the owned asset pipeline and camera layout bridge to the shared Web surface', async () => {
  const document = createFakeDocument();
  const source = createCoordinatorFixture();
  const assets = createAssetPipelineFixture();
  const shell = createDsl4WebPreviewShell({
    featureFlags: {
      ...assetEnabledFlags,
      dsl4PreviewReloadOverlay: true,
    },
    environment: 'development',
    document,
    mount: document.body,
    protocolSession: {},
    sessionId: 'composite-shell-test',
    sourceFrontend: {parse() {}},
    maxSourceBytes: 8192,
    createCoordinator: source.createCoordinator,
    createAssetPipeline: assets.createAssetPipeline,
    assetPipelineOptions: {
      structuralFingerprint: sri('composite-structure'),
      adapterOptions: {},
      prepareGeneration() {},
      restartGeneration() {},
    },
    previewViewport: {width: 800, height: 600},
  });

  assert.equal(typeof assets.options.reloadSurface.submitCandidate, 'function');
  await assets.options.onDiagnostic({
    code: 'K4-ASSET-MISSING',
    severity: 'error',
    message: 'Asset missing.',
  });
  await shell.whenIdle();
  assert.deepEqual(shell.getSnapshot().reloadOverlay.diagnosticChannels, ['asset']);

  const occupied = shell.getSnapshot().reloadOverlay.overlay.layout.layout.rect;
  shell.registerReservedRect('camera-controls', occupied);
  assert.equal(
    shell.getSnapshot().reloadOverlay.overlay.layout.layout.resolvedAnchor,
    'top-center',
  );
  shell.unregisterReservedRect('camera-controls');
  assert.equal(shell.getSnapshot().reloadOverlay.overlay.layout.layout.resolvedAnchor, 'top-right');
  await shell.dispose();
});

test('opens the picker directly from a button activation and renders watch status', async () => {
  const {document, fixture, shell} = createShell();
  const button = findById(shell.element, 'dsl4-web-preview-open-project');
  const status = findById(shell.element, 'dsl4-web-preview-watch-status');
  assert.equal(shell.element.parentNode, document.body);
  button.click();
  assert.deepEqual(fixture.calls, [['openProject']]);
  fixture.options.onSourceStatus({
    status: 'watching-visible',
    started: true,
    sourceDisplayName: 'story.kamishibai.yaml',
  });
  assert.equal(button.disabled, true);
  assert.match(status.textContent, /Watching/u);
  await shell.whenIdle();
});

test('maps staged sources and reload choices onto the existing accessible shell', async () => {
  const {fixture, shell} = createShell();
  const initialIntegrity = sri('initial');
  fixture.options.onSourceResult(sourceResult(initialIntegrity));
  fixture.setCurrent({integrity: initialIntegrity});
  fixture.options.onProtocolEvent({
    type: 'preview.source.staged',
    sourceIntegrity: initialIntegrity,
    status: 'active',
    candidate: null,
    current: {integrity: initialIntegrity},
    diagnostics: [],
  });
  assert.equal(shell.getSnapshot().preview.phase, 'running');
  assert.deepEqual(shell.getSnapshot().preview.counts, {scenes: 2, actions: 2, assets: 1});

  const candidateIntegrity = sri('candidate');
  fixture.options.onSourceResult(sourceResult(candidateIntegrity, {warnings: 1}));
  fixture.options.onProtocolEvent({
    type: 'preview.source.staged',
    sourceIntegrity: candidateIntegrity,
    status: 'pending',
    candidate: {
      id: 2,
      options: {
        storyStart: {enabled: true, reason: null},
        currentScene: {enabled: true, reason: null},
        currentAction: {enabled: false, reason: 'The current action changed.'},
      },
    },
    current: {integrity: initialIntegrity},
    diagnostics: [],
  });
  assert.equal(shell.getSnapshot().preview.phase, 'candidate');
  assert.equal(shell.getSnapshot().preview.warningCount, 1);
  findById(shell.element, 'dsl4-preview-reload-2').click();
  assert.deepEqual(fixture.calls.at(-1), ['commit', 'currentScene']);

  fixture.setCurrent({integrity: candidateIntegrity});
  fixture.options.onProtocolEvent({
    type: 'preview.source.committed',
    current: {integrity: candidateIntegrity},
  });
  assert.equal(shell.getSnapshot().preview.phase, 'running');
  assert.equal(shell.getSnapshot().preview.currentIntegrity, candidateIntegrity);
  await new Promise((resolve) => setImmediate(resolve));
});

test('auto-applies source updates through the shared non-blocking Web/CLI reload surface', async () => {
  const {document, fixture, shell} = createShell({
    featureFlags: {...enabledFlags, dsl4PreviewReloadOverlay: true},
  });
  const initialIntegrity = sri('overlay-initial');
  fixture.options.onSourceResult(sourceResult(initialIntegrity));
  fixture.setCurrent({integrity: initialIntegrity});
  fixture.options.onProtocolEvent({
    type: 'preview.source.staged',
    revision: 1,
    sourceIntegrity: initialIntegrity,
    status: 'active',
    candidate: null,
    current: {integrity: initialIntegrity},
    diagnostics: [],
  });

  const candidateIntegrity = sri('overlay-candidate');
  fixture.options.onSourceResult(sourceResult(candidateIntegrity));
  fixture.options.onProtocolEvent({
    type: 'preview.source.staged',
    revision: 2,
    sourceIntegrity: candidateIntegrity,
    status: 'pending',
    candidate: {
      id: 2,
      options: {
        storyStart: {enabled: true, reason: null},
        currentScene: {enabled: true, reason: null},
        currentAction: {enabled: false, reason: 'The current action is not replay-safe.'},
      },
    },
    current: {integrity: initialIntegrity},
    diagnostics: [],
  });
  await shell.whenIdle();

  assert.deepEqual(fixture.calls.at(-1), ['commit', 'currentScene']);
  assert.equal(shell.getSnapshot().preview.phase, 'running');
  assert.equal(shell.getSnapshot().reloadOverlay.overlay.policy.status, 'reloaded');
  assert.equal(shell.getSnapshot().reloadOverlay.overlay.policy.preference, 'action');
  assert.equal(shell.getSnapshot().reloadOverlay.overlay.policy.lastSuccess.actualAnchor, 'scene');
  const statusButton = findById(shell.element, 'dsl4-preview-reload-status-button');
  assert.equal(statusButton.getAttribute('data-reload-state'), 'reloaded');
  assert.equal(document.activeElement, null);

  statusButton.click();
  await shell.whenIdle();
  findById(shell.element, 'dsl4-preview-reload-position-story').click();
  await shell.whenIdle();
  findById(shell.element, 'dsl4-preview-reload-scope-reload-once').click();
  await shell.whenIdle();
  assert.deepEqual(fixture.calls.at(-1), ['restart', 'storyStart']);

  const assetOperations = [];
  await shell.submitReloadCandidate({
    channel: 'asset',
    channelRevision: 1,
    availability: {
      story: {available: true, reason: null},
      scene: {available: true, reason: null},
      action: {available: true, replaySafe: true, reason: null},
    },
    changedIds: ['Backdrop'],
    initiatingInputId: null,
    apply: (request) => assetOperations.push(['apply', request.actualAnchor]),
    restart: (request) => assetOperations.push(['restart', request.actualAnchor]),
  });
  assert.deepEqual(assetOperations, [['apply', 'action']]);
  assert.equal(shell.getSnapshot().reloadOverlay.globalRevision, 2);
  await shell.dispose();
});

test('shows recoverable diagnostics and explicit CLI fallback without retaining source text', async () => {
  const {fixture, shell} = createShell();
  fixture.options.onSourceDiagnostic({
    code: 'K4-WEB-PREVIEW-UNSUPPORTED',
    severity: 'error',
    message: 'Folder access is unsupported.',
  });
  const fallback = findById(shell.element, 'dsl4-web-preview-fallback');
  assert.equal(fallback.hidden, false);
  assert.match(fallback.textContent, /preview-dsl4 --watch/u);
  assert.match(fallback.textContent, /validate-dsl4/u);
  assert.equal(shell.getSnapshot().diagnosticCode, 'K4-WEB-PREVIEW-UNSUPPORTED');

  fixture.options.onSourceDiagnostic(null);
  assert.equal(fallback.hidden, true);
  fixture.options.onSourceDiagnostic({
    code: 'K4-SOURCE-MISSING',
    severity: 'error',
    message: 'Source is temporarily missing.',
  });
  assert.equal(shell.getSnapshot().preview.validationStatus, 'missing');
  assert.equal(JSON.stringify(shell.getSnapshot()).includes('must not escape'), false);
  await shell.dispose();
  assert.equal(fixture.disposed, true);
  assert.equal(shell.element.parentNode, null);
});
