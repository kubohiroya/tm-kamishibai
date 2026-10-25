import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test, vi} from 'vitest';
import {
  createDsl4DevelopmentPreviewShell,
  createDsl4CliPreviewShell,
} from '../src/builder/dsl4-preview-shell.js';
import {createDsl4WebPreviewShell} from '../src/builder/dsl4-web-preview-shell.js';
import {createDsl4PreviewReloadSurface} from '../src/builder/dsl4-preview-reload-surface.js';
import {createDsl4PreviewReloadOverlay} from '../src/builder/dsl4-preview-reload-overlay.js';
import {createDsl4PreviewReloadPolicy} from '../src/dsl4/preview-reload-policy.js';
import {createDsl4PreviewLayoutCoordinator} from '../src/dsl4/preview-layout-coordinator.js';
import {
  getDsl4CreationCleanup,
  Dsl4CreationFailure,
  createDsl4CreationCleanup,
} from '../src/dsl4/creation-cleanup.js';
import {createFakeDocument, requireById, requireFakeElement} from './helpers/fake-dom.ts';
import {deferred, waitUntil, withDeadline} from './helpers/async-test-helpers.ts';

const availability = {
  story: {available: true, reason: null},
  scene: {available: true, reason: null},
  action: {available: true, replaySafe: true, reason: null},
};
const candidate = (revision: number) => ({
  revision,
  availability,
  summary: {category: 'source', changedIds: []},
});
const ack = (request: Readonly<Record<string, unknown>>) => ({
  revision: request.revision,
  actualAnchor: request.actualAnchor,
  fallbackReason: request.fallbackReason,
});
const flags = {
  dsl4Runtime: true,
  dsl4AppShell: true,
  dsl4WebPreviewAdapter: true,
  dsl4PreviewReloadOverlay: true,
};
const sri = (value: string) => `sha256-${createHash('sha256').update(value).digest('base64')}`;
function failureFrom(operation: () => unknown) {
  try {
    operation();
  } catch (error) {
    const cleanup = getDsl4CreationCleanup(error);
    assert.ok(cleanup, 'creation failure must retain cleanup ownership');
    return cleanup;
  }
  assert.fail('expected creation failure');
}
function makePolicy(overrides: Partial<Parameters<typeof createDsl4PreviewReloadPolicy>[0]> = {}) {
  return createDsl4PreviewReloadPolicy({
    applyGeneration: ack,
    restartGeneration: ack,
    ...overrides,
  });
}
function reloadChild(dispose: () => unknown = () => {}) {
  return {
    dispose,
    hasPendingCleanup: () => false,
    getSnapshot: () => ({}),
    whenIdle: async () => {},
    setVisible: vi.fn(),
    submitCandidate: vi.fn(),
    setDiagnostic: vi.fn(),
    setWatchState: vi.fn(),
    acknowledgePreviewInput: vi.fn(),
    registerReservedRect: vi.fn(),
    updateReservedRect: vi.fn(),
    unregisterReservedRect: vi.fn(),
    updateViewport: vi.fn(),
  };
}
function coordinatorChild(dispose: () => unknown = () => {}) {
  const state = () => ({source: {started: false}, protocol: {pendingStages: 0, candidate: null}});
  return {
    dispose,
    hasPendingCleanup: () => false,
    getState: state,
    whenIdle: async () => {},
    openProject: vi.fn(),
    start: vi.fn(),
    restart: vi.fn(),
    pollNow: vi.fn(),
    commit: vi.fn(),
    defer: vi.fn(),
  };
}
function webSetup(extra: Record<string, unknown> = {}) {
  const document = createFakeDocument();
  const coordinator = coordinatorChild();
  const shell = createDsl4WebPreviewShell({
    featureFlags: flags,
    environment: 'development',
    document,
    mount: document.body,
    protocolSession: {},
    sessionId: 'cleanup-owner-test',
    sourceFrontend: {parse() {}},
    maxSourceBytes: 8192,
    createCoordinator: () => coordinator,
    ...extra,
  });
  assert.ok('whenIdle' in shell);
  return {document, coordinator, shell};
}

