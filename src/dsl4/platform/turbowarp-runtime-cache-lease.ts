export const defaultCacheLeaseHeartbeatMs = 30_000;

export function defaultCacheLeaseHeartbeatSchedule(
  callback: () => void,
  milliseconds: number,
): () => void {
  const timer = setInterval(callback, milliseconds);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

export function createDsl4RuntimeCacheLeaseLifecycle({
  cachePort,
  heartbeatMs,
  scheduleHeartbeat,
}: {
  cachePort: Record<'renewLease' | 'releaseLease', () => unknown> | null;
  heartbeatMs: number;
  scheduleHeartbeat: (callback: () => void, milliseconds: number) => () => void;
}) {
  let cancelHeartbeat: (() => void) | null = null;
  let operation = Promise.resolve();
  let error: unknown = null;
  let active = cachePort !== null;

  function queue(run: () => unknown | Promise<unknown>, clearErrorOnSuccess = false) {
    if (!cachePort) return operation;
    operation = operation.then(async () => {
      try {
        await run();
        if (clearErrorOnSuccess) error = null;
      } catch (caught) {
        error = caught;
      }
    });
    return operation;
  }

  function startHeartbeat() {
    if (!cachePort || cancelHeartbeat) return;
    const cancel = scheduleHeartbeat(() => {
      void queue(() => cachePort.renewLease(), true);
    }, heartbeatMs);
    if (typeof cancel !== 'function') {
      throw new TypeError('scheduleCacheLeaseHeartbeat must return a cancellation function');
    }
    cancelHeartbeat = cancel;
  }

  return Object.freeze({
    async activate() {
      if (!cachePort) return;
      await queue(() => cachePort.renewLease(), true);
      active = true;
      startHeartbeat();
    },
    async deactivate() {
      const cancel = cancelHeartbeat;
      cancelHeartbeat = null;
      try {
        cancel?.();
      } catch (caught) {
        error = caught;
      }
      if (!cachePort || !active) return;
      active = false;
      await queue(() => cachePort.releaseLease());
    },
    getError() {
      return error;
    },
  });
}
