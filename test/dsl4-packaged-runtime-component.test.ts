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
import {thrown} from './helpers/thrown-error.ts';
import {firstDiagnostic, okResult, refusedResult} from './helpers/result-outcome.ts';
import {requireDefined, requireRecord} from './helpers/require-value.ts';

/**
 * The project and component shapes these cases build, install into, and read back.
 *
 * The builder and the loader both take and return their projects opaquely, so the members the
 * cases reach for are named here once instead of at every read.
 */
interface ComponentStorage extends Record<string, unknown> {
  assets?: {files: {data: string}[]};
}

interface Sb3Project extends Record<string, unknown> {
  extensionStorage: Record<string, ComponentStorage>;
  targets: Record<string, unknown>[];
  monitors: unknown[];
}

interface LoadedComponent extends Record<string, unknown> {
  channel: string;
  assetBundlePath: string;
  getAssetFile(assetId: string, filePath: string): Uint8Array;
}

/** Read the runtime component storage a case has just installed into a project. */
function componentStorage(project: Sb3Project): ComponentStorage {
  return requireDefined(
    project.extensionStorage.kubohiroyakamishibairuntime4,
    'the installed runtime component storage',
  );
}

/** Read the project one install produced, which the builder declares opaquely. */
function installedProject(project: unknown): Sb3Project {
  return requireRecord(project, 'the installed project') as unknown as Sb3Project;
}

/** Read one loaded component the case expects the startup loader to have accepted. */
function loadedComponent(result: unknown): LoadedComponent {
  return okResult(result, 'the loaded runtime component') as unknown as LoadedComponent;
}

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

function baseProject(): Sb3Project {
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

function baseSb3(project: Sb3Project = baseProject()) {
  return Buffer.from(
    zipSync({
      'project.json': strToU8(`${JSON.stringify(project)}\n`),
      'existing.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    }),
  );
}

function sri(bytes: Uint8Array) {
  return `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
}

function assetSnapshot() {
  const blobs = new Map([
    ['OpeningImage\0opening.svg', new TextEncoder().encode('<svg/>')],
    ['RescuePose\0metadata.json', new TextEncoder().encode('{"labels":["rescue"]}')],
    ['RescuePose\0model.json', new TextEncoder().encode('{"model":true}')],
  ]);
  const blob = (key: string) => requireDefined(blobs.get(key), `the ${key} fixture blob`);
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
                size: blob('OpeningImage\0opening.svg').length,
                integrity: sri(blob('OpeningImage\0opening.svg')),
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
                size: blob('RescuePose\0metadata.json').length,
                integrity: sri(blob('RescuePose\0metadata.json')),
              },
              {
                path: 'model.json',
                size: blob('RescuePose\0model.json').length,
                integrity: sri(blob('RescuePose\0model.json')),
              },
            ],
          },
        },
      ],
    },
    getFile(assetId: string, filePath: string) {
      return new Uint8Array(blob(`${assetId}\0${filePath}`));
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
    runtimeArtifact: okResult(artifactResult, 'the runtime artifact descriptor').artifact,
    assetBundle,
  };
}

const options = (channel: 'bundled' | 'unbundled', extra: Record<string, unknown> = {}) => ({
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

async function install(
  component: Awaited<ReturnType<typeof fixture>>,
  channel: 'bundled' | 'unbundled',
  project: Sb3Project = baseProject(),
  extra: Record<string, unknown> = {},
): Promise<Sb3Project> {
  return installedProject(
    await installDsl4PackagedRuntimeComponent(
      project,
      component.storyDocument,
      component.sourceDescriptor,
      component.runtimeArtifact,
      component.assetBundle,
      options(channel, extra),
    ),
  );
}

async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof Sb3BuilderError, true);
    assert.equal(thrown(error).code, code);
    return true;
  });
}

test('atomically stores and loads source, artifact, and assets in either channel', async () => {
  const component = await fixture();
  for (const channel of ['unbundled', 'bundled'] as const) {
    const project = baseProject();
    const original = structuredClone(project);
    const installed = await install(component, channel, project);
    assert.deepEqual(project, original);
    assert.deepEqual(installed.targets, original.targets);

    const loaded = loadedComponent(
      await loadDsl4RuntimeComponent(installed, frontend, loadOptions),
    );
    assert.equal(loaded.channel, channel);
    assert.equal(loaded.assetBundlePath, dsl4AssetBundleStoragePaths[channel]);
    assert.deepEqual(loaded.sourceDescriptor, component.sourceDescriptor);
    assert.deepEqual(loaded.runtimeArtifact, component.runtimeArtifact);
    assert.deepEqual(loaded.assetBundle, component.assetBundle);
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(Object.isFrozen(loaded.assetBundle), true);

    const first = loaded.getAssetFile('OpeningImage', 'opening.svg');
    first[0] = requireDefined(first[0], 'the first byte of the copied asset') ^ 0xff;
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
    requireRecord(installed.extensionURLs, 'the installed extension URLs').kubohiroyakamishibai4,
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
  requireDefined(tamperedBundle.files[0], 'the first bundled file').data =
    Buffer.from('<svf/>').toString('base64');
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
  const cases: [Sb3Project, string][] = [];

  const missing = structuredClone(valid);
  delete componentStorage(missing).assets;
  cases.push([missing, 'K4-ASSET-BUNDLE-CHANNEL-MISSING']);

  const mismatch = structuredClone(valid);
  mismatch.extensionStorage.kubohiroyakamishibai4 = {
    components: {
      kubohiroyakamishibairuntime4: {assets: componentStorage(mismatch).assets},
    },
  };
  delete componentStorage(mismatch).assets;
  cases.push([mismatch, 'K4-ASSET-BUNDLE-CHANNEL-MISMATCH']);

  const ambiguous = structuredClone(valid);
  ambiguous.extensionStorage.kubohiroyakamishibai4 = {
    components: {
      kubohiroyakamishibairuntime4: {assets: componentStorage(ambiguous).assets},
    },
  };
  cases.push([ambiguous, 'K4-ASSET-BUNDLE-CHANNEL-AMBIGUOUS']);

  const tampered = structuredClone(valid);
  requireDefined(
    requireDefined(componentStorage(tampered).assets, 'the stored asset bundle').files[0],
    'its first file',
  ).data = Buffer.from('<svf/>').toString('base64');
  cases.push([tampered, 'K4-ASSET-BUNDLE-INTEGRITY-001']);

  for (const [project, code] of cases) {
    const result = await loadDsl4RuntimeComponent(project, frontend, loadOptions);
    const diagnostic = firstDiagnostic(result, 'the withheld component');
    assert.equal(diagnostic.code, code);
    assert.equal(diagnostic.path, '$.assets');
    for (const field of ['sourceDescriptor', 'runtimeArtifact', 'assetBundle', 'getAssetFile']) {
      assert.equal(Object.hasOwn(refusedResult(result, 'the withheld component'), field), false);
    }
  }
});
