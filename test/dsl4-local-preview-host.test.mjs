import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createDsl4LocalPreviewHost,
  createDsl4ProductionSourceFrontend,
  dsl4TurboWarpBrowserBundleMaximumBytes,
} from '../src/builder/index.js';
import {
  createDsl4LiveReloadSession,
  createDsl4PreviewProtocolSession,
  decodeDsl4PreviewSourceGenerationWire,
  dsl4BrowserTurboWarpStageMaximumProjectBytes,
  dsl4PreviewSourceGenerationWireMaximumMessageBytes,
} from '../src/dsl4/index.js';

const schema = JSON.parse(
  await readFile(new URL('../schema/dsl-4.schema.json', import.meta.url), 'utf8'),
);
const frontend = createDsl4ProductionSourceFrontend(schema);
const validSource = "kamishibai: '4.0'\nscenes:\n  opening: []\n";

function fakeWatchFactory() {
  let listener = null;
  let errorListener = null;
  let closed = 0;
  return {
    factory(_directory, nextListener) {
      listener = nextListener;
      return {
        close() {
          closed += 1;
        },
        on(type, callback) {
          if (type === 'error') errorListener = callback;
          return this;
        },
      };
    },
    emit(filename) {
      listener?.('change', filename);
    },
    emitError(error) {
      errorListener?.(error);
    },
    get closed() {
      return closed;
    },
  };
}

