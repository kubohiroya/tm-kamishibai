import {deepFreeze} from './story-document.js';

const inputKinds = new Set(['key', 'touch']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function candidates(value: unknown, name: string) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (candidate) =>
        typeof candidate !== 'string' || candidate.length === 0 || candidate !== candidate.trim(),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError(`${name} must be a non-empty array of unique trimmed strings`);
  }
  return new Set(value);
}

function historyPaused(value: unknown) {
  if (!isRecord(value) || typeof value.historyPaused !== 'boolean') {
    throw new TypeError('input arbitration context must provide historyPaused');
  }
  return value.historyPaused;
}

/**
 * Coordinate navigation input with the currently active story input action.
 *
 * Exact eligible story keys win defensively, while any other navigation key may synchronously
 * cancel the action through the runtime controller. Actor touch resolves on pointerdown, so the
 * matching pointer release is suppressed once and cannot advance the next action.
 */
export function createDsl4InputArbitration() {
  let disposed = false;
  let generation = 0;
  let activeStoryInput: {
    generation: number;
    kind: 'key' | 'touch';
    candidates: Set<string>;
  } | null = null;
  let suppressPointerRelease = false;

  function ensureActive() {
    if (disposed) throw new TypeError('input arbitration is disposed');
  }

  function beginStoryInput(kind: 'key' | 'touch', inputCandidates: unknown) {
    ensureActive();
    if (!inputKinds.has(kind)) throw new TypeError('story input kind must be key or touch');
    const token = deepFreeze({generation: ++generation, kind});
    activeStoryInput = {
      generation: token.generation,
      kind,
      candidates: candidates(inputCandidates, `${kind} candidates`),
    };
    return token;
  }

  function finishStoryInput(inputToken: unknown, {accepted = false}: {accepted?: boolean} = {}) {
    if (typeof accepted !== 'boolean') throw new TypeError('accepted must be boolean');
    if (!isRecord(inputToken)) return false;
    const tokenGeneration = inputToken.generation;
    const tokenKind = inputToken.kind;
    if (
      !activeStoryInput ||
      tokenGeneration !== activeStoryInput.generation ||
      tokenKind !== activeStoryInput.kind
    ) {
      return false;
    }
    if (accepted && activeStoryInput.kind === 'touch') suppressPointerRelease = true;
    activeStoryInput = null;
    return true;
  }

  function shouldDeferNavigationKey(input: unknown) {
    ensureActive();
    if (!isRecord(input) || typeof input.code !== 'string' || input.code.length === 0) {
      throw new TypeError('navigation key context must provide code');
    }
    if (historyPaused(input)) return false;
    return activeStoryInput?.kind === 'key' && activeStoryInput.candidates.has(String(input.code));
  }

  function arbitrateNavigationPointer(input: unknown): 'allow' | 'defer' | 'suppress' {
    ensureActive();
    const paused = historyPaused(input);
    if (suppressPointerRelease) {
      suppressPointerRelease = false;
      return 'suppress';
    }
    if (paused) return 'allow';
    if (activeStoryInput?.kind === 'touch') return 'defer';
    return 'allow';
  }

  function cancelNavigationPointer(input: unknown) {
    ensureActive();
    if (!isRecord(input) || typeof input.pointerType !== 'string') {
      throw new TypeError('pointer cancellation context must provide pointerType');
    }
    suppressPointerRelease = false;
  }

  function snapshot() {
    return deepFreeze({
      version: 1,
      disposed,
      activeStoryInputKind: activeStoryInput?.kind ?? null,
      activeStoryCandidateCount: activeStoryInput?.candidates.size ?? 0,
      suppressPointerRelease,
    });
  }

  function dispose() {
    if (disposed) return;
    activeStoryInput = null;
    suppressPointerRelease = false;
    disposed = true;
  }

  return Object.freeze({
    beginStoryInput,
    finishStoryInput,
    shouldDeferNavigationKey,
    arbitrateNavigationPointer,
    cancelNavigationPointer,
    getState: snapshot,
    dispose,
  });
}
