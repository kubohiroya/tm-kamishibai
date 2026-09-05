import {validateDsl4ActionRegistrySnapshot} from './action-registry.js';

const completedResult = Object.freeze({outcome: 'completed'});
const terminalStates = new Set(['completed', 'transitioned', 'failed', 'cancelled']);

export const dsl4CustomActionTimeoutDefaults = Object.freeze({
  customActionTimeoutMs: 30_000,
  minimumCustomActionTimeoutMs: 100,
  maximumCustomActionTimeoutMs: 300_000,
  maximumFailureMessageScalars: 256,
});

export class Dsl4CustomActionError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'Dsl4CustomActionError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function customError(code: string, message: string) {
  return new Dsl4CustomActionError(code, message);
}

function cancellationError() {
  const error = new Error('Custom action invocation was cancelled');
  error.name = 'AbortError';
  return error;
}

function defaultScheduleTimeout(callback: () => void, milliseconds: number) {
  const timer = setTimeout(callback, milliseconds);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
}

function validateStoryDocument(input: unknown) {
  if (!isRecord(input) || input.kind !== 'StoryDocument' || input.version !== '4.0') {
    throw new TypeError('Custom action adapter requires a StoryDocument version 4.0');
  }
  if (!Array.isArray(input.scenes)) {
    throw new TypeError('Custom action StoryDocument scenes must be an array');
  }
  const sceneIds = new Set();
  for (const scene of input.scenes) {
    if (!isRecord(scene) || typeof scene.id !== 'string' || scene.id.length === 0) {
      throw new TypeError('Custom action StoryDocument scene IDs must be non-empty strings');
    }
    if (sceneIds.has(scene.id)) {
      throw new TypeError('Custom action StoryDocument scene IDs must be unique');
    }
    sceneIds.add(scene.id);
  }
  return sceneIds;
}

function validateThreadHost(input: unknown) {
  if (!isRecord(input)) throw new TypeError('Custom action thread host must be an object');
  for (const method of ['start', 'waitForCompletion', 'stop'] as const) {
    if (typeof input[method] !== 'function') {
      throw new TypeError(`Custom action thread host must provide ${method}`);
    }
  }
  const host = input as Record<'start' | 'waitForCompletion' | 'stop', (...p: any[]) => any>;
  return Object.freeze({
    start: host.start.bind(input),
    waitForCompletion: host.waitForCompletion.bind(input),
    stop: host.stop.bind(input),
  });
}

function validateRuntimeContext(input: unknown) {
  if (
    !isRecord(input) ||
    typeof input.actionPath !== 'string' ||
    input.actionPath.length === 0 ||
    !isRecord(input.signal) ||
    typeof input.signal.aborted !== 'boolean' ||
    typeof input.signal.addEventListener !== 'function' ||
    typeof input.signal.removeEventListener !== 'function'
  ) {
    throw new TypeError('Custom action runtime context is invalid');
  }
  if (
    !isRecord(input.structuredData) ||
    Object.keys(input.structuredData).length !== 2 ||
    typeof input.structuredData.actionScopeRef !== 'string' ||
    input.structuredData.actionScopeRef.length === 0 ||
    typeof input.structuredData.actionViewRef !== 'string' ||
    input.structuredData.actionViewRef.length === 0
  ) {
    throw new TypeError('Custom action runtime context requires Structured Data resources');
  }
  return Object.freeze({
    actionPath: input.actionPath,
    signal: input.signal as unknown as AbortSignal,
    structuredData: Object.freeze({
      actionScopeRef: input.structuredData.actionScopeRef,
      actionViewRef: input.structuredData.actionViewRef,
    }),
  });
}

function validatePayload(input: unknown, registration: Readonly<Record<string, any>>) {
  if (!isRecord(input)) throw new TypeError('Custom action payload must be an object');
  const keys = Object.keys(input).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'arguments' ||
    keys[1] !== 'name' ||
    keys[2] !== 'target' ||
    input.name !== registration.name ||
    typeof input.target !== 'string' ||
    input.target.length === 0 ||
    !isRecord(input.arguments)
  ) {
    throw new TypeError('Custom action payload does not match its registration');
  }
  const declaredParameters = registration.parameters as ReadonlyArray<
    Readonly<Record<string, any>>
  >;
  const parameters = new Map(declaredParameters.map((parameter) => [parameter.name, parameter]));
  for (const name of Object.keys(input.arguments)) {
    const parameter = parameters.get(name);
    if (!parameter) {
      throw customError(
        'K4-CUSTOM-ARGUMENT-UNKNOWN',
        'Custom action payload contains an undeclared argument',
      );
    }
    if (typeof input.arguments[name] !== parameter.type) {
      throw new TypeError('Custom action payload argument type does not match its registration');
    }
  }
  for (const parameter of declaredParameters) {
    if (parameter.required && !Object.hasOwn(input.arguments, parameter.name)) {
      throw new TypeError('Custom action payload is missing a required argument');
    }
  }
  return deepFreeze({
    name: registration.name,
    target: input.target,
    arguments: {...input.arguments},
  });
}

