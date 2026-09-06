import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'vitest';
import {fileURLToPath} from 'node:url';

import {strToU8, unzipSync, zipSync} from 'fflate';

import {
  embedDsl4PackagedRuntimeComponentInSb3,
  installDsl4PackagedRuntimeComponent,
  installDsl4RuntimeComponent,
  Sb3BuilderError,
} from '../src/builder/index.js';
import {
  createDsl4EmbeddedAssetBundle,
  createDsl4EmbeddedSourceDescriptor,
  createDsl4RuntimeArtifactDescriptor,
  createDsl4SourceFrontend,
  dsl4AssetBundleStoragePaths,
  loadDsl4RuntimeComponent,
} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);
const subtleCrypto = webcrypto.subtle;
const maxSourceBytes = 8192;
const maxAssetFiles = 10;
const maxAssetBytes = 4096;
const sourceText = `
kamishibai: '4.0'
assets:
  ProjectBackdrop: backdrop
  OpeningImage:
    kind: backdrop
    file: assets/opening.svg
    loading: lazy
  RescuePose:
    kind: recognitionModel
    file: pose-models/rescue
controls:
  keymaps:
    development:
      ArrowUp: history.previousScene
      Space: navigation.nextAction
    production:
      Space: navigation.nextAction
scenes:
  opening: []
`;

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

