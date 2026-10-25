import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {test, vi} from 'vitest';
import {createDsl4WebPreviewShell} from '../src/builder/dsl4-web-preview-shell.js';
import {validateDsl4AssetCandidate} from '../src/dsl4/asset-candidate-validator.js';
import {createDsl4AssetSnapshotWatch} from '../src/dsl4/asset-snapshot-watch.js';
import {createDsl4BrowserPreviewAssetAdapter} from '../src/dsl4/browser-preview-asset-adapter.js';
import {createDsl4AssetReloadTransaction} from '../src/dsl4/asset-reload-transaction.js';
import {createDsl4BrowserAssetReloadPipeline} from '../src/dsl4/browser-asset-reload-pipeline.js';
import {dsl4AssetReloadProtocolCapabilities} from '../src/dsl4/asset-reload-protocol.js';
import {
  createDsl4CreationCleanup,
  Dsl4CreationFailure,
  getDsl4CreationCleanup,
} from '../src/dsl4/creation-cleanup.js';
import {dsl4TestSourceFrontend} from './helpers/dsl4-test-frontend.ts';
import {deferred, waitUntil, withDeadline} from './helpers/async-test-helpers.ts';
import {createFakeDocument} from './helpers/fake-dom.ts';

const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
const sri = (text: string) => `sha256-${createHash('sha256').update(text).digest('base64')}`;
const parsed = dsl4TestSourceFrontend.parse(
  "kamishibai: '4.0'\nassets:\n  Picture:\n    kind: backdrop\n    file: picture.svg\nscenes:\n  opening:\n    - stage: Picture\n",
  {sourceId: 'cleanup-assets'},
);
assert.equal(parsed.ok, true);
if (!parsed.ok) throw new Error('Asset cleanup fixture must parse');
const storyDocument = parsed.storyDocument;
const context = {
  sourceResult: {...parsed, sourceSnapshot: {integrity: sri('source')}},
  structuralFingerprint: sri('structure'),
};
function clock(clearTimeout = () => {}) {
  let time = 0;
  return {
    now: () => time,
    async sleep(delay: number) {
      time += delay;
    },
    setTimeout: () => 1,
    clearTimeout,
  };
}
function root() {
  return {
    kind: 'directory',
    queryPermission: async () => 'granted',
    getDirectoryHandle: async () => {
      throw Object.assign(new Error('missing'), {name: 'NotFoundError'});
    },
    getFileHandle: async () => ({
      kind: 'file',
      getFile: async () => ({size: bytes.length, arrayBuffer: async () => bytes.slice().buffer}),
    }),
  };
}
function summary(revision = 1) {
  return {
    revision,
    providerId: `asset-provider-${revision}`,
    sourceIntegrity: sri('source'),
    graphIntegrity: sri('graph'),
    contentIntegrity: sri(String(revision)),
    classification: {kind: 'initial', changedAssets: [], affectedScenes: []},
    validations: [],
  };
}
function adapterFixture() {
  return {
    getCandidateProvider: (revision: number) => ({providerId: `asset-provider-${revision}`}),
    accept: vi.fn(),
    discard: vi.fn(),
    dispose: vi.fn(),
  };
}
function preparedFixture() {
  return {
    activate: vi.fn(() => ({actualAnchor: 'scene'})),
    rollback: vi.fn<(...args: unknown[]) => unknown>(),
    release: vi.fn<(...args: unknown[]) => unknown>(),
  };
}
function validator(inspectImage: () => unknown) {
  return validateDsl4AssetCandidate({
    storyDocument,
    asset: {id: 'Picture', kind: 'backdrop'},
    files: [{path: 'picture.svg', bytes}],
    signal: new AbortController().signal,
    maxImagePixels: 100,
    maxAudioDurationSeconds: 100,
    maxAudioChannels: 2,
    maxAudioSampleRate: 48000,
    inspectImage,
  });
}
function assetAdapter(
  extra: Partial<Parameters<typeof createDsl4BrowserPreviewAssetAdapter>[0]> = {},
) {
  return createDsl4BrowserPreviewAssetAdapter({
    inspectImage: () => ({width: 1, height: 1}),
    inspectAudio: () => ({}),
    onCandidate() {},
    subtleCrypto: webcrypto.subtle,
    watchOptions: {clock: clock()},
    ...extra,
  });
}
function pipeline(
  prepareGeneration: Parameters<
    typeof createDsl4BrowserAssetReloadPipeline
  >[0]['prepareGeneration'],
  extra: Partial<Parameters<typeof createDsl4BrowserAssetReloadPipeline>[0]> = {},
) {
  return createDsl4BrowserAssetReloadPipeline({
    sessionId: 'cleanup-pipeline',
    negotiatedCapabilities: dsl4AssetReloadProtocolCapabilities,
    prepareGeneration,
    adapterOptions: {
      subtleCrypto: webcrypto.subtle,
      inspectImage: () => ({width: 1, height: 1}),
      inspectAudio: () => ({}),
      watchOptions: {clock: clock()},
    },
    ...extra,
  });
}
for (const asyncFailure of [false, true]) {
  test(`validator retains ${asyncFailure ? 'async' : 'sync'} decoder release failure for explicit retry`, async () => {
    let broken = true;
    let nested: unknown;
    const release = vi.fn(() => {
      nested = result.release();
      if (broken) {
        if (asyncFailure) return Promise.reject(new Error('decoder failed'));
        throw new Error('decoder failed');
      }
    });
    const result: Awaited<ReturnType<typeof validator>> = await validator(() => ({
      width: 1,
      height: 1,
      release,
    }));
    const attempt = result.release();
    assert.strictEqual(result.release(), attempt);
    assert.strictEqual(nested, attempt);
    await assert.rejects(attempt, AggregateError);
    assert.equal(release.mock.calls.length, 1);
    broken = false;
    await result.release();
    await result.release();
    assert.equal(release.mock.calls.length, 2);
  });
}
test('validator hands off failed cleanup when validation fails before returning a candidate', async () => {
  let broken = true;
  const release = vi.fn(() => {
    if (broken) throw new Error('decoder failed');
  });
  let failure: unknown;
  try {
    await validator(() => ({width: 500, height: 500, release}));
  } catch (error) {
    failure = error;
  }
  const cleanup = getDsl4CreationCleanup(failure);
  assert.ok(cleanup);
  assert.equal(release.mock.calls.length, 1);
  assert.equal(cleanup.hasPendingCleanup(), true);
  broken = false;
  await cleanup.dispose();
  assert.equal(release.mock.calls.length, 2);
  assert.equal(cleanup.hasPendingCleanup(), false);
});

