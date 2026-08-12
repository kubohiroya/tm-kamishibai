import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {strToU8, unzipSync, zipSync} from 'fflate';
import {parse} from 'yaml';

import {
  convertDsl4ProjectAssets,
  createDsl4ProductionSourceFrontend,
  loadDsl4ExternalSource,
  loadDsl4LocalAssetSnapshot,
} from '../src/builder/index.js';
import {md5, sha256} from '../src/builder/hash.js';
import {readSb3} from '../src/builder/sb3.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(repositoryRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const sourceFrontend = createDsl4ProductionSourceFrontend(schema);
const localBytes = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360"/></svg>',
);
const projectBytes = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240"><rect width="320" height="240"/></svg>',
);
const remoteBytes = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480"/></svg>',
);
const poseFiles = {
  'model.json': Buffer.from('{"model":"rescue"}'),
  'metadata.json': Buffer.from('{"labels":["help"]}'),
  'weights.bin': Buffer.from([1, 2, 3, 4]),
};
const opaquePoseZip = Buffer.from(zipSync(poseFiles, {level: 0}));

function wavBytes() {
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(40, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(4, 40);
  bytes.writeInt16LE(1, 44);
  bytes.writeInt16LE(-1, 46);
  return bytes;
}

const soundBytes = wavBytes();

function integrity(bytes) {
  return `sha256-${sha256(bytes)}`;
}

function sourceText() {
  return `kamishibai: '4.0'
assets:
  LocalBackdrop:
    kind: backdrop
    file: assets/local.svg
  ProjectBackdrop:
    kind: backdrop
    name: Existing
  RemoteBackdrop:
    kind: backdrop
    delivery: remote
    source:
      url: https://cdn.example.com/remote.svg
      integrity: ${integrity(remoteBytes)}
      contentType: image/svg+xml
      size: ${remoteBytes.length}
  UiImage:
    kind: image
    file: assets/local.svg
  LocalSound:
    kind: sound
    file: assets/effect.wav
  RescuePose:
    kind: poseModel
    file: models/rescue
scenes:
  opening: []
`;
}

function urlOnlyRemoteSourceText() {
  return `kamishibai: '4.0'
assets:
  BareBackdrop:
    kind: backdrop
    delivery: remote
    source:
      url: https://cdn.example.com/redirect.svg
  BareSound:
    kind: sound
    delivery: remote
    source:
      url: https://cdn.example.com/effect.wav
scenes:
  opening: []
`;
}

function opaqueRemotePoseSourceText() {
  return `kamishibai: '4.0'
assets:
  OpaquePose:
    kind: poseModel
    delivery: remote
    source:
      url: https://cdn.example.com/opaque-pose.zip
      integrity: ${integrity(opaquePoseZip)}
      contentType: application/zip
      size: ${opaquePoseZip.length}
scenes:
  opening: []
`;
}

function baseSb3() {
  const assetId = md5(projectBytes);
  const filename = `${assetId}.svg`;
  const project = {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        costumes: [
          {
            name: 'Existing',
            bitmapResolution: 1,
            dataFormat: 'svg',
            assetId,
            md5ext: filename,
            rotationCenterX: 160,
            rotationCenterY: 120,
          },
        ],
        sounds: [],
      },
    ],
    monitors: [],
    extensions: [],
    meta: {semver: '3.0.0'},
  };
  return Buffer.from(
    zipSync({
      'project.json': strToU8(`${JSON.stringify(project)}\n`),
      [filename]: new Uint8Array(projectBytes),
    }),
  );
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsl4-asset-converter-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'assets'));
  await mkdir(path.join(root, 'models', 'rescue'), {recursive: true});
  await writeFile(path.join(root, 'assets', 'local.svg'), localBytes);
  await writeFile(path.join(root, 'assets', 'effect.wav'), soundBytes);
  await Promise.all(
    Object.entries(poseFiles).map(([name, bytes]) =>
      writeFile(path.join(root, 'models', 'rescue', name), bytes),
    ),
  );
  await writeFile(path.join(root, 'story.k4.yml'), sourceText());
  await writeFile(
    path.join(root, 'project.source.json'),
    `${JSON.stringify({
      formatVersion: 1,
      mode: 'external',
      sourceId: 'main',
      path: 'story.k4.yml',
    })}\n`,
  );
  await writeFile(path.join(root, 'base.sb3'), baseSb3());
  return root;
}

