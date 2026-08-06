import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {installDsl4PackagedRuntimeComponent} from '../src/builder/index.js';
import {
  createDsl4EmbeddedAssetBundle,
  createDsl4EmbeddedSourceDescriptor,
  createDsl4RuntimeArtifactDescriptor,
  createDsl4RuntimeStartup,
  createDsl4SourceFrontend,
  dsl4DefaultFeatureFlags,
  resolveDsl4FeatureFlags,
} from '../src/dsl4/index.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const subtleCrypto = webcrypto.subtle;
const maxSourceBytes = 8192;
const maxAssetFiles = 10;
const maxAssetBytes = 8192;
const sourceText = `
kamishibai: '4.0'
controls:
  keymaps:
    development:
      ArrowLeft: history.previousAction
      Space: navigation.nextAction
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - wait: 0
`;

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

function baseProject() {
  return {extensionStorage: {}, targets: [], monitors: []};
}

async function packagedProject(profile, historyNavigationAvailable = false, source = sourceText) {
  const parsed = frontend.parse(source, {sourceId: 'main'});
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const sourceDescriptor = await createDsl4EmbeddedSourceDescriptor(source, {
    sourceId: 'main',
    displayName: 'story.kamishibai.yaml',
    maxSourceBytes,
    subtleCrypto,
  });
  const artifactResult = await createDsl4RuntimeArtifactDescriptor(
    parsed.storyDocument,
    sourceDescriptor,
    profile,
    {maxSourceBytes, historyNavigationAvailable, subtleCrypto},
  );
  assert.equal(artifactResult.ok, true, JSON.stringify(artifactResult.diagnostics));
  const assetBundle = await createDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    {manifest: {formatVersion: 1, assets: []}, getFile() {}},
    {maxFiles: maxAssetFiles, maxTotalBytes: maxAssetBytes, subtleCrypto},
  );
  const project = await installDsl4PackagedRuntimeComponent(
    baseProject(),
    parsed.storyDocument,
    sourceDescriptor,
    artifactResult.artifact,
    assetBundle,
    {
      channel: 'unbundled',
      maxSourceBytes,
      maxAssetFiles,
      maxAssetBytes,
      historyNavigationAvailable,
      subtleCrypto,
    },
  );
  return {project, runtimeArtifact: artifactResult.artifact};
}

const enabledOptions = (project, extra = {}) => ({
  featureFlags: {dsl4Runtime: true},
  project,
  sourceFrontend: frontend,
  maxSourceBytes,
  maxAssetFiles,
  maxAssetBytes,
  port: {},
  subtleCrypto,
  ...extra,
});

test('defaults OFF and does not inspect runtime inputs or adapters', async () => {
  assert.deepEqual(dsl4DefaultFeatureFlags, {dsl4Runtime: false});
  assert.equal(Object.isFrozen(dsl4DefaultFeatureFlags), true);
  const implicit = await createDsl4RuntimeStartup();
  let factoryCalls = 0;
  const explicit = await createDsl4RuntimeStartup({
    featureFlags: {dsl4Runtime: false},
    project: new Proxy({}, {get: () => assert.fail('project must not be read')}),
    sourceFrontend: new Proxy({}, {get: () => assert.fail('frontend must not be read')}),
    port: new Proxy({}, {get: () => assert.fail('port must not be read')}),
    createAssetLifecycle() {
      factoryCalls += 1;
      assert.fail('asset lifecycle factory must not be called');
    },
    createRuntimeEnvironment() {
      factoryCalls += 1;
      assert.fail('runtime environment factory must not be called');
    },
  });
  assert.equal(factoryCalls, 0);
  for (const result of [implicit, explicit]) {
    assert.equal(result.ok, true);
    assert.equal(result.enabled, false);
    assert.equal(result.session, null);
    assert.deepEqual(result.featureFlags, {dsl4Runtime: false});
    assert.equal(Object.isFrozen(result), true);
  }
});

