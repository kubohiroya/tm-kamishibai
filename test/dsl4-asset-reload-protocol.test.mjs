import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDsl4AssetReloadProtocolSession,
  dsl4AssetReloadProtocolCapabilities,
} from '../src/dsl4/index.js';

function transaction() {
  let state = {
    latestRevision: 0,
    status: 'idle',
    candidate: null,
    active: null,
    diagnostic: null,
  };
  const calls = [];
  return {
    stage(summary) {
      calls.push(['stage', summary.revision]);
      state = {
        ...state,
        latestRevision: summary.revision,
        status: 'ready',
        candidate: {revision: summary.revision, providerId: summary.providerId},
      };
      return state;
    },
    failClosed(summary) {
      calls.push(['failClosed', summary.revision]);
      state = {
        ...state,
        latestRevision: summary.revision,
        status: 'full-rebuild',
        candidate: null,
        diagnostic: {code: 'K4-ASSET-FULL-REBUILD-REQUIRED'},
      };
      return state;
    },
    commit(revision, request) {
      calls.push(['commit', revision, request]);
      state = {
        ...state,
        status: 'active',
        candidate: null,
        active: {revision, generation: 1},
        diagnostic: null,
      };
      return state;
    },
    defer(revision) {
      calls.push(['defer', revision]);
      state = {...state, status: 'idle', candidate: null};
      return state;
    },
    getState: () => state,
    whenIdle: () => state,
    calls,
  };
}

function candidate(revision) {
  return {revision, providerId: `asset-provider-${revision}`};
}

test('serializes negotiated asset stage and commit messages for one preview session', async () => {
  const reload = transaction();
  const protocol = createDsl4AssetReloadProtocolSession({
    transaction: reload,
    sessionId: 'preview-1',
    negotiatedCapabilities: dsl4AssetReloadProtocolCapabilities,
  });

  const staged = await protocol.stage({
    type: 'preview.asset.stage',
    sessionId: 'preview-1',
    summary: candidate(1),
  });
  assert.equal(staged.type, 'preview.asset.staged');
  assert.equal(staged.candidate.revision, 1);
  const committed = await protocol.commit({
    type: 'preview.asset.commit',
    sessionId: 'preview-1',
    revision: 1,
    request: {requestedPreference: 'action'},
  });
  assert.equal(committed.type, 'preview.asset.committed');
  assert.deepEqual(reload.calls, [
    ['stage', 1],
    ['commit', 1, {requestedPreference: 'action'}],
  ]);
  assert.equal(protocol.getState().candidateRevision, null);
});

test('fails closed when any optional asset capability is absent', async () => {
  const reload = transaction();
  const protocol = createDsl4AssetReloadProtocolSession({
    transaction: reload,
    sessionId: 'preview-1',
    negotiatedCapabilities: dsl4AssetReloadProtocolCapabilities.filter(
      (capability) => capability !== 'asset.commit.v1',
    ),
  });

  const fallback = await protocol.stage({
    type: 'preview.asset.stage',
    sessionId: 'preview-1',
    summary: candidate(1),
  });
  assert.equal(fallback.type, 'preview.asset.fallback');
  assert.equal(fallback.diagnostic.code, 'K4-ASSET-FULL-REBUILD-REQUIRED');
  assert.deepEqual(reload.calls, [['failClosed', 1]]);
  await assert.rejects(
    protocol.commit({
      type: 'preview.asset.commit',
      sessionId: 'preview-1',
      revision: 1,
    }),
    (error) => error.code === 'K4-ASSET-PROTOCOL-CAPABILITY',
  );
});

test('rejects stale sessions, revisions, unknown keys, and discards on disconnect', async () => {
  const reload = transaction();
  const protocol = createDsl4AssetReloadProtocolSession({
    transaction: reload,
    sessionId: 'preview-1',
    negotiatedCapabilities: dsl4AssetReloadProtocolCapabilities,
  });

  await assert.rejects(
    protocol.stage({type: 'preview.asset.stage', sessionId: 'stale', summary: candidate(1)}),
    (error) => error.code === 'K4-ASSET-PROTOCOL-SESSION',
  );
  await assert.rejects(
    protocol.stage({
      type: 'preview.asset.stage',
      sessionId: 'preview-1',
      summary: candidate(1),
      rawBytes: [1, 2, 3],
    }),
    (error) => error.code === 'K4-ASSET-PROTOCOL-SCHEMA',
  );
  await protocol.stage({
    type: 'preview.asset.stage',
    sessionId: 'preview-1',
    summary: candidate(2),
  });
  await assert.rejects(
    protocol.defer({type: 'preview.asset.defer', sessionId: 'preview-1', revision: 1}),
    (error) => error.code === 'K4-ASSET-STALE-001',
  );
  await protocol.disconnect();
  assert.deepEqual(reload.calls.slice(-2), [
    ['stage', 2],
    ['defer', 2],
  ]);
  await assert.rejects(
    protocol.stage({type: 'preview.asset.stage', sessionId: 'preview-1', summary: candidate(3)}),
    (error) => error.code === 'K4-ASSET-PROTOCOL-DISCONNECTED',
  );
});