test('watch retains failed active release, joins reentry, and retries only the failed resource', async () => {
  let read = 0,
    broken = true;
  let nested: unknown;
  const releases = [
    vi.fn(),
    vi.fn(() => {
      nested = watch.dispose();
      if (broken) throw new Error('active release failed');
    }),
  ];
  const watch = createDsl4AssetSnapshotWatch({
    clock: clock(),
    read: () => ({key: 'A', value: {}, release: releases[read++]!}),
    onCandidate() {},
  });
  await watch.start({});
  await watch.accept(1);
  const attempt = watch.dispose();
  assert.strictEqual(watch.dispose(), attempt);
  await assert.rejects(attempt, AggregateError);
  assert.strictEqual(nested, attempt);
  assert.equal(watch.hasPendingCleanup(), true);
  assert.equal(releases[0]!.mock.calls.length, 1);
  assert.equal(releases[1]!.mock.calls.length, 1);
  assert.throws(() => watch.pollNow(), /not active/);
  broken = false;
  await watch.dispose();
  assert.equal(releases[0]!.mock.calls.length, 1);
  assert.equal(releases[1]!.mock.calls.length, 2);
  assert.equal(watch.hasPendingCleanup(), false);
});
test('watch keeps a timer failure independent from resource release and closes stale callbacks', async () => {
  let broken = true;
  let tick = () => {};
  const release = vi.fn();
  const clears = vi.fn(() => {
    if (broken) throw new Error('timer failed');
  });
  const watch = createDsl4AssetSnapshotWatch({
    clock: {
      ...clock(clears),
      setTimeout(callback) {
        tick = callback;
        return 1;
      },
    },
    read: () => ({key: 'A', value: {}, release}),
    onCandidate() {},
  });
  await watch.start({});
  await assert.rejects(watch.dispose(), AggregateError);
  assert.equal(release.mock.calls.length, 2);
  tick();
  broken = false;
  await watch.dispose();
  assert.equal(clears.mock.calls.length, 2);
  assert.equal(release.mock.calls.length, 2);
  assert.equal(watch.hasPendingCleanup(), false);
});
test('watch retires the first stable-read result when the second read fails', async () => {
  const release = vi.fn();
  let reads = 0;
  const watch = createDsl4AssetSnapshotWatch({
    clock: clock(),
    read() {
      if (++reads === 2) throw new Error('read failed');
      return {key: 'A', value: {}, release};
    },
    onCandidate() {},
  });
  await watch.start({});
  assert.equal(release.mock.calls.length, 1);
  await watch.dispose();
  assert.equal(release.mock.calls.length, 1);
});
test('watch retains both owners when the second read and first cleanup fail together', async () => {
  let reads = 0,
    broken = true;
  const firstRelease = vi.fn(() => {
    if (broken) throw new Error('first cleanup failed');
  });
  const childRelease = vi.fn(() => {
    if (broken) throw new Error('second cleanup failed');
  });
  const child = createDsl4CreationCleanup([childRelease], 'second read cleanup');
  const watch = createDsl4AssetSnapshotWatch({
    clock: clock(),
    async read() {
      if (++reads === 1) return {key: 'A', value: {}, release: firstRelease};
      await child.dispose().catch(() => {});
      throw new Dsl4CreationFailure(new Error('second read failed'), child, 'second read');
    },
    onCandidate() {},
  });
  await watch.start({});
  assert.equal(firstRelease.mock.calls.length, 1);
  assert.equal(childRelease.mock.calls.length, 1);
  assert.equal(watch.getState().pendingReleaseCount, 2);
  await assert.rejects(watch.dispose(), AggregateError);
  assert.equal(firstRelease.mock.calls.length, 2);
  assert.equal(childRelease.mock.calls.length, 2);
  assert.equal(watch.hasPendingCleanup(), true);
  broken = false;
  await watch.dispose();
  assert.equal(firstRelease.mock.calls.length, 3);
  assert.equal(childRelease.mock.calls.length, 3);
  assert.equal(child.hasPendingCleanup(), false);
  assert.equal(watch.hasPendingCleanup(), false);
});
for (const failRelease of [false, true]) {
  test(`watch closes a candidate waiting for superseded release${failRelease ? ' with failed late cleanup' : ''}`, async () => {
    let key = 'A',
      reads = 0,
      broken = failRelease;
    const entered = deferred(),
      gate = deferred();
    const releases = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    releases[1]!.mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
    });
    releases[3]!.mockImplementation(() => {
      if (broken) throw new Error('late cleanup failed');
    });
    const onCandidate = vi.fn();
    const watch = createDsl4AssetSnapshotWatch({
      clock: clock(),
      read: () => ({key, value: {}, release: releases[reads++]!}),
      onCandidate,
    });
    await watch.start({});
    key = 'B';
    const polling = watch.pollNow();
    await entered.promise;
    const closing = watch.dispose();
    const result = closing.then(
      () => true,
      () => false,
    );
    gate.resolve();
    await withDeadline(polling, 'superseded read close', 2000);
    assert.equal(await withDeadline(result, 'superseded dispose', 2000), !failRelease);
    assert.equal(watch.getState().candidate, null);
    assert.equal(onCandidate.mock.calls.length, 1);
    assert.equal(releases[3]!.mock.calls.length, 1);
    broken = false;
    await watch.dispose();
    assert.equal(releases[3]!.mock.calls.length, failRelease ? 2 : 1);
    assert.equal(releases[1]!.mock.calls.length, 1);
    assert.equal(watch.hasPendingCleanup(), false);
  });
}
test('watch retains a late read release failure without an automatic retry in the same disposal', async () => {
  const gate = deferred<{key: string; value: Record<string, unknown>; release: () => void}>();
  let reads = 0,
    broken = true;
  const release = vi.fn(() => {
    if (broken) throw new Error('late release failed');
  });
  const watch = createDsl4AssetSnapshotWatch({
    clock: clock(),
    read() {
      reads++;
      return gate.promise;
    },
    onCandidate() {},
  });
  const starting = watch.start({});
  await waitUntil(() => reads === 1);
  const attempt = watch.dispose();
  const rejected = assert.rejects(attempt, AggregateError);
  gate.resolve({key: 'A', value: {}, release});
  await Promise.all([starting, rejected]);
  assert.equal(release.mock.calls.length, 1);
  broken = false;
  await watch.dispose();
  assert.equal(release.mock.calls.length, 2);
  assert.equal(watch.hasPendingCleanup(), false);
});
test('watch candidate observer can await disposal', async () => {
  const finished = deferred();
  const watch = createDsl4AssetSnapshotWatch({
    clock: clock(),
    read: () => ({key: 'A', value: {}, release() {}}),
    async onCandidate() {
      await watch.dispose();
      finished.resolve();
    },
  });
  await withDeadline(watch.start({}), 'candidate observer close', 2000);
  await withDeadline(finished.promise, 'candidate observer completion', 2000);
  assert.equal(watch.getState().status, 'disposed');
  assert.equal(watch.hasPendingCleanup(), false);
});