test('policy retains timer cleanup after synchronous clear failure and reentry', async () => {
  let callback = () => {};
  const clears = vi.fn(() => {
    if (clears.mock.calls.length === 1) throw new Error('clear failed');
  });
  const policy = makePolicy({
    clock: {
      now: () => 0,
      setTimeout: (run) => {
        callback = run;
        return 1;
      },
      clearTimeout: clears,
    },
  });
  await policy.submitCandidate(candidate(1));
  await policy.acknowledge({explicit: true});
  let reentered: unknown;
  clears.mockImplementationOnce(() => {
    reentered = policy.dispose();
    throw new Error('clear failed');
  });
  const attempt = policy.dispose();
  assert.strictEqual(policy.dispose(), attempt);
  await assert.rejects(attempt, /cleanup failed/);
  assert.strictEqual(reentered, attempt);
  assert.equal(policy.hasPendingCleanup(), true);
  assert.throws(() => policy.submitCandidate(candidate(2)), /disposed/);
  await policy.dispose();
  assert.equal(clears.mock.calls.length, 2);
  assert.equal(policy.hasPendingCleanup(), false);
  callback();
  assert.equal(policy.getState().status, 'disposed');
  assert.equal(policy.getState().lastSuccess, null);
});

for (const observerKind of ['onState', 'subscriber'] as const) {
  test(`policy ${observerKind} can await disposal without a queue deadlock`, async () => {
    const policy = makePolicy();
    const observer = async () => {
      await policy.dispose();
    };
    if (observerKind === 'subscriber') policy.subscribe(observer);
    // Install onState on a separate instance because it is fixed at creation.
    const selected =
      observerKind === 'onState'
        ? makePolicy({
            onState: async (state) => {
              if (state.status === 'applying') await selected.dispose();
            },
          })
        : policy;
    const operation = selected.submitCandidate(candidate(1));
    await assert.rejects(withDeadline(operation, 'notification disposal', 1000), /disposed/);
    await selected.dispose();
    assert.equal(selected.hasPendingCleanup(), false);
  });
}

for (const rejectLate of [false, true]) {
  test(`policy keeps closed state after a late driver ${rejectLate ? 'rejection' : 'ack'}`, async () => {
    const driver = deferred<unknown>();
    const apply = vi.fn(() => driver.promise);
    const policy = makePolicy({applyGeneration: apply});
    const first = policy.submitCandidate(candidate(1));
    const firstRejected = assert.rejects(first, /disposed|late failure/);
    await waitUntil(() => apply.mock.calls.length === 1);
    const queued = policy.submitCandidate(candidate(2));
    const queuedRejected = assert.rejects(queued, /disposed/);
    const disposal = policy.dispose();
    if (rejectLate) driver.reject(new Error('late failure'));
    else driver.resolve({revision: 1, actualAnchor: 'action', fallbackReason: null});
    await Promise.all([firstRejected, queuedRejected, disposal]);
    assert.equal(apply.mock.calls.length, 1);
    assert.equal(policy.getState().currentGeneration, null);
    assert.equal(policy.getState().diagnostic, null);
    assert.equal(policy.getState().latestCandidate, null);
    assert.equal(policy.getState().status, 'disposed');
  });
}

for (const asynchronous of [false, true]) {
  test(`overlay retries independent ${asynchronous ? 'async' : 'sync'} subscription and toolbar failures`, async () => {
    const document = createFakeDocument();
    const policy = makePolicy();
    const releases = vi.fn(() => {});
    const releaseToolbar = vi.fn(() => {});
    const calls: string[] = [];
    const fail = () => {
      throw new Error('release failed');
    };
    if (asynchronous) {
      releases.mockImplementationOnce(async () => {
        throw new Error('release failed');
      });
      releaseToolbar.mockImplementationOnce(async () => {
        throw new Error('release failed');
      });
    } else {
      releases.mockImplementationOnce(fail);
      releaseToolbar.mockImplementationOnce(fail);
    }
    const overlay = createDsl4PreviewReloadOverlay({
      surface: 'web',
      document,
      mount: document.body,
      layoutCoordinator: createDsl4PreviewLayoutCoordinator({viewport: {width: 800, height: 600}}),
      policy: {
        ...policy,
        subscribe(observer) {
          const unsubscribe = policy.subscribe(observer);
          return () => {
            const released = releases();
            if (asynchronous) return Promise.resolve(released).then(unsubscribe);
            return unsubscribe();
          };
        },
      },
      stageControls: {
        addButton() {
          return {
            dispose: releaseToolbar,
            update() {},
            focus() {
              calls.push('focus');
            },
          };
        },
      },
    });
    const root = requireFakeElement(overlay.element, 'overlay');
    const attempt = overlay.dispose();
    assert.strictEqual(overlay.dispose(), attempt);
    assert.equal(document.body.children.length, 0);
    assert.equal(document.listenerCount('keydown'), 0);
    assert.equal(
      [...root.children].some((child) =>
        [...child.listeners.values()].some((list) => list.length > 0),
      ),
      false,
    );
    await assert.rejects(attempt, /cleanup failed/);
    assert.equal(overlay.hasPendingCleanup(), true);
    assert.throws(() => overlay.setPreferredAnchor('top-left'), /disposed/);
    assert.throws(() => overlay.acknowledgePreviewInput('x'), /disposed/);
    await overlay.dispose();
    assert.equal(releases.mock.calls.length, 2);
    assert.equal(releaseToolbar.mock.calls.length, 2);
    assert.equal(overlay.hasPendingCleanup(), false);
    await policy.dispose();
  });
}

