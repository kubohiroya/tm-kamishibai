import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDsl4LiveReloadSession,
  createDsl4PreviewProtocolSession,
  dsl4PreviewOptionalCapabilities,
  dsl4PreviewProtocolVersion,
  dsl4PreviewRequiredCapabilities,
  Dsl4PreviewProtocolError,
} from '../src/dsl4/index.js';
import {deferred, waitUntil} from './helpers/async-test-helpers.mjs';
import {dsl4TestSourceFrontend} from './helpers/dsl4-test-frontend.mjs';

const frontend = dsl4TestSourceFrontend;

const initialSource = `
kamishibai: '4.0'
variables:
  score: 0
scenes:
  opening:
    - wait:
        seconds: 1
        stableId: active-wait
`;

function parsedSnapshot(source, integrity) {
  return {
    ...frontend.parse(source, {sourceId: 'main'}),
    sourceSnapshot: {sourceId: 'main', integrity},
  };
}

function fakeSession(storyDocument, events, name) {
  let runtime = {
    status: 'idle',
    sceneId: 'opening',
    actionIndex: 0,
    actionPath: '/scenes/opening/actions/0',
    variables: storyDocument.variables,
  };
  let quiesceToken = null;
  return {
    start(options = {}) {
      events.push([name, 'start', options]);
      runtime = {
        ...runtime,
        status: 'running',
        sceneId: options.sceneId ?? runtime.sceneId,
        actionIndex: options.actionIndex ?? runtime.actionIndex,
        actionPath:
          options.actionIndex === undefined
            ? runtime.actionPath
            : `/scenes/${options.sceneId}/actions/${options.actionIndex}`,
        variables: options.variables ?? runtime.variables,
      };
      return Promise.resolve(runtime);
    },
    stop(reason) {
      events.push([name, 'stop', reason]);
      runtime = {...runtime, status: 'stopped'};
      quiesceToken = null;
    },
    dispose(reason) {
      events.push([name, 'dispose', reason]);
    },
    getState() {
      return {runtime};
    },
    quiesce({candidateId}) {
      quiesceToken = Object.freeze({
        kind: 'Dsl4QuiesceToken',
        version: 1,
        candidateId,
        runtimeGeneration: 1,
        storyPath: runtime.actionPath ?? `/scenes/${runtime.sceneId}`,
        actionSignature: runtime.actionPath
          ? {command: 'wait', target: null, handler: 'core'}
          : null,
        sceneId: runtime.sceneId,
        actionIndex: runtime.actionIndex,
        variables: {...runtime.variables},
        resumeMode: runtime.actionPath ? 'replay-action' : 'finished',
      });
      runtime = {...runtime, status: 'paused'};
      return quiesceToken;
    },
    resumeQuiesce(candidateId) {
      if (!quiesceToken || quiesceToken.candidateId !== candidateId) {
        throw new TypeError('stale quiesce candidate');
      }
      quiesceToken = null;
      runtime = {...runtime, status: 'running'};
      return runtime;
    },
  };
}

function createSetup() {
  const events = [];
  let created = 0;
  const liveReload = createDsl4LiveReloadSession({
    createSession({storyDocument}) {
      created += 1;
      return fakeSession(storyDocument, events, `runtime-${created}`);
    },
  });
  const protocol = createDsl4PreviewProtocolSession({liveReloadSession: liveReload});
  return {events, liveReload, protocol};
}

function hello(sessionId, overrides = {}) {
  return {
    type: 'preview.handshake',
    protocolVersion: dsl4PreviewProtocolVersion,
    sessionId,
    capabilities: dsl4PreviewRequiredCapabilities,
    ...overrides,
  };
}