function options(root, outputName, extra = {}) {
  return {
    projectRoot: root,
    sourceManifest: path.join(root, 'project.source.json'),
    baseSb3: path.join(root, 'base.sb3'),
    outputDirectory: path.join(root, outputName),
    to: 'local',
    sourceFrontend,
    maxSourceBytes: 64 * 1024,
    maxSourceManifestBytes: 4096,
    maxRemoteMapBytes: 16 * 1024,
    maxBaseSb3Bytes: 1024 * 1024,
    maxAssetFileBytes: 64 * 1024,
    maxAssetFiles: 32,
    maxTotalAssetBytes: 512 * 1024,
    timeoutMs: 1000,
    maxRedirects: 2,
    allowedHosts: ['cdn.example.com'],
    subtleCrypto: webcrypto.subtle,
    fetchImplementation: async (url) => {
      assert.equal(url.hostname, 'cdn.example.com');
      return new Response(remoteBytes, {
        status: 200,
        headers: {'content-type': 'image/svg+xml'},
      });
    },
    ...extra,
  };
}

async function outputSource(result) {
  return parse(await readFile(result.sourcePath, 'utf8'));
}

test('converts one local asset into an SB3 project asset without changing inputs', async (t) => {
  const root = await fixture(t);
  const input = await Promise.all([
    readFile(path.join(root, 'story.k4.yml')),
    readFile(path.join(root, 'base.sb3')),
  ]);
  const result = await convertDsl4ProjectAssets(
    options(root, 'project-output', {
      to: 'project',
      assets: ['LocalBackdrop'],
    }),
  );
  const source = await outputSource(result);
  assert.deepEqual(source.assets.LocalBackdrop, {
    kind: 'backdrop',
    name: 'LocalBackdrop',
    delivery: 'embedded',
  });
  assert.equal(source.assets.ProjectBackdrop.name, 'Existing');
  const {archive, project} = readSb3(await readFile(result.sb3Path));
  const converted = project.targets[0].costumes.find(({name}) => name === 'LocalBackdrop');
  assert(converted);
  assert.equal(converted.rotationCenterX, 240);
  assert.equal(converted.rotationCenterY, 180);
  assert.deepEqual(Buffer.from(archive[converted.md5ext]), localBytes);
  assert.deepEqual(await readFile(path.join(root, 'story.k4.yml')), input[0]);
  assert.deepEqual(await readFile(path.join(root, 'base.sb3')), input[1]);
});

test('preserves a local image file when converting it to an SB3 project asset', async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, 'story.k4.yml'),
    `kamishibai: '4.0'
assets:
  LocalBackdrop:
    kind: backdrop
    file: assets/local.svg
scenes:
  opening: []
`,
  );
  const result = await convertDsl4ProjectAssets(
    options(root, 'preserved-local-project-output', {
      to: 'project',
      assets: ['LocalBackdrop'],
    }),
  );
  assert.deepEqual(result.preservedOriginals, {LocalBackdrop: 'assets/local.svg'});
  assert.deepEqual(
    await readFile(path.join(result.outputDirectory, 'assets', 'local.svg')),
    localBytes,
  );
  assert.deepEqual(await readFile(path.join(root, 'assets', 'local.svg')), localBytes);
});

