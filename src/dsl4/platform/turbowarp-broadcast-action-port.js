import {createTurboWarpBroadcastPort} from '@kubohiroya/turbowarp-runtime-host';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} code @param {string} message */
function broadcastError(code, message) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  return error;
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
  const sharedPort = createTurboWarpBroadcastPort({
    runtime: options.runtime,
    errorCodePrefix: 'K4',
  });
  return Object.freeze({
    /** @param {{message: string}} payload @param {{signal: AbortSignal}} context */
    broadcastMessageAndWait(payload, context) {
      return sharedPort.broadcastMessageAndWait(payload, context);
    },
    dispose() {
      sharedPort.dispose();
    },
  });
}
