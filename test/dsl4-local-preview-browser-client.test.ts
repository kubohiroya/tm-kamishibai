import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4LocalPreviewBrowserClient} from '../src/builder/index.js';
import {requireDefined, requireRecord, requireString} from './helpers/require-value.ts';
import {deferred} from './helpers/async-test-helpers.ts';

const integrity = (character: string) => `sha256-${character.repeat(43)}=`;

async function waitFor(predicate: () => unknown, label: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('browser preview client owns the authenticated generation stream and preserves the current runtime on invalid source', async () => {
  const token = 'a'.repeat(43);
  const eventControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const listeners = new Map<string, (event: unknown) => unknown>();
  const updates: unknown[] = [];
  const watchStates: unknown[] = [];
  const diagnostics: unknown[] = [];
  const accepted: number[] = [];
  const commits: unknown[] = [];
  const runtimeReadyBodies: unknown[] = [];
  const projectBytes = new Uint8Array([80, 75, 3, 4]);
  const currentOne = integrity('A');
  const currentTwo = integrity('B');
  const initialRecords = [
    {sequence: 1, type: 'local-preview.generation', generation: {revision: 1}},
    {
      sequence: 2,
      type: 'local-preview.source',
      generationRevision: 1,
      source: {
        ok: true,
        integrity: currentOne,
        counts: {scenes: 1, actions: 0, assets: 0},
        diagnostics: [],
      },
    },
  ];
  const mount = {
    appendChild() {},
    clientHeight: 360,
    clientWidth: 480,
  };
  const document = {
    querySelector(selector: string) {
      if (selector === '#dsl4-local-preview-runtime') return mount;
      if (selector === '#dsl4-local-preview-source-name') return {textContent: 'story.k4.yml'};
      return null;
    },
    createElement() {
      return {setAttribute() {}, remove() {}, textContent: ''};
    },
  };
  const shell = {
    async setReloadWatchState(_channel: unknown, state: unknown) {
      watchStates.push(state);
    },
    async setReloadDiagnostic(_channel: unknown, diagnostic: unknown) {
      diagnostics.push(diagnostic);
    },
    update(view: unknown) {
      updates.push(view);
    },
    async submitReloadCandidate(candidate: {apply(request: unknown): Promise<unknown>}) {
      await candidate.apply({actualAnchor: 'action'});
    },
    getSnapshot() {
      return {updates: updates.length};
    },
    async dispose() {},
  };
  const runtime = {
    async start() {},
    async accept(record: {generation: {revision: number}}) {
      const revision = record.generation.revision;
      accepted.push(revision);
      if (revision === 1) return {revision, current: {integrity: currentOne}, candidate: null};
      if (revision === 2) {
        return {
          revision,
          current: {integrity: currentOne},
          candidate: {
            options: {
              storyStart: {enabled: true, reason: null},
              currentScene: {enabled: true, reason: null},
              currentAction: {enabled: true, reason: null},
            },
          },
        };
      }
      return {revision, current: {integrity: currentTwo}, candidate: null};
    },
    async commit(choice: unknown) {
      commits.push(choice);
      return {current: {integrity: currentTwo}};
    },
    async restart() {
      throw new Error('restart is not expected');
    },
    getState() {
      return {status: 'ready'};
    },
    async dispose() {},
  };
  const fetchRequest = async (endpoint: string, init?: {body?: unknown}) => {
    if (endpoint === '/api/connect') {
      return Response.json({events: initialRecords});
    }
    if (endpoint === '/api/events') {
      return new Response(
        new ReadableStream({
          start(controller) {
            eventControllers.push(controller);
          },
        }),
        {status: 200, headers: {'content-type': 'application/x-ndjson'}},
      );
    }
    if (endpoint === '/api/runtime-project') {
      return new Response(projectBytes, {
        status: 200,
        headers: {'content-length': String(projectBytes.byteLength)},
      });
    }
    if (endpoint === '/api/runtime-ready') {
      runtimeReadyBodies.push(
        JSON.parse(
          requireString(requireDefined(init, 'the request init').body, 'the request body'),
        ),
      );
      return Response.json({snapshot: {browserRuntimeReady: true}});
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  const onApplicationOpen = () => {};
  const client = createDsl4LocalPreviewBrowserClient({
    document,
    location: {hash: `#${token}`, pathname: '/', search: ''},
    history: {
      replaceState(_state: unknown, _title: unknown, path: unknown) {
        assert.equal(path, '/');
      },
    },
    eventTarget: {
      addEventListener(type: string, listener: (event: unknown) => unknown) {
        listeners.set(type, listener);
      },
      removeEventListener(type: string) {
        listeners.delete(type);
      },
    },
    fetch: fetchRequest,
    sourceFrontend: {parse() {}},
    platform: {},
    runtimeOptions: {},
    maxProjectBytes: 300 * 1024 * 1024,
    maxProjectJsonBytes: 400 * 1024 * 1024,
    maxAssetFiles: 123,
    maxAssetBytes: 200 * 1024 * 1024,
    onApplicationOpen,
    createShell: () => shell,
    createRuntime(options: Record<string, unknown>) {
      assert.deepEqual(options.projectBytes, projectBytes);
      assert.equal(options.maxProjectBytes, 300 * 1024 * 1024);
      assert.equal(options.maxProjectJsonBytes, 400 * 1024 * 1024);
      assert.equal(options.maxAssetFiles, 123);
      assert.equal(options.maxAssetBytes, 200 * 1024 * 1024);
      assert.equal(options.onApplicationOpen, onApplicationOpen);
      return runtime;
    },
  });

  const started = await client.start();
  assert.equal(started.status, 'running');
  assert.deepEqual(accepted, [1]);
  assert.equal(requireRecord(updates.at(-1), 'the last update').currentIntegrity, currentOne);
  assert.deepEqual(watchStates, ['stabilizing', 'watching']);
  assert.deepEqual(runtimeReadyBodies, [{version: 1}]);

  const encoder = new TextEncoder();
  for (const record of [
    {sequence: 3, type: 'local-preview.generation', generation: {revision: 2}},
    {
      sequence: 4,
      type: 'local-preview.source',
      generationRevision: 2,
      source: {
        ok: true,
        integrity: currentTwo,
        counts: {scenes: 1, actions: 1, assets: 0},
        diagnostics: [],
      },
    },
  ]) {
    requireDefined(eventControllers[0], 'the event stream controller').enqueue(
      encoder.encode(`${JSON.stringify(record)}\n`),
    );
  }
  await waitFor(() => commits.length === 1, 'automatic source commit');
  assert.deepEqual(commits, ['currentAction']);
  assert.equal(requireRecord(updates.at(-1), 'the last update').currentIntegrity, currentTwo);

  for (const record of [
    {sequence: 5, type: 'local-preview.generation', generation: {revision: 3}},
    {
      sequence: 6,
      type: 'local-preview.source',
      generationRevision: 3,
      source: {
        ok: false,
        integrity: null,
        counts: null,
        diagnostics: [
          {code: 'K4-SCHEMA-001', severity: 'error', message: 'Scenes must not be empty.'},
        ],
      },
    },
  ]) {
    requireDefined(eventControllers[0], 'the event stream controller').enqueue(
      encoder.encode(`${JSON.stringify(record)}\n`),
    );
  }
  await waitFor(
    () => requireRecord(updates.at(-1), 'the last update').validationStatus === 'invalid',
    'invalid diagnostic',
  );
  assert.equal(requireRecord(updates.at(-1), 'the last update').currentIntegrity, currentTwo);
  assert.equal(requireRecord(diagnostics.at(-1), 'the last diagnostic').code, 'K4-SCHEMA-001');
  assert.equal(JSON.stringify(client.getState()).includes(token), false);

  await client.dispose();
  assert.equal(client.getState().status, 'disposed');
  assert.equal(listeners.has('pagehide'), false);
});

test('browser preview client aborts startup when the page is hidden', async () => {
  const listeners = new Map<string, (event: unknown) => unknown>();
  const fetchStarted = deferred<void>();
  let runtimeCreated = false;
  let shellDisposed = false;
  const mount = {appendChild() {}, clientHeight: 360, clientWidth: 480};
  const client = createDsl4LocalPreviewBrowserClient({
    document: {
      querySelector(selector: string) {
        if (selector === '#dsl4-local-preview-runtime') return mount;
        return null;
      },
      createElement() {
        return {setAttribute() {}, remove() {}, textContent: ''};
      },
    },
    location: {hash: `#${'a'.repeat(43)}`, pathname: '/', search: ''},
    history: {replaceState() {}},
    eventTarget: {
      addEventListener(type: string, listener: (event: unknown) => unknown) {
        listeners.set(type, listener);
      },
      removeEventListener(type: string) {
        listeners.delete(type);
      },
    },
    async fetch(_endpoint: string, init: {signal: AbortSignal}) {
      fetchStarted.resolve();
      return new Promise((_resolve, reject) => {
        const abort = () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (init.signal.aborted) abort();
        else init.signal.addEventListener('abort', abort, {once: true});
      });
    },
    sourceFrontend: {parse() {}},
    platform: {},
    runtimeOptions: {},
    createShell: () => ({
      async setReloadWatchState() {},
      async setReloadDiagnostic() {},
      update() {},
      getSnapshot() {
        return {};
      },
      async dispose() {
        shellDisposed = true;
      },
    }),
    createRuntime() {
      runtimeCreated = true;
      throw new Error('runtime creation is not expected');
    },
  });

  const startup = client.start();
  await fetchStarted.promise;
  const rejectedStartup = assert.rejects(startup, {name: 'AbortError'});
  requireDefined(listeners.get('pagehide'), 'the pagehide listener')({type: 'pagehide'});
  await rejectedStartup;
  await waitFor(() => client.getState().status === 'disposed', 'pagehide cleanup');
  assert.equal(runtimeCreated, false);
  assert.equal(shellDisposed, true);
  assert.equal(listeners.has('pagehide'), false);
});
