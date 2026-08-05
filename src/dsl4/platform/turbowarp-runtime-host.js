import {createDsl4RuntimeStartup, resolveDsl4FeatureFlags} from '../runtime-startup.js';
import {deepFreeze} from '../story-document.js';
import {createDsl4ActorActionPort} from './actor-action-port.js';
import {createDsl4MediaActionPort} from './media-action-port.js';
import {createDsl4PlatformAssetSession} from './platform-asset-session.js';
import {createDsl4SvgTextPlatform} from './svg-text-action-port.js';
import {createDsl4TurboWarpActorPlatform} from './turbowarp-actor-adapter.js';

const hostPortMethods = new Set([
  'wait',
  'transition',
  'keyInputToChangeScene',
  'touchInputToChangeScene',
]);
const controllerCommands = new Set(['goto', 'branch', 'pose']);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} code @param {string} message */
function hostError(code, message) {
  const error = new Error(message);
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

/** @param {string} message */
function abortError(message) {
  const error = hostError('K4-HOST-WAIT-002', message);
  error.name = 'AbortError';
  return error;
}

/** @param {unknown} value */
function validateSignal(value) {
  if (
    !isRecord(value) ||
    typeof value.aborted !== 'boolean' ||
    typeof value.addEventListener !== 'function' ||
    typeof value.removeEventListener !== 'function'
  ) {
    throw hostError('K4-HOST-WAIT-001', 'wait context must provide an AbortSignal');
  }
  return /** @type {AbortSignal} */ (/** @type {unknown} */ (value));
}

/** @param {() => void} callback @param {number} milliseconds */
function defaultWaitSchedule(callback, milliseconds) {
  const timer = setTimeout(callback, milliseconds);
  return () => clearTimeout(timer);
}

/**
 * @param {(callback: () => void, milliseconds: number) => () => void} schedule
 */
function createWaitPort(schedule) {
  return Object.freeze({
    /** @param {unknown} payload @param {unknown} context */
    wait(payload, context) {
      if (
        !isRecord(payload) ||
        Object.keys(payload).length !== 1 ||
        !Object.hasOwn(payload, 'seconds') ||
        typeof payload.seconds !== 'number' ||
        !Number.isFinite(payload.seconds) ||
        payload.seconds < 0
      ) {
        throw hostError(
          'K4-HOST-WAIT-001',
          'wait payload must provide one finite non-negative seconds value',
        );
      }
      const signal = validateSignal(isRecord(context) ? context.signal : undefined);
      if (signal.aborted) return Promise.reject(abortError('wait action was cancelled'));
      const milliseconds = payload.seconds * 1000;
      if (!Number.isFinite(milliseconds)) {
        throw hostError('K4-HOST-WAIT-001', 'wait duration is outside the supported range');
      }
      if (milliseconds === 0) return Promise.resolve();

      return new Promise((resolve, reject) => {
        let settled = false;
        let cancel = () => {};
        const cleanup = () => {
          signal.removeEventListener('abort', handleAbort);
          cancel();
        };
        const finish = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(undefined);
        };
        const handleAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(abortError('wait action was cancelled'));
        };
        signal.addEventListener('abort', handleAbort, {once: true});
        if (signal.aborted) {
          handleAbort();
          return;
        }
        try {
          const scheduledCancel = schedule(finish, milliseconds);
          if (typeof scheduledCancel !== 'function') {
            throw hostError(
              'K4-HOST-WAIT-001',
              'wait schedule must return a cancellation function',
            );
          }
          cancel = scheduledCancel;
          if (settled) cancel();
        } catch (error) {
          settled = true;
          cleanup();
          reject(error);
        }
      });
    },
  });
}

/** @param {unknown} value */
function validateHostPort(value) {
  if (value === undefined)
    return /** @type {Readonly<Record<string, Function>>} */ (Object.freeze({}));
  if (!isRecord(value)) throw new TypeError('DSL 4.0 host port must be an object');
  for (const [method, operation] of Object.entries(value)) {
    if (method === 'dispose') {
      if (typeof operation !== 'function') {
        throw new TypeError('DSL 4.0 host port dispose must be a function');
      }
      continue;
    }
    if (typeof operation !== 'function') {
      throw new TypeError(`DSL 4.0 host port ${method} must be a function`);
    }
  }
  return /** @type {Record<string, Function>} */ (value);
}

