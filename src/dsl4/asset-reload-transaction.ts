import {deepFreeze} from './story-document.js';
import {
  createDsl4AssetCleanupOwners,
  createDsl4AssetObserverWaits,
} from './asset-cleanup-owners.js';
import {createDsl4RetryableCleanup} from './retryable-cleanup.js';
import {dsl4FailedCreationCleanupSteps} from './creation-cleanup.js';

const liveReloadKinds = new Set([
  'initial',
  'source-live-reload',
  'asset-live-reload',
  'composite-live-reload',
  'additive-composite-live-reload',
]);
const integrityPattern = /^sha256-[A-Za-z0-9+/]{43}=$/u;

export class Dsl4AssetReloadTransactionError extends Error {
  code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'Dsl4AssetReloadTransactionError';
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new Dsl4AssetReloadTransactionError(code, message, cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

function integrity(value: unknown, name: string) {
  if (typeof value !== 'string' || !integrityPattern.test(value)) {
    throw new TypeError(`${name} must be a canonical SHA-256 SRI value`);
  }
  return value;
}

function abbreviatedIntegrity(value: unknown, name: string) {
  if (value === null || value === 'bundle') return value;
  const full = integrity(value, name);
  return `${full.slice(0, 18)}…${full.slice(-8)}`;
}

/** The asset adapter the transaction prepares candidates through. */
interface AssetReloadAdapter {
  getCandidateProvider(revision: number): unknown;
  accept(revision: number): unknown;
  discard(revision: number): unknown;
  dispose(): unknown;
  hasPendingCleanup?(): boolean;
  beginCleanupAttempt?(): void;
}

/** One prepared asset generation, ready to swap in or throw away. */
interface PreparedAssetGeneration {
  activate(request: Readonly<{revision: number; request: unknown}>): unknown;
  rollback(reason: string): unknown;
  release(reason: string): unknown;
}

function validateAssetAdapter(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.getCandidateProvider !== 'function' ||
    typeof value.accept !== 'function' ||
    typeof value.discard !== 'function' ||
    typeof value.dispose !== 'function'
  ) {
    throw new TypeError('asset reload transaction requires an asset adapter');
  }
  return value as unknown as AssetReloadAdapter;
}

function validateCandidate(value: unknown) {
  if (!isRecord(value) || !isRecord(value.classification)) {
    throw new TypeError('asset reload candidate must be an object with a classification');
  }
  const revision = positiveInteger(value.revision, 'revision');
  if (
    typeof value.providerId !== 'string' ||
    !/^asset-provider-[1-9][0-9]*$/u.test(value.providerId)
  ) {
    throw new TypeError('asset reload candidate providerId is invalid');
  }
  const kind = value.classification.kind;
  if (typeof kind !== 'string' || (!liveReloadKinds.has(kind) && kind !== 'full-rebuild')) {
    throw new TypeError('asset reload candidate classification is invalid');
  }
  if (!Array.isArray(value.classification.changedAssets)) {
    throw new TypeError('asset reload candidate changedAssets must be an array');
  }
  if (!Array.isArray(value.classification.affectedScenes) || !Array.isArray(value.validations)) {
    throw new TypeError('asset reload candidate summaries must be arrays');
  }
  return deepFreeze({
    formatVersion: 1,
    revision,
    providerId: value.providerId,
    sourceIntegrity: integrity(value.sourceIntegrity, 'sourceIntegrity'),
    graphIntegrity: integrity(value.graphIntegrity, 'graphIntegrity'),
    contentIntegrity: integrity(value.contentIntegrity, 'contentIntegrity'),
    classification: {
      kind,
      requiresFullRebuild: value.classification.requiresFullRebuild === true,
      changedAssets: value.classification.changedAssets.map((asset) => {
        if (
          !isRecord(asset) ||
          typeof asset.id !== 'string' ||
          asset.id.length === 0 ||
          typeof asset.kind !== 'string' ||
          asset.kind.length === 0 ||
          typeof asset.change !== 'string' ||
          !['added', 'content', 'removed'].includes(asset.change) ||
          !Number.isSafeInteger(asset.fileCount) ||
          Number(asset.fileCount) < 0
        ) {
          throw new TypeError('asset reload changed asset summary is invalid');
        }
        return {
          id: asset.id,
          kind: asset.kind,
          change: asset.change,
          fileCount: Number(asset.fileCount),
          beforeIntegrity: abbreviatedIntegrity(
            asset.beforeIntegrity,
            'changedAsset.beforeIntegrity',
          ),
          afterIntegrity: abbreviatedIntegrity(asset.afterIntegrity, 'changedAsset.afterIntegrity'),
        };
      }),
      affectedScenes: value.classification.affectedScenes.map((sceneId) => {
        if (typeof sceneId !== 'string' || sceneId.length === 0) {
          throw new TypeError('asset reload affected scene is invalid');
        }
        return sceneId;
      }),
    },
    validations: value.validations.map((validation) => {
      if (
        !isRecord(validation) ||
        typeof validation.assetId !== 'string' ||
        validation.assetId.length === 0 ||
        typeof validation.kind !== 'string' ||
        validation.kind.length === 0 ||
        !Number.isSafeInteger(validation.fileCount) ||
        Number(validation.fileCount) < 1
      ) {
        throw new TypeError('asset reload validation summary is invalid');
      }
      return {
        assetId: validation.assetId,
        kind: validation.kind,
        fileCount: Number(validation.fileCount),
      };
    }),
  });
}

function validatePrepared(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.activate !== 'function' ||
    typeof value.rollback !== 'function' ||
    typeof value.release !== 'function'
  ) {
    throw new TypeError('prepared asset generation must provide activate, rollback, and release');
  }
  return value as unknown as PreparedAssetGeneration;
}