test('overlay keeps failed listeners inert and retries pointer capture and DOM removal', async () => {
  const document = createFakeDocument();
  const policy = makePolicy();
  const overlay = createDsl4PreviewReloadOverlay({
    surface: 'web',
    document,
    mount: document.body,
    policy,
    layoutCoordinator: createDsl4PreviewLayoutCoordinator({viewport: {width: 800, height: 600}}),
  });
  const root = requireFakeElement(overlay.element, 'overlay');
  const status = requireFakeElement(overlay.statusButton, 'status');
  status.dispatch('pointerdown', {pointerId: 7});
  const release = vi.spyOn(status, 'releasePointerCapture').mockImplementationOnce(() => {
    throw new Error('capture release');
  });
  const remove = root.remove.bind(root);
  const removals = vi.spyOn(root, 'remove').mockImplementationOnce(() => {
    throw new Error('DOM release');
  });
  vi.spyOn(document, 'removeEventListener').mockImplementationOnce(() => {
    throw new Error('listener release');
  });
  await assert.rejects(overlay.dispose(), /cleanup failed/);
  const before = policy.getState();
  document.dispatchKey('KeyA');
  status.click();
  assert.deepEqual(policy.getState(), before);
  removals.mockImplementation(remove);
  await overlay.dispose();
  assert.equal(release.mock.calls.length, 2);
  assert.equal(document.listenerCount('keydown'), 0);
  assert.equal(root.parentNode, null);
  assert.equal(overlay.hasPendingCleanup(), false);
  await policy.dispose();
});

test('surface retries geometry and overlay cleanup even after an independent owner fails', async () => {
  const document = createFakeDocument();
  const disconnect = vi.fn().mockImplementationOnce(() => {
    throw new Error('disconnect failed');
  });
  const removal = vi.fn().mockImplementationOnce(() => {
    throw new Error('resize listener failed');
  });
  document.defaultView = {
    addEventListener() {},
    removeEventListener: removal,
    ResizeObserver: class {
      observe() {}
      disconnect() {
        return disconnect();
      }
    },
  };
  const surface = createDsl4PreviewReloadSurface({
    surface: 'cli',
    environment: 'development',
    document,
    mount: document.body,
    viewport: {width: 800, height: 600},
  });
  const attempt = surface.dispose();
  assert.strictEqual(surface.dispose(), attempt);
  assert.throws(() => surface.updateViewport({width: 400, height: 300}), /disposed/);
  await assert.rejects(surface.setWatchState('source', 'watching'), /disposed/);
  await assert.rejects(attempt, /cleanup failed/);
  assert.equal(document.body.children.length, 0);
  assert.equal(surface.policy.getState().disposed, true);
  assert.equal(surface.hasPendingCleanup(), true);
  await surface.dispose();
  assert.equal(disconnect.mock.calls.length, 2);
  assert.equal(removal.mock.calls.length, 3, 'only the failed listener is retried');
  assert.equal(surface.hasPendingCleanup(), false);
});

for (const setupFailure of ['observe', 'listener'] as const) {
  test(`surface retains partial ${setupFailure} setup for explicit creation cleanup retry`, async () => {
    const document = createFakeDocument();
    const remove = vi.fn().mockImplementationOnce(() => {
      throw new Error('remove failed');
    });
    const disconnect = vi.fn().mockImplementationOnce(() => {
      throw new Error('disconnect failed');
    });
    document.defaultView = {
      addEventListener() {
        if (setupFailure === 'listener') throw new Error('partially added');
      },
      removeEventListener: remove,
      ResizeObserver: class {
        observe() {
          throw new Error('observe failed');
        }
        disconnect() {
          return disconnect();
        }
      },
    };
    const cleanup = failureFrom(() =>
      createDsl4PreviewReloadSurface({
        surface: 'web',
        environment: 'development',
        document,
        mount: document.body,
        viewport: {width: 800, height: 600},
      }),
    );
    assert.ok(cleanup.completion);
    await assert.rejects(cleanup.completion);
    assert.equal(document.body.children.length, 0);
    assert.equal(document.listenerCount('keydown'), 0);
    assert.equal(cleanup.hasPendingCleanup(), true);
    await cleanup.dispose();
    assert.equal(cleanup.hasPendingCleanup(), false);
    assert.equal(
      setupFailure === 'observe' ? disconnect.mock.calls.length : remove.mock.calls.length,
      2,
    );
  });
}

