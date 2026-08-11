import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import test from 'node:test';

import {
  createDsl4BundledTMPoseRuntime,
  dsl4PoseNetBundleManifest,
  verifyDsl4PoseNetBundle,
} from '../src/dsl4/platform/posenet-bundle.js';

test('verifies the pinned PoseNet MobileNetV1 supply', async () => {
  const result = await verifyDsl4PoseNetBundle({subtleCrypto: webcrypto.subtle});
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

test('rejects missing, tampered, and over-limit PoseNet supply with stable codes', async () => {
  const valid = await verifyDsl4PoseNetBundle({subtleCrypto: webcrypto.subtle});
  const tampered = valid.files.map((file) => ({
    ...file,
    bytes: new Uint8Array(file.bytes),
  }));
  tampered[1].bytes[0] ^= 0xff;
  await assert.rejects(
    verifyDsl4PoseNetBundle({files: tampered, subtleCrypto: webcrypto.subtle}),
    (error) => error.code === 'K4-POSENET-ASSET-003',
  );
  await assert.rejects(
    verifyDsl4PoseNetBundle({files: valid.files.slice(0, 2), subtleCrypto: webcrypto.subtle}),
    (error) => error.code === 'K4-POSENET-ASSET-004',
  );
  const oversized = valid.files.map((file) => ({...file, bytes: new Uint8Array(file.bytes)}));
  oversized[0].bytes = new Uint8Array(65 * 1024);
  await assert.rejects(
    verifyDsl4PoseNetBundle({files: oversized, subtleCrypto: webcrypto.subtle}),
    (error) => error.code === 'K4-POSENET-ASSET-004',
  );
});

test('rejects altered provenance and file metadata', async () => {
  const manifest = {
    ...dsl4PoseNetBundleManifest,
    source: {...dsl4PoseNetBundleManifest.source, modelUrl: 'https://example.invalid/'},
  };
  await assert.rejects(
    verifyDsl4PoseNetBundle({manifest, subtleCrypto: webcrypto.subtle}),
    (error) => error.code === 'K4-POSENET-ASSET-001',
  );

  const fileManifest = {
    ...dsl4PoseNetBundleManifest,
    files: dsl4PoseNetBundleManifest.files.map((file) =>
      file.path === 'model-stride16.json' ? {...file, sha256: '0'.repeat(64)} : file,
    ),
  };
  await assert.rejects(
    verifyDsl4PoseNetBundle({manifest: fileManifest, subtleCrypto: webcrypto.subtle}),
    (error) => error.code === 'K4-POSENET-ASSET-001',
  );
});

test('injects verified PoseNet responses and rejects other network requests', async () => {
  const originalFetchCalls = [];
  const globalObject = {
    Response,
    location: {href: 'https://preview.invalid/'},
    crypto: webcrypto,
    fetch(...args) {
      originalFetchCalls.push(args);
      return Promise.reject(new Error('external fetch must not run'));
    },
  };
  const originalFetch = globalObject.fetch;
  const calls = [];
  const runtime = {
    Webcam: class {},
    async loadFromFiles() {
      const response = await globalObject.fetch(dsl4PoseNetBundleManifest.files[0].url);
      calls.push((await response.arrayBuffer()).byteLength);
      await assert.rejects(
        globalObject.fetch('https://example.invalid/not-posenet.bin'),
        (error) => error.code === 'K4-POSENET-FETCH-001',
      );
      return {labels: ['ok']};
    },
  };
  const wrapped = createDsl4BundledTMPoseRuntime({runtime, globalObject});
  assert.deepEqual(await wrapped.loadFromFiles({}, {}, {}), {labels: ['ok']});
  assert.deepEqual(calls, [49_720]);
  assert.equal(originalFetchCalls.length, 0);
  assert.equal(globalObject.fetch, originalFetch);
});

test('does not invoke the runtime when the embedded supply is tampered', async () => {
  const valid = await verifyDsl4PoseNetBundle({subtleCrypto: webcrypto.subtle});
  const tampered = valid.files.map((file) => ({
    ...file,
    bytes: new Uint8Array(file.bytes),
  }));
  tampered[2].bytes[0] ^= 0xff;
  let runtimeCalls = 0;
  const wrapped = createDsl4BundledTMPoseRuntime({
    runtime: {
      Webcam: class {},
      async loadFromFiles() {
        runtimeCalls += 1;
      },
    },
    globalObject: {
      Response,
      location: {href: 'https://preview.invalid/'},
      crypto: webcrypto,
      fetch() {},
    },
    files: tampered,
    subtleCrypto: webcrypto.subtle,
  });
  await assert.rejects(
    wrapped.loadFromFiles({}, {}, {}),
    (error) => error.code === 'K4-POSENET-ASSET-003',
  );
  assert.equal(runtimeCalls, 0);
});
