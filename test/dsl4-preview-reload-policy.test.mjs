import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4PreviewReloadPolicy, resolveDsl4ReloadAnchor} from '../src/dsl4/index.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, reject, resolve};
}

function clock() {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, {callback, due: now + delay});
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.due > now) continue;
        timers.delete(id);
        timer.callback();
      }
      await Promise.resolve();
    },
  };
}

function availability({action = true, replaySafe = true, scene = true} = {}) {
  return {
    story: {available: true, reason: null},
    scene: {available: scene, reason: scene ? null : 'The current scene is unavailable.'},
    action: {
      available: action,
      replaySafe,
      reason: action ? null : 'The current action anchor is unavailable.',
    },
  };
}

function candidate(revision, overrides = {}) {
  return {
    revision,
    availability: availability(),
    summary: {category: 'source', changedIds: [`scene-${revision}`]},
    initiatingInputId: null,
    ...overrides,
  };
}

function policy({apply, restart, inputClock = clock()} = {}) {
  const applies = [];
  const restarts = [];
  const states = [];
  const instance = createDsl4PreviewReloadPolicy({
    clock: inputClock,
    applyGeneration: async (request) => {
      applies.push(request);
      if (apply) return apply(request);
      return {
        revision: request.revision,
        actualAnchor: request.actualAnchor,
        fallbackReason: request.fallbackReason,
      };
    },
    restartGeneration: async (request) => {
      restarts.push(request);
      if (restart) return restart(request);
      return {
        revision: request.revision,
        actualAnchor: request.actualAnchor,
        fallbackReason: request.fallbackReason,
      };
    },
    onState: (state) => states.push(state),
  });
  return {applies, clock: inputClock, instance, restarts, states};
}

test('resolves replay-safe action, scene, and story fallback without changing the request', () => {
  assert.deepEqual(
    resolveDsl4ReloadAnchor({requestedPreference: 'action', availability: availability()}),
    {requestedPreference: 'action', actualAnchor: 'action', fallbackReason: null},
  );
  assert.deepEqual(
    resolveDsl4ReloadAnchor({
      requestedPreference: 'action',
      availability: availability({replaySafe: false}),
    }),
    {
      requestedPreference: 'action',
      actualAnchor: 'scene',
      fallbackReason: 'The current action is not replay-safe.',
    },
  );
  assert.equal(
    resolveDsl4ReloadAnchor({
      requestedPreference: 'action',
      availability: availability({action: false, scene: false}),
    }).actualAnchor,
    'story',
  );
  assert.equal(
    resolveDsl4ReloadAnchor({
      requestedPreference: 'scene',
      availability: availability({scene: false}),
    }).actualAnchor,
    'story',
  );
});

test('auto-applies a valid generation, records actual fallback and acknowledges only after commit', async () => {
  const setup = policy();
  await setup.instance.submitCandidate(
    candidate(1, {
      availability: availability({replaySafe: false}),
      initiatingInputId: 'save-key-1',
    }),
  );
  const state = setup.instance.getState();
  assert.equal(state.status, 'reloaded');
  assert.equal(state.preference, 'action');
  assert.equal(state.lastSuccess.requestedPreference, 'action');
  assert.equal(state.lastSuccess.actualAnchor, 'scene');
  assert.equal(state.lastSuccess.fallbackReason, 'The current action is not replay-safe.');
  assert.equal(setup.applies.length, 1);

  await setup.instance.acknowledge({inputId: 'save-key-1'});
  await setup.clock.advance(1_999);
  assert.equal(setup.instance.getState().status, 'reloaded');
  await setup.instance.acknowledge({inputId: 'next-key'});
  assert.equal(setup.instance.getState().status, 'reloaded');
  await setup.clock.advance(1);
  assert.equal(setup.instance.getState().status, 'watching');
});

