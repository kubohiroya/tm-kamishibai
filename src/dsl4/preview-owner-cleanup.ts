import {
  createDsl4CreationCleanup,
  Dsl4CreationFailure,
  dsl4FailedCreationCleanupSteps,
} from './creation-cleanup.js';
import type {Dsl4PreviewDocument} from './preview-dom.js';
import {createDsl4RetryableCleanup} from './retryable-cleanup.js';

type Step = Parameters<typeof createDsl4RetryableCleanup>[0]['steps'][number];

/** Register each resource before setup can fail; close inputs before invoking any release callback. */
export function createDsl4PreviewOwnerCleanup(message: string) {
  const steps: Step[] = [];
  let closed = false;
  let cleanup: ReturnType<typeof createDsl4RetryableCleanup> | null = null;
  function add(step: Step) {
    if (closed) throw new TypeError('preview cleanup registration is closed');
    steps.push(step);
  }
  return Object.freeze({
    add,
    close() {
      closed = true;
    },
    own(candidate: unknown) {
      if (typeof candidate !== 'object' || candidate === null) return;
      const owner = candidate as {dispose?: () => unknown; hasPendingCleanup?: () => boolean};
      if (typeof owner.dispose !== 'function') return;
      add({
        run: () => owner.dispose!(),
        isPending: () => owner.hasPendingCleanup?.() ?? false,
      });
    },
    listen(
      target: Pick<Dsl4PreviewDocument, 'addEventListener' | 'removeEventListener'>,
      type: string,
      listener: (event: never) => unknown,
      options?: unknown,
    ) {
      const guarded = (event: never) => {
        if (!closed) return listener(event);
      };
      add(() => target.removeEventListener(type, guarded, options));
      target.addEventListener(type, guarded, options);
    },
    hasPendingCleanup() {
      return cleanup?.hasPendingCleanup() ?? steps.length > 0;
    },
    dispose() {
      closed = true;
      cleanup ??= createDsl4RetryableCleanup({steps, message, parallel: true});
      return cleanup.run();
    },
    fail(failure: unknown): never {
      closed = true;
      const failed = createDsl4CreationCleanup(
        [...dsl4FailedCreationCleanupSteps(failure), ...steps],
        message,
        true,
      );
      void failed.dispose('preview-creation-failed').catch(() => {});
      throw new Dsl4CreationFailure(failure, failed, message);
    },
  });
}