test('development shell independently retries focus, listener, and DOM cleanup while inputs stay closed', async () => {
  const document = createFakeDocument();
  const before = document.createElement('button');
  document.body.appendChild(before);
  before.focus();
  const choices = vi.fn();
  const shell = createDsl4DevelopmentPreviewShell({
    environment: 'development',
    document,
    mount: document.body,
    onReloadChoice: choices,
  });
  shell.update({
    formatVersion: 1,
    phase: 'candidate',
    sourceDisplayName: 'story.kamishibai.yaml',
    currentIntegrity: sri('old'),
    candidateIntegrity: sri('new'),
    validationStatus: 'valid',
    counts: {scenes: 1, actions: 1, assets: 0},
    anchor: {sceneId: 'intro', actionId: null},
    warningCount: 0,
    changeCategories: ['source'],
    safeStatusMessage: 'Candidate ready.',
    choices: {
      1: {enabled: true, reason: null},
      2: {enabled: true, reason: null},
      3: {enabled: true, reason: null},
    },
  });
  const root = requireFakeElement(shell.element, 'shell');
  const button = requireById(root, 'dsl4-preview-reload-1');
  const focus = vi.spyOn(before, 'focus').mockImplementationOnce(() => {
    throw new Error('focus failure');
  });
  const detach = vi.spyOn(root, 'remove').mockImplementationOnce(() => {
    throw new Error('DOM failure');
  });
  vi.spyOn(document, 'removeEventListener').mockImplementationOnce(() => {
    throw new Error('listener failure');
  });
  const disposal = shell.dispose();
  assert.strictEqual(shell.dispose(), disposal);
  await assert.rejects(disposal, /cleanup failed/);
  button.click();
  document.dispatchKey('Digit1');
  assert.equal(choices.mock.calls.length, 0);
  assert.equal(shell.getSnapshot(), null);
  assert.throws(() => shell.update({}), /disposed/);
  await shell.dispose();
  assert.equal(focus.mock.calls.length, 2);
  assert.equal(detach.mock.calls.length, 2);
  assert.strictEqual(document.activeElement, before);
  assert.equal(document.listenerCount('keydown'), 0);
  assert.equal(shell.hasPendingCleanup(), false);
});

for (const host of ['cli', 'web'] as const) {
  for (const asynchronous of [false, true]) {
    test(`${host} shell retains a failed ${asynchronous ? 'async' : 'sync'} child and joins reentrant disposal`, async () => {
      const document = createFakeDocument();
      const gate = deferred();
      let shell!:
        | ReturnType<typeof createDsl4CliPreviewShell>
        | Extract<ReturnType<typeof createDsl4WebPreviewShell>, {whenIdle: unknown}>;
      let reentered: unknown;
      const release = vi.fn<() => unknown>(() => {
        reentered = shell.dispose();
        if (asynchronous) return gate.promise;
        throw new Error('child failed');
      });
      const child = reloadChild(release);
      const coordinator = coordinatorChild();
      const input = {
        featureFlags: flags,
        environment: 'development',
        document,
        mount: document.body,
        createReloadSurface: () => child,
      };
      if (host === 'cli') shell = createDsl4CliPreviewShell(input);
      else {
        const web = createDsl4WebPreviewShell({
          ...input,
          protocolSession: {},
          sessionId: 'test',
          sourceFrontend: {parse() {}},
          maxSourceBytes: 8192,
          createCoordinator: () => coordinator,
        });
        assert.ok('whenIdle' in web);
        // Both hosts expose the common operations used in this case.
        shell = web;
      }
      const attempt = shell.dispose();
      assert.equal(release.mock.calls.length, 1, 'children close before dispose returns');
      assert.strictEqual(shell.dispose(), attempt);
      assert.throws(() => shell.submitReloadCandidate({}), /disposed/);
      assert.throws(() => shell.acknowledgePreviewInput('test'), /disposed/);
      assert.throws(() => shell.updatePreviewViewport({}), /disposed/);
      await waitUntil(() => release.mock.calls.length === 1);
      assert.strictEqual(reentered, attempt);
      if (asynchronous) gate.reject(new Error('child failed'));
      await assert.rejects(attempt, /cleanup failed/);
      assert.equal(document.body.children.length, 0);
      assert.equal(document.listenerCount('keydown'), 0);
      assert.equal(shell.hasPendingCleanup(), true);
      release.mockImplementation(() => {});
      await shell.dispose();
      assert.equal(release.mock.calls.length, 2);
      assert.equal(child.submitCandidate.mock.calls.length, 0);
      assert.equal(shell.hasPendingCleanup(), false);
    });
  }

  test(`${host} shell carries an invalid returned child's failed cleanup out of the factory`, async () => {
    const document = createFakeDocument();
    const release = vi
      .fn()
      .mockRejectedValueOnce(new Error('partial child cleanup'))
      .mockResolvedValue(undefined);
    const input = {
      featureFlags: flags,
      environment: 'development',
      document,
      mount: document.body,
      createReloadSurface: () => ({dispose: release}),
    };
    const cleanup = failureFrom(() =>
      host === 'cli' ? createDsl4CliPreviewShell(input) : webSetup(input),
    );
    assert.ok(cleanup.completion);
    await assert.rejects(cleanup.completion);
    assert.equal(
      release.mock.calls.length,
      1,
      'initial failure is not retried in the same attempt',
    );
    assert.equal(document.body.children.length, 0);
    assert.equal(document.listenerCount('keydown'), 0);
    await cleanup.dispose();
    assert.equal(release.mock.calls.length, 2);
    assert.equal(cleanup.hasPendingCleanup(), false);
  });
}

