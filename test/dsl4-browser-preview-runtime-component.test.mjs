import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'vitest';

import {strToU8, zipSync} from 'fflate';

import {createDsl4ProductionSourceFrontend} from '../src/builder/dsl4-source-frontend.js';
import {createDsl4BrowserPreviewStoryFileProject} from '../src/dsl4/browser-preview-source-adapter.js';
import {createDsl4EmbeddedSourceDescriptor} from '../src/dsl4/source-descriptor.js';
import {createDsl4BrowserPreviewRuntimeComponent} from '../src/dsl4/platform/browser-preview-runtime-component.js';

const schema = JSON.parse(
  await readFile(new URL('../schema/dsl-4.schema.json', import.meta.url), 'utf8'),
);
const frontend = createDsl4ProductionSourceFrontend(schema);

function fileHandle(name, read) {
  return {
    kind: 'file',
    name,
    async getFile() {
      const bytes = new Uint8Array(read());
      return {
        name,
        size: bytes.byteLength,
        async arrayBuffer() {
          return bytes.slice().buffer;
        },
      };
    },
  };
}

function notFound() {
  return Object.assign(new Error('not found'), {name: 'NotFoundError'});
}

async function sourceResult(source) {
  const parsed = frontend.parse(source, {sourceId: 'main'});
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const sourceSnapshot = await createDsl4EmbeddedSourceDescriptor(source, {
    sourceId: 'main',
    displayName: 'story.kamishibai.yaml',
    maxSourceBytes: 64 * 1024,
    subtleCrypto: webcrypto.subtle,
  });
  return {...parsed, sourceSnapshot};
}

const storyWithEveryDelivery = `kamishibai: '4.0'
assets:
  DroppedBackdrop:
    kind: backdrop
    name: DroppedBackdrop
  DroppedSound:
    kind: sound
    name: DroppedSound
  LocalImage:
    kind: image
    file: assets/card.svg
  RemoteSound:
    kind: sound
    delivery: remote
    source:
      url: https://cdn.example.com/voice.ogg
      integrity: sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      contentType: audio/ogg
      size: 123
scenes:
  opening:
    - wait: 0
`;

test('prepares project, local-directory, and remote assets for one watched source generation', async () => {
  const localBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  let reads = 0;
  const assetsDirectory = {
    kind: 'directory',
    async getFileHandle(name) {
      if (name !== 'card.svg') throw notFound();
      return fileHandle(name, () => {
        reads += 1;
        return localBytes;
      });
    },
  };
  const projectRoot = {
    kind: 'directory',
    async getDirectoryHandle(name) {
      if (name === 'assets') return assetsDirectory;
      throw notFound();
    },
  };
  const result = await sourceResult(storyWithEveryDelivery);
  const baseComponent = {runtimeArtifact: {formatVersion: 1}};
  const component = await createDsl4BrowserPreviewRuntimeComponent({
    baseComponent,
    sourceResult: result,
    projectRoot,
    maxAssetFileBytes: 1024,
    maxAssetFiles: 8,
    maxAssetBytes: 4096,
    quietWindowMs: 0,
    sleep: async () => {},
    subtleCrypto: webcrypto.subtle,
  });

  assert.equal(component.storyDocument, result.storyDocument);
  assert.equal(component.sourceDescriptor, result.sourceSnapshot);
  assert.equal(reads, 2, 'local files must be captured by a stable double read');
  assert.deepEqual(
    component.assetBundle.manifest.assets.map(({id, source}) => ({id, source})),
    [
      {id: 'DroppedBackdrop', source: {type: 'project', name: 'DroppedBackdrop'}},
      {id: 'DroppedSound', source: {type: 'project', name: 'DroppedSound'}},
      {
        id: 'LocalImage',
        source: {
          type: 'file',
          inputPath: 'assets/card.svg',
          mode: 'file',
          files: [
            {
              path: 'card.svg',
              size: localBytes.byteLength,
              integrity: component.assetBundle.files[0].integrity,
            },
          ],
        },
      },
      {
        id: 'RemoteSound',
        source: {
          type: 'remote',
          url: 'https://cdn.example.com/voice.ogg',
          integrity: 'sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          contentType: 'audio/ogg',
          size: 123,
        },
      },
    ],
  );
  assert.deepEqual(component.getAssetFile('LocalImage', 'card.svg'), localBytes);
});

