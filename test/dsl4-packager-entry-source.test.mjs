import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';

import {
  dsl4PackagerCompatibility,
  dsl4PackagerEntrySourceTemplateContract,
  Dsl4PackagerAdapterError,
  packageDsl4WithTurboWarpPackager,
  resolveDsl4PackagerEntrySourceSurface,
} from '../src/builder/index.js';
import {
  claimDsl4PackagerEntrySource,
  createDsl4BinaryEntryAssetBundle,
  createDsl4BinaryEntryProviderFromPackagerSource,
  createDsl4EmbeddedSourceDescriptor,
  createDsl4RuntimeArtifactDescriptor,
  createDsl4SourceFrontend,
  dsl4PackagerEntrySourceRegistryName,
  Dsl4PackagerEntrySourceError,
} from '../src/dsl4/index.js';
import {
  createDsl4PackagedBinaryRuntimeBridge,
  inspectDsl4PackagedBinaryRuntime,
  resolveDsl4PackagerSessionPolicy,
} from '../src/dsl4/platform/packaged-binary-runtime.js';

const require = createRequire(import.meta.url);
const TurboWarpPackager = require('@turbowarp/packager');
const installedPackager = require('@turbowarp/packager/package.json');
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const subtleCrypto = webcrypto.subtle;
const sourceText = `
kamishibai: '4.0'
assets:
  Project: backdrop
  Pose:
    kind: poseModel
    file: models/pose
    loading: eager
controls:
  keymaps:
    development:
      Space: navigation.nextAction
    production:
      Space: navigation.nextAction
scenes:
  opening: []
`;
const limits = Object.freeze({
  maxArchiveBytes: 4 * 1024 * 1024,
  maxArchiveEntries: 64,
  maxArchiveEntryBytes: 512 * 1024,
  maxArchiveExpandedBytes: 2 * 1024 * 1024,
  maxAssetFiles: 8,
  maxAssetFileBytes: 64 * 1024,
  maxAssetBytes: 128 * 1024,
  maxCompressionRatio: 100,
  subtleCrypto,
});

