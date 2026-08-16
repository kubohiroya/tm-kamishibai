import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

import {build} from 'esbuild';
import {buildExtensionBundles} from '@kubohiroya/sb3-toolchain';

import {installDsl4PackagedRuntimeComponent} from '../../src/builder/dsl4-source.js';
import {createDsl4ProductionSourceFrontend} from '../../src/builder/dsl4-source-frontend.js';
import {createDsl4EmbeddedAssetBundle} from '../../src/dsl4/asset-bundle-descriptor.js';
import {createDsl4RuntimeArtifactDescriptor} from '../../src/dsl4/runtime-artifact-descriptor.js';
import {createDsl4EmbeddedSourceDescriptor} from '../../src/dsl4/source-descriptor.js';
import {createDsl4PoseNetProjectBundleFromLoader} from '../../src/dsl4/platform/posenet-bundle.js';
import {
  dsl4RuntimeProvenance,
  formatDsl4RuntimeExtensionHeader,
} from '../../src/dsl4/runtime-provenance.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const tensorflowBrowserRuntimePath = require.resolve('@tensorflow/tfjs/dist/tf.min.js');
const tmPoseBrowserRuntimePath =
  require.resolve('@teachablemachine/pose/dist/teachablemachine-pose.min.js');
const tmPoseWebpackLoader = 'function n(r){if(e[r])';
const tmPoseWebpackLoaderWithSharedTensorflow =
  'function n(r){if(0===r)return globalThis.tf;if(e[r])';
const officialWebsiteFaviconPath = path.join(projectRoot, 'site/favicon.png');
const applicationMenuIconPaths = Object.freeze({
  open: path.join(projectRoot, 'scripts/sb3/assets/application-menu-open.svg'),
  reload: path.join(projectRoot, 'scripts/sb3/assets/application-menu-reload.svg'),
  about: path.join(projectRoot, 'scripts/sb3/assets/application-menu-about.svg'),
  language: path.join(projectRoot, 'scripts/sb3/assets/application-menu-language.svg'),
});
const extensionId = 'kubohiroyakamishibai4';
const runtimeExtensionId = 'kubohiroyakamishibairuntime4';
const runtimeExtensionPath = `extensions/${runtimeExtensionId}.js`;
const externalExtensionMembers = Object.freeze(
  [
    {
      id: 'kubohiroyaassetmanager',
      name: 'Asset Manager',
      package: '@kubohiroya/turbowarp-asset-manager',
      version: '0.11.0',
      artifact: 'dist/asset-manager.js',
      sourcePath: path.join(
        path.dirname(
          fileURLToPath(import.meta.resolve('@kubohiroya/turbowarp-asset-manager/composition')),
        ),
        'asset-manager.js',
      ),
    },
    {
      id: 'kubohiroyaasyncinput',
      name: 'Async Input',
      package: '@kubohiroya/turbowarp-async-input',
      version: '0.4.0',
      artifact: 'dist/async-input.js',
      sourcePath: path.join(
        path.dirname(
          fileURLToPath(import.meta.resolve('@kubohiroya/turbowarp-async-input/composition')),
        ),
        'async-input.js',
      ),
    },
    {
      id: 'kubohiroyabubble',
      name: 'Bubble',
      package: '@kubohiroya/turbowarp-bubble',
      version: '0.7.0',
      artifact: 'dist/turbowarp-bubble.js',
      sourcePath: path.join(
        path.dirname(
          fileURLToPath(import.meta.resolve('@kubohiroya/turbowarp-bubble/composition')),
        ),
        'turbowarp-bubble.js',
      ),
    },
    {
      id: 'kubohiroyaruntimeexpression',
      name: 'Runtime Expression',
      package: '@kubohiroya/turbowarp-runtime-expression',
      version: '0.4.0',
      artifact: 'dist/runtime-expression.js',
      sourcePath: path.join(
        path.dirname(
          fileURLToPath(
            import.meta.resolve('@kubohiroya/turbowarp-runtime-expression/composition'),
          ),
        ),
        'runtime-expression.js',
      ),
    },
    {
      id: 'kubohiroyasvgtext',
      name: 'SVG Text',
      package: '@kubohiroya/turbowarp-svg-text',
      version: '0.5.0',
      artifact: 'dist/svg-text.js',
      sourcePath: path.join(
        path.dirname(
          fileURLToPath(import.meta.resolve('@kubohiroya/turbowarp-svg-text/composition')),
        ),
        'svg-text.js',
      ),
    },
    {
      id: 'tmpose',
      name: 'TMPose',
      package: '@kubohiroya/turbowarp-tmpose',
      version: '1.10.3',
      artifact: 'dist/tmpose.js',
      sourcePath: path.join(
        path.dirname(
          fileURLToPath(import.meta.resolve('@kubohiroya/turbowarp-tmpose/composition')),
        ),
        'tmpose.js',
      ),
    },
  ].map((member) => Object.freeze({...member, path: `extensions/${member.id}.js`})),
);
const bundleMemberIds = Object.freeze([
  runtimeExtensionId,
  ...externalExtensionMembers.map(({id}) => id),
]);
const extensionBundle = Object.freeze({
  id: extensionId,
  name: 'Kamishibai DSL 4.0 Runtime',
  members: [...bundleMemberIds],
  recoveryCapsule: false,
});
const closeTitleBroadcastId = 'closeTitleMessage';
const closeTitleBroadcastName = 'closeTitle';
const poseConfidenceVariableId = 'dsl4-pose-confidence';
const poseProgressVariableId = 'dsl4-pose-progress';
const sourceText = `kamishibai: '4.0'
controls:
  keymaps:
    production:
      Space: navigation.nextAction
scenes:
  opening:
    - wait: 0
`;
const limits = Object.freeze({
  maxSourceBytes: 1024 * 1024,
  maxAssetFiles: 64,
  maxAssetBytes: 64 * 1024 * 1024,
});
const runtimeProfiles = new Set(['authoring', 'playback']);
const runtimeExtensionEntryPath = path.join(
  projectRoot,
  'scripts/sb3/dsl4-runtime-extension-entry.js',
);
let pendingPoseNetProjectBundle;