test('reports malformed capability tokens as DSL 4.0 protocol schema errors', async () => {
  const {protocol} = createSetup();
  for (const capabilities of [
    'source.stage.v1',
    ['Source.Stage.V1'],
    ['source..stage.v1'],
    [...dsl4PreviewRequiredCapabilities, dsl4PreviewRequiredCapabilities[0]],
  ]) {
    await assert.rejects(
      protocol.handshake(hello('client-a', {capabilities})),
      (error) =>
        error instanceof Dsl4PreviewProtocolError &&
        error.code === 'K4-PREVIEW-PROTOCOL-SCHEMA' &&
        !error.message.endsWith('.'),
    );
    assert.equal(protocol.getState().connected, false);
  }

  assert.throws(
    () =>
      createDsl4PreviewProtocolSession({
        liveReloadSession: createDsl4LiveReloadSession({createSession: () => ({})}),
        runtimeCapabilities: ['not a capability'],
      }),
    (error) =>
      error instanceof Dsl4PreviewProtocolError && error.code === 'K4-PREVIEW-PROTOCOL-SCHEMA',
  );
});

test('negotiates one major version and fails closed when required capabilities are missing', async () => {
  const {protocol} = createSetup();
  await assert.rejects(
    protocol.handshake(
      hello('client-a', {
        protocolVersion: {major: dsl4PreviewProtocolVersion.major + 1, minor: 0},
      }),
    ),
    (error) =>
      error instanceof Dsl4PreviewProtocolError && error.code === 'K4-PREVIEW-PROTOCOL-VERSION',
  );
  assert.equal(protocol.getState().connected, false);

  await assert.rejects(
    protocol.handshake(hello('client-a', {capabilities: ['source.stage.v1']})),
    (error) =>
      error instanceof Dsl4PreviewProtocolError && error.code === 'K4-PREVIEW-PROTOCOL-CAPABILITY',
  );
  assert.equal(protocol.getState().connected, false);

  const ack = await protocol.handshake(
    hello('client-a', {
      protocolVersion: {major: 1, minor: 9},
      capabilities: [
        ...dsl4PreviewRequiredCapabilities,
        ...dsl4PreviewOptionalCapabilities,
        'client.extra.v1',
      ],
    }),
  );
  assert.equal(ack.type, 'preview.handshake.ack');
  assert.deepEqual(ack.protocolVersion, dsl4PreviewProtocolVersion);
  assert.deepEqual(
    ack.capabilities,
    [...dsl4PreviewRequiredCapabilities, ...dsl4PreviewOptionalCapabilities].sort(),
  );
  assert.deepEqual(ack.current, {generation: 0, sourceId: null, integrity: null});
  assert.equal(Object.isFrozen(ack), true);

  await assert.rejects(
    protocol.stage({
      type: 'preview.source.stage',
      sessionId: 'client-a',
      revision: 1,
      result: parsedSnapshot(initialSource, 'sha256-initial'),
      unexpected: true,
    }),
    (error) => error.code === 'K4-PREVIEW-PROTOCOL-SCHEMA',
  );
});

