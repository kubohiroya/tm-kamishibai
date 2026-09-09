import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {test} from 'vitest';

import {
  createDsl4BrowserPreviewCoordinator,
  createDsl4PreviewSourceProtocolPort,
  dsl4PreviewOptionalCapabilities,
  dsl4PreviewRequiredCapabilities,
} from '../src/dsl4/index.js';
import {deferred} from './helpers/async-test-helpers.ts';
import {requireDefined, requireRecord} from './helpers/require-value.ts';

/** The source snapshot and parse result the port stages. */
interface SourceSnapshot {
  readonly integrity: string;
  readonly text: string;
}

interface SourceResult {
  readonly ok: boolean;
  readonly canonicalSource: string;
  readonly diagnostics: readonly Readonly<{code: string}>[];
  readonly storyDocument?: Readonly<Record<string, unknown>>;
  readonly sourceSnapshot: SourceSnapshot;
}

/** One protocol message the fake session records. Each member belongs to one message type. */
interface ProtocolMessage {
  readonly type: string;
  readonly sessionId: string;
  readonly revision?: number;
  readonly candidateId?: number;
  readonly choice?: string;
  readonly capabilities?: readonly string[];
  readonly result?: SourceResult;
}

type PortOptions = Parameters<typeof createDsl4PreviewSourceProtocolPort>[0];

/**
 * Pass port options the declaration refuses on purpose.
 *
 * One case asserts that the factory rejects an empty session, a duplicate capability, and
 * non-function observers -- all of which its own types already forbid.
 */
function invalidPortOptions(options: Record<string, unknown>): PortOptions {
  return options as unknown as PortOptions;
}

type RestartChoice = Parameters<
  ReturnType<typeof createDsl4PreviewSourceProtocolPort>['commit']
>[0];

/** One case commits a choice the port's own union forbids, to assert that it refuses it. */
function invalidChoice(choice: string): RestartChoice {
  return choice as RestartChoice;
}

/** Read a state or acknowledgement the port reports as an opaque record. */
function reported(value: unknown, description: string): Record<string, unknown> {
  return requireRecord(value, description);
}

