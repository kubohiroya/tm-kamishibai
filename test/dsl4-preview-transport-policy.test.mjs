import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
  createDsl4PreviewTransportPolicy,
  dsl4PreviewTransportLimits,
  dsl4PreviewTransportTokenBytes,
  Sb3BuilderError,
} from '../src/builder/index.js';
import {
  createDsl4PreviewProtocolSession,
  dsl4PreviewProtocolVersion,
  dsl4PreviewRequiredCapabilities,
} from '../src/dsl4/index.js';

const manifest = Object.freeze({
  formatVersion: 1,
  mode: 'external',
  sourceId: 'main',
  path: 'story.kamishibai.yaml',
});

function deterministicRandomBytes() {
  let value = 0;
  return (size) => Buffer.alloc(size, value++);
}

function policyOptions(overrides = {}) {
  return {
    bindHost: '127.0.0.1',
    port: 4173,
    origin: 'http://127.0.0.1:4173',
    projectRoot: '/project',
    sourceManifest: manifest,
    tokenTtlMs: 1_000,
    maxTokenRecords: 4,
    onDisconnect() {},
    randomBytes: deterministicRandomBytes(),
    now: () => 100,
    ...overrides,
  };
}

function request(token, overrides = {}) {
  return {
    origin: 'http://127.0.0.1:4173',
    remoteAddress: '127.0.0.1',
    token,
    ...overrides,
  };
}

function throwsCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof Sb3BuilderError, true);
    assert.equal(error.code, code);
    assert.equal(error.stage, 'dsl4-preview-transport');
    return true;
  });
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof Sb3BuilderError, true);
    assert.equal(error.code, code);
    assert.equal(error.stage, 'dsl4-preview-transport');
    return true;
  });
}

test('defines finite security limits and requires a literal loopback bind with an exact origin', () => {
  assert.deepEqual(dsl4PreviewTransportLimits, {
    maximumTokenTtlMs: 300_000,
    maximumTokenRecords: 64,
  });
  assert.equal(Object.isFrozen(dsl4PreviewTransportLimits), true);
  assert.equal(dsl4PreviewTransportTokenBytes, 32);

  for (const invalidBindHost of ['0.0.0.0', 'localhost', '127.0.0.2', null]) {
    throwsCode(
      () =>
        createDsl4PreviewTransportPolicy(
          policyOptions({bindHost: invalidBindHost, origin: `http://${invalidBindHost}:4173`}),
        ),
      'K4-PREVIEW-TRANSPORT-BIND',
    );
  }
  for (const invalidOrigin of [
    'http://127.0.0.1:4174',
    'http://localhost:4173',
    'http://user@127.0.0.1:4173',
    'http://127.0.0.1:4173/path',
    'ws://127.0.0.1:4173',
    null,
  ]) {
    throwsCode(
      () => createDsl4PreviewTransportPolicy(policyOptions({origin: invalidOrigin})),
      'K4-PREVIEW-TRANSPORT-ORIGIN',
    );
  }

  assert.throws(
    () =>
      createDsl4PreviewTransportPolicy(
        policyOptions({tokenTtlMs: dsl4PreviewTransportLimits.maximumTokenTtlMs + 1}),
      ),
    /tokenTtlMs/u,
  );
  assert.throws(
    () =>
      createDsl4PreviewTransportPolicy(
        policyOptions({maxTokenRecords: dsl4PreviewTransportLimits.maximumTokenRecords + 1}),
      ),
    /maxTokenRecords/u,
  );
  assert.throws(
    () => createDsl4PreviewTransportPolicy(policyOptions({projectRoot: '/'})),
    /filesystem root/u,
  );
});

