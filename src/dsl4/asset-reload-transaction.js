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
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'Dsl4AssetReloadTransactionError';
    this.code = code;
  }
}

/** @param {string} code @param {string} message @param {unknown} [cause] @returns {never} */
function fail(code, message, cause) {
  throw new Dsl4AssetReloadTransactionError(code, message, cause);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name */
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} name */
function integrity(value, name) {
  if (typeof value !== 'string' || !integrityPattern.test(value)) {
    throw new TypeError(`${name} must be a canonical SHA-256 SRI value`);
  }
  return value;
}

/** @param {unknown} value @param {string} name */
function abbreviatedIntegrity(value, name) {
  if (value === null || value === 'bundle') return value;
  const full = integrity(value, name);
  return `${full.slice(0, 18)}…${full.slice(-8)}`;
}

/** @param {unknown} value */
function validateAssetAdapter(value) {
  if (
    !isRecord(value) ||
    typeof value.getCandidateProvider !== 'function' ||
    typeof value.accept !== 'function' ||
    typeof value.discard !== 'function' ||
    typeof value.dispose !== 'function'
  ) {
    throw new TypeError('asset reload transaction requires an asset adapter');
  }
  return /** @type {Record<string, Function>} */ (value);
}

/** @param {unknown} value */
function validateCandidate(value) {
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

/** @param {unknown} value */
function validatePrepared(value) {
  if (
    !isRecord(value) ||
    typeof value.activate !== 'function' ||
    typeof value.rollback !== 'function' ||
    typeof value.release !== 'function'
  ) {
    throw new TypeError('prepared asset generation must provide activate, rollback, and release');
  }
  return /** @type {Record<string, Function>} */ (value);
}

/** @param {string} code @param {string} message */
function diagnostic(code, message) {
  return deepFreeze({formatVersion: 1, code, severity: 'error', message});
}

/**
 * Prepare, activate, acknowledge, and release complete source-plus-asset generations in order.
 * Platform code supplies the safe-boundary and generation-specific runtime implementation.
 *
 * @param {object} options
 * @param {Record<string, Function>} options.assetAdapter
 * @param {(input: Readonly<{summary: Readonly<Record<string, unknown>>, provider: Readonly<Record<string, unknown>>, signal: AbortSignal}>) => unknown | Promise<unknown>} options.prepareGeneration
 * @param {(event: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>} [options.onEvent]
 * @param {(diagnostic: Readonly<Record<string, unknown>> | null) => unknown | Promise<unknown>} [options.onDiagnostic]
 * @param {(error: unknown) => unknown} [options.onError]
 */
export function createDsl4AssetReloadTransaction(options) {
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
  /** @type {'idle' | 'preparing' | 'ready' | 'applying' | 'active' | 'diagnostic' | 'full-rebuild' | 'disposed'} */
  let status = 'idle';
  let latestRevision = 0;
  let generation = 0;
  /** @type {{summary: Readonly<Record<string, any>>, prepared: Record<string, Function>} | null} */
  let candidate = null;
  /** @type {{summary: Readonly<Record<string, any>>, prepared: Record<string, Function>, generation: number, acknowledgement: Readonly<Record<string, unknown>>} | null} */
  let active = null;
  const pendingReleases = new Set();
  /** @type {Readonly<Record<string, unknown>> | null} */
  let currentDiagnostic = null;
  /** @type {Readonly<Record<string, unknown>> | null} */
  let lastEvent = null;
  let operationQueue = Promise.resolve();

  /** @param {unknown} error */
  function reportError(error) {
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

  /** @param {() => unknown | Promise<unknown>} operation */
  function enqueue(operation) {
    const result = operationQueue.then(operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** @param {Readonly<Record<string, unknown>>} event */
  async function publish(event) {
    lastEvent = event;
    try {
      await options.onEvent?.(event);
    } catch (error) {
      reportError(error);
    }
  }

  /** @param {Readonly<Record<string, unknown>> | null} value */
  async function setDiagnostic(value) {
    currentDiagnostic = value;
    try {
      await options.onDiagnostic?.(value);
    } catch (error) {
      reportError(error);
    }
  }

  /** @param {{prepared: Record<string, Function>} | null} value @param {string} reason */
  async function releasePrepared(value, reason) {
    if (!value) return;
    await value.prepared.release(reason);
  }

  /** @param {{summary: Readonly<Record<string, any>>, prepared: Record<string, Function>} | null} value @param {string} reason */
  async function discardPrepared(value, reason) {
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

  /** @param {unknown} input */
  function stage(input) {
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

  /** @param {unknown} input Fail closed without preparing when capabilities are incomplete. */
  function failClosed(input) {
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

  /** @param {number} revision @param {Readonly<Record<string, unknown>>} [request] */
  function commit(revision, request = {}) {
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

  /** @param {number} revision */
  function defer(revision) {
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
