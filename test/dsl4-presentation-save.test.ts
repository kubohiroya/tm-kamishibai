import assert from 'node:assert/strict';
import {test} from 'vitest';
import {createDsl4PresentationSavePort} from '../src/dsl4/platform/presentation-save-port.js';
function fixture() {
  const log: unknown[] = [];
  const target = {
    isStage: false,
    x: 3,
    y: 4,
    size: 80,
    direction: 70,
    visible: true,
    currentCostume: 0,
    sprite: {costumes: [{name: 'base'}, {name: 'next'}]},
    effects: {ghost: 5},
    getLayerOrder: () => 2,
    setXY(x: number, y: number) {
      this.x = x;
      this.y = y;
    },
    setSize(size: number) {
      this.size = size;
    },
    setDirection(direction: number) {
      this.direction = direction;
    },
    setVisible(visible: boolean) {
      this.visible = visible;
    },
    setCostume(index: number) {
      this.currentCostume = index;
      log.push(['costume', index]);
    },
    setEffect(name: string, value: number) {
      Reflect.set(this.effects, name, value);
    },
    goToFront() {
      log.push('front');
    },
  };
  let binding: unknown = {Hero: 'base'};
  let fail = false;
  const port = createDsl4PresentationSavePort({
    targets: () => [{key: 'Hero', target}],
    video: () => null,
    bindings: {
      capture: () => structuredClone(binding),
      validate(input) {
        assert(input && typeof input === 'object');
      },
      async apply(input) {
        log.push(['binding', input]);
        if (fail) {
          fail = false;
          throw new Error('binding failed');
        }
        binding = structuredClone(input);
        target.size = 100;
      },
    },
  });
  return {
    target,
    port,
    log,
    fail: () => {
      fail = true;
    },
    binding: () => binding,
  };
}
test('rehydrates actor data, effects, costume and asset binding without replaying actions', async () => {
  const f = fixture(),
    saved = f.port.capturePresentationState();
  f.target.x = 20;
  f.target.size = 120;
  f.target.currentCostume = 1;
  f.target.effects.ghost = 60;
  const transaction = await f.port.prepareRestorePresentation(saved, {
    signal: new AbortController().signal,
  });
  await transaction.commit();
  await transaction.finalize();
  assert.equal(f.target.x, 3);
  assert.equal(f.target.size, 80);
  assert.equal(f.target.currentCostume, 0);
  assert.equal(f.target.effects.ghost, 5);
  assert.deepEqual(f.binding(), {Hero: 'base'});
});
test('partial asset binding failure rolls back actor and image state', async () => {
  const f = fixture(),
    saved = f.port.capturePresentationState();
  f.target.x = 60;
  f.target.size = 120;
  const transaction = await f.port.prepareRestorePresentation(saved, {});
  f.fail();
  await assert.rejects(transaction.commit() as Promise<void>, /binding failed/u);
  await transaction.rollback();
  assert.equal(f.target.x, 60);
  assert.equal(f.target.size, 120);
});
test('rejects missing costumes and duplicate targets before changing the native state', async () => {
  const f = fixture(),
    saved = f.port.capturePresentationState();
  await assert.rejects(
    f.port.prepareRestorePresentation(
      {...saved, targets: [{...saved.targets[0], costume: 'missing'}]},
      {},
    ),
    /not prepared/u,
  );
  await assert.rejects(
    f.port.prepareRestorePresentation(
      {...saved, targets: [saved.targets[0], saved.targets[0]]},
      {},
    ),
    /differs/u,
  );
  assert.equal(f.log.length, 0);
});

test('retains failed previous audio/animation cleanup after adoption for explicit finalize retry', async () => {
  let attempts = 0;
  const port = createDsl4PresentationSavePort({
    targets: () => [],
    video: () => null,
    finalizePrevious() {
      attempts++;
      if (attempts === 1) throw new Error('old audio stop failed');
    },
  });
  const tx = await port.prepareRestorePresentation({targets: [], videos: []}, {});
  await tx.commit();
  await assert.rejects(tx.finalize() as Promise<void>, /Previous presentation cleanup failed/u);
  await tx.finalize();
  await tx.finalize();
  assert.equal(attempts, 2);
});
