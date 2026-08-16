import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {
  createBundledTMPoseRuntime,
  createPoseNetProjectBundle,
  createPoseNetProjectBundleFromLoader,
  loadPoseNetProjectBundle,
  poseNetBundleManifest,
  poseNetModelDefaults,
  validatePoseNetProjectBundle,
  verifyPoseNetBundle,
} from '@kubohiroya/turbowarp-tmpose/posenet';

import {
  createDsl4BundledTMPoseRuntime,
  createDsl4PoseNetProjectBundle,
  createDsl4PoseNetProjectBundleFromLoader,
  createDsl4ProjectTMPoseRuntime,
  dsl4PoseNetBundleManifest,
  dsl4PoseNetModelDefaults,
  loadDsl4PoseNetProjectBundle,
  loadDsl4PoseNetProjectBundleData,
  validateDsl4PoseNetProjectBundle,
  verifyDsl4PoseNetBundle,
} from '../src/dsl4/platform/posenet-bundle.js';

let pendingPoseNetFiles;

function loadPublishedPoseNetFiles() {
  pendingPoseNetFiles ??= Promise.all(
    poseNetBundleManifest.files.map(async ({path, mediaType, packageSpecifier}) => ({
      path,
      mediaType,
      bytes: new Uint8Array(await readFile(fileURLToPath(import.meta.resolve(packageSpecifier)))),
    })),
  );
  return pendingPoseNetFiles;
}

test('delegates the PoseNet manifest, verification, storage, and runtime contract to TMPose 1.10', () => {
  assert.equal(createDsl4BundledTMPoseRuntime, createBundledTMPoseRuntime);
  assert.equal(createDsl4PoseNetProjectBundle, createPoseNetProjectBundle);
  assert.equal(createDsl4PoseNetProjectBundleFromLoader, createPoseNetProjectBundleFromLoader);
  assert.equal(dsl4PoseNetBundleManifest, poseNetBundleManifest);
  assert.equal(dsl4PoseNetModelDefaults, poseNetModelDefaults);
  assert.equal(loadDsl4PoseNetProjectBundleData, loadPoseNetProjectBundle);
  assert.equal(validateDsl4PoseNetProjectBundle, validatePoseNetProjectBundle);
  assert.equal(verifyDsl4PoseNetBundle, verifyPoseNetBundle);
  assert.equal(dsl4PoseNetBundleManifest.distribution.version, '1.10.3');
});

test('verifies the PoseNet supply published by TMPose', async () => {
  const result = await verifyDsl4PoseNetBundle(await loadPublishedPoseNetFiles(), {
    subtleCrypto: webcrypto.subtle,
  });
  assert.equal(result.manifest, dsl4PoseNetBundleManifest);
  assert.deepEqual(
    result.files.map((file) => file.path),
    ['model-stride16.json', 'group1-shard1of2.bin', 'group1-shard2of2.bin'],
  );
  assert.equal(
    result.files.reduce((total, file) => total + file.bytes.byteLength, 0),
    5_082_500,
  );
});

test('rejects missing and tampered PoseNet supply with upstream error codes', async () => {
  const valid = await verifyDsl4PoseNetBundle(await loadPublishedPoseNetFiles(), {
    subtleCrypto: webcrypto.subtle,
  });
  const tampered = valid.files.map((file) => ({
    ...file,
    bytes: new Uint8Array(file.bytes),
  }));
  tampered[1].bytes[0] ^= 0xff;
  await assert.rejects(
    verifyDsl4PoseNetBundle(tampered, {subtleCrypto: webcrypto.subtle}),
    (error) => error.code === 'TMPOSE-POSENET-ASSET-003',
  );
  await assert.rejects(
    verifyDsl4PoseNetBundle(valid.files.slice(0, 2), {subtleCrypto: webcrypto.subtle}),
    (error) => error.code === 'TMPOSE-POSENET-ASSET-004',
  );
});

