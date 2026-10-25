import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test, vi} from 'vitest';
import {createDsl4WebPreviewShell} from '../src/builder/dsl4-web-preview-shell.js';
import {createDsl4PreviewReloadSurface} from '../src/builder/dsl4-preview-reload-surface.js';
import {createDsl4BrowserAssetReloadPipeline} from '../src/dsl4/browser-asset-reload-pipeline.js';
import {createDsl4SourceFrontend} from '../src/dsl4/source-frontend.js';
import {dsl4AssetReloadProtocolCapabilities} from '../src/dsl4/asset-reload-protocol.js';
import {createDsl4PreviewReloadPolicy} from '../src/dsl4/preview-reload-policy.js';
import {Dsl4PreviewReloadDisposedError} from '../src/dsl4/preview-reload-cancellation.js';
import {createFakeDocument, requireById} from './helpers/fake-dom.ts';
import {deferred, waitUntil, withDeadline} from './helpers/async-test-helpers.ts';
import {requireRecord} from './helpers/require-value.ts';

const flags = {
  dsl4Runtime: true,
  dsl4AppShell: true,
  dsl4WebPreviewAdapter: true,
  dsl4WebPreviewAssetLiveReload: true,
  dsl4PreviewReloadOverlay: true,
};
const sri = (value: string) => `sha256-${createHash('sha256').update(value).digest('base64')}`;
function assetOptions() {
  return {
    structuralFingerprint: sri('structure'),
    adapterOptions: {},
    prepareGeneration() {},
    restartGeneration() {},
  };
}
function coordinatorFixture() {
  return {
    start: vi.fn<(...args: unknown[]) => unknown>(),
    openProject() {},
    restart() {},
    pollNow() {},
    commit() {},
    defer() {},
    dispose: vi.fn(),
    getState: () => ({source: {started: false}, protocol: {}}),
    whenIdle: async () => {},
  };
}
function stubPipeline() {
  return {
    start() {},
    updateSource() {},
    pollNow() {},
    dispose() {},
    getState: () => ({}),
    whenIdle: async () => {},
  };
}
function createShell(extra: Record<string, unknown> = {}) {
  const document = createFakeDocument();
  const errors: unknown[] = [];
  const coordinator = coordinatorFixture();
  const shell = createDsl4WebPreviewShell({
    environment: 'development',
    document,
    mount: document.body,
    featureFlags: flags,
    protocolSession: {},
    sessionId: 'shutdown-regression',
    sourceFrontend: {parse() {}},
    maxSourceBytes: 8192,
    createCoordinator: () => coordinator,
    createAssetPipeline: stubPipeline,
    assetPipelineOptions: assetOptions(),
    onError: (error: unknown) => errors.push(error),
    ...extra,
  });
  assert.ok('whenIdle' in shell);
  return {shell, document, errors, coordinator};
}
interface RootHooks {
  onProjectRoot(root: unknown): Promise<unknown>;
}
function rootAwareShell(observer?: (root: unknown) => unknown) {
  let hooks!: RootHooks;
  const coordinator = coordinatorFixture();
  const afterRoot = vi.fn(() => 'started');
  // Match the production coordinator's source adapter: root publication belongs to start.
  coordinator.start.mockImplementation(async (root) => {
    await hooks.onProjectRoot(root);
    return afterRoot();
  });
  return {
    ...createShell({
      createCoordinator(options: RootHooks) {
        hooks = options;
        return coordinator;
      },
      ...(observer ? {onProjectRoot: observer} : {}),
    }),
    afterRoot,
  };
}
function outcome(operation: unknown) {
  return Promise.resolve(operation).then(
    (value) => ({ok: true as const, value}),
    (error) => ({ok: false as const, error}),
  );
}

