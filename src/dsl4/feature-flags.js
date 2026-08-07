import {deepFreeze} from './story-document.js';

const featureFlagKeys = new Set([
  'dsl4Runtime',
  'dsl4AppShell',
  'dsl4WebPreviewAdapter',
  'dsl4PoseFeedbackModes',
  'dsl4PosePreviewMirroring',
  'dsl4CameraPreviewControls',
  'dsl4SpeechAdvanceTypewriter',
  'structuredDataIntegrationEnabled',
]);

export const dsl4DefaultFeatureFlags = deepFreeze({
  dsl4Runtime: false,
  dsl4AppShell: false,
  dsl4WebPreviewAdapter: false,
  dsl4PoseFeedbackModes: false,
  dsl4PosePreviewMirroring: false,
  dsl4CameraPreviewControls: false,
  dsl4SpeechAdvanceTypewriter: false,
  structuredDataIntegrationEnabled: false,
});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve one immutable startup feature snapshot without importing runtime dependencies.
 *
 * @param {unknown} [input]
 */
export function resolveDsl4FeatureFlags(input = {}) {
  if (!isRecord(input)) throw new TypeError('DSL 4.0 feature flags must be an object');
  const unknown = Object.keys(input).filter((key) => !featureFlagKeys.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown DSL 4.0 feature flag: ${unknown.sort().join(', ')}`);
  }
  const resolved = {...dsl4DefaultFeatureFlags, ...input};
  for (const [name, value] of Object.entries(resolved)) {
    if (typeof value !== 'boolean') throw new TypeError(`${name} feature flag must be boolean`);
  }
  if (resolved.dsl4AppShell && !resolved.dsl4Runtime) {
    throw new TypeError('dsl4AppShell requires dsl4Runtime');
  }
  if (resolved.dsl4WebPreviewAdapter && (!resolved.dsl4Runtime || !resolved.dsl4AppShell)) {
    throw new TypeError('dsl4WebPreviewAdapter requires dsl4Runtime and dsl4AppShell');
  }
  if (resolved.dsl4SpeechAdvanceTypewriter && !resolved.dsl4Runtime) {
    throw new TypeError('dsl4SpeechAdvanceTypewriter requires dsl4Runtime');
  }
  return deepFreeze(resolved);
}