test('coalesces queued rapid saves and serializes a newer generation arriving during apply', async () => {
  const firstGate = deferred();
  const started = deferred();
  const setup = policy({
    async apply(request) {
      if (request.revision === 3) {
        started.resolve();
        await firstGate.promise;
      }
      return {
        revision: request.revision,
        actualAnchor: request.actualAnchor,
        fallbackReason: request.fallbackReason,
      };
    },
  });

  const skipped = setup.instance.submitCandidate(candidate(1));
  const adopted = setup.instance.submitCandidate(candidate(2));
  await Promise.all([skipped, adopted]);
  assert.deepEqual(
    setup.applies.map(({revision}) => revision),
    [2],
  );

  const applying = setup.instance.submitCandidate(candidate(3));
  await started.promise;
  const queued = setup.instance.submitCandidate(candidate(4));
  assert.equal(setup.instance.getState().status, 'applying');
  firstGate.resolve();
  await Promise.all([applying, queued]);
  assert.deepEqual(
    setup.applies.map(({revision}) => revision),
    [2, 3, 4],
  );
  assert.equal(setup.instance.getState().latestAppliedRevision, 4);
  assert.throws(
    () => setup.instance.submitCandidate(candidate(4)),
    (error) => error.code === 'K4-PREVIEW-RELOAD-STALE-001',
  );
});

test('keeps position selection side-effect free and separates every manual scope', async () => {
  let failRestart = false;
  const setup = policy({
    restart(request) {
      if (failRestart) throw new Error('manual failed');
      return {
        revision: request.revision,
        actualAnchor: request.actualAnchor,
        fallbackReason: request.fallbackReason,
      };
    },
  });
  await setup.instance.submitCandidate(candidate(1));

  await setup.instance.openDialog();
  await setup.instance.selectPosition('scene');
  assert.equal(setup.restarts.length, 0);
  assert.equal(setup.instance.getState().preference, 'action');
  await setup.instance.applyScope('save-next');
  assert.equal(setup.restarts.length, 0);
  assert.equal(setup.instance.getState().preference, 'scene');

  await setup.instance.openDialog();
  await setup.instance.selectPosition('story');
  await setup.instance.applyScope('reload-once');
  assert.equal(setup.restarts.length, 1);
  assert.equal(setup.instance.getState().preference, 'scene');

  await setup.instance.openDialog();
  await setup.instance.selectPosition('action');
  await setup.instance.applyScope('reload-and-save');
  assert.equal(setup.instance.getState().preference, 'action');

  failRestart = true;
  await setup.instance.openDialog();
  await setup.instance.selectPosition('story');
  await setup.instance.applyScope('reload-and-save');
  assert.equal(setup.instance.getState().preference, 'action');
  assert.equal(setup.instance.getState().status, 'diagnostic');

  await setup.instance.openDialog();
  await setup.instance.selectPosition('scene');
  await setup.instance.applyScope('cancel');
  assert.equal(setup.instance.getState().preference, 'action');
});

test('marks an open dialog stale and gives diagnostics priority over success and acknowledgement', async () => {
  const setup = policy();
  await setup.instance.submitCandidate(candidate(1));
  await setup.instance.openDialog();
  await setup.instance.selectPosition('action');
  const newer = setup.instance.submitCandidate(candidate(2));
  const during = setup.instance.getState();
  assert.equal(during.dialog.step, 'position');
  assert.equal(during.dialog.stale, true);
  assert.equal(during.dialog.targetRevision, 2);
  await newer;

  await setup.instance.setDiagnostic({
    code: 'K4-ASSET-MISSING',
    severity: 'error',
    message: 'Referenced asset is missing.',
  });
  assert.equal(setup.instance.getState().status, 'diagnostic');
  await setup.instance.acknowledge({inputId: 'ordinary-key'});
  await setup.clock.advance(5_000);
  assert.equal(setup.instance.getState().status, 'diagnostic');
  await setup.instance.setDiagnostic(null);
  assert.equal(setup.instance.getState().status, 'reloaded');
});

test('fails closed for malformed candidates, anchors, callbacks, scopes, and acknowledgements', async () => {
  assert.throws(
    () =>
      createDsl4PreviewReloadPolicy({
        applyGeneration() {},
      }),
    TypeError,
  );
  assert.throws(
    () => resolveDsl4ReloadAnchor({requestedPreference: 'action', availability: {}}),
    TypeError,
  );
  const setup = policy({
    apply: () => ({revision: 999, actualAnchor: 'action', fallbackReason: null}),
  });
  await setup.instance.submitCandidate(candidate(1));
  assert.equal(setup.instance.getState().status, 'diagnostic');
  assert.throws(() => setup.instance.applyScope('unknown'), TypeError);
  await setup.instance.dispose();
});
