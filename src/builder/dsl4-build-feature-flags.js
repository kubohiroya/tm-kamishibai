import {resolveDsl4FeatureFlags} from '../dsl4/feature-flags.js';
import {deepFreeze} from '../dsl4/story-document.js';

export const dsl4DefaultBuildFeatureFlags = deepFreeze({
  dsl4RootBinaryEntryPackaging: false,
});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve builder-only packaging flags separately from the runtime feature snapshot.
 *
 * @param {unknown} [input]
 */
export function resolveDsl4BuildFeatureFlags(input = {}) {
  if (!isRecord(input)) throw new TypeError('DSL 4.0 build feature flags must be an object');
  const runtimeInput = {...input};
  const rootBinaryEntryPackaging = runtimeInput.dsl4RootBinaryEntryPackaging ?? false;
  delete runtimeInput.dsl4RootBinaryEntryPackaging;
  if (typeof rootBinaryEntryPackaging !== 'boolean') {
    throw new TypeError('dsl4RootBinaryEntryPackaging build feature flag must be boolean');
  }
  return deepFreeze({
    dsl4RootBinaryEntryPackaging: rootBinaryEntryPackaging,
    runtimeFeatureFlags: resolveDsl4FeatureFlags(runtimeInput),
  });
}