function createPoseNetProjectBundle() {
  pendingPoseNetProjectBundle ??= createDsl4PoseNetProjectBundleFromLoader(
    async ({packageSpecifier}) =>
      new Uint8Array(await readFile(fileURLToPath(import.meta.resolve(packageSpecifier)))),
    {subtleCrypto: webcrypto.subtle},
  );
  return pendingPoseNetProjectBundle;
}

function md5(contents) {
  return createHash('md5').update(contents).digest('hex');
}

function sha256Sri(contents) {
  return `sha256-${createHash('sha256').update(contents).digest('base64')}`;
}

function svgAsset(name, source, rotationCenterX, rotationCenterY) {
  const bytes = Buffer.from(`${source.trim()}\n`);
  const assetId = md5(bytes);
  return Object.freeze({
    bytes,
    filename: `${assetId}.svg`,
    costume: {
      assetId,
      name,
      bitmapResolution: 1,
      dataFormat: 'svg',
      md5ext: `${assetId}.svg`,
      rotationCenterX,
      rotationCenterY,
    },
  });
}

function titleAssets() {
  const title = svgAsset(
    'Title',
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">
  <rect width="480" height="360" fill="#f4fffb"/>
  <text x="240" y="40" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#007d66">{{ABOUT_TITLE}}</text>
  <text x="240" y="68" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#006b58">Version {{VERSION}} ({{BUILD_DATE}})</text>
  <text x="240" y="194" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_LICENSE_APP_LINE_1}}</text>
  <text x="240" y="210" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_LICENSE_APP_LINE_2}}</text>
  <text x="240" y="234" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_LICENSE_STORY_LINE_1}}</text>
  <text x="240" y="250" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_LICENSE_STORY_LINE_2}}</text>
  <text x="240" y="282" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_AUTHOR_ORGANIZATION_LINE_1}}</text>
  <text x="240" y="298" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_AUTHOR_ORGANIZATION_LINE_2}}</text>
  <text x="240" y="326" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_AUTHOR_NAME}} &lt;{{ABOUT_AUTHOR_EMAIL}}&gt;</text>