function createRuntimeProtocol() {
  const lifecycle = [];
  const liveReload = createDsl4LiveReloadSession({
    createSession({storyDocument}) {
      const firstAction = storyDocument.scenes[0].actions[0] ?? null;
      let state = {
        status: 'idle',
        sceneId: storyDocument.scenes[0].id,
        actionIndex: 0,
        actionPath: firstAction?.id ?? null,
        variables: storyDocument.variables,
      };
      let quiesceToken = null;
      return {
        start(options = {}) {
          lifecycle.push(['start', options]);
          state = {...state, status: 'running'};
          return Promise.resolve(state);
        },
        stop(reason) {
          lifecycle.push(['stop', reason]);
          state = {...state, status: 'stopped'};
          quiesceToken = null;
        },
        dispose(reason) {
          lifecycle.push(['dispose', reason]);
        },
        getState() {
          return {runtime: state};
        },
        quiesce({candidateId}) {
          quiesceToken = Object.freeze({
            kind: 'Dsl4QuiesceToken',
            version: 1,
            candidateId,
            runtimeGeneration: 1,
            storyPath: firstAction?.id ?? `/scenes/${state.sceneId}`,
            actionSignature: firstAction
              ? {
                  command: firstAction.command,
                  target: firstAction.target,
                  handler: firstAction.handler ?? 'core',
                }
              : null,
            sceneId: state.sceneId,
            actionIndex: 0,
            variables: {...state.variables},
            resumeMode: firstAction ? 'replay-action' : 'finished',
          });
          state = {...state, status: 'paused'};
          return quiesceToken;
        },
        resumeQuiesce(candidateId) {
          if (!quiesceToken || quiesceToken.candidateId !== candidateId) {
            throw new TypeError('stale quiesce candidate');
          }
          quiesceToken = null;
          state = {...state, status: 'running'};
          return state;
        },
      };
    },
  });
  return {
    lifecycle,
    liveReload,
    protocol: createDsl4PreviewProtocolSession({liveReloadSession: liveReload}),
  };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function request(origin, endpoint, {token, body = {}, expectedStatus = 200}) {
  const response = await fetch(`${origin}${endpoint}`, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      ...(token ? {authorization: `Bearer ${token}`} : {}),
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, expectedStatus);
  return response.json();
}

test('connects the loopback browser host, Node watcher, and injected runtime protocol', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'dsl4-local-preview-host-'));
  const sourceManifestPath = path.join(projectRoot, 'project.source.json');
  const sourceFilename = 'preview.k4.yml';
  const sourcePath = path.join(projectRoot, sourceFilename);
  const sourceWatch = fakeWatchFactory();
  const structureWatch = fakeWatchFactory();
  const manifest = {formatVersion: 1, mode: 'external', sourceId: 'main', path: sourceFilename};
  await Promise.all([
    writeFile(sourceManifestPath, `${JSON.stringify(manifest)}\n`),
    writeFile(sourcePath, validSource),
  ]);
  const runtime = createRuntimeProtocol();
  const observedEvents = [];
  const host = createDsl4LocalPreviewHost({
    projectRoot,
    sourceManifestPath,
    sourceManifest: manifest,
    sourceFrontend: frontend,
    maxSourceBytes: 4096,
    protocolSession: runtime.protocol,
    watcherOptions: {
      watchFactory: sourceWatch.factory,
      quietWindowMs: 0,
      retryIntervalMs: 1,
      stabilityTimeoutMs: 3,
    },
    structureWatchFactory: structureWatch.factory,
    onEvent: (event) => observedEvents.push(event),
  });

  try {
    const listening = await host.start();
    assert.equal(listening.status, 'listening');
    assert.equal(listening.connected, false);
    assert.equal(JSON.stringify(listening).includes(projectRoot), false);
    const launchUrl = new URL(host.getLaunchUrl());
    const origin = launchUrl.origin;
    const token = launchUrl.hash.slice(1);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/u);

    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/u);
    const pageBody = await page.text();
    assert.match(pageBody, /dsl4-local-preview-client\.js/u);
    assert.match(
      pageBody,
      /<strong id="dsl4-local-preview-source-name">preview\.k4\.yml<\/strong>/u,
    );
    const clientModule = await fetch(`${origin}/modules/builder/dsl4-local-preview-client.js`);
    assert.equal(clientModule.status, 200);
    assert.match(await clientModule.text(), /createDsl4CliPreviewShell/u);
    assert.equal((await fetch(`${origin}/modules/builder/../../package.json`)).status, 404);

    const connected = await request(origin, '/api/connect', {body: {token}});
    assert.equal(connected.snapshot.status, 'connected');
    assert.equal(runtime.lifecycle[0][0], 'start');
    const initial = connected.events.find((event) => event.type === 'local-preview.source');
    assert.equal(initial.source.ok, true);
    assert.equal(initial.acknowledgement.status, 'active');
    assert.equal(initial.source.counts.scenes, 1);
    const generationEvent = connected.events.find(
      (event) => event.type === 'local-preview.generation',
    );
    const generation = decodeDsl4PreviewSourceGenerationWire(
      new TextEncoder().encode(JSON.stringify(generationEvent.generation)),
    );
    assert.equal(generation.revision, 1);
    assert.equal(generation.result.ok, true);
    assert.equal(generation.result.storyDocument.scenes[0].id, 'opening');
    assert.equal(
      observedEvents.some((event) => event.type === 'local-preview.generation'),
      false,
    );
    const serialized = JSON.stringify(connected);
    assert.equal(serialized.includes(validSource.trim()), false);
    assert.equal(serialized.includes(projectRoot), false);
    assert.equal(serialized.includes(sourceFilename), false);
    assert.equal(serialized.includes(token), false);

    const denied = await fetch(`${origin}/api/commit`, {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:1',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({choice: 'storyStart'}),
    });
    assert.equal(denied.status, 400);
    const deniedError = (await denied.json()).error;
    assert.equal(deniedError.code, 'K4-PREVIEW-TRANSPORT-ORIGIN');
    assert.equal(deniedError.message, 'The local preview host rejected the request');
    assert.equal(JSON.stringify(deniedError).includes(projectRoot), false);
    assert.equal(JSON.stringify(deniedError).includes(token), false);
    assert.equal(host.getSnapshot().status, 'connected');

    await writeFile(sourcePath, "kamishibai: '4.0'\nscenes: {}\n");
    const beforeInvalid = host.getSnapshot();
    const beforeInvalidSources = observedEvents.filter(
      (event) => event.type === 'local-preview.source',
    ).length;
    sourceWatch.emit(sourceFilename);
    await waitFor(
      () =>
        observedEvents.filter((event) => event.type === 'local-preview.source').length >
        beforeInvalidSources,
      'invalid source event was not published',
    );
    const invalid = observedEvents.findLast((event) => event.type === 'local-preview.source');
    assert.equal(invalid.source.ok, false);
    assert.equal(invalid.acknowledgement.status, 'invalid');
    assert.equal(invalid.acknowledgement.current.generation, 1);
    assert.equal(host.getSnapshot().latestSequence, beforeInvalid.latestSequence + 2);
    assert.equal(host.getSnapshot().retainedEvents, beforeInvalid.retainedEvents + 1);
    assert.equal(runtime.lifecycle.length, 1);

    await writeFile(sourcePath, validSource.replace('opening: []', 'opening:\n    - wait: 60'));
    const beforeCandidate = host.getSnapshot();
    const beforeCandidateSources = observedEvents.filter(
      (event) => event.type === 'local-preview.source',
    ).length;
    sourceWatch.emit(sourceFilename);
    await waitFor(
      () =>
        observedEvents.filter((event) => event.type === 'local-preview.source').length >
        beforeCandidateSources,
      'valid candidate event was not published',
    );
    const candidate = observedEvents.findLast((event) => event.type === 'local-preview.source');
    assert.equal(candidate.acknowledgement.status, 'pending');
    assert.equal(candidate.acknowledgement.candidate.options.storyStart.enabled, true);
    assert.equal(host.getSnapshot().latestSequence, beforeCandidate.latestSequence + 2);
    assert.equal(host.getSnapshot().retainedEvents, beforeCandidate.retainedEvents + 1);
    assert.equal(runtime.lifecycle.length, 1);

    const committed = await request(origin, '/api/commit', {
      token,
      body: {choice: 'storyStart'},
    });
    assert.equal(committed.acknowledgement.status, 'active');
    assert.equal(committed.acknowledgement.current.generation, 2);
    assert.deepEqual(
      runtime.lifecycle.map(([operation]) => operation),
      ['start', 'stop', 'dispose', 'start'],
    );

    const manifestChanged = {...manifest, path: 'alternate.k4.yaml'};
    await writeFile(sourceManifestPath, `${JSON.stringify(manifestChanged)}\n`);
    structureWatch.emit('project.source.json');
    await waitFor(
      () => host.getSnapshot().rebuildRequired,
      'structural manifest change did not require a rebuild',
    );
    assert.equal(host.getSnapshot().status, 'rebuild-required');
    assert.equal(runtime.liveReload.getState().hasCurrent, true);
    assert.equal(sourceWatch.closed, 1);
    const rebuildEvent = observedEvents.findLast(
      (event) => event.type === 'local-preview.full-rebuild-required',
    );
    assert.equal(rebuildEvent.diagnostic.code, 'K4-PREVIEW-STRUCTURE-CHANGED');

    const disconnectedCommit = await request(origin, '/api/commit', {
      token,
      body: {choice: 'storyStart'},
      expectedStatus: 400,
    });
    assert.equal(disconnectedCommit.error.code, 'K4-PREVIEW-TRANSPORT-DISCONNECTED');
  } finally {
    assert.deepEqual(await host.dispose(), await host.dispose());
    await runtime.liveReload.dispose();
    await rm(projectRoot, {recursive: true, force: true});
  }
  assert.equal(structureWatch.closed, 1);
});

