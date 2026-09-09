import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'vitest';
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
import {thrown} from './helpers/thrown-error.ts';
import {requireDefined, requireRecord} from './helpers/require-value.ts';
import {okResult, requireSession} from './helpers/result-outcome.ts';

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
    kind: recognitionModel
    file: models/first
    loading: lazy
  NextPose:
    kind: recognitionModel
    file: models/next
    loading: lazy
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  first:
    recognitionModel: FirstPose
    actions:
      - goto: next
  next:
    recognitionModel: NextPose
    actions: []
`;
const cacheIdentity = Object.freeze({
  id: 'binarybacking0001',
  label: 'story.kamishibai.yaml',
  databaseName: 'tw-kamishibai-assets-v1--story--binarybacking0001',
});

/**
 * Hand the Asset Manager the Node WebCrypto implementation through the DOM type it declares.
 *
 * `@types/node` gives `webcrypto.subtle` a wider `KeyUsage` union than lib.dom's, so the two
 * `SubtleCrypto` declarations are not assignable to one another even though this is the
 * implementation the package runs against under Node.
 */
const domSubtleCrypto = subtleCrypto as unknown as SubtleCrypto;

/**
 * The session binary backing members these cases drive.
 *
 * The platform session declares the backing through the Asset Manager package's own types; the
 * cases here read the state and the export bundle it publishes.
 */
interface SessionBacking {
  ready: Promise<unknown>;
  getState(): unknown;
  createExportBundle(): Promise<{
    descriptor: {integrity: string};
    entryNames: readonly string[];
    getEntry(entryName: string): Uint8Array;
  }>;
  getAssetFiles(assetId: string): Promise<unknown[]>;
}

/** The session binary backing a platform session opened; every case here requires one. */
function binaryBackingOf(session: {binaryAssetBacking: unknown}): SessionBacking {
  return requireDefined(
    session.binaryAssetBacking,
    'the session binary backing',
  ) as unknown as SessionBacking;
}

type SessionOptions = Parameters<typeof createDsl4PlatformAssetSession>[0];

/**
 * The establishment input the backing hands a session composition.
 *
 * The Asset Manager declares it opaquely at this boundary, so the members these doubles read --
 * the policy, the session id, and the one-shot source -- are named here.
 */
interface BackingEstablishmentInput {
  policy: string;
  sessionId: string;
  source: {
    read(asset: unknown, options?: unknown): Promise<unknown>;
    release(): Promise<unknown>;
  };
}

/**
 * Hand the platform session a composition double through the package type it declares.
 *
 * The Asset Manager and TM compositions are large published interfaces; each case here builds only
 * the members the session actually calls, which is what the doubles are for.
 */
function compositionFactory<Name extends 'createAssetManagerComposition' | 'createTMComposition'>(
  composition: unknown,
): NonNullable<SessionOptions[Name]> {
  return (() => composition) as NonNullable<SessionOptions[Name]>;
}

/** One recorded TM composition call: the operation, then the arguments it was given. */
type PoseCall = [string, string?, string[]?];

function sri(bytes: Uint8Array) {
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
  const files = new Map<string, Uint8Array>();
  const fixtureModels: [string, string, number][] = [
    ['FirstPose', 'first', 1],
    ['NextPose', 'next', 2],
  ];
  for (const [assetId, label, weight] of fixtureModels) {
    files.set(`${assetId}\0metadata.json`, new TextEncoder().encode(`{"labels":["${label}"]}`));
    files.set(`${assetId}\0model.json`, new TextEncoder().encode(`{"model":"${label}"}`));
    files.set(`${assetId}\0weights.bin`, new Uint8Array([weight, weight + 1, weight + 2]));
  }
  return {
    manifest: {
      formatVersion: 1,
      assets: ['FirstPose', 'NextPose'].map((assetId) => ({
        id: assetId,
        kind: 'recognitionModel',
        loading: 'lazy',
        source: {
          type: 'file',
          inputPath: assetId === 'FirstPose' ? 'models/first' : 'models/next',
          mode: 'directory',
          files: ['metadata.json', 'model.json', 'weights.bin'].map((filePath) => {
            const bytes = requireDefined(
              files.get(`${assetId}\0${filePath}`),
              `the ${assetId} ${filePath} blob`,
            );
            return {path: filePath, size: bytes.length, integrity: sri(bytes)};
          }),
        },
      })),
    },
    getFile(assetId: string, filePath: string) {
      return new Uint8Array(
        requireDefined(files.get(`${assetId}\0${filePath}`), `the ${assetId} ${filePath} blob`),
      );
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
    runtimeArtifact: okResult(runtimeArtifact, 'the runtime artifact descriptor').artifact,
    binaryBundle,
    runtimeComponent: Object.freeze({
      storyDocument: parsed.storyDocument,
      sourceDescriptor,
      assetBundle: binaryBundle.descriptor,
    }),
  };
}

async function providerFor(component: Awaited<ReturnType<typeof fixture>>) {
  return createDsl4OneShotBinaryEntryProvider(
    component.storyDocument,
    component.binaryBundle.descriptor,
    {
      maxFiles: limits.maxAssetFiles,
      maxFileBytes: limits.maxAssetFileBytes,
      maxTotalBytes: limits.maxAssetBytes,
      maxCompressionRatio: 1,
      releaseAfterLastAsset: false,
      readEntry(entryName: string) {
        const bytes = component.binaryBundle.getEntry(entryName);
        return {bytes, compressedSize: bytes.length};
      },
      subtleCrypto,
    },
  );
}

function sessionComposition(databaseName: string, indexedDB: IDBFactory = new IDBFactory()) {
  const backingOptions = {
    indexedDB,
    subtleCrypto: domSubtleCrypto,
    databaseName,
    heartbeatIntervalMs: 60_000,
  };
  return Object.freeze({
    createSessionBinaryBacking(
      input: Parameters<typeof createSessionBinaryBacking>[0],
      operationOptions: Parameters<typeof createSessionBinaryBacking>[2],
    ) {
      return createSessionBinaryBacking(input, backingOptions, operationOptions);
    },
  });
}

function completeAssetManagerComposition(binary: Record<string, unknown>) {
  return Object.freeze({
    async registerProjectAsset(input: {name: string}) {
      return {name: input.name, mimeType: 'image/svg+xml'};
    },
    async registerEmbeddedAsset(input: {name: string}) {
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

function completeTMComposition(calls: PoseCall[]) {
  let active: string | null = null;
  return Object.freeze({
    async registerPoseModel(input: {name: string; files: {path: string}[]}) {
      calls.push(['register', input.name, input.files.map((file) => file.path)]);
      return {name: input.name, labels: [input.name]};
    },
    activatePoseModel(name: string) {
      active = name;
    },
    async releasePoseModel(name: string) {
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
  let receivedComponent: unknown;
  const startup = await createDsl4RuntimeStartup({
    featureFlags: {dsl4Runtime: true},
    project,
    sourceFrontend: frontend,
    ...limits,
    assetBundleFormat: 'binary-entry',
    subtleCrypto,
    createRuntimeEnvironment(runtimeComponent: unknown) {
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
  const started = okResult(startup, 'the runtime startup');
  assert.strictEqual(receivedComponent, started.runtimeComponent);
  const loadedComponent = requireRecord(receivedComponent, 'the runtime component handed over');
  assert.equal(
    requireRecord(loadedComponent.assetBundle, 'its asset bundle').integrity,
    component.binaryBundle.descriptor.integrity,
  );
  assert.equal(Object.hasOwn(loadedComponent, 'getAssetFile'), false);
  assert.equal(Object.isFrozen(loadedComponent), true);
  await requireSession(startup, 'the runtime startup').dispose('test-complete');
});

test('establishes one session, bounds alternating scene models, and re-exports identical entries', async () => {
  const component = await fixture();
  const provider = await providerFor(component);
  const binary = sessionComposition('dsl4-binary-product-wiring');
  const assetManager = completeAssetManagerComposition(binary);
  const poseCalls: PoseCall[] = [];
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
    createAssetManagerComposition:
      compositionFactory<'createAssetManagerComposition'>(assetManager),
    createTMComposition: compositionFactory<'createTMComposition'>(
      completeTMComposition(poseCalls),
    ),
  });

  await binaryBackingOf(session).ready;
  assert.deepEqual(binaryBackingOf(session).getState(), {
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
  assert.equal(
    Object.hasOwn(
      requireRecord(session.getAssetResource('FirstPose'), 'the pose asset resource'),
      'files',
    ),
    false,
  );

  const editorBundle = await binaryBackingOf(session).createExportBundle();
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
  const reloaded = okResult(
    await loadDsl4BinaryEntryRuntimeComponent(embedded.project, frontend, {
      ...limits,
      subtleCrypto,
    }),
    'the reloaded runtime component',
  );
  assert.equal(
    requireRecord(reloaded.assetBundle, 'its asset bundle').integrity,
    component.binaryBundle.descriptor.integrity,
  );
  const reloadedProvider = await createDsl4BinaryEntryProviderFromSb3(
    embedded.bytes,
    requireRecord(reloaded.storyDocument, 'its story document'),
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
  const forbiddenIndexedDB = new Proxy<IDBFactory>({} as IDBFactory, {
    get() {
      assert.fail('disabled session backing must not inspect IndexedDB');
    },
  });
  const assetManager = completeAssetManagerComposition(
    sessionComposition('dsl4-binary-direct-source', forbiddenIndexedDB),
  );
  const poseCalls: PoseCall[] = [];
  const session = createDsl4PlatformAssetSession({
    runtimeComponent: component.runtimeComponent,
    binaryEntryProvider: provider,
    cacheIdentity,
    binarySessionBackingPolicy: 'disabled',
    binarySessionId: 'direct-source-session',
    tmPoseRuntime: {Webcam: class {}, async loadFromFiles() {}},
    setLoading() {},
    createAssetManagerComposition:
      compositionFactory<'createAssetManagerComposition'>(assetManager),
    createTMComposition: compositionFactory<'createTMComposition'>(
      completeTMComposition(poseCalls),
    ),
  });

  await binaryBackingOf(session).ready;
  assert.deepEqual(binaryBackingOf(session).getState(), {
    state: 'ready',
    mode: 'direct',
    sessionId: 'direct-source-session',
    disposed: false,
    providerRetained: true,
    warning: null,
    failureCode: null,
  });

  const concurrent = await Promise.all([
    binaryBackingOf(session).getAssetFiles('FirstPose'),
    binaryBackingOf(session).getAssetFiles('NextPose'),
  ]);
  assert.deepEqual(
    concurrent.map((files) => files.length),
    [3, 3],
    'direct mode must serialize concurrent runtime reads through the bounded provider',
  );

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
  const warnings: unknown[] = [];
  const warning = Object.freeze({
    code: 'ASSET_SESSION_BINARY_DIRECT_FALLBACK',
    causeCode: 'ASSET_SESSION_BINARY_UNAVAILABLE',
  });
  const composition = Object.freeze({
    async createSessionBinaryBacking(input: BackingEstablishmentInput) {
      assert.equal(input.policy, 'prefer');
      return Object.freeze({
        sessionId: input.sessionId,
        mode: 'direct',
        warning,
        get(asset: unknown, operationOptions: unknown) {
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
    onWarning(value: unknown) {
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
  const fatalErrors: unknown[] = [];
  const composition = Object.freeze({
    async createSessionBinaryBacking(
      input: Parameters<typeof createSessionBinaryBacking>[0],
      options: Parameters<typeof createSessionBinaryBacking>[2],
    ) {
      const established = await realComposition.createSessionBinaryBacking(input, options);
      return Object.freeze({
        ...established,
        get(
          key: Parameters<typeof established.get>[0],
          operationOptions: Parameters<typeof established.get>[1],
        ) {
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
    assert.equal(thrown(error).code, 'ASSET_SESSION_BINARY_BUNDLE_NOT_FOUND');
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
    createSessionBinaryBacking(input: BackingEstablishmentInput, {signal}: {signal: AbortSignal}) {
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
    assert.equal(thrown(error).code, 'ASSET_SESSION_BINARY_ABORTED');
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
