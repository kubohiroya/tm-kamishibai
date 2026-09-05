import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4InputArbitration} from '../src/dsl4/index.js';

test('gives an exact active story key the only semantic claim', () => {
  const arbitration = createDsl4InputArbitration();
  const token = arbitration.beginStoryInput('key', ['Enter', 'ArrowRight']);

  assert.equal(arbitration.shouldDeferNavigationKey({code: 'Enter', historyPaused: false}), true);
  assert.equal(arbitration.shouldDeferNavigationKey({code: 'Space', historyPaused: false}), false);
  assert.equal(arbitration.shouldDeferNavigationKey({code: 'Enter', historyPaused: true}), false);
  assert.deepEqual(arbitration.getState(), {
    version: 1,
    disposed: false,
    activeStoryInputKind: 'key',
    activeStoryCandidateCount: 2,
    suppressPointerRelease: false,
  });

  assert.equal(arbitration.finishStoryInput(token, {accepted: true}), true);
  assert.equal(arbitration.shouldDeferNavigationKey({code: 'Enter', historyPaused: false}), false);
});

test('suppresses exactly one pointer release after an accepted actor touch', () => {
  const arbitration = createDsl4InputArbitration();
  const token = arbitration.beginStoryInput('touch', ['Hero']);

  assert.equal(
    arbitration.arbitrateNavigationPointer({pointerType: 'touch', historyPaused: true}),
    'allow',
  );
  assert.equal(
    arbitration.arbitrateNavigationPointer({pointerType: 'touch', historyPaused: false}),
    'defer',
  );
  arbitration.finishStoryInput(token, {accepted: true});
  assert.equal(
    arbitration.arbitrateNavigationPointer({pointerType: 'touch', historyPaused: false}),
    'suppress',
  );
  assert.equal(
    arbitration.arbitrateNavigationPointer({pointerType: 'touch', historyPaused: false}),
    'allow',
  );

  const cancelled = arbitration.beginStoryInput('touch', ['Door']);
  arbitration.finishStoryInput(cancelled, {accepted: true});
  arbitration.cancelNavigationPointer({pointerType: 'touch'});
  assert.equal(
    arbitration.arbitrateNavigationPointer({pointerType: 'touch', historyPaused: false}),
    'allow',
  );
});

test('ignores stale wait completion and clears every claim on dispose', () => {
  const arbitration = createDsl4InputArbitration();
  const stale = arbitration.beginStoryInput('touch', ['Hero']);
  const current = arbitration.beginStoryInput('key', ['Space']);

  assert.equal(arbitration.finishStoryInput(stale, {accepted: true}), false);
  assert.equal(arbitration.shouldDeferNavigationKey({code: 'Space', historyPaused: false}), true);
  arbitration.finishStoryInput(current);
  arbitration.dispose();
  arbitration.dispose();
  assert.deepEqual(arbitration.getState(), {
    version: 1,
    disposed: true,
    activeStoryInputKind: null,
    activeStoryCandidateCount: 0,
    suppressPointerRelease: false,
  });
  assert.throws(
    () => arbitration.shouldDeferNavigationKey({code: 'Space', historyPaused: false}),
    /disposed/u,
  );
});
