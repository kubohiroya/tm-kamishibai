import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';
import {downloadProjectFromBuffer} from '@turbowarp/sbdl';

import {
  createDsl4BinaryEntryProviderFromSb3,
  dsl4SbdlCompatibility,
  embedDsl4BinaryEntryRuntimeComponentInSb3,
  Sb3BuilderError,
} from '../src/builder/index.js';
import {
  createDsl4BinaryEntryAssetBundle,
  createDsl4EmbeddedSourceDescriptor,
  createDsl4OneShotBinaryEntryProvider,
  createDsl4RuntimeArtifactDescriptor,
  createDsl4SourceFrontend,
  dsl4BinaryEntryFormatVersion,
  dsl4BinaryEntryPrefix,
  dsl4LegacyBinaryEntryFormatVersion,
  dsl4LegacyBinaryEntryPrefix,
  Dsl4BinaryEntryError,
  loadDsl4BinaryEntryRuntimeComponent,
  loadDsl4RuntimeComponent,
  validateDsl4BinaryEntryAssetBundle,
} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const sbdlPackage = require('@turbowarp/sbdl/package.json');
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const subtleCrypto = webcrypto.subtle;
const maxSourceBytes = 8192;
const bundleOptions = {
  maxFiles: 10,
  maxFileBytes: 4096,
  maxTotalBytes: 16 * 1024,
  subtleCrypto,
};
const componentOptions = {
  channel: 'bundled',
  maxSourceBytes,
  maxAssetFiles: bundleOptions.maxFiles,
  maxAssetFileBytes: bundleOptions.maxFileBytes,
  maxAssetBytes: bundleOptions.maxTotalBytes,
  subtleCrypto,
};
const archiveOptions = {
  maxSourceBytes,
  maxArchiveBytes: 1024 * 1024,
  maxArchiveEntries: 32,
  maxArchiveEntryBytes: 128 * 1024,
  maxArchiveExpandedBytes: 512 * 1024,
  maxAssetFiles: bundleOptions.maxFiles,
  maxAssetFileBytes: bundleOptions.maxFileBytes,
  maxAssetBytes: bundleOptions.maxTotalBytes,
  maxCompressionRatio: 100,
  subtleCrypto,
};
const sourceText = `
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
controls:
  keymaps:
    development:
      Space: navigation.nextAction
    production:
      Space: navigation.nextAction
scenes:
  opening: []
`;