test('stops both watchers on browser disconnect without stopping the current runtime', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'dsl4-local-preview-disconnect-'));
  const sourceManifestPath = path.join(projectRoot, 'project.source.json');
  const sourceWatch = fakeWatchFactory();
  const structureWatch = fakeWatchFactory();
  const manifest = {formatVersion: 1, mode: 'external', sourceId: 'main'};
  await Promise.all([
    writeFile(sourceManifestPath, `${JSON.stringify(manifest)}\n`),
    writeFile(path.join(projectRoot, 'story.kamishibai.yaml'), validSource),
  ]);
  const runtime = createRuntimeProtocol();
  const host = createDsl4LocalPreviewHost({
    projectRoot,
    sourceManifestPath,
    sourceManifest: manifest,
    sourceFrontend: frontend,
    maxSourceBytes: 4096,
    protocolSession: runtime.protocol,
    watcherOptions: {
      watchFactory: sourceWatch.factory,
      quietWindowMs: 0,
      retryIntervalMs: 1,
      stabilityTimeoutMs: 3,
    },
    structureWatchFactory: structureWatch.factory,
  });

  try {
    await host.start();
    const launchUrl = new URL(host.getLaunchUrl());
    const token = launchUrl.hash.slice(1);
    await request(launchUrl.origin, '/api/connect', {body: {token}});
    assert.equal(runtime.liveReload.getState().hasCurrent, true);

    const disconnected = await request(launchUrl.origin, '/api/disconnect', {token});
    assert.equal(disconnected.snapshot.connected, false);
    assert.equal(disconnected.snapshot.status, 'listening');
    assert.equal(sourceWatch.closed, 1);
    assert.equal(structureWatch.closed, 1);
    assert.equal(runtime.liveReload.getState().hasCurrent, true);
  } finally {
    await host.dispose();
    await runtime.liveReload.dispose();
    await rm(projectRoot, {recursive: true, force: true});
  }
  assert.equal(sourceWatch.closed, 1);
  assert.equal(structureWatch.closed, 1);
});

