import {createDsl4ReloadPlan} from './reload-planner.js';
import {deepFreeze, sourceOriginForStoryPath} from './story-document.js';
import {encodeDsl4StoryPathSegment} from './story-path.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
}

function validateStoryDocument(value: unknown) {
  if (!isRecord(value) || value.kind !== 'StoryDocument' || value.version !== '4.0') {
    throw new TypeError('live reload requires a DSL 4.0 StoryDocument');
  }
  return value;
}

interface LiveReloadRuntimeState {
  readonly status?: unknown;
  readonly runtime?: unknown;
}

interface LiveReloadActionSignature {
  readonly command: string;
  readonly handler: 'core' | 'custom';
  readonly target: string | null;
}

interface LiveReloadAction {
  readonly id?: unknown;
  readonly command?: unknown;
  readonly target?: unknown;
  readonly handler?: unknown;
}

interface LiveReloadScene {
  readonly id?: unknown;
  readonly actions?: readonly LiveReloadAction[];
}

interface LiveReloadQuiesceToken {
  readonly kind: 'Dsl4QuiesceToken';
  readonly version: 1;
  readonly candidateId: number;
  readonly runtimeGeneration: number;
  readonly storyPath: string;
  readonly sceneId: string | null;
  readonly actionIndex: number;
  readonly variables: Readonly<Record<string, string | number | boolean>>;
  readonly resumeMode: 'next-action' | 'replay-action' | 'finished';
  readonly actionSignature: Readonly<LiveReloadActionSignature> | null;
}

type LiveReloadPlanOption =
  | Readonly<{
      enabled: true;
      preserveManagedPresentation: boolean;
      destination: Readonly<{sceneId?: string; actionIndex?: number}>;
      variables: Readonly<Record<string, string | number | boolean>>;
    }>
  | Readonly<{enabled: false; reason: string}>;

interface LiveReloadPlan {
  readonly diagnostics: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly options: Readonly<
    Record<'storyStart' | 'currentScene' | 'currentAction', Readonly<LiveReloadPlanOption>>
  >;
}

/**
 * The runtime session the reload loop drives.
 *
 * The first six members are required and checked below. The rest are reached only when the session
 * offers them: `getRuntimeVariableSnapshot` is probed before use, and the action and variable
 * members belong to sessions that expose the debugger surface.
 */
export interface LiveReloadRuntimeSession {
  start(options?: {
    sceneId?: string;
    actionIndex?: number;
    variables?: Readonly<Record<string, string | number | boolean>>;
  }): Promise<unknown>;
  stop(reason?: string): unknown;
  dispose(reason?: string): unknown;
  getState(): Readonly<LiveReloadRuntimeState>;
  quiesce(request: {candidateId: number}): unknown;
  resumeQuiesce(candidateId: number): unknown;
  invokeAction?(action: unknown): unknown;
  queueVariableWrite?(request: unknown): unknown;
  getRuntimeVariableSnapshot?(): unknown;
  rejectActionInvocation?(error: unknown): unknown;
}

function validateRuntimeSession(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.start !== 'function' ||
    typeof value.stop !== 'function' ||
    typeof value.dispose !== 'function' ||
    typeof value.getState !== 'function' ||
    typeof value.quiesce !== 'function' ||
    typeof value.resumeQuiesce !== 'function'
  ) {
    throw new TypeError(
      'live reload runtime session must provide start, stop, dispose, getState, quiesce, and resumeQuiesce',
    );
  }
  return value as unknown as LiveReloadRuntimeSession;
}

