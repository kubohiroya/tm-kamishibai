import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {createDsl4SourceFrontend, validateDsl4AssetCandidate} from '../src/dsl4/index.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const limits = {
  maxImagePixels: 16_777_216,
  maxAudioDurationSeconds: 1_800,
  maxAudioChannels: 8,
  maxAudioSampleRate: 192_000,
};

function story() {
  const parsed = frontend.parse(
    `
kamishibai: '4.0'
assets:
  Picture:
    kind: image
    file: picture.svg
  Bell:
    kind: sound
    file: bell.wav
  Rescue:
    kind: recognitionModel
    file: rescue
  Skin: costume:Hero
actors:
  Hero: Skin
scenes:
  opening:
    recognitionModel: Rescue
    actions:
      - Hero.pose:
          steps:
            - pose: help
`,
    {sourceId: 'asset-candidate-validator-test'},
  );
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  return parsed.storyDocument;
}

const storyDocument = story();
const encoder = new TextEncoder();

function asset(id) {
  return {id, ...storyDocument.assets[id]};
}

function wav() {
  const bytes = new Uint8Array(16);
  bytes.set(encoder.encode('RIFF'), 0);
  bytes.set(encoder.encode('WAVE'), 8);
  return bytes;
}

function poseFiles(labels = ['help', 'jump']) {
  return [
    {
      path: 'metadata.json',
      bytes: encoder.encode(JSON.stringify({labels})),
    },
    {
      path: 'model.json',
      bytes: encoder.encode(JSON.stringify({weightsManifest: [{paths: ['weights.bin']}]})),
    },
    {path: 'weights.bin', bytes: new Uint8Array([1, 2, 3])},
  ];
}

test('validates an image signature, browser decode, pixel limit, and release ownership', async () => {
  const releases = [];
  const controller = new AbortController();
  const result = await validateDsl4AssetCandidate({
    storyDocument,
    asset: asset('Picture'),
    files: [
      {path: 'picture.svg', bytes: encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"/>')},
    ],
    signal: controller.signal,
    inspectImage(bytes, context) {
      assert.equal(bytes instanceof Uint8Array, true);
      assert.equal(context.assetId, 'Picture');
      assert.equal(context.mediaType, 'image/svg+xml');
      assert.equal(context.signal, controller.signal);
      return {width: 640, height: 480, release: () => releases.push('image')};
    },
    ...limits,
  });

  assert.deepEqual(result.summary, {
    assetId: 'Picture',
    kind: 'image',
    fileCount: 1,
    mediaType: 'image/svg+xml',
    width: 640,
    height: 480,
  });
  await result.release();
  await result.release();
  assert.deepEqual(releases, ['image']);
});

test('rejects image extension, signature, decoder, and pixel limit failures', async () => {
  const base = {
    storyDocument,
    asset: asset('Picture'),
    signal: new AbortController().signal,
    inspectImage: () => ({width: 1, height: 1}),
    ...limits,
  };
  await assert.rejects(
    validateDsl4AssetCandidate({
      ...base,
      files: [{path: 'picture.svg', bytes: new Uint8Array([0, 1, 2])}],
    }),
    (error) => error.code === 'K4-ASSET-SIGNATURE-001',
  );
  await assert.rejects(
    validateDsl4AssetCandidate({
      ...base,
      files: [{path: 'picture.png', bytes: encoder.encode('<svg/>')}],
    }),
    (error) => error.code === 'K4-ASSET-SIGNATURE-001',
  );
  await assert.rejects(
    validateDsl4AssetCandidate({
      ...base,
      files: [{path: 'picture.svg', bytes: encoder.encode('<svg/>')}],
      inspectImage: () => ({width: 10_000, height: 10_000}),
    }),
    (error) => error.code === 'K4-ASSET-LIMIT-001',
  );
});

test('validates sound signature and finite decoded audio limits', async () => {
  const result = await validateDsl4AssetCandidate({
    storyDocument,
    asset: asset('Bell'),
    files: [{path: 'bell.wav', bytes: wav()}],
    signal: new AbortController().signal,
    inspectAudio(bytes, context) {
      assert.equal(bytes.length, 16);
      assert.equal(context.mediaType, 'audio/wav');
      return {durationSeconds: 2.5, channels: 2, sampleRate: 48_000};
    },
    ...limits,
  });
  assert.deepEqual(result.summary, {
    assetId: 'Bell',
    kind: 'sound',
    fileCount: 1,
    mediaType: 'audio/wav',
    durationSeconds: 2.5,
    channels: 2,
    sampleRate: 48_000,
  });

  await assert.rejects(
    validateDsl4AssetCandidate({
      storyDocument,
      asset: asset('Bell'),
      files: [{path: 'bell.wav', bytes: wav()}],
      signal: new AbortController().signal,
      inspectAudio: () => ({durationSeconds: 2_000, channels: 2, sampleRate: 48_000}),
      ...limits,
    }),
    (error) => error.code === 'K4-ASSET-LIMIT-001',
  );
});

test('validates one complete pose bundle and every referenced label', async () => {
  const result = await validateDsl4AssetCandidate({
    storyDocument,
    asset: asset('Rescue'),
    files: poseFiles(),
    signal: new AbortController().signal,
    ...limits,
  });
  assert.deepEqual(result.summary, {
    assetId: 'Rescue',
    kind: 'recognitionModel',
    fileCount: 3,
    labelCount: 2,
  });
  await result.release();

  await assert.rejects(
    validateDsl4AssetCandidate({
      storyDocument,
      asset: asset('Rescue'),
      files: poseFiles(['jump']),
      signal: new AbortController().signal,
      ...limits,
    }),
    (error) => error.code === 'K4-ASSET-POSE-LABEL-001',
  );
  await assert.rejects(
    validateDsl4AssetCandidate({
      storyDocument,
      asset: asset('Rescue'),
      files: poseFiles().slice(0, 2),
      signal: new AbortController().signal,
      ...limits,
    }),
    (error) => error.code === 'K4-ASSET-POSE-BUNDLE-001',
  );
});

test('releases decoded resources when validation fails or is cancelled', async () => {
  const releases = [];
  await assert.rejects(
    validateDsl4AssetCandidate({
      storyDocument,
      asset: asset('Picture'),
      files: [{path: 'picture.svg', bytes: encoder.encode('<svg/>')}],
      signal: new AbortController().signal,
      inspectImage: () => ({
        width: 100_000,
        height: 100_000,
        release: () => releases.push('failed'),
      }),
      ...limits,
    }),
    (error) => error.code === 'K4-ASSET-LIMIT-001',
  );
  assert.deepEqual(releases, ['failed']);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    validateDsl4AssetCandidate({
      storyDocument,
      asset: asset('Picture'),
      files: [{path: 'picture.svg', bytes: encoder.encode('<svg/>')}],
      signal: controller.signal,
      inspectImage: () => ({width: 1, height: 1}),
      ...limits,
    }),
    (error) => error.name === 'AbortError',
  );
});

test('rejects missing explicit limits, inspectors, and malformed files before partial success', async () => {
  await assert.rejects(
    validateDsl4AssetCandidate({
      storyDocument,
      asset: asset('Picture'),
      files: [{path: 'picture.svg', bytes: encoder.encode('<svg/>')}],
      signal: new AbortController().signal,
      ...limits,
    }),
    (error) => error.code === 'K4-ASSET-DECODE-001',
  );
  await assert.rejects(
    validateDsl4AssetCandidate({
      storyDocument,
      asset: asset('Bell'),
      files: [],
      signal: new AbortController().signal,
      inspectAudio() {},
      ...limits,
    }),
    TypeError,
  );
});
