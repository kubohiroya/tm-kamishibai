import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {test} from 'vitest';
import {createDsl4SourceFrontend} from '../src/dsl4/source-frontend.js';
import {
  createDsl4LiveReloadSession,
  type LiveReloadRuntimeSession,
} from '../src/dsl4/live-reload-session.js';
import {createDsl4PreviewProtocolSession} from '../src/dsl4/preview-protocol.js';
import {createDsl4PreviewSourceProtocolPort} from '../src/dsl4/preview-source-protocol-port.js';
import {createDsl4BrowserPreviewRuntimeBridge} from '../src/dsl4/browser-preview-runtime-bridge.js';
import {createDsl4BrowserPreviewCoordinator} from '../src/dsl4/browser-preview-coordinator.js';
import {createDsl4BrowserPreviewSourceAdapter} from '../src/dsl4/browser-preview-source-adapter.js';
import {createDsl4PreviewSourceGenerationWire} from '../src/dsl4/preview-source-generation-wire.js';
import {createDsl4CreationCleanup, Dsl4CreationFailure} from '../src/dsl4/creation-cleanup.js';
import {deferred, waitUntil, withDeadline, flushMicrotasks} from './helpers/async-test-helpers.ts';
import {requireRecord} from './helpers/require-value.ts';

const schema = JSON.parse(
  await readFile(new URL('../schema/dsl-4.schema.json', import.meta.url), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const parsed = frontend.parse(
  "kamishibai: '4.0'\nvariables: {}\nscenes:\n  opening:\n    - wait: 1\n",
  {sourceId: 'main'},
);
assert(parsed.ok);
const storyDocument = parsed.storyDocument;
const result = {
  ...parsed,
  sourceSnapshot: {
    sourceId: 'main',
    text: parsed.canonicalSource,
    byteLength: new TextEncoder().encode(parsed.canonicalSource).length,
    integrity: `sha256-${'a'.repeat(43)}=`,
  },
};

function runtime(overrides: Partial<LiveReloadRuntimeSession> = {}): LiveReloadRuntimeSession {
  let status = 'running';
  return {
    start: async () => {
      status = 'running';
    },
    stop: () => {
      status = 'stopped';
    },
    dispose: () => {},
    getState: () => ({
      runtime: {
        status,
        sceneId: 'opening',
        actionIndex: 0,
        actionPath: '/scenes/opening/actions/0',
        variables: {...requireRecord(storyDocument.variables, 'the story variables')},
      },
    }),
    quiesce: ({candidateId}) => ({
      kind: 'Dsl4QuiesceToken',
      version: 1,
      candidateId,
      runtimeGeneration: 1,
      storyPath: '/scenes/opening/actions/0',
      sceneId: 'opening',
      actionIndex: 0,
      variables: {...requireRecord(storyDocument.variables, 'the story variables')},
      resumeMode: 'replay-action',
      actionSignature: {command: 'wait', handler: 'core', target: null},
    }),
    resumeQuiesce: () => {},
    ...overrides,
  };
}

function protocolFixture() {
  return {
    handshake: async (message: {sessionId: string; capabilities: string[]}) => ({
      type: 'preview.handshake.ack',
      sessionId: message.sessionId,
      capabilities: message.capabilities,
    }),
    stage: async (message: {sessionId: string; revision: number}) => ({
      type: 'preview.source.staged',
      sessionId: message.sessionId,
      revision: message.revision,
      status: 'active',
      candidate: null,
    }),
    commit: async () => ({}),
    defer: async () => ({}),
    disconnect: async (message: {sessionId: string}) => ({
      type: 'preview.disconnected',
      sessionId: message.sessionId,
    }),
    getState: () => ({}),
    whenIdle: async () => {},
  };
}

test('live reload retains stop and dispose failures, closes immediately, and joins synchronous reentry', async () => {
  let stops = 0,
    releases = 0;
  let reentrant: unknown;
  const gate = deferred();
  const live = createDsl4LiveReloadSession({
    initialStoryDocument: storyDocument,
    initialSession: runtime({
      stop() {
        stops++;
        reentrant = live.dispose();
        if (stops === 1) throw new Error('stop failed');
      },
      async dispose() {
        releases++;
        await gate.promise;
        if (releases === 1) throw new Error('release failed');
      },
    }),
    createSession: () => runtime(),
  });
  const attempt = live.dispose();
  assert.strictEqual(live.dispose(), attempt);
  await assert.rejects(live.invokeAction({}), /disposed/);
  await waitUntil(() => releases === 1);
  assert.strictEqual(reentrant, attempt);
  gate.resolve();
  await assert.rejects(attempt, /disposal failed/);
  assert(live.hasPendingCleanup());
  assert(live.getState().hasCurrent);
  await live.dispose();
  assert.deepEqual([stops, releases], [2, 2]);
  assert.equal(live.hasPendingCleanup(), false);
  assert.equal(live.getState().hasCurrent, false);
  await live.dispose();
  assert.deepEqual([stops, releases], [2, 2]);
});

test('successful live reload stop is not repeated when only disposal needs retry', async () => {
  let stops = 0,
    releases = 0;
  const live = createDsl4LiveReloadSession({
    initialStoryDocument: storyDocument,
    initialSession: runtime({
      stop() {
        stops++;
      },
      dispose() {
        if (++releases === 1) throw new Error('release failed');
      },
    }),
    createSession: () => runtime(),
  });
  await assert.rejects(live.dispose());
  await live.dispose();
  assert.deepEqual([stops, releases], [1, 2]);
});

test('dispose owns a late factory result without starting it and retries failed cleanup', async () => {
  const gate = deferred<LiveReloadRuntimeSession>();
  let entered = false,
    starts = 0,
    releases = 0;
  const live = createDsl4LiveReloadSession({
    createSession: () => {
      entered = true;
      return gate.promise;
    },
  });
  const staging = live.stage(result);
  const rejected = assert.rejects(staging, /disposed/);
  await waitUntil(() => entered);
  const disposal = live.dispose();
  gate.resolve(
    runtime({
      start: async () => {
        starts++;
      },
      dispose() {
        if (++releases === 1) throw new Error('late failed');
      },
    }),
  );
  await rejected;
  await assert.rejects(disposal);
  assert.equal(starts, 0);
  assert.equal(releases, 1);
  await live.dispose();
  assert.equal(releases, 2);
  assert.equal(live.hasPendingCleanup(), false);
});

test('invalid factory result retains its disposable owner after validation cleanup failure', async () => {
  let releases = 0;
  const invalid = {
    dispose() {
      if (++releases === 1) throw new Error('invalid release');
    },
  } as unknown as LiveReloadRuntimeSession;
  const live = createDsl4LiveReloadSession({createSession: () => invalid});
  await assert.rejects(live.stage(result), /cleanup failed/);
  assert.equal(releases, 1);
  await live.dispose();
  assert.equal(releases, 2);
  assert.equal(live.hasPendingCleanup(), false);
});

test('initial synchronous start failure retains the runtime for explicit cleanup retry', async () => {
  let releases = 0;
  const live = createDsl4LiveReloadSession({
    createSession: () =>
      runtime({
        start() {
          throw new Error('start failed');
        },
        dispose() {
          if (++releases === 1) throw new Error('release failed');
        },
      }),
  });
  await assert.rejects(live.stage(result), /start and cleanup failed/);
  assert.equal(releases, 1);
  await live.dispose();
  assert.equal(releases, 2);
});

test('failed factory creation cleanup joins its initial completion and later retries explicitly', async () => {
  let releases = 0;
  const child = createDsl4CreationCleanup(
    [
      () => {
        if (++releases === 1) throw new Error('factory release');
      },
    ],
    'factory cleanup',
  );
  const initial = child.dispose();
  await assert.rejects(initial);
  const live = createDsl4LiveReloadSession({
    createSession() {
      throw new Dsl4CreationFailure(new Error('prepare failed'), child, 'factory failed');
    },
  });
  await assert.rejects(live.stage(result), /factory failed/);
  assert.equal(releases, 1);
  await live.dispose();
  assert.equal(releases, 2);
  assert.equal(live.hasPendingCleanup(), false);
});

test('failed replacement retains both old and candidate owners until explicit disposal', async () => {
  let oldReleases = 0,
    nextReleases = 0;
  const live = createDsl4LiveReloadSession({
    initialStoryDocument: storyDocument,
    initialSession: runtime({
      dispose() {
        if (++oldReleases === 1) throw new Error('old release');
      },
    }),
    createSession: () =>
      runtime({
        dispose() {
          if (++nextReleases === 1) throw new Error('candidate release');
        },
      }),
  });
  const staged = await live.stage(result);
  assert(staged.candidate);
  await assert.rejects(live.commit(staged.candidate.id, 'storyStart'), /commit and cleanup failed/);
  assert.deepEqual([oldReleases, nextReleases], [1, 1]);
  await live.dispose();
  assert.deepEqual([oldReleases, nextReleases], [2, 2]);
  assert.equal(live.hasPendingCleanup(), false);
});

test('dispose during old runtime cleanup closes the candidate without starting it', async () => {
  const gate = deferred();
  let oldEntered = false,
    starts = 0,
    nextReleases = 0;
  const live = createDsl4LiveReloadSession({
    initialStoryDocument: storyDocument,
    initialSession: runtime({
      async dispose() {
        oldEntered = true;
        await gate.promise;
      },
    }),
    createSession: () =>
      runtime({
        start: async () => {
          starts++;
        },
        dispose() {
          nextReleases++;
        },
      }),
  });
  const staged = await live.stage(result);
  assert(staged.candidate);
  const committing = live.commit(staged.candidate.id, 'storyStart');
  const rejected = assert.rejects(committing, /disposed/);
  await waitUntil(() => oldEntered);
  const disposal = live.dispose();
  gate.resolve();
  await Promise.all([rejected, disposal]);
  assert.deepEqual([starts, nextReleases], [0, 1]);
  assert.equal(live.getState().status, 'disposed');
});

for (const failure of ['throw', 'invalid-ack'] as const) {
  test(`port retries ${failure} disconnect failures and joins synchronous reentry`, async () => {
    const protocol = protocolFixture();
    let calls = 0;
    let reentrant: unknown;
    protocol.disconnect = async (message) => {
      reentrant = port.dispose();
      if (++calls === 1) {
        if (failure === 'throw') throw new Error('disconnect failed');
        return {type: 'wrong', sessionId: message.sessionId};
      }
      return {type: 'preview.disconnected', sessionId: message.sessionId};
    };
    const port = createDsl4PreviewSourceProtocolPort({
      protocolSession: protocol,
      sessionId: 'retry',
    });
    await port.connect();
    const attempt = port.dispose();
    assert.strictEqual(port.dispose(), attempt);
    await assert.rejects(attempt);
    assert.strictEqual(reentrant, attempt);
    assert(port.hasPendingCleanup());
    assert.throws(() => port.stage(result), /disposed/);
    await port.dispose();
    assert.equal(calls, 2);
    assert.equal(port.hasPendingCleanup(), false);
    await port.dispose();
    assert.equal(calls, 2);
  });
}

test('port waits for pending handshake then disconnects its late connection', async () => {
  const gate = deferred();
  let connections = 0,
    disconnects = 0;
  const protocol = protocolFixture();
  protocol.handshake = async (message) => {
    await gate.promise;
    connections++;
    return {
      type: 'preview.handshake.ack',
      sessionId: message.sessionId,
      capabilities: message.capabilities,
    };
  };
  protocol.disconnect = async (message) => {
    disconnects++;
    connections--;
    return {type: 'preview.disconnected', sessionId: message.sessionId};
  };
  const port = createDsl4PreviewSourceProtocolPort({protocolSession: protocol, sessionId: 'late'});
  const connecting = port.connect();
  const disposal = port.dispose();
  gate.resolve();
  await Promise.all([connecting, disposal]);
  assert.deepEqual([connections, disconnects], [0, 1]);
  assert.equal(port.getState().status, 'disposed');
});

test('real bridge/protocol/live reload retains runtime failure without resuming a closing runtime', async () => {
  let releases = 0,
    resumes = 0;
  const bridge = createDsl4BrowserPreviewRuntimeBridge({
    sessionId: 'bridge-retry',
    createSession: () =>
      runtime({
        resumeQuiesce() {
          if (++resumes === 1) throw new Error('resume failed');
        },
        dispose() {
          if (++releases === 1) throw new Error('release failed');
        },
      }),
  });
  await bridge.start();
  const record = (revision: number) => ({
    sequence: revision,
    type: 'local-preview.generation',
    generation: createDsl4PreviewSourceGenerationWire({revision, result}),
  });
  await bridge.accept(record(1));
  await bridge.accept(record(2));
  await assert.rejects(bridge.dispose());
  assert.equal(releases, 1);
  assert(bridge.hasPendingCleanup());
  assert.throws(() => bridge.start(), /disposed/);
  await bridge.dispose();
  assert.equal(releases, 2);
  assert.equal(resumes, 0);
  assert.equal(bridge.hasPendingCleanup(), false);
  assert.equal(bridge.getState().status, 'disposed');
});

function browserResources() {
  let now = 0,
    clears = 0;
  let failTimer = false,
    failListener = false;
  let onClear = () => {};
  const timers = new Set<{callback: () => void}>();
  const listeners = new Map<string, unknown>();
  const removals: string[] = [];
  const clock = {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    },
    setTimeout(callback: () => void) {
      const handle = {callback};
      timers.add(handle);
      return handle;
    },
    clearTimeout(handle: unknown) {
      clears++;
      onClear();
      if (failTimer) throw new Error('timer failed');
      timers.delete(handle as {callback: () => void});
    },
  };
  const document = {
    visibilityState: 'visible',
    hidden: false,
    addEventListener(type: string, listener: unknown) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string) {
      removals.push(type);
      if (failListener && type === 'visibilitychange') throw new Error('listener failed');
      listeners.delete(type);
    },
  };
  const file = (text: string) => ({
    kind: 'file',
    getFile: async () => {
      const bytes = new TextEncoder().encode(text);
      return {size: bytes.length, arrayBuffer: async () => bytes.buffer};
    },
  });
  const root = {
    kind: 'directory',
    queryPermission: async () => 'granted',
    getDirectoryHandle: async () => {
      throw Object.assign(new Error('missing'), {name: 'NotFoundError'});
    },
    getFileHandle: async (name: string) => {
      if (name === 'project.source.json')
        return file(
          JSON.stringify({
            formatVersion: 1,
            mode: 'external',
            sourceId: 'main',
            path: 'story.kamishibai.yaml',
          }),
        );
      if (name === 'story.kamishibai.yaml') return file("kamishibai: '4.0'\nscenes: {}\n");
      throw Object.assign(new Error('missing'), {name: 'NotFoundError'});
    },
  };
  return {
    clock,
    document,
    root,
    timers,
    listeners,
    removals,
    get clears() {
      return clears;
    },
    fail(timer: boolean, listener: boolean) {
      failTimer = timer;
      failListener = listener;
    },
    onClear(callback: () => void) {
      onClear = callback;
    },
  };
}

