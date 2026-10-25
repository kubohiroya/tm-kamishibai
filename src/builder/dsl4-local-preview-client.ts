import {createDsl4CliPreviewShell} from './dsl4-preview-shell.js';
import {createDsl4RetryableCleanup} from '../dsl4/retryable-cleanup.js';
import {createDsl4AssetObserverWaits} from '../dsl4/asset-cleanup-owners.js';

const restartChoiceNames = Object.freeze({
  story: 'storyStart',
  scene: 'currentScene',
  action: 'currentAction',
});
const missingCodes = new Set(['K4-SOURCE-MISSING']);
const browserDocument = globalThis.document;
const browserLocation = globalThis.location;
const browserHistory = globalThis.history;
const mount = browserDocument.querySelector('#dsl4-local-preview-runtime');
const sourceName = browserDocument.querySelector('#dsl4-local-preview-source-name')?.textContent;
const sourceDisplayName =
  typeof sourceName === 'string' && sourceName.length > 0 ? sourceName : 'story.kamishibai.yaml';
const token = browserLocation.hash.slice(1);

if (!mount) throw new Error('The local preview mount is missing.');
const previewMount = mount;
if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
  throw new Error('The local preview launch token is missing or invalid. Restart the CLI host.');
}
browserHistory.replaceState(null, '', `${browserLocation.pathname}${browserLocation.search}`);

let disposed = false;
let latestSequence = 0;
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
let streamController: AbortController | null = null;
let streamReader: ReadableStreamDefaultReader<string> | null = null;
let streamBody: ReadableStream<Uint8Array> | null = null;
let startup: Promise<void> | null = null;
const lifecycle = new AbortController();

const shell = createDsl4CliPreviewShell({
  environment: 'development',
  document: browserDocument,
  mount: previewMount,
  featureFlags: {
    dsl4Runtime: true,
    dsl4AppShell: true,
    dsl4PreviewReloadOverlay: true,
  },
  onError: reportError,
});

const observers = createDsl4AssetObserverWaits(reportError);
function notifyWatch(...args: Parameters<typeof shell.setReloadWatchState>) {
  if (disposed) return Promise.resolve();
  return observers.wait(() => shell.setReloadWatchState(...args));
}
function notifyDiagnostic(...args: Parameters<typeof shell.setReloadDiagnostic>) {
  if (disposed) return Promise.resolve();
  return observers.wait(() => shell.setReloadDiagnostic(...args));
}
function notifyCandidate(...args: Parameters<typeof shell.submitReloadCandidate>) {
  if (disposed) return Promise.resolve();
  return observers.wait(() => shell.submitReloadCandidate(...args));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeMessage(value: unknown) {
  const message = String(value ?? 'Local preview status changed')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .trim();
  return (message || 'Local preview status changed').slice(0, 500);
}

function reportError(error: unknown) {
  if (disposed) {
    console.error('Local preview cleanup failed', error);
    return;
  }
  const message = safeMessage(error instanceof Error ? error.message : error);
  const status = browserDocument.createElement('p');
  status.setAttribute('role', 'alert');
  status.textContent = message;
  previewMount.appendChild(status);
}

async function post(endpoint: string, body: unknown, authorize: boolean = true) {
  const response = await globalThis.fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorize ? {authorization: `Bearer ${token}`} : {}),
    },
    body: JSON.stringify(body),
    cache: 'no-store',
    credentials: 'same-origin',
    signal: lifecycle.signal,
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(safeMessage(result?.error?.message ?? result?.error?.code ?? 'Preview failed'));
  }
  return result;
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

/** One event the local preview host streams to this client. */
interface Dsl4PreviewClientEvent extends Readonly<Record<string, unknown>> {
  readonly sequence?: unknown;
  readonly type?: unknown;
  readonly event?: Dsl4PreviewAcknowledgement & {type?: unknown};
}

/** One preview source result the client renders. */
interface Dsl4PreviewSourceResult {
  readonly ok?: unknown;
  readonly integrity: string;
  readonly counts: Record<string, number>;
  readonly diagnostics?: readonly Dsl4PreviewClientDiagnostic[];
}

interface Dsl4PreviewClientDiagnostic {
  readonly code?: string;
  readonly message?: string;
  readonly severity?: string;
}

/** The protocol acknowledgement the client renders alongside a source result. */
/** The per-anchor availability the reload choices are rendered from. */
type Dsl4PreviewReloadChoices = Readonly<
  Record<'storyStart' | 'currentScene' | 'currentAction', {available?: unknown} | undefined>
>;

/** The protocol acknowledgement the client renders alongside a source result. */
interface Dsl4PreviewAcknowledgement {
  readonly current?: {readonly integrity?: string} | null;
  readonly candidate?: {readonly options?: unknown} | null;
  readonly active?: {readonly integrity?: string} | null;
  readonly revision?: unknown;
}

