import {createDsl4ObjectStore} from './object-store/index.js';
import {deepFreeze} from './story-document.js';

const storyTypeTag = 'kamishibai.storyDocument';
const actionViewTypeTag = 'kamishibai.actionView';

export class Dsl4KamishibaiStructuredDataError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} storyPath
   * @param {unknown} [cause]
   */
  constructor(code, message, storyPath = '/', cause) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'Dsl4KamishibaiStructuredDataError';
    this.code = code;
    this.storyPath = storyPath;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {unknown} */
function copyTree(value) {
  if (Array.isArray(value)) return value.map(copyTree);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyTree(child)]));
}

/** @param {unknown} storyDocument */
function validateStoryDocument(storyDocument) {
  if (
    !isRecord(storyDocument) ||
    storyDocument.kind !== 'StoryDocument' ||
    storyDocument.version !== '4.0' ||
    !Array.isArray(storyDocument.scenes)
  ) {
    throw new TypeError('Structured Data integration requires a DSL 4.0 StoryDocument');
  }
  return /** @type {Readonly<Record<string, any>>} */ (storyDocument);
}

/** @param {unknown} scene */
function validateScene(scene) {
  if (!isRecord(scene) || typeof scene.id !== 'string' || !Array.isArray(scene.actions)) {
    throw new TypeError('SceneActionIterator requires a normalized scene');
  }
  return /** @type {Readonly<Record<string, any>>} */ (scene);
}

/** @param {unknown} store */
function validateStore(store) {
  if (!isRecord(store)) throw new TypeError('store must be a DSL 4 Object Store');
  for (const method of [
    'createScope',
    'createScopeBundle',
    'debugSnapshot',
    'disposeRealm',
    'readValue',
    'releaseScope',
  ]) {
    if (typeof store[method] !== 'function') throw new TypeError(`store.${method} is required`);
  }
  if (typeof store.rootScopeRef !== 'string') throw new TypeError('store.rootScopeRef is required');
  return /** @type {any} */ (store);
}

/** @param {any} result @param {string} operation @param {string} [storyPath] */
function requireStoreResult(result, operation, storyPath = '/') {
  if (result?.ok) return result.value;
  throw new Dsl4KamishibaiStructuredDataError(
    'K4-STRUCTURED-DATA-001',
    `Structured Data operation ${operation} failed`,
    storyPath,
    result?.error,
  );
}

/** @param {any} result @param {string} operation @param {string} [storyPath] */
function requireCleanupResult(result, operation, storyPath = '/') {
  if (result?.ok) return result.value;
  throw new Dsl4KamishibaiStructuredDataError(
    'K4-STRUCTURED-DATA-CLEANUP-001',
    `Structured Data cleanup ${operation} failed`,
    storyPath,
    result?.error,
  );
}

/**
 * Create a typed scene iterator without evaluating an author-provided JSONPath.
 *
 * @param {Readonly<Record<string, unknown>>} storyDocument
 */
export function createDsl4StoryIterator(storyDocument) {
  const story = validateStoryDocument(storyDocument);
  const scenes = /** @type {ReadonlyArray<Readonly<Record<string, any>>>} */ (story.scenes);
  const sceneIndex = new Map();
  for (const [index, candidate] of scenes.entries()) {
    const scene = validateScene(candidate);
    if (sceneIndex.has(scene.id)) {
      throw new TypeError(`StoryIterator scene id is duplicated: ${scene.id}`);
    }
    sceneIndex.set(scene.id, index);
  }
  let state = 'ready';
  let position = -1;

  function requireActive() {
    if (state === 'released') throw new TypeError('StoryIterator is released');
  }

  function next() {
    requireActive();
    const nextPosition = position + 1;
    if (nextPosition >= scenes.length) {
      position = scenes.length;
      state = 'exhausted';
      return Object.freeze({status: 'done'});
    }
    position = nextPosition;
    state = 'positioned';
    return Object.freeze({status: 'item', index: position, scene: scenes[position]});
  }

  /** @param {unknown} sceneId */
  function select(sceneId) {
    requireActive();
    if (typeof sceneId !== 'string' || !sceneIndex.has(sceneId)) return null;
    position = /** @type {number} */ (sceneIndex.get(sceneId));
    state = 'positioned';
    return Object.freeze({status: 'item', index: position, scene: scenes[position]});
  }

  function current() {
    requireActive();
    return state === 'positioned'
      ? Object.freeze({index: position, scene: scenes[position]})
      : null;
  }

  function release() {
    if (state === 'released') return false;
    state = 'released';
    position = -1;
    return true;
  }

  return Object.freeze({
    next,
    select,
    current,
    release,
    getState: () => deepFreeze({state, position, length: scenes.length}),
  });
}

/**
 * Create a typed action iterator positioned immediately before `startIndex`.
 *
 * @param {Readonly<Record<string, unknown>>} scene
 * @param {object} [options]
 * @param {number} [options.startIndex]
 */
