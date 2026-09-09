import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
  createDsl4PlatformAssetAdapter,
  createDsl4TMModelAdapter,
  createDsl4TMPlatform,
} from '../src/dsl4/platform/index.js';
import {deferred} from './helpers/async-test-helpers.ts';
import {thrown} from './helpers/thrown-error.ts';
import {requireDefined, requireRecord} from './helpers/require-value.ts';

/** Read the routed payload one adapter is handed. */
function requireRoutedPayload(payload: unknown) {
  const record = requireRecord(payload, 'the routed payload');
  return {asset: requireRecord(record.asset, 'the routed asset') as {kind: string}};
}

/** One file of a pose model bundle. */
interface PoseModelFile {
  path: string;
  bytes: Uint8Array;
}

/** What the composition is asked to register. */
interface PoseModelRegistration {
  name: string;
  files: PoseModelFile[];
}

function poseModel(
  id = 'RescuePose',
  files = [
    {path: 'metadata.json', bytes: new TextEncoder().encode('{"labels":["rescue"]}')},
    {path: 'model.json', bytes: new TextEncoder().encode('{"model":true}')},
    {path: 'weights.bin', bytes: new Uint8Array([1, 2, 3])},
  ],
) {
  return {
    asset: {
      id,
      kind: 'recognitionModel',
      loading: 'lazy',
      source: {type: 'file'} as {type: string; url?: string},
    },
    files,
  };
}

function fakeComposition(overrides: Record<string, unknown> = {}) {
  const calls: {register: PoseModelRegistration[]; release: string[]} = {register: [], release: []};
  return {
    calls,
    composition: Object.freeze({
      async registerPoseModel(input: PoseModelRegistration) {
        calls.register.push(input);
        return Object.freeze({name: input.name, labels: Object.freeze(['idle', 'rescue'])});
      },
      async releasePoseModel(name: string) {
        calls.release.push(name);
      },
      ...overrides,
    }),
  };
}

test('registers one embedded Teachable Machine pose model and returns immutable metadata', async () => {
  const fake = fakeComposition();
  const adapter = createDsl4TMModelAdapter({composition: fake.composition});
  const payload = poseModel();
  const resource = await adapter.prepare(payload);

  assert.equal(fake.calls.register.length, 1);
  assert.equal(requireDefined(fake.calls.register[0], 'the first registration').name, 'RescuePose');
  assert.deepEqual(
    requireDefined(fake.calls.register[0], 'the first registration').files.map(
      ({path: filePath}) => filePath,
    ),
    ['metadata.json', 'model.json', 'weights.bin'],
  );
  assert.strictEqual(
    requireDefined(
      requireDefined(fake.calls.register[0], 'the first registration').files[0],
      'its first file',
    ).bytes,
    requireDefined(payload.files[0], 'the payload first file').bytes,
  );
  assert.deepEqual(resource, {
    adapter: 'tm',
    assetId: 'RescuePose',
    kind: 'recognitionModel',
    name: 'RescuePose',
    labels: ['idle', 'rescue'],
  });
  assert.equal(Object.isFrozen(resource), true);
  assert.equal(Object.isFrozen(resource.labels), true);
  assert.deepEqual(adapter.getPoseModelLabels('RescuePose'), ['idle', 'rescue']);

  await adapter.release(resource);
  await adapter.release(resource);
  assert.deepEqual(fake.calls.release, ['RescuePose']);
  assert.equal(adapter.getPoseModelLabels('RescuePose'), null);
});

test('registers an extracted verified remote pose model through the same owner', async () => {
  const fake = fakeComposition();
  const adapter = createDsl4TMModelAdapter({composition: fake.composition});
  const payload = poseModel();
  payload.asset.source = {type: 'remote', url: 'https://cdn.example.com/pose.zip'};
  const resource = await adapter.prepare(payload);
  assert.equal(resource.adapter, 'tm');
  assert.deepEqual(
    requireDefined(fake.calls.register[0], 'the first registration').files.map(
      ({path: filePath}) => filePath,
    ),
    ['metadata.json', 'model.json', 'weights.bin'],
  );
  await adapter.release(resource);
});

