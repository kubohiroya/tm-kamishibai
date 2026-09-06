import type {Dsl4NavigationSessionSurface} from '../navigation-session-surface.js';
import {createDsl4NavigationSession} from '../navigation-session.js';
import {resolveDsl4FeatureFlags} from '../runtime-startup.js';
import {deepFreeze} from '../story-document.js';
import {createDsl4RuntimeVariableSnapshot} from '../runtime-variable-surface.js';
import {createDsl4TurboWarpRuntimeEnvironment} from './turbowarp-runtime-host.js';
import {createDsl4TurboWarpTransitionPort} from './turbowarp-transition-port.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The navigation session this factory creates, as far as it inspects the result. */
type Dsl4PreviewNavigationSession = ReturnType<typeof createDsl4NavigationSession>;

/** The debug execution surface the navigation session accepts, named where this factory forwards it. */
type Dsl4NavigationDebugExecution = NonNullable<
  Parameters<typeof createDsl4NavigationSession>[0]['debugExecution']
>;

/**
 * What the `runtime.fail` observer reaches for on the navigation session it is still creating.
 *
 * The observer runs during `createDsl4NavigationSession`, before `created` is assigned, so every
 * step is optional. The current result shape carries no `session` member at all, which is why this
 * is declared as a lookup rather than derived from the session type.
 */
interface Dsl4PreviewCreatedSession {
  session?: {getState?(): Dsl4PreviewSessionState | undefined};
}

/** The failure detail the observer lifts out of the session state onto a `runtime.fail` event. */
interface Dsl4PreviewSessionState {
  runtime?: {diagnostic?: unknown};
  diagnostic?: unknown;
}

/** The runtime environment options this factory forwards wholesale, so the two never drift apart. */
type Dsl4TurboWarpRuntimeEnvironmentOptions = Parameters<
  typeof createDsl4TurboWarpRuntimeEnvironment
>[0];

/** The runtime component a preview session drives, as far as this factory reads it. */
interface Dsl4PreviewRuntimeComponent extends Readonly<Record<string, unknown>> {
  readonly storyDocument: Readonly<Record<string, unknown>>;
  readonly runtimeArtifact: Readonly<{controlProfile: string}> & Readonly<Record<string, unknown>>;
  readonly assetBundle: Readonly<Record<string, unknown>>;
}

/**
 * The options this factory reads. It forwards the whole object to the runtime environment, so it
 * carries that contract and adds only the members it reads itself. Every injected surface is
 * validated before it is used.
 */
type Dsl4PreviewSessionOptions = Dsl4TurboWarpRuntimeEnvironmentOptions & {
  featureFlags?: unknown;
  runtimeComponent?: unknown;
  resetManagedPresentation: () => unknown | Promise<unknown>;
  resolveRuntimeComponent?: (request: Readonly<Record<string, unknown>>) => unknown;
  onEvent?: (event: Readonly<Record<string, unknown>>) => unknown;
  inputTarget?: unknown;
  stagePointerTarget?: unknown;
  runtimeVersion?: unknown;
};