test('uses the upstream runtime wrapper for verified offline PoseNet responses', async () => {
  const originalFetchCalls = [];
  const globalObject = {
    Response,
    location: {href: 'https://preview.invalid/'},
    crypto: webcrypto,
    fetch(...arguments_) {
      originalFetchCalls.push(arguments_);
      return Promise.reject(new Error('external fetch must not run'));
    },
  };
  const originalFetch = globalObject.fetch;
  const responseSizes = [];
  const wrapped = createDsl4BundledTMPoseRuntime({
    runtime: {
      Webcam: class {},
      async loadFromFiles() {
        const response = await globalObject.fetch(dsl4PoseNetBundleManifest.files[0].url);
        responseSizes.push((await response.arrayBuffer()).byteLength);
        await assert.rejects(
          globalObject.fetch('https://example.invalid/not-posenet.bin'),
          (error) => error.code === 'TMPOSE-POSENET-FETCH-001',
        );
        return {labels: ['ok']};
      },
    },
    globalObject,
    files: await loadPublishedPoseNetFiles(),
  });
  assert.deepEqual(await wrapped.loadFromFiles({}, {}, {}), {labels: ['ok']});
  assert.deepEqual(responseSizes, [49_720]);
  assert.equal(originalFetchCalls.length, 0);
  assert.equal(globalObject.fetch, originalFetch);
});

test('stores PoseNet as explicit project model data and restores it losslessly', async () => {
  const descriptor = await createDsl4PoseNetProjectBundle(await loadPublishedPoseNetFiles(), {
    subtleCrypto: webcrypto.subtle,
  });
  const project = {
    extensionStorage: {
      kubohiroyakamishibai4: {
        components: {kubohiroyakamishibairuntime4: {poseNet: descriptor}},
      },
    },
  };
  const storedDescriptor = loadDsl4PoseNetProjectBundle(project);
  assert.equal(storedDescriptor, descriptor);
  const verified = await loadDsl4PoseNetProjectBundleData(storedDescriptor, {
    subtleCrypto: webcrypto.subtle,
  });
  assert.equal(descriptor.encoding, 'base64');
  assert.deepEqual(
    descriptor.files.map(({path, mediaType, size}) => ({path, mediaType, size})),
    dsl4PoseNetBundleManifest.files.map(({path, mediaType, size}) => ({
      path,
      mediaType,
      size,
    })),
  );
  assert.equal(
    verified.files.reduce((total, file) => total + file.bytes.byteLength, 0),
    5_082_500,
  );
});

test('decodes project model data lazily and rejects ambiguous storage', async () => {
  const descriptor = await createDsl4PoseNetProjectBundle(await loadPublishedPoseNetFiles(), {
    subtleCrypto: webcrypto.subtle,
  });
  let runtimeCalls = 0;
  const wrapped = createDsl4BundledTMPoseRuntime({
    runtime: {
      Webcam: class {},
      async loadFromFiles() {
        runtimeCalls += 1;
        return {ok: true};
      },
    },
    globalObject: {Response, crypto: webcrypto, fetch() {}},
    projectBundle: descriptor,
  });
  assert.equal(runtimeCalls, 0);
  assert.deepEqual(await wrapped.loadFromFiles({}, {}, {}), {ok: true});
  assert.equal(runtimeCalls, 1);

  const missing = createDsl4ProjectTMPoseRuntime({
    runtime: {Webcam: class {}, async loadFromFiles() {}},
    globalObject: {Response, crypto: webcrypto, fetch() {}},
    project: {},
  });
  await assert.rejects(
    missing.loadFromFiles({}, {}, {}),
    (error) => error.code === 'K4-POSENET-ASSET-002',
  );

  const invalidDescriptor = {
    ...descriptor,
    files: descriptor.files.map((file, index) =>
      index === 0 ? {...file, sha256: '0'.repeat(64)} : file,
    ),
  };
  const invalid = createDsl4BundledTMPoseRuntime({
    runtime: {Webcam: class {}, async loadFromFiles() {}},
    globalObject: {Response, crypto: webcrypto, fetch() {}},
    projectBundle: invalidDescriptor,
  });
  await assert.rejects(
    invalid.loadFromFiles({}, {}, {}),
    (error) => error.code === 'TMPOSE-POSENET-ASSET-001',
  );

  assert.throws(
    () =>
      loadDsl4PoseNetProjectBundle({
        extensionStorage: {
          kubohiroyakamishibairuntime4: {poseNet: descriptor},
          kubohiroyakamishibai4: {
            components: {kubohiroyakamishibairuntime4: {poseNet: descriptor}},
          },
        },
      }),
    (error) => error.code === 'K4-POSENET-ASSET-001',
  );
});