function validateQuiesceToken(
  value: unknown,
  candidateId: number,
  currentStoryDocument: Readonly<Record<string, unknown>>,
) {
  if (!isRecord(value)) {
    throw new TypeError('live reload runtime returned an invalid QuiesceToken');
  }
  const token = value as Record<string, unknown>;
  const keys = Object.keys(token).sort();
  const expectedKeys = [
    'actionIndex',
    'actionSignature',
    'candidateId',
    'kind',
    'resumeMode',
    'runtimeGeneration',
    'sceneId',
    'storyPath',
    'variables',
    'version',
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    token.kind !== 'Dsl4QuiesceToken' ||
    token.version !== 1 ||
    token.candidateId !== candidateId ||
    typeof token.runtimeGeneration !== 'number' ||
    !Number.isSafeInteger(token.runtimeGeneration) ||
    token.runtimeGeneration < 0 ||
    typeof token.storyPath !== 'string' ||
    token.storyPath.length === 0 ||
    (typeof token.sceneId !== 'string' && token.sceneId !== null) ||
    (typeof token.sceneId === 'string' && token.sceneId.length === 0) ||
    typeof token.actionIndex !== 'number' ||
    !Number.isSafeInteger(token.actionIndex) ||
    token.actionIndex < 0 ||
    !isRecord(token.variables) ||
    Object.values(token.variables).some(
      (runtimeValue) =>
        typeof runtimeValue !== 'string' &&
        typeof runtimeValue !== 'number' &&
        typeof runtimeValue !== 'boolean',
    ) ||
    !['next-action', 'replay-action', 'finished'].includes(String(token.resumeMode))
  ) {
    throw new TypeError('live reload runtime returned an invalid QuiesceToken');
  }
  const runtimeGeneration = Number(token.runtimeGeneration);
  const actionIndex = Number(token.actionIndex);
  const storyPath = token.storyPath;
  const sceneId = token.sceneId;
  const variables = token.variables as Readonly<Record<string, string | number | boolean>>;
  const resumeMode = token.resumeMode as LiveReloadQuiesceToken['resumeMode'];
  let actionSignature: Readonly<LiveReloadActionSignature> | null = null;
  if (token.actionSignature !== null) {
    if (!isRecord(token.actionSignature)) {
      throw new TypeError('live reload QuiesceToken action signature is invalid');
    }
    const signatureKeys = Object.keys(token.actionSignature).sort();
    if (
      signatureKeys.length !== 3 ||
      signatureKeys[0] !== 'command' ||
      signatureKeys[1] !== 'handler' ||
      signatureKeys[2] !== 'target' ||
      typeof token.actionSignature.command !== 'string' ||
      token.actionSignature.command.length === 0 ||
      (typeof token.actionSignature.target !== 'string' && token.actionSignature.target !== null) ||
      (typeof token.actionSignature.target === 'string' &&
        token.actionSignature.target.length === 0) ||
      !['core', 'custom'].includes(String(token.actionSignature.handler))
    ) {
      throw new TypeError('live reload QuiesceToken action signature is invalid');
    }
    actionSignature = deepFreeze({
      command: token.actionSignature.command,
      handler: token.actionSignature.handler as LiveReloadActionSignature['handler'],
      target: token.actionSignature.target,
    });
  }
  const scenes = (Array.isArray(currentStoryDocument.scenes) ? currentStoryDocument.scenes : []) as
    readonly Readonly<LiveReloadScene>[] | [];
  const declaredVariables = (currentStoryDocument.variables ?? {}) as Readonly<
    Record<string, string | number | boolean>
  >;
  const declaredVariableNames = Object.keys(declaredVariables).sort();
  const tokenVariableNames = Object.keys(variables).sort();
  if (
    declaredVariableNames.length !== tokenVariableNames.length ||
    declaredVariableNames.some((name, index) => name !== tokenVariableNames[index]) ||
    declaredVariableNames.some((name) => typeof variables[name] !== typeof declaredVariables[name])
  ) {
    throw new TypeError('live reload QuiesceToken variable snapshot is inconsistent');
  }
  const scene = scenes.find((currentScene) => currentScene.id === sceneId) ?? null;
  const actions = scene?.actions ?? [];
  const action = actions[actionIndex] ?? null;
  if (actionSignature) {
    if (
      resumeMode === 'finished' ||
      !action ||
      action.id !== storyPath ||
      action.command !== actionSignature.command ||
      action.target !== actionSignature.target ||
      String(action.handler ?? 'core') !== actionSignature.handler
    ) {
      throw new TypeError('live reload QuiesceToken action anchor is inconsistent');
    }
  } else if (
    resumeMode !== 'finished' ||
    !scene ||
    actionIndex !== actions.length ||
    storyPath !== `/scenes/${encodeDsl4StoryPathSegment(String(scene.id))}`
  ) {
    throw new TypeError('live reload QuiesceToken terminal anchor is inconsistent');
  }
  const normalizedToken: LiveReloadQuiesceToken = {
    kind: 'Dsl4QuiesceToken',
    version: 1,
    candidateId,
    runtimeGeneration,
    storyPath,
    sceneId,
    actionIndex,
    variables: cloneValue(variables) as Readonly<Record<string, string | number | boolean>>,
    resumeMode,
    actionSignature,
  };
  return deepFreeze(normalizedToken);
}

