import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runInThisContext} from 'node:vm';
import test from 'node:test';

import {strFromU8, unzipSync} from 'fflate';
import {buildSb3, importSb3} from '@kubohiroya/sb3-toolchain';

import {
  createDownloadableReleaseSb3,
  downloadableReleases,
} from '../scripts/sb3/downloadable-releases.mjs';
import {
  buildDsl4RuntimeComponent,
  createDsl4ProductionSourceFrontend,
  embedDsl4PackagedRuntimeComponentInSb3,
} from '../src/builder/index.js';
import {
  createDsl4EmbeddedAssetBundle,
  createDsl4EmbeddedSourceDescriptor,
  createDsl4RuntimeArtifactDescriptor,
} from '../src/dsl4/index.js';
import {dsl4StandardProductionFeatureFlags} from '../src/dsl4/feature-flags.js';
import {
  buildDsl4BrowserSelectedStoryProject,
  collectDsl4BrowserDroppedFiles,
  selectDsl4BrowserStorySource,
} from '../src/dsl4/platform/browser-story-file-loader.js';
import {dsl4RuntimeApplicationMenuDefaultIcons} from '../src/dsl4/platform/runtime-application-menu.js';
import {createFakeDocument, findByAttribute} from './helpers/fake-dom.mjs';
import {turbowarpVmCommit} from './helpers/turbowarp-vm.mjs';

const require = createRequire(import.meta.url);
const VirtualMachine = require('scratch-vm');
const dispatch = require('scratch-vm/src/dispatch/central-dispatch');
const vmLog = require('scratch-vm/src/util/log');
const bundleExtensionId = 'kubohiroyakamishibai4';
const runtimeExtensionId = 'kubohiroyakamishibairuntime4';
const release = downloadableReleases.find(({series}) => series === '4.0');
assert(release, 'The release catalog must publish a DSL 4.0 artifact.');
const schema = JSON.parse(
  await readFile(new URL('../schema/dsl-4.schema.json', import.meta.url), 'utf8'),
);
const frontend = createDsl4ProductionSourceFrontend(schema);
const storyComponentLimits = Object.freeze({
  maxSourceBytes: 1024 * 1024,
  maxAssetFiles: 64,
  maxAssetBytes: 64 * 1024 * 1024,
});
const version3MenuIconFilenames = Object.freeze({
  open: '1766a36329eca190b2b19bba53ef7d8f.svg',
  reload: '8cf6379b2d82bea5a39bb46757a9bd3d.svg',
  about: 'fc0a44695524e272260a18d76320828f.svg',
  language: '7069974a56d188a8d1e9e79513df9e0e.svg',
});
const version3MenuIconDataUrls = Object.freeze(
  Object.fromEntries(
    await Promise.all(
      Object.entries(version3MenuIconFilenames).map(async ([action, filename]) => {
        const bytes = await readFile(new URL(`../app/assets/${filename}`, import.meta.url));
        return [action, `data:image/svg+xml;base64,${bytes.toString('base64')}`];
      }),
    ),
  ),
);

async function buildRelease() {
  return createDownloadableReleaseSb3(release);
}

function browserFile(name, contents) {
  const bytes = new Uint8Array(contents);
  return {
    name,
    size: bytes.byteLength,
    async arrayBuffer() {
      return bytes.slice().buffer;
    },
  };
}

function browserFileHandle(name, file) {
  return {
    kind: 'file',
    name,
    async getFile() {
      return file;
    },
  };
}

function browserDirectoryHandle(name, entries) {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const entry of entries) yield entry;
    },
  };
}

async function buildEmbeddedStoryRelease({navigationFixture = false} = {}) {
  const result = await buildRelease();
  const projectDirectory = await mkdtemp(path.join(tmpdir(), 'dsl4-restart-project-'));
  const baseSb3Path = path.join(projectDirectory, 'base.sb3');
  const sourceDirectory = path.join(projectDirectory, 'source');
  const projectAssetsPath = path.join(projectDirectory, 'project-assets.yml');
  const displayAssetPath = path.join(projectDirectory, 'display.svg');
  const projectSb3Path = path.join(projectDirectory, 'project.sb3');
  const sceneSource = navigationFixture
    ? `  opening:
    actions:
      - Actor.show:
          skin: ActorSkin
          x: 0
          y: 0
          scale: 100
      - wait: 60
  ending:
    actions:
      - Actor.show:
          skin: ActorSkin
          x: 123
          y: 0
          scale: 100
      - wait: 60`
    : `  opening:
    - wait: 0.05`;
  const sourceText = `kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
      ArrowRight: rehearsal.skipAction
      ArrowDown: rehearsal.skipScene
assets:
  EndCover:
    kind: backdrop
    name: Menu
  ActorSkin: costume:Actor
actors:
  Actor: ActorSkin
cover:
  backdrop: EndCover
scenes:
${sceneSource}
`;
  const parsed = frontend.parse(sourceText, {sourceId: 'main'});
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const source = await createDsl4EmbeddedSourceDescriptor(sourceText, {
    sourceId: 'main',
    displayName: 'story.kamishibai.yaml',
    maxSourceBytes: storyComponentLimits.maxSourceBytes,
    subtleCrypto: webcrypto.subtle,
  });
  const artifact = await createDsl4RuntimeArtifactDescriptor(
    parsed.storyDocument,
    source,
    'production',
    {maxSourceBytes: storyComponentLimits.maxSourceBytes, subtleCrypto: webcrypto.subtle},
  );
  assert.equal(artifact.ok, true, JSON.stringify(artifact.diagnostics));
  const assets = await createDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    {
      manifest: {
        formatVersion: 1,
        assets: [
          {
            id: 'ActorSkin',
            kind: 'costume',
            loading: 'eager',
            target: 'Actor',
            source: {type: 'project', name: 'ActorSkin'},
          },
          {
            id: 'EndCover',
            kind: 'backdrop',
            loading: 'eager',
            source: {type: 'project', name: 'Menu'},
          },
        ],
      },
      getFile() {
        assert.fail('The embedded story fixture has no binary file asset.');
      },
    },
    {
      maxFiles: storyComponentLimits.maxAssetFiles,
      maxTotalBytes: storyComponentLimits.maxAssetBytes,
      subtleCrypto: webcrypto.subtle,
    },
  );
  try {
    await Promise.all([
      writeFile(baseSb3Path, result.archive),
      writeFile(
        displayAssetPath,
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#fff"/></svg>\n',
      ),
      writeFile(
        projectAssetsPath,
        `formatVersion: 1
sprites:
  Actor:
    layerOrder: 1
    visible: false
    x: 0
    y: 0
    size: 100
    direction: 90
    draggable: false
    rotationStyle: all around
    volume: 100
  Narration:
    layerOrder: 2
    visible: false
    x: 0
    y: 0
    size: 100
    direction: 90
    draggable: false
    rotationStyle: all around
    volume: 100
assets:
  ActorSkin:
    kind: costume
    target: Actor
    file: display.svg
    rotationCenterX: 5
    rotationCenterY: 5
  NarrationText:
    kind: costume
    target: Narration
    file: display.svg
    rotationCenterX: 5
    rotationCenterY: 5
`,
      ),
    ]);
    await importSb3({inputPath: baseSb3Path, outputDirectory: sourceDirectory});
    await buildSb3({
      sourceDirectory,
      projectAssetsPath,
      outputPath: projectSb3Path,
    });
    const embedded = await embedDsl4PackagedRuntimeComponentInSb3(
      await readFile(projectSb3Path),
      parsed.storyDocument,
      source,
      artifact.artifact,
      assets,
      {
        channel: 'bundled',
        ...storyComponentLimits,
        replaceExisting: true,
        subtleCrypto: webcrypto.subtle,
      },
    );
    return embedded.bytes;
  } finally {
    await rm(projectDirectory, {recursive: true, force: true});
  }
}

