import {createDsl4ReloadPlan} from './reload-planner.js';
import {deepFreeze} from './story-document.js';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {unknown} */
function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
}

/** @param {unknown} value */
function validateStoryDocument(value) {
  if (!isRecord(value) || value.kind !== 'StoryDocument' || value.version !== '4.0') {
    throw new TypeError('live reload requires a DSL 4.0 StoryDocument');
  }
  return value;
}

/** @param {unknown} value */
function validateRuntimeSession(value) {
  if (
    !isRecord(value) ||
    typeof value.start !== 'function' ||
    typeof value.stop !== 'function' ||
    typeof value.dispose !== 'function' ||
    typeof value.getState !== 'function'
  ) {
    throw new TypeError(
      'live reload runtime session must provide start, stop, dispose, and getState',
    );
  }
  return /** @type {Record<string, Function>} */ (value);
}

/** @param {Record<string, Function>} session */
function executionState(session) {
  const state = session.getState();
  if (!isRecord(state)) throw new TypeError('live reload runtime state must be an object');
  return isRecord(state.runtime) ? state.runtime : state;
}

/** @param {unknown} input */
function sourceIntegrity(input) {
  if (!isRecord(input) || input.sourceSnapshot === undefined || input.sourceSnapshot === null) {
    return null;
  }
  if (!isRecord(input.sourceSnapshot) || typeof input.sourceSnapshot.integrity !== 'string') {
    throw new TypeError('sourceSnapshot must provide an integrity string');
  }
  return input.sourceSnapshot.integrity;
}

/** @param {unknown} value @param {string} name */
function optionalIntegrity(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  return value;
}

/**
 * Coordinate author-visible DSL 4.0 source reload behavior without owning filesystem watch,
 * transport, or modal UI.
 *
 * @param {object} options
 * @param {(context: Readonly<{storyDocument: Readonly<Record<string, unknown>>, previousSession: Record<string, Function> | null, preserveManagedPresentation: boolean}>) => Record<string, Function> | Promise<Record<string, Function>>} options.createSession
 * @param {Readonly<Record<string, unknown>>} [options.initialStoryDocument]
 * @param {Record<string, Function>} [options.initialSession]
 * @param {string} [options.initialSourceIntegrity]
 * @param {(error: unknown) => void} [options.onRunError]
 * @param {(value: unknown) => boolean} [options.isException]
 */