test('real adapter retains a decoder failure and keeps successful decoders released on retry', async () => {
  let reads = 0,
    broken = true;
  const releases = [
    vi.fn(),
    vi.fn(() => {
      if (broken) throw new Error('candidate decoder failed');
    }),
  ];
  const adapter = assetAdapter({
    inspectImage: () => ({width: 1, height: 1, release: releases[reads++]}),
  });
  await adapter.start(root(), context);
  const provider = adapter.getCandidateProvider(1)!;
  const attempt = adapter.dispose();
  assert.strictEqual(adapter.dispose(), attempt);
  await assert.rejects(attempt, AggregateError);
  assert.equal(adapter.hasPendingCleanup(), true);
  assert.equal(adapter.getState().providerCount, 1);
  assert.throws(() => provider.getFile('Picture', 'picture.svg'), /released/);
  assert.throws(() => adapter.pollNow(), /disposed/);
  assert.equal(releases[1]!.mock.calls.length, 1);
  broken = false;
  await adapter.dispose();
  assert.equal(releases[0]!.mock.calls.length, 1);
  assert.equal(releases[1]!.mock.calls.length, 2);
  assert.equal(adapter.getState().providerCount, 0);
  assert.equal(adapter.hasPendingCleanup(), false);
});
test('adapter joins failed validation cleanup and allows explicit retry through its owner', async () => {
  let broken = true;
  const release = vi.fn(() => {
    if (broken) throw new Error('invalid decoder cleanup failed');
  });
  const adapter = assetAdapter({inspectImage: () => ({width: 100000, height: 100000, release})});
  await adapter.start(root(), context);
  assert.equal(release.mock.calls.length, 1);
  assert.equal(adapter.hasPendingCleanup(), true);
  broken = false;
  await adapter.dispose();
  assert.equal(release.mock.calls.length, 2);
  assert.equal(adapter.hasPendingCleanup(), false);
});