test('source timer/listener failures stay owned independently without retrying successful steps', async () => {
  const resources = browserResources();
  const source = createDsl4BrowserPreviewSourceAdapter({
    sourceFrontend: frontend,
    maxSourceBytes: 4096,
    clock: resources.clock,
    document: resources.document,
    subtleCrypto: webcrypto.subtle,
    onResult: () => {},
  });
  await source.start(resources.root);
  resources.fail(true, true);
  let reentries = 0;
  resources.onClear(() => {
    reentries++;
    source.dispose();
  });
  assert.throws(() => source.dispose(), /cleanup failed/);
  assert.equal(reentries, 1);
  assert(source.hasPendingCleanup());
  assert.equal(resources.listeners.has('pagehide'), false);
  assert.equal(resources.listeners.has('visibilitychange'), true);
  assert.throws(() => source.pollNow(), /not active/);
  resources.fail(false, false);
  source.dispose();
  assert.equal(source.hasPendingCleanup(), false);
  assert.equal(resources.timers.size, 0);
  assert.equal(resources.listeners.size, 0);
  assert.equal(resources.removals.filter((t) => t === 'pagehide').length, 1);
});

test('coordinator continues protocol disposal after source cleanup failure and retries source only', async () => {
  const resources = browserResources();
  const protocol = protocolFixture();
  let disconnects = 0;
  const disconnect = protocol.disconnect;
  protocol.disconnect = async (message) => {
    disconnects++;
    return disconnect(message);
  };
  const coordinator = createDsl4BrowserPreviewCoordinator({
    protocolSession: protocol,
    sessionId: 'coordinator-retry',
    sourceFrontend: frontend,
    maxSourceBytes: 4096,
    sourceOptions: {
      clock: resources.clock,
      document: resources.document,
      subtleCrypto: webcrypto.subtle,
    },
  });
  await coordinator.start(resources.root);
  resources.fail(true, true);
  let reentrant: unknown;
  resources.onClear(() => {
    reentrant = coordinator.dispose();
  });
  const disposal = coordinator.dispose();
  await assert.rejects(disposal);
  assert.strictEqual(reentrant, disposal);
  assert.equal(disconnects, 1);
  assert(coordinator.hasPendingCleanup());
  resources.fail(false, false);
  await coordinator.dispose();
  assert.equal(disconnects, 1);
  assert.equal(coordinator.hasPendingCleanup(), false);
  assert.equal(resources.listeners.size, 0);
});

