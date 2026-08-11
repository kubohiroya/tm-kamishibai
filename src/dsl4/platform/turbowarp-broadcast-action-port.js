const broadcastHatOpcode = 'event_whenbroadcastreceived';
const broadcastMessageType = 'broadcast_msg';
const afterExecuteEvent = 'AFTER_EXECUTE';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} code @param {string} message @param {unknown} [cause] */
function broadcastError(code, message, cause) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  if (cause !== undefined) Object.defineProperty(error, 'cause', {value: cause});
  return error;
}

/** @param {string} message */
function cancelledError(message) {
  const error = broadcastError('K4-BROADCAST-CANCELLED', message);
  error.name = 'AbortError';
  return error;
}

/** @param {unknown} value */
function validateSignal(value) {
  if (
    !isRecord(value) ||
    typeof value.aborted !== 'boolean' ||
    typeof value.addEventListener !== 'function' ||
    typeof value.removeEventListener !== 'function'
  ) {
    throw broadcastError(
      'K4-BROADCAST-CONTEXT-001',
      'broadcastMessageAndWait context must provide an AbortSignal',
    );
  }
  return /** @type {AbortSignal} */ (/** @type {unknown} */ (value));
}

/** @param {unknown} value */
function validateRuntime(value) {
  if (!isRecord(value)) {
    throw broadcastError(
      'K4-BROADCAST-RUNTIME-001',
      'TurboWarp broadcast action port requires a runtime object',
    );
  }
  for (const method of ['getTargetForStage', 'startHats', '_stopThread', 'on']) {
    if (typeof value[method] !== 'function') {
      throw broadcastError('K4-BROADCAST-RUNTIME-001', `TurboWarp runtime must provide ${method}`);
    }
  }
  const removeListener =
    typeof value.off === 'function'
      ? value.off.bind(value)
      : typeof value.removeListener === 'function'
        ? value.removeListener.bind(value)
        : null;
  if (!removeListener) {
    throw broadcastError(
      'K4-BROADCAST-RUNTIME-001',
      'TurboWarp runtime must provide off or removeListener',
    );
  }
  if (!Array.isArray(value.threads)) {
    throw broadcastError('K4-BROADCAST-RUNTIME-001', 'TurboWarp runtime threads must be an array');
  }
  return Object.freeze({
    runtime: /** @type {Record<string, any>} */ (value),
    removeListener,
  });
}

/** @param {unknown} payload */
function validatePayload(payload) {
  if (
    !isRecord(payload) ||
    Object.keys(payload).length !== 1 ||
    typeof payload.message !== 'string' ||
    payload.message.length === 0
  ) {
    throw broadcastError(
      'K4-BROADCAST-PAYLOAD-001',
      'broadcastMessageAndWait payload must contain one non-empty message string',
    );
  }
  return payload.message;
}

/**
 * Resolve only a project-declared exact broadcast name. Scratch normally performs a
 * case-insensitive lookup; DSL 4.0 intentionally keeps the authored name exact.
 *
 * @param {Record<string, any>} runtime
 * @param {string} message
 */
function resolveExactBroadcast(runtime, message) {
  let stage;
  try {
    stage = runtime.getTargetForStage();
  } catch (cause) {
    throw broadcastError(
      'K4-BROADCAST-RUNTIME-001',
      'TurboWarp Stage broadcast registry could not be read',
      cause,
    );
  }
  if (!isRecord(stage) || !isRecord(stage.variables)) {
    throw broadcastError(
      'K4-BROADCAST-RUNTIME-001',
      'TurboWarp Stage broadcast registry is unavailable',
    );
  }
  const declared = Object.values(stage.variables).find(
    (variable) =>
      isRecord(variable) && variable.type === broadcastMessageType && variable.name === message,
  );
  return declared ? message : null;
}

/**
 * Create one session-owned TurboWarp port for the DSL 4.0 broadcastMessageAndWait action.
 * Receiver threads never receive DSL ActionContext; ownership is tracked only by thread identity.
 *
 * @param {unknown} options
 */