test('derives Scratch sound metadata while converting a local sound to project form', async (t) => {
  const root = await fixture(t);
  const result = await convertDsl4ProjectAssets(
    options(root, 'sound-project-output', {
      to: 'project',
      assets: ['LocalSound'],
    }),
  );
  const source = await outputSource(result);
  assert.equal(source.assets.LocalSound.name, 'LocalSound');
  const {archive, project} = readSb3(await readFile(result.sb3Path));
  const sound = project.targets[0].sounds.find(({name}) => name === 'LocalSound');
  assert(sound);
  assert.equal(sound.rate, 8000);
  assert.equal(sound.sampleCount, 2);
  assert.deepEqual(Buffer.from(archive[sound.md5ext]), soundBytes);
});

test('verifies and embeds a remote asset while converting it to project form', async (t) => {
  const root = await fixture(t);
  const result = await convertDsl4ProjectAssets(
    options(root, 'remote-project-output', {
      to: 'project',
      assets: ['RemoteBackdrop'],
    }),
  );
  const source = await outputSource(result);
  assert.equal(source.assets.RemoteBackdrop.name, 'RemoteBackdrop');
  assert.equal(source.assets.RemoteBackdrop.delivery, 'embedded');
  const {archive, project} = readSb3(await readFile(result.sb3Path));
  const backdrop = project.targets[0].costumes.find(({name}) => name === 'RemoteBackdrop');
  assert(backdrop);
  assert.deepEqual(Buffer.from(archive[backdrop.md5ext]), remoteBytes);
  assert.match(result.preservedOriginals.RemoteBackdrop, /^assets\/originals\//u);
  assert.deepEqual(
    await readFile(
      path.join(result.outputDirectory, ...result.preservedOriginals.RemoteBackdrop.split('/')),
    ),
    remoteBytes,
  );
});

test('converts URL-only remote images and sounds to local and project assets', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'story.k4.yml'), urlOnlyRemoteSourceText());
  const requests = [];
  const fetchImplementation = async (url) => {
    requests.push(url.href);
    if (url.pathname === '/redirect.svg') {
      return new Response(null, {
        status: 302,
        headers: {location: 'https://media.example.com/final.svg'},
      });
    }
    const sound = url.pathname.endsWith('.wav');
    return new Response(sound ? soundBytes : remoteBytes, {
      status: 200,
      headers: {'content-type': sound ? 'audio/wav' : 'image/svg+xml'},
    });
  };
  const common = {
    allowedHosts: ['cdn.example.com', 'media.example.com'],
    fetchImplementation,
  };
  const local = await convertDsl4ProjectAssets(
    options(root, 'url-only-local-output', {...common, to: 'local'}),
  );
  const localSource = await outputSource(local);
  assert.match(localSource.assets.BareBackdrop.file, /^assets\/.+\.svg$/u);
  assert.match(localSource.assets.BareSound.file, /^assets\/.+\.wav$/u);
  assert.deepEqual(
    await readFile(
      path.join(local.outputDirectory, ...localSource.assets.BareBackdrop.file.split('/')),
    ),
    remoteBytes,
  );
  assert.deepEqual(
    await readFile(
      path.join(local.outputDirectory, ...localSource.assets.BareSound.file.split('/')),
    ),
    soundBytes,
  );

  const projectResult = await convertDsl4ProjectAssets(
    options(root, 'url-only-project-output', {...common, to: 'project'}),
  );
  const projectSource = await outputSource(projectResult);
  assert.equal(projectSource.assets.BareBackdrop.name, 'BareBackdrop');
  assert.equal(projectSource.assets.BareSound.name, 'BareSound');
  const {archive, project} = readSb3(await readFile(projectResult.sb3Path));
  const backdrop = project.targets[0].costumes.find(({name}) => name === 'BareBackdrop');
  const sound = project.targets[0].sounds.find(({name}) => name === 'BareSound');
  assert(backdrop);
  assert(sound);
  assert.deepEqual(Buffer.from(archive[backdrop.md5ext]), remoteBytes);
  assert.deepEqual(Buffer.from(archive[sound.md5ext]), soundBytes);
  assert.equal(requests.filter((url) => url === 'https://cdn.example.com/redirect.svg').length, 2);
  assert.equal(requests.filter((url) => url === 'https://media.example.com/final.svg').length, 2);
});

