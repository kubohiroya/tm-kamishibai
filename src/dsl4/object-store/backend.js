import {deepFreezeStoreValue} from './freeze.js';

const backendStates = new WeakMap();

/**
 * Create the private immutable-snapshot backend used by the Generic Object Store Core.
 * The optional hook is a test seam and never receives the candidate root.
 *
 * @param {object} [options]
 * @param {(event: Readonly<{operation: string, baseRevision: number, nextRevision: number}>) => ('conflict' | 'failure' | void)} [options.beforeCommit]
 */
export function createDsl4MapBackend({beforeCommit} = {}) {
  if (beforeCommit !== undefined && typeof beforeCommit !== 'function') {
    throw new TypeError('beforeCommit must be a function');
  }

  const backend = Object.freeze({
    debugStatus() {
      const state = backendStates.get(backend);
      if (!state?.bound) {
        return deepFreezeStoreValue({
          bound: false,
          revision: 0,
          commitCount: 0,
          rootIdentity: null,
        });
      }
      return deepFreezeStoreValue({
        bound: true,
        revision: state.revision,
        commitCount: state.commitCount,
        rootIdentity: state.rootIdentity,
      });
    },
  });
  backendStates.set(backend, {
    bound: false,
    root: null,
    revision: 0,
    commitCount: 0,
    rootIdentity: null,
    beforeCommit,
  });
  return backend;
}

/** @param {unknown} backend */
export function isDsl4MapBackend(backend) {
  return typeof backend === 'object' && backend !== null && backendStates.has(backend);
}

/**
 * @internal
 * @param {object} backend
 * @param {Readonly<Record<string, unknown>>} root
 */
export function initializeDsl4MapBackend(backend, root) {
  const state = backendStates.get(backend);
  if (!state || state.bound) throw new TypeError('MapBackend must be unused');
  if (!Object.isFrozen(root)) throw new TypeError('MapBackend root must be immutable');
  state.bound = true;
  state.root = root;
  state.rootIdentity = Object.freeze({});
}

/**
 * @internal
 * @param {object} backend
 */
export function readDsl4MapBackend(backend) {
  const state = backendStates.get(backend);
  if (!state?.bound || !state.root) throw new TypeError('MapBackend is not initialized');
  return {root: state.root, revision: state.revision};
}

/**
 * @internal
 * @param {object} backend
 * @param {object} transaction
 * @param {number} transaction.baseRevision
 * @param {string} transaction.operation
 * @param {Readonly<Record<string, unknown>>} transaction.root
 */
export function commitDsl4MapBackend(backend, {baseRevision, operation, root}) {
  const state = backendStates.get(backend);
  if (!state?.bound || !state.root) return {ok: false, reason: 'failure'};
  if (state.revision !== baseRevision) return {ok: false, reason: 'conflict'};
  if (!Object.isFrozen(root)) return {ok: false, reason: 'failure'};

  try {
    const decision = state.beforeCommit?.(
      deepFreezeStoreValue({operation, baseRevision, nextRevision: baseRevision + 1}),
    );
    if (decision === 'conflict') return {ok: false, reason: 'conflict'};
    if (decision === 'failure') return {ok: false, reason: 'failure'};
    if (decision !== undefined) return {ok: false, reason: 'failure'};
  } catch {
    return {ok: false, reason: 'failure'};
  }

  if (state.revision !== baseRevision) return {ok: false, reason: 'conflict'};
  state.root = root;
  state.revision += 1;
  state.commitCount += 1;
  state.rootIdentity = Object.freeze({});
  return {ok: true, revision: state.revision};
}
