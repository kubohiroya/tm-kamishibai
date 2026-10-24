import {createDsl4RetryableCleanup} from './retryable-cleanup.js';

type CleanupStep = Parameters<typeof createDsl4RetryableCleanup>[0]['steps'][number];

export interface Dsl4CreationCleanup {
  readonly completion: Promise<void> | null;
  dispose(reason?: string): Promise<void>;
  hasPendingCleanup(): boolean;
}

/** Carry cleanup ownership when a factory cannot publish its normal result. */
export class Dsl4CreationFailure extends AggregateError {
  readonly cleanup: Dsl4CreationCleanup;

  constructor(
    failure: unknown,
    cleanup: Dsl4CreationCleanup,
    message: string,
    cleanupError?: unknown,
  ) {
    super(
      [
        failure,
        ...(cleanupError instanceof AggregateError
          ? cleanupError.errors
          : cleanupError === undefined
            ? []
            : [cleanupError]),
      ],
      `${message}: ${failure instanceof Error ? failure.message : String(failure)}`,
      {cause: failure},
    );
    this.name = 'Dsl4CreationFailure';
    this.cleanup = cleanup;
  }
}

export function getDsl4CreationCleanup(failure: unknown): Dsl4CreationCleanup | null {
  // An injected factory may use another copy of the module (for example a bundled runtime).
  if (failure instanceof Dsl4CreationFailure) return failure.cleanup;
  try {
    if (typeof failure !== 'object' || failure === null) return null;
    const error = failure as {name?: unknown; cleanup?: unknown};
    if (
      error.name !== 'Dsl4CreationFailure' ||
      typeof error.cleanup !== 'object' ||
      error.cleanup === null
    )
      return null;
    const cleanup = error.cleanup as Partial<Dsl4CreationCleanup>;
    const completion = cleanup.completion;
    return typeof cleanup.dispose === 'function' &&
      typeof cleanup.hasPendingCleanup === 'function' &&
      (completion === null ||
        (typeof completion === 'object' &&
          completion !== null &&
          typeof completion.then === 'function'))
      ? (cleanup as Dsl4CreationCleanup)
      : null;
  } catch {
    // An opaque third-party exception must not replace the original preparation failure.
    return null;
  }
}

/** A parent joins its child's initial cleanup; only a later attempt may retry it. */
export function dsl4FailedCreationCleanupSteps(failure: unknown): readonly CleanupStep[] {
  const child = getDsl4CreationCleanup(failure);
  if (!child) return [];
  const initial = child.completion;
  let joined = false;
  return [
    {
      run(reason) {
        if (!joined) {
          joined = true;
          return initial ?? child.dispose(reason);
        }
        return child.dispose(reason);
      },
      isPending: () => child.hasPendingCleanup(),
    },
  ];
}

export function createDsl4CreationCleanup(
  steps: readonly CleanupStep[],
  message: string,
  parallel = false,
): Dsl4CreationCleanup {
  const cleanup = createDsl4RetryableCleanup({steps, message, parallel});
  return Object.freeze({
    get completion() {
      return cleanup.completion;
    },
    dispose: cleanup.run,
    hasPendingCleanup: cleanup.hasPendingCleanup,
  });
}

/** Preserve the original exception when cleanup is complete; otherwise hand off its owner. */
export async function cleanupDsl4FailedCreation(
  failure: unknown,
  cleanup: Dsl4CreationCleanup,
  reason: string,
  message: string,
): Promise<void> {
  try {
    await cleanup.dispose(reason);
  } catch (cleanupError) {
    throw new Dsl4CreationFailure(failure, cleanup, message, cleanupError);
  }
  if (cleanup.hasPendingCleanup()) throw new Dsl4CreationFailure(failure, cleanup, message);
}

/** Retain a returned composition even when validation/setup fails before its adapter exists. */
export function guardDsl4CompositionCreation<T>(
  candidate: unknown,
  initialize: () => T,
  message: string,
): T {
  try {
    return initialize();
  } catch (failure) {
    if (typeof candidate !== 'object' || candidate === null) throw failure;
    const composition = candidate as {
      releaseAll?: () => unknown;
      hasPendingCleanup?: () => boolean;
    };
    if (typeof composition.releaseAll !== 'function') throw failure;
    const cleanup = createDsl4CreationCleanup(
      [
        ...dsl4FailedCreationCleanupSteps(failure),
        {
          run: () => composition.releaseAll!(),
          isPending: () => composition.hasPendingCleanup?.() ?? false,
        },
      ],
      message,
      true,
    );
    void cleanup.dispose('partial-composition-failed').catch(() => {});
    throw new Dsl4CreationFailure(failure, cleanup, message);
  }
}