/**
 * @param {Record<string, Function>} destination
 * @param {Record<string, Function>} source
 * @param {string[]} methods
 * @param {string} owner
 */
function addPortMethods(destination, source, methods, owner) {
  for (const method of methods) {
    if (typeof source[method] !== 'function') {
      throw new TypeError(`${owner} must provide ${method}`);
    }
    if (Object.hasOwn(destination, method)) {
      throw hostError('K4-HOST-PORT-COLLISION', `Runtime port method is duplicated: ${method}`);
    }
    destination[method] = source[method].bind(source);
  }
}

/**
 * @param {Readonly<Record<string, unknown>>} storyDocument
 * @param {Record<string, Function>} port
 * @param {unknown} evaluateCondition
 */
function validateStoryCapabilities(storyDocument, port, evaluateCondition) {
  const scenes = Array.isArray(storyDocument.scenes) ? storyDocument.scenes : [];
  for (const scene of scenes) {
    if (!isRecord(scene) || !Array.isArray(scene.actions)) continue;
    for (const action of scene.actions) {
      if (!isRecord(action) || typeof action.command !== 'string') continue;
      if (action.command === 'branch' && typeof evaluateCondition !== 'function') {
        throw hostError(
          'K4-HOST-CONDITION-MISSING',
          'A condition evaluator is required by the DSL 4.0 story',
        );
      }
      if (controllerCommands.has(action.command)) continue;
      if (typeof port[action.command] !== 'function') {
        throw hostError(
          'K4-HOST-PORT-MISSING',
          `Runtime port method is required by the DSL 4.0 story: ${action.command}`,
        );
      }
    }
  }
}

/**
 * @param {Record<string, any>} options
 * @param {Readonly<Record<string, unknown>>} runtimeComponent
 */