test('Web shell keeps independent coordinator/asset/surface cleanup and retries inspector failures', async () => {
  let inspectFailure = true;
  let childPending = true;
  const releaseSurface = vi.fn();
  const surface = {
    ...reloadChild(releaseSurface),
    hasPendingCleanup() {
      if (inspectFailure) throw new Error('inspection failed');
      return childPending;
    },
  };
  const releaseCoordinator = vi
    .fn()
    .mockRejectedValueOnce(new Error('coordinator cleanup'))
    .mockResolvedValue(undefined);
  const releaseAssets = vi
    .fn()
    .mockRejectedValueOnce(new Error('asset cleanup'))
    .mockResolvedValue(undefined);
  const {shell, document} = webSetup({
    featureFlags: {...flags, dsl4WebPreviewAssetLiveReload: true},
    createCoordinator: () => coordinatorChild(releaseCoordinator),
    createReloadSurface: () => surface,
    createAssetPipeline: () => ({
      start() {},
      updateSource() {},
      pollNow() {},
      dispose: releaseAssets,
      getState: () => ({}),
      whenIdle: async () => {},
    }),
    assetPipelineOptions: {
      structuralFingerprint: sri('structure'),
      adapterOptions: {},
      prepareGeneration() {},
      restartGeneration() {},
    },
  });
  await assert.rejects(shell.dispose());
  assert.equal(document.body.children.length, 0);
  assert.equal(releaseAssets.mock.calls.length, 1);
  assert.equal(releaseCoordinator.mock.calls.length, 1);
  assert.equal(
    releaseSurface.mock.calls.length,
    1,
    'inspection failure does not block normal release',
  );
  assert.equal(shell.hasPendingCleanup(), true);
  inspectFailure = false;
  childPending = false;
  await shell.dispose();
  assert.equal(releaseSurface.mock.calls.length, 1);
  assert.equal(releaseCoordinator.mock.calls.length, 2);
  assert.equal(releaseAssets.mock.calls.length, 2);
  assert.equal(shell.hasPendingCleanup(), false);
  childPending = true;
  await shell.dispose();
  assert.equal(
    releaseSurface.mock.calls.length,
    2,
    'late child cleanup is discoverable after success',
  );
  childPending = false;
  assert.equal(shell.hasPendingCleanup(), false);
});

test('parent creation joins the child creation attempt and only explicitly retries it later', async () => {
  const release = vi
    .fn()
    .mockRejectedValueOnce(new Error('child cleanup failed'))
    .mockResolvedValue(undefined);
  const initial = deferred();
  const lower = createDsl4CreationCleanup(
    [
      async () => {
        await initial.promise;
        await release();
      },
    ],
    'lower cleanup',
  );
  const first = lower.dispose();
  void first.catch(() => {});
  const cleanup = failureFrom(() =>
    webSetup({
      createCoordinator() {
        throw new Dsl4CreationFailure(new Error('factory failed'), lower, 'coordinator creation');
      },
    }),
  );
  assert.ok(cleanup.completion);
  initial.resolve();
  await assert.rejects(cleanup.completion);
  assert.equal(release.mock.calls.length, 1);
  await cleanup.dispose();
  assert.equal(release.mock.calls.length, 2);
  assert.equal(cleanup.hasPendingCleanup(), false);
});