test('source start waiting for project publication cannot attach after disposal', async () => {
  const resources = browserResources();
  const gate = deferred();
  const source = createDsl4BrowserPreviewSourceAdapter({
    sourceFrontend: frontend,
    maxSourceBytes: 4096,
    clock: resources.clock,
    document: resources.document,
    onProjectRoot: () => gate.promise,
    onResult: () => {},
  });
  const starting = source.start(resources.root);
  source.dispose();
  gate.resolve();
  await assert.rejects(starting, /disposed/);
  assert.equal(resources.listeners.size, 0);
  assert.equal(resources.timers.size, 0);
  assert.equal(source.hasPendingCleanup(), false);
});

test('protocol can release its connection after the runtime has already been disposed', async () => {
  let resumes = 0;
  const live = createDsl4LiveReloadSession({
    createSession: () =>
      runtime({
        resumeQuiesce() {
          resumes++;
          throw new Error('resume failed');
        },
      }),
  });
  const protocol = createDsl4PreviewProtocolSession({liveReloadSession: live});
  const port = createDsl4PreviewSourceProtocolPort({
    protocolSession: protocol,
    sessionId: 'protocol-retry',
  });
  await port.connect();
  await port.stage(result);
  await port.stage(result);
  await assert.rejects(port.dispose());
  await live.dispose();
  await port.dispose();
  assert.equal(resumes, 1);
  assert.equal(port.hasPendingCleanup(), false);
  assert.equal(protocol.getState().connected, false);
});