test('bounds and media-validates URL-only remote downloads without committing output', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'story.k4.yml'), urlOnlyRemoteSourceText());
  const attempt = async (outputName, extra, code) => {
    await assert.rejects(
      convertDsl4ProjectAssets(
        options(root, outputName, {
          to: 'local',
          assets: ['BareBackdrop'],
          ...extra,
        }),
      ),
      (error) => error.code === code,
    );
    await assert.rejects(stat(path.join(root, outputName)), {code: 'ENOENT'});
  };
  await attempt(
    'url-only-disallowed-redirect',
    {
      fetchImplementation: async () =>
        new Response(null, {
          status: 302,
          headers: {location: 'https://untrusted.example.com/final.svg'},
        }),
    },
    'K4-ASSET-REMOTE-HOST-001',
  );
  let timeoutSignalAborted = false;
  await attempt(
    'url-only-timeout',
    {
      timeoutMs: 1,
      fetchImplementation: async (_url, {signal}) =>
        new Promise((_resolve, reject) => {
          const guard = setTimeout(() => reject(new Error('timeout signal did not abort')), 1000);
          signal.addEventListener(
            'abort',
            () => {
              timeoutSignalAborted = true;
              clearTimeout(guard);
              reject(new Error('timed out'));
            },
            {once: true},
          );
        }),
    },
    'K4-ASSET-REMOTE-REQUEST-001',
  );
  assert.equal(timeoutSignalAborted, true);
  await attempt(
    'url-only-oversized',
    {
      maxAssetFileBytes: 4,
      fetchImplementation: async () =>
        new Response(remoteBytes, {
          status: 200,
          headers: {'content-type': 'image/svg+xml'},
        }),
    },
    'K4-ASSET-REMOTE-SIZE-001',
  );
  await attempt(
    'url-only-wrong-media',
    {
      fetchImplementation: async () =>
        new Response(remoteBytes, {
          status: 200,
          headers: {'content-type': 'text/plain'},
        }),
    },
    'K4-ASSET-CONVERT-REMOTE-TYPE-001',
  );
});

test('keeps a Teachable Machine pose ZIP opaque across remote, local, and rsync forms', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'story.k4.yml'), opaqueRemotePoseSourceText());
  const local = await convertDsl4ProjectAssets(
    options(root, 'opaque-pose-local-output', {
      to: 'local',
      fetchImplementation: async () =>
        new Response(opaquePoseZip, {
          status: 200,
          headers: {'content-type': 'application/zip'},
        }),
    }),
  );
  const localSource = await outputSource(local);
  assert.match(localSource.assets.OpaquePose.file, /^assets\/.+\.zip$/u);
  assert.deepEqual(
    await readFile(
      path.join(local.outputDirectory, ...localSource.assets.OpaquePose.file.split('/')),
    ),
    opaquePoseZip,
  );
  const parsedLocal = sourceFrontend.parse(await readFile(local.sourcePath, 'utf8'), {
    sourceId: 'opaque',
  });
  assert.equal(parsedLocal.ok, true);
  const localSnapshot = await loadDsl4LocalAssetSnapshot(
    local.outputDirectory,
    parsedLocal.storyDocument,
    {
      maxFileBytes: 64 * 1024,
      maxFiles: 32,
      maxTotalBytes: 512 * 1024,
      subtleCrypto: webcrypto.subtle,
    },
  );
  const poseSnapshot = localSnapshot.manifest.assets.find(({id}) => id === 'OpaquePose');
  assert.equal(poseSnapshot.source.mode, 'archive');
  assert.equal(poseSnapshot.source.files.length, 3);

  let synchronizedPose;
  const remote = await convertDsl4ProjectAssets(
    options(local.outputDirectory, 'opaque-pose-rsync-output', {
      sourceManifest: local.sourceManifestPath,
      baseSb3: local.sb3Path,
      to: 'remote',
      rsyncDestination: 'author@assets.example.com:/srv/www/k4-assets',
      remoteBaseUrl: 'https://cdn.example.com/k4-assets/',
      runRsync: async (command) => {
        const sourceDirectory = command.arguments.at(-2).slice(0, -path.sep.length);
        const [filename] = await readdir(sourceDirectory);
        synchronizedPose = await readFile(path.join(sourceDirectory, filename));
      },
      fetchImplementation: async () =>
        new Response(synchronizedPose, {
          status: 200,
          headers: {'content-type': 'application/zip'},
        }),
    }),
  );
  assert.deepEqual(synchronizedPose, opaquePoseZip);
  const remoteSource = (await outputSource(remote)).assets.OpaquePose.source;
  assert.equal(remoteSource.integrity, integrity(opaquePoseZip));
  assert.equal(remoteSource.size, opaquePoseZip.length);
});