export function createDsl4SceneActionIterator(scene, {startIndex = 0} = {}) {
  const normalizedScene = validateScene(scene);
  const actions = /** @type {ReadonlyArray<Readonly<Record<string, any>>>} */ (
    normalizedScene.actions
  );
  if (
    !Number.isSafeInteger(startIndex) ||
    startIndex < 0 ||
    (actions.length === 0 ? startIndex !== 0 : startIndex >= actions.length)
  ) {
    throw new TypeError('SceneActionIterator startIndex is invalid');
  }
  let state = 'ready';
  let position = startIndex - 1;

  function requireActive() {
    if (state === 'released') throw new TypeError('SceneActionIterator is released');
  }

  function next() {
    requireActive();
    const nextPosition = position + 1;
    if (nextPosition >= actions.length) {
      position = actions.length;
      state = 'exhausted';
      return Object.freeze({status: 'done'});
    }
    position = nextPosition;
    state = 'positioned';
    return Object.freeze({status: 'item', index: position, action: actions[position]});
  }

  function current() {
    requireActive();
    return state === 'positioned'
      ? Object.freeze({index: position, action: actions[position]})
      : null;
  }

  function release() {
    if (state === 'released') return false;
    state = 'released';
    position = -1;
    return true;
  }

  return Object.freeze({
    next,
    current,
    release,
    getState: () => deepFreeze({state, position, length: actions.length}),
  });
}

/**
 * Bind Kamishibai story, scene, and action ownership to one Object Store realm.
 *
 * @param {object} options
 * @param {Readonly<Record<string, unknown>>} options.storyDocument
 * @param {object} [options.store]
 * @param {object} [options.objectStoreOptions]
 */
