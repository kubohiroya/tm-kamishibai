import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'vitest';

import {strFromU8, strToU8, unzipSync} from 'fflate';

import {createDsl4ProductionSourceFrontend} from '../src/builder/dsl4-source-frontend.js';
import {createDsl4EmbeddedAssetBundle} from '../src/dsl4/asset-bundle-descriptor.js';
import {
  createDsl4BrowserDistributionFilename,
  createDsl4BrowserDistributionSb3,
  downloadDsl4BrowserDistributionSb3,
  requestDsl4BrowserDistributionSaveTarget,
  saveDsl4BrowserDistributionSb3,
} from '../src/dsl4/platform/browser-distribution-build.js';
import {createDsl4RuntimeApplicationMenu} from '../src/dsl4/platform/runtime-application-menu.js';
import {createDsl4RuntimeArtifactDescriptor} from '../src/dsl4/runtime-artifact-descriptor.js';
import {loadDsl4RuntimeComponent} from '../src/dsl4/runtime-artifact-loader.js';
import {createDsl4EmbeddedSourceDescriptor} from '../src/dsl4/source-descriptor.js';
import {
  createFakeDocument,
  findByAttribute,
  requireFakeElement,
  requireFirst,
} from './helpers/fake-dom.ts';
import {okResult} from './helpers/result-outcome.ts';
import {requireDefined} from './helpers/require-value.ts';

/**
 * The project shapes these cases build and read back.
 *
 * The builder takes and returns the open project opaquely -- it is parsed JSON on both sides -- so
 * the members the cases reach for are named here once.
 */
interface MenuStorage extends Record<string, unknown> {
  retained?: string;
  components?: {
    kubohiroyakamishibairuntime4?: {application?: {mode?: string}; source?: unknown};
  };
}

interface DistributionProject {
  targets: {isStage?: boolean; name?: string; variables?: Record<string, [string, unknown]>}[];
  monitors: {id: string; params: {VARIABLE: string}; visible: boolean}[];
  extensions?: string[];
  extensionStorage: Record<string, MenuStorage>;
}

/** Read the runtime component storage the builder rewrote in a built project. */
function componentStorage(project: DistributionProject) {
  return requireDefined(
    requireDefined(project.extensionStorage.kubohiroyakamishibai4, 'the extension storage')
      .components,
    'its components',
  ).kubohiroyakamishibairuntime4;
}

const maxSourceBytes = 64 * 1024;
const maxAssetFiles = 64;
const maxAssetBytes = 64 * 1024 * 1024;
const schema = JSON.parse(
  await readFile(new URL('../schema/dsl-4.schema.json', import.meta.url), 'utf8'),
);
const frontend = createDsl4ProductionSourceFrontend(schema);
const source = `kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    actions:
      - wait: 0
`;

async function runtimeComponent() {
  const parsed = frontend.parse(source, {sourceId: 'main'});
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const sourceDescriptor = await createDsl4EmbeddedSourceDescriptor(source, {
    sourceId: 'main',
    displayName: 'browser-demo.kamishibai.yaml',
    maxSourceBytes,
    subtleCrypto: webcrypto.subtle,
  });
  const artifact = await createDsl4RuntimeArtifactDescriptor(
    parsed.storyDocument,
    sourceDescriptor,
    'production',
    {maxSourceBytes, subtleCrypto: webcrypto.subtle},
  );
  assert.equal(artifact.ok, true, JSON.stringify(artifact.diagnostics));
  const assetBundle = await createDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    {
      manifest: {formatVersion: 1, assets: []},
      getFile(assetId: string, filePath: string): Uint8Array {
        throw new Error(`The empty bundle has no ${assetId}/${filePath}`);
      },
    },
    {maxFiles: maxAssetFiles, maxTotalBytes: maxAssetBytes, subtleCrypto: webcrypto.subtle},
  );
  return Object.freeze({
    storyDocument: parsed.storyDocument,
    sourceDescriptor,
    runtimeArtifact: okResult(artifact, 'the runtime artifact descriptor').artifact,
    assetBundle,
  });
}

function menuProject(): DistributionProject {
  return {
    targets: [{isStage: true, name: 'Stage'}],
    monitors: [],
    extensions: ['kubohiroyakamishibai4'],
    extensionStorage: {
      kubohiroyakamishibai4: {
        retained: 'bundle metadata',
        components: {
          kubohiroyakamishibairuntime4: {
            application: {mode: 'menu'},
            source: {retained: false},
          },
        },
      },
    },
  };
}

