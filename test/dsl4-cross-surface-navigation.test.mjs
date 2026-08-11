import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {strToU8, unzipSync, zipSync} from 'fflate';

import {embedDsl4PackagedRuntimeComponentInSb3} from '../src/builder/index.js';
import {
  createDsl4EmbeddedAssetBundle,
  createDsl4EmbeddedSourceDescriptor,
  createDsl4RuntimeArtifactDescriptor,
  createDsl4RuntimeStartup,
  createDsl4SourceFrontend,
} from '../src/dsl4/index.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const sourceText = await readFile(
  new URL('fixtures/dsl4/cross-surface-navigation.kamishibai.yaml', import.meta.url),
  'utf8',
);
const contract = JSON.parse(
  await readFile(new URL('fixtures/dsl4/cross-surface-navigation.json', import.meta.url), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const subtleCrypto = webcrypto.subtle;
const limits = Object.freeze({
  maxSourceBytes: 16_384,
  maxAssetFiles: 8,
  maxAssetBytes: 8_192,
});
const historyLimits = Object.freeze({maxActionEntries: 32, maxSceneVisits: 16});

function baseSb3() {
  return Buffer.from(
    zipSync({
      'project.json': strToU8(
        `${JSON.stringify({extensionStorage: {}, targets: [], monitors: []})}\n`,
      ),
    }),
  );
}

function projectFromSb3(bytes) {
  const projectBytes = unzipSync(bytes)['project.json'];
  assert.ok(projectBytes, 'project.json must remain in the SB3');
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(projectBytes));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, reject, resolve};
}

function keyEvent(code) {
  const counters = {preventDefault: 0, stopPropagation: 0};
  return {
    code,
    defaultPrevented: false,
    repeat: false,
    preventDefault() {
      counters.preventDefault += 1;
      this.defaultPrevented = true;
    },
    stopPropagation() {
      counters.stopPropagation += 1;
    },
    counters,
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

async function packagedComponent() {
  const parsed = frontend.parse(sourceText, {
    sourceId: 'cross-surface-navigation.kamishibai.yaml',
  });
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const sourceDescriptor = await createDsl4EmbeddedSourceDescriptor(sourceText, {
    sourceId: 'cross-surface-navigation.kamishibai.yaml',
    displayName: 'cross-surface-navigation.kamishibai.yaml',
    maxSourceBytes: limits.maxSourceBytes,
    subtleCrypto,
  });
  const artifactResult = await createDsl4RuntimeArtifactDescriptor(
    parsed.storyDocument,
    sourceDescriptor,
    contract.controlProfile,
    {
      maxSourceBytes: limits.maxSourceBytes,
      historyNavigationAvailable: true,
      subtleCrypto,
    },
  );
  assert.equal(artifactResult.ok, true, JSON.stringify(artifactResult.diagnostics));
  const assetBundle = await createDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    {
      manifest: {formatVersion: 1, assets: []},
      getFile() {
        assert.fail('the cross-surface fixture has no binary assets');
      },
    },
    {maxFiles: limits.maxAssetFiles, maxTotalBytes: limits.maxAssetBytes, subtleCrypto},
  );
  return Object.freeze({
    storyDocument: parsed.storyDocument,
    sourceDescriptor,
    runtimeArtifact: artifactResult.artifact,
    assetBundle,
  });
}

async function rehearsalPackagedComponent() {
  const source = `kamishibai: '4.0'
controls:
  keymaps:
    production:
      ArrowRight: rehearsal.skipAction
      ArrowDown: rehearsal.skipScene
scenes:
  opening:
    - wait: 60
    - wait: 60
    - wait: 60
  ending:
    - wait: 60
`;
  const parsed = frontend.parse(source, {sourceId: 'cross-surface-rehearsal.k4.yml'});
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const sourceDescriptor = await createDsl4EmbeddedSourceDescriptor(source, {
    sourceId: 'cross-surface-rehearsal.k4.yml',
    displayName: 'cross-surface-rehearsal.k4.yml',
    maxSourceBytes: limits.maxSourceBytes,
    subtleCrypto,
  });
  const artifactResult = await createDsl4RuntimeArtifactDescriptor(
    parsed.storyDocument,
    sourceDescriptor,
    'production',
    {maxSourceBytes: limits.maxSourceBytes, subtleCrypto},
  );
  assert.equal(artifactResult.ok, true, JSON.stringify(artifactResult.diagnostics));
  const assetBundle = await createDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    {
      manifest: {formatVersion: 1, assets: []},
      getFile() {
        assert.fail('the cross-surface rehearsal fixture has no binary assets');
      },
    },
    {maxFiles: limits.maxAssetFiles, maxTotalBytes: limits.maxAssetBytes, subtleCrypto},
  );
  return Object.freeze({
    storyDocument: parsed.storyDocument,
    sourceDescriptor,
    runtimeArtifact: artifactResult.artifact,
    assetBundle,
  });
}