test('real adapter retries only the watch timer when decoder cleanup already succeeded', async () => {
  let broken = true;
  const release = vi.fn();
  const clears = vi.fn(() => {
    if (broken) throw new Error('timer failed');
  });
  const adapter = assetAdapter({
    watchOptions: {clock: clock(clears)},
    inspectImage: () => ({width: 1, height: 1, release}),
  });
  await adapter.start(root(), context);
  await assert.rejects(adapter.dispose(), AggregateError);
  assert.equal(release.mock.calls.length, 2);
  assert.equal(adapter.getState().providerCount, 0);
  assert.equal(adapter.hasPendingCleanup(), true);
  broken = false;
  await adapter.dispose();
  assert.equal(release.mock.calls.length, 2);
  assert.equal(clears.mock.calls.length, 2);
  assert.equal(adapter.hasPendingCleanup(), false);
});

test('transaction keeps a failed rollback after defer and retries it without repeating release', async () => {
  const adapter = adapterFixture();
  const prepared = preparedFixture();
  let broken = true;
  prepared.rollback.mockImplementation(() => {
    if (broken) throw new Error('rollback failed');
  });
  const tx = createDsl4AssetReloadTransaction({
    assetAdapter: adapter,
    prepareGeneration: () => prepared,
  });
  await tx.stage(summary());
  await assert.rejects(tx.defer(1), AggregateError);
  assert.equal(tx.getState().pendingReleaseCount, 1);
  assert.equal(prepared.release.mock.calls.length, 1);
  await assert.rejects(tx.dispose(), AggregateError);
  assert.equal(adapter.dispose.mock.calls.length, 1);
  broken = false;
  await tx.dispose();
  assert.equal(prepared.release.mock.calls.length, 1);
  assert.equal(adapter.dispose.mock.calls.length, 1);
  assert.equal(tx.hasPendingCleanup(), false);
});
test('transaction retains a returned generation when its contract is invalid', async () => {
  let broken = true;
  const release = vi.fn(() => {
    if (broken) throw new Error('partial failed');
  });
  const tx = createDsl4AssetReloadTransaction({
    assetAdapter: adapterFixture(),
    prepareGeneration: () => ({release}),
  });
  await tx.stage(summary());
  assert.equal(release.mock.calls.length, 1);
  assert.equal(tx.getState().pendingReleaseCount, 1);
  broken = false;
  await tx.dispose();
  assert.equal(release.mock.calls.length, 2);
  assert.equal(tx.hasPendingCleanup(), false);
});