export function createDsl4KamishibaiStructuredDataSession({
  storyDocument: inputStoryDocument,
  store: inputStore,
  objectStoreOptions,
}) {
  const sourceStoryDocument = validateStoryDocument(inputStoryDocument);
  const store = validateStore(
    inputStore ?? createDsl4ObjectStore(/** @type {any} */ (objectStoreOptions)),
  );
  /** @type {'idle' | 'active' | 'faulted' | 'disposed'} */
  let state = 'idle';
  /** @type {string | null} */
  let storyScopeRef = null;
  /** @type {ReturnType<typeof createDsl4StoryIterator> | null} */
  let storyIterator = null;
  /** @type {string | null} */
  let sceneScopeRef = null;
  /** @type {ReturnType<typeof createDsl4SceneActionIterator> | null} */
  let sceneIterator = null;
  /** @type {Readonly<Record<string, any>> | null} */
  let activeScene = null;
  /** @type {string | null} */
  let actionScopeRef = null;
  /** @type {string | null} */
  let actionViewRef = null;
  /** @type {Readonly<Record<string, any>> | null} */
  let activeAction = null;

  function requireUsable() {
    if (state === 'disposed' || state === 'faulted') {
      throw new Dsl4KamishibaiStructuredDataError(
        'K4-STRUCTURED-DATA-STATE-001',
        `Structured Data session is ${state}`,
      );
    }
  }

  function requireStory() {
    requireUsable();
    if (state !== 'active' || !storyScopeRef || !storyIterator) {
      throw new Dsl4KamishibaiStructuredDataError(
        'K4-STRUCTURED-DATA-STATE-001',
        'Structured Data story scope is not active',
      );
    }
  }

  /** @param {string} reason */
  function releaseAction(reason = 'action-complete') {
    requireUsable();
    if (!actionScopeRef) return false;
    const storyPath = typeof activeAction?.id === 'string' ? activeAction.id : '/';
    requireCleanupResult(store.releaseScope(actionScopeRef), reason, storyPath);
    actionScopeRef = null;
    actionViewRef = null;
    activeAction = null;
    return true;
  }

  /** @param {string} reason */
  function releaseScene(reason = 'scene-exit') {
    requireUsable();
    if (!sceneScopeRef) return false;
    const scenePath = typeof activeScene?.id === 'string' ? `/scenes/${activeScene.id}` : '/';
    requireCleanupResult(store.releaseScope(sceneScopeRef), reason, scenePath);
    sceneIterator?.release();
    sceneScopeRef = null;
    sceneIterator = null;
    activeScene = null;
    actionScopeRef = null;
    actionViewRef = null;
    activeAction = null;
    return true;
  }

  /** @param {string} reason */
  function endStory(reason = 'story-end') {
    requireUsable();
    if (!storyScopeRef) return false;
    const released = store.releaseScope(storyScopeRef);
    if (!released.ok) {
      const disposed = store.disposeRealm();
      state = disposed.ok ? 'disposed' : 'faulted';
      storyIterator?.release();
      sceneIterator?.release();
      storyScopeRef = null;
      storyIterator = null;
      sceneScopeRef = null;
      sceneIterator = null;
      activeScene = null;
      actionScopeRef = null;
      actionViewRef = null;
      activeAction = null;
      requireCleanupResult(released, reason);
    }
    storyIterator?.release();
    sceneIterator?.release();
    state = 'idle';
    storyScopeRef = null;
    storyIterator = null;
    sceneScopeRef = null;
    sceneIterator = null;
    activeScene = null;
    actionScopeRef = null;
    actionViewRef = null;
    activeAction = null;
    return true;
  }

  function beginStory() {
    requireUsable();
    if (storyScopeRef) endStory('story-restart');
    const created = requireStoreResult(
      store.createScopeBundle({
        ownerScopeRef: store.rootScopeRef,
        label: 'kamishibai.story',
        typeTag: storyTypeTag,
        value: copyTree(sourceStoryDocument),
        references: [],
      }),
      'beginStory',
    );
    try {
      const stored = requireStoreResult(store.readValue(created.ownerRef), 'readStory');
      if (stored.typeTag !== storyTypeTag) {
        throw new Dsl4KamishibaiStructuredDataError(
          'K4-STRUCTURED-DATA-001',
          'Structured Data story type is invalid',
        );
      }
      storyIterator = createDsl4StoryIterator(stored.value);
    } catch (error) {
      const cleanup = store.releaseScope(created.scopeRef);
      if (!cleanup.ok) {
        const disposed = store.disposeRealm();
        state = disposed.ok ? 'disposed' : 'faulted';
      }
      throw error;
    }
    storyScopeRef = created.scopeRef;
    state = 'active';
    return true;
  }

  /** @param {unknown} sceneId @param {object} [options] @param {number} [options.actionIndex] */
  function enterScene(sceneId, {actionIndex = 0} = {}) {
    requireStory();
    const activeStoryIterator = storyIterator;
    const activeStoryScopeRef = storyScopeRef;
    if (!activeStoryIterator || !activeStoryScopeRef) {
      throw new Dsl4KamishibaiStructuredDataError(
        'K4-STRUCTURED-DATA-STATE-001',
        'Structured Data story scope is not active',
      );
    }
    const selected = activeStoryIterator.select(sceneId);
    if (!selected) {
      throw new Dsl4KamishibaiStructuredDataError(
        'K4-STRUCTURED-DATA-SCENE-001',
        'Structured Data scene is unavailable',
      );
    }
    const nextIterator = createDsl4SceneActionIterator(selected.scene, {startIndex: actionIndex});
    releaseScene('scene-transition');
    const nextScopeRef = requireStoreResult(
      store.createScope(activeStoryScopeRef, 'kamishibai.scene'),
      'enterScene',
      `/scenes/${selected.scene.id}`,
    );
    sceneScopeRef = nextScopeRef;
    sceneIterator = nextIterator;
    activeScene = selected.scene;
    return deepFreeze({scene: activeScene, sceneIndex: selected.index});
  }

  function beginNextAction() {
    requireStory();
    if (!sceneScopeRef || !sceneIterator || !activeScene) {
      throw new Dsl4KamishibaiStructuredDataError(
        'K4-STRUCTURED-DATA-STATE-001',
        'Structured Data scene scope is not active',
      );
    }
    releaseAction('next-action');
    const next = sceneIterator.next();
    if (next.status === 'done') return deepFreeze({status: 'done'});
    const action = next.action;
    const storyPath = String(action.id);
    const actionView = {
      kind: 'ActionView',
      version: 1,
      name: action.command,
      target: action.target,
      arguments: action.args,
      storyPath,
    };
    const created = requireStoreResult(
      store.createScopeBundle({
        ownerScopeRef: sceneScopeRef,
        label: 'kamishibai.action',
        typeTag: actionViewTypeTag,
        value: actionView,
        references: [],
      }),
      'beginAction',
      storyPath,
    );
    actionScopeRef = created.scopeRef;
    actionViewRef = created.ownerRef;
    activeAction = action;
    return deepFreeze({
      status: 'item',
      index: next.index,
      action,
      resources: {actionScopeRef, actionViewRef},
    });
  }

  function currentActionResources() {
    return actionScopeRef && actionViewRef ? deepFreeze({actionScopeRef, actionViewRef}) : null;
  }

  function snapshot() {
    const storeSnapshot = store.debugSnapshot();
    return deepFreeze({
      state,
      story: storyScopeRef ? 'active' : 'idle',
      scene: sceneScopeRef ? 'active' : 'idle',
      action: actionScopeRef ? 'active' : 'idle',
      counts: storeSnapshot.counts,
    });
  }

  function dispose() {
    if (state === 'disposed') return false;
    const disposed = requireCleanupResult(store.disposeRealm(), 'dispose');
    storyIterator?.release();
    sceneIterator?.release();
    state = 'disposed';
    storyScopeRef = null;
    storyIterator = null;
    sceneScopeRef = null;
    sceneIterator = null;
    activeScene = null;
    actionScopeRef = null;
    actionViewRef = null;
    activeAction = null;
    return disposed.realmState === 'disposed';
  }

  return Object.freeze({
    beginStory,
    enterScene,
    beginNextAction,
    currentActionResources,
    releaseAction,
    releaseScene,
    endStory,
    debugSnapshot: snapshot,
    dispose,
  });
}
