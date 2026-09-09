import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'vitest';

import {createDsl4ProductionSourceFrontend} from '../src/builder/index.js';
import {
  createDsl4BrowserPreviewRuntimeBridge,
  createDsl4PreviewSourceGenerationWire,
  dsl4PreviewSourceGenerationWireMaximumMessageBytes,
} from '../src/dsl4/index.js';
import {requireRecord} from './helpers/require-value.ts';

/** Read the generation one acknowledgement reports as current. */
function currentGeneration(acknowledgement: unknown) {
  return requireRecord(
    requireRecord(acknowledgement, 'the acknowledgement').current,
    'its current generation',
  ).generation;
}

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

async function sourceResult(source: string, marker: string) {
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

function generationRecord(
  sequence: number,
  revision: number,
  result: Readonly<Record<string, unknown>>,
) {
  return {
    sequence,
    type: 'local-preview.generation',
    generation: createDsl4PreviewSourceGenerationWire({revision, result}),
  };
}

/** The runtime state the session double owns, as the bridge and these cases read it. */
interface SessionRuntimeState {
  status: string;
  sceneId: string;
  actionIndex: number;
  actionPath: string;
  variables: Record<string, unknown>;
  generation: number;
}

/** What the bridge asks for when it opens a session. */
interface CreateSessionInput {
  storyDocument: {variables?: Record<string, unknown>};
  previousSession: unknown;
  preserveManagedPresentation: boolean;
}

/** The position and variables one start request overrides. */
interface SessionStartOptions {
  sceneId?: string;
  actionIndex?: number;
  variables?: Record<string, unknown>;
}

type BridgeOptions = Parameters<typeof createDsl4BrowserPreviewRuntimeBridge>[0];

function runtimeFixture() {
  const lifecycle: unknown[][] = [];
  let sessionCount = 0;
  function createSession({
    storyDocument,
    previousSession,
    preserveManagedPresentation,
  }: CreateSessionInput) {
    sessionCount += 1;
    const name = `session-${sessionCount}`;
    lifecycle.push([
      name,
      'create',
      previousSession === null ? null : 'previous',
      preserveManagedPresentation,
    ]);
    let disposed = false;
    let quiesceCandidateId: string | null = null;
    let state: SessionRuntimeState = {
      status: 'idle',
      sceneId: 'opening',
      actionIndex: 0,
      actionPath: '/scenes/opening/actions/0',
      variables: {...storyDocument.variables},
      generation: sessionCount,
    };
    return {
      start(options: SessionStartOptions = {}) {
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
      stop(reason: string) {
        lifecycle.push([name, 'stop', reason]);
        state = {...state, status: 'stopped'};
        quiesceCandidateId = null;
        return state;
      },
      dispose(reason: string) {
        lifecycle.push([name, 'dispose', reason]);
        disposed = true;
      },
      getState() {
        return {runtime: {...state}, disposed};
      },
      quiesce({candidateId}: {candidateId: string}) {
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
      resumeQuiesce(candidateId: string) {
        if (candidateId !== quiesceCandidateId) throw new TypeError('stale quiesce candidate');
        lifecycle.push([name, 'resume', candidateId]);
        quiesceCandidateId = null;
        state = {...state, status: 'running'};
        return state;
      },
    };
  }
  // The double implements the members the bridge calls; `LiveReloadRuntimeSession` also declares
  // the ones a real TurboWarp session carries, which this fixture has no runtime to provide.
  return {createSession: createSession as unknown as BridgeOptions['createSession'], lifecycle};
}

test('starts the first valid generation in a browser-owned runtime session', async () => {
  const runtime = runtimeFixture();
  const events: unknown[] = [];
  const bridge = createDsl4BrowserPreviewRuntimeBridge({
    createSession: runtime.createSession,
    sessionId: 'browser-runtime-test',
    onEvent: (event: unknown) => events.push(event),
  });

  await bridge.start();
  const invalid = await sourceResult("kamishibai: '4.0'\nscenes: {}\n", 'A');
  const invalidAck = await bridge.accept(generationRecord(2, 1, invalid));
  assert.equal(requireRecord(invalidAck, 'the bridge acknowledgement').status, 'invalid');
  assert.equal(bridge.getState().status, 'invalid');
  assert.deepEqual(runtime.lifecycle, []);

  const valid = await sourceResult(initialSource, 'B');
  const activeAck = await bridge.accept(generationRecord(5, 2, valid));
  assert.equal(requireRecord(activeAck, 'the bridge acknowledgement').status, 'active');
  assert.equal(currentGeneration(activeAck), 1);
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
  assert.equal(requireRecord(committed, 'the acknowledgement').choice, 'currentAction');
  assert.equal(currentGeneration(committed), 2);

  const invalid = await sourceResult("kamishibai: '4.0'\nscenes: {}\n", 'E');
  const invalidAck = await bridge.accept(generationRecord(7, 3, invalid));
  assert.equal(requireRecord(invalidAck, 'the bridge acknowledgement').status, 'invalid');
  assert.equal(currentGeneration(invalidAck), 2);
  assert.equal(bridge.getState().latestValidGenerationRevision, 2);

  const restarted = await bridge.restart('storyStart');
  assert.equal(requireRecord(restarted, 'the acknowledgement').choice, 'storyStart');
  assert.equal(currentGeneration(restarted), 3);
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