test('converts all local, project, and remote assets to a local output tree', async (t) => {
  const root = await fixture(t);
  const result = await convertDsl4ProjectAssets(
    options(root, 'local-output', {
      to: 'local',
    }),
  );
  assert.deepEqual(result.converted, {
    LocalBackdrop: 'local',
    LocalSound: 'local',
    ProjectBackdrop: 'local',
    RemoteBackdrop: 'local',
    RescuePose: 'local',
    UiImage: 'local',
  });
  const source = await outputSource(result);
  for (const assetId of [
    'LocalBackdrop',
    'LocalSound',
    'ProjectBackdrop',
    'RemoteBackdrop',
    'UiImage',
  ]) {
    assert.equal(source.assets[assetId].delivery, 'embedded');
    assert.match(source.assets[assetId].file, /^assets\//u);
    const materialized = await readFile(
      path.join(result.outputDirectory, ...source.assets[assetId].file.split('/')),
    );
    assert.deepEqual(
      materialized,
      assetId === 'LocalBackdrop' || assetId === 'UiImage'
        ? localBytes
        : assetId === 'LocalSound'
          ? soundBytes
          : assetId === 'ProjectBackdrop'
            ? projectBytes
            : remoteBytes,
    );
  }
  assert.match(source.assets.RescuePose.file, /^assets\//u);
  for (const [name, bytes] of Object.entries(poseFiles)) {
    assert.deepEqual(
      await readFile(
        path.join(result.outputDirectory, ...source.assets.RescuePose.file.split('/'), name),
      ),
      bytes,
    );
  }
  const {project} = readSb3(await readFile(result.sb3Path));
  assert.equal(
    project.targets[0].costumes.some(({name}) => name === 'Existing'),
    false,
  );
});

test('makes a selective local conversion a reusable standalone project', async (t) => {
  const root = await fixture(t);
  const result = await convertDsl4ProjectAssets(
    options(root, 'standalone-local-output', {
      to: 'local',
      assets: ['ProjectBackdrop'],
    }),
  );
  assert.equal(result.sourceManifestPath, path.join(result.outputDirectory, 'project.source.json'));
  assert.equal(result.assetsDirectory, path.join(result.outputDirectory, 'assets'));
  const manifest = JSON.parse(await readFile(result.sourceManifestPath, 'utf8'));
  assert.deepEqual(manifest, {
    formatVersion: 1,
    mode: 'external',
    sourceId: 'main',
    path: 'story.k4.yml',
  });
  const loaded = await loadDsl4ExternalSource(result.outputDirectory, manifest, {
    maxSourceBytes: 64 * 1024,
    subtleCrypto: webcrypto.subtle,
  });
  const parsed = sourceFrontend.parse(loaded.descriptor.text, {
    sourceId: loaded.descriptor.sourceId,
  });
  assert.equal(parsed.ok, true);
  const source = parse(loaded.descriptor.text);
  assert.equal(source.assets.LocalBackdrop.file, 'assets/local.svg');
  assert.equal(source.assets.RescuePose.file, 'models/rescue');
  assert.match(source.assets.ProjectBackdrop.file, /^assets\//u);
  assert.deepEqual(
    await readFile(path.join(result.outputDirectory, 'assets', 'local.svg')),
    localBytes,
  );
  for (const [name, bytes] of Object.entries(poseFiles)) {
    assert.deepEqual(
      await readFile(path.join(result.outputDirectory, 'models', 'rescue', name)),
      bytes,
    );
  }
  const snapshot = await loadDsl4LocalAssetSnapshot(result.outputDirectory, parsed.storyDocument, {
    maxFileBytes: 64 * 1024,
    maxFiles: 32,
    maxTotalBytes: 512 * 1024,
    subtleCrypto: webcrypto.subtle,
  });
  assert.equal(
    snapshot.manifest.assets.find(({id}) => id === 'ProjectBackdrop').source.type,
    'file',
  );
});

test('verifies matching destinations before converting local and project assets to remote', async (t) => {
  const root = await fixture(t);
  const remoteMap = {
    LocalBackdrop: {
      url: 'https://cdn.example.com/local.svg',
      integrity: integrity(localBytes),
      contentType: 'image/svg+xml',
      size: localBytes.length,
    },
    ProjectBackdrop: {
      url: 'https://cdn.example.com/project.svg',
      integrity: integrity(projectBytes),
      contentType: 'image/svg+xml',
      size: projectBytes.length,
    },
  };
  const remoteMapPath = path.join(root, 'remote-map.json');
  await writeFile(remoteMapPath, `${JSON.stringify(remoteMap)}\n`);
  const result = await convertDsl4ProjectAssets(
    options(root, 'remote-output', {
      to: 'remote',
      assets: ['LocalBackdrop', 'ProjectBackdrop'],
      remoteMap: remoteMapPath,
      fetchImplementation: async (url) => {
        const body = url.pathname.endsWith('local.svg') ? localBytes : projectBytes;
        return new Response(body, {
          status: 200,
          headers: {'content-type': 'image/svg+xml'},
        });
      },
    }),
  );
  const source = await outputSource(result);
  assert.deepEqual(source.assets.LocalBackdrop.source, remoteMap.LocalBackdrop);
  assert.deepEqual(source.assets.ProjectBackdrop.source, remoteMap.ProjectBackdrop);
  const {project} = readSb3(await readFile(result.sb3Path));
  assert.equal(
    project.targets[0].costumes.some(({name}) => name === 'Existing'),
    false,
  );
});

test('does not double-count a remote verification destination as logical asset content', async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, 'story.k4.yml'),
    `kamishibai: '4.0'
assets:
  LocalBackdrop:
    kind: backdrop
    file: assets/local.svg
scenes:
  opening: []
`,
  );
  const remoteMapPath = path.join(root, 'single-remote-map.json');
  const remoteSource = {
    url: 'https://cdn.example.com/local.svg',
    integrity: integrity(localBytes),
    contentType: 'image/svg+xml',
    size: localBytes.length,
  };
  await writeFile(remoteMapPath, `${JSON.stringify({LocalBackdrop: remoteSource})}\n`);
  const result = await convertDsl4ProjectAssets(
    options(root, 'single-content-remote-output', {
      to: 'remote',
      assets: ['LocalBackdrop'],
      remoteMap: remoteMapPath,
      maxAssetFileBytes: localBytes.length,
      maxAssetFiles: 1,
      maxTotalAssetBytes: localBytes.length,
      fetchImplementation: async () =>
        new Response(localBytes, {
          status: 200,
          headers: {'content-type': 'image/svg+xml'},
        }),
    }),
  );
  assert.deepEqual((await outputSource(result)).assets.LocalBackdrop.source, remoteSource);
});

