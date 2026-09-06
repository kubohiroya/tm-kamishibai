import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'vitest';
import {fileURLToPath} from 'node:url';

import {strToU8, unzipSync, zipSync} from 'fflate';

import {
  buildDsl4RuntimeComponent,
  createDsl4BinaryEntryProviderFromSb3,
  dsl4DefaultBuildFeatureFlags,
  Dsl4BuildError,
  resolveDsl4BuildFeatureFlags,
  Sb3BuilderError,
} from '../src/builder/index.js';
import {
  createDsl4SourceFrontend,
  dsl4BinaryEntryPrefix,
  dsl4LegacyBinaryEntryPrefix,
} from '../src/dsl4/index.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const subtleCrypto = webcrypto.subtle;
const sourceManifest = Object.freeze({
  formatVersion: 1,
  mode: 'external',
  sourceId: 'main',
  path: 'story.kamishibai.yaml',
  cacheId: 'story000000000001',
  cacheDatabaseName: 'tw-kamishibai-assets-v1--story--story000000000001',
});
const validSource = `
kamishibai: '4.0'
assets:
  OpeningImage:
    kind: backdrop
    file: assets/opening.svg
    loading: lazy
  RescuePose:
    kind: recognitionModel
    file: pose-models/rescue
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    recognitionModel: RescuePose
    actions:
      - stage: OpeningImage
`;
const remoteSource = `
kamishibai: '4.0'
assets:
  RemoteOpening:
    kind: backdrop
    delivery: remote
    loading: lazy
    source:
      url: https://cdn.example.com/remote-opening.svg
      integrity: sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      contentType: image/svg+xml
      size: 123456
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - stage: RemoteOpening
`;
const localPoseArchiveSource = validSource.replace(
  'file: pose-models/rescue',
  'file: pose-models/rescue.ZIP',
);

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

function structuredDataSurface(project) {
  const prefix = 'kubohiroyastructdata1';
  return {
    extensionIds: Object.keys(project.extensionStorage ?? {}).filter((id) => id.startsWith(prefix)),
    opcodes: project.targets.flatMap((target) =>
      Object.values(target.blocks ?? {})
        .map((block) => block?.opcode)
        .filter((opcode) => typeof opcode === 'string' && opcode.startsWith(prefix)),
    ),
  };
}