test('bridge disposal stops the runtime while protocol staging is waiting for quiesce', async () => {
  const quiescing = deferred();
  const token = deferred<unknown>();
  let releases = 0;
  const base = runtime();
  const bridge = createDsl4BrowserPreviewRuntimeBridge({
    sessionId: 'quiesce-dispose',
    createSession: () =>
      runtime({
        quiesce(request) {
          quiescing.resolve();
          return token.promise.then(() => base.quiesce(request));
        },
        stop() {
          token.resolve(undefined);
        },
        dispose() {
          releases++;
        },
      }),
  });
  await bridge.start();
  const record = (revision: number) => ({
    sequence: revision,
    type: 'local-preview.generation',
    generation: createDsl4PreviewSourceGenerationWire({revision, result}),
  });
  await bridge.accept(record(1));
  const staging = bridge.accept(record(2));
  const observed = staging.catch(() => {});
  await quiescing.promise;
  await bridge.dispose();
  await observed;
  assert.equal(releases, 1);
  assert.equal(bridge.getState().status, 'disposed');
  assert.equal(bridge.hasPendingCleanup(), false);
});

test('child pending-cleanup inspection remains reachable after a successful disposal promise', async () => {
  let releases = 0;
  const live = createDsl4LiveReloadSession({
    initialStoryDocument: storyDocument,
    initialSession: runtime({
      dispose() {
        releases++;
      },
      hasPendingCleanup: () => releases < 2,
    }),
    createSession: () => runtime(),
  });
  await live.dispose();
  assert(live.hasPendingCleanup());
  await live.dispose();
  assert.equal(releases, 2);
  assert.equal(live.hasPendingCleanup(), false);
});