test('Web shell closes poll/build/delegate operations immediately and ignores late source/root results', async () => {
  let callbacks!: {
    onProjectRoot(root: unknown): Promise<unknown>;
    onSourceResult(result: unknown): void;
  };
  const coordinator = coordinatorChild();
  const {shell} = webSetup({
    createCoordinator(options: typeof callbacks) {
      callbacks = options;
      return coordinator;
    },
  });
  const attempt = shell.dispose();
  await assert.rejects(shell.pollNow(), /disposed/);
  await assert.rejects(shell.prepareDistributionBuild(), /disposed/);
  assert.throws(() => shell.setReloadVisible(true), /disposed/);
  assert.throws(() => shell.start({}), /disposed/);
  assert.throws(() => shell.restart('storyStart'), /disposed/);
  await assert.rejects(callbacks.onProjectRoot({}), /disposed/);
  callbacks.onSourceResult({ok: true, sourceSnapshot: {displayName: 'late.yaml'}});
  await attempt;
  assert.equal(coordinator.pollNow.mock.calls.length, 0);
  assert.equal(shell.getSnapshot().sourceDisplayName, 'story.kamishibai.yaml');
  assert.equal(shell.getDistributionBuildState().enabled, false);
});

test('policy awaits normal notifications and contains an observer rejection after disposal', async () => {
  const notification = deferred();
  const errors: unknown[] = [];
  let called = false;
  const policy = makePolicy({
    onState: () => {
      called = true;
      return notification.promise;
    },
    onError: (error) => errors.push(error),
  });
  let finished = false;
  const changed = policy.setWatchState('watching').then(() => {
    finished = true;
  });
  await waitUntil(() => called);
  assert.equal(finished, false);
  await withDeadline(policy.dispose(), 'close waiting notification', 1000);
  await changed;
  notification.reject(new Error('late observer failure'));
  await waitUntil(() => errors.length > 0);
  assert.equal(policy.getState().status, 'disposed');
});

for (const surface of ['development', 'overlay'] as const) {
  test(`${surface} keeps a partially registered listener and failed DOM removal owned on creation failure`, async () => {
    const document = createFakeDocument();
    const policy = makePolicy();
    const added = document.addEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
      added(type, listener, options);
      throw new Error('listener partially installed');
    });
    const createElement = document.createElement.bind(document);
    const removals = vi
      .fn()
      .mockRejectedValueOnce(new Error('DOM remove failed'))
      .mockResolvedValue(undefined);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const result = createElement(tag);
      if (tag === 'section') {
        const remove = result.remove.bind(result);
        result.remove = () => removals().then(remove);
      }
      return result;
    });
    const cleanup = failureFrom(() =>
      surface === 'development'
        ? createDsl4DevelopmentPreviewShell({
            environment: 'development',
            document,
            mount: document.body,
          })
        : createDsl4PreviewReloadOverlay({
            surface: 'web',
            document,
            mount: document.body,
            policy,
            layoutCoordinator: createDsl4PreviewLayoutCoordinator({
              viewport: {width: 800, height: 600},
            }),
          }),
    );
    assert.ok(cleanup.completion);
    await assert.rejects(cleanup.completion);
    assert.equal(document.listenerCount(surface === 'development' ? 'keydown' : 'pointerup'), 0);
    assert.equal(cleanup.hasPendingCleanup(), true);
    await cleanup.dispose();
    assert.equal(removals.mock.calls.length, 2);
    assert.equal(document.body.children.length, 0);
    assert.equal(cleanup.hasPendingCleanup(), false);
    await policy.dispose();
  });
}

test('surface disposal waits for an active driver and drops queued candidates without publishing success', async () => {
  const document = createFakeDocument();
  const surface = createDsl4PreviewReloadSurface({
    surface: 'web',
    environment: 'development',
    document,
    mount: document.body,
    viewport: {width: 800, height: 600},
  });
  const gate = deferred();
  const apply = vi.fn(() => gate.promise);
  const first = surface.submitCandidate({
    channel: 'source',
    channelRevision: 1,
    availability,
    changedIds: [],
    apply,
    restart() {},
  });
  const firstResult = assert.rejects(first, /disposed/);
  await waitUntil(() => apply.mock.calls.length === 1);
  const queued = surface.submitCandidate({
    channel: 'asset',
    channelRevision: 1,
    availability,
    changedIds: [],
    apply,
    restart() {},
  });
  const queuedResult = assert.rejects(queued, /disposed/);
  let completed = false;
  const attempt = surface.dispose();
  void attempt.then(() => {
    completed = true;
  });
  await waitUntil(() => document.body.children.length === 0);
  assert.equal(completed, false);
  gate.resolve();
  await Promise.all([attempt, firstResult, queuedResult]);
  assert.equal(apply.mock.calls.length, 1);
  assert.deepEqual(surface.getSnapshot().candidateChannels, []);
  assert.equal(surface.policy.getState().status, 'disposed');
});

