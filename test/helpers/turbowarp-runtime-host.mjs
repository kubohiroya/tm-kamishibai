import {createTurboWarpRuntimeHost} from '@kubohiroya/turbowarp-runtime-host';

/**
 * Wrap a fake runtime in the real shared runtime host, so adapter tests drive the same adapter the
 * app composes rather than a hand-written stand-in.
 *
 * Only the two members the host factory validates are defaulted. Everything an individual test
 * cares about — renderer, targets, monitors — comes from the caller.
 *
 * @param {Record<string, unknown>} [runtime]
 */
export function createTestTurboWarpRuntimeHost(runtime = {}) {
  return createTurboWarpRuntimeHost({
    runtime: {
      on() {},
      startHats: () => [],
      ...runtime,
    },
  });
}
