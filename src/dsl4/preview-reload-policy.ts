import {resolveReloadAnchor} from '@kubohiroya/turbowarp-preview-runtime';

import {deepFreeze} from './story-document.js';

const preferences = new Set(['story', 'scene', 'action']);
const watchStates = new Set(['watching', 'stabilizing', 'paused', 'disconnected']);
const manualScopes = new Set(['reload-once', 'reload-and-save', 'save-next', 'cancel']);

export const dsl4PreviewReloadPolicyDefaults = deepFreeze({
  preference: 'action',
  minimumSuccessDisplayMs: 2_000,
});

export class Dsl4PreviewReloadPolicyError extends TypeError {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'Dsl4PreviewReloadPolicyError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new Dsl4PreviewReloadPolicyError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function preference(value: unknown, name: string) {
  if (typeof value !== 'string' || !preferences.has(value)) {
    throw new TypeError(`${name} must be story, scene, or action`);
  }
  return value as 'story' | 'scene' | 'action';
}

function positiveInteger(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

function milliseconds(value: unknown, name: string, minimum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

function safeText(value: unknown, name: string) {
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

function anchorAvailability(value: unknown, name: string) {
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

function availability(value: unknown) {
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

function candidate(value: unknown) {
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

function validateClock(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.now !== 'function' ||
    typeof value.setTimeout !== 'function' ||
    typeof value.clearTimeout !== 'function'
  ) {
    throw new TypeError('reload policy clock is invalid');
  }
  return value as Readonly<Record<string, Function>>;
}

const defaultClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback: Function, delay: number) => setTimeout(callback, delay),
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
});

/** Resolve the actual safe anchor without mutating the requested session preference. */
export function resolveDsl4ReloadAnchor({
  requestedPreference,
  availability: inputAvailability,
}: {
  requestedPreference: 'story' | 'scene' | 'action';
  availability: unknown;
}) {
  return resolveReloadAnchor({
    requestedPreference: preference(requestedPreference, 'requestedPreference'),
    availability: availability(inputAvailability),
  });
}

/** Serialize automatic generation adoption and explicit manual restart/preference transactions. */
export function createDsl4PreviewReloadPolicy(options: {
  applyGeneration: (request: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
  restartGeneration: (request: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
  onState?: (state: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
  onError?: (error: unknown) => unknown;
  clock?: Readonly<Record<string, Function>> | undefined;
  minimumSuccessDisplayMs?: number;
}) {
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
  let watchStatus: 'watching' | 'stabilizing' | 'paused' | 'disconnected' = 'watching';
  let currentPreference: 'story' | 'scene' | 'action' = 'action';
  let latestSeenRevision = 0;
  let latestAppliedRevision = 0;
  let latestCandidate: ReturnType<typeof candidate> | null = null;
  let currentGeneration: ReturnType<typeof candidate> | null = null;
  let applying: Readonly<Record<string, unknown>> | null = null;
  let currentDiagnostic: Readonly<Record<string, unknown>> | null = null;
  let lastSuccess: Readonly<Record<string, any>> | null = null;
  let dialog: {
    open: boolean;
    step: 'position' | 'scope';
    targetRevision: number | null;
    selectedPreference: 'story' | 'scene' | 'action' | null;
    stale: boolean;
  } = {
    open: false,
    step: 'position',
    targetRevision: null,
    selectedPreference: null,
    stale: false,
  };
  let acknowledgementTimer: unknown = null;
  let operationQueue = Promise.resolve();
  const subscribers = new Set<
    (state: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>
  >();

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

  function reportError(error: unknown) {
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

  function enqueue(operation: () => unknown | Promise<unknown>) {
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

  function acknowledgement(value: unknown, revision: number) {
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

  async function perform(
    selected: ReturnType<typeof candidate>,
    mode: 'auto' | 'manual',
    requested: 'story' | 'scene' | 'action',
    initiatingInputId: string | null,
  ) {
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

  async function adopt(selected: ReturnType<typeof candidate>) {
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

  function submitCandidate(input: unknown) {
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

  async function setWatchState(value: 'watching' | 'stabilizing' | 'paused' | 'disconnected') {
    if (!watchStates.has(value)) throw new TypeError('reload watch state is invalid');
    watchStatus = value;
    await notify();
    return snapshot();
  }

  async function setDiagnostic(value: unknown) {
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

  async function acknowledge(input: {inputId?: string; explicit?: boolean} = {}) {
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

  async function openDialog(input: {inputId?: string} = {}) {
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

  async function selectPosition(value: unknown) {
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

  function applyScope(value: unknown, input: {inputId?: string} = {}) {
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
    subscribe(observer: (state: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>) {
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
