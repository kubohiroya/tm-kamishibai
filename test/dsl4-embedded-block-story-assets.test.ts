import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {test} from 'vitest';

import {createDsl4EmbeddedAssetBundle} from '../src/dsl4/asset-bundle-descriptor.js';
import {createDsl4BinaryEntryAssetBundle} from '../src/dsl4/binary-entry-provider.js';
import {prepareDsl4EmbeddedBlockStoryProject} from '../src/dsl4/platform/embedded-block-story.js';
import {
  loadDsl4BinaryEntryRuntimeComponent,
  loadDsl4RuntimeComponent,
} from '../src/dsl4/runtime-artifact-loader.js';
import {createDsl4StructuredBlockSourceDeclaration} from '../src/dsl4/structured-block-source.js';
import {dsl4TestSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';
import {firstDiagnostic, okResult} from './helpers/result-outcome.ts';
import {requireArray, requireRecord} from './helpers/require-value.ts';

const options = {
  maxSourceBytes: 16384,
  maxAssetFiles: 10,
  maxAssetFileBytes: 16384,
  maxTotalAssetBytes: 16384,
  subtleCrypto: webcrypto.subtle,
};
const fileBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
const integrity = `sha256-${createHash('sha256').update(fileBytes).digest('base64')}`;
const fileAssets = {Opening: {kind: 'backdrop', file: 'assets/opening.svg'}};

function source(assets: Record<string, unknown>) {
  return {
    controls: {keymaps: {production: {Space: 'navigation.nextAction'}}},
    assets,
    scenes: {opening: [{wait: 0}]},
  };
}

function project(assets: Record<string, unknown>, bundle?: unknown, channel = 'bundled') {
  const component = {
    application: {mode: 'menu'},
    ...(bundle === undefined ? {} : {assets: bundle}),
  };
  return {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        blocks: createDsl4StructuredBlockSourceDeclaration({
          source: source(assets),
          label: '',
          form: 'bundle',
          hatId: 'root',
          idPrefix: 'root-',
        }),
      },
    ],
    extensionStorage:
      channel === 'bundled'
        ? {kubohiroyakamishibai4: {components: {kubohiroyakamishibairuntime4: component}}}
        : {kubohiroyakamishibairuntime4: component},
  };
}

function storedComponent(prepared: Record<string, unknown>, channel = 'bundled') {
  const storage = requireRecord(prepared.extensionStorage, 'extension storage');
  if (channel === 'unbundled') {
    return requireRecord(storage.kubohiroyakamishibairuntime4, 'direct runtime component');
  }
  const bundle = requireRecord(storage.kubohiroyakamishibai4, 'extension bundle');
  return requireRecord(
    requireRecord(bundle.components, 'components').kubohiroyakamishibairuntime4,
    'bundled runtime component',
  );
}

function fileSnapshot() {
  return {
    manifest: {
      formatVersion: 1,
      assets: [
        {
          id: 'Opening',
          kind: 'backdrop',
          loading: 'eager',
          source: {
            type: 'file',
            inputPath: 'assets/opening.svg',
            mode: 'file',
            files: [{path: 'opening.svg', size: fileBytes.length, integrity}],
          },
        },
      ],
    },
    getFile(assetId: string, filePath: string) {
      assert.equal(assetId, 'Opening');
      assert.equal(filePath, 'opening.svg');
      return new Uint8Array(fileBytes);
    },
  };
}

function fileStory(assets: Record<string, unknown> = fileAssets) {
  return requireRecord(
    okResult(
      frontend.parse(JSON.stringify({kamishibai: '4.0', ...source(assets)})),
      'file asset source',
    ).storyDocument,
    'file asset story',
  );
}

test('preserves embedded file bytes and loads the edited blocks through either component channel', async () => {
  const assets = await createDsl4EmbeddedAssetBundle(fileStory(), fileSnapshot(), {
    maxFiles: options.maxAssetFiles,
    maxTotalBytes: options.maxTotalAssetBytes,
    subtleCrypto: options.subtleCrypto,
  });
  for (const channel of ['bundled', 'unbundled']) {
    const input = project(fileAssets, assets, channel);
    const original = structuredClone(input);
    const prepared = await prepareDsl4EmbeddedBlockStoryProject(input, frontend, options);
    assert.deepEqual(input, original);
    assert.deepEqual(storedComponent(prepared, channel).assets, assets);
    const loaded = okResult(
      await loadDsl4RuntimeComponent(prepared, frontend, options),
      `${channel} file component`,
    );
    assert.equal(loaded.channel, channel);
    assert.deepEqual(loaded.assetBundle, assets);
    assert.equal(typeof loaded.getAssetFile, 'function');
    const getFile = loaded.getAssetFile as (assetId: string, filePath: string) => Uint8Array;
    assert.deepEqual(getFile('Opening', 'opening.svg'), fileBytes);
  }
});