test('start immediately followed by dispose has no detached root rejection', async () => {
  const {shell, afterRoot, errors} = rootAwareShell();
  const starting = outcome(shell.start({kind: 'directory'}));
  await shell.dispose();
  const result = await starting;
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(String(result.error), /disposed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(afterRoot.mock.calls.length, 0);
  assert.deepEqual(errors, []);
  assert.equal(shell.hasPendingCleanup(), false);
  // Vitest fails this regression if an independent root promise rejects unhandled.
});

for (const rejected of [false, true]) {
  test(`root observer ${rejected ? 'rejection' : 'completion'} after dispose stays on start's promise`, async () => {
    const gate = deferred();
    const observer = vi.fn(() => gate.promise);
    const {shell, errors, afterRoot} = rootAwareShell(observer);
    const starting = outcome(shell.start({kind: 'directory'}));
    await waitUntil(() => observer.mock.calls.length > 0);
    await shell.dispose();
    const failure = new Error('root preparation failed');
    if (rejected) gate.reject(failure);
    else gate.resolve();
    const result = await starting;
    assert.equal(result.ok, false);
    if (!result.ok) {
      if (rejected) assert.strictEqual(result.error, failure);
      else assert.match(String(result.error), /disposed/);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(observer.mock.calls.length, 1, 'the shell must not publish the root twice');
    assert.equal(afterRoot.mock.calls.length, 0);
    assert.deepEqual(errors, []);
    assert.equal(shell.getDistributionBuildState().enabled, false);
    assert.equal(shell.hasPendingCleanup(), false);
  });
}

test('dispose requested by a root observer does not continue source startup', async () => {
  const observer = vi.fn(() => {
    void setup.shell.dispose();
  });
  const setup = rootAwareShell(observer);
  const starting = outcome(setup.shell.start({kind: 'directory'}));
  const result = await starting;
  await setup.shell.dispose();
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(String(result.error), /disposed/);
  assert.equal(observer.mock.calls.length, 1);
  assert.equal(setup.afterRoot.mock.calls.length, 0);
  assert.deepEqual(setup.errors, []);
});

test('root preparation failure is returned to the start caller', async () => {
  const failure = new Error('root preparation failed');
  const observer = vi.fn(() => {
    throw failure;
  });
  const {shell, errors, afterRoot} = rootAwareShell(observer);
  await assert.rejects(
    Promise.resolve(shell.start({kind: 'directory'})),
    (error) => error === failure,
  );
  await shell.dispose();
  assert.equal(observer.mock.calls.length, 1);
  assert.equal(afterRoot.mock.calls.length, 0);
  assert.deepEqual(errors, []);
});

test('normal startup publishes the root once and awaits its observer', async () => {
  const gate = deferred();
  const observer = vi.fn(() => gate.promise);
  const {shell, errors, afterRoot} = rootAwareShell(observer);
  const starting = shell.start({kind: 'directory'});
  await waitUntil(() => observer.mock.calls.length > 0);
  assert.equal(afterRoot.mock.calls.length, 0);
  gate.resolve();
  assert.equal(await starting, 'started');
  assert.equal(observer.mock.calls.length, 1);
  assert.equal(afterRoot.mock.calls.length, 1);
  await shell.dispose();
  assert.deepEqual(errors, []);
});

function clock() {
  let time = 0;
  let timer = 0;
  return {
    now: () => time,
    async sleep(delay: number) {
      time += delay;
    },
    setTimeout() {
      return ++timer;
    },
    clearTimeout() {},
  };
}
function assetProject() {
  const bytes = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg"><text>one</text></svg>',
  );
  return {
    kind: 'directory',
    queryPermission: async () => 'granted',
    getDirectoryHandle: async () => {
      throw Object.assign(new Error('missing'), {name: 'NotFoundError'});
    },
    async getFileHandle(name: string) {
      assert.equal(name, 'picture.svg');
      return {
        kind: 'file',
        async getFile() {
          return {size: bytes.length, arrayBuffer: async () => bytes.slice().buffer};
        },
      };
    },
  };
}

for (const phase of ['idle', 'active', 'failed-surface'] as const) {
  test(`real asset pipeline and surface close in parallel from ${phase} without spurious errors`, async () => {
    let source!: RootHooks & {onSourceResult(result: unknown): unknown};
    const watchStates: unknown[] = [];
    const released = vi.fn();
    let disposePipeline!: ReturnType<typeof vi.fn<() => unknown>>;
    const {shell, document, errors} = createShell({
      createCoordinator(options: typeof source) {
        source = options;
        const coordinator = coordinatorFixture();
        coordinator.start.mockImplementation((root) => options.onProjectRoot(root));
        return coordinator;
      },
      createAssetPipeline(options: Parameters<typeof createDsl4BrowserAssetReloadPipeline>[0]) {
        const pipeline = createDsl4BrowserAssetReloadPipeline(options);
        disposePipeline = vi.fn(() => pipeline.dispose());
        return {...pipeline, dispose: disposePipeline};
      },
      assetPipelineOptions: {
        ...assetOptions(),
        negotiatedCapabilities: dsl4AssetReloadProtocolCapabilities,
        adapterOptions: {
          subtleCrypto: webcrypto.subtle,
          inspectImage: () => ({width: 1, height: 1}),
          inspectAudio: () => ({durationSeconds: 1, channels: 1, sampleRate: 48000}),
          watchOptions: {clock: clock()},
        },
        prepareGeneration: () => ({
          activate: () => ({actualAnchor: 'scene'}),
          rollback() {},
          release: released,
        }),
        onWatchStatus: (state: unknown) =>
          watchStates.push(requireRecord(state, 'watch state').status),
      },
    });
    if (phase === 'active') {
      const schema = JSON.parse(
        await readFile(new URL('../schema/dsl-4.schema.json', import.meta.url), 'utf8'),
      );
      const frontend = createDsl4SourceFrontend(schema);
      const parsed = frontend.parse(
        "kamishibai: '4.0'\nassets:\n  Picture:\n    kind: backdrop\n    file: picture.svg\nscenes:\n  opening:\n    - stage: Picture\n",
        {sourceId: 'shutdown-regression'},
      );
      assert.equal(parsed.ok, true);
      await shell.start(assetProject());
      // The injected coordinator publishes source results while the real asset path remains intact.
      await source.onSourceResult({...parsed, sourceSnapshot: {integrity: sri('source')}});
      await shell.whenIdle();
      const pipeline = requireRecord(shell.getSnapshot().assetPipeline, 'asset pipeline');
      assert.equal(
        requireRecord(pipeline.transaction, 'asset transaction').generation,
        1,
        JSON.stringify({pipeline, errors: errors.map(String)}),
      );
      assert.ok(Number(requireRecord(pipeline.adapter, 'asset adapter').providerCount) > 0);
    }
    const overlay = requireById(document.body, 'dsl4-preview-reload-overlay');
    const detach = vi.spyOn(overlay, 'remove');
    if (phase === 'failed-surface')
      detach.mockImplementationOnce(() => {
        throw new Error('surface detach failed');
      });
    const closing = shell.dispose();
    assert.strictEqual(shell.dispose(), closing);
    if (phase === 'failed-surface') {
      await assert.rejects(closing, /cleanup failed/);
      assert.equal(shell.hasPendingCleanup(), true);
      await shell.dispose();
      assert.equal(detach.mock.calls.length, 2);
    } else await closing;
    assert.deepEqual(errors, []);
    assert.ok(watchStates.includes('disposed'), 'the real watch sends its terminal notification');
    assert.equal(
      disposePipeline.mock.calls.length,
      1,
      'successful pipeline disposal is not repeated',
    );
    assert.equal(released.mock.calls.length, phase === 'active' ? 1 : 0);
    const pipeline = requireRecord(shell.getSnapshot().assetPipeline, 'asset pipeline');
    assert.equal(requireRecord(pipeline.adapter, 'asset adapter').providerCount, 0);
    assert.deepEqual(
      requireRecord(shell.getSnapshot().reloadOverlay, 'reload surface').watchChannels,
      [],
    );
    assert.equal(shell.hasPendingCleanup(), false);
    assert.equal(document.body.children.length, 0);
    await shell.dispose();
    assert.equal(disposePipeline.mock.calls.length, 1);
  });
}

interface AssetBridge {
  submitCandidate(candidate: unknown): unknown;
  setWatchState(channel: string, state: unknown): unknown;
  setDiagnostic(channel: string, diagnostic: unknown): unknown;
}

async function assetSourceResult(sourceId: string) {
  const schema = JSON.parse(
    await readFile(new URL('../schema/dsl-4.schema.json', import.meta.url), 'utf8'),
  );
  const parsed = createDsl4SourceFrontend(schema).parse(
    "kamishibai: '4.0'\nassets:\n  Picture:\n    kind: backdrop\n    file: picture.svg\nscenes:\n  opening:\n    - stage: Picture\n",
    {sourceId},
  );
  assert.equal(parsed.ok, true);
  return {...parsed, sourceSnapshot: {integrity: sri(sourceId)}};
}

for (const phase of ['synchronous', 'microtasks', 'task', 'apply-started'] as const) {
  test(`real ${phase} staged notification disposes a transferred candidate without reporting cancellation`, async () => {
    let source!: RootHooks & {onSourceResult(result: unknown): unknown};
    let closing: Promise<unknown> | undefined;
    const closingStarted = deferred();
    const applyEntered = deferred();
    const events: unknown[] = [];
    const activate = vi.fn(() => ({actualAnchor: 'scene'}));
    const rollback = vi.fn();
    const release = vi.fn();
    const {shell, document, errors} = createShell({
      createCoordinator(options: typeof source) {
        source = options;
        const coordinator = coordinatorFixture();
        coordinator.start.mockImplementation((root) => options.onProjectRoot(root));
        return coordinator;
      },
      createAssetPipeline: createDsl4BrowserAssetReloadPipeline,
      ...(phase === 'apply-started'
        ? {
            createReloadSurface(options: Parameters<typeof createDsl4PreviewReloadSurface>[0]) {
              const surface = createDsl4PreviewReloadSurface(options);
              return {
                ...surface,
                submitCandidate(input: unknown) {
                  const candidate = requireRecord(input, 'reload candidate');
                  const apply = candidate.apply;
                  assert.equal(typeof apply, 'function');
                  return surface.submitCandidate({
                    ...candidate,
                    apply(request: unknown) {
                      applyEntered.resolve();
                      return (apply as (request: unknown) => unknown)(request);
                    },
                  });
                },
              };
            },
          }
        : {}),
      assetPipelineOptions: {
        ...assetOptions(),
        negotiatedCapabilities: dsl4AssetReloadProtocolCapabilities,
        adapterOptions: {
          subtleCrypto: webcrypto.subtle,
          inspectImage: () => ({width: 1, height: 1}),
          inspectAudio: () => ({durationSeconds: 1, channels: 1, sampleRate: 48000}),
          watchOptions: {clock: clock()},
        },
        prepareGeneration: () => ({activate, rollback, release}),
        async onEvent(event: unknown) {
          const type = requireRecord(event, 'asset event').type;
          events.push(type);
          // The real pipeline has already handed the candidate to the surface at this point.
          if (type === 'preview.asset.staged') {
            if (phase === 'microtasks')
              for (let index = 0; index < 10; index++) await Promise.resolve();
            if (phase === 'task') await new Promise((resolve) => setImmediate(resolve));
            if (phase === 'apply-started') await applyEntered.promise;
            closing = shell.dispose();
            assert.strictEqual(shell.dispose(), closing);
            closingStarted.resolve();
          }
        },
      },
    });
    const result = await assetSourceResult(`staged-shutdown-${phase}`);
    await shell.start(assetProject());
    await source.onSourceResult(result);
    await withDeadline(closingStarted.promise, 'staged observer disposal', 5000);
    assert.ok(closing);
    await withDeadline(closing, 'staged disposal completion', 5000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(errors, []);
    assert.equal(activate.mock.calls.length, 0);
    assert.equal(rollback.mock.calls.length, 1);
    assert.equal(release.mock.calls.length, 1);
    assert.ok(events.includes('preview.asset.deferred'));
    assert.equal(events.includes('preview.asset.commit-started'), false);
    const snapshot = shell.getSnapshot();
    const pipeline = requireRecord(snapshot.assetPipeline, 'asset pipeline');
    assert.equal(requireRecord(pipeline.adapter, 'asset adapter').providerCount, 0);
    const transaction = requireRecord(pipeline.transaction, 'asset transaction');
    assert.equal(transaction.generation, 0);
    assert.equal(transaction.pendingReleaseCount, 0);
    const surface = requireRecord(snapshot.reloadOverlay, 'surface');
    assert.equal(surface.globalRevision, 1, 'the candidate was transferred before shutdown');
    assert.equal(surface.disposed, true);
    assert.deepEqual(surface.candidateChannels, []);
    assert.equal(shell.hasPendingCleanup(), false);
    assert.equal(document.body.children.length, 0);
    assert.throws(() => shell.submitReloadCandidate({}), /disposed/);
  });
}

test('real activation failure stays visible when disposal starts from commit notification', async () => {
  let source!: RootHooks & {onSourceResult(result: unknown): unknown};
  let closing: Promise<unknown> | undefined;
  const closingStarted = deferred();
  const events: unknown[] = [];
  const rollback = vi.fn();
  const release = vi.fn();
  const failure = new Error('genuine activation failure');
  const activate = vi.fn(async () => {
    await Promise.resolve();
    throw failure;
  });
  const {shell, document, errors} = createShell({
    createCoordinator(options: typeof source) {
      source = options;
      const coordinator = coordinatorFixture();
      coordinator.start.mockImplementation((root) => options.onProjectRoot(root));
      return coordinator;
    },
    createAssetPipeline: createDsl4BrowserAssetReloadPipeline,
    assetPipelineOptions: {
      ...assetOptions(),
      negotiatedCapabilities: dsl4AssetReloadProtocolCapabilities,
      adapterOptions: {
        subtleCrypto: webcrypto.subtle,
        inspectImage: () => ({width: 1, height: 1}),
        inspectAudio: () => ({durationSeconds: 1, channels: 1, sampleRate: 48000}),
        watchOptions: {clock: clock()},
      },
      prepareGeneration: () => ({activate, rollback, release}),
      onEvent(event: unknown) {
        const type = requireRecord(event, 'asset event').type;
        events.push(type);
        if (type === 'preview.asset.commit-started') {
          closing = shell.dispose();
          closingStarted.resolve();
        }
      },
    },
  });
  const result = await assetSourceResult('activation-failure-shutdown');
  await shell.start(assetProject());
  await source.onSourceResult(result);
  await withDeadline(closingStarted.promise, 'commit observer disposal', 5000);
  assert.ok(closing);
  await withDeadline(closing, 'activation failure disposal', 5000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /asset generation commit was not acknowledged/);
  assert.equal(errors[0] instanceof Dsl4PreviewReloadDisposedError, false);
  assert.equal(activate.mock.calls.length, 1);
  assert.equal(rollback.mock.calls.length, 1);
  assert.equal(release.mock.calls.length, 1);
  assert.ok(events.includes('preview.asset.commit-failed'));
  const pipeline = requireRecord(shell.getSnapshot().assetPipeline, 'asset pipeline');
  assert.equal(requireRecord(pipeline.adapter, 'asset adapter').providerCount, 0);
  assert.equal(shell.hasPendingCleanup(), false);
  assert.equal(document.body.children.length, 0);
});

for (const failure of [
  null,
  new Error('apply failed'),
  new TypeError('reload policy is disposed'),
  Object.assign(new Error('driver aborted'), {name: 'AbortError'}),
]) {
  test(`transferred active driver ${failure ? failure.name : 'completion'} during disposal keeps genuine failures distinct`, async () => {
    let bridge!: AssetBridge;
    let report!: (error: unknown) => unknown;
    const driver = deferred();
    const apply = vi.fn(() => driver.promise);
    const {shell, errors} = createShell({
      createAssetPipeline(input: {
        reloadSurface: AssetBridge;
        onError: (error: unknown) => unknown;
      }) {
        bridge = input.reloadSurface;
        report = input.onError;
        return stubPipeline();
      },
    });
    const submitting = Promise.resolve(
      bridge.submitCandidate({
        channel: 'asset',
        channelRevision: 1,
        changedIds: ['Picture'],
        availability: {
          story: {available: true, reason: null},
          scene: {available: true, reason: null},
          action: {available: true, replaySafe: true, reason: null},
        },
        initiatingInputId: null,
        apply,
        restart() {},
      }),
    ).catch(report);
    await waitUntil(() => apply.mock.calls.length === 1);
    const closing = shell.dispose();
    assert.strictEqual(shell.dispose(), closing);
    if (failure) driver.reject(failure);
    else driver.resolve();
    await Promise.all([submitting, closing]);
    assert.deepEqual(errors, failure ? [failure] : []);
    assert.equal(shell.hasPendingCleanup(), false);
    const state = requireRecord(shell.getSnapshot().reloadOverlay, 'surface');
    assert.equal(state.disposed, true);
    const policy = requireRecord(requireRecord(state.overlay, 'overlay').policy, 'policy');
    assert.equal(policy.status, 'disposed');
    assert.equal(policy.lastSuccess, null);
  });
}

test('borrowed bridge preserves a closed child error while the parent remains active', async () => {
  let bridge!: AssetBridge;
  let surface!: ReturnType<typeof createDsl4PreviewReloadSurface>;
  const {shell, errors} = createShell({
    createReloadSurface(options: Parameters<typeof createDsl4PreviewReloadSurface>[0]) {
      surface = createDsl4PreviewReloadSurface(options);
      return surface;
    },
    createAssetPipeline(input: {reloadSurface: AssetBridge}) {
      bridge = input.reloadSurface;
      return stubPipeline();
    },
  });
  await surface.dispose();
  await assert.rejects(Promise.resolve(bridge.submitCandidate({})), Dsl4PreviewReloadDisposedError);
  assert.equal(shell.getSnapshot().disposed, false);
  await shell.dispose();
  assert.deepEqual(errors, []);
  assert.equal(shell.hasPendingCleanup(), false);
});

test('invalid driver acknowledgement remains a validation failure when policy disposal overlaps', async () => {
  const driver = deferred<unknown>();
  const apply = vi.fn(() => driver.promise);
  const policy = createDsl4PreviewReloadPolicy({
    applyGeneration: apply,
    restartGeneration() {},
  });
  const submitting = outcome(
    policy.submitCandidate({
      revision: 1,
      availability: {
        story: {available: true, reason: null},
        scene: {available: true, reason: null},
        action: {available: true, replaySafe: true, reason: null},
      },
      summary: {category: 'asset', changedIds: []},
    }),
  );
  await waitUntil(() => apply.mock.calls.length === 1);
  const closing = policy.dispose();
  driver.resolve({revision: 999, actualAnchor: 'action', fallbackReason: null});
  const result = await submitting;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error instanceof TypeError);
    assert.equal(result.error instanceof Dsl4PreviewReloadDisposedError, false);
  }
  await closing;
  assert.equal(policy.getState().lastSuccess, null);
  assert.equal(policy.hasPendingCleanup(), false);
});

