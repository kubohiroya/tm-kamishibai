import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4AssetSnapshotWatch, Dsl4AssetSnapshotWatchError} from '../src/dsl4/index.js';

function fakeClock() {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  return {
    now: () => now,
    sleep(delay) {
      now += delay;
      return Promise.resolve();
    },
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, {callback, delay});
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    timers,
  };
}

function reader(keys, releases = []) {
  let index = 0;
  return async () => {
    const key = keys[Math.min(index++, keys.length - 1)];
    if (key instanceof Error) throw key;
    return {
      key,
      value: {kind: 'asset-snapshot', key},
      release(reason) {
        releases.push([key, reason]);
      },
    };
  };
}

test('publishes only stable snapshots and swaps owned generations after acknowledgement', async () => {
  const clock = fakeClock();
  const events = [];
  const releases = [];
  const watch = createDsl4AssetSnapshotWatch({
    read: reader(['A', 'A', 'A', 'A', 'B', 'B'], releases),
    onCandidate: (event) => events.push(event),
    clock,
  });

  await watch.start({story: 1});
  assert.deepEqual(
    events.map(({key}) => key),
    ['A'],
  );
  assert.equal(watch.getState().status, 'candidate');
  await watch.accept(events[0].revision);
  assert.equal(watch.getState().activeKey, 'A');
  assert.equal(watch.getState().status, 'watching');

  await watch.pollNow();
  assert.deepEqual(
    events.map(({key}) => key),
    ['A'],
  );
  assert.equal(watch.getState().activeKey, 'A');

  await watch.update({story: 2});
  assert.deepEqual(
    events.map(({key}) => key),
    ['A', 'B'],
  );
  await watch.accept(events[1].revision);
  assert.equal(watch.getState().activeKey, 'B');
  assert.equal(
    releases.some(([key, reason]) => key === 'A' && reason === 'generation-replaced'),
    true,
  );
  assert.equal(clock.timers.size, 1);
});

test('retries mismatched double reads and exposes only the stable key', async () => {
  const clock = fakeClock();
  const events = [];
  const releases = [];
  const watch = createDsl4AssetSnapshotWatch({
    read: reader(['partial-1', 'partial-2', 'stable', 'stable'], releases),
    onCandidate: (event) => events.push(event),
    clock,
    quietWindowMs: 10,
    retryIntervalMs: 5,
    stabilityTimeoutMs: 30,
  });

  await watch.start({});
  assert.deepEqual(
    events.map(({key}) => key),
    ['stable'],
  );
  assert.equal(clock.now(), 25);
  assert.deepEqual(releases.slice(0, 3), [
    ['partial-1', 'unstable-read'],
    ['partial-2', 'unstable-read'],
    ['stable', 'stable-read-duplicate'],
  ]);
});

test('bounds an unstable source and recovers without replacing the active generation', async () => {
  const clock = fakeClock();
  const diagnostics = [];
  const events = [];
  let mode = 'unstable';
  let sequence = 0;
  const watch = createDsl4AssetSnapshotWatch({
    read() {
      if (mode === 'missing') {
        throw new Dsl4AssetSnapshotWatchError('K4-ASSET-MISSING', 'Referenced asset is missing');
      }
      const key = mode === 'unstable' ? `unstable-${sequence++}` : 'recovered';
      return {key, value: {key}, release() {}};
    },
    onCandidate: (event) => events.push(event),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic?.code ?? null),
    clock,
    quietWindowMs: 1,
    retryIntervalMs: 1,
    stabilityTimeoutMs: 2,
  });

  await watch.start({});
  assert.equal(watch.getState().status, 'diagnostic');
  assert.equal(watch.getState().diagnostic.code, 'K4-ASSET-UNSTABLE-001');
  mode = 'missing';
  await watch.pollNow();
  assert.equal(watch.getState().diagnostic.code, 'K4-ASSET-MISSING');
  mode = 'valid';
  await watch.pollNow();
  assert.deepEqual(
    events.map(({key}) => key),
    ['recovered'],
  );
  assert.equal(watch.getState().diagnostic, null);
  assert.deepEqual(diagnostics, ['K4-ASSET-UNSTABLE-001', 'K4-ASSET-MISSING', null]);
});

test('coalesces overlapping polls without overlapping reads', async () => {
  const clock = fakeClock();
  const events = [];
  let activeReads = 0;
  let maximumReads = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let reads = 0;
  const watch = createDsl4AssetSnapshotWatch({
    async read() {
      activeReads += 1;
      maximumReads = Math.max(maximumReads, activeReads);
      reads += 1;
      if (reads === 1) await firstGate;
      activeReads -= 1;
      const key = reads <= 2 ? 'A' : 'B';
      return {key, value: {key}, release() {}};
    },
    onCandidate: (event) => events.push(event),
    clock,
  });

  const first = watch.start({});
  const overlapping = watch.pollNow();
  releaseFirst();
  await Promise.all([first, overlapping]);
  assert.equal(maximumReads, 1);
  assert.deepEqual(
    events.map(({key}) => key),
    ['A', 'B'],
  );
  assert.equal(watch.getState().candidate.key, 'B');
});

test('discards stale candidates and releases every candidate and active generation once', async () => {
  const clock = fakeClock();
  const releases = [];
  const events = [];
  const watch = createDsl4AssetSnapshotWatch({
    read: reader(['A', 'A', 'B', 'B', 'C', 'C'], releases),
    onCandidate: (event) => events.push(event),
    clock,
  });

  await watch.start({});
  await assert.rejects(watch.accept(999), (error) => error.code === 'K4-ASSET-STALE-001');
  await watch.accept(events[0].revision);
  await watch.pollNow();
  await watch.discard(events[1].revision);
  assert.equal(
    releases.some(([key, reason]) => key === 'B' && reason === 'candidate-discarded'),
    true,
  );
  await watch.pollNow();
  await watch.setHidden(true);
  assert.equal([...clock.timers.values()][0].delay, 5_000);
  await watch.dispose();
  await watch.dispose();
  assert.equal(
    releases.filter(([key, reason]) => key === 'A' && reason === 'watch-disposed').length,
    1,
  );
  assert.equal(
    releases.filter(([key, reason]) => key === 'C' && reason === 'watch-disposed').length,
    1,
  );
  assert.equal(watch.getState().status, 'disposed');
  assert.equal(clock.timers.size, 0);
});

test('rejects malformed limits, readers, callbacks, and inactive operations', async () => {
  assert.throws(() => createDsl4AssetSnapshotWatch(), TypeError);
  assert.throws(
    () => createDsl4AssetSnapshotWatch({read() {}, onCandidate() {}, foregroundIntervalMs: 0}),
    TypeError,
  );
  const watch = createDsl4AssetSnapshotWatch({
    read: reader(['A', 'A']),
    onCandidate() {},
    clock: fakeClock(),
  });
  assert.throws(() => watch.pollNow(), TypeError);
  await assert.rejects(watch.accept(1), (error) => error.code === 'K4-ASSET-STALE-001');
  await watch.start({});
  assert.throws(() => watch.start({}), TypeError);
  await assert.rejects(watch.setHidden('yes'), TypeError);
});
