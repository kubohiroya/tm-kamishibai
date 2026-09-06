import {deepFreeze} from '../dsl4/story-document.js';

/**
 * The startup-fixed switches for every DSL 5.0 capability, all off until its child issue lands.
 *
 * Shaped after `dsl4DefaultFeatureFlags`: an unknown key is a `TypeError` rather than a silently
 * ignored option, every value must be a boolean, and the resolved snapshot is frozen. A flag is
 * fixed at startup and never toggled mid-session, so a story cannot observe a capability appearing
 * or vanishing while it runs.
 *
 * With every flag off, the runtime, app shell, asset lifecycle and distribution artifacts are the
 * DSL 4.0 ones, and no 5.0 opcode, storage or manifest reaches a 4.0 artifact.
 */
const featureFlagKeys = new Set([
  'dsl5NarrativeCore',
  'dsl5Persistence',
  'dsl5ProjectAppShell',
  'dsl5PublicationSegments',
  'dsl5ReadingUx',
  'dsl5AssetGroups',
  'dsl5AudioLifecycle',
  'dsl5RichText',
  'dsl5PresentationEffects',
  'dsl5Viewport',
  'dsl5Video',
  'dsl5CompiledArtifact',
  'dsl5SealedArtifact',
]);

export const dsl5DefaultFeatureFlags = deepFreeze({
  dsl5NarrativeCore: false,
  dsl5Persistence: false,
  dsl5ProjectAppShell: false,
  dsl5PublicationSegments: false,
  dsl5ReadingUx: false,
  dsl5AssetGroups: false,
  dsl5AudioLifecycle: false,
  dsl5RichText: false,
  dsl5PresentationEffects: false,
  dsl5Viewport: false,
  dsl5Video: false,
  dsl5CompiledArtifact: false,
  dsl5SealedArtifact: false,
});

export type Dsl5FeatureFlags = typeof dsl5DefaultFeatureFlags;

/**
 * Which flags a flag cannot be enabled without.
 *
 * This is the epic's dependency order written where it can be checked rather than only read. Each
 * entry says what the capability reads from another: persistence restores the variables narrative
 * core defines, reading UX navigates the segments publication provides, audio owns channels whose
 * buffers the asset groups release, video needs both those buffers and the viewport it draws into.
 */
const featureFlagRequirements = deepFreeze({
  dsl5Persistence: ['dsl5NarrativeCore'],
  dsl5ProjectAppShell: ['dsl5Persistence'],
  dsl5ReadingUx: ['dsl5PublicationSegments'],
  dsl5AssetGroups: ['dsl5PublicationSegments'],
  dsl5AudioLifecycle: ['dsl5AssetGroups'],
  dsl5RichText: ['dsl5NarrativeCore'],
  dsl5Video: ['dsl5AssetGroups', 'dsl5Viewport'],
  dsl5CompiledArtifact: ['dsl5PublicationSegments', 'dsl5AssetGroups'],
  // Sealing is authenticated encryption over the compiled artifact's segments and asset groups, so
  // it has nothing to seal without one. Sealing raw authoring source is not a profile 5.0 offers.
  dsl5SealedArtifact: ['dsl5CompiledArtifact'],
}) as Readonly<Record<string, readonly (keyof Dsl5FeatureFlags)[]>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve one immutable startup feature snapshot without importing runtime dependencies. */
export function resolveDsl5FeatureFlags(input: unknown = {}): Dsl5FeatureFlags {
  if (!isRecord(input)) throw new TypeError('DSL 5.0 feature flags must be an object');
  const unknown = Object.keys(input)
    .filter((key) => !featureFlagKeys.has(key))
    .sort();
  if (unknown.length > 0) {
    throw new TypeError(`Unknown DSL 5.0 feature flag: ${unknown.join(', ')}`);
  }
  const resolved = {...dsl5DefaultFeatureFlags, ...input};
  for (const [name, value] of Object.entries(resolved)) {
    if (typeof value !== 'boolean') throw new TypeError(`${name} feature flag must be boolean`);
  }
  for (const [name, requirements] of Object.entries(featureFlagRequirements)) {
    if (!resolved[name as keyof Dsl5FeatureFlags]) continue;
    const missing = requirements.filter((requirement) => !resolved[requirement]);
    if (missing.length > 0) {
      throw new TypeError(`${name} requires ${missing.join(' and ')}`);
    }
  }
  return deepFreeze(resolved) as Dsl5FeatureFlags;
}
