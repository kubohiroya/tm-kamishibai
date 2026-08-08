import {
  dsl4EmptyActionRegistrySnapshot,
  validateDsl4ActionRegistrySnapshot,
} from './action-registry.js';

/** @type {Readonly<Record<string, 'finish-only' | 'cancel-replay-safe'>>} */
export const dsl4CoreActionQuiesceModes = Object.freeze({
  stage: 'finish-only',
  bgm: 'finish-only',
  sound: 'finish-only',
  wait: 'cancel-replay-safe',
  transition: 'cancel-replay-safe',
  goto: 'finish-only',
  branch: 'finish-only',
  keyInputToChangeScene: 'cancel-replay-safe',
  touchInputToChangeScene: 'cancel-replay-safe',
  poseInputToChangeScene: 'cancel-replay-safe',
  show: 'finish-only',
  hide: 'finish-only',
  setTransparency: 'finish-only',
  moveTo: 'cancel-replay-safe',
  say: 'cancel-replay-safe',
  think: 'cancel-replay-safe',
  setSkin: 'finish-only',
  setLayer: 'finish-only',
  loop: 'finish-only',
  setText: 'finish-only',
  pose: 'cancel-replay-safe',
});

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
