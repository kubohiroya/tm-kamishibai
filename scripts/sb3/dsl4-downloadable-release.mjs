import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

import {build} from 'esbuild';

import {installDsl4PackagedRuntimeComponent} from '../../src/builder/dsl4-source.js';
import {createDsl4ProductionSourceFrontend} from '../../src/builder/dsl4-source-frontend.js';
import {createDsl4EmbeddedAssetBundle} from '../../src/dsl4/asset-bundle-descriptor.js';
import {createDsl4RuntimeArtifactDescriptor} from '../../src/dsl4/runtime-artifact-descriptor.js';
import {createDsl4EmbeddedSourceDescriptor} from '../../src/dsl4/source-descriptor.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const releaseDirectory = path.join(projectRoot, 'release-sources', '4.0.0', 'app');
const extensionId = 'kubohiroyakamishibairuntime4';
const extensionPath = `extensions/${extensionId}.js`;
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
  maxSourceBytes: 64 * 1024,
  maxAssetFiles: 64,
  maxAssetBytes: 64 * 1024 * 1024,
});

function md5(contents) {
  return createHash('md5').update(contents).digest('hex');
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
  <text x="240" y="58" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#007d66">Kamishibai DSL 4.0</text>
  <text x="240" y="92" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#006b58">Version {{VERSION}} ({{BUILD_DATE}})</text>
  <text x="240" y="138" text-anchor="middle" font-family="sans-serif" font-size="20">{{ABOUT_TITLE}}</text>
  <text x="240" y="174" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_LICENSE_APP_LINE_1}}</text>
  <text x="240" y="192" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_LICENSE_APP_LINE_2}}</text>
  <text x="240" y="218" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_LICENSE_STORY_LINE_1}}</text>
  <text x="240" y="236" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_LICENSE_STORY_LINE_2}}</text>
  <text x="240" y="270" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_AUTHOR_ORGANIZATION_LINE_1}}</text>
  <text x="240" y="288" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_AUTHOR_ORGANIZATION_LINE_2}}</text>
  <text x="240" y="316" text-anchor="middle" font-family="sans-serif" font-size="12">{{ABOUT_AUTHOR_NAME}} / {{ABOUT_AUTHOR_EMAIL}}</text>
</svg>`,
    240,
    180,
  );
  const titleRuntime = svgAsset(
    'TitleRuntime',
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">
  <rect width="480" height="360" fill="#f4fffb"/>
  <text x="240" y="180" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#007d66">Kamishibai DSL 4.0</text>
</svg>`,
    240,
    180,
  );
  const websiteFallback = svgAsset(
    'official-website-button',
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="64" viewBox="0 0 160 64">
  <rect width="160" height="64" rx="12" fill="#007d66"/>
  <image href="data:image/png;base64,{{OFFICIAL_WEBSITE_FAVICON}}" x="8" y="8" width="48" height="48"/>
  <text x="104" y="38" text-anchor="middle" font-family="sans-serif" font-size="12" fill="white">{{ABOUT_OFFICIAL_WEBSITE_NAME}}</text>
</svg>`,
    80,
    32,
  );
  const websiteRuntime = svgAsset(
    'official-website-button-runtime',
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="#007d66"/>
  <image href="data:image/png;base64,{{OFFICIAL_WEBSITE_FAVICON}}" x="8" y="8" width="48" height="48"/>
</svg>`,
    32,
    32,
  );
  return Object.freeze([title, titleRuntime, websiteFallback, websiteRuntime]);
}

function stageTarget(title, titleRuntime) {
  return {
    isStage: true,
    name: 'Stage',
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: {
      titleSetVersion: {
        opcode: 'kubohiroyakamishibairuntime4_setTextValue',
        next: null,
        parent: null,
        inputs: {
          NAME: [1, [10, 'about.version']],
          VALUE: [1, [10, 'Version {{VERSION}} ({{BUILD_DATE}})']],
        },
        fields: {},
        shadow: false,
        topLevel: true,
        x: 0,
        y: 0,
      },
    },
    comments: {},
    currentCostume: 0,
    costumes: [title.costume, titleRuntime.costume],
    sounds: [],
    volume: 100,
    layerOrder: 0,
    tempo: 60,
    videoTransparency: 50,
    videoState: 'on',
    textToSpeechLanguage: null,
  };
}

