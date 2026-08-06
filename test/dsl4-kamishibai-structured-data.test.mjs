import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDsl4KamishibaiStructuredDataSession,
  createDsl4ObjectStore,
  createDsl4SceneActionIterator,
  createDsl4StoryIterator,
} from '../src/dsl4/index.js';

const story = Object.freeze({
  kind: 'StoryDocument',
  version: '4.0',
  scenes: Object.freeze([
    Object.freeze({
      id: 'opening',
      actions: Object.freeze([
        Object.freeze({
          id: '/scenes/opening/actions/0',
          command: 'wait',
          handler: 'core',
          target: null,
          args: Object.freeze({seconds: 1}),
        }),
        Object.freeze({
          id: '/scenes/opening/actions/1',
          command: 'goto',
          handler: 'core',
          target: null,
          args: Object.freeze({scene: 'ending'}),
        }),
      ]),
    }),
    Object.freeze({id: 'ending', actions: Object.freeze([])}),
  ]),
  variables: Object.freeze({}),
  sourceMap: Object.freeze({}),
  metadata: Object.freeze({sourceId: 'typed-iterator-test'}),
});

test('iterates typed scenes and actions without JSONPath and releases deterministically', () => {
  const mutableStory = {
    kind: 'StoryDocument',
    version: '4.0',
    scenes: [
      {id: 'one', actions: [{id: '/one/0', command: 'wait', target: null, args: {seconds: 1}}]},
      {id: 'two', actions: []},
    ],
  };
  const storyIterator = createDsl4StoryIterator(mutableStory);
  assert.equal(Object.isFrozen(mutableStory), false);
  assert.deepEqual(storyIterator.getState(), {state: 'ready', position: -1, length: 2});
  assert.equal(storyIterator.next().scene.id, 'one');
  assert.equal(storyIterator.select('two').scene.id, 'two');
  assert.equal(storyIterator.next().status, 'done');
  assert.equal(storyIterator.next().status, 'done');
  assert.equal(storyIterator.release(), true);
  assert.equal(storyIterator.release(), false);
  assert.throws(() => storyIterator.next(), /released/u);
  assert.equal(Object.isFrozen(mutableStory), false);
  assert.equal(Object.isFrozen(mutableStory.scenes[0]), false);

  const actions = createDsl4SceneActionIterator(story.scenes[0], {startIndex: 1});
  assert.equal(actions.next().action.command, 'goto');
  assert.equal(actions.next().status, 'done');
  assert.equal(actions.next().status, 'done');
  assert.equal(actions.release(), true);
  assert.throws(() => actions.current(), /released/u);
  assert.throws(
    () => createDsl4SceneActionIterator(story.scenes[0], {startIndex: 2}),
    /startIndex/u,
  );
});

test('rejects duplicate scene ids before selecting an ambiguous typed scene', () => {
  const scene = {id: 'opening', actions: []};
  assert.throws(
    () =>
      createDsl4StoryIterator({
        kind: 'StoryDocument',
        version: '4.0',
        scenes: [scene, {...scene}],
      }),
    /scene id is duplicated/u,
  );
});