test('preserves binary entry metadata so the packaged runtime can bind the existing archive bytes', async () => {
  const bundle = await createDsl4BinaryEntryAssetBundle(fileStory(), fileSnapshot(), {
    maxFiles: options.maxAssetFiles,
    maxFileBytes: options.maxAssetFileBytes,
    maxTotalBytes: options.maxTotalAssetBytes,
    subtleCrypto: options.subtleCrypto,
  });
  const prepared = await prepareDsl4EmbeddedBlockStoryProject(
    project(fileAssets, bundle.descriptor),
    frontend,
    options,
  );
  assert.deepEqual(storedComponent(prepared).assets, bundle.descriptor);
  const loaded = okResult(
    await loadDsl4BinaryEntryRuntimeComponent(prepared, frontend, options),
    'binary entry block story',
  );
  assert.deepEqual(loaded.assetBundle, bundle.descriptor);
  const files = requireArray(
    requireRecord(loaded.assetBundle, 'asset bundle').files,
    'file entries',
  );
  const entry = requireRecord(files[0], 'opening entry').entry;
  assert.equal(typeof entry, 'string');
  assert.deepEqual(bundle.getEntry(entry as string), fileBytes);
});

test('rebuilds project and remote asset definitions from the current blocks', async () => {
  const remote = {
    url: 'https://cdn.example.com/opening.ogg',
    integrity: 'sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    contentType: 'audio/ogg',
    size: 123,
  };
  const prepared = await prepareDsl4EmbeddedBlockStoryProject(
    project(
      {
        ProjectBackdrop: {kind: 'backdrop', name: 'Menu', loading: 'lazy'},
        RemoteMusic: {kind: 'sound', delivery: 'remote', source: remote},
      },
      {invalid: 'stale bundle'},
    ),
    frontend,
    options,
  );
  const loaded = okResult(
    await loadDsl4RuntimeComponent(prepared, frontend, options),
    'project and remote block assets',
  );
  const bundle = requireRecord(loaded.assetBundle, 'regenerated asset bundle');
  const manifest = requireRecord(bundle.manifest, 'asset manifest');
  const assets = requireArray(manifest.assets, 'manifest assets');
  assert.deepEqual(
    assets.map((asset) => requireRecord(asset, 'manifest asset').source),
    [
      {type: 'project', name: 'Menu'},
      {type: 'remote', ...remote},
    ],
  );
  assert.equal(requireRecord(assets[0], 'project asset').loading, 'lazy');
  assert.deepEqual(bundle.files, []);
});

test('diagnoses a file asset without an embedded bundle on the normal component load path', async () => {
  const prepared = await prepareDsl4EmbeddedBlockStoryProject(
    project(fileAssets),
    frontend,
    options,
  );
  const loaded = await loadDsl4RuntimeComponent(prepared, frontend, options);
  assert.equal(
    firstDiagnostic(loaded, 'missing file bundle').code,
    'K4-ASSET-BUNDLE-CHANNEL-MISSING',
  );
});

test('diagnoses file declarations edited away from the retained bundle instead of loading stale assets', async () => {
  const assets = await createDsl4EmbeddedAssetBundle(fileStory(), fileSnapshot(), {
    maxFiles: options.maxAssetFiles,
    maxTotalBytes: options.maxTotalAssetBytes,
    subtleCrypto: options.subtleCrypto,
  });
  await assert.rejects(
    prepareDsl4EmbeddedBlockStoryProject(
      project({Opening: {kind: 'backdrop', file: 'assets/replaced.svg'}}, assets),
      frontend,
      options,
    ),
    {code: 'K4-ASSET-BUNDLE-MANIFEST-001'},
  );
});