function isThreadKey(thread: unknown) {
  return (typeof thread === 'object' && thread !== null) || typeof thread === 'function';
}

/**
 * Create one session-owned adapter between the fixed customAction runtime port and Scratch
 * primary threads. The injected host must return before the started handler body can execute.
 */
export function createDsl4ActionInvocationAdapter(options: {
  registrySnapshot: unknown;
  storyDocument: unknown;
  runtimeGeneration: number;
  threadHost: unknown;
  customActionTimeoutMs?: number;
  scheduleTimeout?: (callback: () => void, milliseconds: number) => () => void;
  onDiagnostic?: (diagnostic: Readonly<Record<string, unknown>>) => unknown;
  onInternalError?: (error: unknown, context: Readonly<Record<string, unknown>>) => unknown;
}) {
  if (!isRecord(options)) throw new TypeError('Custom action adapter options must be an object');
  const registrySnapshot = validateDsl4ActionRegistrySnapshot(options.registrySnapshot);
  const sceneIds = validateStoryDocument(options.storyDocument);
  const runtimeGeneration = options.runtimeGeneration;
  if (!Number.isSafeInteger(runtimeGeneration) || runtimeGeneration < 0) {
    throw new TypeError('Custom action runtimeGeneration must be a non-negative safe integer');
  }
  const threadHost = validateThreadHost(options.threadHost);
  const customActionTimeoutMs =
    options.customActionTimeoutMs ?? dsl4CustomActionTimeoutDefaults.customActionTimeoutMs;
  if (
    !Number.isSafeInteger(customActionTimeoutMs) ||
    customActionTimeoutMs < dsl4CustomActionTimeoutDefaults.minimumCustomActionTimeoutMs ||
    customActionTimeoutMs > dsl4CustomActionTimeoutDefaults.maximumCustomActionTimeoutMs
  ) {
    throw new TypeError('customActionTimeoutMs is outside the supported range');
  }
  const scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
  if (typeof scheduleTimeout !== 'function')
    throw new TypeError('scheduleTimeout must be a function');
  if (options.onDiagnostic !== undefined && typeof options.onDiagnostic !== 'function') {
    throw new TypeError('onDiagnostic must be a function');
  }
  if (options.onInternalError !== undefined && typeof options.onInternalError !== 'function') {
    throw new TypeError('onInternalError must be a function');
  }
  const onDiagnostic = options.onDiagnostic;
  const onInternalError = options.onInternalError;

  const registrations = new Map(registrySnapshot.actions.map((entry) => [entry.name, entry]));
  const invocationByThread: WeakMap<object, Record<string, any>> = new WeakMap();
  const settledInvocationByThread: WeakMap<object, Record<string, any>> = new WeakMap();
  const activeInvocations: Set<Record<string, any>> = new Set();
  let nextInvocationSequence = 1;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;

  function reportDiagnostic(code: string, invocation: Record<string, any> | null) {
    try {
      onDiagnostic?.(
        deepFreeze({
          code,
          ...(invocation
            ? {
                invocationId: invocation.publicView.invocationId,
                actionPath: invocation.publicView.actionPath,
              }
            : {}),
        }),
      );
    } catch {
      // Diagnostics cannot change invocation semantics.
    }
  }

  function reportInternalError(
    error: unknown,
    operation: string,
    invocation: Record<string, any> | null,
  ) {
    try {
      onInternalError?.(
        error,
        deepFreeze({
          operation,
          ...(invocation ? {invocationId: invocation.publicView.invocationId} : {}),
        }),
      );
    } catch {
      // Internal observers cannot change invocation semantics.
    }
  }

  function clearInvocationHooks(invocation: Record<string, any>) {
    invocation.runtimeContext.signal.removeEventListener('abort', invocation.handleRuntimeAbort);
    try {
      invocation.cancelTimeout();
    } catch (error) {
      reportInternalError(error, 'cancel-timeout', invocation);
    }
    invocation.cancelTimeout = () => {};
  }

  function settle(
    invocation: Record<string, any>,
    terminal: Readonly<{
      state: 'completed' | 'transitioned' | 'failed' | 'cancelled';
      result?: Readonly<Record<string, unknown>>;
      error?: Error;
      stop: boolean;
      reason: string;
    }>,
    diagnoseLate: boolean = true,
  ) {
    if (invocation.phase !== 'running') {
      if (
        diagnoseLate &&
        (invocation.phase === 'settling' || terminalStates.has(invocation.phase))
      ) {
        reportDiagnostic('K4-CUSTOM-ALREADY-SETTLED', invocation);
      }
      return false;
    }
    invocation.phase = terminal.state === 'cancelled' ? 'cancelling' : 'settling';
    clearInvocationHooks(invocation);
    invocation.abortController.abort(terminal.reason);

    void (async () => {
      let finalTerminal = terminal;
      let stopCompletion: unknown;
      if (terminal.stop) {
        try {
          stopCompletion = threadHost.stop(invocation.thread, terminal.reason);
        } catch (error) {
          reportInternalError(error, 'stop-thread', invocation);
          finalTerminal = {
            state: 'failed',
            error: customError(
              'K4-CUSTOM-CLEANUP-FAILED',
              'Custom action primary thread cleanup failed',
            ),
            stop: false,
            reason: 'cleanup-failed',
          };
        }
      }
      settledInvocationByThread.set(invocation.thread, invocation);
      invocationByThread.delete(invocation.thread);
      if (finalTerminal === terminal && terminal.stop) {
        try {
          await stopCompletion;
        } catch (error) {
          reportInternalError(error, 'stop-thread', invocation);
          finalTerminal = {
            state: 'failed',
            error: customError(
              'K4-CUSTOM-CLEANUP-FAILED',
              'Custom action primary thread cleanup failed',
            ),
            stop: false,
            reason: 'cleanup-failed',
          };
        }
      }
      activeInvocations.delete(invocation);
      invocation.phase = finalTerminal.state;
      if (finalTerminal.state === 'completed' || finalTerminal.state === 'transitioned') {
        invocation.resolve(finalTerminal.result);
      } else {
        invocation.reject(finalTerminal.error);
      }
    })();
    return true;
  }

  function invocationForUtil(util: unknown) {
    const thread = isRecord(util) ? util.thread : null;
    const invocation = isThreadKey(thread) ? invocationByThread.get(thread as object) : undefined;
    if (!invocation) {
      reportDiagnostic('K4-CUSTOM-CONTEXT-MISSING', null);
      throw customError(
        'K4-CUSTOM-CONTEXT-MISSING',
        'Current action context is not available for this Scratch thread',
      );
    }
    return invocation;
  }

  function invocationForTerminalUtil(util: unknown) {
    const thread = isRecord(util) ? util.thread : null;
    if (!isThreadKey(thread)) return invocationForUtil(util);
    const invocation = invocationByThread.get(thread as object);
    if (invocation) return invocation;
    const settled = settledInvocationByThread.get(thread as object);
    if (settled) {
      reportDiagnostic('K4-CUSTOM-ALREADY-SETTLED', settled);
      return null;
    }
    return invocationForUtil(util);
  }

  function failUnknownArgument(invocation: Record<string, any>) {
    settle(invocation, {
      state: 'failed',
      error: customError(
        'K4-CUSTOM-ARGUMENT-UNKNOWN',
        'Current action argument is not declared by the handler',
      ),
      stop: true,
      reason: 'argument-unknown',
    });
  }

  function declaredArgument(invocation: Record<string, any>, name: unknown) {
    if (typeof name !== 'string' || !invocation.parameters.has(name)) {
      failUnknownArgument(invocation);
      return null;
    }
    return name;
  }

  async function stopUnexpectedThreads(threads: unknown[], reason: string) {
    const settlements = await Promise.allSettled(
      threads.filter(isThreadKey).map(async (thread) => threadHost.stop(thread as object, reason)),
    );
    const failures = settlements
      .filter((settlement) => settlement.status === 'rejected')
      .map((settlement) => settlement.reason);
    if (failures.length > 0) {
      reportInternalError(
        new AggregateError(failures, 'Custom action unexpected thread cleanup failed'),
        'stop-unexpected-threads',
        null,
      );
    }
  }

  async function customAction(payloadInput: unknown, contextInput: unknown) {
    if (disposed) throw new TypeError('Custom action adapter is disposed');
    if (!isRecord(payloadInput) || typeof payloadInput.name !== 'string') {
      throw new TypeError('Custom action payload must name one registered handler');
    }
    const registration = registrations.get(payloadInput.name);
    if (!registration) {
      throw customError(
        'K4-CUSTOM-HANDLER-MISSING',
        'Custom action handler is not present in the fixed Registry Snapshot',
      );
    }
    const payload = validatePayload(payloadInput, registration);
    const runtimeContext = validateRuntimeContext(contextInput);
    if (runtimeContext.signal.aborted) throw cancellationError();

    const invocationId = `invocation-${runtimeGeneration}-${nextInvocationSequence++}`;
    const abortController = new AbortController();
    let phase = 'created';
    let resolveResult: (value: unknown) => void = () => {};
    let rejectResult: (reason: unknown) => void = () => {};
    const resultPromise = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    let started;
    try {
      started = threadHost.start(deepFreeze({...registration.source}));
    } catch (error) {
      reportInternalError(error, 'start-primary-thread', null);
      throw customError(
        'K4-CUSTOM-HANDLER-MISSING',
        'Custom action primary handler could not be started',
      );
    }
    const threads = Array.isArray(started) ? started : [];
    if (threads.length !== 1 || !isThreadKey(threads[0])) {
      await stopUnexpectedThreads(threads, 'handler-cardinality-invalid');
      const ambiguous = threads.length > 1;
      throw customError(
        ambiguous ? 'K4-CUSTOM-HANDLER-AMBIGUOUS' : 'K4-CUSTOM-HANDLER-MISSING',
        ambiguous
          ? 'Custom action dispatch started more than one primary handler'
          : 'Custom action primary handler was not found',
      );
    }

    const thread = threads[0] as object;
    const invocation: Record<string, any> = {
      thread,
      registration,
      parameters: new Map(registration.parameters.map((parameter) => [parameter.name, parameter])),
      payload,
      runtimeContext,
      abortController,
      resolve: resolveResult,
      reject: rejectResult,
      resultPromise,
      get phase() {
        return phase;
      },
      set phase(value) {
        phase = value;
      },
      cancelTimeout: () => {},
      handleRuntimeAbort: () => {},
      publicView: null,
    };
    invocation.publicView = Object.freeze({
      invocationId,
      runtimeGeneration,
      registrySnapshot,
      actionPath: runtimeContext.actionPath,
      name: payload.name,
      target: payload.target,
      arguments: payload.arguments,
      actionScope: runtimeContext.structuredData.actionScopeRef,
      actionView: runtimeContext.structuredData.actionViewRef,
      signal: abortController.signal,
      get state() {
        return invocation.phase;
      },
    });
    invocation.handleRuntimeAbort = () => {
      settle(invocation, {
        state: 'cancelled',
        error: cancellationError(),
        stop: true,
        reason: 'runtime-cancelled',
      });
    };
    invocation.phase = 'running';
    invocationByThread.set(thread, invocation);
    activeInvocations.add(invocation);
    runtimeContext.signal.addEventListener('abort', invocation.handleRuntimeAbort, {once: true});
    if (runtimeContext.signal.aborted) invocation.handleRuntimeAbort();

    if (invocation.phase === 'running') {
      let scheduledCancel;
      try {
        scheduledCancel = scheduleTimeout(() => {
          settle(invocation, {
            state: 'failed',
            error: customError('K4-CUSTOM-TIMEOUT', 'Custom action primary handler timed out'),
            stop: true,
            reason: 'timeout',
          });
        }, customActionTimeoutMs);
      } catch (error) {
        reportInternalError(error, 'schedule-timeout', invocation);
        settle(invocation, {
          state: 'failed',
          error: customError('K4-CUSTOM-TIMEOUT', 'Custom action timeout could not be scheduled'),
          stop: true,
          reason: 'timeout-schedule-failed',
        });
      }
      if (invocation.phase === 'running' && typeof scheduledCancel !== 'function') {
        settle(invocation, {
          state: 'failed',
          error: customError('K4-CUSTOM-TIMEOUT', 'Custom action timeout could not be scheduled'),
          stop: true,
          reason: 'timeout-schedule-failed',
        });
      } else if (invocation.phase === 'running') {
        invocation.cancelTimeout = scheduledCancel;
      } else if (typeof scheduledCancel === 'function') {
        try {
          scheduledCancel();
        } catch (error) {
          reportInternalError(error, 'cancel-timeout', invocation);
        }
      }
    }

    if (invocation.phase === 'running') {
      try {
        const completion = threadHost.waitForCompletion(thread);
        if (
          ((typeof completion !== 'object' || completion === null) &&
            typeof completion !== 'function') ||
          typeof completion.then !== 'function'
        ) {
          throw new TypeError('waitForCompletion must return a Promise-like value');
        }
        Promise.resolve(completion).then(
          () => {
            settle(
              invocation,
              {state: 'completed', result: completedResult, stop: false, reason: 'normal-end'},
              false,
            );
          },
          () => {
            settle(
              invocation,
              {
                state: 'failed',
                error: customError(
                  'K4-CUSTOM-THREAD-FAILED',
                  'Custom action primary thread failed',
                ),
                stop: false,
                reason: 'thread-failed',
              },
              false,
            );
          },
        );
      } catch (error) {
        reportInternalError(error, 'observe-primary-thread', invocation);
        settle(
          invocation,
          {
            state: 'failed',
            error: customError(
              'K4-CUSTOM-THREAD-FAILED',
              'Custom action primary thread could not be observed',
            ),
            stop: true,
            reason: 'thread-observer-failed',
          },
          false,
        );
      }
    }
    return resultPromise;
  }

  const adapter = {
    customAction,
    currentActionName(util: unknown) {
      return invocationForUtil(util).publicView.name;
    },
    currentActionTarget(util: unknown) {
      return invocationForUtil(util).publicView.target;
    },
    currentActionResources(util: unknown) {
      return invocationForUtil(util).runtimeContext.structuredData;
    },
    currentActionHasArgument(name: unknown, util: unknown) {
      const invocation = invocationForUtil(util);
      const declared = declaredArgument(invocation, name);
      return declared === null ? false : Object.hasOwn(invocation.publicView.arguments, declared);
    },
    currentActionArgument(name: unknown, util: unknown) {
      const invocation = invocationForUtil(util);
      const declared = declaredArgument(invocation, name);
      return declared === null ? '' : (invocation.publicView.arguments[declared] ?? '');
    },
    completeCurrentAction(util: unknown) {
      const invocation = invocationForTerminalUtil(util);
      if (!invocation) return;
      settle(invocation, {
        state: 'completed',
        result: completedResult,
        stop: true,
        reason: 'explicit-complete',
      });
    },
    failCurrentAction(message: unknown, util: unknown) {
      const invocation = invocationForTerminalUtil(util);
      if (!invocation) return;
      const scalars = [...(typeof message === 'string' ? message : '')];
      const bounded = scalars
        .slice(0, dsl4CustomActionTimeoutDefaults.maximumFailureMessageScalars)
        .join('');
      settle(invocation, {
        state: 'failed',
        error: customError('K4-CUSTOM-FAILED', bounded || 'Custom action handler failed'),
        stop: true,
        reason: 'explicit-fail',
      });
    },
    gotoFromCurrentAction(sceneId: unknown, util: unknown) {
      const invocation = invocationForTerminalUtil(util);
      if (!invocation) return;
      if (invocation.phase !== 'running') {
        reportDiagnostic('K4-CUSTOM-ALREADY-SETTLED', invocation);
        return;
      }
      if (typeof sceneId !== 'string' || !sceneIds.has(sceneId)) {
        settle(invocation, {
          state: 'failed',
          error: customError('K4-CUSTOM-GOTO-001', 'Custom action goto scene is unknown'),
          stop: true,
          reason: 'goto-invalid',
        });
        return;
      }
      settle(invocation, {
        state: 'transitioned',
        result: deepFreeze({outcome: 'transitioned', sceneId}),
        stop: true,
        reason: 'goto',
      });
    },
    dispose(reason: string = 'dispose') {
      if (disposePromise) return disposePromise;
      if (typeof reason !== 'string' || reason.length === 0) {
        return Promise.reject(new TypeError('Custom action dispose reason must be non-empty'));
      }
      disposed = true;
      const pending = [...activeInvocations];
      for (const invocation of pending) {
        settle(invocation, {
          state: 'cancelled',
          error: cancellationError(),
          stop: true,
          reason: 'adapter-disposed',
        });
      }
      disposePromise = (async () => {
        const settlements = await Promise.allSettled(
          pending.map((invocation) => invocation.resultPromise),
        );
        const cleanupFailures = [];
        for (const settlement of settlements) {
          if (
            settlement.status === 'rejected' &&
            settlement.reason instanceof Dsl4CustomActionError &&
            settlement.reason.code === 'K4-CUSTOM-CLEANUP-FAILED'
          ) {
            cleanupFailures.push(settlement.reason);
          }
        }
        if (cleanupFailures.length > 0) {
          throw new AggregateError(cleanupFailures, 'Custom action adapter disposal failed');
        }
      })();
      return disposePromise;
    },
  };
  return Object.freeze(adapter);
}