function websiteTarget(websiteFallback, websiteRuntime) {
  return {
    isStage: false,
    name: 'officialWebsiteButton',
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [websiteFallback.costume, websiteRuntime.costume],
    sounds: [],
    volume: 100,
    layerOrder: 1,
    visible: false,
    x: 0,
    y: 0,
    size: 100,
    direction: 90,
    draggable: false,
    rotationStyle: 'all around',
  };
}

async function createProject(assets) {
  const [title, titleRuntime, websiteFallback, websiteRuntime] = assets;
  const project = {
    targets: [stageTarget(title, titleRuntime), websiteTarget(websiteFallback, websiteRuntime)],
    monitors: [],
    extensions: [extensionId],
    extensionURLs: {[extensionId]: `embedded-extension:${extensionPath}`},
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
  return installDsl4PackagedRuntimeComponent(
    project,
    parsed.storyDocument,
    sourceDescriptor,
    artifactResult.artifact,
    assetBundle,
    {
      channel: 'unbundled',
      ...limits,
      subtleCrypto: webcrypto.subtle,
    },
  );
}

async function createExtensionBundle() {
  const result = await build({
    entryPoints: [path.join(projectRoot, 'scripts/sb3/dsl4-runtime-extension-entry.js')],
    bundle: true,
    charset: 'utf8',
    format: 'iife',
    legalComments: 'none',
    logLevel: 'silent',
    minify: true,
    platform: 'browser',
    target: ['es2022'],
    write: false,
  });
  assert.equal(result.outputFiles.length, 1);
  return Buffer.from(result.outputFiles[0].contents);
}

async function expectedFiles() {
  const assets = titleAssets();
  const project = await createProject(assets);
  const archiveEntries = ['project.json', ...assets.map(({filename}) => filename)];
  const files = new Map([
    ['project.source.json', Buffer.from(`${JSON.stringify(project, null, 2)}\n`)],
    [
      'embedded-extensions.json',
      Buffer.from(
        `${JSON.stringify(
          {
            formatVersion: 1,
            extensions: [
              {
                id: extensionId,
                path: extensionPath,
                mediaType: 'text/javascript',
                parameters: [],
                encoding: 'base64',
              },
            ],
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
    [extensionPath, await createExtensionBundle()],
  ]);
  for (const asset of assets) files.set(`assets/${asset.filename}`, asset.bytes);
  return files;
}

async function listFiles(directory, relative = '') {
  const entries = await readdir(directory, {withFileTypes: true});
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const nested = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory())
      files.push(...(await listFiles(path.join(directory, entry.name), nested)));
    else if (entry.isFile()) files.push(nested);
    else throw new Error(`Unsupported release source entry: ${nested}`);
  }
  return files;
}

async function writeRelease(files) {
  await rm(releaseDirectory, {force: true, recursive: true});
  for (const [relativePath, contents] of files) {
    const outputPath = path.join(releaseDirectory, relativePath);
    await mkdir(path.dirname(outputPath), {recursive: true});
    await writeFile(outputPath, contents);
  }
  process.stdout.write(`Wrote ${files.size} DSL 4.0 release source file(s).\n`);
}

async function checkRelease(files) {
  const actualFiles = await listFiles(releaseDirectory);
  assert.deepEqual(
    actualFiles,
    [...files.keys()].sort((left, right) => left.localeCompare(right, 'en')),
  );
  for (const [relativePath, expected] of files) {
    const actual = await readFile(path.join(releaseDirectory, relativePath));
    assert(actual.equals(expected), `DSL 4.0 release source is stale: ${relativePath}`);
  }
  process.stdout.write(`Verified ${files.size} DSL 4.0 release source file(s).\n`);
}

const files = await expectedFiles();
if (process.argv.includes('--write')) await writeRelease(files);
else await checkRelease(files);