test('serves copied browser and project artifacts through separate authenticated boundaries', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'dsl4-local-preview-artifacts-'));
  const sourceManifestPath = path.join(projectRoot, 'project.source.json');
  const sourceFilename = 'preview.k4.yml';
  const manifest = {formatVersion: 1, mode: 'external', sourceId: 'main', path: sourceFilename};
  await Promise.all([
    writeFile(sourceManifestPath, `${JSON.stringify(manifest)}\n`),
    writeFile(path.join(projectRoot, sourceFilename), validSource),
  ]);
  const runtime = createRuntimeProtocol();
  const sourceWatch = fakeWatchFactory();
  const structureWatch = fakeWatchFactory();
  const projectBytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x01]);
  const browserBundleBytes = new TextEncoder().encode('export const previewRuntime = true;\n');
  const expectedProject = [...projectBytes];
  const expectedBundle = new TextDecoder().decode(browserBundleBytes);
  const host = createDsl4LocalPreviewHost({
    projectRoot,
    sourceManifestPath,
    sourceManifest: manifest,
    sourceFrontend: frontend,
    maxSourceBytes: 4096,
    protocolSession: runtime.protocol,
    projectBytes,
    browserBundleBytes,
    watcherOptions: {
      watchFactory: sourceWatch.factory,
      quietWindowMs: 0,
      retryIntervalMs: 1,
      stabilityTimeoutMs: 3,
    },
    structureWatchFactory: structureWatch.factory,
  });
  projectBytes.fill(0);
  browserBundleBytes.fill(0);

  try {
    const beforeStart = host.getSnapshot();
    assert.deepEqual(beforeStart.runtimeArtifacts, {
      available: true,
      projectBytes: expectedProject.length,
      browserBundleBytes: Buffer.byteLength(expectedBundle),
    });
    assert.equal(JSON.stringify(beforeStart).includes(expectedBundle), false);
    await host.start();
    const launchUrl = new URL(host.getLaunchUrl());
    const token = launchUrl.hash.slice(1);

    const bundleResponse = await fetch(`${launchUrl.origin}/runtime/browser.js`);
    assert.equal(bundleResponse.status, 200);
    assert.equal(bundleResponse.headers.get('cache-control'), 'no-store');
    assert.equal(bundleResponse.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(await bundleResponse.text(), expectedBundle);

    const disconnectedProject = await fetch(`${launchUrl.origin}/api/runtime-project`, {
      method: 'POST',
      headers: {
        origin: launchUrl.origin,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(disconnectedProject.status, 400);
    assert.equal(
      (await disconnectedProject.json()).error.code,
      'K4-PREVIEW-TRANSPORT-DISCONNECTED',
    );

    await request(launchUrl.origin, '/api/connect', {body: {token}});
    const deniedProject = await fetch(`${launchUrl.origin}/api/runtime-project`, {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:1',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(deniedProject.status, 400);
    assert.equal((await deniedProject.json()).error.code, 'K4-PREVIEW-TRANSPORT-ORIGIN');

    const projectResponse = await fetch(`${launchUrl.origin}/api/runtime-project`, {
      method: 'POST',
      headers: {
        origin: launchUrl.origin,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(projectResponse.status, 200);
    assert.equal(projectResponse.headers.get('cache-control'), 'no-store');
    assert.equal(projectResponse.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.deepEqual([...new Uint8Array(await projectResponse.arrayBuffer())], expectedProject);

    await writeFile(
      sourceManifestPath,
      `${JSON.stringify({...manifest, path: 'replacement.k4.yml'})}\n`,
    );
    structureWatch.emit('project.source.json');
    await waitFor(
      () => host.getSnapshot().rebuildRequired,
      'artifact structural change did not require a rebuild',
    );
    assert.equal(host.getSnapshot().runtimeArtifacts, null);
    assert.equal((await fetch(`${launchUrl.origin}/runtime/browser.js`)).status, 404);
  } finally {
    const disposed = await host.dispose();
    assert.equal(disposed.runtimeArtifacts, null);
    await runtime.liveReload.dispose();
    await rm(projectRoot, {recursive: true, force: true});
  }
});

test('streams generations to a browser-owned runtime without creating a Node protocol session', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'dsl4-browser-runtime-host-'));
  const sourceManifestPath = path.join(projectRoot, 'project.source.json');
  const sourceFilename = 'runtime-preview.k4.yml';
  const sourcePath = path.join(projectRoot, sourceFilename);
  const manifest = {formatVersion: 1, mode: 'external', sourceId: 'main', path: sourceFilename};
  await Promise.all([
    writeFile(sourceManifestPath, `${JSON.stringify(manifest)}\n`),
    writeFile(sourcePath, validSource),
  ]);
  const sourceWatch = fakeWatchFactory();
  const structureWatch = fakeWatchFactory();
  const observedEvents = [];
  const projectBytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x01]);
  const browserBundleBytes = new TextEncoder().encode('globalThis.browserRuntime = true;\n');
  const host = createDsl4LocalPreviewHost({
    projectRoot,
    sourceManifestPath,
    sourceManifest: manifest,
    sourceFrontend: frontend,
    maxSourceBytes: 4096,
    runtimeOwner: 'browser',
    projectBytes,
    browserBundleBytes,
    watcherOptions: {
      watchFactory: sourceWatch.factory,
      quietWindowMs: 0,
      retryIntervalMs: 1,
      stabilityTimeoutMs: 3,
    },
    structureWatchFactory: structureWatch.factory,
    onEvent: (event) => observedEvents.push(event),
  });

  try {
    assert.equal(host.getSnapshot().runtimeOwner, 'browser');
    await host.start();
    const launchUrl = new URL(host.getLaunchUrl());
    const token = launchUrl.hash.slice(1);
    const page = await fetch(launchUrl.origin);
    const pageBody = await page.text();
    assert.match(pageBody, /src="\/runtime\/browser\.js"/u);
    assert.equal(pageBody.includes('dsl4-local-preview-client.js'), false);

    const connected = await request(launchUrl.origin, '/api/connect', {body: {token}});
    assert.equal(connected.snapshot.status, 'connected');
    assert.equal(connected.snapshot.runtimeOwner, 'browser');
    const generationRecord = connected.events.find(
      (event) => event.type === 'local-preview.generation',
    );
    const generation = decodeDsl4PreviewSourceGenerationWire(
      new TextEncoder().encode(JSON.stringify(generationRecord.generation)),
    );
    assert.equal(generation.revision, 1);
    assert.equal(generation.result.storyDocument.scenes[0].id, 'opening');
    const sourceRecord = connected.events.find((event) => event.type === 'local-preview.source');
    assert.equal(sourceRecord.generationRevision, 1);
    assert.equal(sourceRecord.source.ok, true);
    assert.equal(Object.hasOwn(sourceRecord, 'acknowledgement'), false);
    assert.equal(
      observedEvents.some((event) => JSON.stringify(event).includes('StoryDocument')),
      false,
    );

    const projectResponse = await fetch(`${launchUrl.origin}/api/runtime-project`, {
      method: 'POST',
      headers: {
        origin: launchUrl.origin,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(projectResponse.status, 200);
    assert.deepEqual([...new Uint8Array(await projectResponse.arrayBuffer())], [...projectBytes]);

    const deniedCommit = await request(launchUrl.origin, '/api/commit', {
      token,
      body: {choice: 'storyStart'},
      expectedStatus: 400,
    });
    assert.equal(deniedCommit.error.code, 'K4-PREVIEW-HOST-RUNTIME-OWNER');

    await writeFile(sourcePath, "kamishibai: '4.0'\nscenes: {}\n");
    sourceWatch.emit(sourceFilename);
    await waitFor(() => host.getSnapshot().source?.ok === false, 'invalid source was not observed');
    const invalidRecord = observedEvents.findLast((event) => event.type === 'local-preview.source');
    assert.equal(invalidRecord.generationRevision, 2);
    assert.equal(invalidRecord.source.ok, false);
    assert.equal(JSON.stringify(invalidRecord).includes(validSource.trim()), false);
    assert.equal(JSON.stringify(invalidRecord).includes(projectRoot), false);
  } finally {
    await host.dispose();
    await rm(projectRoot, {recursive: true, force: true});
  }
  assert.equal(sourceWatch.closed, 1);
  assert.equal(structureWatch.closed, 1);
});

test('fails before opening sockets for unsafe local host configuration', () => {
  const runtime = createRuntimeProtocol();
  const base = {
    projectRoot: '/tmp/dsl4-project',
    sourceManifestPath: '/tmp/dsl4-project/project.source.json',
    sourceManifest: {formatVersion: 1, mode: 'external', sourceId: 'main'},
    sourceFrontend: frontend,
    maxSourceBytes: 4096,
    protocolSession: runtime.protocol,
  };
  assert.throws(() => createDsl4LocalPreviewHost({...base, bindHost: '0.0.0.0'}), /bindHost/u);
  assert.throws(
    () =>
      createDsl4LocalPreviewHost({
        ...base,
        sourceManifestPath: '/tmp/other/project.source.json',
      }),
    /sourceManifestPath/u,
  );
  assert.throws(() => createDsl4LocalPreviewHost({...base, port: 70_000}), /port/u);
  assert.throws(
    () =>
      createDsl4LocalPreviewHost({
        ...base,
        maxGenerationMessageBytes: dsl4PreviewSourceGenerationWireMaximumMessageBytes + 1,
      }),
    /maxGenerationMessageBytes/u,
  );
  assert.throws(
    () => createDsl4LocalPreviewHost({...base, projectBytes: Uint8Array.of(1)}),
    /must be provided together/u,
  );
  assert.throws(
    () =>
      createDsl4LocalPreviewHost({
        ...base,
        projectBytes: new Uint8Array(0),
        browserBundleBytes: Uint8Array.of(1),
      }),
    /projectBytes must contain/u,
  );
  assert.throws(
    () =>
      createDsl4LocalPreviewHost({
        ...base,
        maxProjectBytes: dsl4BrowserTurboWarpStageMaximumProjectBytes + 1,
      }),
    /maxProjectBytes must be <=/u,
  );
  assert.throws(
    () =>
      createDsl4LocalPreviewHost({
        ...base,
        maxBrowserBundleBytes: dsl4TurboWarpBrowserBundleMaximumBytes + 1,
      }),
    /maxBrowserBundleBytes must be <=/u,
  );
  const withoutProtocol = {...base};
  delete withoutProtocol.protocolSession;
  assert.throws(
    () => createDsl4LocalPreviewHost({...withoutProtocol, runtimeOwner: 'browser'}),
    /requires projectBytes and browserBundleBytes/u,
  );
  assert.throws(
    () =>
      createDsl4LocalPreviewHost({
        ...base,
        runtimeOwner: 'browser',
        projectBytes: Uint8Array.of(1),
        browserBundleBytes: Uint8Array.of(1),
      }),
    /protocolSession must be omitted/u,
  );
  assert.throws(
    () => createDsl4LocalPreviewHost({...base, runtimeOwner: 'worker'}),
    /runtimeOwner must be protocol or browser/u,
  );
  void runtime.liveReload.dispose();
});

test('closes the loopback socket when disposal races server startup', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'dsl4-local-preview-dispose-race-'));
  const runtime = createRuntimeProtocol();
  const host = createDsl4LocalPreviewHost({
    projectRoot,
    sourceManifestPath: path.join(projectRoot, 'project.source.json'),
    sourceManifest: {formatVersion: 1, mode: 'external', sourceId: 'main'},
    sourceFrontend: frontend,
    maxSourceBytes: 4096,
    protocolSession: runtime.protocol,
  });

  try {
    const starting = host.start();
    const disposing = host.dispose();
    await assert.rejects(starting, /disposed while starting/u);
    const snapshot = await disposing;
    assert.equal(snapshot.status, 'disposed');
    assert.equal(snapshot.disposed, true);
    assert.equal(snapshot.connected, false);
    assert.equal(host.getSnapshot().status, 'disposed');
    assert.throws(() => host.getLaunchUrl(), /unavailable/u);
    assert.throws(() => host.start(), /disposed/u);
  } finally {
    await host.dispose();
    await runtime.liveReload.dispose();
    await rm(projectRoot, {recursive: true, force: true});
  }
});