test('asset notification bridge forwards active calls, closes on failed disposal, and preserves genuine cleanup errors', async () => {
  let bridge!: AssetBridge;
  let pipelineError!: (error: unknown) => unknown;
  const surface = {
    setVisible() {},
    submitCandidate: vi.fn(),
    setDiagnostic: vi.fn(),
    setWatchState: vi.fn(),
    acknowledgePreviewInput() {},
    registerReservedRect() {},
    updateReservedRect() {},
    unregisterReservedRect() {},
    updateViewport() {},
    dispose: vi.fn(),
    getSnapshot: () => ({}),
    whenIdle: async () => {},
  };
  const failure = new Error('genuine cleanup failure');
  const dispose = vi.fn(() => {
    bridge.submitCandidate({afterClose: true});
    bridge.setDiagnostic('asset', null);
    bridge.setWatchState('asset', 'disconnected');
    if (dispose.mock.calls.length === 1) {
      pipelineError(failure);
      throw failure;
    }
  });
  const {shell, errors} = createShell({
    createReloadSurface: () => surface,
    createAssetPipeline(input: {reloadSurface: AssetBridge; onError: (error: unknown) => unknown}) {
      bridge = input.reloadSurface;
      pipelineError = input.onError;
      return {...stubPipeline(), dispose};
    },
  });
  const candidate = {revision: 1};
  const diagnostic = {code: 'test', message: 'diagnostic'};
  await bridge.submitCandidate(candidate);
  await bridge.setDiagnostic('asset', diagnostic);
  await bridge.setWatchState('asset', 'watching');
  assert.deepEqual(surface.submitCandidate.mock.calls, [[candidate]]);
  assert.deepEqual(surface.setDiagnostic.mock.calls, [['asset', diagnostic]]);
  assert.deepEqual(surface.setWatchState.mock.calls, [['asset', 'watching']]);
  await assert.rejects(shell.dispose(), /cleanup failed/);
  assert.equal(shell.hasPendingCleanup(), true);
  assert.deepEqual(errors, [failure], 'genuine cleanup diagnostics must not be suppressed');
  assert.throws(() => shell.setReloadWatchState('asset', 'watching'), /disposed/);
  await bridge.submitCandidate({late: true});
  await bridge.setDiagnostic('asset', null);
  await bridge.setWatchState('asset', 'disconnected');
  await shell.dispose();
  assert.equal(dispose.mock.calls.length, 2);
  assert.equal(surface.dispose.mock.calls.length, 1);
  assert.equal(surface.submitCandidate.mock.calls.length, 1);
  assert.equal(surface.setDiagnostic.mock.calls.length, 1);
  assert.equal(surface.setWatchState.mock.calls.length, 1);
  assert.equal(shell.hasPendingCleanup(), false);
});
