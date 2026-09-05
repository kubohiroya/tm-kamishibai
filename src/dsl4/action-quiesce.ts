import {
  dsl4EmptyActionRegistrySnapshot,
  validateDsl4ActionRegistrySnapshot,
} from './action-registry.js';
import {dsl4CoreActionManifest} from './core-action-manifest.js';

/** @type {Readonly<Record<string, 'finish-only' | 'cancel-replay-safe'>>} */
export const dsl4CoreActionQuiesceModes = Object.freeze(
  Object.fromEntries(dsl4CoreActionManifest.map(({command, quiesce}) => [command, quiesce])),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve the startup-fixed quiesce policy for core and custom actions without reading the VM.
 * Unknown or malformed actions use the non-replay-safe default.
 *
 */
export function createDsl4ActionQuiesceResolver({
  registrySnapshot = dsl4EmptyActionRegistrySnapshot,
}: {registrySnapshot?: unknown} = {}) {
  const registry = validateDsl4ActionRegistrySnapshot(registrySnapshot);
  const customModes = new Map(registry.actions.map((action) => [action.name, action.quiesce]));
  const resolver = (action: unknown) => {
    if (!isRecord(action) || typeof action.command !== 'string') return 'finish-only';
    if (action.handler === 'custom') return customModes.get(action.command) ?? 'finish-only';
    if (action.handler !== undefined && action.handler !== 'core') return 'finish-only';
    return dsl4CoreActionQuiesceModes[action.command] ?? 'finish-only';
  };
  return Object.freeze(resolver);
}
