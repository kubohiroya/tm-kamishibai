import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  createDsl4EmbeddedAssetBundle,
  createDsl4SourceFrontend,
  Dsl4AssetBundleError,
  validateDsl4EmbeddedAssetBundle,
} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const subtleCrypto = webcrypto.subtle;
const options = {maxFiles: 10, maxTotalBytes: 4096, subtleCrypto};

function sri(bytes) {
  return `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
}

function story() {
  const result = frontend.parse(
    `
kamishibai: '4.0'
assets:
  Project: backdrop
  Image:
    kind: backdrop
    file: assets/image.svg
    loading: lazy
  Pose:
    kind: recognitionModel
    file: models/pose
scenes:
  opening: []
`,
    {sourceId: 'asset-bundle-test'},
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.storyDocument;
}

function snapshot(imageBytes = new TextEncoder().encode('<svg/>')) {
  const blobs = new Map([
    ['Image\0image.svg', imageBytes],
    ['Pose\0metadata.json', new TextEncoder().encode('{"labels":[]}')],
    ['Pose\0model.json', new TextEncoder().encode('{"model":true}')],
  ]);
  return {
    manifest: {
      formatVersion: 1,
      assets: [
        {
          id: 'Image',
          kind: 'backdrop',
          loading: 'lazy',
          source: {
            type: 'file',
            inputPath: 'assets/image.svg',
            mode: 'file',
            files: [
              {
                path: 'image.svg',
                size: blobs.get('Image\0image.svg').length,
                integrity: sri(blobs.get('Image\0image.svg')),
              },
            ],
          },
        },
        {
          id: 'Pose',
          kind: 'recognitionModel',
          loading: 'eager',
          source: {
            type: 'file',
            inputPath: 'models/pose',
            mode: 'directory',
            files: [
              {
                path: 'metadata.json',
                size: blobs.get('Pose\0metadata.json').length,
                integrity: sri(blobs.get('Pose\0metadata.json')),
              },
              {
                path: 'model.json',
                size: blobs.get('Pose\0model.json').length,
                integrity: sri(blobs.get('Pose\0model.json')),
              },
            ],
          },
        },
        {
          id: 'Project',
          kind: 'backdrop',
          loading: 'eager',
          source: {type: 'project', name: 'Project'},
        },
      ],
    },
    getFile(assetId, filePath) {
      return new Uint8Array(blobs.get(`${assetId}\0${filePath}`));
    },
  };
}

function bitmapStory() {
  const result = frontend.parse(
    `
kamishibai: '4.0'
assets:
  Hero:
    kind: costume
    target: Actor
    file: costumes/hero.png
    bitmapResolution: 2
actors:
  Actor: Hero
scenes:
  opening: []
`,
    {sourceId: 'bitmap-costume-test'},
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.storyDocument;
}

function bitmapSnapshot() {
  const bytes = new Uint8Array([1, 2, 3]);
  return {
    manifest: {
      formatVersion: 1,
      assets: [
        {
          id: 'Hero',
          kind: 'costume',
          target: 'Actor',
          loading: 'eager',
          bitmapResolution: 2,
          source: {
            type: 'file',
            inputPath: 'costumes/hero.png',
            mode: 'file',
            files: [{path: 'hero.png', size: bytes.length, integrity: sri(bytes)}],
          },
        },
      ],
    },
    getFile(assetId, filePath) {
      assert.equal(assetId, 'Hero');
      assert.equal(filePath, 'hero.png');
      return bytes;
    },
  };
}

async function rejectsCode(input, code) {
  await assert.rejects(validateDsl4EmbeddedAssetBundle(story(), input, options), (error) => {
    assert.equal(error instanceof Dsl4AssetBundleError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test('creates and validates a canonical self-contained asset bundle', async () => {
  const descriptor = await createDsl4EmbeddedAssetBundle(story(), snapshot(), options);
  assert.equal(descriptor.formatVersion, 1);
  assert.match(descriptor.integrity, /^sha256-/u);
  assert.deepEqual(
    descriptor.files.map(({assetId, path: filePath}) => [assetId, filePath]),
    [
      ['Image', 'image.svg'],
      ['Pose', 'metadata.json'],
      ['Pose', 'model.json'],
    ],
  );
  assert.equal(
    descriptor.files.some(({assetId}) => assetId === 'Project'),
    false,
  );
  const validated = await validateDsl4EmbeddedAssetBundle(
    story(),
    structuredClone(descriptor),
    options,
  );
  assert.deepEqual(validated.descriptor, descriptor);
  assert.equal(Object.isFrozen(validated.descriptor), true);
  assert.equal(Object.isFrozen(validated.descriptor.files), true);
  const first = validated.getFile('Image', 'image.svg');
  first[0] ^= 0xff;
  assert.deepEqual(validated.getFile('Image', 'image.svg'), new TextEncoder().encode('<svg/>'));
});

test('rejects structure, order, duplicate, base64, size, hash, and bundle mutations', async () => {
  const descriptor = await createDsl4EmbeddedAssetBundle(story(), snapshot(), options);
  const unknown = structuredClone(descriptor);
  unknown.extra = true;
  const reversed = structuredClone(descriptor);
  reversed.files.reverse();
  const reversedManifest = structuredClone(descriptor);
  reversedManifest.manifest.assets.reverse();
  const reversedAssetFiles = structuredClone(descriptor);
  reversedAssetFiles.manifest.assets[1].source.files.reverse();
  const duplicate = structuredClone(descriptor);
  duplicate.files.push(structuredClone(duplicate.files[0]));
  const missing = structuredClone(descriptor);
  missing.files.pop();
  const invalidBase64 = structuredClone(descriptor);
  invalidBase64.files[0].data = '*invalid*';
  const invalidBase64Alphabet = structuredClone(descriptor);
  invalidBase64Alphabet.files[0].data = 'AA*A';
  const urlSafeBase64Alphabet = structuredClone(descriptor);
  urlSafeBase64Alphabet.files[0].data = '____';
  const misplacedBase64Padding = structuredClone(descriptor);
  misplacedBase64Padding.files[0].data = 'AA=A';
  const nonCanonicalBase64PaddingBits = structuredClone(descriptor);
  nonCanonicalBase64PaddingBits.files[0].data = 'AB==';
  const wrongSize = structuredClone(descriptor);
  wrongSize.files[0].size += 1;
  const wrongHash = structuredClone(descriptor);
  wrongHash.files[0].data = Buffer.from('changed').toString('base64');
  wrongHash.files[0].size = 7;
  wrongHash.manifest.assets[0].source.files[0].size = 7;
  const wrongBundle = structuredClone(descriptor);
  wrongBundle.integrity = `sha256-${'A'.repeat(43)}=`;
  const unsafePath = structuredClone(descriptor);
  unsafePath.manifest.assets[0].source.files[0].path = '../image.svg';
  unsafePath.files[0].path = '../image.svg';
  for (const [candidate, code] of [
    [unknown, 'K4-ASSET-BUNDLE-DESCRIPTOR-001'],
    [reversed, 'K4-ASSET-BUNDLE-ORDER-001'],
    [reversedManifest, 'K4-ASSET-BUNDLE-ORDER-001'],
    [reversedAssetFiles, 'K4-ASSET-BUNDLE-ORDER-001'],
    [duplicate, 'K4-ASSET-BUNDLE-DUPLICATE-001'],
    [missing, 'K4-ASSET-BUNDLE-MANIFEST-001'],
    [invalidBase64, 'K4-ASSET-BUNDLE-BASE64-001'],
    [invalidBase64Alphabet, 'K4-ASSET-BUNDLE-BASE64-001'],
    [urlSafeBase64Alphabet, 'K4-ASSET-BUNDLE-BASE64-001'],
    [misplacedBase64Padding, 'K4-ASSET-BUNDLE-BASE64-001'],
    [nonCanonicalBase64PaddingBits, 'K4-ASSET-BUNDLE-BASE64-001'],
    [wrongSize, 'K4-ASSET-BUNDLE-DESCRIPTOR-001'],
    [wrongHash, 'K4-ASSET-BUNDLE-INTEGRITY-001'],
    [wrongBundle, 'K4-ASSET-BUNDLE-INTEGRITY-001'],
    [unsafePath, 'K4-ASSET-BUNDLE-PATH-001'],
  ]) {
    await rejectsCode(candidate, code);
  }
});

test('rejects a payload for a project reference and enforces finite limits', async () => {
  const descriptor = await createDsl4EmbeddedAssetBundle(story(), snapshot(), options);
  const unexpected = structuredClone(descriptor);
  unexpected.files.push({
    assetId: 'Project',
    path: 'project.svg',
    size: 1,
    integrity: sri(Buffer.from('x')),
    encoding: 'base64',
    data: Buffer.from('x').toString('base64'),
  });
  await rejectsCode(unexpected, 'K4-ASSET-BUNDLE-MANIFEST-001');
  await assert.rejects(
    validateDsl4EmbeddedAssetBundle(story(), descriptor, {...options, maxFiles: 2}),
    (error) => error.code === 'K4-ASSET-BUNDLE-LIMIT-001',
  );
  await assert.rejects(
    validateDsl4EmbeddedAssetBundle(story(), descriptor, {...options, maxTotalBytes: 2}),
    (error) => error.code === 'K4-ASSET-BUNDLE-LIMIT-001',
  );
});

test('binds bitmapResolution through the asset manifest and rejects tampering', async () => {
  const storyDocument = bitmapStory();
  const snapshot = bitmapSnapshot();
  const descriptor = await createDsl4EmbeddedAssetBundle(storyDocument, snapshot, options);
  assert.equal(descriptor.manifest.assets[0].bitmapResolution, 2);

  const missing = structuredClone(descriptor);
  delete missing.manifest.assets[0].bitmapResolution;
  await assert.rejects(
    validateDsl4EmbeddedAssetBundle(storyDocument, missing, options),
    (error) => error.code === 'K4-ASSET-BUNDLE-DESCRIPTOR-001',
  );
  const wrong = structuredClone(descriptor);
  wrong.manifest.assets[0].bitmapResolution = 1;
  await assert.rejects(
    validateDsl4EmbeddedAssetBundle(storyDocument, wrong, options),
    (error) => error.code === 'K4-ASSET-BUNDLE-MANIFEST-001',
  );
});

test('supports a canonical empty file payload', async () => {
  const descriptor = await createDsl4EmbeddedAssetBundle(
    story(),
    snapshot(new Uint8Array()),
    options,
  );
  assert.equal(descriptor.files[0].size, 0);
  assert.equal(descriptor.files[0].data, '');
  const validated = await validateDsl4EmbeddedAssetBundle(story(), descriptor, options);
  assert.deepEqual(validated.getFile('Image', 'image.svg'), new Uint8Array());
});

test('validates a model-sized base64 payload without overflowing the regexp stack', async () => {
  const modelBytes = new Uint8Array(5_897_600);
  for (let index = 0; index < modelBytes.length; index += 1) {
    modelBytes[index] = index % 251;
  }
  const largeOptions = {...options, maxTotalBytes: 8 * 1024 * 1024};
  const descriptor = await createDsl4EmbeddedAssetBundle(
    story(),
    snapshot(modelBytes),
    largeOptions,
  );
  const validated = await validateDsl4EmbeddedAssetBundle(
    story(),
    structuredClone(descriptor),
    largeOptions,
  );
  const recovered = validated.getFile('Image', 'image.svg');
  assert.equal(recovered.length, modelBytes.length);
  assert.equal(recovered[0], 0);
  assert.equal(recovered[250], 250);
  assert.equal(recovered[251], 0);
  assert.equal(recovered.at(-1), modelBytes.at(-1));
});

test('stores verified remote metadata without an embedded payload', async () => {
  const parsed = frontend.parse(
    `
kamishibai: '4.0'
assets:
  Remote:
    kind: sound
    delivery: remote
    loading: lazy
    source:
      url: https://cdn.example.com/remote.ogg
      integrity: sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      contentType: audio/ogg
      size: 123456
scenes:
  opening:
    - sound: Remote
`,
    {sourceId: 'remote-bundle-test'},
  );
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const snapshot = {
    manifest: {
      formatVersion: 1,
      assets: [
        {
          id: 'Remote',
          kind: 'sound',
          loading: 'lazy',
          source: {
            type: 'remote',
            url: 'https://cdn.example.com/remote.ogg',
            integrity: 'sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            contentType: 'audio/ogg',
            size: 123456,
          },
        },
      ],
    },
    getFile() {
      assert.fail('remote assets must not request local bytes');
    },
  };
  const descriptor = await createDsl4EmbeddedAssetBundle(parsed.storyDocument, snapshot, options);
  assert.deepEqual(descriptor.files, []);
  assert.equal(descriptor.manifest.assets[0].source.type, 'remote');
  const validated = await validateDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    descriptor,
    options,
  );
  assert.deepEqual(validated.descriptor, descriptor);

  const changed = structuredClone(descriptor);
  changed.manifest.assets[0].source.url = 'https://cdn.example.com/changed.ogg';
  await assert.rejects(
    validateDsl4EmbeddedAssetBundle(parsed.storyDocument, changed, options),
    (error) => error.code === 'K4-ASSET-BUNDLE-MANIFEST-001',
  );
});

test('stores an unpinned remote pose URL without inventing verification metadata', async () => {
  const parsed = frontend.parse(
    `
kamishibai: '4.0'
assets:
  RemotePose:
    kind: recognitionModel
    delivery: remote
    loading: lazy
    source:
      url: https://cdn.example.com/pose/
scenes:
  opening:
    recognitionModel: RemotePose
    actions: []
`,
    {sourceId: 'bare-remote-pose-bundle-test'},
  );
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const snapshot = {
    manifest: {
      formatVersion: 1,
      assets: [
        {
          id: 'RemotePose',
          kind: 'recognitionModel',
          loading: 'lazy',
          source: {type: 'remote', url: 'https://cdn.example.com/pose/'},
        },
      ],
    },
    getFile() {
      assert.fail('remote assets must not request local bytes');
    },
  };
  const descriptor = await createDsl4EmbeddedAssetBundle(parsed.storyDocument, snapshot, options);
  assert.deepEqual(descriptor.files, []);
  assert.deepEqual(descriptor.manifest.assets[0].source, {
    type: 'remote',
    url: 'https://cdn.example.com/pose/',
  });
  await validateDsl4EmbeddedAssetBundle(parsed.storyDocument, descriptor, options);
});

test('stores URL-only remote image and sound sources without inventing metadata', async () => {
  const parsed = frontend.parse(
    `
kamishibai: '4.0'
assets:
  RemoteImage:
    kind: image
    delivery: remote
    source:
      url: https://cdn.example.com/image.svg
  RemoteSound:
    kind: sound
    delivery: remote
    source:
      url: https://cdn.example.com/sound.wav
scenes:
  opening: []
`,
    {sourceId: 'bare-remote-media-bundle-test'},
  );
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const sources = {
    RemoteImage: {type: 'remote', url: 'https://cdn.example.com/image.svg'},
    RemoteSound: {type: 'remote', url: 'https://cdn.example.com/sound.wav'},
  };
  const snapshot = {
    manifest: {
      formatVersion: 1,
      assets: Object.entries(sources).map(([id, source]) => ({
        id,
        kind: id === 'RemoteImage' ? 'image' : 'sound',
        loading: 'eager',
        source,
      })),
    },
    getFile() {
      assert.fail('remote assets must not request local bytes');
    },
  };
  const descriptor = await createDsl4EmbeddedAssetBundle(parsed.storyDocument, snapshot, options);
  assert.deepEqual(
    Object.fromEntries(descriptor.manifest.assets.map((asset) => [asset.id, asset.source])),
    sources,
  );
  await validateDsl4EmbeddedAssetBundle(parsed.storyDocument, descriptor, options);

  const partial = frontend.parse(
    `
kamishibai: '4.0'
assets:
  RemoteImage:
    kind: image
    delivery: remote
    source:
      url: https://cdn.example.com/image.svg
      contentType: image/svg+xml
scenes:
  opening: []
`,
    {sourceId: 'partial-remote-media-bundle-test'},
  );
  assert.equal(partial.ok, false);
});