function executionFromQuiesceToken(token: Readonly<LiveReloadQuiesceToken>) {
  return deepFreeze({
    status: token.resumeMode === 'finished' ? 'finished' : 'paused',
    sceneId: token.sceneId,
    actionIndex: token.actionIndex,
    actionPath: token.actionSignature ? token.storyPath : null,
    variables: cloneValue(token.variables),
    generation: token.runtimeGeneration,
  });
}

function quiesceDiagnostic(storyDocument: Readonly<Record<string, unknown>>, error: unknown) {
  const record = isRecord(error) ? error : {};
  const code =
    typeof record.code === 'string' &&
    ['K4-RELOAD-QUIESCE-TIMEOUT', 'K4-RELOAD-QUIESCE-FAILED'].includes(record.code)
      ? record.code
      : 'K4-RELOAD-QUIESCE-FAILED';
  const storyPath = typeof record.storyPath === 'string' ? record.storyPath : '/';
  const origin = sourceOriginForStoryPath(storyDocument, storyPath);
  return deepFreeze({
    version: 1,
    code,
    severity: 'error',
    message:
      code === 'K4-RELOAD-QUIESCE-TIMEOUT'
        ? 'Live reload could not stop the current action before the quiesce timeout'
        : 'Live reload could not establish a safe action boundary',
    sourceId: origin.sourceId,
    range: origin.range,
    ...(storyPath !== '/' ? {storyPath} : {}),
    related: [],
  });
}

function executionState(session: LiveReloadRuntimeSession) {
  const state = session.getState();
  if (!isRecord(state)) throw new TypeError('live reload runtime state must be an object');
  return isRecord(state.runtime) ? state.runtime : state;
}

function sourceIntegrity(input: unknown) {
  if (!isRecord(input) || input.sourceSnapshot === undefined || input.sourceSnapshot === null) {
    return null;
  }
  if (!isRecord(input.sourceSnapshot) || typeof input.sourceSnapshot.integrity !== 'string') {
    throw new TypeError('sourceSnapshot must provide an integrity string');
  }
  return input.sourceSnapshot.integrity;
}

function optionalIntegrity(value: unknown, name: string) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  return value;
}

/**
 * Coordinate author-visible DSL 4.0 source reload behavior without owning filesystem watch,
 * transport, or modal UI.
 */