test('owns StoryDocument, scene, and ActionView in nested scopes with no orphan', () => {
  const store = createDsl4ObjectStore();
  const session = createDsl4KamishibaiStructuredDataSession({storyDocument: story, store});

  assert.equal(session.beginStory(), true);
  assert.deepEqual(session.debugSnapshot().counts, {
    scopes: 2,
    entries: 1,
    nodes: 28,
    leases: 0,
    handles: 3,
    tombstones: 0,
    referenceEdges: 0,
  });
  assert.equal(session.enterScene('opening').scene.id, 'opening');
  const first = session.beginNextAction();
  assert.equal(first.status, 'item');
  assert.equal(first.index, 0);
  assert.equal(first.action.command, 'wait');
  assert.deepEqual(session.currentActionResources(), first.resources);
  assert.equal(store.classifyHandle(first.resources.actionScopeRef).value.kind, 'scope');
  const actionView = store.readValue(first.resources.actionViewRef);
  assert.equal(actionView.ok, true);
  assert.equal(actionView.value.typeTag, 'kamishibai.actionView');
  assert.deepEqual(actionView.value.value, {
    kind: 'ActionView',
    version: 1,
    name: 'wait',
    target: null,
    arguments: {seconds: 1},
    storyPath: '/scenes/opening/actions/0',
  });

  assert.equal(session.releaseAction(), true);
  assert.equal(session.releaseAction(), false);
  assert.equal(session.currentActionResources(), null);
  const second = session.beginNextAction();
  assert.equal(second.action.command, 'goto');
  assert.equal(session.beginNextAction().status, 'done');
  assert.equal(session.enterScene('ending').scene.id, 'ending');
  assert.equal(session.beginNextAction().status, 'done');
  assert.equal(session.endStory(), true);
  assert.equal(session.endStory(), false);
  const endedCounts = session.debugSnapshot().counts;
  assert.deepEqual(
    {
      scopes: endedCounts.scopes,
      entries: endedCounts.entries,
      nodes: endedCounts.nodes,
      leases: endedCounts.leases,
      referenceEdges: endedCounts.referenceEdges,
    },
    {
      scopes: 1,
      entries: 0,
      nodes: 0,
      leases: 0,
      referenceEdges: 0,
    },
  );
  assert.equal(endedCounts.handles, endedCounts.tombstones + 1);

  assert.equal(session.beginStory(), true);
  session.enterScene('opening', {actionIndex: 1});
  assert.equal(session.beginNextAction().action.command, 'goto');
  assert.equal(session.dispose(), true);
  assert.equal(session.dispose(), false);
  assert.deepEqual(store.debugSnapshot().counts, {
    scopes: 0,
    entries: 0,
    nodes: 0,
    leases: 0,
    handles: 0,
    tombstones: 0,
    referenceEdges: 0,
  });
});

test('rejects invalid typed positions without partially changing Store ownership', () => {
  const store = createDsl4ObjectStore();
  const session = createDsl4KamishibaiStructuredDataSession({storyDocument: story, store});
  session.beginStory();
  const before = store.debugSnapshot();
  assert.throws(
    () => session.enterScene('missing'),
    (error) => {
      assert.equal(error.code, 'K4-STRUCTURED-DATA-SCENE-001');
      return true;
    },
  );
  assert.deepEqual(store.debugSnapshot(), before);
  assert.throws(() => session.enterScene('opening', {actionIndex: 99}), /startIndex/u);
  assert.deepEqual(store.debugSnapshot(), before);
  session.dispose();
});

test('fails closed without a resumable partial Iterator when scoped Store creation fails', () => {
  const sizingStore = createDsl4ObjectStore();
  const sizingSession = createDsl4KamishibaiStructuredDataSession({
    storyDocument: story,
    store: sizingStore,
  });
  sizingSession.beginStory();
  const storyNodeCount = sizingStore.debugSnapshot().counts.nodes;
  sizingSession.dispose();

  const limitedStore = createDsl4ObjectStore({limits: {maxNodes: storyNodeCount}});
  const limitedSession = createDsl4KamishibaiStructuredDataSession({
    storyDocument: story,
    store: limitedStore,
  });
  limitedSession.beginStory();
  limitedSession.enterScene('opening');
  assert.throws(
    () => limitedSession.beginNextAction(),
    (error) => {
      assert.equal(error.code, 'K4-STRUCTURED-DATA-001');
      return true;
    },
  );
  assert.equal(limitedSession.debugSnapshot().state, 'idle');
  assert.deepEqual(limitedSession.debugSnapshot().counts, {
    scopes: 1,
    entries: 0,
    nodes: 0,
    leases: 0,
    handles: 4,
    tombstones: 3,
    referenceEdges: 0,
  });
  limitedSession.dispose();

  const backingStore = createDsl4ObjectStore();
  let sceneScopeCalls = 0;
  const failingStore = {
    rootScopeRef: backingStore.rootScopeRef,
    createScope(...args) {
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
  const failingSession = createDsl4KamishibaiStructuredDataSession({
    storyDocument: story,
    store: failingStore,
  });
  failingSession.beginStory();
  failingSession.enterScene('opening');
  assert.throws(
    () => failingSession.enterScene('ending'),
    (error) => {
      assert.equal(error.code, 'K4-STRUCTURED-DATA-001');
      return true;
    },
  );
  assert.equal(failingSession.debugSnapshot().state, 'idle');
  assert.equal(failingSession.debugSnapshot().counts.scopes, 1);
  assert.equal(failingSession.debugSnapshot().counts.entries, 0);
  assert.equal(failingSession.debugSnapshot().counts.nodes, 0);
  failingSession.dispose();
});