async function buildExternalSourceStoryRelease() {
  const result = await buildRelease();
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'dsl4-external-finish-'));
  const sourceFilename = 'story.k4.yml';
  const sourceText = `kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
assets:
  EndCover:
    kind: backdrop
    name: Menu
cover:
  backdrop: EndCover
scenes:
  opening:
    - wait: 0.05
`;
  const sourceManifest = {
    formatVersion: 1,
    mode: 'external',
    sourceId: 'main',
    path: sourceFilename,
  };
  try {
    await writeFile(path.join(projectRoot, sourceFilename), sourceText);
    const built = await buildDsl4RuntimeComponent({
      baseSb3Bytes: result.archive,
      projectRoot,
      sourceManifest,
      sourceFrontend: frontend,
      controlProfile: 'production',
      channel: 'bundled',
      maxSourceBytes: storyComponentLimits.maxSourceBytes,
      maxAssetFileBytes: storyComponentLimits.maxAssetBytes,
      maxAssetFiles: storyComponentLimits.maxAssetFiles,
      maxTotalAssetBytes: storyComponentLimits.maxAssetBytes,
      replaceExisting: true,
      subtleCrypto: webcrypto.subtle,
    });
    assert.deepEqual(
      built.project.extensionStorage[bundleExtensionId].components[runtimeExtensionId].application,
      {mode: 'story'},
    );
    return built.bytes;
  } finally {
    await rm(projectRoot, {recursive: true, force: true});
  }
}

function installUnsandboxedScriptDom({withTitleUi = false} = {}) {
  const previous = {
    document: globalThis.document,
    location: globalThis.location,
    Scratch: globalThis.Scratch,
    ScratchExtensions: globalThis.ScratchExtensions,
  };
  globalThis.location = {href: 'https://release.test/'};
  const executeScript = (script) => {
    try {
      const prefix = 'data:text/javascript;base64,';
      assert(script.src.startsWith(prefix), 'The release extension must be embedded.');
      const source = Buffer.from(script.src.slice(prefix.length), 'base64').toString('utf8');
      runInThisContext(source, {filename: `${bundleExtensionId}.js`});
    } catch (error) {
      script.onerror?.(error);
    }
  };
  const document = withTitleUi
    ? createFakeDocument()
    : {
        visibilityState: 'visible',
        scripts: [],
        addEventListener() {},
        removeEventListener() {},
        createElement(tagName) {
          assert.equal(tagName, 'script');
          return {onerror: null, src: ''};
        },
        body: {appendChild: executeScript},
      };
  if (withTitleUi) {
    const appendChild = document.body.appendChild.bind(document.body);
    document.body.appendChild = (element) => {
      if (element.tagName === 'SCRIPT') {
        executeScript(element);
        return element;
      }
      return appendChild(element);
    };
  }
  globalThis.document = document;
  const restore = () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(globalThis, name);
      else globalThis[name] = value;
    }
  };
  restore.document = document;
  return restore;
}

async function extensionReporter(vm, opcode) {
  const service = vm.extensionManager._loadedExtensions.get(bundleExtensionId);
  assert(service, 'The embedded DSL 4.0 runtime extension was not loaded.');
  return dispatch.call(service, opcode);
}

async function loadProjectQuietly(vm, archive) {
  const originalWarn = vmLog.warn;
  const originalWarning = vmLog.warning;
  vmLog.warn = () => {};
  vmLog.warning = () => {};
  try {
    await vm.loadProject(archive);
  } finally {
    vmLog.warn = originalWarn;
    vmLog.warning = originalWarning;
  }
}

