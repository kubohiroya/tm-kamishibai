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
    kind: poseModel
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
          kind: 'poseModel',
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

test('asset bundle runtime core has no filesystem, network, DOM, VM, or Scratch dependency', async () => {
  const implementation = await readFile(
    path.join(projectRoot, 'src', 'dsl4', 'asset-bundle-descriptor.js'),
    'utf8',
  );
  assert.doesNotMatch(implementation, /(?:node:fs|node:http|node:https|\bfetch\s*\()/u);
  assert.doesNotMatch(implementation, /(?:globalThis\.(?:document|window)|KeyboardEvent)/u);
  assert.doesNotMatch(implementation, /(?:\bScratch\b|scratch-vm|vm\.runtime|startHats)/u);
});
