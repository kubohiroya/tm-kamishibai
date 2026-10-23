type CleanupStep =
  | ((reason: string) => unknown)
  | {
      run: (reason: string) => unknown;
      isPending: () => boolean;
    };

/** Keep failed cleanup owners reachable while permanently closing the owning surface. */
export function createDsl4RetryableCleanup({
  steps,
  message,
  parallel = false,
}: {
  steps: readonly CleanupStep[];
  message: string;
  parallel?: boolean;
}) {
  const pending = new Set(steps.map((_step, index) => index));
  const unverified = new Set<number>();
  const hasInspectors = steps.some((step) => typeof step !== 'function');
  let checking = false;
  let requested = false;
  let running = false;
  let attempt: Promise<void> | null = null;
  let completion: Promise<void> | null = null;
  return Object.freeze({
    get requested() {
      return requested;
    },
    get completion() {
      return completion;
    },
    hasPendingCleanup() {
      if (running || checking || pending.size > 0 || unverified.size > 0) return true;
      checking = true;
      try {
        return steps.some((step) => {
          try {
            return typeof step !== 'function' && step.isPending();
          } catch {
            return true;
          }
        });
      } finally {
        checking = false;
      }
    },
    run(reason: string = 'dispose'): Promise<void> {
      if (running) return attempt!;
      if (attempt && pending.size === 0 && !hasInspectors) return attempt;
      if (typeof reason !== 'string' || reason.length === 0) {
        return Promise.reject(new TypeError('dispose reason must be a non-empty string'));
      }
      requested = true;
      let resolve!: () => void, reject!: (error: unknown) => void;
      const operation = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      // Publish before inspection, cancellation, or release callbacks can reenter disposal.
      running = true;
      attempt = completion = operation;
      void operation.then(
        () => {
          if (attempt === operation) running = false;
        },
        () => {
          if (attempt === operation) {
            running = false;
            attempt = null;
          }
        },
      );
      void (async () => {
        const errors: unknown[] = [];
        const release = async (index: number) => {
          const step = steps[index]!;
          if (typeof step !== 'function') {
            try {
              if (step.isPending()) pending.add(index);
              unverified.delete(index);
            } catch (error) {
              // Preserve an unknown child until an explicit retry can inspect it again.
              unverified.add(index);
              errors.push(error);
            }
          }
          if (!pending.has(index)) return;
          try {
            await (typeof step === 'function' ? step(reason) : step.run(reason));
            pending.delete(index);
          } catch (error) {
            errors.push(error);
          }
        };
        const indices = steps.map((_step, index) => index);
        if (parallel) await Promise.all(indices.map(release));
        else for (const index of indices) await release(index);
        if (errors.length > 0) throw new AggregateError(errors, message);
      })().then(resolve, reject);
      return operation;
    },
  });
}
