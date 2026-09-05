import {deepFreeze} from './story-document.js';

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
  let status:
    | 'idle'
    | 'preparing'
    | 'ready'
    | 'applying'
    | 'active'
    | 'diagnostic'
    | 'full-rebuild'
    | 'disposed' = 'idle';
  let latestRevision = 0;
  let generation = 0;
  let candidate: {
    summary: Readonly<Record<string, any>>;
    prepared: PreparedAssetGeneration;
  } | null = null;
  let active: {
    summary: Readonly<Record<string, any>>;
    prepared: PreparedAssetGeneration;
    generation: number;
    acknowledgement: Readonly<Record<string, unknown>>;
  } | null = null;
  const pendingReleases = new Set<{prepared: PreparedAssetGeneration} | null>();
  let currentDiagnostic: Readonly<Record<string, unknown>> | null = null;
  let lastEvent: Readonly<Record<string, unknown>> | null = null;
  let operationQueue = Promise.resolve();

  function reportError(error: unknown) {
    try {
      options.onError?.(error);
    } catch {
      // Error observers cannot change transaction state.
    }
  }

  function snapshot() {
    return deepFreeze({
      version: 1,
      status,
      disposed,
      latestRevision,
      generation,
      pendingReleaseCount: pendingReleases.size,
      active: active
        ? {
            revision: active.summary.revision,
            providerId: active.summary.providerId,
            sourceIntegrity: active.summary.sourceIntegrity,
            graphIntegrity: active.summary.graphIntegrity,
            contentIntegrity: active.summary.contentIntegrity,
            generation: active.generation,
          }
        : null,
      candidate: candidate
        ? {
            revision: candidate.summary.revision,
            providerId: candidate.summary.providerId,
            classification: candidate.summary.classification,
          }
        : null,
      diagnostic: currentDiagnostic,
      lastEvent,
    });
  }

  function enqueue(operation: () => unknown | Promise<unknown>) {
    const result = operationQueue.then(operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function publish(event: Readonly<Record<string, unknown>>) {
    lastEvent = event;
    try {
      await options.onEvent?.(event);
    } catch (error) {
      reportError(error);
    }
  }

  async function setDiagnostic(value: Readonly<Record<string, unknown>> | null) {
    currentDiagnostic = value;
    try {
      await options.onDiagnostic?.(value);
    } catch (error) {
      reportError(error);
    }
  }

  async function releasePrepared(
    value: {prepared: PreparedAssetGeneration} | null,
    reason: string,
  ) {
    if (!value) return;
    await value.prepared.release(reason);
  }

  async function discardPrepared(
    value: {summary: Readonly<Record<string, any>>; prepared: PreparedAssetGeneration} | null,
    reason: string,
  ) {
    if (!value) return;
    const errors = [];
    try {
      await value.prepared.rollback(reason);
    } catch (error) {
      errors.push(error);
    }
    try {
      await value.prepared.release(reason);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Asset candidate cleanup failed');
  }

  function stage(input: unknown) {
    return enqueue(async () => {
      if (disposed) throw new TypeError('asset reload transaction is disposed');
      const summary = validateCandidate(input);
      if (summary.revision <= latestRevision) {
        fail('K4-ASSET-STALE-001', 'Asset candidate revision is stale');
      }
      latestRevision = summary.revision;
      if (candidate) {
        await discardPrepared(candidate, 'candidate-superseded');
        candidate = null;
      }
      if (
        summary.classification.kind === 'full-rebuild' ||
        summary.classification.requiresFullRebuild
      ) {
        await adapter.discard(summary.revision);
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
      let prepared;
      try {
        const provider = adapter.getCandidateProvider(summary.revision);
        if (!isRecord(provider) || provider.providerId !== summary.providerId) {
          fail('K4-ASSET-STALE-001', 'Asset candidate provider is stale');
        }
        prepared = validatePrepared(
          await options.prepareGeneration(
            Object.freeze({summary, provider, signal: new AbortController().signal}),
          ),
        );
      } catch {
        try {
          await adapter.discard(summary.revision);
        } catch {
          // The fixed prepare diagnostic remains authoritative.
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
      }
      candidate = {summary, prepared};
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

  /** Fail closed without preparing when capabilities are incomplete. */
  function failClosed(input: unknown) {
    return enqueue(async () => {
      if (disposed) throw new TypeError('asset reload transaction is disposed');
      const summary = validateCandidate(input);
      if (summary.revision <= latestRevision) {
        fail('K4-ASSET-STALE-001', 'Asset candidate revision is stale');
      }
      latestRevision = summary.revision;
      if (candidate) {
        await discardPrepared(candidate, 'protocol-fail-closed');
        candidate = null;
      }
      await adapter.discard(summary.revision);
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

  function commit(revision: number, request: Readonly<Record<string, unknown>> = {}) {
    return enqueue(async () => {
      if (disposed) throw new TypeError('asset reload transaction is disposed');
      const requestedRevision = positiveInteger(revision, 'revision');
      if (!isRecord(request)) throw new TypeError('asset commit request must be an object');
      if (!candidate || candidate.summary.revision !== requestedRevision) {
        fail('K4-ASSET-STALE-001', 'Asset candidate revision is stale');
      }
      const selected = candidate;
      candidate = null;
      status = 'applying';
      await publish(
        deepFreeze({type: 'preview.asset.commit-started', revision: requestedRevision}),
      );
      let activation;
      try {
        activation = await selected.prepared.activate(
          Object.freeze({revision: requestedRevision, request}),
        );
        if (!isRecord(activation)) {
          throw new TypeError('asset generation activation must return an acknowledgement');
        }
        await adapter.accept(requestedRevision);
      } catch (error) {
        const cleanupErrors = [];
        try {
          await selected.prepared.rollback('activation-failed');
        } catch (rollbackError) {
          cleanupErrors.push(rollbackError);
        }
        try {
          await selected.prepared.release('activation-failed');
        } catch (releaseError) {
          cleanupErrors.push(releaseError);
        }
        try {
          await adapter.discard(requestedRevision);
        } catch {
          // The adapter may already have rejected or released the candidate.
        }
        const code = cleanupErrors.length > 0 ? 'K4-ASSET-ROLLBACK-001' : 'K4-ASSET-PREPARE-001';
        status = 'diagnostic';
        await setDiagnostic(
          diagnostic(
            code,
            cleanupErrors.length > 0
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
        if (cleanupErrors.length > 0) {
          throw new AggregateError([error, ...cleanupErrors], 'Asset activation rollback failed');
        }
        return snapshot();
      }

      const previous = active;
      generation += 1;
      const acknowledgement = deepFreeze({
        type: 'preview.asset.committed',
        revision: requestedRevision,
        generation,
        sourceIntegrity: selected.summary.sourceIntegrity,
        graphIntegrity: selected.summary.graphIntegrity,
        contentIntegrity: selected.summary.contentIntegrity,
        activation,
      });
      active = {
        summary: selected.summary,
        prepared: selected.prepared,
        generation,
        acknowledgement,
      };
      status = 'active';
      await setDiagnostic(null);
      await publish(acknowledgement);
      if (previous) {
        try {
          await releasePrepared(previous, 'generation-replaced-after-ack');
        } catch {
          pendingReleases.add(previous);
          status = 'diagnostic';
          await setDiagnostic(
            diagnostic('K4-ASSET-RELEASE-001', 'Previous asset generation release failed'),
          );
        }
      }
      return snapshot();
    });
  }

  function defer(revision: number) {
    return enqueue(async () => {
      if (disposed) throw new TypeError('asset reload transaction is disposed');
      const requestedRevision = positiveInteger(revision, 'revision');
      if (!candidate || candidate.summary.revision !== requestedRevision) {
        fail('K4-ASSET-STALE-001', 'Asset candidate revision is stale');
      }
      const selected = candidate;
      candidate = null;
      await discardPrepared(selected, 'candidate-deferred');
      await adapter.discard(requestedRevision);
      status = active ? 'active' : 'idle';
      await publish(deepFreeze({type: 'preview.asset.deferred', revision: requestedRevision}));
      return snapshot();
    });
  }

  function dispose() {
    return enqueue(async () => {
      if (disposed) return snapshot();
      disposed = true;
      const errors = [];
      try {
        await discardPrepared(candidate, 'transaction-disposed');
      } catch (error) {
        errors.push(error);
      }
      try {
        await releasePrepared(active, 'transaction-disposed');
      } catch (error) {
        errors.push(error);
      }
      for (const pending of pendingReleases) {
        try {
          await releasePrepared(pending, 'transaction-disposed-retry');
          pendingReleases.delete(pending);
        } catch (error) {
          errors.push(error);
        }
      }
      candidate = null;
      active = null;
      try {
        await adapter.dispose();
      } catch (error) {
        errors.push(error);
      }
      currentDiagnostic = null;
      status = 'disposed';
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Asset reload transaction disposal failed');
      }
      return snapshot();
    });
  }

  return Object.freeze({
    stage,
    failClosed,
    commit,
    defer,
    dispose,
    getState: snapshot,
    async whenIdle() {
      await operationQueue;
      return snapshot();
    },
  });
}