test('rejects malformed pose model bundles before TM registration', async () => {
  const fake = fakeComposition();
  const adapter = createDsl4TMModelAdapter({composition: fake.composition});
  const validFiles = poseModel().files;
  const metadataFile = requireDefined(validFiles[0], 'the metadata file');
  const modelFile = requireDefined(validFiles[1], 'the model file');
  const weightsFile = requireDefined(validFiles[2], 'the weights file');
  const invalid: readonly unknown[] = [
    {},
    {asset: {id: '', kind: 'recognitionModel', source: {type: 'file'}}, files: validFiles},
    {asset: {id: 'Image', kind: 'backdrop', source: {type: 'file'}}, files: validFiles},
    {asset: {id: 'ProjectPose', kind: 'recognitionModel', source: {type: 'project'}}, files: []},
    poseModel('MissingFile', validFiles.slice(0, 2)),
    poseModel('ExtraFile', [...validFiles, {path: 'extra.bin', bytes: new Uint8Array([4])}]),
    poseModel('DuplicateFile', [metadataFile, metadataFile, weightsFile]),
    poseModel('NestedFile', [
      {...metadataFile, path: 'model/metadata.json'},
      modelFile,
      weightsFile,
    ]),
    poseModel('MissingWeights', [
      metadataFile,
      modelFile,
      {path: 'weights.dat', bytes: new Uint8Array([1])},
    ]),
    poseModel('EmptyBytes', [metadataFile, modelFile, {...weightsFile, bytes: new Uint8Array()}]),
  ];
  for (const payload of invalid) {
    await assert.rejects(
      adapter.prepare(payload),
      (error) => typeof thrown(error).code === 'string',
    );
  }
  // The adapter must refuse an object that is not an `AbortSignal`, which is what this passes.
  const invalidSignal = {} as unknown as AbortSignal;
  await assert.rejects(adapter.prepare(poseModel(), {signal: invalidSignal}), /signal is invalid/u);
  assert.deepEqual(fake.calls, {register: [], release: []});
});

test('releases invalid or aborted registrations without publishing a resource', async () => {
  const registration = deferred<{name: string; labels: string[]}>();
  const fake = fakeComposition({
    registerPoseModel(input: PoseModelRegistration) {
      fake.calls.register.push(input);
      return registration.promise;
    },
  });
  const adapter = createDsl4TMModelAdapter({composition: fake.composition});
  const controller = new AbortController();
  const pending = adapter.prepare(poseModel(), {signal: controller.signal});
  controller.abort('scene-superseded');
  registration.resolve({name: 'RescuePose', labels: ['rescue']});

  await assert.rejects(pending, (error) => thrown(error).name === 'AbortError');
  assert.deepEqual(fake.calls.release, ['RescuePose']);

  const malformed = fakeComposition({
    async registerPoseModel(input: PoseModelRegistration) {
      fake.calls.register.push(input);
      // A numeric label is what this case proves the adapter refuses.
      return {name: input.name, labels: [42] as unknown as string[]};
    },
  });
  const malformedAdapter = createDsl4TMModelAdapter({composition: malformed.composition});
  await assert.rejects(malformedAdapter.prepare(poseModel()), /invalid registration/u);
  assert.deepEqual(malformed.calls.release, ['RescuePose']);
});

test('forwards the preparation AbortSignal to TM registration', async () => {
  let registrationOptions: {signal?: AbortSignal} | undefined;
  const fake = fakeComposition({
    async registerPoseModel(input: PoseModelRegistration, options: {signal?: AbortSignal}) {
      fake.calls.register.push(input);
      registrationOptions = options;
      return {name: input.name, labels: ['rescue']};
    },
  });
  const adapter = createDsl4TMModelAdapter({composition: fake.composition});
  const controller = new AbortController();

  await adapter.prepare(poseModel(), {signal: controller.signal});

  assert.strictEqual(
    requireDefined(registrationOptions, 'the registration options').signal,
    controller.signal,
  );
});

