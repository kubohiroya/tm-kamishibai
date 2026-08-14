import {
  dsl4EmptyActionRegistrySnapshot,
  validateDsl4ActionRegistrySnapshot,
} from './action-registry.js';
import {dsl4CoreActionManifest} from './core-action-manifest.js';

/** @type {Readonly<Record<string, 'finish-only' | 'cancel-replay-safe'>>} */
export const dsl4CoreActionQuiesceModes = Object.freeze(
  Object.fromEntries(dsl4CoreActionManifest.map(({command, quiesce}) => [command, quiesce])),
);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve the startup-fixed quiesce policy for core and custom actions without reading the VM.
 * Unknown or malformed actions use the non-replay-safe default.
 *
 * @param {object} [options]
 * @param {unknown} [options.registrySnapshot]
 */
export function createDsl4ActionQuiesceResolver({
  registrySnapshot = dsl4EmptyActionRegistrySnapshot,
} = {}) {
  const registry = validateDsl4ActionRegistrySnapshot(registrySnapshot);
  const customModes = new Map(registry.actions.map((action) => [action.name, action.quiesce]));
  /** @param {unknown} action */
  const resolver = (action) => {
    if (!isRecord(action) || typeof action.command !== 'string') return 'finish-only';
    if (action.handler === 'custom') return customModes.get(action.command) ?? 'finish-only';
    if (action.handler !== undefined && action.handler !== 'core') return 'finish-only';
    return dsl4CoreActionQuiesceModes[action.command] ?? 'finish-only';
  };
  return Object.freeze(resolver);
}