function diagnostic(code: string, message: string) {
  return deepFreeze({formatVersion: 1, code, severity: 'error', message});
}

/**
 * Prepare, activate, acknowledge, and release complete source-plus-asset generations in order.
 * Platform code supplies the safe-boundary and generation-specific runtime implementation.
 */
export function createDsl4AssetReloadTransaction(options: {
  assetAdapter: AssetReloadAdapter;
  prepareGeneration: (
    input: Readonly<{
      summary: Readonly<Record<string, unknown>>;
      provider: Readonly<Record<string, unknown>>;
      signal: AbortSignal;
    }>,
  ) => unknown | Promise<unknown>;
  onEvent?: (event: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
  onDiagnostic?: (
    diagnostic: Readonly<Record<string, unknown>> | null,
  ) => unknown | Promise<unknown>;
  onError?: (error: unknown) => unknown;
}) {
  if (!isRecord(options)) throw new TypeError('asset reload transaction options are required');
  const adapter = validateAssetAdapter(options.assetAdapter);
  if (typeof options.prepareGeneration !== 'function') {
    throw new TypeError('prepareGeneration must be a function');
  }
  if (options.onEvent !== undefined && typeof options.onEvent !== 'function') {
    throw new TypeError('onEvent must be a function');
  }
  if (options.onDiagnostic !== undefined && typeof options.onDiagnostic !== 'function') {
    throw new TypeError('onDiagnostic must be a function');
  }
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new TypeError('onError must be a function');
  }

  let disposed = false;
  let status = 'idle';
  let latestRevision = 0;
  let generation = 0;
  const owners = createDsl4AssetCleanupOwners('Asset generation cleanup failed');
  type Generation = {
    summary: ReturnType<typeof validateCandidate>;
    prepared: PreparedAssetGeneration;
    cleanup: ReturnType<typeof owners.own>;
    rollback: boolean;
    discard: boolean;
    retiring: boolean;
    generation?: number;
  };
  let candidate: Generation | null = null;
  let active: Generation | null = null;
  let currentDiagnostic: Readonly<Record<string, unknown>> | null = null;
  let lastEvent: Readonly<Record<string, unknown>> | null = null;
  let operationQueue = Promise.resolve();
  let preparation: AbortController | null = null;
  let preparationStopped = false;
  function reportError(error: unknown) {
    try {
      options.onError?.(error);
    } catch {
      /* Error observers cannot change ownership. */
    }
  }
  const observers = createDsl4AssetObserverWaits(reportError);
  function requireActive() {
    if (disposed) throw new TypeError('asset reload transaction is disposed');
  }
  function snapshot() {
    const visibleCandidate = candidate && !candidate.retiring ? candidate : null;
    return deepFreeze({
      version: 1,
      status,
      disposed,
      latestRevision,
      generation,
      pendingReleaseCount: Math.max(
        0,
        owners.size -
          Number(Boolean(visibleCandidate)) -
          Number(Boolean(active && !active.retiring)),
      ),
      active:
        active && !active.retiring
          ? {
              revision: active.summary.revision,
              providerId: active.summary.providerId,
              sourceIntegrity: active.summary.sourceIntegrity,
              graphIntegrity: active.summary.graphIntegrity,
              contentIntegrity: active.summary.contentIntegrity,
              generation: active.generation,
            }
          : null,
      candidate: visibleCandidate
        ? {
            revision: visibleCandidate.summary.revision,
            providerId: visibleCandidate.summary.providerId,
            classification: visibleCandidate.summary.classification,
          }
        : null,
      diagnostic: currentDiagnostic,
      lastEvent,
    });
  }
  function enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    if (disposed) return Promise.reject(new TypeError('asset reload transaction is disposed'));
    const result = operationQueue.then(operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async function publish(event: Readonly<Record<string, unknown>>) {
    if (!disposed) lastEvent = event;
    try {
      await observers.wait(() => options.onEvent?.(event));
    } catch (error) {
      reportError(error);
    }
  }
  async function setDiagnostic(value: Readonly<Record<string, unknown>> | null) {
    if (disposed) return;
    currentDiagnostic = value;
    try {
      await observers.wait(() => options.onDiagnostic?.(value));
    } catch (error) {
      reportError(error);
    }
  }
  function ownGeneration(value: unknown, summary: ReturnType<typeof validateCandidate>) {
    const returned = isRecord(value) ? value : {};
    const record = {
      summary,
      prepared: value as PreparedAssetGeneration,
      rollback: true,
      discard: false,
      retiring: false,
    } as Generation;
    record.cleanup = owners.own([
      (reason) =>
        record.rollback && typeof returned.rollback === 'function'
          ? returned.rollback(reason)
          : undefined,
      (reason) => (typeof returned.release === 'function' ? returned.release(reason) : undefined),
      // Final adapter disposal owns all providers once the transaction closes.
      () => (record.discard && !disposed ? adapter.discard(summary.revision) : undefined),
    ]);
    return record;
  }
  function releasePrepared(value: Generation | null, reason: string) {
    if (!value) return Promise.resolve();
    value.retiring = true;
    return value.cleanup.release(reason);
  }
  async function failedPreparation(
    error: unknown,
    summary: ReturnType<typeof validateCandidate>,
    value?: Generation,
  ) {
    if (value) {
      value.discard = true;
      await releasePrepared(value, 'prepare-failed');
    } else {
      const cleanup = owners.own([
        ...dsl4FailedCreationCleanupSteps(error),
        () => (!disposed ? adapter.discard(summary.revision) : undefined),
      ]);
      await cleanup.release('prepare-failed');
    }
  }
  function stage(input: unknown) {
    return enqueue(async () => {
      requireActive();
      const summary = validateCandidate(input);
      if (summary.revision <= latestRevision)
        fail('K4-ASSET-STALE-001', 'Asset candidate revision is stale');
      latestRevision = summary.revision;
      if (candidate) {
        await releasePrepared(candidate, 'candidate-superseded');
        candidate = null;
      }
      requireActive();
      if (
        summary.classification.kind === 'full-rebuild' ||
        summary.classification.requiresFullRebuild
      ) {
        const cleanup = owners.own([
          () => (!disposed ? adapter.discard(summary.revision) : undefined),
        ]);
        await cleanup.release('full-rebuild');
        requireActive();
        status = 'full-rebuild';
        await setDiagnostic(
          diagnostic(
            'K4-ASSET-FULL-REBUILD-REQUIRED',
            'This asset graph change requires a new preview build',
          ),
        );
        await publish(
          deepFreeze({
            type: 'preview.asset.full-rebuild',
            revision: summary.revision,
            classification: summary.classification,
          }),
        );
        return snapshot();
      }
      status = 'preparing';
      await setDiagnostic(null);
      if (disposed || preparationStopped) return snapshot();
      let selected: Generation | undefined;
      try {
        requireActive();
        const provider = adapter.getCandidateProvider(summary.revision);
        if (!isRecord(provider) || provider.providerId !== summary.providerId)
          fail('K4-ASSET-STALE-001', 'Asset candidate provider is stale');
        preparation = new AbortController();
        const returned = await options.prepareGeneration(
          Object.freeze({summary, provider, signal: preparation.signal}),
        );
        selected = ownGeneration(returned, summary);
        validatePrepared(returned);
      } catch (error) {
        try {
          await failedPreparation(error, summary, selected);
        } catch (cleanupError) {
          reportError(cleanupError);
        }
        if (disposed || preparationStopped) {
          reportError(error);
          return snapshot();
        }
        status = 'diagnostic';
        await setDiagnostic(
          diagnostic('K4-ASSET-PREPARE-001', 'Asset generation could not be prepared'),
        );
        await publish(
          deepFreeze({
            type: 'preview.asset.prepare-failed',
            revision: summary.revision,
            diagnosticId: 'K4-ASSET-PREPARE-001',
          }),
        );
        return snapshot();
      } finally {
        preparation = null;
      }
      if (disposed || preparationStopped) {
        await releasePrepared(selected, 'transaction-disposed');
        return snapshot();
      }
      candidate = selected;
      status = 'ready';
      await publish(
        deepFreeze({
          type: 'preview.asset.staged',
          revision: summary.revision,
          providerId: summary.providerId,
          classification: summary.classification,
          validations: summary.validations,
        }),
      );
      return snapshot();
    });
  }
  function failClosed(input: unknown) {
    return enqueue(async () => {
      requireActive();
      const summary = validateCandidate(input);
      if (summary.revision <= latestRevision)
        fail('K4-ASSET-STALE-001', 'Asset candidate revision is stale');
      latestRevision = summary.revision;
      if (candidate) {
        await releasePrepared(candidate, 'protocol-fail-closed');
        candidate = null;
      }
      const cleanup = owners.own([
        () => (!disposed ? adapter.discard(summary.revision) : undefined),
      ]);
      await cleanup.release('protocol-fail-closed');
      requireActive();
      status = 'full-rebuild';
      await setDiagnostic(
        diagnostic(
          'K4-ASSET-FULL-REBUILD-REQUIRED',
          'The connected preview does not support transactional asset reload',
        ),
      );
      await publish(
        deepFreeze({
          type: 'preview.asset.full-rebuild',
          revision: summary.revision,
          reason: 'capability-not-negotiated',
          classification: summary.classification,
        }),
      );
      return snapshot();
    });
  }
  function commit(revision: unknown, request: unknown = {}) {
    return enqueue(async () => {
      requireActive();
      const requestedRevision = positiveInteger(revision, 'revision');
      if (!isRecord(request)) throw new TypeError('asset commit request must be an object');
      if (!candidate || candidate.retiring || candidate.summary.revision !== requestedRevision)
        fail('K4-ASSET-STALE-001', 'Asset candidate revision is stale');
      const selected = candidate;
      candidate = null;
      status = 'applying';
      await publish(
        deepFreeze({type: 'preview.asset.commit-started', revision: requestedRevision}),
      );
      let activation;
      try {
        requireActive();
        activation = await selected.prepared.activate(
          Object.freeze({revision: requestedRevision, request}),
        );
        if (!isRecord(activation))
          throw new TypeError('asset generation activation must return an acknowledgement');
        requireActive();
        await adapter.accept(requestedRevision);
        requireActive();
      } catch (error) {
        selected.discard = true;
        let cleanupError: unknown;
        try {
          await releasePrepared(selected, 'activation-failed');
        } catch (failure) {
          cleanupError = failure;
        }
        if (disposed) {
          if (cleanupError)
            throw new AggregateError([error, cleanupError], 'Asset activation rollback failed');
          throw error;
        }
        const code = cleanupError ? 'K4-ASSET-ROLLBACK-001' : 'K4-ASSET-PREPARE-001';
        status = 'diagnostic';
        await setDiagnostic(
          diagnostic(
            code,
            cleanupError
              ? 'Asset activation failed and rollback was incomplete'
              : 'Asset generation activation failed; the previous generation remains active',
          ),
        );
        await publish(
          deepFreeze({
            type: 'preview.asset.commit-failed',
            revision: requestedRevision,
            diagnosticId: code,
          }),
        );
        if (cleanupError)
          throw new AggregateError([error, cleanupError], 'Asset activation rollback failed');
        return snapshot();
      }
      const previous = active;
      generation += 1;
      selected.rollback = false;
      selected.discard = false;
      selected.generation = generation;
      active = selected;
      status = 'active';
      await setDiagnostic(null);
      await publish(
        deepFreeze({
          type: 'preview.asset.committed',
          revision: requestedRevision,
          generation,
          sourceIntegrity: selected.summary.sourceIntegrity,
          graphIntegrity: selected.summary.graphIntegrity,
          contentIntegrity: selected.summary.contentIntegrity,
          activation,
        }),
      );
      if (previous) {
        try {
          await releasePrepared(previous, 'generation-replaced-after-ack');
        } catch {
          if (!disposed) status = 'diagnostic';
          await setDiagnostic(
            diagnostic('K4-ASSET-RELEASE-001', 'Previous asset generation release failed'),
          );
        }
      }
      return snapshot();
    });
  }
  function defer(revision: unknown) {
    return enqueue(async () => {
      requireActive();
      const requestedRevision = positiveInteger(revision, 'revision');
      if (!candidate || candidate.summary.revision !== requestedRevision)
        fail('K4-ASSET-STALE-001', 'Asset candidate revision is stale');
      candidate.discard = true;
      await releasePrepared(candidate, 'candidate-deferred');
      candidate = null;
      if (!disposed) status = active ? 'active' : 'idle';
      await publish(deepFreeze({type: 'preview.asset.deferred', revision: requestedRevision}));
      return snapshot();
    });
  }
  const cleanup = createDsl4RetryableCleanup({
    message: 'Asset reload transaction disposal failed',
    parallel: true,
    steps: [
      () => adapter.beginCleanupAttempt?.(),
      () => {
        preparation?.abort();
      },
      async () => {
        await operationQueue;
        await owners.drain('transaction-disposed');
      },
      {
        run: async () => {
          await operationQueue;
          await adapter.dispose();
        },
        isPending: () => adapter.hasPendingCleanup?.() ?? false,
      },
      () => {
        candidate = null;
        active = null;
        currentDiagnostic = null;
        status = 'disposed';
      },
    ],
  });
  let disposal: Promise<ReturnType<typeof snapshot>> | null = null;
  function dispose() {
    if (disposal) return disposal;
    disposed = true;
    status = 'disposed';
    owners.beginDispose();
    const operation = Promise.resolve()
      .then(() => cleanup.run())
      .then(snapshot);
    disposal = operation;
    observers.close();
    const settled = () => {
      owners.endDispose();
      disposal = null;
    };
    void operation.then(settled, settled);
    return operation;
  }
  return Object.freeze({
    stage,
    failClosed,
    commit,
    defer,
    dispose,
    getState: snapshot,
    stopPreparation() {
      preparationStopped = true;
      preparation?.abort();
    },
    beginCleanupAttempt() {
      owners.beginDispose();
      adapter.beginCleanupAttempt?.();
    },
    hasPendingCleanup: () => owners.hasPendingCleanup() || cleanup.hasPendingCleanup(),
    async whenIdle() {
      await operationQueue;
      return snapshot();
    },
  });
}