test('synchronizes content-addressed local, project, remote, and pose assets with rsync over SSH', async (t) => {
  const root = await fixture(t);
  const synchronized = new Map();
  let syncComplete = false;
  let receivedCommand;
  const result = await convertDsl4ProjectAssets(
    options(root, 'rsync-output', {
      to: 'remote',
      assets: ['LocalBackdrop', 'ProjectBackdrop', 'RemoteBackdrop', 'RescuePose'],
      rsyncDestination: 'author@assets.example.com:/srv/www/k4-assets',
      remoteBaseUrl: 'https://cdn.example.com/k4-assets/',
      rsyncSshPort: 2222,
      rsyncTimeoutMs: 4321,
      runRsync: async (command) => {
        receivedCommand = command;
        assert.equal(command.executable, 'rsync');
        assert.equal(command.timeoutMs, 4321);
        assert.equal(command.arguments.includes('--delete'), false);
        assert.equal(
          command.arguments.find((argument) => argument.startsWith('--rsh=')),
          '--rsh=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -p 2222',
        );
        assert.equal(command.arguments.at(-1), 'author@assets.example.com:/srv/www/k4-assets/');
        const sourceDirectory = command.arguments.at(-2).slice(0, -path.sep.length);
        for (const filename of await readdir(sourceDirectory)) {
          synchronized.set(filename, await readFile(path.join(sourceDirectory, filename)));
        }
        syncComplete = true;
      },
      fetchImplementation: async (url) => {
        if (url.pathname === '/remote.svg') {
          return new Response(remoteBytes, {
            status: 200,
            headers: {'content-type': 'image/svg+xml'},
          });
        }
        assert.equal(syncComplete, true, 'public verification must run after rsync');
        const filename = decodeURIComponent(path.posix.basename(url.pathname));
        const bytes = synchronized.get(filename);
        assert(bytes, `missing synchronized payload ${filename}`);
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': filename.endsWith('.zip') ? 'application/zip' : 'image/svg+xml',
          },
        });
      },
    }),
  );
  assert(receivedCommand);
  assert.equal(synchronized.size, 4);
  const source = await outputSource(result);
  for (const assetId of ['LocalBackdrop', 'ProjectBackdrop', 'RemoteBackdrop', 'RescuePose']) {
    const remote = source.assets[assetId].source;
    assert.equal(source.assets[assetId].delivery, 'remote');
    assert.match(remote.url, /^https:\/\/cdn\.example\.com\/k4-assets\//u);
    const filename = decodeURIComponent(path.posix.basename(new URL(remote.url).pathname));
    const bytes = synchronized.get(filename);
    assert(bytes);
    assert.equal(remote.integrity, integrity(bytes));
    assert.equal(remote.size, bytes.length);
  }
  const poseSource = source.assets.RescuePose.source;
  assert.equal(poseSource.contentType, 'application/zip');
  const poseArchive = unzipSync(
    synchronized.get(decodeURIComponent(path.posix.basename(new URL(poseSource.url).pathname))),
  );
  assert.deepEqual(Object.keys(poseArchive).sort(), Object.keys(poseFiles).sort());
  for (const [filename, bytes] of Object.entries(poseFiles)) {
    assert.deepEqual(Buffer.from(poseArchive[filename]), bytes);
  }
  const {project} = readSb3(await readFile(result.sb3Path));
  assert.equal(
    project.targets[0].costumes.some(({name}) => name === 'Existing'),
    false,
  );
});

