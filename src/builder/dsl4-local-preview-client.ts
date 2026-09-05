import {createDsl4CliPreviewShell} from './dsl4-preview-shell.js';

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
        const result = await post('/api/commit', {
          choice: restartChoice(request.actualAnchor),
        });
        renderCommitted(result.acknowledgement);
      },
      async restart(request: Readonly<Record<string, any>>) {
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

async function applyEvent(record: Record<string, any>) {
  if (!Number.isSafeInteger(record.sequence) || record.sequence <= latestSequence) return;
  latestSequence = record.sequence;
  if (record.type === 'local-preview.source') {
    await renderSource(record.source, record.acknowledgement);
    return;
  }
  if (record.type === 'local-preview.protocol') {
    if (record.event?.type === 'preview.source.committed') renderCommitted(record.event);
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
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
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
  await shell.setReloadWatchState('source', 'stabilizing');
  const connected = await post('/api/connect', {token}, false);
  for (const event of connected.events ?? []) await applyEvent(event);
  await shell.setReloadWatchState('source', 'watching');
  await streamEvents();
}

function dispose() {
  if (disposed) return;
  disposed = true;
  streamController?.abort();
  void shell.dispose();
}

globalThis.addEventListener('pagehide', dispose, {once: true});
start().catch(async (error) => {
  if (disposed || error?.name === 'AbortError') return;
  reportError(error);
  try {
    await shell.setReloadWatchState('source', 'disconnected');
  } catch {
    // The visible error remains authoritative when cleanup is already complete.
  }
});
