import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {createSessionBinaryBacking} from '@kubohiroya/turbowarp-asset-manager/composition';
import {IDBFactory} from 'fake-indexeddb';
import {strToU8, zipSync} from 'fflate';

import {
  createDsl4BinaryEntryProviderFromSb3,
  embedDsl4BinaryEntryRuntimeComponentInSb3,
  installDsl4BinaryEntryRuntimeComponent,
} from '../src/builder/index.js';
import {
  createDsl4BinaryEntryAssetBundle,
  createDsl4EmbeddedSourceDescriptor,
  createDsl4OneShotBinaryEntryProvider,
  createDsl4RuntimeArtifactDescriptor,
  createDsl4RuntimeStartup,
  createDsl4SourceFrontend,
  loadDsl4BinaryEntryRuntimeComponent,
} from '../src/dsl4/index.js';
import {
  createDsl4BinaryEntryBacking,
  createDsl4PlatformAssetSession,
} from '../src/dsl4/platform/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const subtleCrypto = webcrypto.subtle;
const limits = Object.freeze({
  maxSourceBytes: 16 * 1024,
  maxAssetFiles: 12,
  maxAssetFileBytes: 4096,
  maxAssetBytes: 32 * 1024,
});
const sourceText = `
kamishibai: '4.0'
assets:
  FirstPose:
    kind: poseModel
    file: models/first
    loading: lazy
  NextPose:
    kind: poseModel
    file: models/next
    loading: lazy
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  first:
    poseModel: FirstPose
    actions:
      - goto: next
  next:
    poseModel: NextPose
    actions: []
`;
const cacheIdentity = Object.freeze({
  id: 'binarybacking0001',
  label: 'story.kamishibai.yaml',
  databaseName: 'tw-kamishibai-assets-v1--story--binarybacking0001',
});

