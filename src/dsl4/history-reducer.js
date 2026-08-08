import {deepFreeze} from './story-document.js';
import {encodeDsl4StoryPathSegment} from './story-path.js';

const historyCommands = new Set([
  'history.previousAction',
  'history.previousScene',
  'history.nextScene',
]);

/**
 * @typedef {object} HistoryDestination
 * @property {number} visitId
 * @property {string} sceneId
 * @property {string | null} actionPath
 * @property {number} actionIndex
 * @property {string} reason
 *
 * @typedef {object} HistoryState
 * @property {'live' | 'history'} mode
 * @property {ReadonlyArray<Readonly<Record<string, unknown>>>} actionEntries
 * @property {ReadonlyArray<Readonly<Record<string, unknown>>>} sceneVisits
 * @property {number} actionCursor
 * @property {number} sceneVisitCursor
 * @property {number | null} currentVisitId
 * @property {number} nextVisitId
 * @property {number} lastSequence
 */

/**
 * @returns {Readonly<HistoryState>}
 */
function initialHistoryState() {
  return deepFreeze({
    mode: 'live',
    actionEntries: [],
    sceneVisits: [],
    actionCursor: 0,
    sceneVisitCursor: -1,
    currentVisitId: null,
    nextVisitId: 1,
    lastSequence: -1,
  });
}

/**
 * @param {Readonly<HistoryState>} state
 * @param {boolean} changed
 * @param {HistoryDestination | null} [destination]
 */
function success(state, changed, destination = null) {
  return deepFreeze({ok: true, state, changed, destination});
}

/**
 * @param {Readonly<HistoryState>} state
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 */
function failure(state, code, message, details = {}) {
  return deepFreeze({
    ok: false,
    state,
    changed: false,
    destination: null,
    diagnostic: {code, message, details},
  });
}

/**
 * @param {unknown} value
 * @returns {value is Readonly<HistoryState>}
 */
function isHistoryState(value) {
  if (typeof value !== 'object' || value === null) return false;
  const state = /** @type {Record<string, unknown>} */ (value);
  return (
    (state.mode === 'live' || state.mode === 'history') &&
    Array.isArray(state.actionEntries) &&
    Array.isArray(state.sceneVisits) &&
    Number.isInteger(state.actionCursor) &&
    Number.isInteger(state.sceneVisitCursor) &&
    Number.isInteger(state.nextVisitId) &&
    Number.isInteger(state.lastSequence)
  );
}

/**
 * @param {string} actionPath
 * @returns {number | null}
 */
function actionIndexFromPath(actionPath) {
  const match = /\/actions\/(0|[1-9][0-9]*)$/.exec(actionPath);
  return match ? Number(match[1]) : null;
}

/**
 * @param {string} value
 * @returns {string}
 */
/**
 * @param {Readonly<HistoryState>} state
 * @param {number} visitId
 * @returns {number}
 */
function visitIndexById(state, visitId) {
  return state.sceneVisits.findIndex((visit) => visit.visitId === visitId);
}

/**
 * @param {Readonly<HistoryState>} state
 * @param {number} visitIndex
 * @param {string} reason
 * @returns {HistoryDestination}
 */
function sceneDestination(state, visitIndex, reason) {
  const visit = state.sceneVisits[visitIndex];
  const firstAction = state.actionEntries[Number(visit.firstActionHistoryIndex)];
  const actionPath =
    firstAction?.visitId === visit.visitId && typeof firstAction.actionPath === 'string'
      ? firstAction.actionPath
      : null;
  return {
    visitId: Number(visit.visitId),
    sceneId: String(visit.sceneId),
    actionPath,
    actionIndex: 0,
    reason,
  };
}

/**
 * @param {Readonly<HistoryState>} state
 * @param {string} command
 */
function move(state, command) {
  if (command === 'history.previousAction') {
    if (state.actionCursor <= 0) return success(state, false);
    const nextActionCursor = state.actionCursor - 1;
    const entry = state.actionEntries[nextActionCursor];
    const actionIndex = actionIndexFromPath(String(entry.actionPath));
    const nextSceneVisitCursor = visitIndexById(state, Number(entry.visitId));
    if (actionIndex === null || nextSceneVisitCursor < 0) {
      return failure(
        state,
        'K4-HISTORY-STATE-001',
        'Action history entry does not identify a valid scene visit and action',
      );
    }
    const nextState = /** @type {Readonly<HistoryState>} */ (
      deepFreeze({
        ...state,
        mode: 'history',
        actionCursor: nextActionCursor,
        sceneVisitCursor: nextSceneVisitCursor,
        currentVisitId: Number(entry.visitId),
      })
    );
    return success(nextState, true, {
      visitId: Number(entry.visitId),
      sceneId: String(entry.sceneId),
      actionPath: String(entry.actionPath),
      actionIndex,
      reason: command,
    });
  }

  const offset = command === 'history.previousScene' ? -1 : 1;
  const nextSceneVisitCursor = state.sceneVisitCursor + offset;
  if (nextSceneVisitCursor < 0 || nextSceneVisitCursor >= state.sceneVisits.length) {
    return success(state, false);
  }
  const visit = state.sceneVisits[nextSceneVisitCursor];
  const nextState = /** @type {Readonly<HistoryState>} */ (
    deepFreeze({
      ...state,
      mode: 'history',
      actionCursor: Number(visit.firstActionHistoryIndex),
      sceneVisitCursor: nextSceneVisitCursor,
      currentVisitId: Number(visit.visitId),
    })
  );
  return success(nextState, true, sceneDestination(nextState, nextSceneVisitCursor, command));
}