test('Web shell does not resume a polled build after disposal while file polling is pending', async () => {
  const gate = deferred();
  const coordinator = coordinatorChild();
  coordinator.pollNow.mockImplementation(() => gate.promise);
  const {shell} = webSetup({createCoordinator: () => coordinator});
  const build = shell.prepareDistributionBuild();
  const outcome = assert.rejects(build, /disposed/);
  await waitUntil(() => coordinator.pollNow.mock.calls.length === 1);
  await shell.dispose();
  gate.resolve();
  await outcome;
  assert.equal(shell.getDistributionBuildState().enabled, false);
  assert.equal(shell.hasPendingCleanup(), false);
});

test('CLI shell rejects candidate input reentered from root DOM removal before the child closes', async () => {
  const document = createFakeDocument();
  const choice = vi.fn();
  const shell = createDsl4CliPreviewShell({
    environment: 'development',
    featureFlags: {dsl4Runtime: true, dsl4AppShell: true},
    document,
    mount: document.body,
    onReloadChoice: choice,
  });
  shell.update({
    formatVersion: 1,
    phase: 'candidate',
    sourceDisplayName: 'story.kamishibai.yaml',
    currentIntegrity: sri('old'),
    candidateIntegrity: sri('new'),
    validationStatus: 'valid',
    counts: {scenes: 1, actions: 1, assets: 0},
    anchor: null,
    warningCount: 0,
    changeCategories: ['source'],
    safeStatusMessage: 'Candidate ready.',
    choices: {
      1: {enabled: true, reason: null},
      2: {enabled: true, reason: null},
      3: {enabled: true, reason: null},
    },
  });
  const root = requireFakeElement(shell.element, 'CLI shell');
  const remove = root.remove.bind(root);
  vi.spyOn(root, 'remove').mockImplementation(() => {
    document.dispatchKey('Digit1');
    remove();
  });
  await shell.dispose();
  assert.equal(choice.mock.calls.length, 0);
  assert.equal(document.listenerCount('keydown'), 0);
});

test('policy cannot publish success after a clock callback requests disposal', async () => {
  let disposal: Promise<unknown> | undefined;
  const policy: ReturnType<typeof makePolicy> = makePolicy({
    clock: {
      now() {
        disposal = policy.dispose();
        return 0;
      },
      setTimeout() {
        assert.fail('must not schedule after close');
      },
      clearTimeout() {},
    },
  });
  const applied = policy.submitCandidate(candidate(1));
  await assert.rejects(applied, /disposed/);
  await disposal;
  assert.equal(policy.getState().lastSuccess, null);
  assert.equal(policy.getState().currentGeneration, null);
});

test('surface refuses an event target without a release API before adding a geometry listener', async () => {
  const document = createFakeDocument();
  const add = vi.fn();
  document.defaultView = {addEventListener: add};
  const cleanup = failureFrom(() =>
    createDsl4PreviewReloadSurface({
      surface: 'web',
      environment: 'development',
      document,
      mount: document.body,
      viewport: {width: 800, height: 600},
    }),
  );
  await cleanup.completion;
  assert.equal(add.mock.calls.length, 0);
  assert.equal(document.body.children.length, 0);
  assert.equal(cleanup.hasPendingCleanup(), false);
});

for (const childKind of ['coordinator', 'asset'] as const) {
  test(`Web shell retains an invalid ${childKind} owner returned before validation`, async () => {
    const release = vi
      .fn()
      .mockRejectedValueOnce(new Error('invalid child release'))
      .mockResolvedValue(undefined);
    const coordinatorRelease = vi.fn();
    const document = createFakeDocument();
    const cleanup = failureFrom(() =>
      webSetup({
        document,
        mount: document.body,
        featureFlags: {...flags, dsl4WebPreviewAssetLiveReload: true},
        createCoordinator: () =>
          childKind === 'coordinator' ? {dispose: release} : coordinatorChild(coordinatorRelease),
        createAssetPipeline: () => ({dispose: release}),
        assetPipelineOptions: {
          structuralFingerprint: sri('structure'),
          adapterOptions: {},
          prepareGeneration() {},
          restartGeneration() {},
        },
      }),
    );
    assert.ok(cleanup.completion);
    await assert.rejects(cleanup.completion);
    assert.equal(release.mock.calls.length, 1);
    assert.equal(document.body.children.length, 0);
    assert.equal(
      childKind === 'asset' ? coordinatorRelease.mock.calls.length : 0,
      childKind === 'asset' ? 1 : 0,
    );
    await cleanup.dispose();
    assert.equal(release.mock.calls.length, 2);
    assert.equal(cleanup.hasPendingCleanup(), false);
  });
}

