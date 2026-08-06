import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  createDsl4KamishibaiStructuredDataSession,
  createDsl4ObjectStore,
  createDsl4RuntimeController,
  createDsl4SourceFrontend,
} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);

function parseStory(source) {
  const parsed = frontend.parse(source, {sourceId: 'structured-runtime-test.kamishibai.yaml'});
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  return parsed.storyDocument;
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {promise, resolve};
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

const sequentialStory = `
kamishibai: '4.0'
scenes:
  opening:
    - wait: 0
    - goto: ending
  ending: []
`;

const cancellableStory = `
kamishibai: '4.0'
scenes:
  opening:
    - wait: 10
    - wait: 0
`;

function activeCounts(store) {
  const counts = store.debugSnapshot().counts;
  return {
    scopes: counts.scopes,
    entries: counts.entries,
    nodes: counts.nodes,
    leases: counts.leases,
    referenceEdges: counts.referenceEdges,
  };
}

test('dispatches stored typed actions with one ActionView scope and releases the story on finish', async () => {
  const storyDocument = parseStory(sequentialStory);
  const store = createDsl4ObjectStore();
  const integration = createDsl4KamishibaiStructuredDataSession({storyDocument, store});
  let observedResources;
  const controller = createDsl4RuntimeController({
    storyDocument,
    structuredDataIntegration: integration,
    port: {
      wait(_payload, context) {
        observedResources = context.structuredData;
        assert.equal(Object.isFrozen(observedResources), true);
        assert.equal(store.classifyHandle(observedResources.actionScopeRef).value.kind, 'scope');
        const actionView = store.readValue(observedResources.actionViewRef);
        assert.equal(actionView.ok, true);
        assert.equal(actionView.value.typeTag, 'kamishibai.actionView');
        assert.equal(actionView.value.value.name, 'wait');
        assert.equal(actionView.value.value.storyPath, '/scenes/opening/actions/0');
      },
    },
  });

  const finished = await controller.start();
  assert.equal(finished.status, 'finished');
  assert.ok(observedResources);
  assert.equal(store.classifyHandle(observedResources.actionViewRef).ok, false);
  assert.deepEqual(activeCounts(store), {
    scopes: 1,
    entries: 0,
    nodes: 0,
    leases: 0,
    referenceEdges: 0,
  });
  controller.dispose();
  assert.equal(store.debugSnapshot().counts.handles, 0);
});

test('advance releases a cancelled action before the next action and ignores stale settlement', async () => {
  const storyDocument = parseStory(cancellableStory);
  const store = createDsl4ObjectStore();
  const integration = createDsl4KamishibaiStructuredDataSession({storyDocument, store});
  const first = deferred();
  const resources = [];
  let calls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument,
    structuredDataIntegration: integration,
    port: {
      wait(_payload, context) {
        calls += 1;
        resources.push(context.structuredData);
        return calls === 1 ? first.promise : undefined;
      },
    },
  });

  const initialRun = controller.start();
  await waitUntil(() => calls === 1);
  assert.equal(store.classifyHandle(resources[0].actionViewRef).ok, true);
  const advanced = await controller.advance('test-advance');
  assert.equal(advanced.status, 'finished');
  assert.equal(calls, 2);
  assert.equal(store.classifyHandle(resources[0].actionViewRef).ok, false);
  assert.equal(store.classifyHandle(resources[1].actionViewRef).ok, false);
  assert.deepEqual(activeCounts(store), {
    scopes: 1,
    entries: 0,
    nodes: 0,
    leases: 0,
    referenceEdges: 0,
  });
  first.resolve();
  await initialRun;
  assert.equal(controller.getState().status, 'finished');
  controller.dispose();
});

