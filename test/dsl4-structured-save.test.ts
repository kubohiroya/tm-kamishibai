import assert from 'node:assert/strict';
import {test} from 'vitest';
import {createDsl4RuntimeController} from '../src/dsl4/runtime-controller.js';
import {createDsl4KamishibaiStructuredDataSession} from '../src/dsl4/kamishibai-structured-data.js';
import {dsl4TestSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';
const parsed = frontend.parse(
  "kamishibai: '4.0'\nvariables: {score: 1}\nscenes: {opening: [{wait: 30}, {wait: 30}]}",
);
assert(parsed.ok);
const storyDocument = parsed.storyDocument;
// Legacy checkpoints omit the built-in variable; restoration must supply its default.
const checkpoint = {
  sceneId: 'opening',
  actionIndex: 0,
  variables: {score: 8},
  status: 'paused',
} as const;
const signal = () => new AbortController().signal;
const wait = (_payload: unknown, ctx: unknown) =>
  new Promise<void>((resolve) =>
    (ctx as {signal: AbortSignal}).signal.addEventListener('abort', () => resolve(), {once: true}),
  );
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

test('adopts isolated Structured Data before notification and retries retired owner disposal', async () => {
  const original = createDsl4KamishibaiStructuredDataSession({storyDocument});
  let fail = true;
  let created: ReturnType<typeof createDsl4KamishibaiStructuredDataSession> | undefined;
  const controller = createDsl4RuntimeController({
    storyDocument,
    port: {wait},
    structuredDataIntegration: {
      ...original,
      dispose() {
        if (fail) throw new Error('old scope disposal failed');
        original.dispose();
      },
    },
    createRestoreStructuredDataIntegration() {
      created = createDsl4KamishibaiStructuredDataSession({storyDocument});
      return created;
    },
  });
  void controller.start({variables: {score: 2}});
  await flush();
  await controller.quiesce({candidateId: 1, mode: 'cancel-replay-safe'});
  const prepared = await controller.prepareRestoreCheckpoint(checkpoint, signal());
  assert.deepEqual(controller.getState().variables, {startSceneIndex: 1, score: 2});
  await prepared.commit();
  assert.deepEqual(controller.getState().variables, {startSceneIndex: 1, score: 8});
  assert.throws(() => prepared.finalize(), /old scope disposal/u);
  assert(controller.hasPendingRestoreCleanup());
  fail = false;
  controller.retryRestoreCleanup();
  assert.equal(controller.hasPendingRestoreCleanup(), false);
  void controller.resume();
  await flush();
  assert.equal(controller.getState().status, 'running');
  controller.dispose();
  assert.equal(created?.debugSnapshot().state, 'disposed');
});
test('preparation and child cleanup failures leave the old scope usable with explicit retry', async () => {
  const original = createDsl4KamishibaiStructuredDataSession({storyDocument});
  let fail = true;
  const child = createDsl4KamishibaiStructuredDataSession({storyDocument});
  const controller = createDsl4RuntimeController({
    storyDocument,
    port: {wait},
    structuredDataIntegration: original,
    createRestoreStructuredDataIntegration() {
      return {
        ...child,
        enterScene(...args) {
          child.enterScene(...args);
          throw new Error('prepare failed');
        },
        dispose() {
          if (fail) throw new Error('child cleanup failed');
          child.dispose();
        },
      };
    },
  });
  void controller.start({variables: {score: 2}});
  await flush();
  await controller.quiesce({candidateId: 1, mode: 'cancel-replay-safe'});
  await assert.rejects(
    controller.prepareRestoreCheckpoint(checkpoint, signal()),
    /preparation and cleanup/u,
  );
  assert.deepEqual(controller.getState().variables, {startSceneIndex: 1, score: 2});
  assert(controller.hasPendingRestoreCleanup());
  await controller.resumeQuiesce(1);
  await flush();
  assert.equal(controller.getState().status, 'running');
  fail = false;
  controller.retryRestoreCleanup();
  assert.equal(controller.hasPendingRestoreCleanup(), false);
  controller.dispose();
});
test('synchronous factory disposal retains a late failed candidate for another explicit dispose', async () => {
  let fail = true;
  const original = createDsl4KamishibaiStructuredDataSession({storyDocument});
  const child = createDsl4KamishibaiStructuredDataSession({storyDocument});
  const controller: ReturnType<typeof createDsl4RuntimeController> = createDsl4RuntimeController({
    storyDocument,
    port: {wait},
    structuredDataIntegration: original,
    createRestoreStructuredDataIntegration() {
      controller.dispose();
      return {
        ...child,
        dispose() {
          if (fail) throw new Error('late cleanup failed');
          child.dispose();
        },
      };
    },
  });
  await assert.rejects(
    controller.prepareRestoreCheckpoint(checkpoint, signal()),
    /preparation and cleanup/u,
  );
  assert(controller.hasPendingRestoreCleanup());
  fail = false;
  controller.dispose();
  assert.equal(controller.hasPendingRestoreCleanup(), false);
});