export function createDsl4TurboWarpBroadcastActionPort(options) {
  if (!isRecord(options)) {
    throw broadcastError(
      'K4-BROADCAST-RUNTIME-001',
      'TurboWarp broadcast action port options must be an object',
    );
  }
  const runtimeInput = options.runtime;
  const {runtime, removeListener} = validateRuntime(runtimeInput);
  /** @type {Set<{cancel: (message: string) => void}>} */
  const activeInvocations = new Set();
  let disposed = false;

  /** @param {unknown} thread */
  function threadIsActive(thread) {
    return runtime.threads.includes(thread);
  }

  /** @param {ReadonlyArray<unknown>} threads @param {string} reason */
  function stopOwnedThreads(threads, reason) {
    const errors = [];
    for (const thread of threads) {
      if (!threadIsActive(thread)) continue;
      try {
        runtime._stopThread(thread);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw broadcastError(
        'K4-BROADCAST-CLEANUP-001',
        `TurboWarp broadcast receiver cleanup failed: ${reason}`,
        errors.length === 1 ? errors[0] : new AggregateError(errors),
      );
    }
  }

  const port = {
    /** @param {unknown} payload @param {unknown} context */
    broadcastMessageAndWait(payload, context) {
      if (disposed) {
        return Promise.reject(
          broadcastError('K4-BROADCAST-DISPOSED', 'TurboWarp broadcast action port is disposed'),
        );
      }
      const message = validatePayload(payload);
      const signal = validateSignal(isRecord(context) ? context.signal : undefined);
      if (signal.aborted) {
        return Promise.reject(cancelledError('broadcastMessageAndWait action was cancelled'));
      }
      const broadcastName = resolveExactBroadcast(runtime, message);
      if (broadcastName === null) return Promise.resolve();

      /** @type {unknown} */
      let started;
      try {
        started = runtime.startHats(broadcastHatOpcode, {BROADCAST_OPTION: broadcastName});
      } catch (cause) {
        throw broadcastError(
          'K4-BROADCAST-START-001',
          'TurboWarp broadcast receiver threads could not be started',
          cause,
        );
      }
      const threads = started === undefined ? [] : started;
      if (!Array.isArray(threads)) {
        throw broadcastError(
          'K4-BROADCAST-RUNTIME-001',
          'TurboWarp startHats must return receiver threads or undefined',
        );
      }
      if (threads.length === 0) return Promise.resolve();

      return new Promise((resolve, reject) => {
        let settled = false;
        let runtimeListenerAttached = false;
        let abortListenerAttached = false;
        const invocation = {
          /** @param {string} messageText */
          cancel(messageText) {
            settleCancelled(messageText);
          },
        };
        /** @param {string} reason */
        const cleanup = (reason) => {
          const errors = [];
          if (runtimeListenerAttached) {
            runtimeListenerAttached = false;
            try {
              removeListener(afterExecuteEvent, handleAfterExecute);
            } catch (error) {
              errors.push(error);
            }
          }
          if (abortListenerAttached) {
            abortListenerAttached = false;
            try {
              signal.removeEventListener('abort', handleAbort);
            } catch (error) {
              errors.push(error);
            }
          }
          activeInvocations.delete(invocation);
          if (errors.length > 0) {
            throw broadcastError(
              'K4-BROADCAST-CLEANUP-001',
              `TurboWarp broadcast observer cleanup failed: ${reason}`,
              errors.length === 1 ? errors[0] : new AggregateError(errors),
            );
          }
        };
        const settleCompleted = () => {
          if (settled || threads.some(threadIsActive)) return;
          settled = true;
          try {
            cleanup('receiver completion');
          } catch (error) {
            reject(error);
            return;
          }
          resolve(undefined);
        };
        /** @param {string} messageText */
        const settleCancelled = (messageText) => {
          if (settled) return;
          settled = true;
          let cleanupError;
          try {
            stopOwnedThreads(threads, messageText);
          } catch (error) {
            cleanupError = error;
          }
          try {
            cleanup(messageText);
          } catch (error) {
            cleanupError =
              cleanupError === undefined
                ? error
                : broadcastError(
                    'K4-BROADCAST-CLEANUP-001',
                    `TurboWarp broadcast cancellation cleanup failed: ${messageText}`,
                    new AggregateError([cleanupError, error]),
                  );
          }
          reject(cleanupError ?? cancelledError(messageText));
        };
        const handleAfterExecute = () => settleCompleted();
        const handleAbort = () => settleCancelled('broadcastMessageAndWait action was cancelled');

        activeInvocations.add(invocation);
        try {
          runtimeListenerAttached = true;
          runtime.on(afterExecuteEvent, handleAfterExecute);
          abortListenerAttached = true;
          signal.addEventListener('abort', handleAbort, {once: true});
        } catch (cause) {
          settled = true;
          /** @type {unknown[]} */
          const errors = [
            broadcastError(
              'K4-BROADCAST-RUNTIME-001',
              'TurboWarp broadcast receiver completion could not be observed',
              cause,
            ),
          ];
          try {
            stopOwnedThreads(threads, 'observer setup failure');
          } catch (error) {
            errors.push(error);
          }
          try {
            cleanup('observer setup failure');
          } catch (error) {
            errors.push(error);
          }
          reject(
            errors.length === 1
              ? errors[0]
              : broadcastError(
                  'K4-BROADCAST-CLEANUP-001',
                  'TurboWarp broadcast observer setup cleanup failed',
                  new AggregateError(errors),
                ),
          );
          return;
        }
        if (signal.aborted) {
          handleAbort();
          return;
        }
        settleCompleted();
      });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const invocation of [...activeInvocations]) {
        invocation.cancel('TurboWarp broadcast action port was disposed');
      }
    },
  };

  return Object.freeze(port);
}