export function createDsl4LiveReloadSession({
  createSession,
  initialStoryDocument,
  initialSession,
  initialSourceIntegrity,
  onRunError,
  isException,
}: {
  createSession: (
    context: Readonly<{
      storyDocument: Readonly<Record<string, unknown>>;
      previousSession: LiveReloadRuntimeSession | null;
      preserveManagedPresentation: boolean;
    }>,
  ) => LiveReloadRuntimeSession | Promise<LiveReloadRuntimeSession>;
  initialStoryDocument?: Readonly<Record<string, unknown>>;
  initialSession?: LiveReloadRuntimeSession;
  initialSourceIntegrity?: string;
  onRunError?: (error: unknown) => void;
  isException?: (value: unknown) => boolean;
}) {
  if (typeof createSession !== 'function') throw new TypeError('createSession must be a function');
  if (onRunError !== undefined && typeof onRunError !== 'function') {
    throw new TypeError('onRunError must be a function');
  }
  if (isException !== undefined && typeof isException !== 'function') {
    throw new TypeError('isException must be a function');
  }
  if ((initialStoryDocument === undefined) !== (initialSession === undefined)) {
    throw new TypeError('initialStoryDocument and initialSession must be provided together');
  }
  if (initialStoryDocument === undefined && initialSourceIntegrity !== undefined) {
    throw new TypeError('initialSourceIntegrity requires an initial runtime session');
  }

  let current =
    initialStoryDocument === undefined
      ? null
      : {
          storyDocument: validateStoryDocument(initialStoryDocument),
          session: validateRuntimeSession(initialSession),
          integrity: optionalIntegrity(initialSourceIntegrity, 'initialSourceIntegrity'),
        };
  let candidate: {
    id: number;
    storyDocument: Readonly<Record<string, unknown>>;
    integrity: string | null;
    plan: Readonly<LiveReloadPlan> | null;
    token: Readonly<LiveReloadQuiesceToken> | null;
  } | null = null;
  let status: 'waiting' | 'active' | 'invalid' | 'quiescing' | 'pending' | 'failed' | 'disposed' =
    current ? 'active' : 'waiting';
  let generation = current ? 1 : 0;
  let nextCandidateId = 1;
  let diagnostics: ReadonlyArray<Readonly<Record<string, unknown>>> = [];
  let disposed = false;
  let operationQueue = Promise.resolve();
  const pendingStages = new Set();

  function snapshot() {
    const runtime = current ? executionState(current.session) : null;
    const metadata = (current?.storyDocument.metadata ?? {}) as Readonly<Record<string, unknown>>;
    return deepFreeze({
      version: 1,
      status,
      generation,
      hasCurrent: current !== null,
      current: current
        ? {
            sourceId: typeof metadata.sourceId === 'string' ? metadata.sourceId : 'main',
            integrity: current.integrity,
            runtime: cloneValue(runtime),
          }
        : null,
      candidate: candidate
        ? {id: candidate.id, integrity: candidate.integrity, plan: candidate.plan}
        : null,
      diagnostics: cloneValue(diagnostics),
      disposed,
    });
  }

  type StageBeginResult =
    | Readonly<{kind: 'snapshot'; state: ReturnType<typeof snapshot>}>
    | Readonly<{kind: 'candidate'; candidateId: number; quiescePromise: Promise<unknown>}>;

  function observeRun(run: unknown) {
    if (!isRecord(run) || typeof run.then !== 'function') {
      return;
    }
    Promise.resolve(run).catch((error) => {
      try {
        onRunError?.(error);
      } catch {
        // Error observers cannot change live reload state.
      }
    });
  }

  function enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = operationQueue.then(operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function makeSession(
    storyDocument: Readonly<Record<string, unknown>>,
    previousSession: LiveReloadRuntimeSession | null,
    preserveManagedPresentation: boolean,
  ) {
    const created = await createSession(
      Object.freeze({storyDocument, previousSession, preserveManagedPresentation}),
    );
    try {
      return validateRuntimeSession(created);
    } catch (error) {
      if (isRecord(created) && typeof created.dispose === 'function') {
        try {
          await created.dispose('invalid-live-reload-session');
        } catch (disposeError) {
          throw new AggregateError(
            [error, disposeError],
            'Invalid DSL 4.0 live reload session cleanup failed',
          );
        }
      }
      throw error;
    }
  }

  function stage(input: unknown) {
    const begun = enqueue(async (): Promise<StageBeginResult> => {
      if (disposed) throw new TypeError('live reload session is disposed');
      if (!isRecord(input) || typeof input.ok !== 'boolean') {
        throw new TypeError('stage requires a source frontend result');
      }
      const integrity = sourceIntegrity(input);
      if (!input.ok) {
        if (!Array.isArray(input.diagnostics)) {
          throw new TypeError('invalid source result must provide diagnostics');
        }
        if (candidate && current) await current.session.resumeQuiesce(candidate.id);
        candidate = null;
        diagnostics = cloneValue(input.diagnostics) as ReadonlyArray<
          Readonly<Record<string, unknown>>
        >;
        status = 'invalid';
        return {kind: 'snapshot', state: snapshot()};
      }

      const storyDocument = validateStoryDocument(input.storyDocument);
      diagnostics = [];
      if (!current) {
        const session = await makeSession(storyDocument, null, false);
        let run;
        try {
          run = session.start();
        } catch (error) {
          try {
            await session.dispose('initial-start-failed');
          } catch (disposeError) {
            throw new AggregateError(
              [error, disposeError],
              'DSL 4.0 initial live reload start and cleanup failed',
            );
          }
          throw error;
        }
        current = {storyDocument, session, integrity};
        generation += 1;
        status = 'active';
        observeRun(run);
        return {kind: 'snapshot', state: snapshot()};
      }

      const candidateId = nextCandidateId++;
      candidate = {id: candidateId, storyDocument, integrity, plan: null, token: null};
      status = 'quiescing';
      let quiescePromise;
      try {
        quiescePromise = Promise.resolve(current.session.quiesce({candidateId}));
      } catch (error) {
        try {
          await current.session.stop('live-reload-quiesce-failed');
        } catch {
          // The fixed quiesce diagnostic remains authoritative.
        }
        candidate = null;
        diagnostics = [quiesceDiagnostic(storyDocument, error)];
        status = 'failed';
        return {kind: 'snapshot', state: snapshot()};
      }
      return {kind: 'candidate', candidateId, quiescePromise};
    });

    const completion = begun.then(async (result) => {
      if (result.kind === 'snapshot') return result.state;
      let tokenInput;
      try {
        tokenInput = await result.quiescePromise;
      } catch (error) {
        return enqueue(async () => {
          if (!candidate || candidate.id !== result.candidateId) {
            throw new TypeError('live reload candidate was replaced while quiescing');
          }
          if (current) {
            try {
              await current.session.stop('live-reload-quiesce-failed');
            } catch {
              // The fixed quiesce diagnostic remains authoritative.
            }
          }
          diagnostics = [quiesceDiagnostic(candidate.storyDocument, error)];
          candidate = null;
          status = 'failed';
          return snapshot();
        });
      }
      return enqueue(async () => {
        if (!candidate || candidate.id !== result.candidateId) {
          throw new TypeError('live reload candidate was replaced while quiescing');
        }
        if (!current) throw new TypeError('live reload has no current runtime');
        const activeCandidate = candidate;
        try {
          const token = validateQuiesceToken(tokenInput, activeCandidate.id, current.storyDocument);
          const plan = createDsl4ReloadPlan({
            currentStoryDocument: current.storyDocument,
            candidateStoryDocument: activeCandidate.storyDocument,
            currentExecution: executionFromQuiesceToken(token),
            ...(isException === undefined ? {} : {isException}),
          }) as Readonly<LiveReloadPlan>;
          candidate = {...activeCandidate, token, plan};
          diagnostics = plan.diagnostics;
          status = 'pending';
          return snapshot();
        } catch (error) {
          try {
            await current.session.stop('live-reload-quiesce-invalid');
          } catch {
            // The fixed quiesce diagnostic remains authoritative.
          }
          diagnostics = [quiesceDiagnostic(activeCandidate.storyDocument, error)];
          candidate = null;
          status = 'failed';
          return snapshot();
        }
      });
    });
    const idleStage = completion.then(
      () => undefined,
      () => undefined,
    );
    pendingStages.add(idleStage);
    void idleStage.then(() => pendingStages.delete(idleStage));
    return completion;
  }

  /** Discard author-visible candidate state while leaving the current runtime untouched. */
  function discardCandidate() {
    return enqueue(async () => {
      if (disposed) throw new TypeError('live reload session is disposed');
      if (candidate && current && status !== 'failed') {
        await current.session.resumeQuiesce(candidate.id);
      }
      candidate = null;
      diagnostics = [];
      if (status !== 'failed') status = current ? 'active' : 'waiting';
      return snapshot();
    });
  }

  function defer(candidateId: number) {
    return enqueue(async () => {
      if (disposed) throw new TypeError('live reload session is disposed');
      if (!candidate || candidate.id !== candidateId) {
        throw new TypeError('live reload candidate is stale or missing');
      }
      if (!current) throw new TypeError('live reload has no current runtime');
      await current.session.resumeQuiesce(candidateId);
      candidate = null;
      diagnostics = [];
      if (status !== 'failed') status = 'active';
      return snapshot();
    });
  }

  function commit(candidateId: number, choice: 'storyStart' | 'currentScene' | 'currentAction') {
    return enqueue(async () => {
      if (disposed) throw new TypeError('live reload session is disposed');
      if (!candidate || candidate.id !== candidateId) {
        throw new TypeError('live reload candidate is stale or missing');
      }
      if (!candidate.plan || !candidate.token) {
        throw new TypeError('live reload candidate has not reached a safe boundary');
      }
      const option = candidate.plan.options[choice];
      if (!option?.enabled) throw new TypeError(`live reload choice ${choice} is disabled`);
      if (!current) throw new TypeError('live reload has no current runtime');
      const previousRuntime = executionState(current.session);
      if (previousRuntime.status === 'failed' || previousRuntime.status === 'stopped') {
        candidate = null;
        status = 'failed';
        throw new TypeError('live reload current runtime stopped before commit');
      }

      const previous = current;
      const next = await makeSession(
        candidate.storyDocument,
        previous.session,
        option.preserveManagedPresentation,
      );
      if (next === previous.session) {
        throw new TypeError('createSession must return a new runtime session for live reload');
      }
      let previousStopped = false;
      try {
        previousStopped = true;
        await previous.session.stop('live-reload');
        await previous.session.dispose('live-reload-replaced');
        const run = next.start({
          ...('sceneId' in option.destination ? {sceneId: option.destination.sceneId} : {}),
          ...('actionIndex' in option.destination
            ? {actionIndex: option.destination.actionIndex}
            : {}),
          variables: option.variables,
        });
        current = {
          storyDocument: candidate.storyDocument,
          session: next,
          integrity: candidate.integrity,
        };
        candidate = null;
        diagnostics = [];
        generation += 1;
        status = 'active';
        observeRun(run);
        return snapshot();
      } catch (error) {
        try {
          await next.dispose('live-reload-commit-failed');
        } catch (disposeError) {
          status = previousStopped ? 'failed' : status;
          throw new AggregateError(
            [error, disposeError],
            'DSL 4.0 live reload commit and cleanup failed',
          );
        }
        if (previousStopped) status = 'failed';
        throw error;
      }
    });
  }

  function dispose() {
    return enqueue(async () => {
      if (disposed) return snapshot();
      disposed = true;
      status = 'disposed';
      candidate = null;
      diagnostics = [];
      const errors = [];
      if (current) {
        try {
          await current.session.stop('live-reload-dispose');
        } catch (error) {
          errors.push(error);
        }
        try {
          await current.session.dispose('live-reload-dispose');
        } catch (error) {
          errors.push(error);
        }
      }
      current = null;
      if (errors.length > 0) {
        throw new AggregateError(errors, 'DSL 4.0 live reload disposal failed');
      }
      return snapshot();
    });
  }

  function invokeAction(action: Readonly<Record<string, unknown>>) {
    if (disposed) {
      const error = new Error('live reload session is disposed');
      Object.defineProperty(error, 'code', {value: 'K4-RELOAD-INVOKE-DISPOSED'});
      return Promise.reject(error);
    }
    if (!current || typeof current.session.invokeAction !== 'function') {
      const error = new Error('live reload has no action-capable current runtime');
      Object.defineProperty(error, 'code', {value: 'K4-RELOAD-INVOKE-INACTIVE'});
      return Promise.reject(error);
    }
    return Promise.resolve(current.session.invokeAction(action));
  }

  function queueVariableWrite(request: unknown) {
    if (disposed || !current || typeof current.session.queueVariableWrite !== 'function') {
      return Object.freeze({accepted: false, code: 'K4-VARIABLE-WRITE-INACTIVE'});
    }
    return current.session.queueVariableWrite(request);
  }

  function getRuntimeVariableSnapshot() {
    if (!current || typeof current.session.getRuntimeVariableSnapshot !== 'function') return null;
    return current.session.getRuntimeVariableSnapshot();
  }

  function rejectActionInvocation(error: unknown) {
    if (disposed) return Promise.reject(new TypeError('live reload session is disposed'));
    if (!current || typeof current.session.rejectActionInvocation !== 'function') {
      return Promise.reject(new TypeError('live reload has no action-capable current runtime'));
    }
    return Promise.resolve(current.session.rejectActionInvocation(error));
  }

  return Object.freeze({
    stage,
    defer,
    discardCandidate,
    commit,
    invokeAction,
    queueVariableWrite,
    getRuntimeVariableSnapshot,
    rejectActionInvocation,
    dispose,
    getState: snapshot,
    async whenIdle() {
      await Promise.all([...pendingStages, operationQueue]);
      await operationQueue;
      return snapshot();
    },
  });
}