test('accepts canonical IPv4 and IPv6 loopback endpoints only', async () => {
  const ipv4 = createDsl4PreviewTransportPolicy(policyOptions());
  const ipv4Token = ipv4.issueToken().token;
  const ipv4Connection = ipv4.connect(request(ipv4Token, {remoteAddress: '127.42.0.9'}));
  assert.equal(ipv4Connection.getState().connected, true);
  await ipv4Connection.disconnect('graceful-stop');

  for (const remoteAddress of ['::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) {
    const ipv6 = createDsl4PreviewTransportPolicy(
      policyOptions({bindHost: '::1', origin: 'http://[::1]:4173'}),
    );
    const token = ipv6.issueToken().token;
    const connection = ipv6.connect({
      origin: 'http://[::1]:4173',
      remoteAddress,
      token,
    });
    assert.equal(connection.getState().connected, true);
    await connection.disconnect('transport-close');
  }
});

test('issues a single-use expiring token without exposing secrets in state', async () => {
  const events = [];
  const policy = createDsl4PreviewTransportPolicy(
    policyOptions({onDisconnect: (event) => events.push(event)}),
  );
  const issued = policy.issueToken();
  assert.deepEqual(issued, {
    version: 1,
    token: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    expiresAt: 1_100,
  });
  assert.equal(Object.isFrozen(issued), true);
  assert.deepEqual(policy.getState(), {
    version: 1,
    connected: false,
    connectedAt: null,
    pendingTokens: 1,
    consumedTokens: 0,
    disposed: false,
  });
  assert.doesNotMatch(JSON.stringify(policy.getState()), /AAAA|\/project|story\.kamishibai/u);

  const connection = policy.connect(request(issued.token));
  assert.deepEqual(policy.getState(), {
    version: 1,
    connected: true,
    connectedAt: 100,
    pendingTokens: 0,
    consumedTokens: 1,
    disposed: false,
  });
  const stopped = await connection.disconnect('transport-close');
  assert.deepEqual(stopped, {
    version: 1,
    connected: false,
    connectedAt: 100,
    lastReason: 'transport-close',
  });
  assert.deepEqual(events, [{version: 1, reason: 'transport-close'}]);
  assert.equal(Object.isFrozen(events[0]), true);
  throwsCode(() => policy.connect(request(issued.token)), 'K4-PREVIEW-TRANSPORT-TOKEN-REUSED');
});

test('rejects schema, Origin, remote, and token attacks without consuming a valid token', async () => {
  const policy = createDsl4PreviewTransportPolicy(policyOptions());
  const token = policy.issueToken().token;
  throwsCode(() => policy.connect(request(token, {extra: true})), 'K4-PREVIEW-TRANSPORT-SCHEMA');
  throwsCode(
    () => policy.connect(request(token, {origin: 'http://127.0.0.1:4174'})),
    'K4-PREVIEW-TRANSPORT-ORIGIN',
  );
  for (const remoteAddress of ['localhost', '192.168.1.2', '::ffff:192.168.1.2']) {
    throwsCode(
      () => policy.connect(request(token, {remoteAddress})),
      'K4-PREVIEW-TRANSPORT-REMOTE',
    );
  }
  throwsCode(
    () => policy.connect(request(token, {remoteAddress: null})),
    'K4-PREVIEW-TRANSPORT-REMOTE',
  );
  throwsCode(() => policy.connect(request(token, {token: null})), 'K4-PREVIEW-TRANSPORT-TOKEN');
  throwsCode(
    () => policy.connect(request('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')),
    'K4-PREVIEW-TRANSPORT-TOKEN',
  );
  assert.equal(policy.getState().pendingTokens, 1);

  const connection = policy.connect(request(token));
  assert.equal(connection.getState().connected, true);
  throwsCode(() => policy.connect(request(token)), 'K4-PREVIEW-TRANSPORT-ACTIVE');
  await connection.disconnect('graceful-stop');
});

test('expires and bounds token records and fails closed on clock or entropy faults', () => {
  let now = 10;
  const limited = createDsl4PreviewTransportPolicy(
    policyOptions({tokenTtlMs: 10, maxTokenRecords: 1, now: () => now}),
  );
  const expired = limited.issueToken().token;
  throwsCode(() => limited.issueToken(), 'K4-PREVIEW-TRANSPORT-TOKEN-LIMIT');
  now = 20;
  throwsCode(() => limited.connect(request(expired)), 'K4-PREVIEW-TRANSPORT-TOKEN-EXPIRED');
  assert.equal(limited.getState().pendingTokens, 0);
  limited.issueToken();
  now = 19;
  throwsCode(() => limited.issueToken(), 'K4-PREVIEW-TRANSPORT-CLOCK');

  const collision = createDsl4PreviewTransportPolicy(
    policyOptions({randomBytes: (size) => Buffer.alloc(size)}),
  );
  collision.issueToken();
  throwsCode(() => collision.issueToken(), 'K4-PREVIEW-TRANSPORT-TOKEN-COLLISION');

  for (const randomBytes of [
    () => Buffer.alloc(dsl4PreviewTransportTokenBytes - 1),
    () => 'not bytes',
    () => {
      throw new Error('entropy unavailable');
    },
  ]) {
    const invalidEntropy = createDsl4PreviewTransportPolicy(policyOptions({randomBytes}));
    throwsCode(() => invalidEntropy.issueToken(), 'K4-PREVIEW-TRANSPORT-TOKEN');
  }
});

test('authorizes only the manifest path while a connection is active', async () => {
  const policy = createDsl4PreviewTransportPolicy(policyOptions());
  const connection = policy.connect(request(policy.issueToken().token));
  const authorization = connection.authorizeSourceRead(manifest.path);
  assert.deepEqual(authorization, {projectRoot: '/project', manifest});
  assert.equal(Object.isFrozen(authorization), true);

  for (const sourcePath of [
    'other.kamishibai.yaml',
    'scripts/story.kamishibai.yaml',
    '../story.kamishibai.yaml',
    '/project/story.kamishibai.yaml',
    'https://example.com/story.kamishibai.yaml',
  ]) {
    throwsCode(() => connection.authorizeSourceRead(sourcePath), 'K4-PREVIEW-TRANSPORT-PATH');
  }
  await connection.disconnect('host-crash');
  throwsCode(
    () => connection.authorizeSourceRead(manifest.path),
    'K4-PREVIEW-TRANSPORT-DISCONNECTED',
  );
});

test('converges every close cause on one immutable disconnect callback', async () => {
  for (const reason of ['graceful-stop', 'host-crash', 'transport-close']) {
    const events = [];
    const policy = createDsl4PreviewTransportPolicy(
      policyOptions({onDisconnect: (event) => events.push(event)}),
    );
    const connection = policy.connect(request(policy.issueToken().token));
    const first = connection.disconnect(reason);
    const second = connection.disconnect('graceful-stop');
    assert.strictEqual(second, first);
    const state = await first;
    assert.equal(state.lastReason, reason);
    assert.deepEqual(events, [{version: 1, reason}]);
    assert.equal(Object.isFrozen(events[0]), true);
  }
});

test('publishes the disconnecting state before invoking a reentrant callback', async () => {
  let reentrantCode = null;
  let policy;
  policy = createDsl4PreviewTransportPolicy(
    policyOptions({
      onDisconnect() {
        try {
          policy.issueToken();
        } catch (error) {
          reentrantCode = error.code;
        }
      },
    }),
  );
  const connection = policy.connect(request(policy.issueToken().token));
  await connection.disconnect('transport-close');
  assert.equal(reentrantCode, 'K4-PREVIEW-TRANSPORT-DISCONNECTING');
  assert.equal(policy.issueToken().version, 1);
});

test('uses the disconnect callback to tear down the protocol before a new session handshake', async () => {
  let discardedCandidates = 0;
  const state = Object.freeze({disposed: false, generation: 0, current: null});
  const protocol = createDsl4PreviewProtocolSession({
    liveReloadSession: {
      stage() {
        throw new Error('not used');
      },
      defer() {
        throw new Error('not used');
      },
      commit() {
        throw new Error('not used');
      },
      discardCandidate() {
        discardedCandidates += 1;
        return state;
      },
      getState: () => state,
      whenIdle: () => Promise.resolve(state),
    },
  });
  let sessionId = 'client-a';
  const handshake = () =>
    protocol.handshake({
      type: 'preview.handshake',
      protocolVersion: dsl4PreviewProtocolVersion,
      sessionId,
      capabilities: dsl4PreviewRequiredCapabilities,
    });
  await handshake();

  const policy = createDsl4PreviewTransportPolicy(
    policyOptions({
      onDisconnect: () => protocol.disconnect({type: 'preview.disconnect', sessionId}),
    }),
  );
  const first = policy.connect(request(policy.issueToken().token));
  await first.disconnect('host-crash');
  assert.equal(protocol.getState().connected, false);
  assert.equal(discardedCandidates, 1);
  await assert.rejects(
    protocol.stage({type: 'preview.source.stage', sessionId, revision: 1, result: {}}),
    (error) => error.code === 'K4-PREVIEW-PROTOCOL-DISCONNECTED',
  );

  const second = policy.connect(request(policy.issueToken().token));
  sessionId = 'client-b';
  await handshake();
  assert.equal(protocol.getState().sessionId, 'client-b');
  assert.equal(protocol.getState().latestRevision, 0);
  await second.disconnect('transport-close');
  assert.equal(discardedCandidates, 2);
});

test('dispose and an in-flight close share one callback and settle before disposal', async () => {
  let release;
  let callbackCalls = 0;
  const callbackGate = new Promise((resolve) => {
    release = resolve;
  });
  const policy = createDsl4PreviewTransportPolicy(
    policyOptions({
      async onDisconnect() {
        callbackCalls += 1;
        await callbackGate;
      },
    }),
  );
  const connection = policy.connect(request(policy.issueToken().token));
  const disconnecting = connection.disconnect('host-crash');
  throwsCode(() => policy.issueToken(), 'K4-PREVIEW-TRANSPORT-DISCONNECTING');
  const disposing = policy.dispose();
  await Promise.resolve();
  assert.equal(callbackCalls, 1);
  assert.deepEqual(policy.getState(), {
    version: 1,
    connected: false,
    connectedAt: null,
    pendingTokens: 0,
    consumedTokens: 0,
    disposed: true,
  });
  release();
  await Promise.all([disconnecting, disposing]);
  assert.equal(callbackCalls, 1);
  assert.strictEqual(policy.dispose(), disposing);
  assert.strictEqual(connection.disconnect('graceful-stop'), disconnecting);
  throwsCode(() => policy.issueToken(), 'K4-PREVIEW-TRANSPORT-DISPOSED');
  throwsCode(
    () => policy.connect(request('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')),
    'K4-PREVIEW-TRANSPORT-DISPOSED',
  );
});

test('dispose initiates graceful disconnect and callback failures remain machine-readable', async () => {
  const events = [];
  const policy = createDsl4PreviewTransportPolicy(
    policyOptions({onDisconnect: (event) => events.push(event)}),
  );
  policy.connect(request(policy.issueToken().token));
  assert.equal((await policy.dispose()).disposed, true);
  assert.deepEqual(events, [{version: 1, reason: 'graceful-stop'}]);

  const failing = createDsl4PreviewTransportPolicy(
    policyOptions({
      onDisconnect() {
        throw new Error('protocol unavailable');
      },
    }),
  );
  const connection = failing.connect(request(failing.issueToken().token));
  const disconnecting = connection.disconnect('transport-close');
  await rejectsCode(disconnecting, 'K4-PREVIEW-TRANSPORT-DISCONNECT');
  await rejectsCode(connection.disconnect('graceful-stop'), 'K4-PREVIEW-TRANSPORT-DISCONNECT');
  assert.equal(connection.getState().connected, false);
  throwsCode(() => failing.issueToken(), 'K4-PREVIEW-TRANSPORT-DISCONNECT');
});