test('late commit acknowledgement cannot reopen a disposed protocol port', async () => {
  const gate = deferred();
  const entered = deferred();
  const protocol = protocolFixture();
  protocol.stage = async (message) =>
    ({
      type: 'preview.source.staged',
      sessionId: message.sessionId,
      revision: message.revision,
      status: 'pending',
      candidate: {id: 1, options: {}},
    }) as unknown as Awaited<ReturnType<typeof protocol.stage>>;
  protocol.commit = async () => {
    entered.resolve();
    await gate.promise;
    return {
      type: 'preview.source.committed',
      sessionId: 'late-commit',
      revision: 1,
      candidateId: 1,
      choice: 'storyStart',
    };
  };
  const port = createDsl4PreviewSourceProtocolPort({
    protocolSession: protocol,
    sessionId: 'late-commit',
  });
  await port.connect();
  await port.stage(result);
  const committing = port.commit('storyStart');
  await entered.promise;
  const disposal = port.dispose();
  gate.resolve();
  await Promise.all([committing, disposal]);
  assert.equal(port.getState().status, 'disposed');
  assert.equal(port.getState().connected, false);
});

test('coordinator waiting for handshake cannot start a source after disposal', async () => {
  const resources = browserResources();
  const gate = deferred();
  const protocol = protocolFixture();
  const handshake = protocol.handshake;
  protocol.handshake = async (message) => {
    await gate.promise;
    return handshake(message);
  };
  const coordinator = createDsl4BrowserPreviewCoordinator({
    protocolSession: protocol,
    sessionId: 'late-source',
    sourceFrontend: frontend,
    maxSourceBytes: 4096,
    sourceOptions: {clock: resources.clock, document: resources.document},
  });
  const starting = coordinator.start(resources.root);
  const rejected = assert.rejects(starting, /disposed/);
  const disposal = coordinator.dispose();
  gate.resolve();
  await Promise.all([rejected, disposal]);
  assert.equal(resources.listeners.size, 0);
  assert.equal(resources.timers.size, 0);
  assert.equal(coordinator.hasPendingCleanup(), false);
});

test('partially registered source listeners are retained when addEventListener throws', async () => {
  const resources = browserResources();
  const add = resources.document.addEventListener;
  resources.document.addEventListener = (type, listener) => {
    add(type, listener);
    if (type === 'pagehide') throw new Error('partial listener');
  };
  const source = createDsl4BrowserPreviewSourceAdapter({
    sourceFrontend: frontend,
    maxSourceBytes: 4096,
    document: resources.document,
    clock: resources.clock,
    onResult: () => {},
  });
  await assert.rejects(source.start(resources.root), /partial listener/);
  resources.fail(false, true);
  assert.throws(() => source.dispose(), /cleanup failed/);
  assert.equal(resources.listeners.has('pagehide'), false);
  resources.fail(false, false);
  source.dispose();
  assert.equal(resources.listeners.size, 0);
  assert.equal(source.hasPendingCleanup(), false);
});

