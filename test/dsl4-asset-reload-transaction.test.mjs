import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'vitest';

import {createDsl4AssetReloadTransaction} from '../src/dsl4/index.js';

function sri(value) {
  return `sha256-${createHash('sha256').update(value).digest('base64')}`;
}

function summary(revision, kind = 'asset-live-reload') {
  return {
    formatVersion: 1,
    revision,
    providerId: `asset-provider-${revision}`,
    sourceIntegrity: sri(`source-${revision}`),
    graphIntegrity: sri('graph'),
    contentIntegrity: sri(`content-${revision}`),
    classification: {
      kind,
      requiresFullRebuild: kind === 'full-rebuild',
      changedAssets:
        kind === 'initial'
          ? []
          : [
              {
                id: 'Picture',
                kind: 'image',
                change: kind === 'full-rebuild' ? 'removed' : 'content',
                fileCount: 1,
                beforeIntegrity: sri('before'),
                afterIntegrity: sri('after'),
              },
            ],
      affectedScenes: ['opening'],
    },
    validations: [{assetId: 'Picture', kind: 'image', fileCount: 1, width: 640, height: 480}],
  };
}

function fakeAdapter() {
  const providers = new Map();
  const accepted = [];
  const discarded = [];
  let disposed = 0;
  return {
    add(revision) {
      providers.set(revision, {
        providerId: `asset-provider-${revision}`,
        getFile() {
          return new Uint8Array([revision]);
        },
      });
    },
    getCandidateProvider(revision) {
      return providers.get(revision) ?? null;
    },
    accept(revision) {
      accepted.push(revision);
      providers.delete(revision);
    },
    discard(revision) {
      discarded.push(revision);
      providers.delete(revision);
    },
    dispose() {
      disposed += 1;
      providers.clear();
    },
    accepted,
    discarded,
    get disposed() {
      return disposed;
    },
  };
}

function prepared(revision, log, {activationError, rollbackError, releaseError} = {}) {
  return {
    activate() {
      log.push(`activate:${revision}`);
      if (activationError) throw activationError;
      return {actualAnchor: 'action'};
    },
    rollback(reason) {
      log.push(`rollback:${revision}:${reason}`);
      if (rollbackError) throw rollbackError;
    },
    release(reason) {
      log.push(`release:${revision}:${reason}`);
      if (releaseError) throw releaseError;
    },
  };
}

test('prepares complete generations and releases the previous one only after commit acknowledgement', async () => {
  const adapter = fakeAdapter();
  const log = [];
  const transaction = createDsl4AssetReloadTransaction({
    assetAdapter: adapter,
    prepareGeneration({summary: candidate, provider}) {
      log.push(`prepare:${candidate.revision}:${provider.providerId}`);
      return prepared(candidate.revision, log);
    },
    onEvent: (event) => log.push(`event:${event.type}:${event.revision}`),
  });

  adapter.add(1);
  await transaction.stage(summary(1, 'initial'));
  assert.equal(transaction.getState().status, 'ready');
  await transaction.commit(1, {requestedPreference: 'action'});
  assert.equal(transaction.getState().generation, 1);
  assert.deepEqual(adapter.accepted, [1]);

  adapter.add(2);
  await transaction.stage(summary(2));
  await transaction.commit(2, {requestedPreference: 'scene'});
  assert.equal(transaction.getState().generation, 2);
  assert.deepEqual(adapter.accepted, [1, 2]);
  assert.equal(
    log.indexOf('event:preview.asset.committed:2') <
      log.indexOf('release:1:generation-replaced-after-ack'),
    true,
  );
  assert.equal(JSON.stringify(transaction.getState()).includes('getFile'), false);
  await transaction.dispose();
  assert.equal(adapter.disposed, 1);
  assert.equal(log.includes('release:2:transaction-disposed'), true);
});