async function projectForSurface(component, surface) {
  const embedded = await embedDsl4PackagedRuntimeComponentInSb3(
    baseSb3(),
    component.storyDocument,
    component.sourceDescriptor,
    component.runtimeArtifact,
    component.assetBundle,
    {
      channel: surface.channel,
      ...limits,
      historyNavigationAvailable: true,
      subtleCrypto,
    },
  );
  return projectFromSb3(embedded.bytes);
}

async function exerciseSurface(component, surface) {
  const waits = [];
  let presentationState = 'initial';
  const project = await projectForSurface(component, surface);
  const startup = await createDsl4RuntimeStartup({
    featureFlags: {dsl4Runtime: true},
    project,
    sourceFrontend: frontend,
    ...limits,
    historyNavigationAvailable: true,
    historyLimits,
    subtleCrypto,
    port: {
      wait(_payload, context) {
        const nextScore = Number(context.getVariable('score')) + 1;
        context.setVariable('score', nextScore);
        presentationState = `wait-${nextScore}`;
        const pending = deferred();
        waits.push(pending);
        return pending.promise;
      },
    },
  });
  assert.equal(startup.ok, true, `${surface.label}: ${JSON.stringify(startup.diagnostics)}`);
  assert.equal(startup.channel, surface.channel);
  assert.equal(startup.runtimeComponent.runtimeArtifact.controlProfile, contract.controlProfile);
  assert.deepEqual(
    startup.runtimeComponent.runtimeArtifact.resolvedKeymap,
    contract.resolvedKeymap,
  );
  assert.equal(startup.runtimeComponent.runtimeArtifact.historyNavigationEnabled, true);

  const {session} = startup;
  const unbound = keyEvent('ArrowRight');
  assert.equal(session.handleKeyDown(unbound), false);
  assert.deepEqual(unbound.counters, {preventDefault: 0, stopPropagation: 0});

  session.start();
  await waitFor(() => waits.length === 1, `${surface.label}: opening did not start`);
  for (const expectedWaitCount of [2, 3]) {
    const advance = keyEvent('Space');
    assert.equal(session.handleKeyDown(advance), true);
    await session.whenInputIdle();
    assert.deepEqual(advance.counters, {preventDefault: 1, stopPropagation: 1});
    await waitFor(
      () => waits.length === expectedWaitCount,
      `${surface.label}: the next scene did not start`,
    );
  }
  assert.deepEqual(
    session.getState().history.sceneVisits.map(({sceneId}) => sceneId),
    contract.expected.visitedScenes,
  );
  assert.equal(session.getState().runtime.variables.score, contract.expected.scoreBeforeRewind);
  assert.equal(presentationState, `wait-${contract.expected.scoreBeforeRewind}`);

  const rewoundScenes = [];
  for (const code of ['ArrowUp', 'ArrowUp', 'ArrowDown']) {
    const navigation = keyEvent(code);
    assert.equal(session.handleKeyDown(navigation), true);
    await session.whenInputIdle();
    assert.deepEqual(navigation.counters, {preventDefault: 1, stopPropagation: 1});
    rewoundScenes.push(session.getState().runtime.sceneId);
    assert.equal(session.getState().runtime.variables.score, contract.expected.scoreBeforeRewind);
    assert.equal(presentationState, `wait-${contract.expected.scoreBeforeRewind}`);
  }
  assert.deepEqual(rewoundScenes, contract.expected.rewoundScenes);

  session.handleKeyDown(keyEvent('Space'));
  await session.whenInputIdle();
  await waitFor(() => waits.length === 4, `${surface.label}: history position did not resume`);
  assert.deepEqual(
    session.getState().history.sceneVisits.map(({sceneId}) => sceneId),
    ['opening', 'middle'],
  );

  session.handleKeyDown(keyEvent('Space'));
  await session.whenInputIdle();
  await waitFor(() => waits.length === 5, `${surface.label}: rebuilt future did not start`);
  const finalState = session.getState();
  const summary = {
    surface: surface.id,
    delivery: surface.delivery,
    channel: startup.channel,
    keymap: finalState.keymap,
    historyEnabled: finalState.historyEnabled,
    sceneVisits: finalState.history.sceneVisits.map(({sceneId}) => sceneId),
    visitIds: finalState.history.sceneVisits.map(({visitId}) => visitId),
    score: finalState.runtime.variables.score,
    presentationState,
  };
  assert.deepEqual(summary.sceneVisits, contract.expected.rebuiltFutureScenes);
  assert.deepEqual(summary.visitIds, [1, 2, 4]);
  assert.equal(summary.score, contract.expected.scoreAfterFutureRebuild);
  assert.equal(summary.presentationState, `wait-${contract.expected.scoreAfterFutureRebuild}`);

  const previousAction = keyEvent('ArrowLeft');
  assert.equal(session.handleKeyDown(previousAction), true);
  await session.whenInputIdle();
  assert.deepEqual(previousAction.counters, {preventDefault: 1, stopPropagation: 1});
  assert.equal(session.getState().runtime.status, 'paused');
  assert.equal(
    session.getState().runtime.variables.score,
    contract.expected.scoreAfterFutureRebuild,
  );
  assert.equal(presentationState, `wait-${contract.expected.scoreAfterFutureRebuild}`);

  session.stop('cross-surface-fixture-complete');
  for (const wait of waits) wait.resolve();
  return summary;
}

