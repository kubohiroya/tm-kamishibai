import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'vitest';
import {fileURLToPath} from 'node:url';

import {
  createDsl4KamishibaiStructuredDataSession,
  createDsl4ObjectStore,
  createDsl4RuntimeController,
  createDsl4SourceFrontend,
} from '../src/dsl4/index.js';
import {deferred, waitUntil} from './helpers/async-test-helpers.ts';
import {okResult} from './helpers/result-outcome.ts';
import {requireDefined, requireRecord} from './helpers/require-value.ts';

/**
 * The story and resource shapes this suite reads.
 *
 * The frontend declares its document opaquely and the integration hands the port an opaque resource
 * record, so the members the cases walk into are named here once.
 */
interface StructuredStory extends Readonly<Record<string, unknown>> {
  scenes: {id: string; actions: Record<string, unknown>[]}[];
}

interface ActionResources {
  actionScopeRef: unknown;
  actionViewRef: unknown;
}

interface PortContext {
  structuredData: ActionResources;
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);

function parseStory(source: string): StructuredStory {
  const parsed = frontend.parse(source, {sourceId: 'structured-runtime-test.kamishibai.yaml'});
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  return requireRecord(parsed.storyDocument, 'the story document') as unknown as StructuredStory;
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

function activeCounts(store: {debugSnapshot(): {counts: Record<string, unknown>}}) {
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
  let observedResources: ActionResources | undefined;
  const controller = createDsl4RuntimeController({
    storyDocument,
    structuredDataIntegration: integration,
    port: {
      wait(_payload: unknown, context: PortContext) {
        observedResources = context.structuredData;
        assert.equal(Object.isFrozen(observedResources), true);
        const scope = requireRecord(
          okResult(
            store.classifyHandle(observedResources.actionScopeRef),
            'the action scope handle',
          ).value,
          'the action scope classification',
        );
        assert.equal(scope.kind, 'scope');
        const actionView = requireRecord(
          okResult(store.readValue(observedResources.actionViewRef), 'the stored ActionView').value,
          'the stored ActionView',
        );
        assert.equal(actionView.typeTag, 'kamishibai.actionView');
        const members = requireRecord(actionView.value, 'the ActionView members');
        assert.equal(members.name, 'wait');
        assert.equal(members.storyPath, '/scenes/opening/actions/0');
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
  const resources: ActionResources[] = [];
  let calls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument,
    structuredDataIntegration: integration,
    port: {
      wait(_payload: unknown, context: PortContext) {
        calls += 1;
        resources.push(context.structuredData);
        return calls === 1 ? first.promise : undefined;
      },
    },
  });

  const initialRun = controller.start();
  await waitUntil(() => calls === 1);
  assert.equal(
    store.classifyHandle(requireDefined(resources[0], 'the resources of action 0').actionViewRef)
      .ok,
    true,
  );
  const advanced = await controller.advance('test-advance');
  assert.equal(advanced.status, 'finished');
  assert.equal(calls, 2);
  assert.equal(
    store.classifyHandle(requireDefined(resources[0], 'the resources of action 0').actionViewRef)
      .ok,
    false,
  );
  assert.equal(
    store.classifyHandle(requireDefined(resources[1], 'the resources of action 1').actionViewRef)
      .ok,
    false,
  );
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
  const resources: ActionResources[] = [];
  let waitCalls = 0;
  const controller = createDsl4RuntimeController({
    storyDocument,
    structuredDataIntegration: integration,
    port: {
      wait(_payload: unknown, context: PortContext) {
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
  assert.equal(
    store.classifyHandle(requireDefined(resources[0], 'the resources of action 0').actionViewRef)
      .ok,
    false,
  );

  const invalid = controller.reposition('missing', {reason: 'test-invalid-reposition'});
  assert.equal(invalid.status, 'finished');
  assert.equal(invalid.diagnostic, null);
  assert.equal(integration.debugSnapshot().state, 'idle');

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
  assert.notEqual(
    requireDefined(resources[1], 'the resources of action 1').actionViewRef,
    requireDefined(resources[0], 'the resources of action 0').actionViewRef,
  );
  assert.equal(
    store.classifyHandle(requireDefined(resources[1], 'the resources of action 1').actionViewRef)
      .ok,
    false,
  );
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

test('advance fails closed when the next scene scope cannot be created', async () => {
  const storyDocument = parseStory(`
kamishibai: '4.0'
scenes:
  opening:
    - wait: 10
  ending: []
`);
  const backingStore = createDsl4ObjectStore();
  let sceneScopeCalls = 0;
  const failingStore = {
    rootScopeRef: backingStore.rootScopeRef,
    createScope(...args: Parameters<typeof backingStore.createScope>) {
      sceneScopeCalls += 1;
      if (sceneScopeCalls === 2) {
        return {ok: false, error: new Error('injected scene scope failure')};
      }
      return backingStore.createScope(...args);
    },
    createScopeBundle: backingStore.createScopeBundle,
    debugSnapshot: backingStore.debugSnapshot,
    disposeRealm: backingStore.disposeRealm,
    readValue: backingStore.readValue,
    releaseScope: backingStore.releaseScope,
  };
  const integration = createDsl4KamishibaiStructuredDataSession({
    storyDocument,
    store: failingStore,
  });
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

  const initialRun = controller.start();
  await waitUntil(() => calls === 1);
  const advanced = await controller.advance('test-cross-scene-failure');
  assert.equal(advanced.status, 'failed');
  assert.equal(
    requireRecord(advanced.diagnostic, 'the advance diagnostic').code,
    'K4-STRUCTURED-DATA-001',
  );
  assert.equal(integration.debugSnapshot().state, 'idle');
  assert.deepEqual(activeCounts(backingStore), {
    scopes: 1,
    entries: 0,
    nodes: 0,
    leases: 0,
    referenceEdges: 0,
  });
  pending.resolve();
  await initialRun;
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
    assert.equal(requireRecord(failed.diagnostic, 'the failure diagnostic').code, 'K4-INJECTED');
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
      return {scene: requireDefined(storyDocument.scenes[0], 'the opening scene')};
    },
    beginNextAction() {
      return {
        status: 'item',
        index: 0,
        action: requireDefined(
          requireDefined(storyDocument.scenes[0], 'the opening scene').actions[0],
          'its first action',
        ),
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
  assert.equal(
    requireRecord(failed.diagnostic, 'the failure diagnostic').code,
    'K4-STRUCTURED-DATA-CLEANUP-001',
  );
  assert.equal(endCalls, 1);
  assert.equal(
    controller
      .getTrace()
      .some((event) => requireRecord(event, 'a trace event').type === 'action.commit'),
    false,
  );
  controller.dispose();
  assert.equal(endCalls, 1);
});