test('transaction retains a failed child inspection while continuing all cleanup', async () => {
  const adapter = adapterFixture(),
    value = preparedFixture();
  let broken = true;
  const tx = createDsl4AssetReloadTransaction({
    assetAdapter: {
      ...adapter,
      hasPendingCleanup() {
        if (broken) throw new Error('inspection failed');
        return false;
      },
    },
    prepareGeneration: () => value,
  });
  await tx.stage(summary());
  await assert.rejects(tx.dispose(), AggregateError);
  assert.equal(value.release.mock.calls.length, 1);
  assert.equal(adapter.dispose.mock.calls.length, 1);
  assert.equal(tx.hasPendingCleanup(), true);
  await assert.rejects(tx.commit(1), /disposed/);
  broken = false;
  await tx.dispose();
  assert.equal(value.release.mock.calls.length, 1);
  assert.equal(adapter.dispose.mock.calls.length, 1);
  assert.equal(tx.hasPendingCleanup(), false);
});

test('transaction independently releases the active generation while retaining its failed predecessor', async () => {
  const adapter = adapterFixture(),
    old = preparedFixture(),
    current = preparedFixture();
  let broken = true;
  old.release.mockImplementation(() => {
    if (broken) throw new Error('old generation failed');
  });
  const tx = createDsl4AssetReloadTransaction({
    assetAdapter: adapter,
    prepareGeneration: (input) => (input.summary.revision === 1 ? old : current),
  });
  await tx.stage(summary(1));
  await tx.commit(1);
  await tx.stage(summary(2));
  await tx.commit(2);
  assert.equal(tx.getState().pendingReleaseCount, 1);
  await assert.rejects(tx.dispose(), AggregateError);
  assert.equal(current.release.mock.calls.length, 1);
  assert.equal(adapter.dispose.mock.calls.length, 1);
  broken = false;
  await tx.dispose();
  assert.equal(old.release.mock.calls.length, 3);
  assert.equal(current.release.mock.calls.length, 1);
  assert.equal(adapter.dispose.mock.calls.length, 1);
  assert.equal(tx.hasPendingCleanup(), false);
});