function validateRuntimeComponent(value: unknown) {
  if (!isRecord(value)) throw new TypeError('preview runtimeComponent must be an object');
  const component = value as unknown as Dsl4PreviewRuntimeComponent;
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

function validateSessionContext(value: unknown) {
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

/** Make one navigation session the sole owner of its TurboWarp runtime environment. */
function ownRuntimeEnvironment(
  session: Dsl4NavigationSessionSurface,
  environment: Readonly<{
    dispose: (reason?: string) => unknown;
    getPoseState?: () => unknown;
  }>,
  runtimeVersion: unknown,
  stateSurfaceEnabled: boolean,
): Dsl4NavigationSessionSurface {
  let disposePromise: Promise<void> | null = null;
  return Object.freeze({
    ...session,
    getRuntimeVariableSnapshot() {
      if (!stateSurfaceEnabled) return null;
      return createDsl4RuntimeVariableSnapshot(session.getState().runtime, {
        poseState: environment.getPoseState?.() ?? null,
        version: runtimeVersion,
      });
    },
    dispose(reason: string = 'dispose') {
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

function createDefaultHostPort(context: Readonly<{runtimeHost: unknown}>) {
  return createDsl4TurboWarpTransitionPort({runtimeHost: context.runtimeHost});
}

/**
 * Create the concrete session factory consumed by the browser preview runtime bridge.
 *
 * The base component contributes only immutable runtime/asset artifacts. Each source generation
 * supplies its already-validated StoryDocument and is never parsed again in the browser.
 *
 * @param {object} optionsInput
 * @param {(context: Readonly<{storyDocument: Readonly<Record<string, unknown>>, baseComponent: Readonly<Record<string, unknown>>}>) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>} [optionsInput.resolveRuntimeComponent]
 * The factory answers a session builder: given a StoryDocument, the previous session to replace,
 * and whether the managed presentation survives, it resolves the next preview session.
 */
export function createDsl4TurboWarpPreviewSessionFactory(optionsInput: unknown) {
  if (!isRecord(optionsInput)) {
    throw new TypeError('TurboWarp preview session options are required');
  }
  const options = optionsInput as unknown as Dsl4PreviewSessionOptions;
  const featureFlags = resolveDsl4FeatureFlags(options.featureFlags);
  if (!featureFlags.dsl4Runtime) {
    throw new TypeError('TurboWarp preview sessions require the dsl4Runtime feature flag');
  }
  const runtimeComponent = validateRuntimeComponent(options.runtimeComponent);
  if (typeof options.resetManagedPresentation !== 'function') {
    throw new TypeError('resetManagedPresentation must be a function');
  }
  if (
    options.resolveRuntimeComponent !== undefined &&
    typeof options.resolveRuntimeComponent !== 'function'
  ) {
    throw new TypeError('resolveRuntimeComponent must be a function');
  }
  if (options.onEvent !== undefined && typeof options.onEvent !== 'function') {
    throw new TypeError('onEvent must be a function');
  }
  if (
    featureFlags.dsl4Debugger &&
    (!isRecord(options.debugExecution) ||
      typeof options.debugExecution.beforeAction !== 'function' ||
      typeof options.debugExecution.getState !== 'function')
  ) {
    throw new TypeError('debugExecution is required when dsl4Debugger is enabled');
  }

  async function createConcreteSession(storyDocument: Readonly<Record<string, unknown>>) {
    const generationComponent = validateRuntimeComponent(
      options.resolveRuntimeComponent
        ? await options.resolveRuntimeComponent(
            Object.freeze({storyDocument, baseComponent: runtimeComponent}),
          )
        : Object.freeze({...runtimeComponent, storyDocument}),
    );
    if (generationComponent.storyDocument !== storyDocument) {
      throw new TypeError(
        'resolved preview runtime component must use the requested StoryDocument',
      );
    }
    let runtimeLifecycleObserver: ((event: Readonly<Record<string, unknown>>) => void) | null =
      null;
    const environment = await createDsl4TurboWarpRuntimeEnvironment(
      {
        ...options,
        createHostPort: options.createHostPort ?? createDefaultHostPort,
      },
      generationComponent,
      () => {},
      () => {},
      (observer) => {
        runtimeLifecycleObserver = observer;
      },
      featureFlags.dsl4PoseFeedbackModes,
      featureFlags.dsl4PosePreviewMirroring,
      featureFlags.dsl4CameraPreviewControls,
      featureFlags.dsl4SpeechAdvanceTypewriter,
    );

    let created: Dsl4PreviewNavigationSession;
    try {
      const recognition = isRecord(storyDocument.recognition) ? storyDocument.recognition : {};
      const posePreview = isRecord(recognition.preview) ? recognition.preview : {};
      const posePreviewControls = isRecord(posePreview.controls) ? posePreview.controls : {};
      const cameraMirroringControlEnabled =
        featureFlags.dsl4CameraPreviewControls && isRecord(posePreviewControls.mirroring);
      created = createDsl4NavigationSession({
        storyDocument,
        controlProfile: String(runtimeComponent.runtimeArtifact.controlProfile),
        historyNavigationAvailable: options.historyNavigationAvailable ?? false,
        historyLimits: options.historyLimits,
        port: environment.port,
        debugExecution: featureFlags.dsl4Debugger
          ? (options.debugExecution as Dsl4NavigationDebugExecution)
          : undefined,
        assetLifecycle: environment.assetLifecycle,
        evaluateCondition: environment.evaluateCondition,
        onEvent(event) {
          try {
            runtimeLifecycleObserver?.(event);
          } catch {
            // Internal UI observers cannot change runtime execution or suppress consumer events.
          }
          if (event.type === 'runtime.fail') {
            const state = (created as Dsl4PreviewCreatedSession | undefined)?.session?.getState?.();
            const diagnostic = state?.runtime?.diagnostic ?? state?.diagnostic;
            options.onEvent?.(diagnostic ? {...event, diagnostic} : event);
            return;
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
        turboWarpBubbleAdvancedPresentationEnabled:
          featureFlags.dsl4TurboWarpBubbleAdvancedPresentation,
        broadcastMessageAndWaitEnabled: featureFlags.dsl4BroadcastMessageAndWait,
        storyVariableWriteEnabled: featureFlags.dsl4TurboWarpStoryVariableWrite,
        crossfadeTransitionsEnabled: featureFlags.dsl4CrossfadeTransitions,
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

    const navigationSession = (created as unknown as {session: Dsl4NavigationSessionSurface})
      .session;
    try {
      if (options.inputTarget !== undefined) {
        navigationSession.attach(options.inputTarget);
      }
      if (featureFlags.dsl4SpeechAdvanceTypewriter && options.stagePointerTarget !== undefined) {
        navigationSession.attachStagePointer(options.stagePointerTarget);
      }
    } catch (error) {
      const cleanupErrors = [];
      try {
        navigationSession.dispose();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await environment.dispose('preview-input-attachment-failed');
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          'DSL 4.0 preview input attachment and cleanup failed',
        );
      }
      throw error;
    }
    const owned = ownRuntimeEnvironment(
      navigationSession,
      environment,
      options.runtimeVersion,
      featureFlags.dsl4TurboWarpStateSurface,
    );
    return owned;
  }

  return async function createPreviewSession(contextInput: unknown) {
    const context = validateSessionContext(contextInput);
    let concreteSession: Dsl4NavigationSessionSurface | null = null;
    let initializationPromise: Promise<Dsl4NavigationSessionSurface> | null = null;
    let runPromise: Promise<unknown> | null = null;
    let disposePromise: Promise<void> | null = null;
    let stopReason: string | null = null;
    let status = 'idle';
    let disposed = false;

    function snapshot() {
      if (concreteSession) return concreteSession.getState();
      return deepFreeze({
        runtime: {
          status,
          sceneId: null,
          actionIndex: 0,
          actionPath: null,
          variables: isRecord(context.storyDocument.variables)
            ? {...context.storyDocument.variables}
            : {},
          generation: 0,
        },
        disposed,
      });
    }

    function disposedError() {
      return new TypeError('TurboWarp preview runtime session is disposed');
    }

    function initialize() {
      if (initializationPromise) return initializationPromise;
      status = 'starting';
      initializationPromise = (async () => {
        if (!context.preserveManagedPresentation) {
          await options.resetManagedPresentation();
        }
        if (disposed) throw disposedError();
        const created = await createConcreteSession(context.storyDocument);
        if (disposed) {
          const failure = disposedError();
          try {
            await created.dispose('preview-disposed-during-initialization');
          } catch (disposeError) {
            throw new AggregateError(
              [failure, disposeError],
              'DSL 4.0 preview initialization cancellation cleanup failed',
            );
          }
          throw failure;
        }
        concreteSession = created;
        status = stopReason === null ? 'ready' : 'stopped';
        return created;
      })().catch((error) => {
        if (!disposed) status = 'failed';
        throw error;
      });
      return initializationPromise;
    }

    return Object.freeze({
      start(startOptions?: Readonly<Record<string, unknown>>) {
        if (disposed) return Promise.reject(disposedError());
        if (runPromise) return runPromise;
        runPromise = initialize().then((session) => {
          if (disposed || stopReason !== null) return snapshot();
          status = 'running';
          return session.start(startOptions);
        });
        return runPromise;
      },
      stop(reason: string = 'stop') {
        if (stopReason === null) stopReason = reason;
        status = 'stopped';
        return concreteSession ? concreteSession.stop(reason) : snapshot();
      },
      dispose(reason: string = 'dispose') {
        if (disposePromise) return disposePromise;
        if (disposed) return Promise.resolve();
        disposed = true;
        status = 'disposing';
        disposePromise = (async () => {
          if (initializationPromise) {
            try {
              await initializationPromise;
            } catch {
              // Initialization owns its partial cleanup and its caller owns the original failure.
            }
          }
          if (concreteSession) await concreteSession.dispose(reason);
          status = 'disposed';
        })();
        return disposePromise;
      },
      getState: snapshot,
      getRuntimeVariableSnapshot() {
        if (!featureFlags.dsl4TurboWarpStateSurface) return null;
        if (!concreteSession?.getRuntimeVariableSnapshot) {
          return createDsl4RuntimeVariableSnapshot(snapshot().runtime);
        }
        return concreteSession.getRuntimeVariableSnapshot();
      },
      invokeAction(action: Readonly<Record<string, unknown>>) {
        if (disposed) return Promise.reject(disposedError());
        return initialize().then((session) => session.invokeAction(action));
      },
      queueVariableWrite(request: unknown) {
        if (disposed || !concreteSession) {
          return deepFreeze({accepted: false, code: 'K4-VARIABLE-WRITE-INACTIVE'});
        }
        return concreteSession.queueVariableWrite(request);
      },
      rejectActionInvocation(error: unknown) {
        if (disposed) return Promise.reject(disposedError());
        return initialize().then((session) => session.rejectActionInvocation(error));
      },
      quiesce(quiesceOptions: {candidateId: number}) {
        if (disposed) return Promise.reject(disposedError());
        return initialize().then((session) => session.quiesce(quiesceOptions));
      },
      resumeQuiesce(candidateId: number) {
        if (disposed) return Promise.reject(disposedError());
        return initialize().then((session) => session.resumeQuiesce(candidateId));
      },
    });
  };
}
