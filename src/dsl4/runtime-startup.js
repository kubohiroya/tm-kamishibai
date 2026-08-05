import {createDsl4NavigationSession} from './navigation-session.js';
import {loadDsl4RuntimeComponent} from './runtime-artifact-loader.js';
import {deepFreeze} from './story-document.js';

const featureFlagKeys = new Set(['dsl4Runtime']);

export const dsl4DefaultFeatureFlags = deepFreeze({dsl4Runtime: false});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve one immutable startup feature snapshot.
 *
 * @param {unknown} [input]
 */
export function resolveDsl4FeatureFlags(input = {}) {
  if (!isRecord(input)) throw new TypeError('DSL 4.0 feature flags must be an object');
  const unknown = Object.keys(input).filter((key) => !featureFlagKeys.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown DSL 4.0 feature flag: ${unknown.sort().join(', ')}`);
  }
  const enabled = Object.hasOwn(input, 'dsl4Runtime') ? input.dsl4Runtime : false;
  if (typeof enabled !== 'boolean') throw new TypeError('dsl4Runtime feature flag must be boolean');
  return deepFreeze({dsl4Runtime: enabled});
}

/**
 * Create a host-controlled runtime session behind one startup-fixed, default-off flag.
 *
 * @param {object} [options]
 * @param {unknown} [options.featureFlags]
 * @param {unknown} [options.project]
 * @param {{parse(source: string, options?: {sourceId?: string}): Readonly<Record<string, any>>}} [options.sourceFrontend]
 * @param {number} [options.maxSourceBytes]
 * @param {number} [options.maxAssetFiles]
 * @param {number} [options.maxAssetBytes]
 * @param {boolean} [options.historyNavigationAvailable]
 * @param {{maxActionEntries: number, maxSceneVisits: number}} [options.historyLimits]
 * @param {Record<string, Function>} [options.port]
 * @param {{prepare: Function, setLoading: Function, release: Function}} [options.assetLifecycle]
 * @param {(runtimeComponent: Readonly<Record<string, unknown>>, context: Readonly<{channel: 'bundled' | 'unbundled', featureFlags: Readonly<{dsl4Runtime: boolean}>}>) => {prepare: Function, setLoading: Function, release: Function}} [options.createAssetLifecycle]
 * @param {(expression: string, variables: Readonly<Record<string, string | number | boolean>>, context: Record<string, unknown>) => boolean | Promise<boolean>} [options.evaluateCondition]
 * @param {(event: Readonly<Record<string, unknown>>) => void} [options.onEvent]
 * @param {(error: unknown, context: Readonly<{command: string, code: string}>) => unknown | Promise<unknown>} [options.onInputError]
 * @param {{digest: Function}} [options.subtleCrypto]
 */
export async function createDsl4RuntimeStartup(options = {}) {
  if (!isRecord(options)) throw new TypeError('DSL 4.0 startup options must be an object');
  const featureFlags = resolveDsl4FeatureFlags(options.featureFlags);
  if (!featureFlags.dsl4Runtime) {
    return deepFreeze({
      ok: true,
      enabled: false,
      featureFlags,
      session: null,
      diagnostics: [],
    });
  }
  if (options.assetLifecycle !== undefined && options.createAssetLifecycle !== undefined) {
    throw new TypeError('Provide either assetLifecycle or createAssetLifecycle, not both');
  }
  if (
    options.createAssetLifecycle !== undefined &&
    typeof options.createAssetLifecycle !== 'function'
  ) {
    throw new TypeError('createAssetLifecycle must be a function');
  }
  const createAssetLifecycle =
    typeof options.createAssetLifecycle === 'function' ? options.createAssetLifecycle : null;
  if (!isRecord(options.port))
    throw new TypeError('port must be an object when DSL 4.0 is enabled');
  if (!options.sourceFrontend || typeof options.sourceFrontend.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse when DSL 4.0 is enabled');
  }
  const {maxSourceBytes, maxAssetFiles, maxAssetBytes} = options;
  if (maxSourceBytes === undefined || maxAssetFiles === undefined || maxAssetBytes === undefined) {
    throw new TypeError('DSL 4.0 startup requires explicit source and asset limits');
  }

  const loaded = await loadDsl4RuntimeComponent(options.project, options.sourceFrontend, {
    maxSourceBytes,
    maxAssetFiles,
    maxAssetBytes,
    historyNavigationAvailable: options.historyNavigationAvailable ?? false,
    subtleCrypto: options.subtleCrypto,
  });
  if (!loaded.ok) {
    return deepFreeze({
      ok: false,
      enabled: true,
      featureFlags,
      diagnostics: loaded.diagnostics,
    });
  }
  const component =
    /** @type {{channel: 'bundled' | 'unbundled', storyDocument: Readonly<Record<string, unknown>>, runtimeArtifact: Readonly<Record<string, any>>}} */ (
      /** @type {unknown} */ (loaded)
    );
  const created = createDsl4NavigationSession({
    storyDocument: component.storyDocument,
    controlProfile: String(component.runtimeArtifact.controlProfile),
    historyNavigationAvailable: options.historyNavigationAvailable ?? false,
    historyLimits: options.historyLimits,
    port: /** @type {Record<string, Function>} */ (options.port),
    assetLifecycle: options.assetLifecycle,
    createAssetLifecycle: createAssetLifecycle
      ? () =>
          createAssetLifecycle(component, deepFreeze({channel: component.channel, featureFlags}))
      : undefined,
    evaluateCondition: options.evaluateCondition,
    onEvent: options.onEvent,
    onInputError: options.onInputError,
  });
  if (!created.ok) {
    return deepFreeze({
      ok: false,
      enabled: true,
      featureFlags,
      diagnostics: created.diagnostics,
    });
  }
  const success = /** @type {{session: Readonly<Record<string, Function>>}} */ (
    /** @type {unknown} */ (created)
  );
  return deepFreeze({
    ok: true,
    enabled: true,
    featureFlags,
    channel: component.channel,
    runtimeComponent: loaded,
    session: success.session,
    diagnostics: [],
  });
}