function sourceResult(integrity: string, {ok = true}: {ok?: boolean} = {}): SourceResult {
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

function createProtocol({
  stageImplementation,
}: {
  stageImplementation?: (message: ProtocolMessage, count: number) => unknown;
} = {}) {
  const calls: ProtocolMessage[] = [];
  let stageCount = 0;
  let generation = 0;
  let currentIntegrity: string | null = null;
  const current = () => ({
    generation,
    sourceId: currentIntegrity ? 'main' : null,
    integrity: currentIntegrity,
  });
  const protocol = {
    async handshake(message: ProtocolMessage) {
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
    async stage(message: ProtocolMessage) {
      calls.push(message);
      stageCount += 1;
      if (stageImplementation) return stageImplementation(message, stageCount);
      const result = requireDefined(message.result, 'the staged source result');
      const valid = result.ok;
      const initial = valid && currentIntegrity === null;
      if (initial) {
        currentIntegrity = result.sourceSnapshot.integrity;
        generation += 1;
      }
      return {
        type: 'preview.source.staged',
        sessionId: message.sessionId,
        revision: message.revision,
        sourceIntegrity: result.sourceSnapshot.integrity,
        status: valid ? (initial ? 'active' : 'pending') : 'invalid',
        candidate:
          valid && !initial
            ? {
                id: requireDefined(message.revision, 'the staged revision') + 100,
                options: {
                  storyStart: {enabled: true, reason: null},
                  currentScene: {enabled: true, reason: null},
                  currentAction: {enabled: true, reason: null},
                },
              }
            : null,
        current: current(),
        diagnostics: result.diagnostics,
      };
    },
    async commit(message: ProtocolMessage) {
      calls.push(message);
      currentIntegrity = `committed-${String(message.revision)}`;
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
    async defer(message: ProtocolMessage) {
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
    async disconnect(message: ProtocolMessage) {
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

function createPort(fixture: {protocol: unknown}, overrides: Partial<PortOptions> = {}) {
  const events: Readonly<Record<string, unknown>>[] = [];
  const errors: unknown[] = [];
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
  assert.equal(reported(connected, 'the connect result').status, 'connected');
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
    options: requireDefined(second.candidate, 'the second candidate').options,
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
  assert.equal(reported(committed, 'the commit acknowledgement').choice, 'currentScene');
  assert.equal(setup.port.getState().candidate, null);

  await setup.port.stage(sourceResult('sha256-candidate-2'));
  const deferred = await setup.port.defer();
  assert.deepEqual(fixture.calls.at(-1), {
    type: 'preview.source.defer',
    sessionId: 'preview-test',
    revision: 3,
    candidateId: 103,
  });
  assert.equal(reported(deferred, 'the defer acknowledgement').type, 'preview.source.deferred');
  assert.equal(setup.port.getState().status, 'connected');
});

test('does not expose a stale stage acknowledgement after a newer revision wins', async () => {
  const gates = [deferred(), deferred()];
  const fixture = createProtocol({
    stageImplementation(message, count) {
      const revision = requireDefined(message.revision, 'the staged revision');
      const result = requireDefined(message.result, 'the staged source result');
      return requireDefined(gates[count - 1], `stage gate ${count}`).promise.then(() => ({
        type: 'preview.source.staged',
        sessionId: message.sessionId,
        revision,
        sourceIntegrity: result.sourceSnapshot.integrity,
        status: 'pending',
        candidate: {id: revision + 10, options: {storyStart: {enabled: true}}},
        current: {generation: 1, sourceId: 'main', integrity: 'sha256-current'},
        diagnostics: [],
      }));
    },
  });
  const setup = createPort(fixture);
  await setup.port.connect();
  const first = setup.port.stage(sourceResult('sha256-first'));
  const second = setup.port.stage(sourceResult('sha256-second'));
  requireDefined(gates[1], 'the second stage gate').resolve();
  await second;
  assert.deepEqual(setup.port.getState().candidate, {
    revision: 2,
    id: 12,
    options: {storyStart: {enabled: true}},
  });
  requireDefined(gates[0], 'the first stage gate').resolve();
  await first;
  assert.equal(requireRecord(setup.port.getState().candidate, 'the winning candidate').revision, 2);
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
        sourceIntegrity: requireDefined(message.result, 'the staged source result').sourceSnapshot
          .integrity,
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
  assert.equal(reported(disconnected, 'the disconnect result').connected, false);
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
  const normalize = (calls: readonly ProtocolMessage[]) =>
    calls.map(({result, ...message}) => ({
      ...Object.fromEntries(Object.entries(message).filter(([member]) => member !== 'sessionId')),
      ...(result
        ? {
            result: {
              ok: result.ok,
              integrity: result.sourceSnapshot.integrity,
              diagnosticCodes: result.diagnostics.map(({code}) => code),
            },
          }
        : {}),
    }));
  assert.deepEqual(normalize(nodeFixture.calls), normalize(browserFixture.calls));
});

function createClock() {
  let now = 0;
  let timer: {callback: () => void; milliseconds: number} | null = null;
  return {
    now: () => now,
    sleep(milliseconds: number) {
      now += milliseconds;
      return Promise.resolve();
    },
    setTimeout(callback: () => void, milliseconds: number) {
      timer = {callback, milliseconds};
      return timer;
    },
    clearTimeout(value: unknown) {
      if (timer === value) timer = null;
    },
  };
}

function createDocument() {
  const listeners = new Map<string, (event: unknown) => void>();
  return {
    visibilityState: 'visible',
    hidden: false,
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
}

function createBrowserProject() {
  let source = "kamishibai: '4.0'\nscenes: {}\n";
  const encoder = new TextEncoder();
  const fileHandle = (read: () => string) => ({
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
    async getFileHandle(name: string) {
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
  return {root, setSource: (value: string) => (source = value)};
}

test('opens the directory picker before an asynchronous protocol handshake settles', async () => {
  const fixture = createProtocol();
  const handshakeGate = deferred();
  const handshake = fixture.protocol.handshake;
  fixture.protocol.handshake = async (message) => {
    await handshakeGate.promise;
    return handshake(message);
  };
  const project = createBrowserProject();
  let pickerCalls = 0;
  const globalObject: Record<string, unknown> = {
    isSecureContext: true,
    crypto: {subtle: webcrypto.subtle},
  };
  globalObject.self = globalObject;
  globalObject.top = globalObject;
  globalObject.showDirectoryPicker = () => {
    pickerCalls += 1;
    return Promise.resolve(project.root);
  };
  const coordinator = createDsl4BrowserPreviewCoordinator({
    protocolSession: fixture.protocol,
    sessionId: 'browser-user-activation',
    sourceFrontend: {
      parse(source: string) {
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
      globalObject,
      subtleCrypto: webcrypto.subtle,
    },
  });

  const opening = coordinator.openProject();
  assert.equal(pickerCalls, 1);
  assert.equal(fixture.calls.length, 0);
  handshakeGate.resolve();
  const state = await opening;
  assert.equal(state.protocol.latestRevision, 1);
  assert.deepEqual(
    fixture.calls.map(({type}) => type),
    ['preview.handshake', 'preview.source.stage'],
  );
  await coordinator.dispose();
});

test('composes browser polling with handshake, stage, commit, and disconnect', async () => {
  const fixture = createProtocol();
  const project = createBrowserProject();
  const errors: unknown[] = [];
  const coordinator = createDsl4BrowserPreviewCoordinator({
    protocolSession: fixture.protocol,
    sessionId: 'browser-coordinator',
    sourceFrontend: {
      parse(source: string) {
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
  assert.equal(requireRecord(changed.protocol.candidate, 'the changed candidate').id, 102);
  const committed = await coordinator.commit('storyStart');
  assert.equal(reported(committed.result, 'the commit result').type, 'preview.source.committed');
  assert.equal(committed.state.protocol.candidate, null);
  const restarted = await coordinator.restart('storyStart');
  assert.equal(reported(restarted.result, 'the restart result').type, 'preview.source.committed');
  assert.equal(restarted.state.protocol.latestRevision, 3);
  const disposed = await coordinator.dispose();
  assert.equal(disposed.disposed, true);
  assert.equal(reported(disposed.source, 'the disposed source state').status, 'disposed');
  assert.equal(reported(disposed.protocol, 'the disposed protocol state').status, 'disposed');
  assert.deepEqual(errors, []);
  assert.deepEqual(
    fixture.calls.map(({type}) => type),
    [
      'preview.handshake',
      'preview.source.stage',
      'preview.source.stage',
      'preview.source.commit',
      'preview.source.stage',
      'preview.source.commit',
      'preview.disconnect',
    ],
  );
});

test('waits for the generation preparation gate before staging a browser source', async () => {
  const fixture = createProtocol();
  const project = createBrowserProject();
  const entered = deferred();
  const release = deferred();
  const coordinator = createDsl4BrowserPreviewCoordinator({
    protocolSession: fixture.protocol,
    sessionId: 'browser-generation-gate',
    sourceFrontend: {
      parse(source: string) {
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
    async beforeSourceStage() {
      entered.resolve();
      await release.promise;
    },
  });

  const starting = coordinator.start(project.root);
  await entered.promise;
  assert.deepEqual(
    fixture.calls.map(({type}) => type),
    ['preview.handshake'],
  );
  release.resolve();
  const started = await starting;
  assert.equal(started.protocol.latestRevision, 1);
  assert.deepEqual(
    fixture.calls.map(({type}) => type),
    ['preview.handshake', 'preview.source.stage'],
  );
  await coordinator.dispose();
});

test('rejects malformed ports and operations before protocol mutation', async () => {
  const fixture = createProtocol();
  const malformed: Record<string, unknown>[] = [
    {protocolSession: {}},
    {sessionId: ''},
    {capabilities: []},
    {capabilities: [...dsl4PreviewRequiredCapabilities, dsl4PreviewRequiredCapabilities[0]]},
    {onEvent: true},
    {onError: true},
  ];
  for (const overrides of malformed) {
    assert.throws(() =>
      createDsl4PreviewSourceProtocolPort(
        invalidPortOptions({
          protocolSession: fixture.protocol,
          sessionId: 'valid',
          ...overrides,
        }),
      ),
    );
  }
  const setup = createPort(fixture);
  assert.throws(() => setup.port.stage(sourceResult('sha256-before-connect')));
  await assert.rejects(setup.port.commit(invalidChoice('unknown')));
  await setup.port.connect();
  assert.throws(() => setup.port.stage({}));
  await assert.rejects(setup.port.commit('storyStart'));
  await assert.rejects(setup.port.defer());
});
