import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {strToU8, zipSync} from 'fflate';

import {
  dsl4BrowserRuntimeComponentMaximums,
  Dsl4BrowserRuntimeComponentError,
  loadDsl4BrowserRuntimeComponent,
  installDsl4PackagedRuntimeComponent,
} from '../src/builder/index.js';
import {
  createDsl4EmbeddedAssetBundle,
  createDsl4EmbeddedSourceDescriptor,
  createDsl4RuntimeArtifactDescriptor,
  createDsl4SourceFrontend,
} from '../src/dsl4/index.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const subtleCrypto = webcrypto.subtle;
const limits = {maxSourceBytes: 16_384, maxAssetFiles: 16, maxAssetBytes: 65_536};
const source = `
kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening: []
`;

function baseProject() {
  return {
    extensionStorage: {},
    targets: [{isStage: true, name: 'Stage', blocks: {}}],
    monitors: [],
  };
}

/** @param {unknown} project @param {Record<string, Uint8Array>} [extra] */
function sb3(project, extra = {}) {
  return new Uint8Array(
    zipSync({
      'project.json': strToU8(JSON.stringify(project)),
      ...extra,
    }),
  );
}

async function packagedProject() {
  const parsed = frontend.parse(source, {sourceId: 'main'});
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const sourceDescriptor = await createDsl4EmbeddedSourceDescriptor(source, {
    sourceId: 'main',
    displayName: 'story.k4.yml',
    maxSourceBytes: limits.maxSourceBytes,
    subtleCrypto,
  });
  const artifact = await createDsl4RuntimeArtifactDescriptor(
    parsed.storyDocument,
    sourceDescriptor,
    'production',
    {maxSourceBytes: limits.maxSourceBytes, subtleCrypto},
  );
  assert.equal(artifact.ok, true, JSON.stringify(artifact.diagnostics));
  const assets = await createDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    {manifest: {formatVersion: 1, assets: []}, getFile() {}},
    {maxFiles: limits.maxAssetFiles, maxTotalBytes: limits.maxAssetBytes, subtleCrypto},
  );
  return installDsl4PackagedRuntimeComponent(
    baseProject(),
    parsed.storyDocument,
    sourceDescriptor,
    artifact.artifact,
    assets,
    {channel: 'unbundled', ...limits, subtleCrypto},
  );
}

/** @param {Uint8Array} projectBytes @param {Record<string, unknown>} [extra] */
function loadOptions(projectBytes, extra = {}) {
  return {
    projectBytes,
    sourceFrontend: frontend,
    ...limits,
    subtleCrypto,
    ...extra,
  };
}

test('loads one immutable base runtime component without accepting a generation source', async () => {
  const project = await packagedProject();
  const bytes = sb3(project, {'asset.svg': strToU8('<svg/>')});
  let parseCount = 0;
  const pending = loadDsl4BrowserRuntimeComponent({
    ...loadOptions(bytes),
    sourceFrontend: {
      parse(text, options) {
        parseCount += 1;
        return frontend.parse(text, options);
      },
    },
  });
  bytes.fill(0);
  const loaded = await pending;

  assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
  assert.equal(loaded.channel, 'unbundled');
  assert.equal(loaded.storyDocument.metadata.sourceId, 'main');
  assert.equal(loaded.sourceDescriptor.displayName, 'story.k4.yml');
  assert.equal(parseCount, 1);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.hasOwn(loaded, 'generation'), false);
});

test('enforces compressed, entry-count, and project.json expansion limits before loading', async () => {
  const project = await packagedProject();
  const projectJson = strToU8(JSON.stringify(project));
  const bytes = sb3(project, {'asset.svg': strToU8('<svg/>')});
  await assert.rejects(
    loadDsl4BrowserRuntimeComponent(loadOptions(bytes, {maxProjectBytes: bytes.length - 1})),
    (error) =>
      error instanceof Dsl4BrowserRuntimeComponentError &&
      error.code === 'K4-PREVIEW-PROJECT-LIMIT-001',
  );
  await assert.rejects(
    loadDsl4BrowserRuntimeComponent(loadOptions(bytes, {maxArchiveEntries: 1})),
    (error) =>
      error instanceof Dsl4BrowserRuntimeComponentError &&
      error.code === 'K4-PREVIEW-PROJECT-LIMIT-001',
  );
  await assert.rejects(
    loadDsl4BrowserRuntimeComponent(
      loadOptions(bytes, {maxProjectJsonBytes: projectJson.length - 1}),
    ),
    (error) =>
      error instanceof Dsl4BrowserRuntimeComponentError &&
      error.code === 'K4-PREVIEW-PROJECT-LIMIT-001',
  );
  await assert.rejects(
    loadDsl4BrowserRuntimeComponent(
      loadOptions(bytes, {
        maxArchiveEntries: dsl4BrowserRuntimeComponentMaximums.maxArchiveEntries + 1,
      }),
    ),
    /maxArchiveEntries/u,
  );
});

test('rejects malformed archive, path, UTF-8, JSON, and project shapes without partial output', async () => {
  const cases = [
    {
      bytes: new Uint8Array([1, 2, 3]),
      code: 'K4-PREVIEW-PROJECT-ARCHIVE-001',
    },
    {
      bytes: new Uint8Array(zipSync({'asset.svg': strToU8('<svg/>')})),
      code: 'K4-PREVIEW-PROJECT-ARCHIVE-001',
    },
    {
      bytes: new Uint8Array(
        zipSync({
          'project.json': strToU8(JSON.stringify(baseProject())),
          '../escape': Uint8Array.of(1),
        }),
      ),
      code: 'K4-PREVIEW-PROJECT-PATH-001',
    },
    {
      bytes: new Uint8Array(zipSync({'project.json': Uint8Array.of(0xc3, 0x28)})),
      code: 'K4-PREVIEW-PROJECT-UTF8-001',
    },
    {
      bytes: new Uint8Array(zipSync({'project.json': strToU8('{')})),
      code: 'K4-PREVIEW-PROJECT-JSON-001',
    },
    {
      bytes: new Uint8Array(zipSync({'project.json': strToU8('[]')})),
      code: 'K4-PREVIEW-PROJECT-JSON-001',
    },
    {
      bytes: new Uint8Array(zipSync({'project.json': strToU8('{}')})),
      code: 'K4-PREVIEW-PROJECT-JSON-001',
    },
  ];
  for (const fixture of cases) {
    await assert.rejects(
      loadDsl4BrowserRuntimeComponent(loadOptions(fixture.bytes)),
      (error) => error instanceof Dsl4BrowserRuntimeComponentError && error.code === fixture.code,
    );
  }
});

test('returns canonical component diagnostics instead of a partial base component', async () => {
  const loaded = await loadDsl4BrowserRuntimeComponent(loadOptions(sb3(baseProject())));
  assert.equal(loaded.ok, false);
  assert.equal(loaded.diagnostics[0].code, 'K4-SOURCE-CHANNEL-MISSING');
  assert.equal(Object.hasOwn(loaded, 'storyDocument'), false);
});
