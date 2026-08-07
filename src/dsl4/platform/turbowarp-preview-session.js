import {createDsl4NavigationSession} from '../navigation-session.js';
import {resolveDsl4FeatureFlags} from '../runtime-startup.js';
import {createDsl4TurboWarpRuntimeEnvironment} from './turbowarp-runtime-host.js';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function validateRuntimeComponent(value) {
  if (!isRecord(value)) throw new TypeError('preview runtimeComponent must be an object');
  const component = /** @type {Record<string, any>} */ (value);
  if (
    !isRecord(component.storyDocument) ||
    component.storyDocument.kind !== 'StoryDocument' ||
    component.storyDocument.version !== '4.0' ||
    !isRecord(component.runtimeArtifact) ||
    typeof component.runtimeArtifact.controlProfile !== 'string' ||
    component.runtimeArtifact.controlProfile.length === 0 ||
    !isRecord(component.assetBundle)
  ) {
    throw new TypeError(
      'preview runtimeComponent must provide a validated StoryDocument, runtime artifact, and asset bundle',
    );
  }
  return component;
}

/** @param {unknown} value */
function validateSessionContext(value) {
  if (!isRecord(value)) throw new TypeError('preview runtime session context must be an object');
  const storyDocument = isRecord(value.storyDocument) ? value.storyDocument : null;
  if (storyDocument?.kind !== 'StoryDocument' || storyDocument.version !== '4.0') {
    throw new TypeError('preview runtime session requires a DSL 4.0 StoryDocument');
  }
  if (value.previousSession !== null && !isRecord(value.previousSession)) {
    throw new TypeError('preview runtime previousSession must be an object or null');
  }
  if (typeof value.preserveManagedPresentation !== 'boolean') {
    throw new TypeError('preview runtime preserveManagedPresentation must be boolean');
  }
  if (value.preserveManagedPresentation && value.previousSession === null) {
    throw new TypeError('preview runtime cannot preserve presentation without a previous session');
  }
  return {
    storyDocument,
    preserveManagedPresentation: value.preserveManagedPresentation,
  };
}

/**
 * Make one navigation session the sole owner of its TurboWarp runtime environment.
 *
 * @param {Readonly<Record<string, Function>>} session
 * @param {Readonly<{dispose: Function}>} environment
 * @returns {Readonly<Record<string, Function>>}
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
          throw new AggregateError(errors, 'DSL 4.0 preview runtime session disposal failed');
        }
      })();
      return disposePromise;
    },
  });
}

/**
 * Create the concrete session factory consumed by the browser preview runtime bridge.
 *
 * The base component contributes only immutable runtime/asset artifacts. Each source generation
 * supplies its already-validated StoryDocument and is never parsed again in the browser.
 *
 * @param {object} optionsInput
 * @returns {(context: Readonly<{storyDocument: Readonly<Record<string, unknown>>, previousSession: Record<string, Function> | null, preserveManagedPresentation: boolean}>) => Promise<Record<string, Function>>}
 */
export function createDsl4TurboWarpPreviewSessionFactory(optionsInput) {
  if (!isRecord(optionsInput)) {
    throw new TypeError('TurboWarp preview session options are required');
  }
  const options = /** @type {Record<string, any>} */ (optionsInput);
  const featureFlags = resolveDsl4FeatureFlags(options.featureFlags);
  if (!featureFlags.dsl4Runtime) {
    throw new TypeError('TurboWarp preview sessions require the dsl4Runtime feature flag');
  }
  const runtimeComponent = validateRuntimeComponent(options.runtimeComponent);
  if (typeof options.resetManagedPresentation !== 'function') {
    throw new TypeError('resetManagedPresentation must be a function');
  }
  if (options.onEvent !== undefined && typeof options.onEvent !== 'function') {
    throw new TypeError('onEvent must be a function');
  }

  return async function createPreviewSession(contextInput) {
    const context = validateSessionContext(contextInput);
    const generationComponent = Object.freeze({
      ...runtimeComponent,
      storyDocument: context.storyDocument,
    });
    /** @type {((event: Readonly<Record<string, unknown>>) => void) | null} */
    let runtimeLifecycleObserver = null;
    const environment = await createDsl4TurboWarpRuntimeEnvironment(
      options,
      generationComponent,
      () => {},
      (observer) => {
        runtimeLifecycleObserver = observer;
      },
      featureFlags.dsl4PoseFeedbackModes,
      featureFlags.dsl4PosePreviewMirroring,
      featureFlags.dsl4CameraPreviewControls,
      featureFlags.dsl4SpeechAdvanceTypewriter,
    );

    let created;
    try {
      const poseRecognition = isRecord(context.storyDocument.poseRecognition)
        ? context.storyDocument.poseRecognition
        : {};
      const posePreview = isRecord(poseRecognition.preview) ? poseRecognition.preview : {};
      const posePreviewControls = isRecord(posePreview.controls) ? posePreview.controls : {};
      const cameraMirroringControlEnabled =
        featureFlags.dsl4CameraPreviewControls && isRecord(posePreviewControls.mirroring);
      created = createDsl4NavigationSession({
        storyDocument: context.storyDocument,
        controlProfile: String(runtimeComponent.runtimeArtifact.controlProfile),
        historyNavigationAvailable: options.historyNavigationAvailable ?? false,
        historyLimits: options.historyLimits,
        port: environment.port,
        assetLifecycle: environment.assetLifecycle,
        evaluateCondition: environment.evaluateCondition,
        onEvent(event) {
          try {
            runtimeLifecycleObserver?.(event);
          } catch {
            // Internal UI observers cannot change runtime execution or suppress consumer events.
          }
          options.onEvent?.(event);
        },
        onInputError: options.onInputError,
        poseNavigationPolicyEnabled: featureFlags.dsl4PoseFeedbackModes,
        structuredDataIntegrationEnabled: featureFlags.structuredDataIntegrationEnabled,
        posePreviewMirroringEnabled:
          featureFlags.dsl4PosePreviewMirroring || cameraMirroringControlEnabled,
        cameraPreviewControlsEnabled: featureFlags.dsl4CameraPreviewControls,
        speechAdvanceTypewriterEnabled: featureFlags.dsl4SpeechAdvanceTypewriter,
      });
    } catch (error) {
      try {
        await environment.dispose('preview-navigation-session-creation-failed');
      } catch (disposeError) {
        throw new AggregateError(
          [error, disposeError],
          'DSL 4.0 preview session creation and cleanup failed',
        );
      }
      throw error;
    }
    if (!created.ok) {
      const failure = new TypeError('preview StoryDocument is incompatible with the base runtime');
      Object.defineProperty(failure, 'diagnostics', {value: created.diagnostics});
      try {
        await environment.dispose('preview-navigation-session-rejected');
      } catch (disposeError) {
        throw new AggregateError(
          [failure, disposeError],
          'DSL 4.0 preview session rejection and cleanup failed',
        );
      }
      throw failure;
    }

    const navigationSession = /** @type {{session: Readonly<Record<string, Function>>}} */ (
      /** @type {unknown} */ (created)
    ).session;
    const owned = ownRuntimeEnvironment(navigationSession, environment);
    /** @type {Promise<unknown> | null} */
    let startPromise = null;
    return Object.freeze({
      ...owned,
      /** @param {Readonly<Record<string, unknown>>} [startOptions] */
      start(startOptions) {
        if (startPromise) return startPromise;
        startPromise = (async () => {
          if (!context.preserveManagedPresentation) {
            await options.resetManagedPresentation();
          }
          return owned.start(startOptions);
        })();
        return startPromise;
      },
    });
  };
}
