import {createDsl4CreationCleanup} from './creation-cleanup.js';

type Step = Parameters<typeof createDsl4CreationCleanup>[0][number];

/** Own resources discovered during asynchronous reads/preparation, including late arrivals. */
export function createDsl4AssetCleanupOwners(message: string) {
  type Entry = {
    cleanup: ReturnType<typeof createDsl4CreationCleanup>;
    current: Promise<void> | null;
    failure: unknown;
  };
  const entries = new Set<Entry>();
  let attempted: Set<Entry> | null = null;
  function release(entry: Entry, reason = 'dispose'): Promise<void> {
    attempted?.add(entry);
    if (entry.current) return entry.current;
    if (!entries.has(entry)) return Promise.resolve();
    let resolve!: () => void, reject!: (error: unknown) => void;
    const operation = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    entry.current = operation;
    void operation.then(
      () => {
        entry.current = null;
      },
      () => {
        entry.current = null;
      },
    );
    void entry.cleanup
      .dispose(reason)
      .then(() => {
        if (entry.cleanup.hasPendingCleanup()) throw new Error('Asset cleanup is still pending');
        entries.delete(entry);
        entry.failure = null;
      })
      .then(resolve, (error) => {
        entry.failure = error;
        reject(error);
      });
    return operation;
  }
  return Object.freeze({
    own(steps: readonly Step[]) {
      const entry: Entry = {
        cleanup: createDsl4CreationCleanup(steps, message, true),
        current: null,
        failure: null,
      };
      entries.add(entry);
      return Object.freeze({
        get completion() {
          return entry.current ?? entry.cleanup.completion;
        },
        dispose: (reason?: string) => release(entry, reason),
        release: (reason?: string) => release(entry, reason),
        hasPendingCleanup: () => entries.has(entry),
      });
    },
    hasPendingCleanup: () => entries.size > 0,
    get size() {
      return entries.size;
    },
    beginDispose() {
      // An in-flight release belongs to this attempt; join it instead of retrying its failure.
      attempted ??= new Set([...entries].filter((entry) => entry.current !== null));
    },
    endDispose() {
      attempted = null;
    },
    async drain(reason = 'dispose') {
      const seen = attempted ?? new Set<Entry>();
      for (;;) {
        const remaining = [...entries].filter((entry) => !seen.has(entry));
        remaining.forEach((entry) => seen.add(entry));
        await Promise.allSettled(remaining.map((entry) => release(entry, reason)));
        await Promise.allSettled([...entries].map((entry) => entry.current).filter(Boolean));
        if (![...entries].some((entry) => !seen.has(entry))) break;
      }
      if (entries.size > 0) {
        throw new AggregateError(
          [...entries].map((entry) => entry.failure ?? new Error('Asset cleanup is pending')),
          message,
        );
      }
    },
  });
}

/** Closing releases observer waits, while late observer failures remain visible. */
export function createDsl4AssetObserverWaits(reportError: (error: unknown) => void) {
  let closed = false;
  const waiters = new Set<() => void>();
  return Object.freeze({
    close() {
      closed = true;
      for (const release of waiters) release();
      waiters.clear();
    },
    async wait(operation: () => unknown) {
      let value: unknown;
      try {
        value = operation();
      } catch (error) {
        if (!closed) throw error;
        reportError(error);
        return;
      }
      const completion = Promise.resolve(value).then(
        () => ({ok: true as const}),
        (error) => {
          if (closed) reportError(error);
          return {ok: false as const, error};
        },
      );
      if (closed) return;
      let release!: () => void;
      const closing = new Promise<null>((resolve) => {
        release = () => resolve(null);
      });
      waiters.add(release);
      try {
        const result = await Promise.race([completion, closing]);
        if (result && !result.ok) throw result.error;
      } finally {
        waiters.delete(release);
      }
    },
  });
}