test('binds revisions and candidates to a session and acknowledges committed integrity', async () => {
  const {events, liveReload, protocol} = createSetup();
  await protocol.handshake(
    hello('client-a', {
      capabilities: [...dsl4PreviewRequiredCapabilities, ...dsl4PreviewOptionalCapabilities],
    }),
  );

  const initial = await protocol.stage({
    type: 'preview.source.stage',
    sessionId: 'client-a',
    revision: 1,
    result: parsedSnapshot(initialSource, 'sha256-initial'),
  });
  assert.equal(initial.status, 'active');
  assert.equal(initial.candidate, null);
  assert.equal(initial.sourceIntegrity, 'sha256-initial');
  assert.deepEqual(initial.current, {
    generation: 1,
    sourceId: 'main',
    integrity: 'sha256-initial',
  });

  const changedSource = initialSource.replace('seconds: 1', 'seconds: 2');
  const pending = await protocol.stage({
    type: 'preview.source.stage',
    sessionId: 'client-a',
    revision: 2,
    result: parsedSnapshot(changedSource, 'sha256-changed'),
  });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.candidate.options.currentAction.enabled, true);

  await assert.rejects(
    protocol.stage({
      type: 'preview.source.stage',
      sessionId: 'client-a',
      revision: 2,
      result: parsedSnapshot(changedSource, 'sha256-duplicate'),
    }),
    (error) => error.code === 'K4-PREVIEW-PROTOCOL-REVISION',
  );
  await assert.rejects(
    protocol.commit({
      type: 'preview.source.commit',
      sessionId: 'client-a',
      revision: 1,
      candidateId: pending.candidate.id,
      choice: 'currentAction',
    }),
    (error) => error.code === 'K4-PREVIEW-PROTOCOL-CANDIDATE',
  );

  const deferred = await protocol.defer({
    type: 'preview.source.defer',
    sessionId: 'client-a',
    revision: 2,
    candidateId: pending.candidate.id,
  });
  assert.equal(deferred.status, 'active');
  assert.equal(protocol.getState().candidate, null);
  await assert.rejects(
    protocol.commit({
      type: 'preview.source.commit',
      sessionId: 'client-a',
      revision: 2,
      candidateId: pending.candidate.id,
      choice: 'currentAction',
    }),
    (error) => error.code === 'K4-PREVIEW-PROTOCOL-CANDIDATE',
  );

  const restaged = await protocol.stage({
    type: 'preview.source.stage',
    sessionId: 'client-a',
    revision: 3,
    result: parsedSnapshot(changedSource, 'sha256-changed'),
  });

  const committed = await protocol.commit({
    type: 'preview.source.commit',
    sessionId: 'client-a',
    revision: 3,
    candidateId: restaged.candidate.id,
    choice: 'currentAction',
  });
  assert.equal(committed.status, 'active');
  assert.deepEqual(committed.current, {
    generation: 2,
    sourceId: 'main',
    integrity: 'sha256-changed',
  });
  assert.equal(liveReload.getState().current.integrity, 'sha256-changed');
  assert.deepEqual(events, [
    ['runtime-1', 'start', {}],
    ['runtime-1', 'stop', 'live-reload'],
    ['runtime-1', 'dispose', 'live-reload-replaced'],
    [
      'runtime-2',
      'start',
      {
        sceneId: 'opening',
        actionIndex: 0,
        variables: {score: 0},
      },
    ],
  ]);

  // A reconnect reconciles a lost commit acknowledgement without replaying source or runtime data.
  const reconciled = await protocol.handshake(hello('client-b'));
  assert.deepEqual(reconciled.current, committed.current);
  assert.equal(protocol.getState().latestRevision, 0);
});

test('disconnect and reconnect discard only pending candidate state', async () => {
  const {events, liveReload, protocol} = createSetup();
  await protocol.handshake(hello('client-a'));
  await protocol.stage({
    type: 'preview.source.stage',
    sessionId: 'client-a',
    revision: 1,
    result: parsedSnapshot(initialSource, 'sha256-initial'),
  });
  const pending = await protocol.stage({
    type: 'preview.source.stage',
    sessionId: 'client-a',
    revision: 2,
    result: parsedSnapshot(initialSource.replace('seconds: 1', 'seconds: 3'), 'sha256-next'),
  });
  assert.ok(pending.candidate);

  const disconnected = await protocol.disconnect({
    type: 'preview.disconnect',
    sessionId: 'client-a',
  });
  assert.deepEqual(disconnected.current, {
    generation: 1,
    sourceId: 'main',
    integrity: 'sha256-initial',
  });
  assert.equal(protocol.getState().connected, false);
  assert.equal(liveReload.getState().candidate, null);
  assert.equal(liveReload.getState().status, 'active');
  assert.deepEqual(events, [['runtime-1', 'start', {}]]);

  await assert.rejects(
    protocol.stage({
      type: 'preview.source.stage',
      sessionId: 'client-a',
      revision: 3,
      result: parsedSnapshot(initialSource, 'sha256-stale'),
    }),
    (error) => error.code === 'K4-PREVIEW-PROTOCOL-DISCONNECTED',
  );

  await protocol.handshake(hello('client-b'));
  await assert.rejects(
    protocol.disconnect({type: 'preview.disconnect', sessionId: 'client-a'}),
    (error) => error.code === 'K4-PREVIEW-PROTOCOL-SESSION',
  );
  assert.equal(protocol.getState().sessionId, 'client-b');

  const revisionReset = await protocol.stage({
    type: 'preview.source.stage',
    sessionId: 'client-b',
    revision: 1,
    result: parsedSnapshot(initialSource.replace('seconds: 1', 'seconds: 4'), 'sha256-reconnect'),
  });
  assert.equal(revisionReset.revision, 1);
  assert.ok(revisionReset.candidate);
});