test('rejects unsafe rsync destinations and rsync failures without local output', async (t) => {
  const root = await fixture(t);
  let runnerCalled = false;
  await assert.rejects(
    convertDsl4ProjectAssets(
      options(root, 'unsafe-rsync-output', {
        to: 'remote',
        assets: ['LocalBackdrop'],
        rsyncDestination: 'author@assets.example.com:/srv/www;touch-pwned',
        remoteBaseUrl: 'https://cdn.example.com/k4-assets/',
        runRsync: async () => {
          runnerCalled = true;
        },
      }),
    ),
    (error) => error.code === 'K4-ASSET-CONVERT-RSYNC-CONFIG-001',
  );
  assert.equal(runnerCalled, false);
  await assert.rejects(stat(path.join(root, 'unsafe-rsync-output')), {code: 'ENOENT'});

  await assert.rejects(
    convertDsl4ProjectAssets(
      options(root, 'failed-rsync-output', {
        to: 'remote',
        assets: ['LocalBackdrop'],
        rsyncDestination: 'author@assets.example.com:/srv/www/k4-assets',
        remoteBaseUrl: 'https://cdn.example.com/k4-assets/',
        runRsync: async () => {
          throw new Error('simulated rsync failure');
        },
        fetchImplementation: async () => {
          assert.fail('HTTPS verification must not run after rsync failure');
        },
      }),
    ),
    (error) => error.code === 'K4-ASSET-CONVERT-RSYNC-001',
  );
  await assert.rejects(stat(path.join(root, 'failed-rsync-output')), {code: 'ENOENT'});
});