async function createRuntimeEnvironment(options, runtimeComponent) {
  const component = /** @type {Readonly<{storyDocument: Readonly<Record<string, unknown>>}>} */ (
    /** @type {unknown} */ (runtimeComponent)
  );
  /** @type {ReturnType<typeof createDsl4PlatformAssetSession> | null} */
  let assetSession = null;
  /** @type {ReturnType<typeof createDsl4SvgTextPlatform> | null} */
  let svgTextPlatform = null;
  /** @type {Readonly<Record<string, Function>> | Record<string, Function>} */
  let hostPort = Object.freeze({});

  try {
    const actorPlatform = createDsl4TurboWarpActorPlatform({
      runtime: options.runtime,
      ...(options.actorScheduler === undefined ? {} : {scheduler: options.actorScheduler}),
      ...(options.actorFrameMilliseconds === undefined
        ? {}
        : {frameMilliseconds: options.actorFrameMilliseconds}),
    });
    assetSession = createDsl4PlatformAssetSession({
      runtimeComponent,
      tmPoseRuntime: options.tmPoseRuntime,
      setLoading: options.setLoading,
      ...(options.createFile === undefined ? {} : {createFile: options.createFile}),
      ...(options.createAssetManagerComposition === undefined
        ? {}
        : {createAssetManagerComposition: options.createAssetManagerComposition}),
      ...(options.createTMPoseComposition === undefined
        ? {}
        : {createTMPoseComposition: options.createTMPoseComposition}),
      ...(options.createAsyncInputComposition === undefined
        ? {}
        : {createAsyncInputComposition: options.createAsyncInputComposition}),
      ...(options.poseSchedule === undefined ? {} : {poseSchedule: options.poseSchedule}),
      ...(options.poseNow === undefined ? {} : {poseNow: options.poseNow}),
    });
    const mediaPort = createDsl4MediaActionPort({
      composition: assetSession.assetManagerComposition,
      resolveActor: actorPlatform.resolveActor,
    });
    const actorPort = createDsl4ActorActionPort({
      composition: assetSession.assetManagerComposition,
      resolveActor: actorPlatform.resolveActor,
      host: actorPlatform.host,
    });
    svgTextPlatform = createDsl4SvgTextPlatform({
      enabled: true,
      runtime: options.runtime,
      storyDocument: component.storyDocument,
      resolveActor: actorPlatform.resolveActor,
      ...(options.createSvgTextComposition === undefined
        ? {}
        : {createComposition: options.createSvgTextComposition}),
    });
    hostPort = validateHostPort(
      typeof options.createHostPort === 'function'
        ? await options.createHostPort(
            Object.freeze({runtime: options.runtime, storyDocument: component.storyDocument}),
          )
        : undefined,
    );

    const port = /** @type {Record<string, Function>} */ ({});
    addPortMethods(port, mediaPort, ['stage', 'bgm', 'sound', 'setSkin'], 'media action port');
    addPortMethods(port, actorPort, ['show', 'moveTo', 'say'], 'actor action port');
    addPortMethods(port, svgTextPlatform.port, ['setText'], 'SVG text action port');
    addPortMethods(
      port,
      assetSession.poseActionPort,
      ['waitForPose', 'poseInputToChangeScene'],
      'pose action port',
    );

    for (const method of Object.keys(hostPort)) {
      if (method === 'dispose') continue;
      if (Object.hasOwn(port, method)) {
        throw hostError('K4-HOST-PORT-COLLISION', `Runtime port method is duplicated: ${method}`);
      }
      if (!hostPortMethods.has(method)) {
        throw hostError(
          'K4-HOST-PORT-UNSUPPORTED',
          `Injected runtime port is unsupported: ${method}`,
        );
      }
      port[method] = /** @type {Function} */ (hostPort[method]).bind(hostPort);
    }
    if (!Object.hasOwn(port, 'wait')) {
      const schedule = options.waitSchedule ?? defaultWaitSchedule;
      if (typeof schedule !== 'function') throw new TypeError('waitSchedule must be a function');
      addPortMethods(port, createWaitPort(schedule), ['wait'], 'wait action port');
    }
    validateStoryCapabilities(component.storyDocument, port, options.evaluateCondition);
    Object.freeze(port);

    /** @type {Promise<void> | null} */
    let disposePromise = null;
    const environment = {
      port,
      assetLifecycle: assetSession.lifecycle,
      /** @param {string} [reason] */
      dispose(reason = 'dispose') {
        if (disposePromise) return disposePromise;
        disposePromise = (async () => {
          const errors = [];
          for (const release of [
            () => hostPort.dispose?.(),
            () => svgTextPlatform?.releaseAll(),
            () => assetSession?.dispose(reason),
          ]) {
            try {
              await release();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0) {
            throw new AggregateError(errors, 'DSL 4.0 TurboWarp environment disposal failed');
          }
        })();
        return disposePromise;
      },
    };
    return Object.freeze(environment);
  } catch (error) {
    const cleanupErrors = [];
    for (const release of [
      () => hostPort.dispose?.(),
      () => svgTextPlatform?.releaseAll(),
      () => assetSession?.dispose('partial-creation-failed'),
    ]) {
      try {
        await release();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'DSL 4.0 TurboWarp environment creation and cleanup failed',
      );
    }
    throw error;
  }
}

/**
 * Create one host-owned, default-off TurboWarp session for a packaged DSL 4.0 component.
 *
 * The returned host never starts the story or attaches a key listener automatically.
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
 * @param {unknown} [options.runtime]
 * @param {unknown} [options.tmPoseRuntime]
 * @param {Function} [options.setLoading]
 * @param {Function} [options.createHostPort]
 * @param {Function} [options.waitSchedule]
 * @param {Function} [options.createFile]
 * @param {Function} [options.createAssetManagerComposition]
 * @param {Function} [options.createTMPoseComposition]
 * @param {Function} [options.createAsyncInputComposition]
 * @param {Function} [options.createSvgTextComposition]
 * @param {unknown} [options.actorScheduler]
 * @param {number} [options.actorFrameMilliseconds]
 * @param {Function} [options.poseSchedule]
 * @param {Function} [options.poseNow]
 * @param {(expression: string, variables: Readonly<Record<string, string | number | boolean>>, context: Record<string, unknown>) => boolean | Promise<boolean>} [options.evaluateCondition]
 * @param {(event: Readonly<Record<string, unknown>>) => void} [options.onEvent]
 * @param {(error: unknown, context: Readonly<{command: string, code: string}>) => unknown | Promise<unknown>} [options.onInputError]
 * @param {{digest: Function}} [options.subtleCrypto]
 */
export async function createDsl4TurboWarpRuntimeHost(options = {}) {
  if (!isRecord(options)) throw new TypeError('DSL 4.0 TurboWarp host options must be an object');
  const featureFlags = resolveDsl4FeatureFlags(options.featureFlags);
  if (!featureFlags.dsl4Runtime) {
    const disabled = await createDsl4RuntimeStartup({featureFlags});
    return deepFreeze({...disabled, host: null});
  }
  if (options.createHostPort !== undefined && typeof options.createHostPort !== 'function') {
    throw new TypeError('createHostPort must be a function');
  }

  /** @type {Awaited<ReturnType<typeof createRuntimeEnvironment>> | null} */
  let environment = null;
  const startup = await createDsl4RuntimeStartup({
    featureFlags,
    project: options.project,
    sourceFrontend: options.sourceFrontend,
    maxSourceBytes: options.maxSourceBytes,
    maxAssetFiles: options.maxAssetFiles,
    maxAssetBytes: options.maxAssetBytes,
    historyNavigationAvailable: options.historyNavigationAvailable,
    historyLimits: options.historyLimits,
    evaluateCondition: options.evaluateCondition,
    onEvent: options.onEvent,
    onInputError: options.onInputError,
    subtleCrypto: options.subtleCrypto,
    async createRuntimeEnvironment(
      /** @type {Readonly<Record<string, unknown>>} */ runtimeComponent,
    ) {
      environment = await createRuntimeEnvironment(options, runtimeComponent);
      return environment;
    },
  });
  if (!startup.ok) return deepFreeze({...startup, host: null});
  if (!environment) {
    throw hostError('K4-HOST-ENVIRONMENT-MISSING', 'Runtime environment was not published');
  }

  const successfulStartup =
    /** @type {Readonly<{featureFlags: Readonly<{dsl4Runtime: boolean}>, channel: 'bundled' | 'unbundled', runtimeComponent: Readonly<Record<string, unknown>>, session: Readonly<Record<string, Function>>}>} */ (
      /** @type {unknown} */ (startup)
    );
  const session = successfulStartup.session;
  /** @type {Promise<void> | null} */
  let disposePromise = null;
  function ensureActive() {
    if (disposePromise) throw hostError('K4-HOST-DISPOSED', 'DSL 4.0 TurboWarp host is disposed');
  }
  const host = Object.freeze({
    /** @param {{sceneId?: string}} [startOptions] */
    start(startOptions) {
      ensureActive();
      return session.start(startOptions);
    },
    /** @param {string} [reason] */
    stop(reason) {
      ensureActive();
      return session.stop(reason);
    },
    /** @param {unknown} target */
    attach(target) {
      ensureActive();
      return session.attach(target);
    },
    detach() {
      ensureActive();
      return session.detach();
    },
    /** @param {string} command */
    dispatchCommand(command) {
      ensureActive();
      return session.dispatchCommand(command);
    },
    /** @param {Record<string, unknown>} event */
    handleKeyDown(event) {
      ensureActive();
      return session.handleKeyDown(event);
    },
    whenInputIdle() {
      return session.whenInputIdle();
    },
    getState() {
      return session.getState();
    },
    getRunPromise() {
      return session.getRunPromise();
    },
    /** @param {string} [reason] */
    dispose(reason = 'dispose') {
      if (disposePromise) return disposePromise;
      if (typeof reason !== 'string' || reason.length === 0) {
        return Promise.reject(new TypeError('dispose reason must be a non-empty string'));
      }
      disposePromise = (async () => {
        const errors = [];
        const pending = [];
        try {
          const activeRun = session.getRunPromise();
          session.dispose();
          pending.push(Promise.resolve(session.whenInputIdle()));
          if (activeRun) pending.push(Promise.resolve(activeRun));
        } catch (error) {
          errors.push(error);
        }
        try {
          pending.push(
            Promise.resolve(
              /** @type {NonNullable<typeof environment>} */ (environment).dispose(reason),
            ),
          );
        } catch (error) {
          errors.push(error);
        }
        const settlements = await Promise.allSettled(pending);
        for (const settlement of settlements) {
          if (settlement.status === 'rejected') errors.push(settlement.reason);
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'DSL 4.0 TurboWarp host disposal failed');
        }
      })();
      return disposePromise;
    },
  });

  return deepFreeze({
    ok: true,
    enabled: true,
    featureFlags: successfulStartup.featureFlags,
    channel: successfulStartup.channel,
    runtimeComponent: successfulStartup.runtimeComponent,
    host,
    diagnostics: [],
  });
}