function sri(bytes) {
  return `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
}

function baseProject() {
  return {
    extensionStorage: {localstorage: {namespace: 'kamishibai'}},
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {start: {opcode: 'event_whenflagclicked', next: null, parent: null}},
      },
    ],
    monitors: [],
  };
}

function baseSb3() {
  return Buffer.from(zipSync({'project.json': strToU8(`${JSON.stringify(baseProject())}\n`)}));
}

function assetSnapshot() {
  const files = new Map();
  for (const [assetId, label, weight] of [
    ['FirstPose', 'first', 1],
    ['NextPose', 'next', 2],
  ]) {
    files.set(`${assetId}\0metadata.json`, new TextEncoder().encode(`{"labels":["${label}"]}`));
    files.set(`${assetId}\0model.json`, new TextEncoder().encode(`{"model":"${label}"}`));
    files.set(`${assetId}\0weights.bin`, new Uint8Array([weight, weight + 1, weight + 2]));
  }
  return {
    manifest: {
      formatVersion: 1,
      assets: ['FirstPose', 'NextPose'].map((assetId) => ({
        id: assetId,
        kind: 'poseModel',
        loading: 'lazy',
        source: {
          type: 'file',
          inputPath: assetId === 'FirstPose' ? 'models/first' : 'models/next',
          mode: 'directory',
          files: ['metadata.json', 'model.json', 'weights.bin'].map((filePath) => {
            const bytes = files.get(`${assetId}\0${filePath}`);
            return {path: filePath, size: bytes.length, integrity: sri(bytes)};
          }),
        },
      })),
    },
    getFile(assetId, filePath) {
      return new Uint8Array(files.get(`${assetId}\0${filePath}`));
    },
  };
}

async function fixture() {
  const parsed = frontend.parse(sourceText, {sourceId: 'main'});
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const sourceDescriptor = await createDsl4EmbeddedSourceDescriptor(sourceText, {
    sourceId: 'main',
    displayName: cacheIdentity.label,
    cacheIdentity,
    maxSourceBytes: limits.maxSourceBytes,
    subtleCrypto,
  });
  const runtimeArtifact = await createDsl4RuntimeArtifactDescriptor(
    parsed.storyDocument,
    sourceDescriptor,
    'production',
    {maxSourceBytes: limits.maxSourceBytes, subtleCrypto},
  );
  assert.equal(runtimeArtifact.ok, true, JSON.stringify(runtimeArtifact.diagnostics));
  const binaryBundle = await createDsl4BinaryEntryAssetBundle(
    parsed.storyDocument,
    assetSnapshot(),
    {
      maxFiles: limits.maxAssetFiles,
      maxFileBytes: limits.maxAssetFileBytes,
      maxTotalBytes: limits.maxAssetBytes,
      subtleCrypto,
    },
  );
  return {
    storyDocument: parsed.storyDocument,
    sourceDescriptor,
    runtimeArtifact: runtimeArtifact.artifact,
    binaryBundle,
    runtimeComponent: Object.freeze({
      storyDocument: parsed.storyDocument,
      sourceDescriptor,
      assetBundle: binaryBundle.descriptor,
    }),
  };
}

async function providerFor(component) {
  return createDsl4OneShotBinaryEntryProvider(
    component.storyDocument,
    component.binaryBundle.descriptor,
    {
      maxFiles: limits.maxAssetFiles,
      maxFileBytes: limits.maxAssetFileBytes,
      maxTotalBytes: limits.maxAssetBytes,
      maxCompressionRatio: 1,
      releaseAfterLastAsset: false,
      readEntry(entryName) {
        const bytes = component.binaryBundle.getEntry(entryName);
        return {bytes, compressedSize: bytes.length};
      },
      subtleCrypto,
    },
  );
}

function sessionComposition(databaseName, indexedDB = new IDBFactory()) {
  const backingOptions = {
    indexedDB,
    subtleCrypto,
    databaseName,
    heartbeatIntervalMs: 60_000,
  };
  return Object.freeze({
    createSessionBinaryBacking(input, operationOptions) {
      return createSessionBinaryBacking(input, backingOptions, operationOptions);
    },
  });
}

function completeAssetManagerComposition(binary) {
  return Object.freeze({
    async registerProjectAsset(input) {
      return {name: input.name, mimeType: 'image/svg+xml'};
    },
    async registerEmbeddedAsset(input) {
      return {name: input.name, mimeType: 'image/svg+xml'};
    },
    releaseAsset() {},
    releaseAll() {},
    isRegistered() {
      return false;
    },
    getMimeType() {
      return '';
    },
    async applyToStage() {},
    async applyToTarget() {},
    async playSound() {},
    stopSound() {},
    stopAllSounds() {},
    ...binary,
  });
}

function completeTMPoseComposition(calls) {
  let active = null;
  return Object.freeze({
    async registerPoseModel(input) {
      calls.push(['register', input.name, input.files.map((file) => file.path)]);
      return {name: input.name, labels: [input.name]};
    },
    activatePoseModel(name) {
      active = name;
    },
    async releasePoseModel(name) {
      calls.push(['release', name]);
      if (active === name) active = null;
    },
    async releaseAll() {
      calls.push(['release-all']);
      active = null;
    },
    isPoseModelRegistered() {
      return true;
    },
    getActivePoseModelName() {
      return active;
    },
    showPreview() {},
    hidePreview() {},
    isPreviewVisible() {
      return false;
    },
    setPreviewPosition() {},
    async startCamera() {},
    stopCamera() {},
    isCameraRunning() {
      return false;
    },
    async startRecognition() {},
    stopRecognition() {},
    isRecognizing() {
      return false;
    },
    currentPose() {
      return '';
    },
    confidence() {
      return 0;
    },
    confidenceOf() {
      return 0;
    },
    configureAccumulatedPose() {},
    resetAccumulatedPose() {},
    subscribeAccumulatedPose() {
      return () => {};
    },
  });
}

function context(generation = 1) {
  return {signal: new AbortController().signal, generation, sceneId: 'first'};
}

test('loads binary-entry metadata through the explicit default-compatible startup route', async () => {
  const component = await fixture();
  const project = await installDsl4BinaryEntryRuntimeComponent(
    baseProject(),
    component.storyDocument,
    component.sourceDescriptor,
    component.runtimeArtifact,
    component.binaryBundle.descriptor,
    {
      channel: 'bundled',
      maxSourceBytes: limits.maxSourceBytes,
      maxAssetFiles: limits.maxAssetFiles,
      maxAssetFileBytes: limits.maxAssetFileBytes,
      maxAssetBytes: limits.maxAssetBytes,
      subtleCrypto,
    },
  );
  let receivedComponent;
  const startup = await createDsl4RuntimeStartup({
    featureFlags: {dsl4Runtime: true},
    project,
    sourceFrontend: frontend,
    ...limits,
    assetBundleFormat: 'binary-entry',
    subtleCrypto,
    createRuntimeEnvironment(runtimeComponent) {
      receivedComponent = runtimeComponent;
      return {
        port: {},
        assetLifecycle: {
          async prepare() {},
          async setLoading() {},
          async releaseAssets() {},
          async release() {},
        },
        async dispose() {},
      };
    },
  });
  assert.equal(startup.ok, true, JSON.stringify(startup.diagnostics));
  assert.strictEqual(receivedComponent, startup.runtimeComponent);
  assert.equal(
    receivedComponent.assetBundle.integrity,
    component.binaryBundle.descriptor.integrity,
  );
  assert.equal(Object.hasOwn(receivedComponent, 'getAssetFile'), false);
  assert.equal(Object.isFrozen(receivedComponent), true);
  await startup.session.dispose('test-complete');
});

test('establishes one session, bounds alternating scene models, and re-exports identical entries', async () => {
  const component = await fixture();
  const provider = await providerFor(component);
  const binary = sessionComposition('dsl4-binary-product-wiring');
  const assetManager = completeAssetManagerComposition(binary);
  const poseCalls = [];
  const session = createDsl4PlatformAssetSession({
    runtimeComponent: component.runtimeComponent,
    binaryEntryProvider: provider,
    cacheIdentity,
    binarySessionBackingPolicy: 'required',
    binarySessionId: 'product-wiring-session',
    sessionBinaryBackingOptions: {
      indexedDB: new IDBFactory(),
      databaseName: 'ignored-by-injected-composition',
    },
    tmPoseRuntime: {Webcam: class {}, async loadFromFiles() {}},
    setLoading() {},
    createAssetManagerComposition() {
      return assetManager;
    },
    createTMPoseComposition() {
      return completeTMPoseComposition(poseCalls);
    },
  });

  await session.binaryAssetBacking.ready;
  assert.deepEqual(session.binaryAssetBacking.getState(), {
    state: 'ready',
    mode: 'session',
    sessionId: 'product-wiring-session',
    disposed: false,
    providerRetained: false,
    warning: null,
    failureCode: null,
  });
  assert.equal(provider.released, true);

  await session.lifecycle.prepare({assetIds: ['FirstPose']}, context(1));
  await session.lifecycle.releaseAssets({assetIds: ['FirstPose'], reason: 'scene-transition'});
  await session.lifecycle.prepare({assetIds: ['NextPose']}, context(2));
  await session.lifecycle.releaseAssets({assetIds: ['NextPose'], reason: 'history-transition'});
  await session.lifecycle.prepare({assetIds: ['FirstPose']}, context(3));
  assert.deepEqual(
    poseCalls.filter(([operation]) => operation === 'register').map(([, name]) => name),
    ['FirstPose', 'NextPose', 'FirstPose'],
  );
  assert.equal(
    poseCalls.every(([, , paths]) =>
      paths === undefined ? true : paths.join(',') === 'metadata.json,model.json,weights.bin',
    ),
    true,
  );
  assert.equal(Object.hasOwn(session.getAssetResource('FirstPose'), 'files'), false);

  const editorBundle = await session.binaryAssetBacking.createExportBundle();
  assert.equal(editorBundle.descriptor.integrity, component.binaryBundle.descriptor.integrity);
  const embedded = await embedDsl4BinaryEntryRuntimeComponentInSb3(
    baseSb3(),
    component.storyDocument,
    component.sourceDescriptor,
    component.runtimeArtifact,
    editorBundle,
    {
      channel: 'bundled',
      maxSourceBytes: limits.maxSourceBytes,
      maxAssetFiles: limits.maxAssetFiles,
      maxAssetFileBytes: limits.maxAssetFileBytes,
      maxAssetBytes: limits.maxAssetBytes,
      subtleCrypto,
    },
  );
  const reloaded = await loadDsl4BinaryEntryRuntimeComponent(embedded.project, frontend, {
    ...limits,
    subtleCrypto,
  });
  assert.equal(reloaded.ok, true, JSON.stringify(reloaded.diagnostics));
  assert.equal(reloaded.assetBundle.integrity, component.binaryBundle.descriptor.integrity);
  const reloadedProvider = await createDsl4BinaryEntryProviderFromSb3(
    embedded.bytes,
    reloaded.storyDocument,
    reloaded.assetBundle,
    {
      ...limits,
      maxArchiveBytes: 1024 * 1024,
      maxArchiveEntries: 32,
      maxArchiveEntryBytes: 128 * 1024,
      maxArchiveExpandedBytes: 512 * 1024,
      maxCompressionRatio: 100,
      subtleCrypto,
    },
  );
  for (const assetId of reloadedProvider.assetIds) {
    const asset = await reloadedProvider.consumeAsset(assetId);
    assert.equal(asset.files.length, 3);
  }
  assert.equal(reloadedProvider.released, true);
  await session.dispose('test-complete');
});

test('disabled policy never opens IndexedDB and re-reads a released scene from the direct source', async () => {
  const component = await fixture();
  const provider = await providerFor(component);
  const forbiddenIndexedDB = new Proxy(
    {},
    {
      get() {
        assert.fail('disabled session backing must not inspect IndexedDB');
      },
    },
  );
  const assetManager = completeAssetManagerComposition(
    sessionComposition('dsl4-binary-direct-source', forbiddenIndexedDB),
  );
  const poseCalls = [];
  const session = createDsl4PlatformAssetSession({
    runtimeComponent: component.runtimeComponent,
    binaryEntryProvider: provider,
    cacheIdentity,
    binarySessionBackingPolicy: 'disabled',
    binarySessionId: 'direct-source-session',
    tmPoseRuntime: {Webcam: class {}, async loadFromFiles() {}},
    setLoading() {},
    createAssetManagerComposition() {
      return assetManager;
    },
    createTMPoseComposition() {
      return completeTMPoseComposition(poseCalls);
    },
  });

  await session.binaryAssetBacking.ready;
  assert.deepEqual(session.binaryAssetBacking.getState(), {
    state: 'ready',
    mode: 'direct',
    sessionId: 'direct-source-session',
    disposed: false,
    providerRetained: true,
    warning: null,
    failureCode: null,
  });

  await session.lifecycle.prepare({assetIds: ['FirstPose']}, context(1));
  await session.lifecycle.releaseAssets({assetIds: ['FirstPose'], reason: 'scene-transition'});
  await session.lifecycle.prepare({assetIds: ['FirstPose']}, context(2));
  assert.deepEqual(
    poseCalls.filter(([operation]) => operation === 'register').map(([, name]) => name),
    ['FirstPose', 'FirstPose'],
  );
  assert.equal(provider.released, false);

  await session.dispose('test-complete');
  assert.equal(provider.released, true);
});

test('publishes one prefer fallback warning and fixes the returned backing to direct mode', async () => {
  const component = await fixture();
  const provider = await providerFor(component);
  const warnings = [];
  const warning = Object.freeze({
    code: 'ASSET_SESSION_BINARY_DIRECT_FALLBACK',
    causeCode: 'ASSET_SESSION_BINARY_UNAVAILABLE',
  });
  const composition = Object.freeze({
    async createSessionBinaryBacking(input) {
      assert.equal(input.policy, 'prefer');
      return Object.freeze({
        sessionId: input.sessionId,
        mode: 'direct',
        warning,
        get(asset, operationOptions) {
          return input.source.read(asset, operationOptions);
        },
        async dispose() {
          await input.source.release();
        },
      });
    },
  });
  const backing = createDsl4BinaryEntryBacking({
    runtimeComponent: component.runtimeComponent,
    provider,
    composition,
    namespace: cacheIdentity.id,
    policy: 'prefer',
    sessionId: 'prefer-fallback-session',
    onWarning(value) {
      warnings.push(value);
    },
  });

  await backing.ready;
  assert.deepEqual(warnings, [warning]);
  assert.equal(backing.getState().mode, 'direct');
  assert.deepEqual(backing.getState().warning, warning);
  assert.equal((await backing.getAssetFiles('FirstPose')).length, 3);
  assert.equal((await backing.getAssetFiles('FirstPose')).length, 3);
  assert.equal(provider.released, false);

  await backing.dispose();
  assert.equal(provider.released, true);
});

test('fails closed on a post-establishment session read without retaining the provider', async () => {
  const component = await fixture();
  const provider = await providerFor(component);
  const realComposition = sessionComposition('dsl4-binary-session-read-failure');
  let failRead = false;
  const fatalErrors = [];
  const composition = Object.freeze({
    async createSessionBinaryBacking(input, options) {
      const established = await realComposition.createSessionBinaryBacking(input, options);
      return Object.freeze({
        ...established,
        get(key, operationOptions) {
          if (!failRead) return established.get(key, operationOptions);
          const error = new Error('session record missing');
          Object.defineProperty(error, 'code', {value: 'ASSET_SESSION_BINARY_BUNDLE_NOT_FOUND'});
          throw error;
        },
      });
    },
  });
  const backing = createDsl4BinaryEntryBacking({
    runtimeComponent: component.runtimeComponent,
    provider,
    composition,
    namespace: cacheIdentity.id,
    policy: 'required',
    sessionId: 'post-establishment-failure',
    onFatalError(error) {
      fatalErrors.push(error);
    },
  });
  await backing.ready;
  failRead = true;
  await assert.rejects(backing.getAssetFiles('FirstPose'), (error) => {
    assert.equal(error.code, 'ASSET_SESSION_BINARY_BUNDLE_NOT_FOUND');
    return true;
  });
  assert.equal(backing.getState().providerRetained, false);
  assert.equal(backing.getState().mode, 'session');
  assert.equal(backing.getState().state, 'failed');
  assert.equal(fatalErrors.length, 1);
  await backing.dispose();
});

test('keeps the provider until aborted establishment releases the source and fails startup', async () => {
  const component = await fixture();
  const provider = await providerFor(component);
  let putStarted = false;
  const composition = Object.freeze({
    createSessionBinaryBacking(input, {signal}) {
      putStarted = true;
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          async () => {
            await input.source.release();
            const error = new Error('session establishment aborted');
            Object.defineProperty(error, 'code', {value: 'ASSET_SESSION_BINARY_ABORTED'});
            reject(error);
          },
          {once: true},
        );
      });
    },
  });
  const backing = createDsl4BinaryEntryBacking({
    runtimeComponent: component.runtimeComponent,
    provider,
    composition,
    namespace: cacheIdentity.id,
    policy: 'required',
    sessionId: 'aborted-establishment',
  });
  while (!putStarted) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backing.getState().providerRetained, true);
  await backing.dispose();
  await assert.rejects(backing.ready, (error) => {
    assert.equal(error.code, 'ASSET_SESSION_BINARY_ABORTED');
    return true;
  });
  assert.deepEqual(backing.getState(), {
    state: 'failed',
    mode: null,
    sessionId: 'aborted-establishment',
    disposed: true,
    providerRetained: false,
    warning: null,
    failureCode: 'ASSET_SESSION_BINARY_ABORTED',
  });
  assert.equal(provider.released, true);
});