</svg>`,
    240,
    180,
  );
  const titleRuntime = svgAsset(
    'TitleRuntime',
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">
  <metadata>locale:ja</metadata>
  <rect width="480" height="360" fill="#f4fffb"/>
  <text x="240" y="40" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#007d66">{{ABOUT_TITLE}}</text>
  <text x="240" y="68" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#006b58">Version {{VERSION}} ({{BUILD_DATE}})</text>
  <text x="240" y="194" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_LICENSE_APP_LINE_1}}</text>
  <text x="240" y="210" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_LICENSE_APP_LINE_2}}</text>
  <text x="240" y="234" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_LICENSE_STORY_LINE_1}}</text>
  <text x="240" y="250" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_LICENSE_STORY_LINE_2}}</text>
  <text x="240" y="282" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_AUTHOR_ORGANIZATION_LINE_1}}</text>
  <text x="240" y="298" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_AUTHOR_ORGANIZATION_LINE_2}}</text>
  <text x="240" y="326" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_AUTHOR_NAME}} &lt;{{ABOUT_AUTHOR_EMAIL}}&gt;</text>
</svg>`,
    240,
    180,
  );
  const menu = svgAsset(
    'Menu',
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">
  <rect width="480" height="360" fill="#f4fffb"/>
  <text x="240" y="52" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#007d66">Participatory AI Kamishibai</text>
</svg>`,
    240,
    180,
  );
  const menuRuntime = svgAsset(
    'MenuRuntime',
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">
  <metadata>locale:ja</metadata>
  <rect width="480" height="360" fill="#f4fffb"/>
  <text x="240" y="52" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#007d66">「参加型」AI紙芝居</text>
</svg>`,
    240,
    180,
  );
  return Object.freeze([title, titleRuntime, menu, menuRuntime]);
}

function stageTarget(title, titleRuntime, menu, menuRuntime) {
  return {
    isStage: true,
    name: 'Stage',
    variables: {
      [poseConfidenceVariableId]: ['ポーズ認識', 0],
      [poseProgressVariableId]: ['チャージ', 0],
    },
    lists: {},
    broadcasts: {
      [closeTitleBroadcastId]: closeTitleBroadcastName,
    },
    blocks: {
      titleFlag: {
        opcode: 'event_whenflagclicked',
        next: 'titleFlagShow',
        parent: null,
        inputs: {},
        fields: {},
        shadow: false,
        topLevel: true,
        x: 0,
        y: 0,
      },
      titleFlagShow: {
        opcode: `${runtimeExtensionId}_showTitle`,
        next: null,
        parent: 'titleFlag',
        inputs: {},
        fields: {},
        shadow: false,
        topLevel: false,
      },
      titleSetVersion: {
        opcode: `${runtimeExtensionId}_setTextValue`,
        next: null,
        parent: null,
        inputs: {
          NAME: [1, [10, 'about.version']],
          VALUE: [1, [10, 'Version {{VERSION}} ({{BUILD_DATE}})']],
        },
        fields: {},
        shadow: false,
        topLevel: true,
        x: 240,
        y: 0,
      },
      titleStageClick: {
        opcode: 'event_whenstageclicked',
        next: 'titleStageClickClose',
        parent: null,
        inputs: {},
        fields: {},
        shadow: false,
        topLevel: true,
        x: 0,
        y: 120,
      },
      titleStageClickClose: {
        opcode: 'event_broadcast',
        next: null,
        parent: 'titleStageClick',
        inputs: {
          BROADCAST_INPUT: [1, [11, closeTitleBroadcastName, closeTitleBroadcastId]],
        },
        fields: {},
        shadow: false,
        topLevel: false,
      },
      titleCloseHat: {
        opcode: 'event_whenbroadcastreceived',
        next: 'titleCloseStart',
        parent: null,
        inputs: {},
        fields: {
          BROADCAST_OPTION: [closeTitleBroadcastName, closeTitleBroadcastId],
        },
        shadow: false,
        topLevel: true,
        x: 0,
        y: 240,
      },
      titleCloseStart: {
        opcode: `${runtimeExtensionId}_closeTitle`,
        next: null,
        parent: 'titleCloseHat',
        inputs: {},
        fields: {},
        shadow: false,
        topLevel: false,
      },
    },
    comments: {},
    currentCostume: 0,
    costumes: [title.costume, titleRuntime.costume, menu.costume, menuRuntime.costume],
    sounds: [],
    volume: 100,
    layerOrder: 0,
    tempo: 60,
    videoTransparency: 50,
    videoState: 'on',
    textToSpeechLanguage: null,
  };
}

function poseFeedbackMonitors() {
  return [
    {
      id: poseConfidenceVariableId,
      mode: 'slider',
      opcode: 'data_variable',
      params: {VARIABLE: 'ポーズ認識'},
      spriteName: null,
      value: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      visible: false,
      sliderMin: 0,
      sliderMax: 100,
      isDiscrete: true,
    },
    {
      id: poseProgressVariableId,
      mode: 'slider',
      opcode: 'data_variable',
      params: {VARIABLE: 'チャージ'},
      spriteName: null,
      value: 0,
      width: 0,
      height: 0,
      x: 343,
      y: 0,
      visible: false,
      sliderMin: 0,
      sliderMax: 100,
      isDiscrete: true,
    },
  ];
}