async function mixedFixture(binary: boolean) {
  const remote = {
    url: 'https://cdn.example.com/original.ogg',
    integrity: 'sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    contentType: 'audio/ogg',
    size: 123,
  };
  const definitions = {
    ...fileAssets,
    ProjectBackdrop: {kind: 'backdrop', name: 'Menu'},
    RemoteMusic: {kind: 'sound', delivery: 'remote', source: remote},
    Removed: {kind: 'sound', name: 'Unused'},
  };
  const file = fileSnapshot();
  const snapshot = {
    ...file,
    manifest: {
      formatVersion: 1,
      assets: [
        ...file.manifest.assets,
        {
          id: 'ProjectBackdrop',
          kind: 'backdrop',
          loading: 'eager',
          source: {type: 'project', name: 'Menu'},
        },
        {
          id: 'RemoteMusic',
          kind: 'sound',
          loading: 'eager',
          source: {type: 'remote', ...remote},
        },
        {
          id: 'Removed',
          kind: 'sound',
          loading: 'eager',
          source: {type: 'project', name: 'Unused'},
        },
      ],
    },
  };
  const limits = {
    maxFiles: options.maxAssetFiles,
    maxFileBytes: options.maxAssetFileBytes,
    maxTotalBytes: options.maxTotalAssetBytes,
    subtleCrypto: options.subtleCrypto,
  };
  const bundle = binary
    ? (await createDsl4BinaryEntryAssetBundle(fileStory(definitions), snapshot, limits)).descriptor
    : await createDsl4EmbeddedAssetBundle(fileStory(definitions), snapshot, limits);
  return {
    bundle,
    edited: {
      ...fileAssets,
      Added: {kind: 'sound', name: 'NewSound'},
      ProjectBackdrop: {kind: 'backdrop', name: 'UpdatedMenu', loading: 'lazy'},
      RemoteMusic: {
        kind: 'sound',
        delivery: 'remote',
        source: {...remote, url: 'https://cdn.example.com/edited.ogg'},
      },
    },
  };
}

for (const binary of [false, true]) {
  const format = binary ? 'binary-entry' : 'embedded-base64';
  const load = binary ? loadDsl4BinaryEntryRuntimeComponent : loadDsl4RuntimeComponent;

  test(`updates mixed ${format} project/remote references without changing file payloads`, async () => {
    const {bundle, edited} = await mixedFixture(binary);
    for (const channel of ['bundled', 'unbundled']) {
      const input = project(edited, bundle, channel);
      const original = structuredClone(input);
      const prepared = await prepareDsl4EmbeddedBlockStoryProject(input, frontend, options);
      assert.deepEqual(input, original);
      const loaded = okResult(await load(prepared, frontend, options), `${format} edited assets`);
      const updated = requireRecord(loaded.assetBundle, 'updated asset bundle');
      assert.deepEqual(updated.files, bundle.files);
      assert.notEqual(updated.integrity, bundle.integrity);
      const assets = requireArray(
        requireRecord(updated.manifest, 'updated manifest').assets,
        'updated manifest assets',
      ).map((asset) => requireRecord(asset, 'manifest asset'));
      assert.deepEqual(
        assets.map((asset) => asset.id),
        ['Added', 'Opening', 'ProjectBackdrop', 'RemoteMusic'],
      );
      assert.deepEqual(assets[1], fileSnapshot().manifest.assets[0]);
      assert.deepEqual(assets[0]?.source, {type: 'project', name: 'NewSound'});
      assert.deepEqual(assets[2]?.source, {type: 'project', name: 'UpdatedMenu'});
      assert.equal(assets[2]?.loading, 'lazy');
      assert.equal(
        requireRecord(assets[3]?.source, 'updated remote source').url,
        'https://cdn.example.com/edited.ogg',
      );
    }
  });

  test(`refuses to re-sign tampered ${format} metadata during mixed asset edits`, async () => {
    const {bundle, edited} = await mixedFixture(binary);
    const tampered = structuredClone(bundle);
    const assets = requireArray(
      requireRecord(tampered.manifest, 'original manifest').assets,
      'original manifest assets',
    );
    requireRecord(requireRecord(assets[1], 'project asset').source, 'project source').name =
      'TamperedMenu';
    await assert.rejects(
      prepareDsl4EmbeddedBlockStoryProject(project(edited, tampered), frontend, options),
      {code: binary ? 'K4-ASSET-ENTRY-INTEGRITY-001' : 'K4-ASSET-BUNDLE-INTEGRITY-001'},
    );
  });
}

test('refuses to re-sign tampered file bytes during mixed reference edits', async () => {
  const {bundle, edited} = await mixedFixture(false);
  const tampered = structuredClone(bundle);
  const files = requireArray(tampered.files, 'embedded files');
  requireRecord(files[0], 'file payload').data = Buffer.from(
    new Uint8Array(fileBytes.length),
  ).toString('base64');
  await assert.rejects(
    prepareDsl4EmbeddedBlockStoryProject(project(edited, tampered), frontend, options),
    {code: 'K4-ASSET-BUNDLE-INTEGRITY-001'},
  );
});
