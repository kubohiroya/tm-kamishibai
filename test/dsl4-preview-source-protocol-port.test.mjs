import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import test from 'node:test';

import {
  createDsl4BrowserPreviewCoordinator,
  createDsl4PreviewSourceProtocolPort,
  dsl4PreviewOptionalCapabilities,
  dsl4PreviewRequiredCapabilities,
} from '../src/dsl4/index.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

function sourceResult(integrity, {ok = true} = {}) {
  const sourceSnapshot = Object.freeze({integrity, text: `source:${integrity}`});
  return ok
    ? Object.freeze({
        ok: true,
        canonicalSource: sourceSnapshot.text,
        diagnostics: [],
        storyDocument: Object.freeze({kind: 'StoryDocument', version: '4.0'}),
        sourceSnapshot,
      })
    : Object.freeze({
        ok: false,
        canonicalSource: sourceSnapshot.text,
        diagnostics: [
          Object.freeze({
            version: 1,
            code: 'K4-TEST-INVALID',
            severity: 'error',
            message: 'Invalid fixture',
            sourceId: 'main',
            range: {
              start: {line: 1, column: 1, offset: 0},
              end: {line: 1, column: 1, offset: 0},
            },
            path: '$',
            related: [],
          }),
        ],
        sourceSnapshot,
      });
}

function createProtocol({stageImplementation} = {}) {
  const calls = [];
  let stageCount = 0;
  let generation = 0;
  let currentIntegrity = null;
  const current = () => ({
    generation,
    sourceId: currentIntegrity ? 'main' : null,
    integrity: currentIntegrity,
  });
  const protocol = {
    async handshake(message) {
      calls.push(message);
      return {
        type: 'preview.handshake.ack',
        sessionId: message.sessionId,
        protocolVersion: {major: 1, minor: 0},
        capabilities: message.capabilities,
        requiredCapabilities: dsl4PreviewRequiredCapabilities,
        current: current(),
      };
    },
    async stage(message) {
      calls.push(message);
      stageCount += 1;
      if (stageImplementation) return stageImplementation(message, stageCount);
      const valid = message.result.ok;
      const initial = valid && currentIntegrity === null;
      if (initial) {
        currentIntegrity = message.result.sourceSnapshot.integrity;
        generation += 1;
      }
      return {
        type: 'preview.source.staged',
        sessionId: message.sessionId,
        revision: message.revision,
        sourceIntegrity: message.result.sourceSnapshot?.integrity ?? null,
        status: valid ? (initial ? 'active' : 'pending') : 'invalid',
        candidate:
          valid && !initial
            ? {
                id: message.revision + 100,
                options: {
                  storyStart: {enabled: true, reason: null},
                  currentScene: {enabled: true, reason: null},
                  currentAction: {enabled: true, reason: null},
                },
              }
            : null,
        current: current(),
        diagnostics: message.result.diagnostics,
      };
    },
    async commit(message) {
      calls.push(message);
      currentIntegrity = `committed-${message.revision}`;
      generation += 1;
      return {
        type: 'preview.source.committed',
        sessionId: message.sessionId,
        revision: message.revision,
        candidateId: message.candidateId,
        choice: message.choice,
        status: 'active',
        current: current(),
      };
    },
    async defer(message) {
      calls.push(message);
      return {
        type: 'preview.source.deferred',
        sessionId: message.sessionId,
        revision: message.revision,
        candidateId: message.candidateId,
        status: 'active',
        current: current(),
      };
    },
    async disconnect(message) {
      calls.push(message);
      return {type: 'preview.disconnected', sessionId: message.sessionId, current: current()};
    },
    getState() {
      return {connected: true};
    },
    async whenIdle() {
      return this.getState();
    },
  };
  return {protocol, calls};
}

function createPort(fixture, overrides = {}) {
  const events = [];
  const errors = [];
  const port = createDsl4PreviewSourceProtocolPort({
    protocolSession: fixture.protocol,
    sessionId: 'preview-test',
    onEvent: (event) => events.push(event),
    onError: (error) => errors.push(error),
    ...overrides,
  });
  return {port, events, errors};
}