test('navigate releases stale ownership and finished reposition opens a fresh typed story', async () => {
  const storyDocument = parseStory(sequentialStory);
  const store = createDsl4ObjectStore();
  const integration = createDsl4KamishibaiStructuredDataSession({storyDocument, store});
  const first = deferred();
  const resources = [];
  let waitCalls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument,
    structuredDataIntegration: integration,
    port: {
      wait(_payload, context) {
        waitCalls += 1;
        resources.push(context.structuredData);
        return waitCalls === 1 ? first.promise : undefined;
      },
    },
  });

  const initialRun = controller.start();
  await waitUntil(() => waitCalls === 1);
  const navigated = await controller.navigate('ending', {reason: 'test-navigate'});
  assert.equal(navigated.status, 'finished');
  assert.equal(store.classifyHandle(resources[0].actionViewRef).ok, false);

  const repositioned = controller.reposition('opening', {
    actionIndex: 0,
    reason: 'test-reposition',
  });
  assert.equal(repositioned.status, 'paused');
  assert.equal(repositioned.sceneId, 'opening');
  assert.equal(integration.debugSnapshot().story, 'active');
  assert.equal(integration.debugSnapshot().scene, 'active');

  const resumed = await controller.resume('test-resume');
  assert.equal(resumed.status, 'finished');
  assert.equal(waitCalls, 2);
  assert.notEqual(resources[1].actionViewRef, resources[0].actionViewRef);
  assert.equal(store.classifyHandle(resources[1].actionViewRef).ok, false);
  assert.deepEqual(activeCounts(store), {
    scopes: 1,
    entries: 0,
    nodes: 0,
    leases: 0,
    referenceEdges: 0,
  });

  first.resolve();
  await initialRun;
  assert.equal(controller.getState().status, 'finished');
  controller.dispose();
});

test('stop and action failure release story, scene, and action ownership exactly once', async () => {
  const storyDocument = parseStory(cancellableStory);
  {
    const store = createDsl4ObjectStore();
    const integration = createDsl4KamishibaiStructuredDataSession({storyDocument, store});
    const pending = deferred();
    let calls = 0;
    const controller = createDsl4RuntimeController({
      storyDocument,
      structuredDataIntegration: integration,
      port: {
        wait() {
          calls += 1;
          return pending.promise;
        },
      },
    });
    const run = controller.start();
    await waitUntil(() => calls === 1);
    assert.equal(controller.stop('test-stop').status, 'stopped');
    assert.deepEqual(activeCounts(store), {
      scopes: 1,
      entries: 0,
      nodes: 0,
      leases: 0,
      referenceEdges: 0,
    });
    pending.resolve();
    await run;
    controller.dispose();
  }

  {
    const store = createDsl4ObjectStore();
    const integration = createDsl4KamishibaiStructuredDataSession({storyDocument, store});
    const controller = createDsl4RuntimeController({
      storyDocument,
      structuredDataIntegration: integration,
      port: {
        wait() {
          throw Object.assign(new Error('injected failure'), {code: 'K4-INJECTED'});
        },
      },
    });
    const failed = await controller.start();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.diagnostic.code, 'K4-INJECTED');
    assert.deepEqual(activeCounts(store), {
      scopes: 1,
      entries: 0,
      nodes: 0,
      leases: 0,
      referenceEdges: 0,
    });
    controller.dispose();
  }
});

test('fails closed when action scope cleanup fails instead of committing the action', async () => {
  const storyDocument = parseStory(`kamishibai: '4.0'\nscenes:\n  opening:\n    - wait: 0\n`);
  let endCalls = 0;
  const integration = {
    beginStory() {},
    enterScene() {
      return {scene: storyDocument.scenes[0]};
    },
    beginNextAction() {
      return {
        status: 'item',
        index: 0,
        action: storyDocument.scenes[0].actions[0],
        resources: {actionScopeRef: '@test.scope', actionViewRef: '@test.action'},
      };
    },
    currentActionResources() {
      return {actionScopeRef: '@test.scope', actionViewRef: '@test.action'};
    },
    releaseAction() {
      throw Object.assign(new Error('cleanup failed'), {
        code: 'K4-STRUCTURED-DATA-CLEANUP-001',
      });
    },
    endStory() {
      endCalls += 1;
    },
    dispose() {},
  };
  const controller = createDsl4RuntimeController({
    storyDocument,
    structuredDataIntegration: integration,
    port: {wait() {}},
  });

  const failed = await controller.start();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.diagnostic.code, 'K4-STRUCTURED-DATA-CLEANUP-001');
  assert.equal(endCalls, 1);
  assert.equal(
    controller.getTrace().some((event) => event.type === 'action.commit'),
    false,
  );
  controller.dispose();
  assert.equal(endCalls, 1);
});
