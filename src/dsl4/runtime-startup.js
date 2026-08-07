import {createDsl4NavigationSession} from './navigation-session.js';
import {loadDsl4RuntimeComponent} from './runtime-artifact-loader.js';
import {resolveDsl4FeatureFlags} from './feature-flags.js';
import {deepFreeze} from './story-document.js';

export {dsl4DefaultFeatureFlags, resolveDsl4FeatureFlags} from './feature-flags.js';

/**
 * @typedef {{prepare: Function, setLoading: Function, releaseAssets: Function, release: Function}} RuntimeAssetLifecycle
 * @typedef {Readonly<{channel: 'bundled' | 'unbundled', featureFlags: Readonly<{dsl4Runtime: boolean, dsl4AppShell: boolean, dsl4WebPreviewAdapter: boolean, dsl4PoseFeedbackModes: boolean, dsl4PosePreviewMirroring: boolean, structuredDataIntegrationEnabled: boolean}>}>} RuntimeStartupContext
 * @typedef {(expression: string, variables: Readonly<Record<string, string | number | boolean>>, context: Record<string, unknown>) => boolean | Promise<boolean>} RuntimeConditionEvaluator
 * @typedef {{port: Record<string, Function>, assetLifecycle?: RuntimeAssetLifecycle, evaluateCondition?: RuntimeConditionEvaluator, dispose: (reason?: string) => unknown | Promise<unknown>}} RuntimeEnvironment
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} candidate
 * @param {string} message
 * @returns {Promise<never>}
 */
async function rejectInvalidRuntimeEnvironment(candidate, message) {
  const failure = new TypeError(message);
  if (isRecord(candidate) && typeof candidate.dispose === 'function') {
    try {
      await candidate.dispose('invalid-runtime-environment');
    } catch (disposeError) {
      throw new AggregateError(
        [failure, disposeError],
        'Invalid DSL 4.0 runtime environment cleanup failed',
      );
    }
  }
  throw failure;
}

/**
 * Make the published navigation session the sole owner of its runtime environment.
 *
 * @param {Readonly<Record<string, Function>>} session
 * @param {RuntimeEnvironment} environment
 */