test('builds and verifies a standalone story SB3 without mutating the open project', async () => {
  const component = await runtimeComponent();
  const project = menuProject();
  const original = structuredClone(project);
  const retainedAsset = Uint8Array.of(1, 2, 3, 4);
  const result = await createDsl4BrowserDistributionSb3({
    projectFiles: {
      'project.json': strToU8(JSON.stringify(project)),
      'retained.svg': retainedAsset,
    },
    runtimeComponent: component,
    sourceFrontend: frontend,
    maxSourceBytes,
    maxAssetFiles,
    maxAssetBytes,
    subtleCrypto: webcrypto.subtle,
  });

  assert.deepEqual(project, original);
  assert.equal(result.filename, 'browser-demo.sb3');
  assert.deepEqual(result.delivery, {networkRequired: false, remoteAssetCount: 0});
  const archive = unzipSync(result.bytes);
  assert.deepEqual(archive['retained.svg'], retainedAsset);
  const outputProject = JSON.parse(
    strFromU8(requireDefined(archive['project.json'], 'the built project.json')),
  ) as DistributionProject;
  const stage = requireDefined(
    outputProject.targets.find(({isStage}) => isStage),
    'the built stage target',
  );
  assert.deepEqual(
    Object.values(requireDefined(stage.variables, 'its variables'))
      .map(([name]) => name)
      .sort(),
    ['チャージ', 'ポーズ認識'],
  );
  assert.deepEqual(
    outputProject.monitors.map(({id, params, visible}) => [id, params.VARIABLE, visible]),
    [
      ['dsl4-pose-confidence', 'ポーズ認識', false],
      ['dsl4-pose-progress', 'チャージ', false],
    ],
  );
  assert.equal(
    requireDefined(outputProject.extensionStorage.kubohiroyakamishibai4, 'the extension storage')
      .retained,
    'bundle metadata',
  );
  assert.equal(
    requireDefined(componentStorage(outputProject), 'the component').application?.mode,
    'story',
  );
  const verified = await loadDsl4RuntimeComponent(outputProject, frontend, {
    maxSourceBytes,
    maxAssetFiles,
    maxAssetBytes,
    subtleCrypto: webcrypto.subtle,
  });
  okResult(verified, 'the verified distribution');
});

test('rejects unsafe or over-limit open-project archives before building', async () => {
  const component = await runtimeComponent();
  const options = {
    runtimeComponent: component,
    sourceFrontend: frontend,
    maxSourceBytes,
    maxAssetFiles,
    maxAssetBytes,
    subtleCrypto: webcrypto.subtle,
  };
  await assert.rejects(
    createDsl4BrowserDistributionSb3({
      ...options,
      projectFiles: {
        'project.json': strToU8(JSON.stringify(menuProject())),
        '../outside.svg': Uint8Array.of(1),
      },
    }),
    {code: 'K4-BROWSER-BUILD-ARCHIVE-PATH'},
  );
  await assert.rejects(
    createDsl4BrowserDistributionSb3({
      ...options,
      projectFiles: {'project.json': strToU8(JSON.stringify(menuProject()))},
      maxProjectBytes: 8,
    }),
    {code: 'K4-BROWSER-BUILD-PROJECT-LIMIT'},
  );
  await assert.rejects(
    createDsl4BrowserDistributionSb3({
      ...options,
      runtimeComponent: {
        ...component,
        assetBundle: {
          ...component.assetBundle,
          manifest: {assets: [{source: {type: 'remote'}}]},
        },
      },
      projectFiles: {'project.json': strToU8(JSON.stringify(menuProject()))},
      network: 'forbidden',
    }),
    {code: 'K4-BROWSER-BUILD-OFFLINE-REMOTE'},
  );
});

test('creates one browser download and revokes its object URL', () => {
  const events: unknown[][] = [];
  const anchor: {
    style: Record<string, string>;
    download?: string;
    href?: string;
    click(): void;
    remove(): void;
  } = {
    style: {},
    click() {
      events.push(['click', this.download, this.href]);
    },
    remove() {
      events.push(['remove']);
    },
  };
  const globalObject = {
    Blob,
    URL: {
      createObjectURL(blob: Blob) {
        events.push(['create', blob.type, blob.size]);
        return 'blob:test';
      },
      revokeObjectURL(url: string) {
        events.push(['revoke', url]);
      },
    },
    document: {
      createElement(name: string) {
        assert.equal(name, 'a');
        return anchor;
      },
      body: {appendChild: () => events.push(['append'])},
    },
  };
  const result = downloadDsl4BrowserDistributionSb3({
    bytes: Uint8Array.of(1, 2, 3),
    filename: 'story.sb3',
    globalObject,
  });
  assert.deepEqual(result, {method: 'download', filename: 'story.sb3', size: 3});
  assert.deepEqual(events, [
    ['create', 'application/x.scratch.sb3', 3],
    ['append'],
    ['click', 'story.sb3', 'blob:test'],
    ['remove'],
    ['revoke', 'blob:test'],
  ]);
  assert.equal(createDsl4BrowserDistributionFilename('nested/日本語.k4.yml'), '日本語.sb3');
});

