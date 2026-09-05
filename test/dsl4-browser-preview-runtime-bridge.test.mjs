import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'vitest';

import {createDsl4ProductionSourceFrontend} from '../src/builder/index.js';
import {
  createDsl4BrowserPreviewRuntimeBridge,
  createDsl4PreviewSourceGenerationWire,
  dsl4PreviewSourceGenerationWireMaximumMessageBytes,
} from '../src/dsl4/index.js';

const schema = JSON.parse(
  await readFile(new URL('../schema/dsl-4.schema.json', import.meta.url), 'utf8'),
);
const frontend = createDsl4ProductionSourceFrontend(schema);

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

/** @param {string} source @param {string} marker */
async function sourceResult(source, marker) {
  const parsed = await frontend.parse(source, {sourceId: 'main'});
  return {
    ...parsed,
    sourceSnapshot: {
      sourceId: 'main',
      text: parsed.canonicalSource,
      byteLength: new TextEncoder().encode(parsed.canonicalSource).byteLength,
      integrity: `sha256-${marker.repeat(43)}=`,
    },
  };
}

/** @param {number} sequence @param {number} revision @param {Readonly<Record<string, unknown>>} result */
function generationRecord(sequence, revision, result) {
  return {
    sequence,
    type: 'local-preview.generation',
    generation: createDsl4PreviewSourceGenerationWire({revision, result}),
  };
}

function runtimeFixture() {
  const lifecycle = [];
  let sessionCount = 0;
  function createSession({storyDocument, previousSession, preserveManagedPresentation}) {
    sessionCount += 1;
    const name = `session-${sessionCount}`;
    lifecycle.push([
      name,
      'create',
      previousSession === null ? null : 'previous',
      preserveManagedPresentation,
    ]);
    let disposed = false;
    let quiesceCandidateId = null;
    let state = {
      status: 'idle',
      sceneId: 'opening',
      actionIndex: 0,
      actionPath: '/scenes/opening/actions/0',
      variables: {...storyDocument.variables},
      generation: sessionCount,
    };
    return {
      start(options = {}) {
        lifecycle.push([name, 'start', options]);
        state = {
          ...state,
          status: 'running',
          sceneId: options.sceneId ?? state.sceneId,
          actionIndex: options.actionIndex ?? state.actionIndex,
          actionPath:
            options.actionIndex === undefined
              ? state.actionPath
              : `/scenes/${options.sceneId}/actions/${options.actionIndex}`,
          variables: options.variables ?? state.variables,
        };
        return Promise.resolve(state);
      },
      stop(reason) {
        lifecycle.push([name, 'stop', reason]);
        state = {...state, status: 'stopped'};
        quiesceCandidateId = null;
        return state;
      },
      dispose(reason) {
        lifecycle.push([name, 'dispose', reason]);
        disposed = true;
      },
      getState() {
        return {runtime: {...state}, disposed};
      },
      quiesce({candidateId}) {
        lifecycle.push([name, 'quiesce', candidateId]);
        quiesceCandidateId = candidateId;
        state = {...state, status: 'paused'};
        return {
          kind: 'Dsl4QuiesceToken',
          version: 1,
          candidateId,
          runtimeGeneration: state.generation,
          storyPath: state.actionPath,
          actionSignature: {command: 'wait', target: null, handler: 'core'},
          sceneId: state.sceneId,
          actionIndex: state.actionIndex,
          variables: {...state.variables},
          resumeMode: 'replay-action',
        };
      },
      resumeQuiesce(candidateId) {
        if (candidateId !== quiesceCandidateId) throw new TypeError('stale quiesce candidate');
        lifecycle.push([name, 'resume', candidateId]);
        quiesceCandidateId = null;
        state = {...state, status: 'running'};
        return state;
      },
    };
  }
  return {createSession, lifecycle};
}