function ownRuntimeEnvironment(session, environment) {
  /** @type {Promise<void> | null} */
  let disposePromise = null;
  return Object.freeze({
    ...session,
    /** @param {string} [reason] */
    dispose(reason = 'dispose') {
      if (disposePromise) return disposePromise;
      disposePromise = (async () => {
        const errors = [];
        try {
          session.dispose();
        } catch (error) {
          errors.push(error);
        }
        try {
          await environment.dispose(reason);
        } catch (error) {
          errors.push(error);
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'DSL 4.0 runtime session disposal failed');
        }
      })();
      return disposePromise;
    },
  });
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
 * @param {RuntimeAssetLifecycle} [options.assetLifecycle]
 * @param {(runtimeComponent: Readonly<Record<string, unknown>>, context: RuntimeStartupContext) => RuntimeAssetLifecycle} [options.createAssetLifecycle]
 * @param {(runtimeComponent: Readonly<Record<string, unknown>>, context: RuntimeStartupContext) => RuntimeEnvironment | Promise<RuntimeEnvironment>} [options.createRuntimeEnvironment]
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
    options.createRuntimeEnvironment !== undefined &&
    (options.port !== undefined ||
      options.assetLifecycle !== undefined ||
      options.createAssetLifecycle !== undefined)
  ) {
    throw new TypeError(
      'createRuntimeEnvironment cannot be combined with port or asset lifecycle options',
    );
  }
  if (
    options.createAssetLifecycle !== undefined &&
    typeof options.createAssetLifecycle !== 'function'
  ) {
    throw new TypeError('createAssetLifecycle must be a function');
  }
  const createAssetLifecycle =
    typeof options.createAssetLifecycle === 'function' ? options.createAssetLifecycle : null;
  if (
    options.createRuntimeEnvironment !== undefined &&
    typeof options.createRuntimeEnvironment !== 'function'
  ) {
    throw new TypeError('createRuntimeEnvironment must be a function');
  }
  const createRuntimeEnvironment =
    typeof options.createRuntimeEnvironment === 'function'
      ? options.createRuntimeEnvironment
      : null;
  if (!createRuntimeEnvironment && !isRecord(options.port))
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
  const startupContext = deepFreeze({channel: component.channel, featureFlags});
  /** @type {RuntimeEnvironment | null} */
  let runtimeEnvironment = null;

  if (createRuntimeEnvironment) {
    const candidate = await createRuntimeEnvironment(component, startupContext);
    if (
      !isRecord(candidate) ||
      !isRecord(candidate.port) ||
      typeof candidate.dispose !== 'function'
    ) {
      await rejectInvalidRuntimeEnvironment(
        candidate,
        'runtime environment must provide port and dispose after component validation',
      );
    }
    if (Object.values(candidate.port).some((operation) => typeof operation !== 'function')) {
      await rejectInvalidRuntimeEnvironment(
        candidate,
        'runtime environment port values must be functions',
      );
    }
    if (
      candidate.assetLifecycle !== undefined &&
      (!isRecord(candidate.assetLifecycle) ||
        typeof candidate.assetLifecycle.prepare !== 'function' ||
        typeof candidate.assetLifecycle.setLoading !== 'function' ||
        typeof candidate.assetLifecycle.releaseAssets !== 'function' ||
        typeof candidate.assetLifecycle.release !== 'function')
    ) {
      await rejectInvalidRuntimeEnvironment(
        candidate,
        'runtime environment asset lifecycle must provide prepare, setLoading, releaseAssets, and release',
      );
    }
    if (
      candidate.evaluateCondition !== undefined &&
      typeof candidate.evaluateCondition !== 'function'
    ) {
      await rejectInvalidRuntimeEnvironment(
        candidate,
        'runtime environment evaluateCondition must be a function',
      );
    }
    runtimeEnvironment = /** @type {RuntimeEnvironment} */ (/** @type {unknown} */ (candidate));
  }

  let created;
  try {
    created = createDsl4NavigationSession({
      storyDocument: component.storyDocument,
      controlProfile: String(component.runtimeArtifact.controlProfile),
      historyNavigationAvailable: options.historyNavigationAvailable ?? false,
      historyLimits: options.historyLimits,
      port: runtimeEnvironment?.port ?? /** @type {Record<string, Function>} */ (options.port),
      assetLifecycle: runtimeEnvironment?.assetLifecycle ?? options.assetLifecycle,
      createAssetLifecycle: createAssetLifecycle
        ? () => createAssetLifecycle(component, startupContext)
        : undefined,
      evaluateCondition: runtimeEnvironment?.evaluateCondition ?? options.evaluateCondition,
      onEvent: options.onEvent,
      onInputError: options.onInputError,
      structuredDataIntegrationEnabled: featureFlags.structuredDataIntegrationEnabled,
      posePreviewMirroringEnabled: featureFlags.dsl4PosePreviewMirroring,
    });
  } catch (error) {
    if (!runtimeEnvironment) throw error;
    try {
      await runtimeEnvironment.dispose('navigation-session-creation-failed');
    } catch (disposeError) {
      throw new AggregateError(
        [error, disposeError],
        'DSL 4.0 startup and runtime environment cleanup failed',
      );
    }
    throw error;
  }
  if (!created.ok) {
    if (runtimeEnvironment) {
      await runtimeEnvironment.dispose('navigation-session-rejected');
    }
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
  const publishedSession = runtimeEnvironment
    ? ownRuntimeEnvironment(success.session, runtimeEnvironment)
    : success.session;
  return deepFreeze({
    ok: true,
    enabled: true,
    featureFlags,
    channel: component.channel,
    runtimeComponent: loaded,
    session: publishedSession,
    diagnostics: [],
  });
}