test('shows an accessible build action only for the non-embedded authoring menu', async () => {
  const document = createFakeDocument();
  let buildCalls = 0;
  const menu = createDsl4RuntimeApplicationMenu({
    document,
    mount: document.body,
    locales: {
      en: {open: 'Open', reload: 'Reload', build: 'Build', about: 'About', language: 'Language'},
      ja: {open: '開く', reload: '再実行', build: '作る', about: '情報', language: '言語'},
    },
    onOpen() {},
    onReload() {},
    onBuild() {
      buildCalls += 1;
    },
    onAbout() {},
    onLocaleChange() {},
    buildVisible: false,
  });
  const menuElement = requireFakeElement(menu.element, 'the menu element');
  const buildButton = requireFirst(
    findByAttribute(menuElement, 'data-dsl4-menu-action', 'build'),
    'build action',
  );
  const status = requireFirst(
    findByAttribute(menuElement, 'data-dsl4-menu-build-status', 'true'),
    'build status',
  );
  assert.equal(buildButton.hidden, true);
  menu.setBuildState({visible: true, enabled: false, status: 'Open a valid project.'});
  menu.show('en');
  assert.equal(buildButton.hidden, false);
  assert.equal(buildButton.disabled, true);
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.textContent, 'Open a valid project.');
  buildButton.click();
  assert.equal(buildCalls, 0);

  menu.setBuildState({enabled: true, status: 'Ready'});
  buildButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(buildCalls, 1);
  assert.equal(buildButton.getAttribute('aria-label'), 'Build');
  menu.dispose();
});

test('hides the open action when the playback profile has no authoring surface', () => {
  const document = createFakeDocument();
  const menu = createDsl4RuntimeApplicationMenu({
    document,
    mount: document.body,
    locales: {
      en: {open: 'Open', reload: 'Reload', about: 'About', language: 'Language'},
      ja: {open: '開く', reload: '再実行', about: '情報', language: '言語'},
    },
    onReload() {},
    onAbout() {},
    onLocaleChange() {},
    openVisible: false,
  });
  const openButton = requireFirst(
    findByAttribute(
      requireFakeElement(menu.element, 'the menu element'),
      'data-dsl4-menu-action',
      'open',
    ),
    'open action',
  );
  menu.show('en');
  assert.equal(openButton.hidden, true);
  assert.equal(openButton.disabled, true);
  assert.equal(openButton.style.display, 'none');
  menu.dispose();
});

/** The window members the save transaction reads, including the self-references it checks. */
interface SaveFileGlobal {
  isSecureContext: boolean;
  self: SaveFileGlobal | null;
  top: SaveFileGlobal | null;
  showSaveFilePicker(options: unknown): Promise<unknown>;
}

test('uses the native save transaction when available and treats picker cancellation explicitly', async () => {
  const writes: unknown[] = [];
  const handle = {
    async createWritable(options: unknown) {
      assert.deepEqual(options, {keepExistingData: false});
      return {
        async write(bytes: Uint8Array) {
          writes.push(new Uint8Array(bytes));
        },
        async close() {
          writes.push('closed');
        },
      };
    },
  };
  const globalObject: SaveFileGlobal = {
    isSecureContext: true,
    self: null,
    top: null,
    async showSaveFilePicker(options: unknown) {
      assert.deepEqual(options, {
        suggestedName: 'story.sb3',
        types: [
          {
            description: 'Scratch 3 project',
            accept: {'application/x.scratch.sb3': ['.sb3']},
          },
        ],
      });
      return handle;
    },
  };
  globalObject.self = globalObject;
  globalObject.top = globalObject;
  const target = await requestDsl4BrowserDistributionSaveTarget({
    filename: 'story.sb3',
    globalObject,
  });
  const saved = await saveDsl4BrowserDistributionSb3({
    bytes: Uint8Array.of(4, 5, 6),
    filename: 'story.sb3',
    target,
    globalObject,
  });
  assert.deepEqual(saved, {method: 'file-system', filename: 'story.sb3', size: 3});
  assert.deepEqual(writes, [Uint8Array.of(4, 5, 6), 'closed']);

  globalObject.showSaveFilePicker = async () => {
    throw Object.assign(new Error('cancelled'), {name: 'AbortError'});
  };
  const cancelled = await requestDsl4BrowserDistributionSaveTarget({
    filename: 'story.sb3',
    globalObject,
  });
  assert.deepEqual(cancelled, {method: 'cancelled', filename: 'story.sb3'});
  assert.deepEqual(
    await saveDsl4BrowserDistributionSb3({
      bytes: Uint8Array.of(9),
      filename: 'story.sb3',
      target: cancelled,
      globalObject,
    }),
    {method: 'cancelled', filename: 'story.sb3', size: 0},
  );
});