test('reports the exact missing project asset path to the author UI boundary', async () => {
  const projectRoot = {
    kind: 'directory',
    async getDirectoryHandle() {
      throw notFound();
    },
  };

  await assert.rejects(
    createDsl4BrowserPreviewRuntimeComponent({
      baseComponent: {},
      sourceResult: await sourceResult(storyWithEveryDelivery),
      projectRoot,
      maxAssetFileBytes: 1024,
      maxAssetFiles: 8,
      maxAssetBytes: 4096,
      quietWindowMs: 0,
      sleep: async () => {},
      subtleCrypto: webcrypto.subtle,
    }),
    (error) => {
      assert.equal(error.code, 'K4-ASSET-MISSING');
      assert.equal(error.displayName, 'assets/card.svg');
      assert.equal(error.path, '$.assets["LocalImage"].file');
      assert.match(error.message, /assets\/card\.svg/u);
      return true;
    },
  );
});

test('rejects local sibling assets when the author opens only a story file', async () => {
  const sourceHandle = fileHandle('story.kamishibai.yaml', () =>
    new TextEncoder().encode(storyWithEveryDelivery),
  );
  const projectRoot = createDsl4BrowserPreviewStoryFileProject(sourceHandle);

  await assert.rejects(
    createDsl4BrowserPreviewRuntimeComponent({
      baseComponent: {},
      sourceResult: await sourceResult(storyWithEveryDelivery),
      projectRoot,
      maxAssetFileBytes: 1024,
      maxAssetFiles: 8,
      maxAssetBytes: 4096,
      quietWindowMs: 0,
      sleep: async () => {},
      subtleCrypto: webcrypto.subtle,
    }),
    (error) => error.code === 'K4-ASSET-PROJECT-DIRECTORY-REQUIRED',
  );
});

test('extracts a local pose archive during watched browser preview capture', async () => {
  const archive = zipSync({
    'metadata.json': strToU8('{"labels":["rescue"]}'),
    'model.json': strToU8('{"weightsManifest":[{"paths":["weights.bin"]}]}'),
    'weights.bin': new Uint8Array([1, 2, 3]),
  });
  let reads = 0;
  const modelsDirectory = {
    kind: 'directory',
    async getFileHandle(name) {
      assert.equal(name, 'rescue.ZIP');
      return fileHandle(name, () => {
        reads += 1;
        return archive;
      });
    },
  };
  const projectRoot = {
    kind: 'directory',
    async getDirectoryHandle(name) {
      assert.equal(name, 'models');
      return modelsDirectory;
    },
  };
  const result = await sourceResult(`kamishibai: '4.0'
assets:
  Rescue:
    kind: recognitionModel
    file: models/rescue.ZIP
scenes:
  opening:
    recognitionModel: Rescue
    actions: []
`);
  const component = await createDsl4BrowserPreviewRuntimeComponent({
    baseComponent: {runtimeArtifact: {formatVersion: 1}},
    sourceResult: result,
    projectRoot,
    maxAssetFileBytes: 4096,
    maxAssetFiles: 8,
    maxAssetBytes: 8192,
    quietWindowMs: 0,
    sleep: async () => {},
    subtleCrypto: webcrypto.subtle,
  });

  assert.equal(reads, 2, 'pose archives must participate in stable double-read capture');
  const pose = component.assetBundle.manifest.assets[0];
  assert.equal(pose.source.mode, 'archive');
  assert.deepEqual(
    pose.source.files.map((file) => file.path),
    ['metadata.json', 'model.json', 'weights.bin'],
  );
  assert.deepEqual(component.getAssetFile('Rescue', 'weights.bin'), new Uint8Array([1, 2, 3]));
});

test('rejects an asset generation that changes between the two stable reads', async () => {
  let bytes = new Uint8Array([1]);
  const projectRoot = {
    kind: 'directory',
    async getDirectoryHandle(name) {
      assert.equal(name, 'assets');
      return {
        kind: 'directory',
        async getFileHandle(fileName) {
          assert.equal(fileName, 'card.svg');
          return fileHandle(fileName, () => bytes);
        },
      };
    },
  };

  await assert.rejects(
    createDsl4BrowserPreviewRuntimeComponent({
      baseComponent: {},
      sourceResult: await sourceResult(storyWithEveryDelivery),
      projectRoot,
      maxAssetFileBytes: 1024,
      maxAssetFiles: 8,
      maxAssetBytes: 4096,
      quietWindowMs: 1,
      sleep: async () => {
        bytes = new Uint8Array([2]);
      },
      subtleCrypto: webcrypto.subtle,
    }),
    (error) => error.code === 'K4-ASSET-UNSTABLE-001',
  );
});