/**
 * Create a pure chronological navigation-history reducer.
 * Product defaults for the mandatory finite limits belong to the runtime integration layer.
 *
 * @param {object} options
 * @param {number} options.maxActionEntries
 * @param {number} options.maxSceneVisits
 */
export function createDsl4HistoryReducer({maxActionEntries, maxSceneVisits}) {
  if (!Number.isInteger(maxActionEntries) || maxActionEntries < 1) {
    throw new TypeError('maxActionEntries must be a positive integer');
  }
  if (!Number.isInteger(maxSceneVisits) || maxSceneVisits < 1) {
    throw new TypeError('maxSceneVisits must be a positive integer');
  }

  /**
   * @param {Readonly<HistoryState>} state
   * @param {Readonly<Record<string, unknown>>} event
   */
  function reduce(state, event) {
    if (!isHistoryState(state) || !Object.isFrozen(state)) {
      throw new TypeError('History reducer requires a frozen HistoryState');
    }
    if (typeof event !== 'object' || event === null || typeof event.type !== 'string') {
      return failure(state, 'K4-HISTORY-EVENT-001', 'History event must have a type');
    }
    if (event.type === 'reset') return success(initialHistoryState(), true);
    if (event.type === 'resume') {
      if (state.mode === 'live') return success(state, false);
      const sceneVisits = state.sceneVisits.slice(0, state.sceneVisitCursor + 1);
      const actionEntries = state.actionEntries.slice(0, state.actionCursor);
      const currentVisit = sceneVisits.at(-1);
      return success(
        deepFreeze({
          ...state,
          mode: 'live',
          actionEntries,
          sceneVisits,
          actionCursor: actionEntries.length,
          sceneVisitCursor: sceneVisits.length - 1,
          currentVisitId: currentVisit ? Number(currentVisit.visitId) : null,
        }),
        true,
      );
    }
    if (historyCommands.has(event.type)) return move(state, event.type);
    if (event.type !== 'scene.enter' && event.type !== 'action.commit') {
      return failure(state, 'K4-HISTORY-EVENT-001', `Unsupported history event: ${event.type}`);
    }
    if (state.mode !== 'live') {
      return failure(
        state,
        'K4-HISTORY-MODE-001',
        'History must resume before recording new execution events',
      );
    }
    if (!Number.isInteger(event.sequence) || Number(event.sequence) <= state.lastSequence) {
      return failure(
        state,
        'K4-HISTORY-SEQUENCE-001',
        'History event sequence must be a monotonically increasing integer',
      );
    }

    if (event.type === 'scene.enter') {
      if (
        typeof event.sceneId !== 'string' ||
        !event.sceneId ||
        typeof event.storyPath !== 'string' ||
        event.storyPath !== `/scenes/${encodeDsl4StoryPathSegment(event.sceneId)}`
      ) {
        return failure(state, 'K4-HISTORY-EVENT-001', 'Scene entry requires sceneId and storyPath');
      }
      if (state.sceneVisits.length >= maxSceneVisits) {
        return failure(state, 'K4-HISTORY-LIMIT-001', 'Scene visit history limit reached', {
          kind: 'sceneVisits',
          limit: maxSceneVisits,
        });
      }
      const visit = deepFreeze({
        visitId: state.nextVisitId,
        sceneId: event.sceneId,
        storyPath: event.storyPath,
        firstActionHistoryIndex: state.actionEntries.length,
        enteredSequence: event.sequence,
      });
      const sceneVisits = [...state.sceneVisits, visit];
      return success(
        deepFreeze({
          ...state,
          sceneVisits,
          actionCursor: state.actionEntries.length,
          sceneVisitCursor: sceneVisits.length - 1,
          currentVisitId: state.nextVisitId,
          nextVisitId: state.nextVisitId + 1,
          lastSequence: Number(event.sequence),
        }),
        true,
      );
    }

    if (
      state.currentVisitId === null ||
      typeof event.sceneId !== 'string' ||
      typeof event.actionPath !== 'string' ||
      !event.actionPath.startsWith(
        `/scenes/${encodeDsl4StoryPathSegment(String(event.sceneId))}/actions/`,
      ) ||
      actionIndexFromPath(event.actionPath) === null
    ) {
      return failure(
        state,
        'K4-HISTORY-EVENT-001',
        'Action commit requires an active visit, sceneId, and action StoryPath',
      );
    }
    const currentVisit = state.sceneVisits[state.sceneVisitCursor];
    if (!currentVisit || currentVisit.sceneId !== event.sceneId) {
      return failure(
        state,
        'K4-HISTORY-STATE-001',
        'Action commit scene does not match the active scene visit',
      );
    }
    if (state.actionEntries.length >= maxActionEntries) {
      return failure(state, 'K4-HISTORY-LIMIT-001', 'Action history limit reached', {
        kind: 'actionEntries',
        limit: maxActionEntries,
      });
    }
    const entry = deepFreeze({
      visitId: state.currentVisitId,
      sceneId: event.sceneId,
      actionPath: event.actionPath,
      committedSequence: event.sequence,
    });
    const actionEntries = [...state.actionEntries, entry];
    return success(
      deepFreeze({
        ...state,
        actionEntries,
        actionCursor: actionEntries.length,
        lastSequence: Number(event.sequence),
      }),
      true,
    );
  }

  return Object.freeze({
    initialState: initialHistoryState,
    reduce,
  });
}