test('transaction rejects a late activation after disposal and retains failed rollback', async () => {
  const adapter = adapterFixture(),
    value = preparedFixture();
  const activation = deferred<{actualAnchor: string}>();
  let broken = true;
  value.activate = vi.fn(() => activation.promise) as unknown as typeof value.activate;
  value.rollback.mockImplementation(() => {
    if (broken) throw new Error('late rollback failed');
  });
  const tx = createDsl4AssetReloadTransaction({
    assetAdapter: adapter,
    prepareGeneration: () => value,
  });
  await tx.stage(summary());
  const commit = tx.commit(1);
  const rejectedCommit = assert.rejects(commit, AggregateError);
  await waitUntil(() => value.activate.mock.calls.length === 1);
  const closing = assert.rejects(tx.dispose(), AggregateError);
  activation.resolve({actualAnchor: 'scene'});
  await Promise.all([rejectedCommit, closing]);
  assert.equal(adapter.accept.mock.calls.length, 0);
  assert.equal(value.rollback.mock.calls.length, 1);
  assert.equal(value.release.mock.calls.length, 1);
  assert.equal(tx.getState().generation, 0);
  broken = false;
  await tx.dispose();
  assert.equal(value.rollback.mock.calls.length, 2);
  assert.equal(value.release.mock.calls.length, 1);
  assert.equal(tx.hasPendingCleanup(), false);
});
test('transaction joins a failed factory cleanup before allowing a later retry', async () => {
  let broken = true;
  const release = vi.fn(() => {
    if (broken) throw new Error('factory cleanup failed');
  });
  const child = createDsl4CreationCleanup([release], 'factory cleanup');
  void child.dispose().catch(() => {});
  const tx = createDsl4AssetReloadTransaction({
    assetAdapter: adapterFixture(),
    prepareGeneration: () => {
      throw new Dsl4CreationFailure(new Error('factory failed'), child, 'factory failed');
    },
  });
  await tx.stage(summary());
  assert.equal(release.mock.calls.length, 1);
  broken = false;
  await tx.dispose();
  assert.equal(release.mock.calls.length, 2);
  assert.equal(tx.hasPendingCleanup(), false);
});
for (const failRelease of [false, true]) {
  test(`transaction owns delayed prepare after disposal${failRelease ? ' with failed release' : ''}`, async () => {
    const gate = deferred<ReturnType<typeof preparedFixture>>();
    const prepared = preparedFixture();
    let broken = failRelease;
    prepared.release.mockImplementation(() => {
      if (broken) throw new Error('late generation failed');
    });
    let nested: unknown;
    const started = vi.fn((input: {signal: AbortSignal}) => {
      input.signal.addEventListener(
        'abort',
        () => {
          nested = tx.dispose();
        },
        {once: true},
      );
      return gate.promise;
    });
    const tx = createDsl4AssetReloadTransaction({
      assetAdapter: adapterFixture(),
      prepareGeneration: started,
    });
    const staging = tx.stage(summary());
    await waitUntil(() => started.mock.calls.length === 1);
    const attempt = tx.dispose();
    const settled = attempt.then(
      () => true,
      () => false,
    );
    await waitUntil(() => started.mock.calls[0]![0].signal.aborted);
    assert.strictEqual(nested, attempt);
    gate.resolve(prepared);
    await staging.catch(() => {});
    assert.equal(await settled, !failRelease);
    assert.equal(prepared.activate.mock.calls.length, 0);
    assert.equal(prepared.release.mock.calls.length, 1);
    broken = false;
    await tx.dispose();
    assert.equal(prepared.release.mock.calls.length, failRelease ? 2 : 1);
    assert.equal(prepared.rollback.mock.calls.length, 1);
    assert.equal(tx.getState().status, 'disposed');
    assert.equal(tx.hasPendingCleanup(), false);
  });
}
test('transaction notifications can await disposal and late notification errors remain visible', async () => {
  const errors: unknown[] = [];
  const tx = createDsl4AssetReloadTransaction({
    assetAdapter: adapterFixture(),
    prepareGeneration: preparedFixture,
    async onEvent() {
      await tx.dispose();
      throw new Error('late observer failed');
    },
    onError: (e) => errors.push(e),
  });
  await withDeadline(tx.stage(summary()), 'transaction observer close', 2000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal(tx.hasPendingCleanup(), false);
});

test('real pipeline retries failed candidate cleanup across protocol and transaction without retrying in the first attempt', async () => {
  let broken = true;
  const prepared = preparedFixture();
  let nested: unknown;
  prepared.rollback.mockImplementation(() => {
    nested = instance.dispose();
    if (broken) throw new Error('candidate rollback failed');
  });
  const instance = pipeline(() => prepared);
  await instance.start(root(), context);
  const attempt = instance.dispose();
  assert.strictEqual(instance.dispose(), attempt);
  await assert.rejects(attempt, AggregateError);
  assert.strictEqual(nested, attempt);
  assert.equal(prepared.rollback.mock.calls.length, 1);
  assert.equal(prepared.release.mock.calls.length, 1);
  assert.equal(instance.hasPendingCleanup(), true);
  await assert.rejects(instance.commit(), /disposed/);
  assert.throws(() => instance.setHidden(false), /disposed/);
  broken = false;
  await instance.dispose();
  assert.equal(prepared.rollback.mock.calls.length, 2);
  assert.equal(prepared.release.mock.calls.length, 1);
  assert.equal(instance.getState().adapter.providerCount, 0);
  assert.equal(instance.getState().protocol.connected, false);
  assert.equal(instance.hasPendingCleanup(), false);
});
for (const failRelease of [false, true]) {
  test(`pipeline aborts cooperative prepare before waiting for protocol idle${failRelease ? ' with failed late cleanup' : ''}`, async () => {
    const entered = deferred(),
      aborted = deferred();
    const prepared = preparedFixture();
    let broken = failRelease,
      nested: unknown;
    prepared.release.mockImplementation(() => {
      if (broken) throw new Error('late cleanup failed');
    });
    const instance = pipeline(async ({signal}) => {
      signal.addEventListener(
        'abort',
        () => {
          nested = instance.dispose();
          aborted.resolve();
        },
        {once: true},
      );
      entered.resolve();
      await aborted.promise;
      return prepared;
    });
    const starting = instance.start(root(), context);
    await entered.promise;
    const closing = instance.dispose();
    const result = closing.then(
      () => true,
      () => false,
    );
    await withDeadline(aborted.promise, 'pipeline prepare abort', 2000);
    assert.strictEqual(nested, closing);
    await withDeadline(starting, 'pipeline aborted start', 2000);
    assert.equal(await withDeadline(result, 'pipeline aborted close', 2000), !failRelease);
    assert.equal(prepared.activate.mock.calls.length, 0);
    assert.equal(prepared.rollback.mock.calls.length, 1);
    assert.equal(prepared.release.mock.calls.length, 1);
    assert.equal(instance.getState().protocol.connected, false);
    assert.equal(instance.getState().adapter.providerCount, 0);
    broken = false;
    await instance.dispose();
    assert.equal(prepared.release.mock.calls.length, failRelease ? 2 : 1);
    assert.equal(prepared.rollback.mock.calls.length, 1);
    assert.equal(instance.hasPendingCleanup(), false);
  });
}
test('pipeline retains a factory cleanup failure returned after prepare abort', async () => {
  const entered = deferred(),
    aborted = deferred();
  let broken = true;
  const release = vi.fn(() => {
    if (broken) throw new Error('aborted factory cleanup failed');
  });
  const child = createDsl4CreationCleanup([release], 'factory cleanup');
  const errors: unknown[] = [];
  const failure = Object.assign(new Error('factory failed after abort'), {name: 'AbortError'});
  const instance = pipeline(
    async ({signal}) => {
      signal.addEventListener('abort', () => aborted.resolve(), {once: true});
      entered.resolve();
      await aborted.promise;
      await child.dispose().catch(() => {});
      throw new Dsl4CreationFailure(failure, child, 'factory failed');
    },
    {onError: (error) => errors.push(error)},
  );
  const starting = instance.start(root(), context);
  await entered.promise;
  const closing = assert.rejects(instance.dispose(), AggregateError);
  await withDeadline(Promise.all([starting, closing]), 'aborted factory cleanup', 2000);
  assert.equal(release.mock.calls.length, 1);
  assert.equal(instance.hasPendingCleanup(), true);
  assert.ok(errors.some((error) => getDsl4CreationCleanup(error) === child));
  assert.equal(instance.getState().adapter.providerCount, 0);
  broken = false;
  await instance.dispose();
  assert.equal(release.mock.calls.length, 2);
  assert.equal(child.hasPendingCleanup(), false);
  assert.equal(instance.hasPendingCleanup(), false);
});
test('real pipeline observer can await disposal from staged notification', async () => {
  const finished = deferred();
  const instance = pipeline(preparedFixture, {
    async onEvent(event) {
      if (event.type === 'preview.asset.staged') {
        await instance.dispose();
        finished.resolve();
      }
    },
  });
  await withDeadline(instance.start(root(), context), 'pipeline observer close', 3000);
  await withDeadline(finished.promise, 'pipeline observer completion', 3000);
  assert.equal(instance.getState().disposed, true);
  assert.equal(instance.getState().adapter.providerCount, 0);
  assert.equal(instance.hasPendingCleanup(), false);
});

test('Web shell explicitly retries a real pipeline generation release without reviving the disposed surface', async () => {
  const document = createFakeDocument(),
    value = preparedFixture();
  let broken = true;
  value.release.mockImplementation(() => {
    if (broken) throw new Error('generation release failed');
  });
  let hooks!: {onProjectRoot(root: unknown): unknown; onSourceResult(result: unknown): unknown};
  const shell = createDsl4WebPreviewShell({
    environment: 'development',
    document,
    mount: document.body,
    featureFlags: {
      dsl4Runtime: true,
      dsl4AppShell: true,
      dsl4WebPreviewAdapter: true,
      dsl4WebPreviewAssetLiveReload: true,
      dsl4PreviewReloadOverlay: true,
    },
    protocolSession: {},
    sessionId: 'cleanup-real-web',
    sourceFrontend: {parse() {}},
    maxSourceBytes: 8192,
    createCoordinator(options: typeof hooks) {
      hooks = options;
      return {
        start: (root: unknown) => options.onProjectRoot(root),
        openProject() {},
        restart() {},
        pollNow() {},
        commit() {},
        defer() {},
        dispose() {},
        getState: () => ({source: {started: false}, protocol: {}}),
        async whenIdle() {},
      };
    },
    assetPipelineOptions: {
      structuralFingerprint: sri('structure'),
      negotiatedCapabilities: dsl4AssetReloadProtocolCapabilities,
      adapterOptions: {
        subtleCrypto: webcrypto.subtle,
        inspectImage: () => ({width: 1, height: 1}),
        inspectAudio: () => ({}),
        watchOptions: {clock: clock()},
      },
      prepareGeneration: () => value,
      restartGeneration() {},
    },
  });
  assert.ok('whenIdle' in shell);
  await shell.start(root());
  await hooks.onSourceResult(context.sourceResult);
  await shell.whenIdle();
  assert.equal(value.activate.mock.calls.length, 1);
  await assert.rejects(shell.dispose(), AggregateError);
  assert.equal(shell.hasPendingCleanup(), true);
  assert.equal(value.release.mock.calls.length, 1);
  assert.equal(document.body.children.length, 0);
  broken = false;
  await shell.dispose();
  assert.equal(value.release.mock.calls.length, 2);
  assert.equal(shell.hasPendingCleanup(), false);
  assert.equal(document.body.children.length, 0);
});
