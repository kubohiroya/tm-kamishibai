import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {test} from 'vitest';

import {createDsl4EmbeddedAssetBundle} from '../src/dsl4/asset-bundle-descriptor.js';
import {rebindDsl4AssetBundleReferences} from '../src/dsl4/asset-bundle-references.js';
import {createDsl4BinaryEntryAssetBundle} from '../src/dsl4/binary-entry-provider.js';
import {definitionRecord} from '../src/dsl4/definition-references.js';
import {prepareDsl4EmbeddedBlockStoryProject} from '../src/dsl4/platform/embedded-block-story.js';
import {
  loadDsl4BinaryEntryRuntimeComponent,
  loadDsl4RuntimeComponent,
} from '../src/dsl4/runtime-artifact-loader.js';
import {createDsl4StructuredBlockSourceDeclaration} from '../src/dsl4/structured-block-source.js';
import {dsl4TestSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';
import {okResult} from './helpers/result-outcome.ts';
import {requireRecord} from './helpers/require-value.ts';

const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
const integrity = `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
const limits = {
  maxFiles: 10,
  maxFileBytes: 16384,
  maxTotalBytes: 16384,
  subtleCrypto: webcrypto.subtle,
};
const loadOptions = {
  maxSourceBytes: 16384,
  maxAssetFiles: limits.maxFiles,
  maxAssetFileBytes: limits.maxFileBytes,
  maxTotalAssetBytes: limits.maxTotalBytes,
  subtleCrypto: limits.subtleCrypto,
};
const definitions = {
  Keep: {kind: 'backdrop', file: 'keep.svg'},
  Retired: {kind: 'backdrop', file: 'retired.svg'},
};
type Format = 1 | 2 | 3;
type Assets = Record<string, unknown>;
const source = (assets: Assets) => ({
  controls: {keymaps: {production: {Space: 'navigation.nextAction'}}},
  assets,
  scenes: {opening: [{wait: 0}]},
});
function story(assets: Assets) {
  return requireRecord(
    okResult(frontend.parse(JSON.stringify({kamishibai: '4.0', ...source(assets)})), 'valid story')
      .storyDocument,
    'parsed story',
  );
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function signed<T extends Record<string, unknown>>(content: T) {
  return {
    ...content,
    integrity: `sha256-${createHash('sha256').update(canonicalJson(content)).digest('base64')}`,
  };
}
async function fixture(format: Format) {
  const originalStory = story(definitions);
  const snapshot = {
    manifest: {
      formatVersion: 1,
      assets: Object.entries(definitions).map(([id, asset]) => ({
        id,
        kind: asset.kind,
        loading: 'eager',
        source: {
          type: 'file',
          inputPath: asset.file,
          mode: 'file',
          files: [{path: 'shared.svg', size: bytes.length, integrity}],
        },
      })),
    },
    getFile: () => bytes,
  };
  const root =
    format === 1 ? null : await createDsl4BinaryEntryAssetBundle(originalStory, snapshot, limits);
  const bundle =
    format === 1
      ? await createDsl4EmbeddedAssetBundle(originalStory, snapshot, limits)
      : root!.descriptor;
  if (format !== 2) return bundle;
  const files = (bundle.files as readonly Record<string, unknown>[]).map(
    ({assetId, path, size, integrity, entry}) => ({
      assetId,
      path,
      size,
      integrity,
      entry: String(entry).replace('k4asset-v1-', 'kamishibai/assets/v1/'),
    }),
  );
  return signed({formatVersion: 2, manifest: bundle.manifest, files});
}
const payloads = (bundle: Readonly<Record<string, unknown>>) =>
  bundle.files as readonly Record<string, unknown>[];
function edited(replacement: string): Assets {
  return {
    Keep: definitions.Keep,
    ...(replacement === 'project'
      ? {Retired: {kind: 'backdrop', name: 'Menu'}}
      : replacement === 'remote'
        ? {
            Retired: {
              kind: 'backdrop',
              delivery: 'remote',
              source: {url: 'https://example.test/retired.svg'},
            },
          }
        : {}),
  };
}
function project(assets: Assets, bundle: unknown, channel: string) {
  const component = {assets: bundle, application: {mode: 'menu'}};
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

for (const format of [1, 2, 3] as const) {
  const label = format === 1 ? 'embedded-base64' : `binary-entry v${format}`;
  test(`authenticates and preserves unchanged ${label} payloads`, async () => {
    const bundle = await fixture(format);
    const bound = await rebindDsl4AssetBundleReferences(story(definitions), bundle, limits);
    assert.equal(bound.descriptor, bundle);
    if (format === 1) assert.deepEqual(bound.getFile!('Keep', 'shared.svg'), bytes);
    else
      assert.equal(
        payloads(bundle)[0]!.entry,
        payloads(bundle)[1]!.entry,
        'fixture shares a content-addressed entry',
      );
  });
  for (const replacement of ['removed', 'project', 'remote']) {
    for (const channel of ['bundled', 'unbundled']) {
      test(`prunes obsolete ${label} ${replacement} payloads through ${channel} prepare/load`, async () => {
        const bundle = await fixture(format),
          before = structuredClone(bundle);
        const input = project(edited(replacement), bundle, channel),
          inputBefore = structuredClone(input);
        const prepared = await prepareDsl4EmbeddedBlockStoryProject(input, frontend, loadOptions);
        const load = format === 1 ? loadDsl4RuntimeComponent : loadDsl4BinaryEntryRuntimeComponent;
        const loaded = okResult(await load(prepared, frontend, loadOptions), 'current story loads');
        const updated = definitionRecord(loaded.assetBundle);
        assert.equal(updated.formatVersion, format);
        assert.deepEqual(
          updated.files,
          payloads(bundle).filter((file) => file.assetId === 'Keep'),
        );
        assert.notEqual(updated.integrity, bundle.integrity);
        assert.deepEqual(bundle, before);
        assert.deepEqual(input, inputBefore);
        if (format === 1) {
          const getFile = loaded.getAssetFile as (assetId: string, path: string) => Uint8Array;
          assert.deepEqual(getFile('Keep', 'shared.svg'), bytes);
        }
        const reloaded = await load(JSON.parse(JSON.stringify(prepared)), frontend, loadOptions);
        assert.equal(reloaded.ok, true, JSON.stringify(reloaded.diagnostics));
      });
    }
  }
  test(`prunes all authenticated ${label} file payloads for an empty manifest`, async () => {
    const bundle = await fixture(format);
    const bound = await rebindDsl4AssetBundleReferences(story({}), bundle, limits);
    assert.deepEqual(bound.descriptor.files, []);
    assert.deepEqual(definitionRecord(bound.descriptor.manifest).assets, []);
    const again = await rebindDsl4AssetBundleReferences(story({}), bound.descriptor, limits);
    assert.equal(again.descriptor, bound.descriptor);
    const input = project({}, bundle, 'bundled');
    const prepared = await prepareDsl4EmbeddedBlockStoryProject(input, frontend, loadOptions);
    assert.equal((await loadDsl4RuntimeComponent(prepared, frontend, loadOptions)).ok, true);
  });
  test(`does not re-sign tampered obsolete ${label} metadata before pruning`, async () => {
    const bundle = await fixture(format),
      bad = {
        ...structuredClone(bundle),
        integrity: `sha256-${Buffer.alloc(32).toString('base64')}`,
      };
    const before = structuredClone(bad);
    for (const current of [edited('removed'), {}]) {
      await assert.rejects(rebindDsl4AssetBundleReferences(story(current), bad, limits), {
        code: format === 1 ? 'K4-ASSET-BUNDLE-INTEGRITY-001' : 'K4-ASSET-ENTRY-INTEGRITY-001',
      });
    }
    assert.deepEqual(bad, before);
  });
  test(`rejects missing or redirected ${label} file assets instead of recycling another payload`, async () => {
    const bundle = await fixture(format);
    for (const assets of [
      {Keep: {...definitions.Keep, file: 'changed.svg'}},
      {...definitions, Added: {kind: 'backdrop', file: 'keep.svg'}},
      {Keep: definitions.Keep, RetiredRenamed: definitions.Retired},
    ]) {
      await assert.rejects(rebindDsl4AssetBundleReferences(story(assets), bundle, limits), {
        code: 'K4-ASSET-BUNDLE-MANIFEST-001',
      });
    }
  });
  test(`rejects missing obsolete ${label} payloads even when the outer digest is valid`, async () => {
    const original = await fixture(format);
    const bad = signed({
      formatVersion: format,
      manifest: original.manifest,
      files: payloads(original).filter((file) => file.assetId !== 'Retired'),
    });
    await assert.rejects(rebindDsl4AssetBundleReferences(story(edited('removed')), bad, limits), {
      code: format === 1 ? 'K4-ASSET-BUNDLE-MANIFEST-001' : 'K4-ASSET-ENTRY-MANIFEST-001',
    });
  });
  test(`prunes every ${label} file while retaining current project and remote references`, async () => {
    const original = await fixture(format);
    const current = {
      Keep: {kind: 'backdrop', name: 'Menu'},
      Retired: {
        kind: 'backdrop',
        delivery: 'remote',
        source: {url: 'https://example.test/remote.svg'},
      },
    };
    const bound = await rebindDsl4AssetBundleReferences(story(current), original, limits);
    assert.deepEqual(bound.descriptor.files, []);
    assert.deepEqual(
      (definitionRecord(bound.descriptor.manifest).assets as Record<string, unknown>[]).map(
        (row) => definitionRecord(row.source).type,
      ),
      ['project', 'remote'],
    );
  });
  test(`keeps ${label} implicit-project mode strict for removed explicit file assets`, async () => {
    const bundle = await fixture(format);
    await assert.rejects(
      rebindDsl4AssetBundleReferences(story(edited('removed')), bundle, {
        ...limits,
        implicitProjectAssets: [],
      }),
      {code: 'K4-ASSET-BUNDLE-MANIFEST-001'},
    );
  });
}

test('authenticates even obsolete embedded bytes before pruning, with a valid outer digest', async () => {
  const original = await fixture(1);
  const files = payloads(original).map((file) =>
    file.assetId === 'Retired'
      ? {...file, data: Buffer.from(new Uint8Array(bytes.length)).toString('base64')}
      : {...file},
  );
  const bad = signed({formatVersion: 1, manifest: original.manifest, files});
  await assert.rejects(rebindDsl4AssetBundleReferences(story(edited('removed')), bad, limits), {
    code: 'K4-ASSET-BUNDLE-INTEGRITY-001',
  });
});