for (const replacement of [false, true]) {
  test(`start callback disposal cannot publish ${replacement ? 'replacement' : 'initial'} runtime as active`, async () => {
    let disposal: Promise<unknown> | undefined;
    let releases = 0;
    const live = createDsl4LiveReloadSession({
      ...(replacement ? {initialStoryDocument: storyDocument, initialSession: runtime()} : {}),
      createSession: () =>
        runtime({
          start() {
            disposal = live.dispose();
            return Promise.resolve();
          },
          dispose() {
            releases++;
          },
        }),
    });
    if (replacement) {
      const staged = await live.stage(result);
      assert(staged.candidate);
      await assert.rejects(live.commit(staged.candidate.id, 'storyStart'), /disposed/);
    } else await assert.rejects(live.stage(result), /disposed/);
    assert(disposal);
    await disposal;
    assert.equal(releases, 1);
    assert.equal(live.getState().status, 'disposed');
    assert.equal(live.getState().hasCurrent, false);
  });
}

test('a source stage queued just before disposal never enters the transport', async () => {
  const protocol = protocolFixture();
  let stages = 0;
  const stage = protocol.stage;
  protocol.stage = async (message) => {
    stages++;
    return stage(message);
  };
  const port = createDsl4PreviewSourceProtocolPort({
    protocolSession: protocol,
    sessionId: 'queued-stage',
  });
  await port.connect();
  const staging = port.stage(result);
  const rejected = assert.rejects(staging, /disposed/);
  await Promise.all([rejected, port.dispose()]);
  assert.equal(stages, 0);
});

test('source status observer may reenter disposal without recursive notifications', async () => {
  const resources = browserResources();
  let disposalNotices = 0;
  const source = createDsl4BrowserPreviewSourceAdapter({
    sourceFrontend: frontend,
    maxSourceBytes: 4096,
    clock: resources.clock,
    document: resources.document,
    onResult: () => {},
    onStatus(state) {
      if (state.disposed) {
        disposalNotices++;
        source.dispose();
      }
    },
  });
  await source.start(resources.root);
  source.dispose();
  assert.equal(disposalNotices, 1);
  assert.equal(source.hasPendingCleanup(), false);
});

test('a polling timer left after clear failure stays inert when it fires after disposal', async () => {
  const resources = browserResources();
  const source = createDsl4BrowserPreviewSourceAdapter({
    sourceFrontend: frontend,
    maxSourceBytes: 4096,
    clock: resources.clock,
    document: resources.document,
    subtleCrypto: webcrypto.subtle,
    onResult: () => {},
  });
  await source.start(resources.root);
  resources.fail(true, false);
  assert.throws(() => source.dispose(), /cleanup failed/);
  for (const timer of resources.timers) {
    resources.timers.delete(timer);
    assert.doesNotThrow(() => timer.callback());
  }
  assert.equal(resources.timers.size, 0);
  resources.fail(false, false);
  source.dispose();
  assert.equal(source.hasPendingCleanup(), false);
});

test('replacement stop in flight joins disposal without repeating a successful stop', async () => {
  const gate = deferred();
  const entered = deferred();
  let stops = 0,
    oldReleases = 0,
    nextReleases = 0;
  const live = createDsl4LiveReloadSession({
    initialStoryDocument: storyDocument,
    initialSession: runtime({
      async stop() {
        stops++;
        entered.resolve();
        await gate.promise;
      },
      dispose() {
        oldReleases++;
      },
    }),
    createSession: () =>
      runtime({
        dispose() {
          nextReleases++;
        },
      }),
  });
  const staged = await live.stage(result);
  assert(staged.candidate);
  const committing = live.commit(staged.candidate.id, 'storyStart');
  const rejected = assert.rejects(committing, /disposed/);
  await entered.promise;
  const disposal = live.dispose();
  gate.resolve();
  await Promise.all([rejected, disposal]);
  assert.deepEqual([stops, oldReleases, nextReleases], [1, 1, 1]);
});

function candidateProtocol() {
  return {
    ...protocolFixture(),
    stage: async (message: {sessionId: string; revision: number}) => ({
      type: 'preview.source.staged',
      sessionId: message.sessionId,
      revision: message.revision,
      status: 'pending',
      candidate: {id: 1, options: {}},
    }),
    commit: async (message: {
      sessionId: string;
      revision: number;
      candidateId: number;
      choice: string;
    }) => ({...message, type: 'preview.source.committed'}),
    defer: async (message: {sessionId: string; revision: number; candidateId: number}) => ({
      ...message,
      type: 'preview.source.deferred',
    }),
  };
}