async function createProject(assets) {
  const [title, titleRuntime, menu, menuRuntime] = assets;
  const project = {
    targets: [stageTarget(title, titleRuntime, menu, menuRuntime)],
    monitors: poseFeedbackMonitors(),
    extensions: [...bundleMemberIds],
    extensionURLs: Object.fromEntries([
      [runtimeExtensionId, `embedded-extension:${runtimeExtensionPath}`],
      ...externalExtensionMembers.map((member) => [member.id, `embedded-extension:${member.path}`]),
    ]),
    extensionStorage: {},
    meta: {
      semver: '3.0.0',
      vm: '0.2.0-turbowarp-c4823421cb7c17d8d8a89878851ce1668c26a21f',
      agent: 'tmpose-kamishibai DSL 4.0 release generator',
    },
  };
  const schema = JSON.parse(
    await readFile(path.join(projectRoot, 'schema/dsl-4.schema.json'), 'utf8'),
  );
  const frontend = createDsl4ProductionSourceFrontend(schema);
  const parsed = frontend.parse(sourceText, {sourceId: 'main'});
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const sourceDescriptor = await createDsl4EmbeddedSourceDescriptor(sourceText, {
    sourceId: 'main',
    displayName: 'story.kamishibai.yaml',
    maxSourceBytes: limits.maxSourceBytes,
    subtleCrypto: webcrypto.subtle,
  });
  const artifactResult = await createDsl4RuntimeArtifactDescriptor(
    parsed.storyDocument,
    sourceDescriptor,
    'production',
    {maxSourceBytes: limits.maxSourceBytes, subtleCrypto: webcrypto.subtle},
  );
  assert.equal(artifactResult.ok, true, JSON.stringify(artifactResult.diagnostics));
  const assetBundle = await createDsl4EmbeddedAssetBundle(
    parsed.storyDocument,
    {manifest: {formatVersion: 1, assets: []}, getFile() {}},
    {
      maxFiles: limits.maxAssetFiles,
      maxTotalBytes: limits.maxAssetBytes,
      subtleCrypto: webcrypto.subtle,
    },
  );
  const poseNetBundle = await createPoseNetProjectBundle();
  const installed = await installDsl4PackagedRuntimeComponent(
    project,
    parsed.storyDocument,
    sourceDescriptor,
    artifactResult.artifact,
    assetBundle,
    {
      channel: 'unbundled',
      ...limits,
      poseNetBundle,
      subtleCrypto: webcrypto.subtle,
    },
  );
  installed.extensionStorage[runtimeExtensionId].application = {mode: 'menu'};
  return installed;
}

export async function createDsl4RuntimeExtensionSource({profile = 'authoring'} = {}) {
  if (!runtimeProfiles.has(profile)) {
    throw new TypeError('DSL 4.0 runtime profile must be authoring or playback');
  }
  const [
    tensorflowBrowserRuntime,
    tmPoseBrowserRuntime,
    officialWebsiteFavicon,
    ...applicationMenuIconFiles
  ] = await Promise.all([
    readFile(tensorflowBrowserRuntimePath, 'utf8'),
    readFile(tmPoseBrowserRuntimePath, 'utf8'),
    readFile(officialWebsiteFaviconPath),
    ...Object.values(applicationMenuIconPaths).map((filename) => readFile(filename)),
  ]);
  const applicationMenuIcons = Object.fromEntries(
    Object.keys(applicationMenuIconPaths).map((action, index) => [
      action,
      `data:image/svg+xml;base64,${applicationMenuIconFiles[index].toString('base64')}`,
    ]),
  );
  const tmPoseRuntimeWithSharedTensorflow = tmPoseBrowserRuntime.replace(
    tmPoseWebpackLoader,
    tmPoseWebpackLoaderWithSharedTensorflow,
  );
  assert.notEqual(
    tmPoseRuntimeWithSharedTensorflow,
    tmPoseBrowserRuntime,
    'The pinned Teachable Machine Pose bundle no longer has the expected Webpack loader.',
  );
  const result = await build({
    entryPoints: [runtimeExtensionEntryPath],
    bundle: true,
    charset: 'utf8',
    define: {
      DSL4_APPLICATION_MENU_ICONS: JSON.stringify(applicationMenuIcons),
      DSL4_OFFICIAL_WEBSITE_ICON: JSON.stringify(
        `data:image/png;base64,${officialWebsiteFavicon.toString('base64')}`,
      ),
      DSL4_AUTHORING_PROFILE: JSON.stringify(profile === 'authoring'),
    },
    format: 'iife',
    banner: {
      // Compatibility fallback until turbowarp-tmpose publishes one reviewed browser runtime.
      // TM Pose directly references global `tf`; its embedded module 0 is routed to that instance.
      js:
        `${formatDsl4RuntimeExtensionHeader()}\n` +
        `(function (exports, module, define, require, process) {\n${tensorflowBrowserRuntime}\n` +
        `}).call(globalThis);\n${tmPoseRuntimeWithSharedTensorflow}\n`,
    },
    legalComments: 'eof',
    logLevel: 'silent',
    minify: true,
    platform: 'browser',
    target: ['es2022'],
    write: false,
  });
  assert.equal(result.outputFiles.length, 1);
  return Buffer.from(result.outputFiles[0].contents);
}