test('strictly resolves one immutable startup flag snapshot', async () => {
  assert.deepEqual(resolveDsl4FeatureFlags(), {dsl4Runtime: false});
  assert.deepEqual(resolveDsl4FeatureFlags({}), {dsl4Runtime: false});
  assert.deepEqual(resolveDsl4FeatureFlags({dsl4Runtime: true}), {dsl4Runtime: true});
  assert.throws(() => resolveDsl4FeatureFlags({dsl4Runtime: 1}), TypeError);
  assert.throws(() => resolveDsl4FeatureFlags({dsl4Runtime: false, extra: true}), TypeError);

  const component = await packagedProject('production');
  const mutableFlags = {dsl4Runtime: true};
  const pending = createDsl4RuntimeStartup(
    enabledOptions(component.project, {featureFlags: mutableFlags}),
  );
  mutableFlags.dsl4Runtime = false;
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.deepEqual(result.featureFlags, {dsl4Runtime: true});
  assert.equal(Object.isFrozen(result.featureFlags), true);
  result.session.dispose();
});

test('withholds component and session when enabled startup validation fails', async () => {
  let factoryCalls = 0;
  const result = await createDsl4RuntimeStartup(
    enabledOptions(baseProject(), {
      createAssetLifecycle() {
        factoryCalls += 1;
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.enabled, true);
  assert.equal(result.diagnostics[0].code, 'K4-SOURCE-CHANNEL-MISSING');
  assert.equal(Object.hasOwn(result, 'runtimeComponent'), false);
  assert.equal(Object.hasOwn(result, 'session'), false);
  assert.equal(factoryCalls, 0);
});

test('creates a component-aware asset lifecycle after validation and releases it', async () => {
  const component = await packagedProject('production');
  const calls = [];
  let receivedComponent;
  let receivedContext;
  const result = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {
      createAssetLifecycle(runtimeComponent, startupContext) {
        receivedComponent = runtimeComponent;
        receivedContext = startupContext;
        calls.push(['create']);
        return {
          prepare(payload, context) {
            calls.push(['prepare', payload, context]);
          },
          setLoading(payload, context) {
            calls.push(['setLoading', payload, context]);
          },
          releaseAssets(payload) {
            calls.push(['releaseAssets', payload]);
          },
          release(payload) {
            calls.push(['release', payload]);
          },
        };
      },
      port: {wait() {}},
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.strictEqual(receivedComponent, result.runtimeComponent);
  assert.equal(Object.isFrozen(receivedComponent), true);
  assert.equal(typeof receivedComponent.getAssetFile, 'function');
  assert.deepEqual(receivedContext, {
    channel: 'unbundled',
    featureFlags: {dsl4Runtime: true},
  });
  assert.equal(Object.isFrozen(receivedContext), true);
  assert.equal(Object.isFrozen(receivedContext.featureFlags), true);
  assert.deepEqual(
    calls.map(([name]) => name),
    ['create'],
  );

  const finished = await result.session.start();
  assert.equal(finished.status, 'finished');
  assert.deepEqual(
    calls.map(([name]) => name),
    ['create', 'prepare'],
  );
  result.session.dispose();
  await waitUntil(() => calls.some(([name]) => name === 'release'));
  assert.deepEqual(
    calls.map(([name]) => name),
    ['create', 'prepare', 'release'],
  );
});

test('rejects conflicting or invalid asset lifecycle factories before publishing a session', async () => {
  const component = await packagedProject('production');
  await assert.rejects(
    createDsl4RuntimeStartup(
      enabledOptions(component.project, {
        assetLifecycle: {prepare() {}, setLoading() {}, releaseAssets() {}, release() {}},
        createAssetLifecycle() {},
      }),
    ),
    /either assetLifecycle or createAssetLifecycle/u,
  );
  await assert.rejects(
    createDsl4RuntimeStartup(
      enabledOptions(component.project, {createAssetLifecycle: /** @type {any} */ ({})}),
    ),
    /must be a function/u,
  );
  await assert.rejects(
    createDsl4RuntimeStartup(
      enabledOptions(component.project, {createAssetLifecycle: () => ({prepare() {}})}),
    ),
    /must provide prepare, setLoading, releaseAssets, and release/u,
  );
  await assert.rejects(
    createDsl4RuntimeStartup(
      enabledOptions(component.project, {createAssetLifecycle: () => undefined}),
    ),
    /must provide prepare, setLoading, releaseAssets, and release/u,
  );
});

test('creates isolated lifecycle instances for separate startups', async () => {
  const component = await packagedProject('production');
  const receivedComponents = [];
  const releases = [];
  let instance = 0;
  const createAssetLifecycle = (runtimeComponent) => {
    receivedComponents.push(runtimeComponent);
    const current = ++instance;
    return {
      prepare() {},
      setLoading() {},
      releaseAssets() {},
      release() {
        releases.push(current);
      },
    };
  };
  const first = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {createAssetLifecycle}),
  );
  const second = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {createAssetLifecycle}),
  );
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(instance, 2);
  assert.notStrictEqual(receivedComponents[0], receivedComponents[1]);
  await first.session.start();
  await second.session.start();
  first.session.dispose();
  second.session.dispose();
  await waitUntil(() => releases.length === 2);
  assert.deepEqual(releases.sort(), [1, 2]);
});