test('builds one self-contained DSL 4.0 release with a pinned runtime extension', async () => {
  const result = await buildRelease();
  const archive = unzipSync(result.archive);
  const project = JSON.parse(strFromU8(archive['project.json']));
  const extensionUrl = project.extensionURLs[bundleExtensionId];
  const extensionSource = Buffer.from(
    extensionUrl.slice('data:text/javascript;base64,'.length),
    'base64',
  ).toString('utf8');
  const stage = project.targets.find(({isStage}) => isStage);
  const title = stage.costumes.find(({name}) => name === 'Title');
  assert(title, 'The release Stage must contain a Title backdrop.');
  const titleSvg = strFromU8(archive[title.md5ext]);
  assert.match(titleSvg, />Participatory AI Kamishibai</u);
  assert.doesNotMatch(titleSvg, /Kamishibai DSL 4\.0/u);
  const localizedTitle = stage.costumes.find(({name}) => name === 'TitleRuntime');
  const localizedTitleSvg = strFromU8(archive[localizedTitle.md5ext]);
  assert.match(localizedTitleSvg, />「参加型」AI紙芝居</u);
  assert.match(localizedTitleSvg, /Mozilla Public License 2\.0/u);
  assert.match(localizedTitleSvg, />千葉商科大学　総合政策学部</u);
  assert.match(localizedTitleSvg, />久保 裕也 &lt;hiroya@cuc\.ac\.jp&gt;</u);
  assert.doesNotMatch(localizedTitleSvg, />千葉商科大学<\/text>\s*<text[^>]*>総合政策学部</u);
  assert.doesNotMatch(localizedTitleSvg, /\{\{/u);
  const menuSvg = strFromU8(archive[stage.costumes.find(({name}) => name === 'Menu').md5ext]);
  const localizedMenuSvg = strFromU8(
    archive[stage.costumes.find(({name}) => name === 'MenuRuntime').md5ext],
  );
  assert.doesNotMatch(menuSvg, />Open|>Reload|>About|>Language/u);
  assert.doesNotMatch(localizedMenuSvg, />ファイルを開く|>もう一度|>アプリ情報|>言語/u);
  assert.deepEqual(
    stage.costumes.map(({name}) => name),
    ['Title', 'TitleRuntime', 'Menu', 'MenuRuntime'],
  );
  assert.deepEqual(
    project.targets.map(({name}) => name),
    ['Stage'],
    'Title and menu actions must not add button sprites to the Scratch project.',
  );
  assert.equal(stage.blocks.titleFlag?.opcode, 'event_whenflagclicked');
  assert.equal(stage.blocks.titleFlag?.next, 'titleFlagShow');
  assert.equal(stage.blocks.titleFlagShow?.opcode, `${bundleExtensionId}_showTitle`);
  assert.equal(stage.blocks.titleStageClick?.opcode, 'event_whenstageclicked');
  assert.deepEqual(stage.blocks.titleStageClickClose?.inputs?.BROADCAST_INPUT, [
    1,
    [11, 'closeTitle', 'closeTitleMessage'],
  ]);
  assert.equal(stage.blocks.titleCloseHat?.opcode, 'event_whenbroadcastreceived');
  assert.deepEqual(stage.blocks.titleCloseHat?.fields?.BROADCAST_OPTION, [
    'closeTitle',
    'closeTitleMessage',
  ]);
  assert.equal(stage.blocks.titleCloseStart?.opcode, `${bundleExtensionId}_closeTitle`);

  assert.equal(turbowarpVmCommit, 'c4823421cb7c17d8d8a89878851ce1668c26a21f');
  assert.deepEqual(project.extensions, [bundleExtensionId]);
  assert.deepEqual(Object.keys(project.extensionURLs), [bundleExtensionId]);
  assert.match(extensionUrl, /^data:text\/javascript;base64,/u);
  assert.match(extensionSource, /^\/\/ Name: Kamishibai DSL 4\.0 Runtime/mu);
  assert.match(extensionSource, /^\/\/ ID: kubohiroyakamishibai4/mu);
  assert.match(extensionSource, /data-dsl4-title-controls/u);
  assert.match(extensionSource, /data-dsl4-title-action/u);
  assert.doesNotMatch(extensionSource, /kubohiroyaweblink|SB3-Toolchain-Reversible-Bundle-v1/u);
  for (const [flag, enabled] of Object.entries(dsl4StandardProductionFeatureFlags)) {
    assert.equal(enabled, true);
    assert.equal(
      extensionSource.includes(`${flag}:!0`),
      true,
      `The Standard release bundle must enable ${flag}.`,
    );
  }
  assert.match(extensionSource, /display:none/u);
  for (const title of [
    'Asset Manager',
    'Async Input',
    'Bubble',
    'Runtime Expression',
    'SVG Text',
    'TMPose',
    'Teachable Machine Pose',
    'TensorFlow.js',
    'PoseNet MobileNetV1 model',
  ]) {
    assert.match(extensionSource, new RegExp(title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  assert.match(extensionSource, /@tensorflow\/tfjs Copyright 2019 Google/u);
  assert.match(extensionSource, /var tmPose=/u);
  const runtimeStorage = project.extensionStorage[bundleExtensionId].components[runtimeExtensionId];
  assert.equal(runtimeStorage.source.text.includes("kamishibai: '4.0'"), true);
  assert.deepEqual(runtimeStorage.application, {mode: 'menu'});
  assert.equal(runtimeStorage.artifact.controlProfile, 'production');
  assert.deepEqual(runtimeStorage.assets.manifest.assets, []);
  assert.deepEqual(Object.values(stage.variables), [
    ['ポーズ認識', 0],
    ['チャージ', 0],
  ]);
  assert.deepEqual(
    project.monitors.map(({opcode, params, mode, sliderMin, sliderMax, visible}) => ({
      opcode,
      params,
      mode,
      sliderMin,
      sliderMax,
      visible,
    })),
    [
      {
        opcode: 'data_variable',
        params: {VARIABLE: 'ポーズ認識'},
        mode: 'slider',
        sliderMin: 0,
        sliderMax: 100,
        visible: false,
      },
      {
        opcode: 'data_variable',
        params: {VARIABLE: 'チャージ'},
        mode: 'slider',
        sliderMin: 0,
        sliderMax: 100,
        visible: false,
      },
    ],
  );
  assert.equal(createHash('sha256').update(result.archive).digest('hex'), release.sha256);
});

test('builds a browser-selected YAML story and only its declared local assets in memory', async () => {
  const result = await buildRelease();
  const archive = unzipSync(result.archive);
  const project = JSON.parse(strFromU8(archive['project.json']));
  const sourceText = `kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
assets:
  Card:
    kind: backdrop
    file: assets/card.svg
cover:
  backdrop: Card
scenes:
  opening:
    - wait: 0
`;
  const card = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"></svg>',
  );
  const built = await buildDsl4BrowserSelectedStoryProject({
    project,
    entries: [
      {
        path: 'story-project/story.k4.yml',
        file: browserFile('story.k4.yml', new TextEncoder().encode(sourceText)),
      },
      {path: 'story-project/assets/card.svg', file: browserFile('card.svg', card)},
      {
        path: 'story-project/private.txt',
        file: browserFile('private.txt', new Uint8Array([1, 2, 3])),
      },
    ],
    sourceFrontend: frontend,
    maxSourceBytes: storyComponentLimits.maxSourceBytes,
    maxAssetFileBytes: storyComponentLimits.maxAssetBytes,
    maxAssetFiles: storyComponentLimits.maxAssetFiles,
    maxAssetBytes: storyComponentLimits.maxAssetBytes,
    subtleCrypto: webcrypto.subtle,
  });
  const component =
    built.project.extensionStorage[bundleExtensionId].components[runtimeExtensionId];
  assert.deepEqual(component.application, {mode: 'story'});
  assert.equal(component.source.text, sourceText);
  assert.deepEqual(
    component.assets.files.map(({assetId, path: filePath, size}) => ({
      assetId,
      path: filePath,
      size,
    })),
    [{assetId: 'Card', path: 'card.svg', size: card.byteLength}],
  );
});

test('reports a missing embedded asset with its story file and source reference line', async () => {
  const sourceText = `kamishibai: '4.0'
assets:
  MissingCard:
    kind: backdrop
    file: assets/missing-card.svg
scenes:
  opening:
    - wait: 0
`;

  await assert.rejects(
    buildDsl4BrowserSelectedStoryProject({
      project: {},
      entries: [
        {
          path: 'story-project/story.k4.yml',
          file: browserFile('story.k4.yml', new TextEncoder().encode(sourceText)),
        },
      ],
      sourceFrontend: frontend,
      maxSourceBytes: storyComponentLimits.maxSourceBytes,
      maxAssetFileBytes: storyComponentLimits.maxAssetBytes,
      maxAssetFiles: storyComponentLimits.maxAssetFiles,
      maxAssetBytes: storyComponentLimits.maxAssetBytes,
      subtleCrypto: webcrypto.subtle,
    }),
    (error) => {
      assert.equal(error.code, 'K4-ASSET-MISSING');
      assert.equal(
        error.message,
        [
          'The asset file referenced in the story could not be found.',
          'file: story-project/story.k4.yml',
          '[5] MissingCard,assets/missing-card.svg',
        ].join('\n'),
      );
      return true;
    },
  );
});

test('keeps the selected source suffix strict after the native chooser accepts YAML files', () => {
  assert.throws(
    () =>
      selectDsl4BrowserStorySource([
        {path: 'story.yml', file: browserFile('story.yml', new Uint8Array())},
      ]),
    /No \.k4\.yml file was selected/u,
  );
  assert.equal(
    selectDsl4BrowserStorySource([
      {path: 'story.k4.yml', file: browserFile('story.k4.yml', new Uint8Array())},
    ]).path,
    'story.k4.yml',
  );
});

test('collects a dropped DSL 4.0 project directory without flattening asset paths', async () => {
  const source = browserFile('story.k4.yml', new TextEncoder().encode("kamishibai: '4.0'\n"));
  const card = browserFile('card.svg', new TextEncoder().encode('<svg/>'));
  const root = browserDirectoryHandle('story-project', [
    ['story.k4.yml', browserFileHandle('story.k4.yml', source)],
    [
      'assets',
      browserDirectoryHandle('assets', [['card.svg', browserFileHandle('card.svg', card)]]),
    ],
  ]);
  const entries = await collectDsl4BrowserDroppedFiles({
    items: [
      {
        async getAsFileSystemHandle() {
          return root;
        },
      },
    ],
  });
  assert.deepEqual(
    entries.map(({path: filePath}) => filePath),
    ['story-project/assets/card.svg', 'story-project/story.k4.yml'],
  );
});

test('stops dropped-directory enumeration at the configured entry and depth boundaries', async () => {
  let fileReads = 0;
  const fileHandle = (name) => ({
    kind: 'file',
    name,
    async getFile() {
      fileReads += 1;
      return browserFile(name, new Uint8Array([1]));
    },
  });
  const wideRoot = {
    kind: 'directory',
    name: 'wide',
    async *entries() {
      yield ['first.k4.yml', fileHandle('first.k4.yml')];
      yield ['second.svg', fileHandle('second.svg')];
      assert.fail('Directory enumeration must stop at maxEntries.');
    },
  };
  await assert.rejects(
    collectDsl4BrowserDroppedFiles(
      {
        items: [
          {
            async getAsFileSystemHandle() {
              return wideRoot;
            },
          },
        ],
      },
      {maxEntries: 2, maxDepth: 4},
    ),
    /2 entry limit/u,
  );
  assert.equal(fileReads, 0, 'The collector must reject before reading a bounded-out file.');

  const nestedRoot = browserDirectoryHandle('root', [
    [
      'first',
      browserDirectoryHandle('first', [
        [
          'second',
          browserDirectoryHandle('second', [['story.k4.yml', fileHandle('story.k4.yml')]]),
        ],
      ]),
    ],
  ]);
  await assert.rejects(
    collectDsl4BrowserDroppedFiles(
      {
        items: [
          {
            async getAsFileSystemHandle() {
              return nestedRoot;
            },
          },
        ],
      },
      {maxEntries: 16, maxDepth: 1},
    ),
    /directory depth limit/u,
  );
  assert.equal(fileReads, 0);

  await assert.rejects(
    collectDsl4BrowserDroppedFiles(
      {
        items: [{}, {}, {}],
      },
      {maxEntries: 2, maxDepth: 4},
    ),
    /2 entry limit/u,
  );

  await assert.rejects(
    collectDsl4BrowserDroppedFiles(
      {
        files: [
          {
            ...browserFile('story.k4.yml', new Uint8Array([1])),
            webkitRelativePath: 'root/one/two/story.k4.yml',
          },
        ],
      },
      {maxEntries: 2, maxDepth: 2},
    ),
    /directory depth limit/u,
  );
});

test('uses the exact version 3 SVG bytes as the reusable DOM menu defaults', () => {
  assert.deepEqual(dsl4RuntimeApplicationMenuDefaultIcons, version3MenuIconDataUrls);
});

test('preserves the embedded source descriptor through a pinned TurboWarp resave', async () => {
  const result = await buildRelease();
  const archive = unzipSync(result.archive);
  const originalProject = JSON.parse(strFromU8(archive['project.json']));
  const originalSource =
    originalProject.extensionStorage[bundleExtensionId].components[runtimeExtensionId].source;
  const restoreGlobals = installUnsandboxedScriptDom();
  const vm = new VirtualMachine();
  try {
    vm.setCompatibilityMode(false);
    vm.setTurboMode(false);
    vm.setCompilerOptions({enabled: false});
    vm.securityManager.canLoadExtensionFromProject = () => true;
    vm.securityManager.getSandboxMode = () => 'unsandboxed';
    await loadProjectQuietly(vm, result.archive);

    const resavedProject = JSON.parse(vm.toJSON());
    assert.deepEqual(
      resavedProject.extensionStorage[bundleExtensionId].components[runtimeExtensionId].source,
      originalSource,
    );
  } finally {
    vm.quit();
    restoreGlobals();
  }
});

test('opens the fixed official website through the Runtime 4 opcode', async () => {
  const result = await buildRelease();
  const restoreGlobals = installUnsandboxedScriptDom();
  const previousOpen = globalThis.open;
  const opened = [];
  globalThis.open = (...args) => opened.push(args);
  const vm = new VirtualMachine();
  try {
    vm.setCompatibilityMode(false);
    vm.setTurboMode(false);
    vm.setCompilerOptions({enabled: false});
    vm.securityManager.canLoadExtensionFromProject = () => true;
    vm.securityManager.getSandboxMode = () => 'unsandboxed';
    await loadProjectQuietly(vm, result.archive);

    await extensionReporter(vm, 'openOfficialWebsite');
    assert.deepEqual(opened, [
      ['https://kubohiroya.github.io/tmpose-kamishibai/', '_blank', 'noopener,noreferrer'],
    ]);
  } finally {
    vm.quit();
    restoreGlobals();
    if (previousOpen === undefined) Reflect.deleteProperty(globalThis, 'open');
    else globalThis.open = previousOpen;
  }
});

test('opens the non-embedded title and menu without validating a packaged story bundle', async () => {
  const result = await buildRelease();
  const restoreGlobals = installUnsandboxedScriptDom({withTitleUi: true});
  const previousOpen = globalThis.open;
  const opened = [];
  globalThis.open = (...args) => opened.push(args);
  const vm = new VirtualMachine();
  try {
    vm.setCompatibilityMode(false);
    vm.setTurboMode(false);
    vm.setCompilerOptions({enabled: false});
    vm.securityManager.canLoadExtensionFromProject = () => true;
    vm.securityManager.getSandboxMode = () => 'unsandboxed';
    await loadProjectQuietly(vm, result.archive);
    vm.runtime.renderer = {
      draw() {},
      createSVGSkin() {
        return 1;
      },
      destroySkin() {},
      updateDrawableSkinId() {},
    };
    const originalToJSON = vm.toJSON.bind(vm);
    vm.toJSON = () => {
      const project = JSON.parse(originalToJSON());
      const component = project.extensionStorage[bundleExtensionId].components[runtimeExtensionId];
      component.assets = {formatVersion: 0};
      return JSON.stringify(project);
    };

    assert.equal(await extensionReporter(vm, 'versionReporter'), '4.0.0-dev');
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'ready');
    assert.deepEqual(JSON.parse(await extensionReporter(vm, 'binaryBackingStatusReporter')), {
      surface: null,
      backing: null,
    });
    assert.deepEqual(JSON.parse(await extensionReporter(vm, 'runtimeDiagnosticsReporter')), {
      status: 'ready',
      surface: null,
      runtime: null,
      resources: null,
      backing: null,
    });
    const titleControls = findByAttribute(
      restoreGlobals.document.body,
      'data-dsl4-title-controls',
      'true',
    )[0];
    assert(titleControls, 'English DOM title controls must exist before the green flag.');
    assert.equal(titleControls.style.display, 'block');
    assert.equal(
      findByAttribute(titleControls, 'data-dsl4-title-action', 'website')[0].getAttribute(
        'aria-label',
      ),
      'Official Website',
    );
    const initialCloseButton = findByAttribute(titleControls, 'data-dsl4-title-action', 'close')[0];
    assert.equal(initialCloseButton.getAttribute('aria-label'), 'Close');
    assert.equal(restoreGlobals.document.body.style.cursor, 'pointer');
    initialCloseButton.click();
    const initialCloseDeadline = Date.now() + 5_000;
    while (Date.now() < initialCloseDeadline) {
      vm.runtime._step();
      if ((await extensionReporter(vm, 'statusReporter')) === 'menu') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'menu');
    const initialApplicationMenu = findByAttribute(
      restoreGlobals.document.body,
      'data-dsl4-application-menu',
      'true',
    )[0];
    assert(initialApplicationMenu, 'The menu must not depend on a packaged story runtime.');
    const initialReloadButton = findByAttribute(
      initialApplicationMenu,
      'data-dsl4-menu-action',
      'reload',
    )[0];
    assert.equal(initialReloadButton.disabled, true);
    assert.equal(initialReloadButton.getAttribute('aria-disabled'), 'true');
    assert.equal(initialReloadButton.style.cursor, 'not-allowed');
    findByAttribute(initialApplicationMenu, 'data-dsl4-menu-action', 'about')[0].click();
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'title');
    assert.equal(
      vm.runtime.getTargetForStage().sprite.costumes[vm.runtime.getTargetForStage().currentCostume]
        .name,
      'Title',
    );
    assert.equal(titleControls.style.display, 'block');
    assert.equal(
      findByAttribute(restoreGlobals.document.body, 'data-dsl4-title-shell', 'true').length,
      0,
      'About must reuse the Stage title instead of opening a separate simplified dialog.',
    );
    await extensionReporter(vm, 'closeTitle');
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'menu');
    vm.greenFlag();
    const titleDeadline = Date.now() + 5_000;
    while (Date.now() < titleDeadline) {
      vm.runtime._step();
      if ((await extensionReporter(vm, 'statusReporter')) === 'title') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'title');
    assert.equal(titleControls.style.display, 'block');
    const websiteButton = findByAttribute(titleControls, 'data-dsl4-title-action', 'website')[0];
    websiteButton.click();
    assert.deepEqual(opened, [
      ['https://kubohiroya.github.io/tmpose-kamishibai/', '_blank', 'noopener,noreferrer'],
    ]);
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'title');
    assert.equal(
      vm.runtime.getTargetForStage().lookupBroadcastMsg('closeTitleMessage', 'closeTitle')?.name,
      'closeTitle',
    );
    const stageClickThreads = vm.runtime.startHats('event_whenstageclicked');
    assert.equal(stageClickThreads.length, 1, 'The Stage click must start the closeTitle stack.');
    const startupDeadline = Date.now() + 5_000;
    while (Date.now() < startupDeadline) {
      vm.runtime._step();
      const status = await extensionReporter(vm, 'statusReporter');
      if (status === 'menu') break;
      if (status === 'error') {
        assert.fail(`DSL 4.0 runtime failed: ${await extensionReporter(vm, 'lastErrorReporter')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finalStatus = await extensionReporter(vm, 'statusReporter');
    assert.equal(
      finalStatus,
      'menu',
      `DSL 4.0 runtime remained ${finalStatus} at startup timeout; threads=${JSON.stringify(
        vm.runtime.threads.map(({topBlock, status, stack}) => ({topBlock, status, stack})),
      )}`,
    );
    assert.equal(
      vm.runtime.getTargetForStage().sprite.costumes[vm.runtime.getTargetForStage().currentCostume]
        .name,
      'Menu',
    );

    vm.greenFlag();
    const secondTitleDeadline = Date.now() + 5_000;
    while (Date.now() < secondTitleDeadline) {
      vm.runtime._step();
      if ((await extensionReporter(vm, 'statusReporter')) === 'title') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'title');
    assert.equal(titleControls.style.display, 'block');
    const closeButton = findByAttribute(titleControls, 'data-dsl4-title-action', 'close')[0];
    const originalStartHats = vm.runtime.startHats.bind(vm.runtime);
    let closeBroadcastStarts = 0;
    vm.runtime.startHats = (opcode, fields, target) => {
      if (opcode === 'event_whenbroadcastreceived' && fields?.BROADCAST_OPTION === 'closeTitle') {
        closeBroadcastStarts += 1;
      }
      return originalStartHats(opcode, fields, target);
    };
    closeButton.click();
    const closeDeadline = Date.now() + 5_000;
    while (Date.now() < closeDeadline) {
      vm.runtime._step();
      const status = await extensionReporter(vm, 'statusReporter');
      if (status === 'menu') break;
      if (status === 'error') {
        assert.fail(`DSL 4.0 runtime failed: ${await extensionReporter(vm, 'lastErrorReporter')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(closeBroadcastStarts, 1, 'The DOM close action must broadcast closeTitle once.');
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'menu');
    assert.equal(
      vm.runtime.getTargetForStage().sprite.costumes[vm.runtime.getTargetForStage().currentCostume]
        .name,
      'Menu',
    );
    assert.equal(titleControls.style.display, 'none');
  } finally {
    vm.quit();
    restoreGlobals();
    if (previousOpen === undefined) Reflect.deleteProperty(globalThis, 'open');
    else globalThis.open = previousOpen;
  }
});

async function assertNaturallyFinishedStoryReturnsToMenu(archive, expectedDisplayNames = []) {
  const restoreGlobals = installUnsandboxedScriptDom({withTitleUi: true});
  const vm = new VirtualMachine();
  try {
    vm.setCompatibilityMode(false);
    vm.setTurboMode(false);
    vm.setCompilerOptions({enabled: false});
    vm.securityManager.canLoadExtensionFromProject = () => true;
    vm.securityManager.getSandboxMode = () => 'unsandboxed';
    await loadProjectQuietly(vm, archive);
    let nextSkinId = 1;
    let nextDrawableId = 1;
    for (const target of vm.runtime.targets) {
      target.drawableID = nextDrawableId;
      nextDrawableId += 1;
      for (const costume of target.sprite?.costumes ?? []) {
        costume.skinId = nextSkinId;
        nextSkinId += 1;
      }
    }
    vm.runtime.renderer = {
      draw() {},
      createSVGSkin() {
        return 1;
      },
      destroySkin() {},
      updateDrawableSkinId() {},
    };

    vm.greenFlag();
    const titleDeadline = Date.now() + 5_000;
    while (Date.now() < titleDeadline) {
      vm.runtime._step();
      if ((await extensionReporter(vm, 'statusReporter')) === 'title') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'title');
    assert.equal(
      restoreGlobals.document.listenerCount('keydown'),
      1,
      'A packaged story must attach its resolved production keymap to the document.',
    );
    const titleControls = findByAttribute(
      restoreGlobals.document.body,
      'data-dsl4-title-controls',
      'true',
    )[0];
    assert(titleControls, 'Title controls must be mounted above the Stage.');
    assert.equal(titleControls.style.display, 'block');
    assert.deepEqual(
      vm.runtime.targets.map((target) => target.getName()),
      ['Stage', ...expectedDisplayNames],
    );
    assert.equal(
      vm.runtime.targets.filter((target) => !target.isStage).every((target) => !target.visible),
      true,
    );

    await extensionReporter(vm, 'closeTitle');
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'menu');
    const stage = vm.runtime.getTargetForStage();
    assert.equal(stage.sprite.costumes[stage.currentCostume].name, 'Menu');
    assert.equal(titleControls.style.display, 'none');
    const applicationMenus = findByAttribute(
      restoreGlobals.document.body,
      'data-dsl4-application-menu',
      'true',
    );
    assert.equal(applicationMenus.length, 1);
    assert.equal(applicationMenus[0].style.display, 'block');
    for (const action of ['open', 'reload', 'about', 'language']) {
      const buttons = findByAttribute(applicationMenus[0], 'data-dsl4-menu-action', action);
      assert.equal(buttons.length, 1);
      assert.equal(buttons[0].children[0].tagName, 'IMG');
      assert.equal(buttons[0].children[0].src, version3MenuIconDataUrls[action]);
      assert.equal(buttons[0].children[0].alt, '');
      assert.match(buttons[0].children[0].style.cssText, /invert\(1\).*saturate\(\.35\)/u);
      assert.match(buttons[0].children[0].style.cssText, /width:10cqw;height:10cqw/u);
      assert.match(buttons[0].children[1].style.cssText, /font-size:3\.8cqw/u);
      assert.doesNotMatch(buttons[0].children[0].style.cssText, /clamp|px/u);
      assert.doesNotMatch(buttons[0].children[1].style.cssText, /clamp|px/u);
    }

    const languageButton = findByAttribute(
      applicationMenus[0],
      'data-dsl4-menu-action',
      'language',
    )[0];
    languageButton.click();
    assert.equal(stage.sprite.costumes[stage.currentCostume].name, 'MenuRuntime');
    assert.equal(languageButton.children[1].textContent, '言語');

    const aboutButton = findByAttribute(applicationMenus[0], 'data-dsl4-menu-action', 'about')[0];
    aboutButton.click();
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'title');
    assert.equal(stage.sprite.costumes[stage.currentCostume].name, 'TitleRuntime');
    assert.equal(applicationMenus[0].style.display, 'none');
    assert.equal(titleControls.style.display, 'block');
    assert.equal(
      findByAttribute(restoreGlobals.document.body, 'data-dsl4-title-shell', 'true').length,
      0,
    );
    await extensionReporter(vm, 'closeTitle');
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'menu');
    assert.equal(stage.sprite.costumes[stage.currentCostume].name, 'MenuRuntime');
    assert.equal(applicationMenus[0].style.display, 'block');

    const reloadButton = findByAttribute(applicationMenus[0], 'data-dsl4-menu-action', 'reload')[0];
    assert.equal(reloadButton.disabled, false);
    assert.equal(reloadButton.getAttribute('aria-disabled'), 'false');
    reloadButton.click();
    let sawReloadStart = false;
    const reloadDeadline = Date.now() + 5_000;
    while (Date.now() < reloadDeadline) {
      vm.runtime._step();
      const status = await extensionReporter(vm, 'statusReporter');
      if (status === 'starting' || status === 'running') sawReloadStart = true;
      if (sawReloadStart && status === 'menu') break;
      if (status === 'error') {
        assert.fail(`DSL 4.0 reload failed: ${await extensionReporter(vm, 'lastErrorReporter')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(sawReloadStart, true, 'Reload must start the packaged story again.');
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'menu');

    for (const target of vm.runtime.targets) {
      if (!target.isStage) target.setVisible(true);
    }
    vm.stopAll();
    vm.greenFlag();
    const restartDeadline = Date.now() + 5_000;
    while (Date.now() < restartDeadline) {
      vm.runtime._step();
      if ((await extensionReporter(vm, 'statusReporter')) === 'title') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'title');
    assert.equal(stage.sprite.costumes[stage.currentCostume].name, 'Title');
    assert.equal(titleControls.style.display, 'block');
    assert.equal(applicationMenus[0].style.display, 'none');
    assert.deepEqual(
      vm.runtime.targets
        .filter((target) => !target.isStage)
        .map((target) => ({name: target.getName(), visible: target.visible})),
      expectedDisplayNames.map((name) => ({name, visible: false})),
      'Red stop followed by the green flag must hide every actor and text target before title.',
    );
  } finally {
    vm.quit();
    restoreGlobals();
  }
}

test('returns a naturally finished embedded story to the menu and allows a restart', async () => {
  await assertNaturallyFinishedStoryReturnsToMenu(await buildEmbeddedStoryRelease(), [
    'Actor',
    'Narration',
  ]);
});

test('dispatches the packaged production scene-skip key into the next scene', async () => {
  const archive = await buildEmbeddedStoryRelease({navigationFixture: true});
  const restoreGlobals = installUnsandboxedScriptDom({withTitleUi: true});
  let editorKeydownCalls = 0;
  restoreGlobals.document.addEventListener('keydown', (event) => {
    editorKeydownCalls += 1;
    event.preventDefault();
  });
  const vm = new VirtualMachine();
  try {
    vm.setCompatibilityMode(false);
    vm.setTurboMode(false);
    vm.setCompilerOptions({enabled: false});
    vm.securityManager.canLoadExtensionFromProject = () => true;
    vm.securityManager.getSandboxMode = () => 'unsandboxed';
    await loadProjectQuietly(vm, archive);
    let nextSkinId = 1;
    let nextDrawableId = 1;
    for (const target of vm.runtime.targets) {
      target.drawableID = nextDrawableId;
      nextDrawableId += 1;
      for (const costume of target.sprite?.costumes ?? []) {
        costume.skinId = nextSkinId;
        nextSkinId += 1;
      }
    }
    vm.runtime.renderer = {
      draw() {},
      createSVGSkin() {
        return 1;
      },
      destroySkin() {},
      updateDrawableSkinId() {},
    };

    vm.greenFlag();
    const titleDeadline = Date.now() + 5_000;
    while (Date.now() < titleDeadline) {
      vm.runtime._step();
      if ((await extensionReporter(vm, 'statusReporter')) === 'title') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'title');
    const storyStart = extensionReporter(vm, 'closeTitle');
    void storyStart.catch(() => {});
    const actor = vm.runtime.targets.find((target) => target.getName() === 'Actor');
    assert(actor, 'The packaged navigation fixture must contain Actor.');
    const actorDeadline = Date.now() + 5_000;
    while (Date.now() < actorDeadline && !actor.visible) {
      vm.runtime._step();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(actor.visible, true, 'The opening scene must display Actor before navigation.');

    const sceneSkipEvent = restoreGlobals.document.dispatchKey('ArrowDown');
    assert.equal(sceneSkipEvent.defaultPrevented, true);
    assert.equal(
      editorKeydownCalls,
      0,
      'The runtime must capture a bound key before the TurboWarp Editor bubble handler.',
    );
    const endingDeadline = Date.now() + 5_000;
    while (Date.now() < endingDeadline && (!actor.visible || actor.x !== 123)) {
      vm.runtime._step();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(
      {visible: actor.visible, x: actor.x},
      {visible: true, x: 123},
      'ArrowDown must enter the ending scene and apply its first actor action.',
    );
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'running');
    vm.stopAll();
  } finally {
    vm.quit();
    restoreGlobals();
  }
});

test('returns an external-source story built from the minimal SB3 to the menu', async () => {
  await assertNaturallyFinishedStoryReturnsToMenu(await buildExternalSourceStoryRelease());
});

test('opens a selected .k4.yml project from the menu without adding Scratch targets', async () => {
  const result = await buildRelease();
  const restoreGlobals = installUnsandboxedScriptDom({withTitleUi: true});
  const source = browserFile(
    'selected.k4.yml',
    new TextEncoder().encode(`kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  selected:
    - wait: 0.1
`),
  );
  const vm = new VirtualMachine();
  try {
    vm.setCompatibilityMode(false);
    vm.setTurboMode(false);
    vm.setCompilerOptions({enabled: false});
    vm.securityManager.canLoadExtensionFromProject = () => true;
    vm.securityManager.getSandboxMode = () => 'unsandboxed';
    await loadProjectQuietly(vm, result.archive);
    let nextSkinId = 1;
    for (const target of vm.runtime.targets) {
      target.drawableID = nextSkinId;
      for (const costume of target.sprite?.costumes ?? []) {
        costume.skinId = nextSkinId;
        nextSkinId += 1;
      }
    }
    vm.runtime.renderer = {
      draw() {},
      createSVGSkin() {
        return 1;
      },
      destroySkin() {},
      updateDrawableSkinId() {},
    };

    vm.greenFlag();
    const titleDeadline = Date.now() + 5_000;
    while (Date.now() < titleDeadline) {
      vm.runtime._step();
      if ((await extensionReporter(vm, 'statusReporter')) === 'title') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await extensionReporter(vm, 'closeTitle');
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'menu');
    const applicationMenu = findByAttribute(
      restoreGlobals.document.body,
      'data-dsl4-application-menu',
      'true',
    )[0];
    assert(applicationMenu, 'The application menu must be mounted above the Stage.');
    findByAttribute(applicationMenu, 'data-dsl4-menu-action', 'open')[0].click();
    const input = restoreGlobals.document.body.children.find(
      (element) => element.tagName === 'INPUT' && element.type === 'file',
    );
    assert(input, 'Open must create a DSL 4.0 YAML file input.');
    assert.equal(input.multiple, false);
    assert.equal(input.webkitdirectory, undefined);
    assert.equal(input.getAttribute('webkitdirectory'), null);
    assert.equal(input.accept, '.yml,.yaml');
    input.files = [
      {
        ...source,
        webkitRelativePath: '',
      },
    ];
    input.dispatch('change');

    let sawSelectedStory = false;
    const storyDeadline = Date.now() + 5_000;
    while (Date.now() < storyDeadline) {
      vm.runtime._step();
      const status = await extensionReporter(vm, 'statusReporter');
      if (status === 'starting' || status === 'running') sawSelectedStory = true;
      if (sawSelectedStory && status === 'menu') break;
      if (status === 'error') {
        assert.fail(
          `Selected DSL 4.0 story failed: ${await extensionReporter(vm, 'lastErrorReporter')}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(sawSelectedStory, true);
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'menu');
    const reloadButton = findByAttribute(applicationMenu, 'data-dsl4-menu-action', 'reload')[0];
    assert.equal(reloadButton.disabled, false);
    assert.equal(reloadButton.getAttribute('aria-disabled'), 'false');
    assert.deepEqual(
      vm.runtime.targets.map((target) => target.getName()),
      ['Stage'],
    );
  } finally {
    vm.quit();
    restoreGlobals();
  }
});

test('localizes the existing Stage title without creating a DOM dialog', async () => {
  const result = await buildRelease();
  const restoreGlobals = installUnsandboxedScriptDom({withTitleUi: true});
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {language: 'ja-JP', languages: ['ja-JP', 'en-US']},
  });
  const vm = new VirtualMachine();
  try {
    vm.setCompatibilityMode(false);
    vm.setTurboMode(false);
    vm.setCompilerOptions({enabled: false});
    vm.securityManager.canLoadExtensionFromProject = () => true;
    vm.securityManager.getSandboxMode = () => 'unsandboxed';
    await loadProjectQuietly(vm, result.archive);
    const stage = vm.runtime.getTargetForStage();
    assert.equal(stage.sprite.costumes[stage.currentCostume].name, 'Title');
    vm.runtime.renderer = {
      draw() {},
      createSVGSkin() {
        return 1;
      },
      destroySkin() {},
      updateDrawableSkinId() {},
    };

    vm.greenFlag();
    const document = restoreGlobals.document;
    const titleDeadline = Date.now() + 5_000;
    while (Date.now() < titleDeadline) {
      vm.runtime._step();
      if ((await extensionReporter(vm, 'statusReporter')) === 'title') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'title');
    assert.equal(stage.sprite.costumes[stage.currentCostume].name, 'TitleRuntime');
    const titleControls = findByAttribute(document.body, 'data-dsl4-title-controls', 'true')[0];
    assert(titleControls, 'Localized title controls must be mounted above the Stage.');
    assert.equal(titleControls.style.display, 'block');
    const website = findByAttribute(titleControls, 'data-dsl4-title-action', 'website')[0];
    const close = findByAttribute(titleControls, 'data-dsl4-title-action', 'close')[0];
    assert.equal(website.getAttribute('aria-label'), '公式Webサイト');
    assert.equal(website.style.cssText.includes('top:25.5556%'), true);
    assert.equal(website.children[0].tagName, 'IMG');
    assert.match(website.children[0].src, /^data:image\/png;base64,/u);
    assert.match(website.children[0].style.cssText, /width:10cqw;height:10cqw/u);
    assert.match(website.children[1].style.cssText, /font-size:2\.5cqw/u);
    assert.doesNotMatch(website.children[0].style.cssText, /clamp|px/u);
    assert.doesNotMatch(website.children[1].style.cssText, /clamp|px/u);
    assert.equal(close.getAttribute('aria-label'), '閉じる');
    assert.equal(findByAttribute(document.body, 'data-dsl4-title-shell', 'true').length, 0);
    assert.equal(document.body.style.cursor, 'pointer');

    await extensionReporter(vm, 'closeTitle');
    const startupDeadline = Date.now() + 5_000;
    while (Date.now() < startupDeadline) {
      vm.runtime._step();
      const status = await extensionReporter(vm, 'statusReporter');
      if (status === 'menu') break;
      if (status === 'error') {
        assert.fail(`DSL 4.0 runtime failed: ${await extensionReporter(vm, 'lastErrorReporter')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'menu');
    assert.equal(stage.sprite.costumes[stage.currentCostume].name, 'MenuRuntime');
    assert.equal(titleControls.style.display, 'none');
    assert.equal(document.body.style.cursor, 'pointer');
  } finally {
    vm.quit();
    restoreGlobals();
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('logs and renders a pre-title Standard initialization failure', async () => {
  const result = await buildRelease();
  const restoreGlobals = installUnsandboxedScriptDom({withTitleUi: true});
  const originalConsoleError = console.error;
  const consoleErrors = [];
  const vm = new VirtualMachine();
  let originalToJSON;
  try {
    vm.setCompatibilityMode(false);
    vm.setTurboMode(false);
    vm.setCompilerOptions({enabled: false});
    vm.securityManager.canLoadExtensionFromProject = () => true;
    vm.securityManager.getSandboxMode = () => 'unsandboxed';
    await loadProjectQuietly(vm, result.archive);
    originalToJSON = vm.toJSON.bind(vm);
    vm.toJSON = () => '{';
    console.error = (...args) => consoleErrors.push(args);
    vm.runtime.renderer = {
      draw() {},
      createSVGSkin() {
        return 1;
      },
      destroySkin() {},
      updateDrawableSkinId() {},
    };

    await extensionReporter(vm, 'showTitle');
    assert.equal(await extensionReporter(vm, 'statusReporter'), 'error');
    const lastError = await extensionReporter(vm, 'lastErrorReporter');
    assert.equal(typeof lastError, 'string');
    assert.notEqual(lastError, '');
    const errorRoot = findByAttribute(
      restoreGlobals.document.body,
      'data-dsl4-runtime-error',
      'true',
    )[0];
    assert(errorRoot, 'The pre-title failure must be rendered inside the Scratch stage.');
    assert.equal(errorRoot.style.display, 'flex');
    const initializationLog = consoleErrors.find(
      ([message]) => message === '[Kamishibai DSL 4.0] initialization failed.',
    );
    assert(initializationLog, 'The pre-title failure must be written to console.error.');
    assert(initializationLog[1] instanceof Error);
    assert.equal(typeof initializationLog[1].stack, 'string');
    assert.match(initializationLog[1].stack, /JSON|Expected property|Unexpected/iu);
  } finally {
    if (originalToJSON) vm.toJSON = originalToJSON;
    vm.quit();
    console.error = originalConsoleError;
    restoreGlobals();
  }
});