async function loadExternalExtensionSources() {
  return Promise.all(
    externalExtensionMembers.map(async (member) => ({
      ...member,
      contents: await readFile(member.sourcePath),
    })),
  );
}

function extensionSourceDescriptors(externalExtensionSources) {
  return [
    {
      id: runtimeExtensionId,
      path: runtimeExtensionPath,
      mediaType: 'text/javascript',
      parameters: [],
      encoding: 'base64',
    },
    ...externalExtensionSources.map((member) => ({
      id: member.id,
      path: member.path,
      mediaType: 'text/javascript',
      parameters: [],
      encoding: 'base64',
      source: {
        provider: 'npm',
        package: member.package,
        version: member.version,
        artifact: member.artifact,
        integrity: sha256Sri(member.contents),
      },
    })),
  ];
}

export async function createDsl4RuntimeBundleSource({profile = 'authoring'} = {}) {
  const [runtimeExtensionSource, externalExtensionSources] = await Promise.all([
    createDsl4RuntimeExtensionSource({profile}),
    loadExternalExtensionSources(),
  ]);
  const extensions = extensionSourceDescriptors(externalExtensionSources);
  const extensionContents = new Map([
    [runtimeExtensionId, runtimeExtensionSource],
    ...externalExtensionSources.map((member) => [member.id, member.contents]),
  ]);
  const project = {
    extensions: [...bundleMemberIds],
    extensionURLs: Object.fromEntries(
      bundleMemberIds.map((memberId) => [memberId, `embedded-extension:extensions/${memberId}.js`]),
    ),
  };
  const bundled = buildExtensionBundles({
    extensionBundles: [extensionBundle],
    extensionContents,
    extensions,
    project,
  });
  const source = bundled.extensionContents.get(extensionId);
  assert(source, 'The DSL 4.0 runtime bundle source was not generated.');
  return Buffer.from(String(source).replace(/^ +(?=\t)/gmu, ''));
}

export async function createDsl4ReleaseSourceFiles() {
  const assets = titleAssets();
  const project = await createProject(assets);
  const [runtimeExtensionSource, externalExtensionSources] = await Promise.all([
    createDsl4RuntimeExtensionSource(),
    loadExternalExtensionSources(),
  ]);
  const archiveEntries = ['project.json', ...assets.map(({filename}) => filename)];
  const files = new Map([
    ['project.source.json', Buffer.from(`${JSON.stringify(project, null, 2)}\n`)],
    [
      'embedded-extensions.json',
      Buffer.from(
        `${JSON.stringify(
          {
            formatVersion: 1,
            extensions: extensionSourceDescriptors(externalExtensionSources),
            extensionBundles: [extensionBundle],
            sourceNotices: dsl4RuntimeProvenance,
          },
          null,
          2,
        )}\n`,
      ),
    ],
    [
      'sb3-source.json',
      Buffer.from(
        `${JSON.stringify(
          {
            formatVersion: 1,
            project: 'project.source.json',
            embeddedExtensions: 'embedded-extensions.json',
            assetsDirectory: 'assets',
            archiveEntries,
          },
          null,
          2,
        )}\n`,
      ),
    ],
    [runtimeExtensionPath, runtimeExtensionSource],
  ]);
  for (const member of externalExtensionSources) files.set(member.path, member.contents);
  for (const asset of assets) files.set(`assets/${asset.filename}`, asset.bytes);
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(
    !process.argv.includes('--write'),
    'Direct release source writes are disabled. Run pnpm release:dsl4:update.',
  );
  const files = await createDsl4ReleaseSourceFiles();
  process.stdout.write(`Generated ${files.size} transient DSL 4 release source file(s).\n`);
}
