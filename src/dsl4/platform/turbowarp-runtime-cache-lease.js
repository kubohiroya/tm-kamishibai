export const defaultCacheLeaseHeartbeatMs = 30_000;

/** @param {() => void} callback @param {number} milliseconds */
export function defaultCacheLeaseHeartbeatSchedule(callback, milliseconds) {
  const timer = setInterval(callback, milliseconds);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

/**
 * @param {{
 *   cachePort: Record<string, any> | null,
 *   heartbeatMs: number,
 *   scheduleHeartbeat: (callback: () => void, milliseconds: number) => () => void,
 * }} options
 */
export function createDsl4RuntimeCacheLeaseLifecycle({cachePort, heartbeatMs, scheduleHeartbeat}) {
  /** @type {null | (() => void)} */
  let cancelHeartbeat = null;
  let operation = Promise.resolve();
  /** @type {unknown} */
  let error = null;
  let active = cachePort !== null;

  /** @param {() => unknown | Promise<unknown>} run @param {boolean} [clearErrorOnSuccess] */
  function queue(run, clearErrorOnSuccess = false) {
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