for (const operation of ['connect', 'stage', 'commit', 'defer', 'disconnect'] as const) {
  test(`event observer can await dispose from ${operation} without waiting on itself`, async () => {
    const protocol = candidateProtocol();
    const eventType = {
      connect: 'preview.handshake.ack',
      stage: 'preview.source.staged',
      commit: 'preview.source.committed',
      defer: 'preview.source.deferred',
      disconnect: 'preview.disconnected',
    }[operation];
    const callbackDone = deferred();
    let armed = operation === 'connect';
    let nested: Promise<unknown> | undefined;
    const port = createDsl4PreviewSourceProtocolPort({
      protocolSession: protocol,
      sessionId: `event-${operation}`,
      async onEvent(event) {
        if (armed && event.type === eventType) {
          armed = false;
          nested = port.dispose();
          await nested;
          callbackDone.resolve();
        }
      },
    });
    if (operation !== 'connect') await port.connect();
    if (operation === 'commit' || operation === 'defer') await port.stage(result);
    armed = true;
    const pending =
      operation === 'connect'
        ? port.connect()
        : operation === 'stage'
          ? port.stage(result)
          : operation === 'commit'
            ? port.commit('storyStart')
            : operation === 'defer'
              ? port.defer()
              : port.disconnect();
    await withDeadline(
      Promise.all([pending, callbackDone.promise]),
      `dispose from ${operation} notification`,
      1000,
    );
    assert(nested);
    await nested;
    assert.equal(port.getState().status, 'disposed');
    assert.equal(port.hasPendingCleanup(), false);
  });
}

test('ordinary stage still awaits its observer until disposal is requested', async () => {
  const entered = deferred(),
    gate = deferred();
  const port = createDsl4PreviewSourceProtocolPort({
    protocolSession: candidateProtocol(),
    sessionId: 'ordinary-notice',
    async onEvent(event) {
      if (event.type === 'preview.source.staged') {
        entered.resolve();
        await gate.promise;
      }
    },
  });
  await port.connect();
  let finished = false;
  const staging = port.stage(result).then(() => {
    finished = true;
  });
  await entered.promise;
  await flushMicrotasks();
  assert.equal(finished, false);
  gate.resolve();
  await staging;
  assert.equal(finished, true);
  await port.dispose();
});

test('late observer failure after disposal is still reported and does not block cleanup', async () => {
  const entered = deferred(),
    gate = deferred();
  const failure = new Error('late observer failure');
  const errors: unknown[] = [];
  const port = createDsl4PreviewSourceProtocolPort({
    protocolSession: candidateProtocol(),
    sessionId: 'late-notice-error',
    onError: (error) => {
      errors.push(error);
    },
    async onEvent(event) {
      if (event.type === 'preview.source.staged') {
        entered.resolve();
        await gate.promise;
        throw failure;
      }
    },
  });
  await port.connect();
  const staging = port.stage(result);
  await entered.promise;
  try {
    await withDeadline(
      Promise.all([staging, port.dispose()]),
      'dispose before observer completion',
      1000,
    );
  } finally {
    gate.resolve();
  }
  await waitUntil(() => errors.includes(failure));
  assert.deepEqual(errors, [failure]);
  assert.equal(port.hasPendingCleanup(), false);
});

test('bridge event may await a failing dispose and then retry only its failed runtime', async () => {
  let releases = 0;
  const callbackEntered = deferred(),
    callbackDone = deferred();
  let nested: Promise<unknown> | undefined;
  let notificationFailure: unknown;
  const bridge = createDsl4BrowserPreviewRuntimeBridge({
    sessionId: 'bridge-notice-retry',
    createSession: () =>
      runtime({
        dispose() {
          if (++releases === 1) throw new Error('release from observer failed');
        },
      }),
    async onEvent(event) {
      if (event.type === 'preview.source.staged') {
        nested = bridge.dispose();
        callbackEntered.resolve();
        try {
          await nested;
        } catch (error) {
          notificationFailure = error;
        }
        callbackDone.resolve();
      }
    },
  });
  await bridge.start();
  const staging = bridge.accept({
    sequence: 1,
    type: 'local-preview.generation',
    generation: createDsl4PreviewSourceGenerationWire({revision: 1, result}),
  });
  await callbackEntered.promise;
  await withDeadline(
    Promise.all([staging, callbackDone.promise]),
    'bridge disposal from observer',
    1000,
  );
  assert(notificationFailure instanceof Error);
  assert.equal(releases, 1);
  assert(bridge.hasPendingCleanup());
  await bridge.dispose();
  assert.equal(releases, 2);
  assert.equal(bridge.hasPendingCleanup(), false);
});

for (const operation of ['commit', 'defer'] as const) {
  test(`coordinator rejects ${operation} immediately after dispose before the child closes`, async () => {
    const resources = browserResources();
    const protocol = candidateProtocol();
    let mutations = 0;
    const commit = protocol.commit,
      defer = protocol.defer;
    protocol.commit = async (message) => {
      mutations++;
      return commit(message);
    };
    protocol.defer = async (message) => {
      mutations++;
      return defer(message);
    };
    const coordinator = createDsl4BrowserPreviewCoordinator({
      protocolSession: protocol,
      sessionId: `closed-${operation}`,
      sourceFrontend: frontend,
      maxSourceBytes: 4096,
      sourceOptions: {
        clock: resources.clock,
        document: resources.document,
        subtleCrypto: webcrypto.subtle,
      },
    });
    await coordinator.start(resources.root);
    const disposal = coordinator.dispose();
    const request = operation === 'commit' ? coordinator.commit('storyStart') : coordinator.defer();
    const rejected = assert.rejects(request, /disposed/);
    await Promise.all([rejected, disposal]);
    assert.equal(mutations, 0);
    assert.equal(coordinator.hasPendingCleanup(), false);
  });
}