test('runs one immutable keymap and chronological history contract on every delivery surface', async () => {
  assert.equal(contract.formatVersion, 1);
  assert.deepEqual(
    contract.surfaces.map(({id}) => id),
    ['web', 'turbowarpEditor', 'packager'],
  );
  const component = await packagedComponent();
  assert.deepEqual(component.runtimeArtifact.resolvedKeymap, contract.resolvedKeymap);

  const results = [];
  for (const surface of contract.surfaces) {
    results.push(await exerciseSurface(component, surface));
  }
  const semanticResults = results.map(
    ({surface: _surface, delivery: _delivery, channel: _channel, ...rest}) => rest,
  );
  assert.deepEqual(semanticResults[1], semanticResults[0]);
  assert.deepEqual(semanticResults[2], semanticResults[0]);
});

test('reproduces rehearsal action and scene skips on every delivery surface', async () => {
  const component = await rehearsalPackagedComponent();
  for (const surface of contract.surfaces) {
    const waits = [];
    const project = await projectForSurface(component, surface);
    const startup = await createDsl4RuntimeStartup({
      featureFlags: {dsl4Runtime: true},
      project,
      sourceFrontend: frontend,
      ...limits,
      subtleCrypto,
      port: {
        wait(_payload, context) {
          const pending = deferred();
          waits.push(pending);
          context.signal.addEventListener(
            'abort',
            () => {
              const error = new Error('rehearsal wait cancelled');
              error.name = 'AbortError';
              pending.reject(error);
            },
            {once: true},
          );
          return pending.promise;
        },
      },
    });
    assert.equal(startup.ok, true, `${surface.label}: ${JSON.stringify(startup.diagnostics)}`);
    const run = startup.session.start();
    await waitFor(() => waits.length === 1, `${surface.label}: first wait did not start`);

    const right = keyEvent('ArrowRight');
    assert.equal(startup.session.handleKeyDown(right), true);
    assert.deepEqual(right.counters, {preventDefault: 1, stopPropagation: 1});
    await waitFor(() => waits.length === 2, `${surface.label}: action skip did not advance`);
    assert.equal(startup.session.getState().runtime.actionIndex, 1);

    const down = keyEvent('ArrowDown');
    assert.equal(startup.session.handleKeyDown(down), true);
    assert.deepEqual(down.counters, {preventDefault: 1, stopPropagation: 1});
    await waitFor(
      () => startup.session.getState().runtime.sceneId === 'ending' && waits.length === 3,
      `${surface.label}: scene skip did not enter ending`,
    );
    assert.equal(startup.session.getState().runtime.actionIndex, 0);

    startup.session.stop('cross-surface-rehearsal-complete');
    await Promise.allSettled([run, startup.session.getRunPromise()]);
  }
});

test('keeps the shared runtime composition root inert on every surface while the flag is OFF', async () => {
  for (const surface of contract.surfaces) {
    const result = await createDsl4RuntimeStartup({
      featureFlags: {dsl4Runtime: false},
      project: new Proxy({}, {get: () => assert.fail(`${surface.label}: project was inspected`)}),
      sourceFrontend: new Proxy(
        {},
        {get: () => assert.fail(`${surface.label}: frontend was inspected`)},
      ),
    });
    assert.equal(result.ok, true);
    assert.equal(result.enabled, false);
    assert.equal(result.session, null);
  }
});