test('handshakes once and assigns monotonic revisions to source results', async () => {
  const fixture = createProtocol();
  const setup = createPort(fixture);
  const connected = await setup.port.connect();
  assert.equal(connected.status, 'connected');
  assert.deepEqual(fixture.calls[0], {
    type: 'preview.handshake',
    protocolVersion: {major: 1, minor: 0},
    sessionId: 'preview-test',
    capabilities: [...dsl4PreviewRequiredCapabilities, ...dsl4PreviewOptionalCapabilities].sort(),
  });
  await setup.port.connect();
  assert.equal(fixture.calls.filter(({type}) => type === 'preview.handshake').length, 1);

  const first = await setup.port.stage(sourceResult('sha256-first'));
  assert.equal(first.revision, 1);
  assert.equal(setup.port.getState().candidate, null);
  const second = await setup.port.stage(sourceResult('sha256-second'));
  assert.equal(second.revision, 2);
  assert.deepEqual(setup.port.getState().candidate, {
    revision: 2,
    id: 102,
    options: second.candidate.options,
  });
  assert.equal(setup.port.getState().latestAcknowledgedRevision, 2);
  assert.equal(JSON.stringify(setup.port.getState()).includes('source:sha256'), false);
});

test('uses the acknowledged revision and candidate for commit and defer', async () => {
  const fixture = createProtocol();
  const setup = createPort(fixture);
  await setup.port.connect();
  await setup.port.stage(sourceResult('sha256-initial'));
  await setup.port.stage(sourceResult('sha256-candidate-1'));
  const committed = await setup.port.commit('currentScene');
  assert.deepEqual(fixture.calls.at(-1), {
    type: 'preview.source.commit',
    sessionId: 'preview-test',
    revision: 2,
    candidateId: 102,
    choice: 'currentScene',
  });
  assert.equal(committed.choice, 'currentScene');
  assert.equal(setup.port.getState().candidate, null);

  await setup.port.stage(sourceResult('sha256-candidate-2'));
  const deferred = await setup.port.defer();
  assert.deepEqual(fixture.calls.at(-1), {
    type: 'preview.source.defer',
    sessionId: 'preview-test',
    revision: 3,
    candidateId: 103,
  });
  assert.equal(deferred.type, 'preview.source.deferred');
  assert.equal(setup.port.getState().status, 'connected');
});

test('does not expose a stale stage acknowledgement after a newer revision wins', async () => {
  const gates = [deferred(), deferred()];
  const fixture = createProtocol({
    stageImplementation(message, count) {
      return gates[count - 1].promise.then(() => ({
        type: 'preview.source.staged',
        sessionId: message.sessionId,
        revision: message.revision,
        sourceIntegrity: message.result.sourceSnapshot.integrity,
        status: 'pending',
        candidate: {id: message.revision + 10, options: {storyStart: {enabled: true}}},
        current: {generation: 1, sourceId: 'main', integrity: 'sha256-current'},
        diagnostics: [],
      }));
    },
  });
  const setup = createPort(fixture);
  await setup.port.connect();
  const first = setup.port.stage(sourceResult('sha256-first'));
  const second = setup.port.stage(sourceResult('sha256-second'));
  gates[1].resolve();
  await second;
  assert.deepEqual(setup.port.getState().candidate, {
    revision: 2,
    id: 12,
    options: {storyStart: {enabled: true}},
  });
  gates[0].resolve();
  await first;
  assert.equal(setup.port.getState().candidate.revision, 2);
  assert.equal(setup.events.filter(({type}) => type === 'preview.source.staged').length, 1);
});

test('disconnect invalidates pending stages and is idempotent', async () => {
  const gate = deferred();
  const fixture = createProtocol({
    stageImplementation(message) {
      return gate.promise.then(() => ({
        type: 'preview.source.staged',
        sessionId: message.sessionId,
        revision: message.revision,
        sourceIntegrity: message.result.sourceSnapshot.integrity,
        status: 'pending',
        candidate: {id: 1, options: {}},
        current: {generation: 1, sourceId: 'main', integrity: 'sha256-current'},
        diagnostics: [],
      }));
    },
  });
  const setup = createPort(fixture);
  await setup.port.connect();
  const pending = setup.port.stage(sourceResult('sha256-pending'));
  const disconnected = await setup.port.disconnect();
  assert.equal(disconnected.connected, false);
  gate.resolve();
  await pending;
  assert.equal(setup.port.getState().candidate, null);
  await setup.port.disconnect();
  assert.equal(fixture.calls.filter(({type}) => type === 'preview.disconnect').length, 1);
});

test('keeps Node and browser source sequences transport-neutral', async () => {
  const nodeFixture = createProtocol();
  const browserFixture = createProtocol();
  const node = createDsl4PreviewSourceProtocolPort({
    protocolSession: nodeFixture.protocol,
    sessionId: 'node-source',
  });
  const browser = createDsl4PreviewSourceProtocolPort({
    protocolSession: browserFixture.protocol,
    sessionId: 'browser-source',
  });
  for (const port of [node, browser]) {
    await port.connect();
    await port.stage(sourceResult('sha256-initial'));
    await port.stage(sourceResult('sha256-invalid', {ok: false}));
    await port.stage(sourceResult('sha256-recovered'));
    await port.defer();
    await port.disconnect();
  }
  const normalize = (calls) =>
    calls.map(({sessionId: _sessionId, result, ...message}) => ({
      ...message,
      ...(result
        ? {
            result: {
              ok: result.ok,
              integrity: result.sourceSnapshot?.integrity ?? null,
              diagnosticCodes: result.diagnostics.map(({code}) => code),
            },
          }
        : {}),
    }));
  assert.deepEqual(normalize(nodeFixture.calls), normalize(browserFixture.calls));
});