test('creates an app-shell-scoped TM composition and adapter pair', async () => {
  const fake = fakeComposition();
  const runtime = {Webcam: class {}, loadFromFiles() {}};
  const createFile = () => ({name: 'file'});
  const calls: unknown[] = [];
  const platform = createDsl4TMPlatform({
    runtime,
    createFile,
    modelInitializationPolicy: 'latest-needed',
    parallelModelInitialization: true,
    createComposition(options: unknown) {
      calls.push(options);
      return fake.composition;
    },
  });

  assert.deepEqual(calls, [
    {
      runtime,
      createFile,
      modelInitializationPolicy: 'latest-needed',
      parallelModelInitialization: true,
    },
  ]);
  assert.strictEqual(platform.composition, fake.composition);
  assert.equal(Object.isFrozen(platform), true);
  const resource = await platform.adapter.prepare(poseModel());
  await platform.adapter.release(resource);
  assert.deepEqual(fake.calls.release, ['RescuePose']);
});

test('rejects invalid TM model initialization options', () => {
  const runtime = {Webcam: class {}, loadFromFiles() {}};
  const createComposition = () => fakeComposition().composition;
  // Both options are out of contract on purpose: the platform must refuse an unknown policy and a
  // non-boolean flag, neither of which its own option types can express.
  type PlatformOptions = Parameters<typeof createDsl4TMPlatform>[0];
  const unknownPolicy = {
    runtime,
    createComposition,
    modelInitializationPolicy: 'newest',
  } as unknown as PlatformOptions;
  const nonBooleanParallel = {
    runtime,
    createComposition,
    parallelModelInitialization: 'yes',
  } as unknown as PlatformOptions;
  assert.throws(() => createDsl4TMPlatform(unknownPolicy), /modelInitializationPolicy/u);
  assert.throws(() => createDsl4TMPlatform(nonBooleanParallel), /parallelModelInitialization/u);
});

test('routes media and pose assets to their owners and preserves release ownership', async () => {
  const calls: [string, unknown][] = [];
  const mediaAdapter = {
    async prepare(payload: unknown) {
      const {asset} = requireRoutedPayload(payload);
      calls.push(['prepare-media', asset.kind]);
      return {owner: 'media', kind: asset.kind};
    },
    async release(resource: unknown) {
      calls.push(['release-media', requireRecord(resource, 'the released resource').kind]);
    },
  };
  const poseAdapter = {
    async prepare(payload: unknown) {
      const {asset} = requireRoutedPayload(payload);
      calls.push(['prepare-pose', asset.kind]);
      return {owner: 'pose', kind: asset.kind};
    },
    async release(resource: unknown) {
      calls.push(['release-pose', requireRecord(resource, 'the released resource').kind]);
    },
  };
  const router = createDsl4PlatformAssetAdapter({mediaAdapter, poseAdapter});
  const resources: Record<string, unknown>[] = [];
  for (const kind of ['backdrop', 'costume', 'sound', 'recognitionModel']) {
    resources.push(await router.prepare({asset: {kind}}, null));
  }
  assert.deepEqual(calls.slice(0, 4), [
    ['prepare-media', 'backdrop'],
    ['prepare-media', 'costume'],
    ['prepare-media', 'sound'],
    ['prepare-pose', 'recognitionModel'],
  ]);

  for (const resource of resources) await router.release(resource, null);
  await router.release(requireDefined(resources[3], 'the pose resource'), null);
  assert.deepEqual(calls.slice(4), [
    ['release-media', 'backdrop'],
    ['release-media', 'costume'],
    ['release-media', 'sound'],
    ['release-pose', 'recognitionModel'],
  ]);
  await assert.rejects(router.prepare({asset: {kind: 'video'}}, null), /Unsupported/u);
  const otherRouter = createDsl4PlatformAssetAdapter({mediaAdapter, poseAdapter});
  await assert.rejects(
    otherRouter.release(requireDefined(resources[0], 'the first resource'), null),
    /not owned/u,
  );
});