function sri(bytes) {
  return `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
}

function fixtureSnapshot() {
  const model = new TextEncoder().encode('{"modelTopology":{"class_name":"Model"}}');
  const metadata = new TextEncoder().encode('{"labels":["rescue"]}');
  const weights = Uint8Array.from({length: 1024}, (_, index) => (index * 67 + 19) % 251);
  const files = new Map([
    ['Pose\0metadata.json', metadata],
    ['Pose\0model.json', model],
    ['Pose\0weights.bin', weights],
  ]);
  return {
    manifest: {
      formatVersion: 1,
      assets: [
        {
          id: 'Pose',
          kind: 'poseModel',
          loading: 'eager',
          source: {
            type: 'file',
            inputPath: 'models/pose',
            mode: 'directory',
            files: [
              {path: 'metadata.json', size: metadata.length, integrity: sri(metadata)},
              {path: 'model.json', size: model.length, integrity: sri(model)},
              {path: 'weights.bin', size: weights.length, integrity: sri(weights)},
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
      return new Uint8Array(files.get(`${assetId}\0${filePath}`));
    },
  };
}

function baseProject(descriptor, source, artifact) {
  return {
    extensionStorage: {
      kubohiroyakamishibai4: {
        components: {kubohiroyakamishibairuntime4: {artifact, assets: descriptor, source}},
      },
    },
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        comments: {},
        currentCostume: 0,
        costumes: [],
        sounds: [],
        volume: 100,
        layerOrder: 0,
        tempo: 60,
        videoTransparency: 50,
        videoState: 'on',
        textToSpeechLanguage: null,
      },
    ],
    monitors: [],
    extensions: [],
    meta: {semver: '3.0.0', vm: '11.3.0', agent: 'tmpose-kamishibai test'},
  };
}

async function fixture() {
  const parsed = frontend.parse(sourceText, {sourceId: 'main'});
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const snapshot = fixtureSnapshot();
  const binaryBundle = await createDsl4BinaryEntryAssetBundle(parsed.storyDocument, snapshot, {
    maxFiles: limits.maxAssetFiles,
    maxFileBytes: limits.maxAssetFileBytes,
    maxTotalBytes: limits.maxAssetBytes,
    subtleCrypto,
  });
  const source = await createDsl4EmbeddedSourceDescriptor(sourceText, {
    sourceId: 'main',
    displayName: 'story.k4.yml',
    maxSourceBytes: 64 * 1024,
    subtleCrypto,
  });
  const artifactResult = await createDsl4RuntimeArtifactDescriptor(
    parsed.storyDocument,
    source,
    'production',
    {maxSourceBytes: 64 * 1024, subtleCrypto},
  );
  assert.equal(artifactResult.ok, true, JSON.stringify(artifactResult.diagnostics));
  const project = baseProject(binaryBundle.descriptor, source, artifactResult.artifact);
  const archive = {'project.json': strToU8(`${JSON.stringify(project)}\n`)};
  for (const entryName of binaryBundle.entryNames) {
    archive[entryName] = binaryBundle.getEntry(entryName);
  }
  const input = zipSync(archive, {level: 6});
  const loadedProject = await TurboWarpPackager.loadProject(input);
  assert.equal(loadedProject.type, 'sb3');
  return {
    binaryBundle,
    input,
    loadedProject,
    project,
    snapshot,
    storyDocument: parsed.storyDocument,
  };
}

function configuredPackager(loadedProject, target) {
  const packager = new TurboWarpPackager.Packager();
  packager.project = loadedProject;
  packager.options.target = target;
  packager.options.autoplay = true;
  packager.options.cloudVariables.mode = 'disabled';
  packager.options.bakeExtensions = false;
  packager.options.custom.js = 'globalThis.__packagerUserScriptRan = true;';
  return packager;
}

function htmlFromResult(result, target) {
  if (target === 'html') return new TextDecoder().decode(result.data);
  return strFromU8(unzipSync(result.data)['index.html']);
}

function fakeZip(archive) {
  const files = Object.fromEntries(
    Object.entries(archive).map(([name]) => [name, {name, dir: false}]),
  );
  return {
    files,
    file(name) {
      const bytes = archive[name];
      if (!bytes) return null;
      return {
        dir: false,
        async(type) {
          assert.equal(type, 'uint8array');
          return Promise.resolve(new Uint8Array(bytes));
        },
      };
    },
  };
}

async function packageFixture(fixtureValue, target) {
  const packager = configuredPackager(fixtureValue.loadedProject, target);
  const result = await packageDsl4WithTurboWarpPackager({
    packager,
    packagerPackage: installedPackager,
    storyDocument: fixtureValue.storyDocument,
    descriptor: fixtureValue.binaryBundle.descriptor,
    limits,
  });
  return {packager, result};
}

test('pins the audited TurboWarp Packager release and maps each supported surface', () => {
  assert.equal(installedPackager.name, dsl4PackagerCompatibility.package);
  assert.equal(installedPackager.version, dsl4PackagerCompatibility.version);
  assert.equal(dsl4PackagerCompatibility.commit, 'ca5decb80e8870160425e84f0b6c575879bc6dd0');
  assert.deepEqual(resolveDsl4PackagerEntrySourceSurface('html'), {
    id: 'plain-html',
    mode: 'archive',
  });
  assert.deepEqual(resolveDsl4PackagerEntrySourceSurface('zip-one-asset'), {
    id: 'zip-one-asset',
    mode: 'archive',
  });
  assert.deepEqual(resolveDsl4PackagerEntrySourceSurface('zip'), {id: 'zip', mode: 'direct'});
  assert.deepEqual(resolveDsl4PackagerEntrySourceSurface('electron-linux64'), {
    id: 'electron',
    mode: 'direct',
  });
  assert.throws(() => resolveDsl4PackagerEntrySourceSurface('nwjs-linux-x64'), TypeError);
  assert.deepEqual(resolveDsl4PackagerSessionPolicy('plain-html'), {
    policy: 'prefer',
    sessionBackingEnabled: true,
  });
  assert.deepEqual(resolveDsl4PackagerSessionPolicy('zip-one-asset'), {
    policy: 'prefer',
    sessionBackingEnabled: true,
  });
  assert.deepEqual(resolveDsl4PackagerSessionPolicy('zip'), {
    policy: 'disabled',
    sessionBackingEnabled: false,
  });
  assert.deepEqual(resolveDsl4PackagerSessionPolicy('electron'), {
    policy: 'disabled',
    sessionBackingEnabled: false,
  });
  assert.throws(() => resolveDsl4PackagerSessionPolicy('editor'), TypeError);
});

test('registers the actual Plain HTML and zip-one-asset ZIP closure before loadProject', async () => {
  const value = await fixture();
  for (const target of ['html', 'zip-one-asset']) {
    const {packager, result} = await packageFixture(value, target);
    const html = htmlFromResult(result, target);
    const attach = dsl4PackagerEntrySourceTemplateContract.packagerEntrySourceAttach;
    assert.equal(html.includes(dsl4PackagerEntrySourceTemplateContract.bootstrapMarker), true);
    assert.equal(packager.options.custom.js.includes('__packagerUserScriptRan'), true);
    assert.equal(
      packager.options.custom.js.indexOf(dsl4PackagerEntrySourceTemplateContract.bootstrapMarker) <
        packager.options.custom.js.indexOf('__packagerUserScriptRan'),
      true,
    );
    assert.equal(html.indexOf(attach) > html.indexOf('Scaffolding.JSZip.loadAsync(data)'), true);
    assert.equal(html.indexOf(attach) < html.indexOf("findFileInZip('project.json')"), true);
    assert.equal(
      html.indexOf(attach) < html.indexOf('await scaffolding.loadProject(projectData)'),
      true,
    );
    const embeddedRuntime =
      target === 'html' ? html : strFromU8(unzipSync(result.data)['script.js']);
    assert.equal(embeddedRuntime.includes('willReadFrequently'), false);
    if (target === 'zip-one-asset') {
      const outer = unzipSync(result.data);
      const inner = unzipSync(outer['project.zip']);
      for (const entryName of value.binaryBundle.entryNames) {
        assert.deepEqual(inner[entryName], value.binaryBundle.getEntry(entryName));
      }
    }
  }
});

test('keeps normal ZIP entries individually addressable and declares Electron direct mode', async () => {
  const value = await fixture();
  const {packager, result} = await packageFixture(value, 'zip');
  const output = unzipSync(result.data);
  const html = strFromU8(output['index.html']);
  assert.equal(html.includes(dsl4PackagerEntrySourceTemplateContract.bootstrapMarker), true);
  assert.equal(
    html.includes(dsl4PackagerEntrySourceTemplateContract.packagerEntrySourceAttach),
    false,
  );
  for (const entryName of value.binaryBundle.entryNames) {
    assert.deepEqual(output[`assets/${entryName}`], value.binaryBundle.getEntry(entryName));
  }
  assert.equal(packager.options.custom.js.includes('"surface":"zip","mode":"direct"'), true);
});

test('claims the generated archive source and replays the three-file pose model until release', async () => {
  const value = await fixture();
  const {packager} = await packageFixture(value, 'html');
  const context = vm.createContext({});
  vm.runInContext(packager.options.custom.js, context);
  assert.equal(context.__packagerUserScriptRan, true);
  const registry = context[Symbol.for(dsl4PackagerEntrySourceRegistryName)];
  const normalizedArchive = unzipSync(new Uint8Array(value.loadedProject.arrayBuffer));
  registry.attachZip(fakeZip(normalizedArchive));
  const source = claimDsl4PackagerEntrySource({globalObject: context});
  assert.equal(context[Symbol.for(dsl4PackagerEntrySourceRegistryName)], undefined);
  const provider = await createDsl4BinaryEntryProviderFromPackagerSource(
    value.storyDocument,
    value.binaryBundle.descriptor,
    source,
    limits,
  );
  const firstRead = await provider.readAsset('Pose');
  firstRead.files[0].bytes[0] ^= 0xff;
  const pose = await provider.readAsset('Pose');
  assert.deepEqual(
    pose.files.map(({path: filePath}) => filePath),
    ['metadata.json', 'model.json', 'weights.bin'],
  );
  for (const file of pose.files) {
    assert.deepEqual(file.bytes, value.snapshot.getFile('Pose', file.path));
  }
  assert.equal(provider.remainingAssetCount, 1);
  await provider.consumeAsset('Pose');
  assert.equal(provider.remainingAssetCount, 0);
  assert.equal(provider.released, false, 'the source is retained until the policy releases it');
  await provider.release();
  assert.equal(source.released, true);
});

test('claims a direct source without IndexedDB or a second SB3 fetch', async () => {
  const value = await fixture();
  const {packager} = await packageFixture(value, 'zip');
  const requests = [];
  const context = vm.createContext({
    URL,
    location: new URL('https://example.test/story/index.html'),
    async fetch(url, options) {
      requests.push({url: String(url), options});
      const entryName = decodeURIComponent(new URL(url).pathname.split('/').pop());
      const bytes = value.binaryBundle.getEntry(entryName);
      return {
        ok: true,
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      };
    },
  });
  vm.runInContext(packager.options.custom.js, context);
  const source = claimDsl4PackagerEntrySource({globalObject: context});
  const provider = await createDsl4BinaryEntryProviderFromPackagerSource(
    value.storyDocument,
    value.binaryBundle.descriptor,
    source,
    limits,
  );
  const pose = await provider.consumeAsset('Pose');
  assert.equal(pose.files.length, 3);
  assert.equal(requests.length, 3);
  assert.equal(
    requests.every(({url}) => url.includes('/story/assets/k4asset-v1-')),
    true,
  );
  assert.equal(
    requests.every(({options}) => options.cache === 'no-store'),
    true,
  );
  await provider.release();
});

test('connects the packaged Runtime 4 bridge to archive and direct providers', async () => {
  const value = await fixture();
  assert.deepEqual(inspectDsl4PackagedBinaryRuntime(value.project), {formatVersion: 3});
  for (const target of ['html', 'zip']) {
    const {packager} = await packageFixture(value, target);
    const contextValues = {};
    if (target === 'zip') {
      Object.assign(contextValues, {
        URL,
        location: new URL('https://example.test/story/index.html'),
        async fetch(url) {
          const entryName = decodeURIComponent(new URL(url).pathname.split('/').pop());
          const bytes = value.binaryBundle.getEntry(entryName);
          return {
            ok: true,
            async arrayBuffer() {
              return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            },
          };
        },
      });
    }
    const context = vm.createContext(contextValues);
    vm.runInContext(packager.options.custom.js, context);
    if (target === 'html') {
      const registry = context[Symbol.for(dsl4PackagerEntrySourceRegistryName)];
      const normalizedArchive = unzipSync(new Uint8Array(value.loadedProject.arrayBuffer));
      registry.attachZip(fakeZip(normalizedArchive));
    }
    const bridge = await createDsl4PackagedBinaryRuntimeBridge({
      project: value.project,
      sourceFrontend: frontend,
      maxSourceBytes: 64 * 1024,
      maxAssetFiles: 8,
      maxAssetBytes: 128 * 1024,
      globalObject: context,
      subtleCrypto,
    });
    assert(bridge);
    assert.equal(bridge.assetBundleFormat, 'binary-entry');
    assert.deepEqual(bridge.runtimeLimits, {
      maxAssetFiles: 8,
      maxAssetFileBytes: 128 * 1024,
      maxAssetBytes: 128 * 1024,
    });
    assert.equal(bridge.surface, target === 'html' ? 'plain-html' : 'zip');
    assert.deepEqual(bridge.sessionBacking, {
      policy: target === 'html' ? 'prefer' : 'disabled',
    });
    assert.equal(bridge.sessionBackingEnabled, target === 'html');
    const pose = await bridge.binaryEntryProvider.readAsset('Pose');
    assert.deepEqual(
      pose.files.map(({path: filePath}) => filePath),
      ['metadata.json', 'model.json', 'weights.bin'],
    );
    await bridge.binaryEntryProvider.release();
  }
});

test('keeps the Base64 rollback project outside the Packager entry source bridge', async () => {
  const value = await fixture();
  const base64Project = structuredClone(value.project);
  base64Project.extensionStorage.kubohiroyakamishibai4.components.kubohiroyakamishibairuntime4.assets =
    {formatVersion: 1};
  assert.equal(inspectDsl4PackagedBinaryRuntime(base64Project), null);
  assert.equal(
    await createDsl4PackagedBinaryRuntimeBridge({
      project: base64Project,
      sourceFrontend: frontend,
      maxSourceBytes: 64 * 1024,
      maxAssetFiles: 8,
      maxAssetBytes: 128 * 1024,
      globalObject: {},
      subtleCrypto,
    }),
    null,
  );
});

test('fails closed for template drift, incompatible releases, and source mismatch', async () => {
  const value = await fixture();
  const drifted = configuredPackager(value.loadedProject, 'html');
  drifted.package = async () => ({
    data: new TextEncoder().encode('<!doctype html><script>scaffolding.loadProject()</script>'),
    type: 'text/html',
    filename: 'index.html',
  });
  await assert.rejects(
    packageDsl4WithTurboWarpPackager({
      packager: drifted,
      packagerPackage: installedPackager,
      storyDocument: value.storyDocument,
      descriptor: value.binaryBundle.descriptor,
      limits,
    }),
    (error) => {
      assert.equal(error instanceof Dsl4PackagerAdapterError, true);
      assert.equal(error.code, 'K4-PACKAGER-TEMPLATE-001');
      return true;
    },
  );
  const incompatible = configuredPackager(value.loadedProject, 'html');
  await assert.rejects(
    packageDsl4WithTurboWarpPackager({
      packager: incompatible,
      packagerPackage: {...installedPackager, version: '3.13.1'},
      storyDocument: value.storyDocument,
      descriptor: value.binaryBundle.descriptor,
      limits,
    }),
    (error) => {
      assert.equal(error.code, 'K4-PACKAGER-COMPATIBILITY-001');
      return true;
    },
  );

  const {packager} = await packageFixture(value, 'html');
  const context = vm.createContext({});
  vm.runInContext(packager.options.custom.js, context);
  const registry = context[Symbol.for(dsl4PackagerEntrySourceRegistryName)];
  const normalizedArchive = unzipSync(new Uint8Array(value.loadedProject.arrayBuffer));
  const extra = {
    ...normalizedArchive,
    [`k4asset-v1-${'f'.repeat(64)}`]: strToU8('extra'),
  };
  assert.throws(
    () => registry.attachZip(fakeZip(extra)),
    (error) => {
      assert.equal(error.code, 'K4-ASSET-ENTRY-MANIFEST-001');
      return true;
    },
  );
  registry.attachZip(fakeZip(normalizedArchive));
  const source = claimDsl4PackagerEntrySource({globalObject: context});
  const mismatched = {
    ...source,
    entries: source.entries.map((entry, index) =>
      index === 0 ? {...entry, uncompressedSize: entry.uncompressedSize + 1} : entry,
    ),
  };
  await assert.rejects(
    createDsl4BinaryEntryProviderFromPackagerSource(
      value.storyDocument,
      value.binaryBundle.descriptor,
      mismatched,
      limits,
    ),
    (error) => {
      assert.equal(error instanceof Dsl4PackagerEntrySourceError, true);
      assert.equal(error.code, 'K4-ASSET-ENTRY-SIZE-001');
      return true;
    },
  );
  assert.equal(source.released, true);
});