test('serializes source revisions in runtime receipt order', async () => {
  const {protocol} = createSetup();
  await protocol.handshake(hello('client-a'));
  const first = protocol.stage({
    type: 'preview.source.stage',
    sessionId: 'client-a',
    revision: 1,
    result: parsedSnapshot(initialSource, 'sha256-one'),
  });
  const second = protocol.stage({
    type: 'preview.source.stage',
    sessionId: 'client-a',
    revision: 2,
    result: parsedSnapshot(initialSource.replace('seconds: 1', 'seconds: 2'), 'sha256-two'),
  });
  assert.equal((await first).status, 'active');
  assert.equal((await second).status, 'pending');
  assert.equal(protocol.getState().latestRevision, 2);
});
test('accepts a newer source revision while the previous revision is still quiescing', async () => {
  const initial = parsedSnapshot(initialSource, 'sha256-initial');
  const gate = deferred();
  const quiesceCalls = [];
  let latestCandidateId = 0;
  const session = {
    start() {},
    stop() {},
    dispose() {},
    getState() {
      return {
        runtime: {
          status: 'running',
          sceneId: 'opening',
          actionIndex: 0,
          actionPath: '/scenes/opening/actions/0',
          variables: {score: 0},
        },
      };
    },
    quiesce({candidateId}) {
      latestCandidateId = candidateId;
      quiesceCalls.push(candidateId);
      return gate.promise.then(() => ({
        kind: 'Dsl4QuiesceToken',
        version: 1,
        candidateId: latestCandidateId,
        runtimeGeneration: 1,
        storyPath: '/scenes/opening/actions/0',
        actionSignature: {command: 'wait', target: null, handler: 'core'},
        sceneId: 'opening',
        actionIndex: 0,
        variables: {score: 0},
        resumeMode: 'replay-action',
      }));
    },
    resumeQuiesce() {},
  };
  const liveReload = createDsl4LiveReloadSession({
    initialStoryDocument: initial.storyDocument,
    initialSession: session,
    createSession() {
      assert.fail('candidate replacement must not create a runtime before commit');
    },
  });
  const protocol = createDsl4PreviewProtocolSession({liveReloadSession: liveReload});
  await protocol.handshake(hello('client-a'));

  const first = protocol.stage({
    type: 'preview.source.stage',
    sessionId: 'client-a',
    revision: 1,
    result: parsedSnapshot(initialSource.replace('seconds: 1', 'seconds: 2'), 'sha256-one'),
  });
  const second = protocol.stage({
    type: 'preview.source.stage',
    sessionId: 'client-a',
    revision: 2,
    result: parsedSnapshot(initialSource.replace('seconds: 1', 'seconds: 3'), 'sha256-two'),
  });
  await waitUntil(() => quiesceCalls.length === 2);
  assert.deepEqual(quiesceCalls, [1, 2]);
  let idleSettled = false;
  const idle = protocol.whenIdle().then(() => {
    idleSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idleSettled, false);
  gate.resolve();

  await assert.rejects(first, /replaced/u);
  const pending = await second;
  await idle;
  assert.equal(idleSettled, true);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.candidate.id, 2);
  assert.deepEqual(protocol.getState().candidate, {revision: 2, id: 2});
});
