import {dsl4PreviewSourceGenerationWireDefaults} from '../dsl4/preview-source-generation-wire.js';
import {
  dsl4BrowserTurboWarpStageDefaults,
  dsl4BrowserTurboWarpStageMaximumProjectBytes,
} from '../dsl4/browser-turbowarp-stage.js';
import {deepFreeze} from '../dsl4/story-document.js';
import {createDsl4LocalPreviewBrowserRuntime} from './dsl4-local-preview-browser-runtime.js';
import {createDsl4CliPreviewShell} from './dsl4-preview-shell.js';

const restartChoiceNames = Object.freeze({
  story: 'storyStart',
  scene: 'currentScene',
  action: 'currentAction',
});
const missingCodes = new Set(['K4-SOURCE-MISSING']);

export const dsl4LocalPreviewBrowserClientDefaults = deepFreeze({
  maxProjectBytes: dsl4BrowserTurboWarpStageDefaults.maxProjectBytes,
  maxGenerationMessageBytes: dsl4PreviewSourceGenerationWireDefaults.maxMessageBytes,
  maxPendingRecords: 64,
  maxPendingCharacters: 32 * 1024 * 1024,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, name: string, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new TypeError(`${name} must be a safe integer between 1 and ${maximum}`);
  }
  return Number(value);
}

function safeMessage(value: unknown) {
  const message = String(value ?? 'Local preview status changed')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .trim();
  return (message || 'Local preview status changed').slice(0, 500);
}

function reloadAvailability(choices: unknown) {
  if (!isRecord(choices)) throw new TypeError('Preview reload choices are invalid');
  function option(value: unknown, fallback: string) {
    if (!isRecord(value) || typeof value.enabled !== 'boolean') {
      throw new TypeError('Preview reload choice is invalid');
    }
    return {
      available: value.enabled,
      reason: value.enabled ? null : safeMessage(value.reason ?? fallback).slice(0, 300),
    };
  }
  const story = option(choices.storyStart, 'The story start is unavailable.');
  const scene = option(choices.currentScene, 'The current scene is unavailable.');
  const action = option(choices.currentAction, 'The current action is unavailable.');
  return {story, scene, action: {...action, replaySafe: action.available}};
}

function legacyChoice(value: unknown, fallback: string) {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') {
    throw new TypeError('Preview reload choice is invalid');
  }
  return {
    enabled: value.enabled,
    reason: value.enabled ? null : safeMessage(value.reason ?? fallback).slice(0, 300),
  };
}

function restartChoice(anchor: unknown) {
  if (anchor !== 'story' && anchor !== 'scene' && anchor !== 'action') {
    throw new TypeError('Preview reload anchor is invalid');
  }
  return restartChoiceNames[anchor];
}