function baseSb3(project = baseProject()) {
  return Buffer.from(
    zipSync({
      'project.json': strToU8(`${JSON.stringify(project)}\n`),
      'existing.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    }),
  );
}

async function withProject(source, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsl4-one-shot-build-'));
  try {
    await mkdir(path.join(directory, 'assets'));
    await mkdir(path.join(directory, 'pose-models', 'rescue'), {recursive: true});
    await writeFile(path.join(directory, 'story.kamishibai.yaml'), source);
    await writeFile(path.join(directory, 'assets', 'opening.svg'), '<svg/>');
    await writeFile(
      path.join(directory, 'pose-models', 'rescue', 'metadata.json'),
      '{"labels":["rescue"]}',
    );
    await writeFile(path.join(directory, 'pose-models', 'rescue', 'model.json'), '{"model":true}');
    await writeFile(
      path.join(directory, 'pose-models', 'rescue.ZIP'),
      zipSync({
        'metadata.json': strToU8('{"labels":["rescue"]}'),
        'model.json': strToU8('{"weightsManifest":[{"paths":["weights.bin"]}]}'),
        'weights.bin': new Uint8Array([1, 2, 3]),
      }),
    );
    return await callback(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

const buildOptions = (directory, channel, extra = {}) => ({
  baseSb3Bytes: baseSb3(),
  projectRoot: directory,
  sourceManifest,
  sourceFrontend: frontend,
  controlProfile: 'production',
  channel,
  maxSourceBytes: 16 * 1024,
  maxAssetFileBytes: 4096,
  maxAssetFiles: 10,
  maxTotalAssetBytes: 16 * 1024,
  subtleCrypto,
  ...extra,
});

test('resolves the root packaging flag once without adding it to runtime flags', () => {
  assert.deepEqual(dsl4DefaultBuildFeatureFlags, {dsl4RootBinaryEntryPackaging: false});
  assert.equal(Object.isFrozen(dsl4DefaultBuildFeatureFlags), true);
  const enabled = resolveDsl4BuildFeatureFlags({
    dsl4Runtime: true,
    dsl4SourceIncludes: true,
    dsl4RootBinaryEntryPackaging: true,
  });
  assert.equal(enabled.dsl4RootBinaryEntryPackaging, true);
  assert.equal(enabled.runtimeFeatureFlags.dsl4SourceIncludes, true);
  assert.equal(Object.hasOwn(enabled.runtimeFeatureFlags, 'dsl4RootBinaryEntryPackaging'), false);
  assert.throws(() => resolveDsl4BuildFeatureFlags({dsl4RootBinaryEntryPackaging: 1}), TypeError);
  assert.throws(() => resolveDsl4BuildFeatureFlags({unknownBuildFlag: true}), TypeError);
});

test('builds and startup-validates one deterministic self-contained component per channel', async () => {
  await withProject(validSource, async (directory) => {
    const sourcePath = path.join(directory, 'story.kamishibai.yaml');
    const assetPath = path.join(directory, 'assets', 'opening.svg');
    const sourceBefore = await readFile(sourcePath);
    const assetBefore = await readFile(assetPath);
    for (const channel of ['unbundled', 'bundled']) {
      const input = baseSb3();
      const inputCopy = Buffer.from(input);
      const options = buildOptions(directory, channel, {baseSb3Bytes: input});
      const first = await buildDsl4RuntimeComponent(options);
      const second = await buildDsl4RuntimeComponent(options);

      assert.deepEqual(input, inputCopy);
      assert.deepEqual(first.bytes, second.bytes);
      assert.deepEqual(first.project.targets, baseProject().targets);
      assert.deepEqual(structuredDataSurface(first.project), {extensionIds: [], opcodes: []});
      assert.equal(first.runtimeComponent.ok, true);
      assert.equal(first.runtimeComponent.channel, channel);
      assert.equal(Object.isFrozen(first), true);
      assert.equal(Object.isFrozen(first.project), true);
      assert.equal(Object.isFrozen(first.runtimeComponent), true);
      assert.equal(
        JSON.stringify({project: first.project, component: first.runtimeComponent}).includes(
          directory,
        ),
        false,
      );

      const firstAsset = first.runtimeComponent.getAssetFile('OpeningImage', 'opening.svg');
      firstAsset[0] ^= 0xff;
      assert.deepEqual(
        first.runtimeComponent.getAssetFile('OpeningImage', 'opening.svg'),
        new Uint8Array(assetBefore),
      );
      assert.deepEqual(unzipSync(first.bytes)['existing.svg'], unzipSync(input)['existing.svg']);
    }
    assert.deepEqual(await readFile(sourcePath), sourceBefore);
    assert.deepEqual(await readFile(assetPath), assetBefore);
  });
});

test('builds a local recognitionModel zip into the same three-file runtime bundle', async () => {
  await withProject(localPoseArchiveSource, async (directory) => {
    const built = await buildDsl4RuntimeComponent(buildOptions(directory, 'unbundled'));
    const pose = built.runtimeComponent.assetBundle.manifest.assets.find(
      (asset) => asset.id === 'RescuePose',
    );
    assert.equal(pose.source.mode, 'archive');
    assert.deepEqual(
      pose.source.files.map((file) => file.path),
      ['metadata.json', 'model.json', 'weights.bin'],
    );
    assert.deepEqual(
      built.runtimeComponent.getAssetFile('RescuePose', 'weights.bin'),
      new Uint8Array([1, 2, 3]),
    );
  });
});

test('builds deterministic root binary entries only when the packaging flag is enabled', async () => {
  await withProject(validSource, async (directory) => {
    const options = buildOptions(directory, 'bundled', {
      featureFlags: {dsl4Runtime: true, dsl4RootBinaryEntryPackaging: true},
    });
    const first = await buildDsl4RuntimeComponent(options);
    const second = await buildDsl4RuntimeComponent(options);
    assert.deepEqual(first.bytes, second.bytes);
    assert.equal(first.runtimeComponent.ok, true);
    assert.equal(Object.hasOwn(first.runtimeComponent, 'getAssetFile'), false);
    const archive = unzipSync(first.bytes);
    const entryNames = Object.keys(archive).filter((name) =>
      name.startsWith(dsl4BinaryEntryPrefix),
    );
    assert.equal(entryNames.length, 3);
    assert.equal(
      Object.keys(archive).some((name) => name.startsWith(dsl4LegacyBinaryEntryPrefix)),
      false,
    );
    for (const entryName of entryNames) {
      assert.match(entryName, /^k4asset-v1-[0-9a-f]{64}$/u);
      assert.equal(entryName.includes('/'), false);
    }
    const provider = await createDsl4BinaryEntryProviderFromSb3(
      first.bytes,
      first.runtimeComponent.storyDocument,
      first.runtimeComponent.assetBundle,
      {
        maxArchiveBytes: 1024 * 1024,
        maxArchiveEntries: 32,
        maxArchiveEntryBytes: 128 * 1024,
        maxArchiveExpandedBytes: 512 * 1024,
        maxAssetFiles: 10,
        maxAssetFileBytes: 4096,
        maxAssetBytes: 16 * 1024,
        maxCompressionRatio: 100,
        subtleCrypto,
      },
    );
    const pose = await provider.consumeAsset('RescuePose');
    assert.deepEqual(
      pose.files.map(({path, contentType}) => ({path, contentType})),
      [
        {path: 'metadata.json', contentType: 'application/json'},
        {path: 'model.json', contentType: 'application/json'},
      ],
    );
    await provider.release();

    const rollback = await buildDsl4RuntimeComponent(
      buildOptions(directory, 'bundled', {featureFlags: {dsl4Runtime: true}}),
    );
    const explicitRollback = await buildDsl4RuntimeComponent(
      buildOptions(directory, 'bundled', {
        featureFlags: {dsl4Runtime: true, dsl4RootBinaryEntryPackaging: false},
      }),
    );
    assert.deepEqual(explicitRollback.bytes, rollback.bytes);
    assert.equal(
      Object.keys(unzipSync(rollback.bytes)).some((name) => name.startsWith(dsl4BinaryEntryPrefix)),
      false,
    );
    assert.equal(typeof rollback.runtimeComponent.getAssetFile, 'function');
  });
});

test('builds a remote manifest without embedding the remote payload', async () => {
  await withProject(remoteSource, async (directory) => {
    const built = await buildDsl4RuntimeComponent(buildOptions(directory, 'unbundled'));
    assert.deepEqual(built.runtimeComponent.assetBundle.files, []);
    assert.deepEqual(built.runtimeComponent.sourceDescriptor.cacheIdentity, {
      id: 'story000000000001',
      label: 'story.kamishibai.yaml',
      databaseName: 'tw-kamishibai-assets-v1--story--story000000000001',
    });
    assert.deepEqual(built.runtimeComponent.assetBundle.manifest.assets, [
      {
        id: 'RemoteOpening',
        kind: 'backdrop',
        loading: 'lazy',
        bitmapResolution: 1,
        source: {
          type: 'remote',
          url: 'https://cdn.example.com/remote-opening.svg',
          integrity: 'sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          contentType: 'image/svg+xml',
          size: 123456,
        },
      },
    ]);
    assert.throws(
      () => built.runtimeComponent.getAssetFile('RemoteOpening', 'remote-opening.svg'),
      (error) => error.code === 'K4-ASSET-BUNDLE-LOOKUP-001',
    );
  });
});

test('requires explicit replacement and preserves the same-channel component deterministically', async () => {
  await withProject(validSource, async (directory) => {
    const first = await buildDsl4RuntimeComponent(buildOptions(directory, 'unbundled'));
    await assert.rejects(
      buildDsl4RuntimeComponent(buildOptions(directory, 'unbundled', {baseSb3Bytes: first.bytes})),
      (error) =>
        error instanceof Sb3BuilderError && error.code === 'K4-RUNTIME-COMPONENT-STORAGE-EXISTS',
    );
    const replaced = await buildDsl4RuntimeComponent(
      buildOptions(directory, 'unbundled', {
        baseSb3Bytes: first.bytes,
        replaceExisting: true,
      }),
    );
    assert.deepEqual(replaced.bytes, first.bytes);
    await assert.rejects(
      buildDsl4RuntimeComponent(
        buildOptions(directory, 'bundled', {
          baseSb3Bytes: first.bytes,
          replaceExisting: true,
        }),
      ),
      (error) =>
        error instanceof Sb3BuilderError && error.code === 'K4-RUNTIME-COMPONENT-CHANNEL-AMBIGUOUS',
    );
  });
});

test('preserves parser and artifact diagnostics without returning a partial result', async () => {
  await withProject('kamishibai: 4.0\nscenes:\n  opening: []\n', async (directory) => {
    await assert.rejects(
      buildDsl4RuntimeComponent(buildOptions(directory, 'unbundled')),
      (error) => {
        assert.equal(error instanceof Dsl4BuildError, true);
        assert.equal(error.code, 'K4-VERSION-001');
        assert.equal(error.stage, 'dsl4-parse');
        assert.equal(error.diagnostics[0].path, '/kamishibai');
        assert.equal(error.diagnostics[0].range.start.line, 1);
        assert.equal(Object.hasOwn(error, 'bytes'), false);
        return true;
      },
    );
  });

  await withProject(validSource, async (directory) => {
    await assert.rejects(
      buildDsl4RuntimeComponent(
        buildOptions(directory, 'unbundled', {controlProfile: 'development'}),
      ),
      (error) => {
        assert.equal(error instanceof Dsl4BuildError, true);
        assert.equal(error.code, 'K4-KEYMAP-PROFILE-UNKNOWN');
        assert.equal(error.stage, 'dsl4-artifact');
        assert.equal(error.diagnostics[0].path, '$.controls.keymaps');
        assert.equal(Object.hasOwn(error, 'bytes'), false);
        return true;
      },
    );
  });
});

test('fails closed when source or asset bytes change during the one-shot build', async () => {
  await withProject(validSource, async (directory) => {
    let sourceRead = 0;
    await assert.rejects(
      buildDsl4RuntimeComponent(
        buildOptions(directory, 'unbundled', {
          async readSource() {
            sourceRead += 1;
            return Buffer.from(sourceRead === 1 ? validSource : `${validSource}\n# changed\n`);
          },
        }),
      ),
      (error) => error instanceof Sb3BuilderError && error.code === 'K4-PREVIEW-SOURCE-UNSTABLE',
    );

    let assetRead = 0;
    await assert.rejects(
      buildDsl4RuntimeComponent(
        buildOptions(directory, 'unbundled', {
          async readAssetFile(filePath) {
            if (path.basename(filePath) === 'opening.svg') {
              assetRead += 1;
              return Buffer.from(assetRead === 1 ? '<svg/>' : '<svf/>');
            }
            return readFile(filePath);
          },
        }),
      ),
      (error) => error instanceof Sb3BuilderError && error.code === 'K4-ASSET-UNSTABLE-001',
    );
  });
});

test('requires an explicit profile, channel, and every finite source and asset limit', async () => {
  await withProject(validSource, async (directory) => {
    for (const field of [
      'controlProfile',
      'channel',
      'maxSourceBytes',
      'maxAssetFileBytes',
      'maxAssetFiles',
      'maxTotalAssetBytes',
    ]) {
      const options = buildOptions(directory, 'unbundled');
      delete options[field];
      await assert.rejects(buildDsl4RuntimeComponent(options), TypeError, field);
    }
  });
});
