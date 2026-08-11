import {deepFreeze} from './story-document.js';

const featureFlagKeys = new Set([
  'dsl4Runtime',
  'dsl4BroadcastMessageAndWait',
  'dsl4SessionBinaryBacking',
  'dsl4SourceIncludes',
  'dsl4AppShell',
  'dsl4WebPreviewAdapter',
  'dsl4WebPreviewAssetLiveReload',
  'dsl4PreviewReloadOverlay',
  'dsl4PoseFeedbackModes',
  'dsl4PosePreviewMirroring',
  'dsl4CameraPreviewControls',
  'dsl4SpeechAdvanceTypewriter',
  'dsl4BubbleAdvanceIndicator',
  'dsl4TurboWarpBubble',
  'dsl4TurboWarpBubbleAdvancedPresentation',
  'structuredDataIntegrationEnabled',
]);

export const dsl4DefaultFeatureFlags = deepFreeze({
  dsl4Runtime: false,
  dsl4BroadcastMessageAndWait: false,
  dsl4SessionBinaryBacking: false,
  dsl4SourceIncludes: false,
  dsl4AppShell: false,
  dsl4WebPreviewAdapter: false,
  dsl4WebPreviewAssetLiveReload: false,
  dsl4PreviewReloadOverlay: false,
  dsl4PoseFeedbackModes: false,
  dsl4PosePreviewMirroring: false,
  dsl4CameraPreviewControls: false,
  dsl4SpeechAdvanceTypewriter: false,
  dsl4BubbleAdvanceIndicator: false,
  dsl4TurboWarpBubble: false,
  dsl4TurboWarpBubbleAdvancedPresentation: false,
  structuredDataIntegrationEnabled: false,
});

// Standard release capabilities are explicit and independent from the default-off rollout policy.
export const dsl4StandardProductionFeatureFlags = deepFreeze({
  dsl4Runtime: true,
  dsl4AppShell: true,
  dsl4PoseFeedbackModes: true,
  dsl4SpeechAdvanceTypewriter: true,
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
  if (resolved.dsl4BroadcastMessageAndWait && !resolved.dsl4Runtime) {
    throw new TypeError('dsl4BroadcastMessageAndWait requires dsl4Runtime');
  }
  if (resolved.dsl4SessionBinaryBacking && !resolved.dsl4Runtime) {
    throw new TypeError('dsl4SessionBinaryBacking requires dsl4Runtime');
  }
  if (resolved.dsl4SourceIncludes && !resolved.dsl4Runtime) {
    throw new TypeError('dsl4SourceIncludes requires dsl4Runtime');
  }
  if (resolved.dsl4WebPreviewAdapter && (!resolved.dsl4Runtime || !resolved.dsl4AppShell)) {
    throw new TypeError('dsl4WebPreviewAdapter requires dsl4Runtime and dsl4AppShell');
  }
  if (
    resolved.dsl4WebPreviewAssetLiveReload &&
    (!resolved.dsl4Runtime || !resolved.dsl4AppShell || !resolved.dsl4WebPreviewAdapter)
  ) {
    throw new TypeError(
      'dsl4WebPreviewAssetLiveReload requires dsl4Runtime, dsl4AppShell, and dsl4WebPreviewAdapter',
    );
  }
  if (resolved.dsl4PreviewReloadOverlay && (!resolved.dsl4Runtime || !resolved.dsl4AppShell)) {
    throw new TypeError('dsl4PreviewReloadOverlay requires dsl4Runtime and dsl4AppShell');
  }
  if (resolved.dsl4SpeechAdvanceTypewriter && !resolved.dsl4Runtime) {
    throw new TypeError('dsl4SpeechAdvanceTypewriter requires dsl4Runtime');
  }
  if (
    resolved.dsl4BubbleAdvanceIndicator &&
    (!resolved.dsl4Runtime || !resolved.dsl4AppShell || !resolved.dsl4SpeechAdvanceTypewriter)
  ) {
    throw new TypeError(
      'dsl4BubbleAdvanceIndicator requires dsl4Runtime, dsl4AppShell, and dsl4SpeechAdvanceTypewriter',
    );
  }
  if (
    resolved.dsl4TurboWarpBubble &&
    (!resolved.dsl4Runtime || !resolved.dsl4AppShell || !resolved.dsl4SpeechAdvanceTypewriter)
  ) {
    throw new TypeError(
      'dsl4TurboWarpBubble requires dsl4Runtime, dsl4AppShell, and dsl4SpeechAdvanceTypewriter',
    );
  }
  if (resolved.dsl4TurboWarpBubbleAdvancedPresentation && !resolved.dsl4TurboWarpBubble) {
    throw new TypeError('dsl4TurboWarpBubbleAdvancedPresentation requires dsl4TurboWarpBubble');
  }
  return deepFreeze(resolved);
}
