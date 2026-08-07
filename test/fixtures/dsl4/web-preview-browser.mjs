import {createDsl4WebPreviewShell} from '../../../src/builder/dsl4-web-preview-shell.js';

const encoder = new TextEncoder();
const browserDocument = globalThis.document;
const unsupportedFixture = new URL(globalThis.location.href).searchParams.has('unsupported');
const manifestText = JSON.stringify({
  formatVersion: 1,
  mode: 'external',
  sourceId: 'main',
  path: 'story.kamishibai.yaml',
});
let sourceText = "kamishibai: '4.0'\nscenes:\n  opening: []\n# revision 1\n";
let sourceMissing = false;
let editorRevision = 1;

function fileFor(text) {
  const bytes = encoder.encode(text);
  return {
    size: bytes.byteLength,
    async arrayBuffer() {
      return bytes.slice().buffer;
    },
  };
}

const rootHandle = {
  kind: 'directory',
  name: 'browser-fixture-project',
  async queryPermission() {
    return 'granted';
  },
  async getDirectoryHandle() {
    throw new DOMException('Directory is missing', 'NotFoundError');
  },
  async getFileHandle(name) {
    if (name === 'project.source.json') {
      return {
        kind: 'file',
        async getFile() {
          return fileFor(manifestText);
        },
      };
    }
    if (name === 'story.kamishibai.yaml' && !sourceMissing) {
      return {
        kind: 'file',
        async getFile() {
          return fileFor(sourceText);
        },
      };
    }
    throw new DOMException('Source is missing', 'NotFoundError');
  },
};

const platform = {isSecureContext: true, crypto: globalThis.crypto};
platform.self = platform;
platform.top = platform;
if (!unsupportedFixture) {
  platform.showDirectoryPicker = async (options) => {
    if (options?.mode !== 'read') throw new TypeError('Fixture picker must be read-only');
    return rootHandle;
  };
}

function sourceFrontendResult(source, sourceId) {
  if (source.includes('invalid: true')) {
    return Object.freeze({
      ok: false,
      canonicalSource: source,
      diagnostics: [
        Object.freeze({
          version: 1,
          code: 'K4-FIXTURE-INVALID',
          severity: 'error',
          message: 'The browser fixture source is invalid',
          sourceId,
          range: {
            start: {line: 1, column: 1, offset: 0},
            end: {line: 1, column: 1, offset: 0},
          },
          path: '$',
          related: [],
        }),
      ],
    });
  }
  return Object.freeze({
    ok: true,
    canonicalSource: source,
    diagnostics: [],
    storyDocument: Object.freeze({
      kind: 'StoryDocument',
      version: '4.0',
      scenes: Object.freeze([
        Object.freeze({
          id: 'opening',
          actions: Object.freeze([{id: `revision-${editorRevision}`}]),
        }),
      ]),
      assetReferences: Object.freeze([]),
    }),
  });
}

function createProtocolSession() {
  let current = null;
  let candidate = null;
  let nextCandidateId = 1;

  const currentSummary = () => ({
    generation: current ? current.generation : 0,
    sourceId: current ? 'main' : null,
    integrity: current?.integrity ?? null,
  });

  return Object.freeze({
    async handshake(message) {
      return {
        type: 'preview.handshake.ack',
        sessionId: message.sessionId,
        protocolVersion: {major: 1, minor: 0},
        capabilities: message.capabilities,
        requiredCapabilities: message.capabilities,
        current: currentSummary(),
      };
    },
    async stage(message) {
      const integrity = message.result.sourceSnapshot?.integrity ?? null;
      if (message.result.ok && !current) {
        current = {integrity, generation: 1};
        candidate = null;
      } else if (message.result.ok) {
        candidate = {id: nextCandidateId++, integrity};
      } else {
        candidate = null;
      }
      return {
        type: 'preview.source.staged',
        sessionId: message.sessionId,
        revision: message.revision,
        sourceIntegrity: integrity,
        status: message.result.ok ? (candidate ? 'pending' : 'active') : 'invalid',
        candidate: candidate
          ? {
              id: candidate.id,
              options: {
                storyStart: {enabled: true, reason: null},
                currentScene: {enabled: true, reason: null},
                currentAction: {enabled: true, reason: null},
              },
            }
          : null,
        current: currentSummary(),
        diagnostics: message.result.diagnostics,
      };
    },
    async commit(message) {
      current = {integrity: candidate.integrity, generation: (current?.generation ?? 0) + 1};
      candidate = null;
      return {
        type: 'preview.source.committed',
        sessionId: message.sessionId,
        revision: message.revision,
        candidateId: message.candidateId,
        choice: message.choice,
        status: 'active',
        current: currentSummary(),
      };
    },
    async defer(message) {
      candidate = null;
      return {
        type: 'preview.source.deferred',
        sessionId: message.sessionId,
        revision: message.revision,
        candidateId: message.candidateId,
        status: 'active',
        current: currentSummary(),
      };
    },
    async disconnect(message) {
      candidate = null;
      return {
        type: 'preview.disconnected',
        sessionId: message.sessionId,
        current: currentSummary(),
      };
    },
    getState() {
      return {current: currentSummary(), candidate};
    },
    async whenIdle() {
      return this.getState();
    },
  });
}

const shell = createDsl4WebPreviewShell({
  featureFlags: {
    dsl4Runtime: true,
    dsl4AppShell: true,
    dsl4WebPreviewAdapter: true,
    dsl4PreviewReloadOverlay: true,
  },
  environment: 'development',
  document: browserDocument,
  mount: browserDocument.querySelector('#web-preview-mount'),
  protocolSession: createProtocolSession(),
  sessionId: 'chromium-browser-fixture',
  sourceFrontend: {
    parse(source, {sourceId = 'main'} = {}) {
      return sourceFrontendResult(source, sourceId);
    },
  },
  maxSourceBytes: 8192,
  sourceOptions: {
    globalObject: platform,
    document: browserDocument,
    foregroundIntervalMs: 60_000,
    backgroundIntervalMs: 60_000,
    quietWindowMs: 10,
    retryIntervalMs: 5,
    stabilityTimeoutMs: 100,
  },
});

async function applyEditorChange(change) {
  change();
  await shell.pollNow();
  await shell.whenIdle();
}

browserDocument.querySelector('#fixture-save-valid').addEventListener('click', () => {
  void applyEditorChange(() => {
    sourceMissing = false;
    editorRevision += 1;
    sourceText = `kamishibai: '4.0'\nscenes:\n  opening: []\n# revision ${editorRevision}\n`;
  });
});
browserDocument.querySelector('#fixture-save-invalid').addEventListener('click', () => {
  void applyEditorChange(() => {
    sourceMissing = false;
    sourceText = "kamishibai: '4.0'\ninvalid: true\n";
  });
});
browserDocument.querySelector('#fixture-remove-source').addEventListener('click', () => {
  void applyEditorChange(() => {
    sourceMissing = true;
  });
});
browserDocument.querySelector('#fixture-restore-source').addEventListener('click', () => {
  void applyEditorChange(() => {
    sourceMissing = false;
    editorRevision += 1;
    sourceText = `kamishibai: '4.0'\nscenes:\n  opening: []\n# restored ${editorRevision}\n`;
  });
});

globalThis.webPreviewFixture = Object.freeze({shell, applyEditorChange});
browserDocument.querySelector('#fixture-ready').textContent = 'Browser fixture ready.';