test('creates an atomic runtime environment only after component validation', async () => {
  const component = await packagedProject('production');
  const calls = [];
  let receivedComponent;
  let receivedContext;
  const result = await createDsl4RuntimeStartup({
    featureFlags: {dsl4Runtime: true},
    project: component.project,
    sourceFrontend: frontend,
    maxSourceBytes,
    maxAssetFiles,
    maxAssetBytes,
    subtleCrypto,
    createRuntimeEnvironment(runtimeComponent, startupContext) {
      receivedComponent = runtimeComponent;
      receivedContext = startupContext;
      calls.push('create');
      return {
        port: {wait() {}},
        assetLifecycle: {prepare() {}, setLoading() {}, releaseAssets() {}, release() {}},
        dispose(reason) {
          calls.push(`dispose:${reason}`);
        },
      };
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.strictEqual(receivedComponent, result.runtimeComponent);
  assert.deepEqual(receivedContext, {
    channel: 'unbundled',
    featureFlags: {dsl4Runtime: true},
  });
  assert.deepEqual(calls, ['create']);
  assert.equal(result.session.getState().runtime.status, 'idle');
  const firstDispose = result.session.dispose('startup-test-dispose');
  const secondDispose = result.session.dispose('ignored');
  assert.strictEqual(secondDispose, firstDispose);
  await firstDispose;
  assert.deepEqual(calls, ['create', 'dispose:startup-test-dispose']);
});

test('uses the condition evaluator owned by the atomic runtime environment', async () => {
  const component = await packagedProject(
    'production',
    false,
    `
kamishibai: '4.0'
variables:
  score: 2
controls:
  keymaps:
    production:
      Space: navigation.nextAction
branches:
  route:
    - if: 'score === 2'
      goto: accepted
    - else: rejected
scenes:
  opening:
    - branch: route
  rejected:
    - wait: 0
  accepted:
    - wait: 0
`,
  );
  const evaluations = [];
  const result = await createDsl4RuntimeStartup({
    featureFlags: {dsl4Runtime: true},
    project: component.project,
    sourceFrontend: frontend,
    maxSourceBytes,
    maxAssetFiles,
    maxAssetBytes,
    subtleCrypto,
    evaluateCondition() {
      assert.fail('the top-level evaluator must not replace environment ownership');
    },
    createRuntimeEnvironment() {
      return {
        port: {wait() {}},
        evaluateCondition(expression, variables) {
          evaluations.push({expression, variables});
          return expression === 'score === 2' && variables.score === 2;
        },
        dispose() {},
      };
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const finished = await result.session.start();
  assert.equal(finished.status, 'finished');
  assert.equal(finished.sceneId, 'accepted');
  assert.deepEqual(evaluations, [{expression: 'score === 2', variables: {score: 2}}]);
  await result.session.dispose('environment-evaluator-complete');
});

test('cleans an atomic runtime environment when navigation session creation is rejected', async () => {
  const component = await packagedProject('development', true);
  const calls = [];
  const result = await createDsl4RuntimeStartup({
    featureFlags: {dsl4Runtime: true},
    project: component.project,
    sourceFrontend: frontend,
    maxSourceBytes,
    maxAssetFiles,
    maxAssetBytes,
    historyNavigationAvailable: true,
    subtleCrypto,
    createRuntimeEnvironment() {
      calls.push('create');
      return {
        port: {wait() {}},
        dispose(reason) {
          calls.push(`dispose:${reason}`);
        },
      };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, 'K4-HISTORY-LIMIT-CONFIG-001');
  assert.deepEqual(calls, ['create', 'dispose:navigation-session-rejected']);
});

test('rejects conflicting or malformed atomic runtime environment options', async () => {
  const component = await packagedProject('production');
  await assert.rejects(
    createDsl4RuntimeStartup({
      ...enabledOptions(component.project),
      createRuntimeEnvironment() {},
    }),
    /cannot be combined/u,
  );
  await assert.rejects(
    createDsl4RuntimeStartup({
      ...enabledOptions(component.project),
      port: undefined,
      createRuntimeEnvironment: /** @type {any} */ ({}),
    }),
    /must be a function/u,
  );
  const calls = [];
  await assert.rejects(
    createDsl4RuntimeStartup({
      ...enabledOptions(component.project),
      port: undefined,
      createRuntimeEnvironment() {
        return {
          port: {wait: 1},
          dispose(reason) {
            calls.push(reason);
          },
        };
      },
    }),
    /port values must be functions/u,
  );
  await assert.rejects(
    createDsl4RuntimeStartup({
      ...enabledOptions(component.project),
      port: undefined,
      createRuntimeEnvironment() {
        return {
          port: {wait() {}},
          evaluateCondition: true,
          dispose(reason) {
            calls.push(reason);
          },
        };
      },
    }),
    /evaluateCondition must be a function/u,
  );
  assert.deepEqual(calls, ['invalid-runtime-environment', 'invalid-runtime-environment']);
});

test('creates but does not auto-start or attach a production navigation session', async () => {
  const component = await packagedProject('production');
  const calls = [];
  const events = [];
  const lifecycle = {
    prepare(payload, context) {
      calls.push(['prepare', payload, context]);
    },
    setLoading(payload, context) {
      calls.push(['setLoading', payload, context]);
    },
    releaseAssets(payload) {
      calls.push(['releaseAssets', payload]);
    },
    release(payload) {
      calls.push(['release', payload]);
    },
  };
  const result = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {
      port: {
        wait(payload, context) {
          calls.push(['wait', payload, context]);
        },
      },
      assetLifecycle: lifecycle,
      onEvent(event) {
        events.push(event);
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.enabled, true);
  assert.equal(result.channel, 'unbundled');
  assert.deepEqual(result.session.getState().keymap, component.runtimeArtifact.resolvedKeymap);
  assert.equal(result.session.getState().historyEnabled, false);
  assert.equal(result.session.getState().history, null);
  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);

  const finished = await result.session.start();
  assert.equal(finished.status, 'finished');
  assert.deepEqual(
    calls.map(([name]) => name),
    ['prepare', 'wait'],
  );
  assert.equal(
    events.some(({type}) => type === 'action.commit'),
    true,
  );
  result.session.dispose();
  await waitUntil(() => calls.some(([name]) => name === 'release'));
  assert.equal(
    calls.some(([name]) => name === 'release'),
    true,
  );
});

test('uses artifact history activation and requires availability plus finite limits', async () => {
  const component = await packagedProject('development', true);
  let factoryCalls = 0;
  const createAssetLifecycle = () => {
    factoryCalls += 1;
    return {prepare() {}, setLoading() {}, releaseAssets() {}, release() {}};
  };
  const unavailable = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {createAssetLifecycle}),
  );
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.diagnostics[0].code, 'K4-KEYMAP-HISTORY-UNAVAILABLE');
  assert.equal(Object.hasOwn(unavailable, 'session'), false);

  const unlimited = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {
      historyNavigationAvailable: true,
      createAssetLifecycle,
    }),
  );
  assert.equal(unlimited.ok, false);
  assert.equal(unlimited.diagnostics[0].code, 'K4-HISTORY-LIMIT-CONFIG-001');
  assert.equal(Object.hasOwn(unlimited, 'runtimeComponent'), false);
  assert.equal(Object.hasOwn(unlimited, 'session'), false);
  assert.equal(factoryCalls, 0);

  const enabled = await createDsl4RuntimeStartup(
    enabledOptions(component.project, {
      historyNavigationAvailable: true,
      historyLimits: {maxActionEntries: 20, maxSceneVisits: 10},
    }),
  );
  assert.equal(enabled.ok, true, JSON.stringify(enabled.diagnostics));
  assert.equal(enabled.session.getState().historyEnabled, true);
  assert.notEqual(enabled.session.getState().history, null);
  assert.deepEqual(enabled.session.getState().keymap, component.runtimeArtifact.resolvedKeymap);
  enabled.session.dispose();
});

test('startup composition core has no global DOM, VM, or Scratch dependency', async () => {
  const implementation = await readFile(
    path.join(repositoryRoot, 'src', 'dsl4', 'runtime-startup.js'),
    'utf8',
  );
  assert.doesNotMatch(implementation, /(?:globalThis\.(?:document|window)|KeyboardEvent)/u);
  assert.doesNotMatch(implementation, /(?:\bScratch\b|scratch-vm|vm\.runtime|startHats)/u);
});