test('keeps a committed generation active when releasing its predecessor fails', async () => {
  const adapter = fakeAdapter();
  const events = [];
  const transaction = createDsl4AssetReloadTransaction({
    assetAdapter: adapter,
    prepareGeneration({summary: candidate}) {
      return prepared(candidate.revision, [], {
        ...(candidate.revision === 1 ? {releaseError: new Error('release failed')} : {}),
      });
    },
    onEvent: (event) => events.push(event),
  });
  adapter.add(1);
  await transaction.stage(summary(1, 'initial'));
  await transaction.commit(1);
  adapter.add(2);
  await transaction.stage(summary(2));
  const committed = await transaction.commit(2);
  assert.equal(committed.status, 'diagnostic');
  assert.equal(committed.active.revision, 2);
  assert.equal(committed.diagnostic.code, 'K4-ASSET-RELEASE-001');
  assert.equal(committed.pendingReleaseCount, 1);
  assert.equal(events.at(-1).type, 'preview.asset.committed');
  await assert.rejects(transaction.dispose(), /disposal failed/u);
});

test('keeps the active generation when activation fails and rolls back the candidate once', async () => {
  const adapter = fakeAdapter();
  const log = [];
  const diagnostics = [];
  const transaction = createDsl4AssetReloadTransaction({
    assetAdapter: adapter,
    prepareGeneration({summary: candidate}) {
      return prepared(candidate.revision, log, {
        ...(candidate.revision === 2 ? {activationError: new Error('activate failed')} : {}),
      });
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic?.code ?? null),
  });

  adapter.add(1);
  await transaction.stage(summary(1, 'initial'));
  await transaction.commit(1);
  adapter.add(2);
  await transaction.stage(summary(2));
  const failed = await transaction.commit(2);

  assert.equal(failed.status, 'diagnostic');
  assert.equal(failed.active.revision, 1);
  assert.deepEqual(adapter.accepted, [1]);
  assert.deepEqual(adapter.discarded, [2]);
  assert.equal(log.filter((entry) => entry === 'rollback:2:activation-failed').length, 1);
  assert.equal(log.filter((entry) => entry === 'release:2:activation-failed').length, 1);
  assert.equal(diagnostics.at(-1), 'K4-ASSET-PREPARE-001');
  await transaction.dispose();
});

test('fails closed for preparation, rollback, full rebuild, stale, and deferred candidates', async () => {
  const adapter = fakeAdapter();
  const log = [];
  const events = [];
  const transaction = createDsl4AssetReloadTransaction({
    assetAdapter: adapter,
    prepareGeneration({summary: candidate}) {
      if (candidate.revision === 1) throw new Error('decode failed');
      return prepared(candidate.revision, log, {
        ...(candidate.revision === 4
          ? {
              activationError: new Error('activate failed'),
              rollbackError: new Error('rollback failed'),
            }
          : {}),
      });
    },
    onEvent: (event) => events.push(event),
  });

  adapter.add(1);
  const prepareFailure = await transaction.stage(summary(1));
  assert.equal(prepareFailure.diagnostic.code, 'K4-ASSET-PREPARE-001');
  assert.deepEqual(adapter.discarded, [1]);

  adapter.add(2);
  await transaction.stage(summary(2));
  await transaction.defer(2);
  assert.equal(log.includes('rollback:2:candidate-deferred'), true);
  assert.deepEqual(adapter.discarded, [1, 2]);

  adapter.add(3);
  const rebuild = await transaction.stage(summary(3, 'full-rebuild'));
  assert.equal(rebuild.status, 'full-rebuild');
  assert.equal(rebuild.diagnostic.code, 'K4-ASSET-FULL-REBUILD-REQUIRED');
  assert.deepEqual(adapter.discarded, [1, 2, 3]);
  await assert.rejects(
    transaction.stage(summary(3)),
    (error) => error.code === 'K4-ASSET-STALE-001',
  );

  adapter.add(4);
  await transaction.stage(summary(4));
  await assert.rejects(transaction.commit(4), AggregateError);
  assert.equal(transaction.getState().diagnostic.code, 'K4-ASSET-ROLLBACK-001');
  assert.equal(
    events.some(({type}) => type === 'preview.asset.commit-failed'),
    true,
  );
  await transaction.dispose();
});

test('rejects malformed and raw-bearing summaries before accessing a provider', async () => {
  const adapter = fakeAdapter();
  const transaction = createDsl4AssetReloadTransaction({
    assetAdapter: adapter,
    prepareGeneration() {
      throw new Error('must not run');
    },
  });

  await assert.rejects(transaction.stage({...summary(1), providerId: '/private/project/file'}));
  await assert.rejects(transaction.stage({...summary(1), sourceIntegrity: 'not-an-integrity'}));
  assert.equal(transaction.getState().latestRevision, 0);
  await transaction.dispose();
});