for (const failure of ['timer', 'listener', 'both'] as const) {
  test(`source end-notice reentry joins the same attempt after ${failure} failure`, async () => {
    const resources = browserResources();
    let attempts = 0,
      notifications = 0;
    const clear = resources.clock.clearTimeout;
    resources.clock.clearTimeout = (handle) => {
      attempts++;
      clear(handle);
    };
    const source = createDsl4BrowserPreviewSourceAdapter({
      sourceFrontend: frontend,
      maxSourceBytes: 4096,
      clock: resources.clock,
      document: resources.document,
      subtleCrypto: webcrypto.subtle,
      onResult: () => {},
      onStatus(state) {
        if (state.disposed) {
          notifications++;
          // A nested call would succeed if it improperly started another attempt now.
          resources.fail(false, false);
          source.dispose();
        }
      },
    });
    await source.start(resources.root);
    resources.fail(failure !== 'listener', failure !== 'timer');
    assert.throws(() => source.dispose(), /cleanup failed/);
    assert.equal(notifications, 1);
    assert.equal(attempts, 1);
    assert.equal(resources.removals.filter((t) => t === 'visibilitychange').length, 1);
    assert(source.hasPendingCleanup());
    source.dispose();
    assert.equal(attempts, failure === 'listener' ? 1 : 2);
    assert.equal(
      resources.removals.filter((t) => t === 'visibilitychange').length,
      failure === 'timer' ? 1 : 2,
    );
    assert.equal(notifications, 1);
    assert.equal(source.hasPendingCleanup(), false);
  });
}

for (const operation of ['defer', 'discardCandidate', 'invalid-source'] as const) {
  for (const rejection of [false, true]) {
    test(`late ${rejection ? 'rejected' : 'resolved'} resume during ${operation} preserves disposal state`, async () => {
      const entered = deferred(),
        gate = deferred();
      let stops = 0,
        releases = 0;
      const live = createDsl4LiveReloadSession({
        initialStoryDocument: storyDocument,
        initialSession: runtime({
          stop() {
            stops++;
          },
          dispose() {
            releases++;
          },
          resumeQuiesce: async () => {
            entered.resolve();
            await gate.promise;
          },
        }),
        createSession: () => runtime(),
      });
      const staged = await live.stage(result);
      assert(staged.candidate);
      const resuming =
        operation === 'defer'
          ? live.defer(staged.candidate.id)
          : operation === 'discardCandidate'
            ? live.discardCandidate()
            : live.stage({ok: false, diagnostics: []});
      const rejected = assert.rejects(resuming, rejection ? /resume failed/ : /disposed/);
      await entered.promise;
      const disposal = live.dispose();
      if (rejection) gate.reject(new Error('resume failed'));
      else gate.resolve();
      await Promise.all([rejected, disposal]);
      assert.equal(live.getState().disposed, true);
      assert.equal(live.getState().status, 'disposed');
      assert.equal(live.getState().hasCurrent, false);
      assert.equal(live.getState().candidate, null);
      assert.deepEqual(live.getState().diagnostics, []);
      assert.equal(live.hasPendingCleanup(), false);
      assert.deepEqual([stops, releases], [1, 1]);
    });
  }
}

for (const failure of ['synchronous-quiesce', 'rejected-quiesce', 'invalid-token'] as const) {
  test(`late stop after ${failure} also preserves disposed status`, async () => {
    const entered = deferred(),
      gate = deferred();
    let stops = 0;
    const live = createDsl4LiveReloadSession({
      initialStoryDocument: storyDocument,
      initialSession: runtime({
        quiesce() {
          if (failure === 'synchronous-quiesce') throw new Error('quiesce failed');
          if (failure === 'rejected-quiesce') return Promise.reject(new Error('quiesce failed'));
          return {};
        },
        async stop() {
          if (++stops === 1) {
            entered.resolve();
            await gate.promise;
          }
        },
      }),
      createSession: () => runtime(),
    });
    const staging = live.stage(result);
    const rejected = assert.rejects(staging, /disposed/);
    await entered.promise;
    const disposal = live.dispose();
    gate.resolve();
    await Promise.all([rejected, disposal]);
    assert.equal(live.getState().status, 'disposed');
    assert.equal(live.getState().candidate, null);
    assert.deepEqual(live.getState().diagnostics, []);
    assert.equal(live.hasPendingCleanup(), false);
  });
}