function sri(bytes) {
  return `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function legacyBinaryBundle(rootBundle) {
  const files = rootBundle.descriptor.files.map(
    ({assetId, path: filePath, size, integrity, entry}) => ({
      assetId,
      path: filePath,
      size,
      integrity,
      entry: `${dsl4LegacyBinaryEntryPrefix}${entry.slice(dsl4BinaryEntryPrefix.length)}`,
    }),
  );
  const content = {
    formatVersion: dsl4LegacyBinaryEntryFormatVersion,
    manifest: structuredClone(rootBundle.descriptor.manifest),
    files,
  };
  const entryNames = [...new Set(files.map(({entry}) => entry))].sort();
  return {
    descriptor: {...content, integrity: sri(new TextEncoder().encode(canonicalJson(content)))},
    entryNames,
    getEntry(entryName) {
      return rootBundle.getEntry(
        `${dsl4BinaryEntryPrefix}${entryName.slice(dsl4LegacyBinaryEntryPrefix.length)}`,
      );
    },
  };
}

function replaceZipEntryName(bytes, from, to) {
  assert.equal(from.length, to.length);
  const output = Buffer.from(bytes);
  const needle = Buffer.from(from);
  const replacement = Buffer.from(to);
  let count = 0;
  for (
    let offset = output.indexOf(needle);
    offset !== -1;
    offset = output.indexOf(needle, offset + 1)
  ) {
    replacement.copy(output, offset);
    count += 1;
  }
  assert.equal(count, 2, 'ZIP entry name must occur in one local and one central header');
  return output;
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
  return Buffer.from(
    zipSync({
      'project.json': strToU8(`${JSON.stringify(baseProject())}\n`),
      'existing.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    }),
  );
}

function assetSnapshot() {
  const shared = new TextEncoder().encode('A'.repeat(256));
  const metadata = new TextEncoder().encode('{"labels":["rescue"]}');
  const blobs = new Map([
    ['Image\0image.svg', shared],
    ['Pose\0metadata.json', metadata],
    ['Pose\0model.json', shared],
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
            files: [{path: 'image.svg', size: shared.length, integrity: sri(shared)}],
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
                size: metadata.length,
                integrity: sri(metadata),
              },
              {path: 'model.json', size: shared.length, integrity: sri(shared)},
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

async function fixture() {
  const parsed = frontend.parse(sourceText, {sourceId: 'main'});
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const sourceDescriptor = await createDsl4EmbeddedSourceDescriptor(sourceText, {
    sourceId: 'main',
    displayName: 'story.kamishibai.yaml',
    maxSourceBytes,
    subtleCrypto,
  });
  const artifact = await createDsl4RuntimeArtifactDescriptor(
    parsed.storyDocument,
    sourceDescriptor,
    'production',
    {maxSourceBytes, subtleCrypto},
  );
  assert.equal(artifact.ok, true, JSON.stringify(artifact.diagnostics));
  const binaryBundle = await createDsl4BinaryEntryAssetBundle(
    parsed.storyDocument,
    assetSnapshot(),
    bundleOptions,
  );
  return {
    storyDocument: parsed.storyDocument,
    sourceDescriptor,
    runtimeArtifact: artifact.artifact,
    binaryBundle,
  };
}

async function rejectsEntryCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof Dsl4BinaryEntryError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test('creates a canonical content-addressed descriptor without Base64 payloads', async () => {
  const component = await fixture();
  const {descriptor, entryNames} = component.binaryBundle;
  assert.equal(descriptor.formatVersion, dsl4BinaryEntryFormatVersion);
  assert.equal(descriptor.files.length, 3);
  assert.equal(entryNames.length, 2, 'identical bytes share one ZIP entry');
  assert.equal(descriptor.files[0].entry.startsWith(dsl4BinaryEntryPrefix), true);
  for (const file of descriptor.files) {
    assert.deepEqual(Object.keys(file), [
      'assetId',
      'path',
      'size',
      'integrity',
      'contentType',
      'entry',
    ]);
    assert.match(file.entry, /^k4asset-v1-[0-9a-f]{64}$/u);
    assert.equal(file.entry.includes('/'), false);
    assert.equal(
      file.contentType,
      file.path.endsWith('.svg') ? 'image/svg+xml' : 'application/json',
    );
    assert.equal(Object.hasOwn(file, 'data'), false);
    assert.equal(Object.hasOwn(file, 'encoding'), false);
  }
  const validated = await validateDsl4BinaryEntryAssetBundle(
    component.storyDocument,
    structuredClone(descriptor),
    bundleOptions,
  );
  assert.deepEqual(validated, descriptor);
  assert.equal(Object.isFrozen(validated.files), true);
  const first = component.binaryBundle.getEntry(entryNames[0]);
  first[0] ^= 0xff;
  assert.notDeepEqual(first, component.binaryBundle.getEntry(entryNames[0]));

  const suppliedAgain = await createDsl4BinaryEntryAssetBundle(
    component.storyDocument,
    assetSnapshot(),
    bundleOptions,
  );
  assert.deepEqual(suppliedAgain.descriptor, descriptor);
  assert.deepEqual(suppliedAgain.entryNames, entryNames);
});

test('rejects descriptor mutation, unsafe paths, noncanonical integrity, and resource limits', async () => {
  const component = await fixture();
  const descriptor = component.binaryBundle.descriptor;
  const reversed = structuredClone(descriptor);
  reversed.files.reverse();
  const missing = structuredClone(descriptor);
  missing.files.pop();
  const unsafe = structuredClone(descriptor);
  unsafe.files[0].entry = '../payload';
  const nonRoot = structuredClone(descriptor);
  nonRoot.files[0].entry = `nested/${nonRoot.files[0].entry}`;
  const wrongContentType = structuredClone(descriptor);
  wrongContentType.files[0].contentType = 'application/octet-stream';
  const noncanonical = structuredClone(descriptor);
  const integrity = noncanonical.integrity;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const index = integrity.length - 2;
  noncanonical.integrity =
    integrity.slice(0, index) + alphabet[alphabet.indexOf(integrity[index]) + 1] + '=';

  for (const [candidate, code] of [
    [reversed, 'K4-ASSET-ENTRY-ORDER-001'],
    [missing, 'K4-ASSET-ENTRY-MANIFEST-001'],
    [unsafe, 'K4-ASSET-ENTRY-PATH-001'],
    [nonRoot, 'K4-ASSET-ENTRY-PATH-001'],
    [wrongContentType, 'K4-ASSET-ENTRY-MANIFEST-001'],
    [noncanonical, 'K4-ASSET-ENTRY-DESCRIPTOR-001'],
  ]) {
    await rejectsEntryCode(
      validateDsl4BinaryEntryAssetBundle(component.storyDocument, candidate, bundleOptions),
      code,
    );
  }
  await rejectsEntryCode(
    validateDsl4BinaryEntryAssetBundle(component.storyDocument, descriptor, {
      ...bundleOptions,
      maxFiles: 2,
    }),
    'K4-ASSET-ENTRY-LIMIT-001',
  );
  await rejectsEntryCode(
    validateDsl4BinaryEntryAssetBundle(component.storyDocument, descriptor, {
      ...bundleOptions,
      maxFileBytes: 128,
    }),
    'K4-ASSET-ENTRY-LIMIT-001',
  );
  const oversizedSnapshot = assetSnapshot();
  let reads = 0;
  await rejectsEntryCode(
    createDsl4BinaryEntryAssetBundle(
      component.storyDocument,
      {
        manifest: oversizedSnapshot.manifest,
        getFile(assetId, filePath) {
          reads += 1;
          return oversizedSnapshot.getFile(assetId, filePath);
        },
      },
      {...bundleOptions, maxFileBytes: 128},
    ),
    'K4-ASSET-ENTRY-LIMIT-001',
  );
  assert.equal(reads, 0, 'declared limits must fail before payload reads');
});

test('reads legacy nested v2 descriptors without implicitly converting them to root v3', async () => {
  const component = await fixture();
  const legacyBundle = legacyBinaryBundle(component.binaryBundle);
  const validated = await validateDsl4BinaryEntryAssetBundle(
    component.storyDocument,
    legacyBundle.descriptor,
    bundleOptions,
  );
  assert.equal(validated.formatVersion, dsl4LegacyBinaryEntryFormatVersion);
  assert.equal(
    validated.files.every(({entry}) => entry.startsWith(dsl4LegacyBinaryEntryPrefix)),
    true,
  );

  const mislabeled = structuredClone(component.binaryBundle.descriptor);
  mislabeled.formatVersion = dsl4LegacyBinaryEntryFormatVersion;
  await rejectsEntryCode(
    validateDsl4BinaryEntryAssetBundle(component.storyDocument, mislabeled, bundleOptions),
    'K4-ASSET-ENTRY-DESCRIPTOR-001',
  );

  const built = await embedDsl4BinaryEntryRuntimeComponentInSb3(
    baseSb3(),
    component.storyDocument,
    component.sourceDescriptor,
    component.runtimeArtifact,
    legacyBundle,
    componentOptions,
  );
  const archive = unzipSync(built.bytes);
  assert.deepEqual(
    Object.keys(archive)
      .filter((name) => name.startsWith(dsl4LegacyBinaryEntryPrefix))
      .sort(),
    legacyBundle.entryNames,
  );
  const provider = await createDsl4BinaryEntryProviderFromSb3(
    built.bytes,
    component.storyDocument,
    legacyBundle.descriptor,
    archiveOptions,
  );
  assert.equal((await provider.consumeAsset('Image')).files[0].contentType, undefined);
  await provider.release();
});

test('consumes each asset once and drops reader references on completion or release', async () => {
  const component = await fixture();
  let releases = 0;
  const provider = await createDsl4OneShotBinaryEntryProvider(
    component.storyDocument,
    component.binaryBundle.descriptor,
    {
      ...bundleOptions,
      maxCompressionRatio: 1,
      readEntry(entryName) {
        const bytes = component.binaryBundle.getEntry(entryName);
        return {bytes, compressedSize: bytes.length};
      },
      releaseEntries() {
        releases += 1;
      },
    },
  );
  const image = await provider.consumeAsset('Image');
  assert.equal(provider.released, false);
  assert.equal(provider.remainingAssetCount, 1);
  image.files[0].bytes[0] ^= 0xff;
  await rejectsEntryCode(provider.consumeAsset('Image'), 'K4-ASSET-ENTRY-CONSUMED-001');
  await provider.consumeAsset('Pose');
  assert.equal(provider.released, true);
  assert.equal(provider.remainingAssetCount, 0);
  assert.equal(releases, 1);
  await provider.release();
  assert.equal(releases, 1);
  await rejectsEntryCode(provider.consumeAsset('Pose'), 'K4-ASSET-ENTRY-RELEASED-001');

  let unblock;
  const pendingProvider = await createDsl4OneShotBinaryEntryProvider(
    component.storyDocument,
    component.binaryBundle.descriptor,
    {
      ...bundleOptions,
      maxCompressionRatio: 1,
      readEntry: (entryName) =>
        new Promise((resolve) => {
          unblock = () => {
            const bytes = component.binaryBundle.getEntry(entryName);
            resolve({bytes, compressedSize: bytes.length});
          };
        }),
    },
  );
  const pending = pendingProvider.consumeAsset('Image');
  await rejectsEntryCode(pendingProvider.consumeAsset('Pose'), 'K4-ASSET-ENTRY-BUSY-001');
  const release = pendingProvider.release();
  unblock();
  await rejectsEntryCode(pending, 'K4-ASSET-ENTRY-ABORTED-001');
  await release;
  assert.equal(pendingProvider.released, true);

  const abortedProvider = await createDsl4OneShotBinaryEntryProvider(
    component.storyDocument,
    component.binaryBundle.descriptor,
    {
      ...bundleOptions,
      maxCompressionRatio: 1,
      readEntry() {
        throw new Error('must not be called');
      },
    },
  );
  const controller = new AbortController();
  controller.abort();
  await rejectsEntryCode(
    abortedProvider.consumeAsset('Image', {signal: controller.signal}),
    'K4-ASSET-ENTRY-ABORTED-001',
  );
  await abortedProvider.release();
});

test('re-reads validated assets for direct runtime backing without weakening one-shot consume', async () => {
  const component = await fixture();
  let reads = 0;
  const provider = await createDsl4OneShotBinaryEntryProvider(
    component.storyDocument,
    component.binaryBundle.descriptor,
    {
      ...bundleOptions,
      maxCompressionRatio: 1,
      releaseAfterLastAsset: false,
      readEntry(entryName) {
        reads += 1;
        const bytes = component.binaryBundle.getEntry(entryName);
        return {bytes, compressedSize: bytes.length};
      },
    },
  );

  const first = await provider.readAsset('Image');
  first.files[0].bytes[0] ^= 0xff;
  const second = await provider.readAsset('Image');
  assert.deepEqual(second.files[0].bytes, assetSnapshot().getFile('Image', 'image.svg'));
  assert.equal(provider.remainingAssetCount, 2);

  await provider.consumeAsset('Image');
  assert.equal(provider.remainingAssetCount, 1);
  await provider.readAsset('Image');
  await rejectsEntryCode(provider.consumeAsset('Image'), 'K4-ASSET-ENTRY-CONSUMED-001');
  assert.equal(reads, 4);

  await provider.release();
  await rejectsEntryCode(provider.readAsset('Image'), 'K4-ASSET-ENTRY-RELEASED-001');
});

test('embeds and loads the binary mode explicitly without changing the legacy default', async () => {
  const component = await fixture();
  const input = baseSb3();
  const first = await embedDsl4BinaryEntryRuntimeComponentInSb3(
    input,
    component.storyDocument,
    component.sourceDescriptor,
    component.runtimeArtifact,
    component.binaryBundle,
    componentOptions,
  );
  const second = await embedDsl4BinaryEntryRuntimeComponentInSb3(
    input,
    component.storyDocument,
    component.sourceDescriptor,
    component.runtimeArtifact,
    component.binaryBundle,
    componentOptions,
  );
  assert.deepEqual(first.bytes, second.bytes);
  assert.deepEqual(first.project.targets, baseProject().targets);
  const archive = unzipSync(first.bytes);
  assert.deepEqual(
    Object.keys(archive)
      .filter((name) => name.startsWith(dsl4BinaryEntryPrefix))
      .sort(),
    component.binaryBundle.entryNames,
  );
  const stored =
    first.project.extensionStorage.kubohiroyakamishibai4.components.kubohiroyakamishibairuntime4
      .assets;
  assert.equal(JSON.stringify(stored).includes('"data"'), false);
  assert.equal(stored.formatVersion, dsl4BinaryEntryFormatVersion);

  const loaded = await loadDsl4BinaryEntryRuntimeComponent(first.project, frontend, archiveOptions);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
  assert.deepEqual(loaded.assetBundle, component.binaryBundle.descriptor);
  assert.equal(Object.hasOwn(loaded, 'getAssetFile'), false);
  const legacyLoad = await loadDsl4RuntimeComponent(first.project, frontend, archiveOptions);
  assert.equal(legacyLoad.ok, false);
  assert.equal(legacyLoad.diagnostics[0].code, 'K4-ASSET-BUNDLE-DESCRIPTOR-001');

  const retainedInput = Buffer.from(first.bytes);
  const provider = await createDsl4BinaryEntryProviderFromSb3(
    retainedInput,
    loaded.storyDocument,
    loaded.assetBundle,
    archiveOptions,
  );
  retainedInput.fill(0);
  const image = await provider.consumeAsset('Image');
  assert.deepEqual(image.files[0].bytes, assetSnapshot().getFile('Image', 'image.svg'));
  const pose = await provider.consumeAsset('Pose');
  assert.equal(pose.files.length, 2);
  assert.equal(provider.released, true);
});

test('preserves root descriptor references and bytes through the pinned sbdl normalization', async () => {
  assert.equal(sbdlPackage.version, dsl4SbdlCompatibility.version);
  assert.equal(dsl4SbdlCompatibility.commit, '56e841ccbdc4f8902c11b53c85299a4988c213e2');
  const component = await fixture();
  const built = await embedDsl4BinaryEntryRuntimeComponentInSb3(
    baseSb3(),
    component.storyDocument,
    component.sourceDescriptor,
    component.runtimeArtifact,
    component.binaryBundle,
    componentOptions,
  );
  const before = unzipSync(built.bytes);
  const withNestedEntry = zipSync({
    ...before,
    'normalization-fixture/note.txt': strToU8('forces sbdl to normalize'),
  });
  const normalized = await downloadProjectFromBuffer(withNestedEntry, {
    date: new Date('2021-12-31T00:00:00.000Z'),
  });
  assert.equal(normalized.type, 'sb3');
  const after = unzipSync(new Uint8Array(normalized.arrayBuffer));
  const normalizedProject = JSON.parse(strFromU8(after['project.json']));
  const normalizedDescriptor =
    normalizedProject.extensionStorage.kubohiroyakamishibai4.components.kubohiroyakamishibairuntime4
      .assets;
  assert.deepEqual(normalizedDescriptor, component.binaryBundle.descriptor);
  for (const entryName of component.binaryBundle.entryNames) {
    assert.deepEqual(after[entryName], before[entryName]);
  }
});

test('rejects reserved root entry collisions even during explicit component replacement', async () => {
  const component = await fixture();
  const collisionEntry = component.binaryBundle.entryNames[0];
  const project = baseProject();
  project.targets[0].costumes = [
    {
      name: 'Collision',
      assetId: 'not-a-scratch-md5',
      dataFormat: 'bin',
      md5ext: collisionEntry,
    },
  ];
  const collisionSb3 = zipSync({
    'project.json': strToU8(`${JSON.stringify(project)}\n`),
    [collisionEntry]: component.binaryBundle.getEntry(collisionEntry),
  });
  await assert.rejects(
    embedDsl4BinaryEntryRuntimeComponentInSb3(
      collisionSb3,
      component.storyDocument,
      component.sourceDescriptor,
      component.runtimeArtifact,
      component.binaryBundle,
      {...componentOptions, replaceExisting: true},
    ),
    (error) => {
      assert.equal(error instanceof Sb3BuilderError, true);
      assert.equal(error.code, 'K4-ASSET-ENTRY-ARCHIVE-COLLISION-001');
      return true;
    },
  );
});

test('fails closed before inflation for archive mismatch and bounds', async () => {
  const component = await fixture();
  const built = await embedDsl4BinaryEntryRuntimeComponentInSb3(
    baseSb3(),
    component.storyDocument,
    component.sourceDescriptor,
    component.runtimeArtifact,
    component.binaryBundle,
    componentOptions,
  );
  const archive = unzipSync(built.bytes);
  const unexpected = {...archive, [`${dsl4BinaryEntryPrefix}extra`]: strToU8('extra')};
  await rejectsEntryCode(
    createDsl4BinaryEntryProviderFromSb3(
      zipSync(unexpected),
      component.storyDocument,
      component.binaryBundle.descriptor,
      archiveOptions,
    ),
    'K4-ASSET-ENTRY-MANIFEST-001',
  );
  const unsafe = {...archive, '../outside': strToU8('unsafe')};
  await rejectsEntryCode(
    createDsl4BinaryEntryProviderFromSb3(
      zipSync(unsafe),
      component.storyDocument,
      component.binaryBundle.descriptor,
      archiveOptions,
    ),
    'K4-ASSET-ENTRY-PATH-001',
  );
  const duplicateTarget = component.binaryBundle.entryNames[0];
  const duplicatePlaceholder = `${dsl4BinaryEntryPrefix}${'f'.repeat(64)}`;
  assert.notEqual(duplicateTarget, duplicatePlaceholder);
  const duplicateArchive = replaceZipEntryName(
    zipSync({...archive, [duplicatePlaceholder]: archive[duplicateTarget]}),
    duplicatePlaceholder,
    duplicateTarget,
  );
  await rejectsEntryCode(
    createDsl4BinaryEntryProviderFromSb3(
      duplicateArchive,
      component.storyDocument,
      component.binaryBundle.descriptor,
      archiveOptions,
    ),
    'K4-ASSET-ENTRY-DUPLICATE-001',
  );
  const missing = {...archive};
  delete missing[component.binaryBundle.entryNames[0]];
  await rejectsEntryCode(
    createDsl4BinaryEntryProviderFromSb3(
      zipSync(missing),
      component.storyDocument,
      component.binaryBundle.descriptor,
      archiveOptions,
    ),
    'K4-ASSET-ENTRY-MANIFEST-001',
  );
  await rejectsEntryCode(
    createDsl4BinaryEntryProviderFromSb3(
      built.bytes,
      component.storyDocument,
      component.binaryBundle.descriptor,
      {...archiveOptions, maxArchiveBytes: built.bytes.length - 1},
    ),
    'K4-ASSET-ENTRY-ARCHIVE-LIMIT-001',
  );
  await rejectsEntryCode(
    createDsl4BinaryEntryProviderFromSb3(
      built.bytes,
      component.storyDocument,
      component.binaryBundle.descriptor,
      {...archiveOptions, maxCompressionRatio: 1},
    ),
    'K4-ASSET-ENTRY-COMPRESSION-001',
  );

  const tamperedArchive = {...archive};
  tamperedArchive[duplicateTarget] = new Uint8Array(archive[duplicateTarget]);
  tamperedArchive[duplicateTarget][0] ^= 0xff;
  const tamperedProvider = await createDsl4BinaryEntryProviderFromSb3(
    zipSync(tamperedArchive),
    component.storyDocument,
    component.binaryBundle.descriptor,
    archiveOptions,
  );
  const tamperedAssetId = component.binaryBundle.descriptor.files.find(
    ({entry}) => entry === duplicateTarget,
  ).assetId;
  await rejectsEntryCode(
    tamperedProvider.consumeAsset(tamperedAssetId),
    'K4-ASSET-ENTRY-INTEGRITY-001',
  );
  await tamperedProvider.release();

  const released = await createDsl4BinaryEntryProviderFromSb3(
    built.bytes,
    component.storyDocument,
    component.binaryBundle.descriptor,
    archiveOptions,
  );
  await released.release();
  await rejectsEntryCode(released.consumeAsset('Image'), 'K4-ASSET-ENTRY-RELEASED-001');

  const badBundle = {
    ...component.binaryBundle,
    entryNames: [...component.binaryBundle.entryNames, `${dsl4BinaryEntryPrefix}extra`].sort(),
  };
  await assert.rejects(
    embedDsl4BinaryEntryRuntimeComponentInSb3(
      baseSb3(),
      component.storyDocument,
      component.sourceDescriptor,
      component.runtimeArtifact,
      badBundle,
      componentOptions,
    ),
    (error) => {
      assert.equal(error instanceof Sb3BuilderError, true);
      assert.equal(error.code, 'K4-ASSET-ENTRY-MANIFEST-001');
      return true;
    },
  );
});
