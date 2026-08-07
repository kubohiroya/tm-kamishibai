import {deepFreeze} from './story-document.js';

const preferences = new Set(['story', 'scene', 'action']);
const watchStates = new Set(['watching', 'stabilizing', 'paused', 'disconnected']);
const manualScopes = new Set(['reload-once', 'reload-and-save', 'save-next', 'cancel']);

export const dsl4PreviewReloadPolicyDefaults = deepFreeze({
  preference: 'action',
  minimumSuccessDisplayMs: 2_000,
});

export class Dsl4PreviewReloadPolicyError extends TypeError {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'Dsl4PreviewReloadPolicyError';
    this.code = code;
  }
}

/** @param {string} code @param {string} message @returns {never} */
function fail(code, message) {
  throw new Dsl4PreviewReloadPolicyError(code, message);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name */
function preference(value, name) {
  if (typeof value !== 'string' || !preferences.has(value)) {
    throw new TypeError(`${name} must be story, scene, or action`);
  }
  return /** @type {'story' | 'scene' | 'action'} */ (value);
}

/** @param {unknown} value @param {string} name */
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} name @param {number} minimum */
function milliseconds(value, name, minimum) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} name */
function safeText(value, name) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 300 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${name} must be bounded safe text`);
  }
  return value;
}

/** @param {unknown} value @param {string} name */
function anchorAvailability(value, name) {
  if (!isRecord(value) || typeof value.available !== 'boolean') {
    throw new TypeError(`${name} availability is invalid`);
  }
  if (value.available && value.reason !== null) {
    throw new TypeError(`${name}.reason must be null when available`);
  }
  if (!value.available && value.reason === null) {
    throw new TypeError(`${name}.reason is required when unavailable`);
  }
  return deepFreeze({
    available: value.available,
    reason: value.reason === null ? null : safeText(value.reason, `${name}.reason`),
  });
}

/** @param {unknown} value */
function availability(value) {
  if (
    !isRecord(value) ||
    !isRecord(value.story) ||
    !isRecord(value.scene) ||
    !isRecord(value.action)
  ) {
    throw new TypeError('candidate availability is invalid');
  }
  const story = anchorAvailability(value.story, 'availability.story');
  const scene = anchorAvailability(value.scene, 'availability.scene');
  const actionBase = anchorAvailability(value.action, 'availability.action');
  if (story.available !== true) throw new TypeError('story reload anchor must always be available');
  if (typeof value.action.replaySafe !== 'boolean') {
    throw new TypeError('availability.action.replaySafe must be boolean');
  }
  return deepFreeze({
    story,
    scene,
    action: {...actionBase, replaySafe: value.action.replaySafe},
  });
}

/** @param {unknown} value */
function candidate(value) {
  if (!isRecord(value) || !isRecord(value.summary)) {
    throw new TypeError('reload candidate must provide a redacted summary');
  }
  return deepFreeze({
    revision: positiveInteger(value.revision, 'candidate.revision'),
    availability: availability(value.availability),
    summary: {
      category: safeText(value.summary.category, 'candidate.summary.category'),
      changedIds: Array.isArray(value.summary.changedIds)
        ? value.summary.changedIds.map((id) => safeText(id, 'candidate.summary.changedIds'))
        : (() => {
            throw new TypeError('candidate.summary.changedIds must be an array');
          })(),
    },
    initiatingInputId:
      value.initiatingInputId === null || value.initiatingInputId === undefined
        ? null
        : safeText(value.initiatingInputId, 'candidate.initiatingInputId'),
  });
}

/** @param {unknown} value */
function validateClock(value) {
  if (
    !isRecord(value) ||
    typeof value.now !== 'function' ||
    typeof value.setTimeout !== 'function' ||
    typeof value.clearTimeout !== 'function'
  ) {
    throw new TypeError('reload policy clock is invalid');
  }
  return /** @type {Readonly<Record<string, Function>>} */ (value);
}

const defaultClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (/** @type {Function} */ callback, /** @type {number} */ delay) =>
    setTimeout(callback, delay),
  clearTimeout: (/** @type {ReturnType<typeof setTimeout>} */ timer) => clearTimeout(timer),
});

/**
 * Resolve the actual safe anchor without mutating the requested session preference.
 *
 * @param {object} input
 * @param {'story' | 'scene' | 'action'} input.requestedPreference
 * @param {unknown} input.availability
 */
export function resolveDsl4ReloadAnchor({requestedPreference, availability: inputAvailability}) {
  const requested = preference(requestedPreference, 'requestedPreference');
  const anchors = availability(inputAvailability);
  if (requested === 'story') {
    return deepFreeze({
      requestedPreference: requested,
      actualAnchor: 'story',
      fallbackReason: null,
    });
  }
  if (requested === 'scene') {
    return anchors.scene.available
      ? deepFreeze({requestedPreference: requested, actualAnchor: 'scene', fallbackReason: null})
      : deepFreeze({
          requestedPreference: requested,
          actualAnchor: 'story',
          fallbackReason: anchors.scene.reason,
        });
  }
  if (anchors.action.available && anchors.action.replaySafe) {
    return deepFreeze({
      requestedPreference: requested,
      actualAnchor: 'action',
      fallbackReason: null,
    });
  }
  const actionReason = anchors.action.available
    ? 'The current action is not replay-safe.'
    : anchors.action.reason;
  return anchors.scene.available
    ? deepFreeze({
        requestedPreference: requested,
        actualAnchor: 'scene',
        fallbackReason: actionReason,
      })
    : deepFreeze({
        requestedPreference: requested,
        actualAnchor: 'story',
        fallbackReason: `${actionReason} ${anchors.scene.reason}`.slice(0, 300),
      });
}

/**
 * Serialize automatic generation adoption and explicit manual restart/preference transactions.
 *
 * @param {object} options
 * @param {(request: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} options.applyGeneration
 * @param {(request: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} options.restartGeneration
 * @param {(state: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.onState]
 * @param {(error: unknown) => unknown} [options.onError]
 * @param {Readonly<Record<string, Function>>} [options.clock]
 * @param {number} [options.minimumSuccessDisplayMs]
 */
export function createDsl4PreviewReloadPolicy(options) {
  if (!isRecord(options)) throw new TypeError('reload policy options are required');
  if (
    typeof options.applyGeneration !== 'function' ||
    typeof options.restartGeneration !== 'function'
  ) {
    throw new TypeError('reload policy requires applyGeneration and restartGeneration');
  }
  if (options.onState !== undefined && typeof options.onState !== 'function') {
    throw new TypeError('onState must be a function');
  }
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new TypeError('onError must be a function');
  }
  const clock = validateClock(options.clock ?? defaultClock);
  const minimumSuccessDisplayMs = milliseconds(
    options.minimumSuccessDisplayMs ?? dsl4PreviewReloadPolicyDefaults.minimumSuccessDisplayMs,
    'minimumSuccessDisplayMs',
    0,
  );

  let disposed = false;
  /** @type {'watching' | 'stabilizing' | 'paused' | 'disconnected'} */
  let watchStatus = 'watching';
  /** @type {'story' | 'scene' | 'action'} */
  let currentPreference = 'action';
  let latestSeenRevision = 0;
  let latestAppliedRevision = 0;
  /** @type {ReturnType<typeof candidate> | null} */
  let latestCandidate = null;
  /** @type {ReturnType<typeof candidate> | null} */
  let currentGeneration = null;
  /** @type {Readonly<Record<string, unknown>> | null} */
  let applying = null;
  /** @type {Readonly<Record<string, unknown>> | null} */
  let currentDiagnostic = null;
  /** @type {Readonly<Record<string, any>> | null} */
  let lastSuccess = null;
  /** @type {{open: boolean, step: 'position' | 'scope', targetRevision: number | null, selectedPreference: 'story' | 'scene' | 'action' | null, stale: boolean}} */
  let dialog = {
    open: false,
    step: 'position',
    targetRevision: null,
    selectedPreference: null,
    stale: false,
  };
  /** @type {unknown} */
  let acknowledgementTimer = null;
  let operationQueue = Promise.resolve();
  const subscribers = new Set();

  function visibleSuccess() {
    return Boolean(lastSuccess && !lastSuccess.seen);
  }

  function displayState() {
    if (currentDiagnostic) return 'diagnostic';
    if (applying) return 'applying';
    if (visibleSuccess()) return 'reloaded';
    return watchStatus;
  }

  function snapshot() {
    return deepFreeze({
      version: 1,
      disposed,
      status: displayState(),
      watchStatus,
      preference: currentPreference,
      latestSeenRevision,
      latestAppliedRevision,
      currentGeneration: currentGeneration
        ? {revision: currentGeneration.revision, summary: currentGeneration.summary}
        : null,
      latestCandidate: latestCandidate
        ? {revision: latestCandidate.revision, summary: latestCandidate.summary}
        : null,
      applying,
      diagnostic: currentDiagnostic,
      lastSuccess,
      dialog,
    });
  }

  /** @param {unknown} error */
  function reportError(error) {
    try {
      options.onError?.(error);
    } catch {
      // Error observers cannot change policy state.
    }
  }

  async function notify() {
    try {
      await options.onState?.(snapshot());
    } catch (error) {
      reportError(error);
    }
    for (const subscriber of subscribers) {
      try {
        await subscriber(snapshot());
      } catch (error) {
        reportError(error);
      }
    }
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

  function cancelAcknowledgementTimer() {
    if (acknowledgementTimer === null) return;
    clock.clearTimeout(acknowledgementTimer);
    acknowledgementTimer = null;
  }

  function scheduleAcknowledgement() {
    cancelAcknowledgementTimer();
    if (!lastSuccess?.acknowledged || lastSuccess.seen) return;
    const remaining = Math.max(0, lastSuccess.visibleUntil - Number(clock.now()));
    acknowledgementTimer = clock.setTimeout(() => {
      acknowledgementTimer = null;
      if (!lastSuccess?.acknowledged || lastSuccess.seen) return;
      if (Number(clock.now()) < lastSuccess.visibleUntil) {
        scheduleAcknowledgement();
        return;
      }
      lastSuccess = {...lastSuccess, seen: true};
      void notify();
    }, remaining);
  }

  /** @param {unknown} value @param {number} revision */
  function acknowledgement(value, revision) {
    if (!isRecord(value) || value.revision !== revision) {
      throw new TypeError('reload operation returned an invalid acknowledgement');
    }
    const actualAnchor = preference(value.actualAnchor, 'acknowledgement.actualAnchor');
    return deepFreeze({
      revision,
      actualAnchor,
      fallbackReason:
        value.fallbackReason === null
          ? null
          : safeText(value.fallbackReason, 'acknowledgement.fallbackReason'),
    });
  }

  /** @param {ReturnType<typeof candidate>} selected @param {'auto' | 'manual'} mode @param {'story' | 'scene' | 'action'} requested @param {string | null} initiatingInputId */
  async function perform(selected, mode, requested, initiatingInputId) {
    const resolved = resolveDsl4ReloadAnchor({
      requestedPreference: requested,
      availability: selected.availability,
    });
    applying = deepFreeze({revision: selected.revision, mode, requestedPreference: requested});
    await notify();
    const operation = mode === 'auto' ? options.applyGeneration : options.restartGeneration;
    try {
      const ack = acknowledgement(
        await operation(
          deepFreeze({
            revision: selected.revision,
            mode,
            requestedPreference: requested,
            actualAnchor: resolved.actualAnchor,
            fallbackReason: resolved.fallbackReason,
            summary: selected.summary,
          }),
        ),
        selected.revision,
      );
      applying = null;
      const acknowledgedAt = Number(clock.now());
      lastSuccess = deepFreeze({
        revision: selected.revision,
        acknowledgedAt,
        visibleUntil: acknowledgedAt + minimumSuccessDisplayMs,
        requestedPreference: requested,
        actualAnchor: ack.actualAnchor,
        fallbackReason: ack.fallbackReason,
        initiatingInputId,
        acknowledged: false,
        seen: false,
      });
      currentDiagnostic = null;
      await notify();
      return {ok: true, acknowledgement: ack};
    } catch (error) {
      applying = null;
      currentDiagnostic = deepFreeze({
        code: 'K4-PREVIEW-RELOAD-APPLY-001',
        severity: 'error',
        message: 'The preview kept the last-known-good generation because reload failed.',
      });
      reportError(error);
      await notify();
      return {ok: false, error};
    }
  }

  /** @param {ReturnType<typeof candidate>} selected */
  async function adopt(selected) {
    if (selected.revision !== latestSeenRevision || selected.revision <= latestAppliedRevision) {
      return snapshot();
    }
    const result = await perform(selected, 'auto', currentPreference, selected.initiatingInputId);
    if (result.ok) {
      latestAppliedRevision = selected.revision;
      currentGeneration = selected;
    }
    await notify();
    return snapshot();
  }

  /** @param {unknown} input */
  function submitCandidate(input) {
    if (disposed) throw new TypeError('reload policy is disposed');
    const selected = candidate(input);
    if (selected.revision <= latestSeenRevision) {
      fail('K4-PREVIEW-RELOAD-STALE-001', 'Reload candidate revision is stale or duplicate');
    }
    latestSeenRevision = selected.revision;
    latestCandidate = selected;
    currentDiagnostic = null;
    if (dialog.open && dialog.targetRevision !== selected.revision) {
      dialog = {
        open: true,
        step: 'position',
        targetRevision: selected.revision,
        selectedPreference: null,
        stale: true,
      };
    }
    void notify();
    return enqueue(() => adopt(selected));
  }

  /** @param {'watching' | 'stabilizing' | 'paused' | 'disconnected'} value */
  async function setWatchState(value) {
    if (!watchStates.has(value)) throw new TypeError('reload watch state is invalid');
    watchStatus = value;
    await notify();
    return snapshot();
  }

  /** @param {unknown} value */
  async function setDiagnostic(value) {
    if (value === null) {
      currentDiagnostic = null;
    } else {
      if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string') {
        throw new TypeError('reload diagnostic is invalid');
      }
      currentDiagnostic = deepFreeze({
        code: safeText(value.code, 'diagnostic.code'),
        severity: value.severity === 'warning' ? 'warning' : 'error',
        message: safeText(value.message, 'diagnostic.message'),
      });
    }
    await notify();
    return snapshot();
  }

  /** @param {{inputId?: string, explicit?: boolean}} [input] */
  async function acknowledge(input = {}) {
    if (!isRecord(input)) throw new TypeError('reload acknowledgement input is invalid');
    if (!lastSuccess || lastSuccess.seen || currentDiagnostic) return snapshot();
    const inputId =
      input.inputId === undefined ? null : safeText(input.inputId, 'acknowledgement.inputId');
    if (input.explicit !== true && inputId !== null && inputId === lastSuccess.initiatingInputId) {
      return snapshot();
    }
    lastSuccess = {...lastSuccess, acknowledged: true};
    scheduleAcknowledgement();
    await notify();
    return snapshot();
  }

  /** @param {{inputId?: string}} [input] */
  async function openDialog(input = {}) {
    if (disposed) throw new TypeError('reload policy is disposed');
    await acknowledge({...input, explicit: true});
    const target = latestCandidate ?? currentGeneration;
    dialog = {
      open: true,
      step: 'position',
      targetRevision: target?.revision ?? null,
      selectedPreference: null,
      stale: false,
    };
    await notify();
    return snapshot();
  }

  /** @param {unknown} value */
  async function selectPosition(value) {
    if (!dialog.open || dialog.step !== 'position') {
      throw new TypeError('reload dialog is not selecting a position');
    }
    dialog = {...dialog, step: 'scope', selectedPreference: preference(value, 'position')};
    await notify();
    return snapshot();
  }

  function closeDialog() {
    dialog = {
      open: false,
      step: 'position',
      targetRevision: null,
      selectedPreference: null,
      stale: false,
    };
  }

  /** @param {unknown} value @param {{inputId?: string}} [input] */
  function applyScope(value, input = {}) {
    if (typeof value !== 'string' || !manualScopes.has(value)) {
      throw new TypeError('reload dialog scope is invalid');
    }
    return enqueue(async () => {
      if (!dialog.open) throw new TypeError('reload dialog is closed');
      if (value === 'cancel') {
        closeDialog();
        await notify();
        return snapshot();
      }
      if (dialog.step !== 'scope' || !dialog.selectedPreference) {
        throw new TypeError('reload dialog has no selected position');
      }
      const selectedPreference = dialog.selectedPreference;
      if (value === 'save-next') {
        currentPreference = selectedPreference;
        closeDialog();
        await notify();
        return snapshot();
      }
      if (dialog.targetRevision !== latestSeenRevision) {
        dialog = {
          open: true,
          step: 'position',
          targetRevision: latestSeenRevision || null,
          selectedPreference: null,
          stale: true,
        };
        await notify();
        return snapshot();
      }
      const selected =
        currentGeneration?.revision === dialog.targetRevision
          ? currentGeneration
          : latestCandidate?.revision === dialog.targetRevision
            ? latestCandidate
            : null;
      if (!selected) fail('K4-PREVIEW-RELOAD-STALE-001', 'Dialog generation is unavailable');
      const previousPreference = currentPreference;
      const inputId =
        input.inputId === undefined ? null : safeText(input.inputId, 'manualReload.inputId');
      const result = await perform(selected, 'manual', selectedPreference, inputId);
      if (result.ok && value === 'reload-and-save') currentPreference = selectedPreference;
      if (!result.ok) currentPreference = previousPreference;
      closeDialog();
      await notify();
      return snapshot();
    });
  }

  async function dispose() {
    if (disposed) return snapshot();
    disposed = true;
    cancelAcknowledgementTimer();
    closeDialog();
    await operationQueue;
    await notify();
    return snapshot();
  }

  return Object.freeze({
    submitCandidate,
    setWatchState,
    setDiagnostic,
    acknowledge,
    openDialog,
    selectPosition,
    applyScope,
    /** @param {(state: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} observer */
    subscribe(observer) {
      if (typeof observer !== 'function')
        throw new TypeError('policy subscriber must be a function');
      subscribers.add(observer);
      return () => subscribers.delete(observer);
    },
    dispose,
    getState: snapshot,
    async whenIdle() {
      await operationQueue;
      return snapshot();
    },
  });
}