async function renderSource(
  source: Dsl4PreviewSourceResult,
  acknowledgement: Dsl4PreviewAcknowledgement,
) {
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
    await notifyDiagnostic('source', diagnostic);
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

  await notifyDiagnostic('source', null);
  const details = {
    integrity: source.integrity,
    counts: source.counts,
    warningCount: diagnostics.filter((diagnostic) => diagnostic?.severity === 'warning').length,
  };
  if (acknowledgement.candidate) {
    candidateDetails = details;
    const choices = acknowledgement.candidate.options as Dsl4PreviewReloadChoices;
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
    await notifyCandidate({
      channel: 'source',
      channelRevision: acknowledgement.revision,
      availability: reloadAvailability(choices),
      changedIds: ['source-generation'],
      initiatingInputId: null,
      async apply(request: Readonly<Record<string, unknown>>) {
        const result = await post('/api/commit', {
          choice: restartChoice(request.actualAnchor),
        });
        renderCommitted(result.acknowledgement);
      },
      async restart(request: Readonly<Record<string, unknown>>) {
        const result = await post('/api/restart', {
          choice: restartChoice(request.actualAnchor),
        });
        renderCommitted(result.acknowledgement);
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

function renderCommitted(acknowledgement: Dsl4PreviewAcknowledgement) {
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

async function applyEvent(record: Dsl4PreviewClientEvent) {
  if (!Number.isSafeInteger(record.sequence) || Number(record.sequence) <= latestSequence) return;
  latestSequence = Number(record.sequence);
  if (record.type === 'local-preview.source') {
    await renderSource(
      record.source as Dsl4PreviewSourceResult,
      record.acknowledgement as Dsl4PreviewAcknowledgement,
    );
    return;
  }
  if (record.type === 'local-preview.protocol') {
    if (record.event?.type === 'preview.source.committed') renderCommitted(record.event);
    return;
  }
  if (record.type === 'local-preview.full-rebuild-required') {
    await notifyWatch('source', 'paused');
    await notifyDiagnostic('source', record.diagnostic);
    return;
  }
  if (record.type === 'local-preview.transport-disconnected') {
    await notifyWatch('source', 'disconnected');
  }
}

async function streamEvents() {
  streamController = new AbortController();
  const response = await globalThis.fetch('/api/events', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({after: latestSequence}),
    cache: 'no-store',
    credentials: 'same-origin',
    signal: streamController.signal,
  });
  if (!response.ok || !response.body) throw new Error('The preview event stream could not start.');
  streamBody = response.body;
  if (disposed) return;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  streamReader = reader;
  let buffered = '';
  while (!disposed) {
    const {done, value} = await reader.read();
    if (done) break;
    buffered += value;
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line) await applyEvent(JSON.parse(line));
      newline = buffered.indexOf('\n');
    }
  }
}

async function start() {
  await notifyWatch('source', 'stabilizing');
  const connected = await post('/api/connect', {token}, false);
  if (disposed) return;
  for (const event of connected.events ?? []) await applyEvent(event);
  await notifyWatch('source', 'watching');
  await streamEvents();
}

let disposal: Promise<void> | null = null;
let cancelJoin: Promise<void> | null = null;
let shellJoin: Promise<unknown> | null = null;
let shellReleased = false;
const cancellation = createDsl4RetryableCleanup({
  message: 'Protocol preview cancellation failed',
  parallel: true,
  steps: [() => lifecycle.abort(), () => streamController?.abort()],
});
const cleanup = createDsl4RetryableCleanup({
  message: 'Protocol preview client cleanup failed',
  parallel: true,
  steps: [
    () => globalThis.removeEventListener('pagehide', handlePageHide),
    {
      isPending: cancellation.hasPendingCleanup,
      run() {
        const pending = cancelJoin;
        cancelJoin = null;
        return pending ?? cancellation.run();
      },
    },
    async () => {
      if (streamReader) {
        await streamReader.cancel();
        streamReader.releaseLock();
        streamReader = null;
      } else await streamBody?.cancel();
      streamBody = null;
      streamController = null;
    },
    {
      isPending: () => shell.hasPendingCleanup(),
      async run() {
        const pending = shellJoin;
        shellJoin = null;
        if (pending) await pending;
        else await shell.dispose();
        if (shell.hasPendingCleanup()) throw new Error('Protocol preview shell cleanup is pending');
        shellReleased = true;
      },
    },
    () => {
      activeDetails = null;
      candidateDetails = null;
    },
  ],
});
export function disposeDsl4LocalPreviewProtocolClient() {
  if (disposal) return disposal;
  disposed = true;
  const operation = Promise.resolve().then(async () => {
    cancelJoin = cancellation.run();
    void cancelJoin.catch(() => {});
    if (!shellReleased) {
      shellJoin = Promise.resolve().then(() => shell.dispose());
      void shellJoin.catch(() => {});
    }
    if (startup) await startup.catch(() => {});
    await cleanup.run();
  });
  disposal = operation;
  observers.close();
  const settled = () => {
    disposal = null;
  };
  void operation.then(settled, settled);
  return operation;
}
export const hasPendingDsl4LocalPreviewProtocolCleanup = cleanup.hasPendingCleanup;
function handlePageHide() {
  if (!disposed) void disposeDsl4LocalPreviewProtocolClient().catch(reportError);
}
globalThis.addEventListener('pagehide', handlePageHide, {once: true});
startup = start();
void startup.catch(async (error) => {
  if (disposed || error?.name === 'AbortError') return;
  reportError(error);
  try {
    await notifyWatch('source', 'disconnected');
  } catch {
    // The visible error remains authoritative when cleanup is already complete.
  }
});