export function createDsl4LiveReloadSession({
  createSession,
  initialStoryDocument,
  initialSession,
  initialSourceIntegrity,
  onRunError,
  isException,
}) {
  if (typeof createSession !== 'function') throw new TypeError('createSession must be a function');
  if (onRunError !== undefined && typeof onRunError !== 'function') {
    throw new TypeError('onRunError must be a function');
  }
  if (isException !== undefined && typeof isException !== 'function') {
    throw new TypeError('isException must be a function');
  }
  if ((initialStoryDocument === undefined) !== (initialSession === undefined)) {
    throw new TypeError('initialStoryDocument and initialSession must be provided together');
  }
  if (initialStoryDocument === undefined && initialSourceIntegrity !== undefined) {
    throw new TypeError('initialSourceIntegrity requires an initial runtime session');
  }

  let current =
    initialStoryDocument === undefined
      ? null
      : {
          storyDocument: validateStoryDocument(initialStoryDocument),
          session: validateRuntimeSession(initialSession),
          integrity: optionalIntegrity(initialSourceIntegrity, 'initialSourceIntegrity'),
        };
  /** @type {{id: number, storyDocument: Readonly<Record<string, unknown>>, integrity: string | null, plan: Readonly<Record<string, any>>} | null} */
  let candidate = null;
  /** @type {'waiting' | 'active' | 'invalid' | 'pending' | 'deferred' | 'failed' | 'disposed'} */
  let status = current ? 'active' : 'waiting';
  let generation = current ? 1 : 0;
  let nextCandidateId = 1;
  /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */
  let diagnostics = [];
  let disposed = false;
  let operationQueue = Promise.resolve();

  function snapshot() {
    const runtime = current ? executionState(current.session) : null;
    const metadata = /** @type {Readonly<Record<string, unknown>>} */ (
      current?.storyDocument.metadata ?? {}
    );
    return deepFreeze({
      version: 1,
      status,
      generation,
      hasCurrent: current !== null,
      current: current
        ? {
            sourceId: typeof metadata.sourceId === 'string' ? metadata.sourceId : 'main',
            integrity: current.integrity,
            runtime: cloneValue(runtime),
          }
        : null,
      candidate: candidate
        ? {id: candidate.id, integrity: candidate.integrity, plan: candidate.plan}
        : null,
      diagnostics: cloneValue(diagnostics),
      disposed,
    });
  }

  /** @param {unknown} run */
  function observeRun(run) {
    if (!run || typeof run !== 'object' || typeof (/** @type {any} */ (run).then) !== 'function') {
      return;
    }
    Promise.resolve(run).catch((error) => {
      try {
        onRunError?.(error);
      } catch {
        // Error observers cannot change live reload state.
      }
    });
  }

  /** @param {() => unknown | Promise<unknown>} operation */
  function enqueue(operation) {
    const result = operationQueue.then(operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * @param {Readonly<Record<string, unknown>>} storyDocument
   * @param {Record<string, Function> | null} previousSession
   * @param {boolean} preserveManagedPresentation
   */
  async function makeSession(storyDocument, previousSession, preserveManagedPresentation) {
    const created = await createSession(
      Object.freeze({storyDocument, previousSession, preserveManagedPresentation}),
    );
    try {
      return validateRuntimeSession(created);
    } catch (error) {
      if (isRecord(created) && typeof created.dispose === 'function') {
        try {
          await created.dispose('invalid-live-reload-session');
        } catch (disposeError) {
          throw new AggregateError(
            [error, disposeError],
            'Invalid DSL 4.0 live reload session cleanup failed',
          );
        }
      }
      throw error;
    }
  }

  /** @param {unknown} input */
  function stage(input) {
    return enqueue(async () => {
      if (disposed) throw new TypeError('live reload session is disposed');
      if (!isRecord(input) || typeof input.ok !== 'boolean') {
        throw new TypeError('stage requires a source frontend result');
      }
      const integrity = sourceIntegrity(input);
      if (!input.ok) {
        if (!Array.isArray(input.diagnostics)) {
          throw new TypeError('invalid source result must provide diagnostics');
        }
        candidate = null;
        diagnostics = /** @type {ReadonlyArray<Readonly<Record<string, unknown>>>} */ (
          cloneValue(input.diagnostics)
        );
        status = 'invalid';
        return snapshot();
      }

      const storyDocument = validateStoryDocument(input.storyDocument);
      diagnostics = [];
      if (!current) {
        const session = await makeSession(storyDocument, null, false);
        let run;
        try {
          run = session.start();
        } catch (error) {
          try {
            await session.dispose('initial-start-failed');
          } catch (disposeError) {
            throw new AggregateError(
              [error, disposeError],
              'DSL 4.0 initial live reload start and cleanup failed',
            );
          }
          throw error;
        }
        current = {storyDocument, session, integrity};
        generation += 1;
        status = 'active';
        observeRun(run);
        return snapshot();
      }

      const plan = createDsl4ReloadPlan({
        currentStoryDocument: current.storyDocument,
        candidateStoryDocument: storyDocument,
        currentExecution: executionState(current.session),
        isException,
      });
      candidate = {id: nextCandidateId++, storyDocument, integrity, plan};
      diagnostics = plan.diagnostics;
      status = 'pending';
      return snapshot();
    });
  }

  /** Discard author-visible candidate state while leaving the current runtime untouched. */
  function discardCandidate() {
    return enqueue(() => {
      if (disposed) throw new TypeError('live reload session is disposed');
      candidate = null;
      diagnostics = [];
      if (status !== 'failed') status = current ? 'active' : 'waiting';
      return snapshot();
    });
  }

  /** @param {number} candidateId */
  function defer(candidateId) {
    return enqueue(() => {
      if (disposed) throw new TypeError('live reload session is disposed');
      if (!candidate || candidate.id !== candidateId) {
        throw new TypeError('live reload candidate is stale or missing');
      }
      status = 'deferred';
      return snapshot();
    });
  }

  /**
   * @param {number} candidateId
   * @param {'storyStart' | 'currentScene' | 'currentAction'} choice
   */
  function commit(candidateId, choice) {
    return enqueue(async () => {
      if (disposed) throw new TypeError('live reload session is disposed');
      if (!candidate || candidate.id !== candidateId) {
        throw new TypeError('live reload candidate is stale or missing');
      }
      const option = candidate.plan.options[choice];
      if (!option?.enabled) throw new TypeError(`live reload choice ${choice} is disabled`);
      if (!current) throw new TypeError('live reload has no current runtime');

      const previous = current;
      const next = await makeSession(
        candidate.storyDocument,
        previous.session,
        option.preserveManagedPresentation,
      );
      if (next === previous.session) {
        throw new TypeError('createSession must return a new runtime session for live reload');
      }
      let previousStopped = false;
      try {
        previousStopped = true;
        await previous.session.stop('live-reload');
        await previous.session.dispose('live-reload-replaced');
        const run = next.start({
          sceneId: option.destination.sceneId,
          actionIndex: option.destination.actionIndex,
          variables: option.variables,
        });
        current = {
          storyDocument: candidate.storyDocument,
          session: next,
          integrity: candidate.integrity,
        };
        candidate = null;
        diagnostics = [];
        generation += 1;
        status = 'active';
        observeRun(run);
        return snapshot();
      } catch (error) {
        try {
          await next.dispose('live-reload-commit-failed');
        } catch (disposeError) {
          status = previousStopped ? 'failed' : status;
          throw new AggregateError(
            [error, disposeError],
            'DSL 4.0 live reload commit and cleanup failed',
          );
        }
        if (previousStopped) status = 'failed';
        throw error;
      }
    });
  }

  function dispose() {
    return enqueue(async () => {
      if (disposed) return snapshot();
      disposed = true;
      status = 'disposed';
      candidate = null;
      diagnostics = [];
      const errors = [];
      if (current) {
        try {
          await current.session.stop('live-reload-dispose');
        } catch (error) {
          errors.push(error);
        }
        try {
          await current.session.dispose('live-reload-dispose');
        } catch (error) {
          errors.push(error);
        }
      }
      current = null;
      if (errors.length > 0) {
        throw new AggregateError(errors, 'DSL 4.0 live reload disposal failed');
      }
      return snapshot();
    });
  }

  return Object.freeze({
    stage,
    defer,
    discardCandidate,
    commit,
    dispose,
    getState: snapshot,
    whenIdle() {
      return operationQueue.then(snapshot);
    },
  });
}