function baseSb3(project = baseProject()) {
  return Buffer.from(
    zipSync({
      'project.json': strToU8(`${JSON.stringify(project)}\n`),
      'existing.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    }),
  );
}

function sri(bytes) {
  return `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
}

function assetSnapshot() {
  const blobs = new Map([
    ['OpeningImage\0opening.svg', new TextEncoder().encode('<svg/>')],
    ['RescuePose\0metadata.json', new TextEncoder().encode('{"labels":["rescue"]}')],
    ['RescuePose\0model.json', new TextEncoder().encode('{"model":true}')],
  ]);
  return {
    manifest: {
      formatVersion: 1,
      assets: [
        {
          id: 'OpeningImage',
          kind: 'backdrop',
          loading: 'lazy',
          source: {
            type: 'file',
            inputPath: 'assets/opening.svg',
            mode: 'file',
            files: [
              {
                path: 'opening.svg',
                size: blobs.get('OpeningImage\0opening.svg').length,
                integrity: sri(blobs.get('OpeningImage\0opening.svg')),
              },
            ],
          },
        },
        {
          id: 'ProjectBackdrop',
          kind: 'backdrop',
          loading: 'eager',
          source: {type: 'project', name: 'ProjectBackdrop'},
        },
        {
          id: 'RescuePose',
          kind: 'recognitionModel',
          loading: 'eager',
          source: {
            type: 'file',
            inputPath: 'pose-models/rescue',
            mode: 'directory',
            files: [
              {
                path: 'metadata.json',
                size: blobs.get('RescuePose\0metadata.json').length,
                integrity: sri(blobs.get('RescuePose\0metadata.json')),
              },
              {
                path: 'model.json',
                size: blobs.get('RescuePose\0model.json').length,
                integrity: sri(blobs.get('RescuePose\0model.json')),
              },
            ],
          },
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
  const artifactResult = await createDsl4RuntimeArtifactDescriptor(
    parsed.storyDocument,
    sourceDescriptor,
    'production',
    {maxSourceBytes, subtleCrypto},
  );
  assert.equal(artifactResult.ok, true, JSON.stringify(artifactResult.diagnostics));
  const assetBundle = await createDsl4EmbeddedAssetBundle(parsed.storyDocument, assetSnapshot(), {
    maxFiles: maxAssetFiles,
    maxTotalBytes: maxAssetBytes,
    subtleCrypto,
  });
  return {
    storyDocument: parsed.storyDocument,
    sourceDescriptor,
    runtimeArtifact: artifactResult.artifact,
    assetBundle,
  };
}

const options = (channel, extra = {}) => ({
  channel,
  maxSourceBytes,
  maxAssetFiles,
  maxAssetBytes,
  subtleCrypto,
  ...extra,
});

const loadOptions = {
  maxSourceBytes,
  maxAssetFiles,
  maxAssetBytes,
  subtleCrypto,
};

async function install(component, channel, project = baseProject(), extra = {}) {
  return installDsl4PackagedRuntimeComponent(
    project,
    component.storyDocument,
    component.sourceDescriptor,
    component.runtimeArtifact,
    component.assetBundle,
    options(channel, extra),
  );
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof Sb3BuilderError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test('atomically stores and loads source, artifact, and assets in either channel', async () => {
  const component = await fixture();
  for (const channel of ['unbundled', 'bundled']) {
    const project = baseProject();
    const original = structuredClone(project);
    const installed = await install(component, channel, project);
    assert.deepEqual(project, original);
    assert.deepEqual(installed.targets, original.targets);

    const loaded = await loadDsl4RuntimeComponent(installed, frontend, loadOptions);
    assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
    assert.equal(loaded.channel, channel);
    assert.equal(loaded.assetBundlePath, dsl4AssetBundleStoragePaths[channel]);
    assert.deepEqual(loaded.sourceDescriptor, component.sourceDescriptor);
    assert.deepEqual(loaded.runtimeArtifact, component.runtimeArtifact);
    assert.deepEqual(loaded.assetBundle, component.assetBundle);
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(Object.isFrozen(loaded.assetBundle), true);

    const first = loaded.getAssetFile('OpeningImage', 'opening.svg');
    first[0] ^= 0xff;
    assert.deepEqual(
      loaded.getAssetFile('OpeningImage', 'opening.svg'),
      new TextEncoder().encode('<svg/>'),
    );
  }
});

test('replaces the Standard authoring extension with an explicit playback runtime', async () => {
  const component = await fixture();
  const project = baseProject();
  project.extensions = ['kubohiroyakamishibai4'];
  project.extensionURLs = {
    kubohiroyakamishibai4: 'data:text/javascript;base64,YXV0aG9yaW5n',
  };
  const original = structuredClone(project);
  const runtimeExtensionSource =
    '// Name: Kamishibai DSL 4.0 Runtime\n' +
    '// ID: kubohiroyakamishibai4\n' +
    'console.log("playback");\n';
  const installed = await install(component, 'bundled', project, {runtimeExtensionSource});
  assert.deepEqual(project, original);
  assert.equal(
    installed.extensionURLs.kubohiroyakamishibai4,
    `data:text/javascript;base64,${Buffer.from(runtimeExtensionSource).toString('base64')}`,
  );
});

test('rejects partial, opposite-channel, unauthorized, and mixed-mode replacement', async () => {
  const component = await fixture();
  const partial = baseProject();
  partial.extensionStorage.kubohiroyakamishibairuntime4 = {
    source: component.sourceDescriptor,
    artifact: component.runtimeArtifact,
  };
  await rejectsCode(
    install(component, 'unbundled', partial, {replaceExisting: true}),
    'K4-RUNTIME-COMPONENT-PARTIAL',
  );

  const installed = await install(component, 'unbundled');
  await rejectsCode(
    install(component, 'unbundled', installed),
    'K4-RUNTIME-COMPONENT-STORAGE-EXISTS',
  );
  assert.deepEqual(
    await install(component, 'unbundled', installed, {replaceExisting: true}),
    installed,
  );
  await rejectsCode(
    install(component, 'bundled', installed, {replaceExisting: true}),
    'K4-RUNTIME-COMPONENT-CHANNEL-AMBIGUOUS',
  );
  await rejectsCode(
    installDsl4RuntimeComponent(
      installed,
      component.storyDocument,
      component.sourceDescriptor,
      component.runtimeArtifact,
      options('unbundled', {replaceExisting: true}),
    ),
    'K4-RUNTIME-COMPONENT-ASSET-MODE-001',
  );

  const tamperedBundle = structuredClone(component.assetBundle);
  tamperedBundle.files[0].data = Buffer.from('<svf/>').toString('base64');
  await rejectsCode(
    installDsl4PackagedRuntimeComponent(
      baseProject(),
      component.storyDocument,
      component.sourceDescriptor,
      component.runtimeArtifact,
      tamperedBundle,
      options('unbundled'),
    ),
    'K4-ASSET-BUNDLE-INTEGRITY-001',
  );
});

test('repackages a complete component deterministically without changing graph or ZIP assets', async () => {
  const component = await fixture();
  const input = baseSb3();
  const inputCopy = Buffer.from(input);
  const first = await embedDsl4PackagedRuntimeComponentInSb3(
    input,
    component.storyDocument,
    component.sourceDescriptor,
    component.runtimeArtifact,
    component.assetBundle,
    options('bundled'),
  );
  const second = await embedDsl4PackagedRuntimeComponentInSb3(
    input,
    component.storyDocument,
    component.sourceDescriptor,
    component.runtimeArtifact,
    component.assetBundle,
    options('bundled'),
  );
  assert.deepEqual(input, inputCopy);
  assert.deepEqual(first.bytes, second.bytes);
  assert.deepEqual(first.project.targets, baseProject().targets);
  assert.deepEqual(unzipSync(first.bytes)['existing.svg'], unzipSync(input)['existing.svg']);
});

test('startup loader withholds the whole component for missing, ambiguous, mismatched, or tampered assets', async () => {
  const component = await fixture();
  const valid = await install(component, 'unbundled');
  const cases = [];

  const missing = structuredClone(valid);
  delete missing.extensionStorage.kubohiroyakamishibairuntime4.assets;
  cases.push([missing, 'K4-ASSET-BUNDLE-CHANNEL-MISSING']);

  const mismatch = structuredClone(valid);
  mismatch.extensionStorage.kubohiroyakamishibai4 = {
    components: {
      kubohiroyakamishibairuntime4: {
        assets: mismatch.extensionStorage.kubohiroyakamishibairuntime4.assets,
      },
    },
  };
  delete mismatch.extensionStorage.kubohiroyakamishibairuntime4.assets;
  cases.push([mismatch, 'K4-ASSET-BUNDLE-CHANNEL-MISMATCH']);

  const ambiguous = structuredClone(valid);
  ambiguous.extensionStorage.kubohiroyakamishibai4 = {
    components: {
      kubohiroyakamishibairuntime4: {
        assets: ambiguous.extensionStorage.kubohiroyakamishibairuntime4.assets,
      },
    },
  };
  cases.push([ambiguous, 'K4-ASSET-BUNDLE-CHANNEL-AMBIGUOUS']);

  const tampered = structuredClone(valid);
  tampered.extensionStorage.kubohiroyakamishibairuntime4.assets.files[0].data =
    Buffer.from('<svf/>').toString('base64');
  cases.push([tampered, 'K4-ASSET-BUNDLE-INTEGRITY-001']);

  for (const [project, code] of cases) {
    const loaded = await loadDsl4RuntimeComponent(project, frontend, loadOptions);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.diagnostics[0].code, code);
    assert.equal(loaded.diagnostics[0].path, '$.assets');
    for (const field of ['sourceDescriptor', 'runtimeArtifact', 'assetBundle', 'getAssetFile']) {
      assert.equal(Object.hasOwn(loaded, field), false);
    }
  }
});