for (const rejectUpdate of [false, true]) {
  test(`Web shell settles an in-flight asset update ${rejectUpdate ? 'failure' : 'success'} and retries only cleanup failures`, async () => {
    const update = deferred();
    const started = vi.fn(() => update.promise);
    const release = vi
      .fn()
      .mockRejectedValueOnce(new Error('cleanup failure'))
      .mockResolvedValue(undefined);
    let callbacks!: {
      onProjectRoot(root: unknown): Promise<unknown>;
      onSourceResult(result: unknown): void;
    };
    const errors: unknown[] = [];
    const {shell, document} = webSetup({
      featureFlags: {...flags, dsl4WebPreviewAssetLiveReload: true},
      createCoordinator(input: typeof callbacks) {
        callbacks = input;
        return coordinatorChild();
      },
      createAssetPipeline: () => ({
        start: started,
        updateSource() {},
        pollNow() {},
        dispose: release,
        getState: () => ({}),
        whenIdle: async () => {},
      }),
      assetPipelineOptions: {
        structuralFingerprint: sri('structure'),
        adapterOptions: {},
        prepareGeneration() {},
        restartGeneration() {},
      },
      onError: (error: unknown) => errors.push(error),
    });
    await callbacks.onProjectRoot({kind: 'directory'});
    callbacks.onSourceResult({
      ok: true,
      sourceSnapshot: {integrity: sri('source')},
      storyDocument: {scenes: []},
      diagnostics: [],
    });
    await waitUntil(() => started.mock.calls.length === 1);
    const first = shell.dispose();
    const failure = assert.rejects(first, /cleanup failed/);
    assert.equal(release.mock.calls.length, 1, 'cleanup starts before waiting for the update');
    assert.equal(document.body.children.length, 0);
    if (rejectUpdate) update.reject(new Error('source operation failed'));
    else update.resolve();
    await failure;
    assert.equal(shell.hasPendingCleanup(), true);
    await shell.dispose();
    assert.equal(release.mock.calls.length, 2);
    assert.equal(started.mock.calls.length, 1);
    assert.equal(shell.hasPendingCleanup(), false);
    if (rejectUpdate) assert.ok(errors.length > 0);
  });
}

test('overlay accepts pointer capture automatically released by DOM removal', async () => {
  const document = createFakeDocument();
  const policy = makePolicy();
  const overlay = createDsl4PreviewReloadOverlay({
    surface: 'web',
    document,
    mount: document.body,
    policy,
    layoutCoordinator: createDsl4PreviewLayoutCoordinator({viewport: {width: 800, height: 600}}),
  });
  const root = requireFakeElement(overlay.element, 'overlay');
  const status = requireFakeElement(overlay.statusButton, 'status');
  status.dispatch('pointerdown', {pointerId: 17});
  const remove = root.remove.bind(root);
  vi.spyOn(root, 'remove').mockImplementation(() => {
    status.pointerCaptures.clear();
    remove();
  });
  const release = vi.spyOn(status, 'releasePointerCapture').mockImplementation(() => {
    throw new Error('pointer is no longer active');
  });
  await overlay.dispose();
  assert.equal(release.mock.calls.length, 0);
  assert.equal(overlay.hasPendingCleanup(), false);
  await policy.dispose();
});

test('development shell does not publish a choice after focus restoration requests disposal', async () => {
  const document = createFakeDocument();
  const before = document.createElement('button');
  document.body.appendChild(before);
  before.focus();
  const choice = vi.fn();
  const shell = createDsl4DevelopmentPreviewShell({
    environment: 'development',
    document,
    mount: document.body,
    onReloadChoice: choice,
  });
  shell.update({
    formatVersion: 1,
    phase: 'candidate',
    sourceDisplayName: 'story.kamishibai.yaml',
    currentIntegrity: sri('old'),
    candidateIntegrity: sri('new'),
    validationStatus: 'valid',
    counts: {scenes: 1, actions: 1, assets: 0},
    anchor: null,
    warningCount: 0,
    changeCategories: ['source'],
    safeStatusMessage: 'Candidate ready.',
    choices: {
      1: {enabled: true, reason: null},
      2: {enabled: true, reason: null},
      3: {enabled: true, reason: null},
    },
  });
  vi.spyOn(before, 'focus').mockImplementationOnce(() => {
    void shell.dispose();
  });
  requireById(requireFakeElement(shell.element, 'shell'), 'dsl4-preview-reload-1').click();
  await shell.dispose();
  assert.equal(choice.mock.calls.length, 0);
  assert.equal(shell.hasPendingCleanup(), false);
});