/** Connect one authenticated browser page to the browser-owned preview runtime and shared overlay. */
export function createDsl4LocalPreviewBrowserClient(optionsInput: object) {
  if (!isRecord(optionsInput)) {
    throw new TypeError('local preview browser client options are required');
  }
  const options = optionsInput as Record<string, any>;
  const documentCandidate = isRecord(options.document) ? options.document : null;
  const locationCandidate = isRecord(options.location) ? options.location : null;
  const historyCandidate = isRecord(options.history) ? options.history : null;
  const eventTargetCandidate = isRecord(options.eventTarget) ? options.eventTarget : null;
  if (
    !documentCandidate ||
    typeof documentCandidate.querySelector !== 'function' ||
    !locationCandidate ||
    !historyCandidate
  ) {
    throw new TypeError('document, location, and history browser boundaries are required');
  }
  if (
    typeof historyCandidate.replaceState !== 'function' ||
    typeof eventTargetCandidate?.addEventListener !== 'function' ||
    typeof eventTargetCandidate?.removeEventListener !== 'function'
  ) {
    throw new TypeError('history and eventTarget must provide browser lifecycle methods');
  }
  const document = documentCandidate as Record<string, any>;
  const location = locationCandidate as Record<string, any>;
  const history = historyCandidate as Record<string, any>;
  const eventTarget = eventTargetCandidate as Record<string, any>;
  const fetchRequest = options.fetch ?? globalThis.fetch;
  if (typeof fetchRequest !== 'function') throw new TypeError('fetch must be a function');
  if (!isRecord(options.sourceFrontend) || typeof options.sourceFrontend.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse');
  }
  if (!isRecord(options.platform)) throw new TypeError('platform must be an object');
  if (!isRecord(options.runtimeOptions)) throw new TypeError('runtimeOptions must be an object');
  const createRuntime = options.createRuntime ?? createDsl4LocalPreviewBrowserRuntime;
  const createShell = options.createShell ?? createDsl4CliPreviewShell;
  if (typeof createRuntime !== 'function') throw new TypeError('createRuntime must be a function');
  if (typeof createShell !== 'function') throw new TypeError('createShell must be a function');
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new TypeError('onError must be a function when provided');
  }
  if (options.onRuntimeEvent !== undefined && typeof options.onRuntimeEvent !== 'function') {
    throw new TypeError('onRuntimeEvent must be a function when provided');
  }
  if (options.onApplicationOpen !== undefined && typeof options.onApplicationOpen !== 'function') {
    throw new TypeError('onApplicationOpen must be a function when provided');
  }
  const maxProjectBytes = boundedInteger(
    options.maxProjectBytes ?? dsl4LocalPreviewBrowserClientDefaults.maxProjectBytes,
    'maxProjectBytes',
    dsl4BrowserTurboWarpStageMaximumProjectBytes,
  );
  const maxGenerationMessageBytes = boundedInteger(
    options.maxGenerationMessageBytes ??
      dsl4LocalPreviewBrowserClientDefaults.maxGenerationMessageBytes,
    'maxGenerationMessageBytes',
    16 * 1024 * 1024,
  );
  const maxPendingRecords = boundedInteger(
    options.maxPendingRecords ?? dsl4LocalPreviewBrowserClientDefaults.maxPendingRecords,
    'maxPendingRecords',
    256,
  );
  const maxPendingCharacters = boundedInteger(
    options.maxPendingCharacters ?? dsl4LocalPreviewBrowserClientDefaults.maxPendingCharacters,
    'maxPendingCharacters',
    64 * 1024 * 1024,
  );
  const mountCandidate = document.querySelector('#dsl4-local-preview-runtime');
  if (!isRecord(mountCandidate)) throw new TypeError('The local preview runtime mount is missing');
  const mount = mountCandidate as Record<string, any>;
  const sourceName = document.querySelector('#dsl4-local-preview-source-name')?.textContent;
  const sourceDisplayName =
    typeof sourceName === 'string' && sourceName.length > 0 ? sourceName : 'story.k4.yml';
  let bearerToken = String(location.hash ?? '').slice(1);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(bearerToken)) {
    throw new TypeError('The local preview launch token is missing or invalid');
  }
  history.replaceState(
    null,
    '',
    `${String(location.pathname ?? '/')}${String(location.search ?? '')}`,
  );

  let status = 'idle';
  let disposed = false;
  let runtimeReady = false;
  let streamDisconnected = false;
  let latestSequence = 0;
  let pendingCharacters = 0;
  const pendingRecords: Array<{record: Record<string, any>; characters: number}> = [];
  const acknowledgements: Map<number, Record<string, any>> = new Map();
  let activeDetails: {
    integrity: string;
    counts: Record<string, number>;
    warningCount: number;
  } | null = null;
  let candidateDetails: {
    integrity: string;
    counts: Record<string, number>;
    warningCount: number;
  } | null = null;
  let runtime: ReturnType<typeof createDsl4LocalPreviewBrowserRuntime> | null = null;
  const lifecycleController = new AbortController();
  let streamController: AbortController | null = null;
  let streamReader: ReadableStreamDefaultReader<string> | null = null;
  let streamCompletion: Promise<void> | null = null;
  let drainPromise: Promise<void> | null = null;
  let processingFailure: unknown = null;
  let startPromise: Promise<Readonly<Record<string, unknown>>> | null = null;
  let disposePromise: Promise<Readonly<Record<string, unknown>>> | null = null;
  let errorAlert: Record<string, any> | null = null;

  const shell = createShell({
    environment: 'development',
    document,
    mount,
    featureFlags: {
      dsl4Runtime: true,
      dsl4AppShell: true,
      dsl4PreviewReloadOverlay: true,
    },
    onError: reportError,
  });

  function reportError(error: unknown) {
    const message = safeMessage(error instanceof Error ? error.message : error);
    try {
      options.onError?.(error);
    } catch {
      // Error observers cannot change browser client ownership.
    }
    if (!errorAlert) {
      const alert = document.createElement?.('p');
      if (isRecord(alert)) {
        errorAlert = alert as Record<string, any>;
        errorAlert.setAttribute?.('role', 'alert');
        mount.appendChild?.(errorAlert);
      }
    }
    if (errorAlert) errorAlert.textContent = message;
  }

  function snapshot() {
    return deepFreeze({
      version: 1,
      status,
      disposed,
      latestSequence,
      pendingRecords: pendingRecords.length,
      pendingCharacters,
      runtime: runtime?.getState() ?? null,
      shell: shell.getSnapshot(),
    });
  }

  function ensureActive() {
    if (!disposed && !lifecycleController.signal.aborted) return;
    const error = new Error('Local preview browser client startup was aborted');
    error.name = 'AbortError';
    throw error;
  }

  async function post(endpoint: string, body: unknown, authorize: boolean = true) {
    const response = await fetchRequest(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorize ? {authorization: `Bearer ${bearerToken}`} : {}),
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
      signal: lifecycleController.signal,
    });
    let result = null;
    try {
      result = await response.json();
    } catch {
      // The status-specific redacted fallback below remains authoritative.
    }
    if (!response.ok) {
      throw new Error(
        safeMessage(result?.error?.message ?? result?.error?.code ?? 'Preview request failed'),
      );
    }
    if (!isRecord(result)) throw new TypeError('Preview response must contain a JSON object');
    return result;
  }

  async function fetchProject() {
    const response = await fetchRequest('/api/runtime-project', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearerToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
      cache: 'no-store',
      credentials: 'same-origin',
      signal: lifecycleController.signal,
    });
    if (!response.ok) throw new Error('The preview runtime project could not be loaded');
    const declaredLength = Number(response.headers.get('content-length'));
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 1 ||
      declaredLength > maxProjectBytes
    ) {
      throw new TypeError('The preview runtime project Content-Length is invalid');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== declaredLength) {
      bytes.fill(0);
      throw new TypeError('The preview runtime project length changed during transfer');
    }
    return bytes;
  }

  function renderCommitted(acknowledgement: Record<string, any>) {
    activeDetails = candidateDetails ?? activeDetails;
    candidateDetails = null;
    if (!activeDetails || !acknowledgement?.current?.integrity) return;
    shell.update({
      formatVersion: 1,
      phase: 'running',
      sourceDisplayName,
      currentIntegrity: acknowledgement.current.integrity,
      candidateIntegrity: null,
      validationStatus: 'valid',
      counts: activeDetails.counts,
      anchor: null,
      choices: null,
      warningCount: activeDetails.warningCount,
      changeCategories: [],
      safeStatusMessage: 'The selected source revision is running.',
    });
  }

  async function renderSource(source: Record<string, any>, acknowledgement: Record<string, any>) {
    const diagnostics = Array.isArray(source.diagnostics) ? source.diagnostics : [];
    const blocking = diagnostics.find(
      (diagnostic) => isRecord(diagnostic) && diagnostic.severity === 'error',
    );
    if (blocking || !source.ok) {
      const diagnostic = blocking ??
        diagnostics[0] ?? {
          code: 'K4-PREVIEW-SOURCE-INVALID',
          severity: 'error',
          message: 'The source is invalid.',
        };
      await shell.setReloadDiagnostic('source', diagnostic);
      shell.update({
        formatVersion: 1,
        phase: 'invalid',
        sourceDisplayName,
        currentIntegrity: acknowledgement.current?.integrity ?? activeDetails?.integrity ?? null,
        candidateIntegrity: null,
        validationStatus: missingCodes.has(diagnostic.code) ? 'missing' : 'invalid',
        counts: null,
        anchor: null,
        choices: null,
        warningCount: diagnostics.filter((item) => item?.severity === 'warning').length,
        changeCategories: [],
        safeStatusMessage: safeMessage(`${diagnostic.code}: ${diagnostic.message}`),
      });
      return;
    }

    await shell.setReloadDiagnostic('source', null);
    const details = {
      integrity: source.integrity,
      counts: source.counts,
      warningCount: diagnostics.filter((diagnostic) => diagnostic?.severity === 'warning').length,
    };
    if (acknowledgement.candidate) {
      candidateDetails = details;
      const choices = acknowledgement.candidate.options;
      shell.update({
        formatVersion: 1,
        phase: 'candidate',
        sourceDisplayName,
        currentIntegrity: acknowledgement.current?.integrity ?? activeDetails?.integrity ?? null,
        candidateIntegrity: details.integrity,
        validationStatus: 'valid',
        counts: details.counts,
        anchor: null,
        choices: {
          1: legacyChoice(choices.storyStart, 'The story start is unavailable.'),
          2: legacyChoice(choices.currentScene, 'The current scene is unavailable.'),
          3: legacyChoice(choices.currentAction, 'The current action is unavailable.'),
        },
        warningCount: details.warningCount,
        changeCategories: ['source'],
        safeStatusMessage: 'A valid source change is ready and will be applied automatically.',
      });
      await shell.submitReloadCandidate({
        channel: 'source',
        channelRevision: acknowledgement.revision,
        availability: reloadAvailability(choices),
        changedIds: ['source-generation'],
        initiatingInputId: null,
        async apply(request: Readonly<Record<string, any>>) {
          const committed = await runtime?.commit(restartChoice(request.actualAnchor));
          if (committed) renderCommitted(committed);
        },
        async restart(request: Readonly<Record<string, any>>) {
          const committed = await runtime?.restart(restartChoice(request.actualAnchor));
          if (committed) renderCommitted(committed);
        },
      });
      return;
    }

    if (acknowledgement.current?.integrity) {
      activeDetails = details;
      candidateDetails = null;
      shell.update({
        formatVersion: 1,
        phase: 'running',
        sourceDisplayName,
        currentIntegrity: acknowledgement.current.integrity,
        candidateIntegrity: null,
        validationStatus: 'valid',
        counts: details.counts,
        anchor: null,
        choices: null,
        warningCount: details.warningCount,
        changeCategories: [],
        safeStatusMessage: 'The current immutable source is running.',
      });
    }
  }

  async function applyRecord(record: Record<string, any>) {
    if (record.type === 'local-preview.generation') {
      const revision = record.generation?.revision;
      if (!Number.isSafeInteger(revision) || Number(revision) < 1 || !runtime) {
        throw new TypeError('Preview generation record revision is invalid');
      }
      const acknowledgement = await runtime.accept(record);
      acknowledgements.set(Number(revision), acknowledgement);
      while (acknowledgements.size > 4) {
        const oldestRevision = acknowledgements.keys().next().value;
        if (oldestRevision === undefined) break;
        acknowledgements.delete(oldestRevision);
      }
      return;
    }
    if (record.type === 'local-preview.source') {
      if (!Number.isSafeInteger(record.generationRevision)) {
        throw new TypeError('Preview source summary revision is invalid');
      }
      const acknowledgement = acknowledgements.get(record.generationRevision);
      if (!acknowledgement) return;
      acknowledgements.delete(record.generationRevision);
      await renderSource(record.source, acknowledgement);
      return;
    }
    if (record.type === 'local-preview.full-rebuild-required') {
      await shell.setReloadWatchState('source', 'paused');
      await shell.setReloadDiagnostic('source', record.diagnostic);
      return;
    }
    if (record.type === 'local-preview.transport-disconnected') {
      await shell.setReloadWatchState('source', 'disconnected');
    }
  }

  function scheduleDrain() {
    if (!runtimeReady || drainPromise || disposed) return drainPromise;
    drainPromise = (async () => {
      while (!disposed && pendingRecords.length > 0) {
        const next = pendingRecords.shift();
        if (!next) break;
        pendingCharacters -= next.characters;
        await applyRecord(next.record);
      }
    })()
      .catch(async (error) => {
        processingFailure = error;
        status = 'failed';
        reportError(error);
        try {
          await shell.setReloadWatchState('source', 'disconnected');
        } catch {
          // The visible runtime error remains authoritative.
        }
        streamController?.abort();
      })
      .finally(() => {
        drainPromise = null;
        if (runtimeReady && pendingRecords.length > 0 && !disposed && !processingFailure) {
          scheduleDrain();
        }
      });
    return drainPromise;
  }

  function ingestRecord(input: unknown, characters: number) {
    if (!isRecord(input) || !Number.isSafeInteger(input.sequence) || Number(input.sequence) < 1) {
      throw new TypeError('Preview event record sequence is invalid');
    }
    const sequence = Number(input.sequence);
    if (sequence <= latestSequence) return;
    if (
      !Number.isSafeInteger(characters) ||
      characters < 1 ||
      pendingRecords.length >= maxPendingRecords ||
      pendingCharacters + characters > maxPendingCharacters
    ) {
      throw new TypeError('Preview startup event queue exceeds its configured limit');
    }
    latestSequence = sequence;
    pendingRecords.push({record: input as Record<string, any>, characters});
    pendingCharacters += characters;
    scheduleDrain();
  }

  async function openEventStream() {
    streamController = new AbortController();
    const response = await fetchRequest('/api/events', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({after: latestSequence}),
      cache: 'no-store',
      credentials: 'same-origin',
      signal: streamController.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error('The preview event stream could not start');
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('application/x-ndjson')) {
      throw new TypeError('The preview event stream Content-Type is invalid');
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    streamReader = reader;
    streamCompletion = (async () => {
      let buffered = '';
      while (!disposed) {
        const {done, value} = await reader.read();
        if (done) break;
        buffered += value;
        if (buffered.length > maxPendingCharacters) {
          throw new TypeError('Preview event line exceeds its configured limit');
        }
        let newline = buffered.indexOf('\n');
        while (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line) ingestRecord(JSON.parse(line), line.length);
          newline = buffered.indexOf('\n');
        }
      }
      if (!disposed && buffered.length > 0) {
        throw new TypeError('Preview event stream ended with a partial record');
      }
      if (!disposed) {
        streamDisconnected = true;
        status = 'disconnected';
        await shell.setReloadWatchState('source', 'disconnected');
      }
    })().catch(async (error) => {
      if (disposed || error?.name === 'AbortError') return;
      streamDisconnected = true;
      status = 'disconnected';
      reportError(error);
      try {
        await shell.setReloadWatchState('source', 'disconnected');
      } catch {
        // The visible transport error remains authoritative.
      }
    });
  }

  async function waitForDrain() {
    while (drainPromise) await drainPromise;
    if (processingFailure) throw processingFailure;
  }

  function start() {
    if (disposed) throw new TypeError('local preview browser client is disposed');
    if (startPromise) return startPromise;
    status = 'starting';
    startPromise = (async () => {
      ensureActive();
      await shell.setReloadWatchState('source', 'stabilizing');
      ensureActive();
      const connected = await post('/api/connect', {token: bearerToken}, false);
      ensureActive();
      const connectedEvents = Array.isArray(connected.events) ? connected.events : [];
      for (const event of connectedEvents) {
        const characters = JSON.stringify(event).length;
        ingestRecord(event, characters);
      }
      await openEventStream();
      ensureActive();
      const projectBytes = await fetchProject();
      let activeRuntime: ReturnType<typeof createDsl4LocalPreviewBrowserRuntime>;
      try {
        ensureActive();
        activeRuntime = createRuntime({
          projectBytes,
          sourceFrontend: options.sourceFrontend,
          document,
          mount,
          platform: options.platform,
          runtimeOptions: options.runtimeOptions,
          sessionId: options.sessionId,
          featureFlags: options.featureFlags,
          maxProjectBytes,
          maxProjectJsonBytes: options.maxProjectJsonBytes,
          maxGenerationMessageBytes,
          maxSourceBytes: options.maxSourceBytes,
          maxAssetFiles: options.maxAssetFiles,
          maxAssetBytes: options.maxAssetBytes,
          historyNavigationAvailable: options.historyNavigationAvailable,
          subtleCrypto: options.subtleCrypto,
          onApplicationOpen: options.onApplicationOpen,
          onRuntimeEvent: options.onRuntimeEvent,
          onError: reportError,
        });
        runtime = activeRuntime;
      } finally {
        projectBytes.fill(0);
      }
      await activeRuntime.start();
      ensureActive();
      runtimeReady = true;
      scheduleDrain();
      await waitForDrain();
      ensureActive();
      if (streamDisconnected) {
        throw new Error('The preview event stream disconnected during startup');
      }
      await shell.setReloadWatchState('source', 'watching');
      status = 'running';
      await post('/api/runtime-ready', {version: 1});
      ensureActive();
      return snapshot();
    })().catch(async (error) => {
      const stoppedByDisposal = disposed || lifecycleController.signal.aborted;
      if (!stoppedByDisposal) {
        status = 'failed';
        reportError(error);
      }
      streamController?.abort();
      try {
        await runtime?.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Local preview browser client startup and cleanup failed',
        );
      }
      runtime = null;
      throw error;
    });
    return startPromise;
  }

  function handlePageHide() {
    void dispose();
  }
  eventTarget.addEventListener('pagehide', handlePageHide, {once: true});

  function dispose() {
    if (disposePromise) return disposePromise;
    if (disposed) return Promise.resolve(snapshot());
    disposed = true;
    status = 'disposing';
    eventTarget.removeEventListener('pagehide', handlePageHide);
    lifecycleController.abort();
    streamController?.abort();
    void streamReader?.cancel().catch(() => {});
    disposePromise = (async () => {
      const errors = [];
      try {
        await streamCompletion;
      } catch (error) {
        errors.push(error);
      }
      try {
        await runtime?.dispose();
      } catch (error) {
        errors.push(error);
      }
      runtime = null;
      try {
        await shell.dispose();
      } catch (error) {
        errors.push(error);
      }
      errorAlert?.remove?.();
      errorAlert = null;
      pendingRecords.splice(0);
      pendingCharacters = 0;
      acknowledgements.clear();
      activeDetails = null;
      candidateDetails = null;
      bearerToken = '';
      status = 'disposed';
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Local preview browser client cleanup failed');
      }
      return snapshot();
    })();
    return disposePromise;
  }

  return Object.freeze({start, dispose, getState: snapshot});
}