test('does not commit local output when synchronized bytes fail public HTTPS verification', async (t) => {
  const root = await fixture(t);
  let runnerCalled = false;
  await assert.rejects(
    convertDsl4ProjectAssets(
      options(root, 'unpublished-rsync-output', {
        to: 'remote',
        assets: ['LocalBackdrop'],
        rsyncDestination: 'author@assets.example.com:/srv/www/k4-assets',
        remoteBaseUrl: 'https://cdn.example.com/k4-assets/',
        runRsync: async () => {
          runnerCalled = true;
        },
        fetchImplementation: async () =>
          new Response(Buffer.from('stale'), {
            status: 200,
            headers: {'content-type': 'image/svg+xml'},
          }),
      }),
    ),
    (error) => error.code === 'K4-ASSET-CONVERT-REMOTE-INTEGRITY-001',
  );
  assert.equal(runnerCalled, true);
  await assert.rejects(stat(path.join(root, 'unpublished-rsync-output')), {code: 'ENOENT'});
});

test('rejects unsupported project kinds and remote content mismatches without output', async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    convertDsl4ProjectAssets(
      options(root, 'unsupported-output', {
        to: 'project',
        assets: ['UiImage'],
      }),
    ),
    (error) => error.code === 'K4-ASSET-CONVERT-UNSUPPORTED-001',
  );
  await assert.rejects(stat(path.join(root, 'unsupported-output')), {code: 'ENOENT'});
  await assert.rejects(
    convertDsl4ProjectAssets(
      options(root, 'pose-project-output', {
        to: 'project',
        assets: ['RescuePose'],
      }),
    ),
    (error) => error.code === 'K4-ASSET-CONVERT-UNSUPPORTED-001',
  );
  await assert.rejects(stat(path.join(root, 'pose-project-output')), {code: 'ENOENT'});

  const remoteMapPath = path.join(root, 'bad-remote-map.json');
  await writeFile(
    remoteMapPath,
    `${JSON.stringify({
      LocalBackdrop: {
        url: 'https://cdn.example.com/local.svg',
        integrity: integrity(localBytes),
        contentType: 'image/svg+xml',
        size: localBytes.length,
      },
    })}\n`,
  );
  await assert.rejects(
    convertDsl4ProjectAssets(
      options(root, 'mismatch-output', {
        to: 'remote',
        assets: ['LocalBackdrop'],
        remoteMap: remoteMapPath,
        fetchImplementation: async () =>
          new Response(Buffer.from('different'), {
            status: 200,
            headers: {'content-type': 'image/svg+xml'},
          }),
      }),
    ),
    (error) => error.code === 'K4-ASSET-CONVERT-REMOTE-INTEGRITY-001',
  );
  await assert.rejects(stat(path.join(root, 'mismatch-output')), {code: 'ENOENT'});
});

test('refuses to replace an existing conversion output directory', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'existing-output'));
  await writeFile(path.join(root, 'existing-output', 'keep.txt'), 'keep');
  await assert.rejects(
    convertDsl4ProjectAssets(
      options(root, 'existing-output', {
        to: 'project',
        assets: ['LocalBackdrop'],
      }),
    ),
    (error) => error.code === 'K4-ASSET-CONVERT-OUTPUT-EXISTS-001',
  );
  assert.equal(await readFile(path.join(root, 'existing-output', 'keep.txt'), 'utf8'), 'keep');
});
