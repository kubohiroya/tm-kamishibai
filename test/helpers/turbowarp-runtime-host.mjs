import {createTurboWarpRuntimeHost} from '@kubohiroya/turbowarp-runtime-host';

/**
 * Wrap a fake runtime in the real shared runtime host, so adapter tests drive the same adapter the
 * app composes rather than a hand-written stand-in.
 *
 * The host wraps the caller's object by reference, the way it wraps a live VM runtime, so a test
 * that reassigns `runtime.targets` afterwards sees the change through the host. Only the two
 * members the host factory validates are filled in, and only when the caller left them out.
 *
 * @param {Record<string, unknown>} [runtime]
 */
export function createTestTurboWarpRuntimeHost(runtime = {}) {
  if (typeof runtime.on !== 'function') runtime.on = () => {};
  if (typeof runtime.startHats !== 'function') runtime.startHats = () => [];
  return createTurboWarpRuntimeHost({runtime});
}