test('starts the first valid generation in a browser-owned runtime session', async () => {
  const runtime = runtimeFixture();
  const events = [];
  const bridge = createDsl4BrowserPreviewRuntimeBridge({
    createSession: runtime.createSession,
    sessionId: 'browser-runtime-test',
    onEvent: (event) => events.push(event),
  });

  await bridge.start();
  const invalid = await sourceResult("kamishibai: '4.0'\nscenes: {}\n", 'A');
  const invalidAck = await bridge.accept(generationRecord(2, 1, invalid));
  assert.equal(invalidAck.status, 'invalid');
  assert.equal(bridge.getState().status, 'invalid');
  assert.deepEqual(runtime.lifecycle, []);

  const valid = await sourceResult(initialSource, 'B');
  const activeAck = await bridge.accept(generationRecord(5, 2, valid));
  assert.equal(activeAck.status, 'active');
  assert.equal(activeAck.current.generation, 1);
  assert.deepEqual(
    runtime.lifecycle.map((entry) => entry[1]),
    ['create', 'start'],
  );
  assert.equal(bridge.getState().latestGenerationRevision, 2);
  assert.equal(bridge.getState().latestValidGenerationRevision, 2);
  assert.equal(JSON.stringify(bridge.getState()).includes('StoryDocument'), false);
  assert.equal(JSON.stringify(events).includes('StoryDocument'), false);

  await bridge.dispose();
  assert.deepEqual(
    runtime.lifecycle.map((entry) => entry[1]),
    ['create', 'start', 'stop', 'dispose'],
  );
});

test('commits, retains the last valid generation through invalid input, and restarts locally', async () => {
  const runtime = runtimeFixture();
  const bridge = createDsl4BrowserPreviewRuntimeBridge({
    createSession: runtime.createSession,
    sessionId: 'browser-runtime-reload',
  });
  await bridge.start();

  const first = await sourceResult(initialSource, 'C');
  await bridge.accept(generationRecord(1, 1, first));
  const changed = await sourceResult(initialSource.replace('seconds: 1', 'seconds: 2'), 'D');
  const candidate = await bridge.accept(generationRecord(4, 2, changed));
  assert.ok(candidate.candidate);
  const committed = await bridge.commit('currentAction');
  assert.equal(committed.choice, 'currentAction');
  assert.equal(committed.current.generation, 2);

  const invalid = await sourceResult("kamishibai: '4.0'\nscenes: {}\n", 'E');
  const invalidAck = await bridge.accept(generationRecord(7, 3, invalid));
  assert.equal(invalidAck.status, 'invalid');
  assert.equal(invalidAck.current.generation, 2);
  assert.equal(bridge.getState().latestValidGenerationRevision, 2);

  const restarted = await bridge.restart('storyStart');
  assert.equal(restarted.choice, 'storyStart');
  assert.equal(restarted.current.generation, 3);
  assert.equal(bridge.getState().latestGenerationRevision, 3);
  await bridge.dispose();
  assert.equal(runtime.lifecycle.filter((entry) => entry[1] === 'dispose').length, 3);
});

test('rejects stale, malformed, oversized, and post-disposal generation records', async () => {
  const runtime = runtimeFixture();
  const bridge = createDsl4BrowserPreviewRuntimeBridge({
    createSession: runtime.createSession,
    sessionId: 'browser-runtime-boundary',
    maxGenerationMessageBytes: 4096,
  });
  const valid = await sourceResult(initialSource, 'F');
  await assert.rejects(() => bridge.accept(generationRecord(1, 1, valid)), /not started/u);
  await bridge.start();
  await bridge.accept(generationRecord(1, 1, valid));
  const beforeInvalidRestart = bridge.getState().protocol.latestRevision;
  await assert.rejects(() => bridge.restart('unknown'), /restart choice/u);
  assert.equal(bridge.getState().protocol.latestRevision, beforeInvalidRestart);
  await assert.rejects(() => bridge.accept(generationRecord(1, 2, valid)), /sequence is stale/u);
  await assert.rejects(() => bridge.accept(generationRecord(2, 3, valid)), /contiguous/u);
  await assert.rejects(
    () => bridge.accept({...generationRecord(2, 2, valid), token: 'secret'}),
    /unknown: token/u,
  );
  await bridge.dispose();
  await assert.rejects(() => bridge.accept(generationRecord(2, 2, valid)), /disposed/u);

  assert.throws(
    () =>
      createDsl4BrowserPreviewRuntimeBridge({
        createSession: runtime.createSession,
        sessionId: 'browser-runtime-limit',
        maxGenerationMessageBytes: dsl4PreviewSourceGenerationWireMaximumMessageBytes + 1,
      }),
    /maxGenerationMessageBytes/u,
  );
});