function createClock() {
  let now = 0;
  let timer = null;
  return {
    now: () => now,
    sleep(milliseconds) {
      now += milliseconds;
      return Promise.resolve();
    },
    setTimeout(callback, milliseconds) {
      timer = {callback, milliseconds};
      return timer;
    },
    clearTimeout(value) {
      if (timer === value) timer = null;
    },
  };
}

function createDocument() {
  const listeners = new Map();
  return {
    visibilityState: 'visible',
    hidden: false,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
}

function createBrowserProject() {
  let source = "kamishibai: '4.0'\nscenes: {}\n";
  const encoder = new TextEncoder();
  const fileHandle = (read) => ({
    kind: 'file',
    async getFile() {
      const bytes = encoder.encode(read());
      return {size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer};
    },
  });
  const root = {
    kind: 'directory',
    queryPermission: async () => 'granted',
    getDirectoryHandle: async () => {
      throw Object.assign(new Error('missing'), {name: 'NotFoundError'});
    },
    async getFileHandle(name) {
      if (name === 'project.source.json') {
        return fileHandle(() =>
          JSON.stringify({
            formatVersion: 1,
            mode: 'external',
            sourceId: 'main',
            path: 'story.kamishibai.yaml',
          }),
        );
      }
      if (name === 'story.kamishibai.yaml') return fileHandle(() => source);
      throw Object.assign(new Error('missing'), {name: 'NotFoundError'});
    },
  };
  return {root, setSource: (value) => (source = value)};
}

test('composes browser polling with handshake, stage, commit, and disconnect', async () => {
  const fixture = createProtocol();
  const project = createBrowserProject();
  const errors = [];
  const coordinator = createDsl4BrowserPreviewCoordinator({
    protocolSession: fixture.protocol,
    sessionId: 'browser-coordinator',
    sourceFrontend: {
      parse(source) {
        return {
          ok: true,
          canonicalSource: source,
          diagnostics: [],
          storyDocument: {kind: 'StoryDocument', version: '4.0'},
        };
      },
    },
    maxSourceBytes: 4096,
    sourceOptions: {
      clock: createClock(),
      document: createDocument(),
      subtleCrypto: webcrypto.subtle,
    },
    onError: (error) => errors.push(error),
  });
  const initial = await coordinator.start(project.root);
  assert.equal(initial.protocol.latestRevision, 1);
  assert.equal(initial.protocol.candidate, null);
  project.setSource("kamishibai: '4.0'\nscenes:\n  next: []\n");
  const changed = await coordinator.pollNow();
  assert.equal(changed.protocol.latestRevision, 2);
  assert.equal(changed.protocol.candidate.id, 102);
  const committed = await coordinator.commit('storyStart');
  assert.equal(committed.result.type, 'preview.source.committed');
  assert.equal(committed.state.protocol.candidate, null);
  const disposed = await coordinator.dispose();
  assert.equal(disposed.disposed, true);
  assert.equal(disposed.source.status, 'disposed');
  assert.equal(disposed.protocol.status, 'disposed');
  assert.deepEqual(errors, []);
  assert.deepEqual(
    fixture.calls.map(({type}) => type),
    [
      'preview.handshake',
      'preview.source.stage',
      'preview.source.stage',
      'preview.source.commit',
      'preview.disconnect',
    ],
  );
});

test('rejects malformed ports and operations before protocol mutation', async () => {
  const fixture = createProtocol();
  for (const overrides of [
    {protocolSession: {}},
    {sessionId: ''},
    {capabilities: []},
    {capabilities: [...dsl4PreviewRequiredCapabilities, dsl4PreviewRequiredCapabilities[0]]},
    {onEvent: true},
    {onError: true},
  ]) {
    assert.throws(() =>
      createDsl4PreviewSourceProtocolPort({
        protocolSession: fixture.protocol,
        sessionId: 'valid',
        ...overrides,
      }),
    );
  }
  const setup = createPort(fixture);
  assert.throws(() => setup.port.stage(sourceResult('sha256-before-connect')));
  await assert.rejects(setup.port.commit('unknown'));
  await setup.port.connect();
  assert.throws(() => setup.port.stage({}));
  await assert.rejects(setup.port.commit('storyStart'));
  await assert.rejects(setup.port.defer());
});
