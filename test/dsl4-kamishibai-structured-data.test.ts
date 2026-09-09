import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
  createDsl4KamishibaiStructuredDataSession,
  createDsl4ObjectStore,
  createDsl4SceneActionIterator,
  createDsl4StoryIterator,
} from '../src/dsl4/index.js';
import {thrown} from './helpers/thrown-error.ts';
import {requireDefined, requireNumber, requireRecord} from './helpers/require-value.ts';
import {okResult} from './helpers/result-outcome.ts';

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

/**
 * Readers for the steps an iterator or a session produces.
 *
 * A step is either `{status: 'done'}` or the item it produced, and the session declares its own
 * steps with `status` widened to `string`, so neither narrows on its own. Each reader asserts the
 * status the case expects -- the assertion the case used to make on the line before -- and names
 * the members that step carries.
 */
function sceneStep(step: unknown, description: string) {
  const record = requireRecord(step, description);
  assert.equal(record.status, 'item', `${description} was expected to produce a scene`);
  return record as unknown as {index: number; scene: {id: string}};
}

function actionStep(step: unknown, description: string) {
  const record = requireRecord(step, description);
  assert.equal(record.status, 'item', `${description} was expected to produce an action`);
  return record as unknown as {
    index: number;
    action: {command: string};
    resources: {actionScopeRef: unknown; actionViewRef: unknown};
  };
}

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
  assert.equal(sceneStep(storyIterator.next(), 'the next step').scene.id, 'one');
  assert.equal(sceneStep(storyIterator.select('two'), 'the selected scene').scene.id, 'two');
  assert.equal(storyIterator.next().status, 'done');
  assert.equal(storyIterator.next().status, 'done');
  assert.equal(storyIterator.release(), true);
  assert.equal(storyIterator.release(), false);
  assert.throws(() => storyIterator.next(), /released/u);
  assert.equal(Object.isFrozen(mutableStory), false);
  assert.equal(Object.isFrozen(requireDefined(mutableStory.scenes[0], 'the first scene')), false);

  const actions = createDsl4SceneActionIterator(
    requireDefined(story.scenes[0], 'the first scene'),
    {startIndex: 1},
  );
  assert.equal(actionStep(actions.next(), 'the next step').action.command, 'goto');
  assert.equal(actions.next().status, 'done');
  assert.equal(actions.next().status, 'done');
  assert.equal(actions.release(), true);
  assert.throws(() => actions.current(), /released/u);
  assert.throws(
    () =>
      createDsl4SceneActionIterator(requireDefined(story.scenes[0], 'the first scene'), {
        startIndex: 2,
      }),
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
  assert.equal(actionStep(first, 'the begun action').index, 0);
  assert.equal(actionStep(first, 'the begun action').action.command, 'wait');
  assert.deepEqual(
    session.currentActionResources(),
    actionStep(first, 'the begun action').resources,
  );
  const classified = okResult(
    store.classifyHandle(actionStep(first, 'the begun action').resources.actionScopeRef),
    'the classified action scope',
  );
  assert.equal(requireRecord(classified.value, 'the classified handle').kind, 'scope');
  const actionView = requireRecord(
    okResult(
      store.readValue(actionStep(first, 'the begun action').resources.actionViewRef),
      'the action view',
    ).value,
    'the action view value',
  );
  assert.equal(actionView.typeTag, 'kamishibai.actionView');
  assert.deepEqual(actionView.value, {
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
  assert.equal(actionStep(second, 'the begun action').action.command, 'goto');
  assert.equal(session.beginNextAction().status, 'done');
  assert.equal(session.enterScene('ending').scene.id, 'ending');
  assert.equal(session.beginNextAction().status, 'done');
  assert.equal(session.endStory(), true);
  assert.equal(session.endStory(), false);
  const endedCounts = requireRecord(session.debugSnapshot().counts, 'the ended store counts');
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
  assert.equal(endedCounts.handles, requireNumber(endedCounts.tombstones, 'the tombstones') + 1);

  assert.equal(session.beginStory(), true);
  session.enterScene('opening', {actionIndex: 1});
  assert.equal(
    actionStep(session.beginNextAction(), 'the beginNextAction step').action.command,
    'goto',
  );
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
      assert.equal(thrown(error).code, 'K4-STRUCTURED-DATA-SCENE-001');
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
      assert.equal(thrown(error).code, 'K4-STRUCTURED-DATA-001');
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
  const failingSession = createDsl4KamishibaiStructuredDataSession({
    storyDocument: story,
    store: failingStore,
  });
  failingSession.beginStory();
  failingSession.enterScene('opening');
  assert.throws(
    () => failingSession.enterScene('ending'),
    (error) => {
      assert.equal(thrown(error).code, 'K4-STRUCTURED-DATA-001');
      return true;
    },
  );
  assert.equal(failingSession.debugSnapshot().state, 'idle');
  assert.equal(requireRecord(failingSession.debugSnapshot().counts, 'the store counts').scopes, 1);
  assert.equal(requireRecord(failingSession.debugSnapshot().counts, 'the store counts').entries, 0);
  assert.equal(requireRecord(failingSession.debugSnapshot().counts, 'the store counts').nodes, 0);
  failingSession.dispose();
});
