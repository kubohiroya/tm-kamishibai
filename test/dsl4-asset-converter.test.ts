import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test, type TestContext} from 'vitest';
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
import {thrown} from './helpers/thrown-error.ts';
import {
  requireArray,
  requireDefined,
  requireRecord,
  requireString,
} from './helpers/require-value.ts';
import type {ParseResult} from '../src/dsl4/source-frontend.js';

type ConversionOptions = Parameters<typeof convertDsl4ProjectAssets>[0];
type RsyncCommand = Parameters<NonNullable<ConversionOptions['runRsync']>>[0];

interface RemoteAssetSource {
  url: string;
  integrity?: string;
  contentType?: string;
  size?: number;
}

interface SourceAsset {
  kind?: string;
  name?: string;
  file?: string;
  delivery?: string;
  source?: RemoteAssetSource;
}

interface OutputSourceDocument {
  assets: Record<string, SourceAsset | undefined>;
}

interface Sb3Costume {
  name: string;
  md5ext: string;
  rotationCenterX: number;
  rotationCenterY: number;
}

interface Sb3Sound {
  name: string;
  md5ext: string;
  rate: number;
  sampleCount: number;
}

interface Sb3Target {
  costumes: Sb3Costume[];
  sounds: Sb3Sound[];
}

interface Sb3Project {
  targets: Sb3Target[];
}

/** `readSb3` hands back `project.json` as parsed JSON, so the cases name the shape they assert on. */
function sb3(bytes: Buffer): {archive: Record<string, Uint8Array>; project: Sb3Project} {
  return readSb3(bytes);
}

function stageOf(project: Sb3Project): Sb3Target {
  return requireDefined(project.targets[0], 'the stage target');
}

function entryOf(archive: Record<string, Uint8Array>, name: string): Uint8Array {
  return requireDefined(archive[name], `archive entry ${name}`);
}

function assetOf(source: OutputSourceDocument, id: string): SourceAsset {
  return requireDefined(source.assets[id], `converted asset ${id}`);
}

function assetFileOf(source: OutputSourceDocument, id: string): string {
  return requireString(assetOf(source, id).file, `the file of converted asset ${id}`);
}

function assetSourceOf(source: OutputSourceDocument, id: string): RemoteAssetSource {
  return requireDefined(assetOf(source, id).source, `the remote source of converted asset ${id}`);
}

function snapshotAssetSource(assets: readonly unknown[], id: string): Record<string, unknown> {
  const asset = requireDefined(
    assets
      .map((entry) => requireRecord(entry, 'a local asset snapshot entry'))
      .find((entry) => entry.id === id),
    `the local asset snapshot of ${id}`,
  );
  return requireRecord(asset.source, `the snapshot source of ${id}`);
}

/** The rsync staging directory is the second-to-last argument, with its trailing separator. */
function rsyncSourceDirectory(command: RsyncCommand): string {
  const argument = requireString(command.arguments.at(-2), 'the rsync source argument');
  return argument.slice(0, -path.sep.length);
}

async function onlyFileIn(directory: string): Promise<Buffer<ArrayBuffer>> {
  const [filename] = await readdir(directory);
  return readFile(path.join(directory, requireDefined(filename, `a file in ${directory}`)));
}

function storyDocumentOf(
  result: ParseResult,
  description: string,
): Readonly<Record<string, unknown>> {
  assert(result.ok, `Expected ${description} to parse`);
  return result.storyDocument;
}

/**
 * The converter only ever fetches a `URL`, but `typeof fetch` accepts wider input, so the test
 * doubles narrow it once here instead of each declaring a narrower parameter they cannot.
 */
function fetchedUrl(input: RequestInfo | URL): URL {
  assert(input instanceof URL, 'expected the converter to fetch a URL');
  return input;
}

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
const poseFiles: Record<string, Buffer<ArrayBuffer>> = {
  'model.json': Buffer.from('{"model":"rescue"}'),
  'metadata.json': Buffer.from('{"labels":["help"]}'),
  'weights.bin': Buffer.from([1, 2, 3, 4]),
};
const opaquePoseZip = Buffer.from(zipSync(poseFiles, {level: 0}));
const remotePoseDirectoryFiles: Record<string, Buffer<ArrayBuffer>> = {
  'model.json': Buffer.from('{"weightsManifest":[{"paths":["weights.bin"]}]}'),
  'metadata.json': Buffer.from('{"labels":["help"]}'),
  'weights.bin': Buffer.from([5, 6, 7, 8]),
};

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

function mp3Bytes(frameCount = 2) {
  const frameLength = Math.floor((144 * 128_000) / 44_100);
  const bytes = Buffer.alloc(frameLength * frameCount);
  for (let index = 0; index < frameCount; index += 1) {
    bytes.writeUInt32BE(0xfffb9000, index * frameLength);
  }
  return bytes;
}

const mpegSoundBytes = mp3Bytes();

function integrity(bytes: Uint8Array) {
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
    kind: recognitionModel
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
    kind: recognitionModel
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

function remotePoseDirectorySourceText() {
  return `kamishibai: '4.0'
assets:
  DirectoryPose:
    kind: recognitionModel
    delivery: remote
    source:
      url: https://cdn.example.com/pose?revision=1
scenes:
  opening: []
`;
}

function baseSb3({
  includeProjectAsset = true,
  includeProjectBytes = true,
}: {
  includeProjectAsset?: boolean;
  includeProjectBytes?: boolean;
} = {}) {
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
        costumes: includeProjectAsset
          ? [
              {
                name: 'Existing',
                bitmapResolution: 1,
                dataFormat: 'svg',
                assetId,
                md5ext: filename,
                rotationCenterX: 160,
                rotationCenterY: 120,
              },
            ]
          : [],
        sounds: [],
      },
    ],
    monitors: [],
    extensions: [],
    meta: {semver: '3.0.0'},
  };
  const entries: Record<string, Uint8Array> = {
    'project.json': strToU8(`${JSON.stringify(project)}\n`),
  };
  if (includeProjectBytes) entries[filename] = new Uint8Array(projectBytes);
  return Buffer.from(zipSync(entries));
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsl4-asset-converter-'));
  t.onTestFinished(() => rm(root, {recursive: true, force: true}));
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
    path.join(root, 'project.source.yaml'),
    'formatVersion: 1\nmode: external\nsourceId: main\npath: story.k4.yml\n',
  );
  await writeFile(path.join(root, 'base.sb3'), baseSb3());
  return root;
}

function options(
  root: string,
  outputName: string,
  extra: Partial<ConversionOptions> = {},
): ConversionOptions {
  return {
    projectRoot: root,
    sourceManifest: path.join(root, 'project.source.yaml'),
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
    fetchImplementation: async (input) => {
      assert.equal(fetchedUrl(input).hostname, 'cdn.example.com');
      return new Response(remoteBytes, {
        status: 200,
        headers: {'content-type': 'image/svg+xml'},
      });
    },
    ...extra,
  };
}

/** The converted YAML is parsed as plain data, so the cases name the shape they read from it. */
async function outputSource(result: {sourcePath: string}): Promise<OutputSourceDocument> {
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
  assert.deepEqual(assetOf(source, 'LocalBackdrop'), {
    kind: 'backdrop',
    name: 'LocalBackdrop',
    delivery: 'embedded',
  });
  assert.equal(assetOf(source, 'ProjectBackdrop').name, 'Existing');
  const {archive, project} = sb3(await readFile(result.sb3Path));
  const converted = stageOf(project).costumes.find(({name}) => name === 'LocalBackdrop');
  assert(converted);
  assert.equal(converted.rotationCenterX, 240);
  assert.equal(converted.rotationCenterY, 180);
  assert.deepEqual(Buffer.from(entryOf(archive, converted.md5ext)), localBytes);
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
  assert.equal(assetOf(source, 'LocalSound').name, 'LocalSound');
  const {archive, project} = sb3(await readFile(result.sb3Path));
  const sound = stageOf(project).sounds.find(({name}) => name === 'LocalSound');
  assert(sound);
  assert.equal(sound.rate, 8000);
  assert.equal(sound.sampleCount, 2);
  assert.deepEqual(Buffer.from(entryOf(archive, sound.md5ext)), soundBytes);
});

test('derives MPEG-1 Layer III metadata while converting MP3 sound to project form', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'assets', 'effect.mp3'), mpegSoundBytes);
  await writeFile(
    path.join(root, 'story.k4.yml'),
    `kamishibai: '4.0'
assets:
  Mp3Sound:
    kind: sound
    file: assets/effect.mp3
scenes:
  opening: []
`,
  );
  const result = await convertDsl4ProjectAssets(
    options(root, 'mp3-project-output', {
      to: 'project',
      assets: ['Mp3Sound'],
    }),
  );
  const {archive, project} = sb3(await readFile(result.sb3Path));
  const sound = stageOf(project).sounds.find(({name}) => name === 'Mp3Sound');
  assert(sound);
  assert.equal(sound.rate, 44_100);
  assert.equal(sound.sampleCount, 2304);
  assert.deepEqual(Buffer.from(entryOf(archive, sound.md5ext)), mpegSoundBytes);
});

test('uses SVG viewBox dimensions and accepts exact px dimensions for project assets', async (t) => {
  const root = await fixture(t);
  const percentageSvg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 480 360"></svg>',
  );
  const pixelSvg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320px" height="200px"></svg>',
  );
  await writeFile(path.join(root, 'assets', 'percentage.svg'), percentageSvg);
  await writeFile(path.join(root, 'assets', 'pixels.svg'), pixelSvg);
  await writeFile(
    path.join(root, 'story.k4.yml'),
    `kamishibai: '4.0'
assets:
  PercentageBackdrop:
    kind: backdrop
    file: assets/percentage.svg
  PixelBackdrop:
    kind: backdrop
    file: assets/pixels.svg
scenes:
  opening: []
`,
  );
  const result = await convertDsl4ProjectAssets(
    options(root, 'svg-dimensions-project-output', {to: 'project'}),
  );
  const {project} = sb3(await readFile(result.sb3Path));
  const percentage = stageOf(project).costumes.find(({name}) => name === 'PercentageBackdrop');
  const pixels = stageOf(project).costumes.find(({name}) => name === 'PixelBackdrop');
  assert(percentage);
  assert(pixels);
  assert.deepEqual([percentage.rotationCenterX, percentage.rotationCenterY], [240, 180]);
  assert.deepEqual([pixels.rotationCenterX, pixels.rotationCenterY], [160, 100]);

  for (const invalid of [
    {
      id: 'PercentageOnly',
      filename: 'percentage-only.svg',
      source: '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"></svg>',
    },
    {
      id: 'MissingWidth',
      filename: 'missing-width.svg',
      source: '<svg xmlns="http://www.w3.org/2000/svg" stroke-width="320" height="200px"></svg>',
    },
  ]) {
    await writeFile(path.join(root, 'assets', invalid.filename), invalid.source);
    await writeFile(
      path.join(root, 'story.k4.yml'),
      `kamishibai: '4.0'
assets:
  ${invalid.id}:
    kind: backdrop
    file: assets/${invalid.filename}
scenes:
  opening: []
`,
    );
    const output = `invalid-${invalid.id.toLowerCase()}-project-output`;
    await assert.rejects(
      convertDsl4ProjectAssets(options(root, output, {to: 'project'})),
      (error) => thrown(error).code === 'K4-ASSET-CONVERT-METADATA-001',
    );
    await assert.rejects(stat(path.join(root, output)), {code: 'ENOENT'});
  }
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
  assert.equal(assetOf(source, 'RemoteBackdrop').name, 'RemoteBackdrop');
  assert.equal(assetOf(source, 'RemoteBackdrop').delivery, 'embedded');
  const {archive, project} = sb3(await readFile(result.sb3Path));
  const backdrop = stageOf(project).costumes.find(({name}) => name === 'RemoteBackdrop');
  assert(backdrop);
  assert.deepEqual(Buffer.from(entryOf(archive, backdrop.md5ext)), remoteBytes);
  const preserved = requireString(
    result.preservedOriginals.RemoteBackdrop,
    'the preserved original of RemoteBackdrop',
  );
  assert.match(preserved, /^assets\/originals\//u);
  assert.deepEqual(
    await readFile(path.join(result.outputDirectory, ...preserved.split('/'))),
    remoteBytes,
  );
});

test('converts URL-only remote images and sounds to local and project assets', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'story.k4.yml'), urlOnlyRemoteSourceText());
  const requests: string[] = [];
  const fetchImplementation = async (input: RequestInfo | URL) => {
    const url = fetchedUrl(input);
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
  assert.match(assetFileOf(localSource, 'BareBackdrop'), /^assets\/.+\.svg$/u);
  assert.match(assetFileOf(localSource, 'BareSound'), /^assets\/.+\.wav$/u);
  assert.deepEqual(
    await readFile(
      path.join(local.outputDirectory, ...assetFileOf(localSource, 'BareBackdrop').split('/')),
    ),
    remoteBytes,
  );
  assert.deepEqual(
    await readFile(
      path.join(local.outputDirectory, ...assetFileOf(localSource, 'BareSound').split('/')),
    ),
    soundBytes,
  );

  const projectResult = await convertDsl4ProjectAssets(
    options(root, 'url-only-project-output', {...common, to: 'project'}),
  );
  const projectSource = await outputSource(projectResult);
  assert.equal(assetOf(projectSource, 'BareBackdrop').name, 'BareBackdrop');
  assert.equal(assetOf(projectSource, 'BareSound').name, 'BareSound');
  const {archive, project} = sb3(await readFile(projectResult.sb3Path));
  const backdrop = stageOf(project).costumes.find(({name}) => name === 'BareBackdrop');
  const sound = stageOf(project).sounds.find(({name}) => name === 'BareSound');
  assert(backdrop);
  assert(sound);
  assert.deepEqual(Buffer.from(entryOf(archive, backdrop.md5ext)), remoteBytes);
  assert.deepEqual(Buffer.from(entryOf(archive, sound.md5ext)), soundBytes);
  assert.equal(requests.filter((url) => url === 'https://cdn.example.com/redirect.svg').length, 2);
  assert.equal(requests.filter((url) => url === 'https://media.example.com/final.svg').length, 2);
});

test('bounds and media-validates URL-only remote downloads without committing output', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'story.k4.yml'), urlOnlyRemoteSourceText());
  const attempt = async (outputName: string, extra: Partial<ConversionOptions>, code: string) => {
    await assert.rejects(
      convertDsl4ProjectAssets(
        options(root, outputName, {
          to: 'local',
          assets: ['BareBackdrop'],
          ...extra,
        }),
      ),
      (error) => thrown(error).code === code,
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
      fetchImplementation: async (_input, init) => {
        const signal = requireDefined(init?.signal, 'the request abort signal');
        return new Promise<Response>((_resolve, reject) => {
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
        });
      },
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
  assert.match(assetFileOf(localSource, 'OpaquePose'), /^assets\/.+\.zip$/u);
  assert.deepEqual(
    await readFile(
      path.join(local.outputDirectory, ...assetFileOf(localSource, 'OpaquePose').split('/')),
    ),
    opaquePoseZip,
  );
  const parsedLocal = sourceFrontend.parse(await readFile(local.sourcePath, 'utf8'), {
    sourceId: 'opaque',
  });
  const localSnapshot = await loadDsl4LocalAssetSnapshot(
    local.outputDirectory,
    storyDocumentOf(parsedLocal, 'the converted local source'),
    {
      maxFileBytes: 64 * 1024,
      maxFiles: 32,
      maxTotalBytes: 512 * 1024,
      subtleCrypto: webcrypto.subtle,
    },
  );
  const poseSnapshot = snapshotAssetSource(localSnapshot.manifest.assets, 'OpaquePose');
  assert.equal(poseSnapshot.mode, 'archive');
  assert.equal(requireArray(poseSnapshot.files, 'the pose snapshot files').length, 3);

  const staged: {pose?: Buffer<ArrayBuffer>} = {};
  const remote = await convertDsl4ProjectAssets(
    options(local.outputDirectory, 'opaque-pose-rsync-output', {
      sourceManifest: local.sourceManifestPath,
      baseSb3: local.sb3Path,
      to: 'remote',
      rsyncDestination: 'author@assets.example.com:/srv/www/k4-assets',
      remoteBaseUrl: 'https://cdn.example.com/k4-assets/',
      runRsync: async (command) => {
        staged.pose = await onlyFileIn(rsyncSourceDirectory(command));
      },
      fetchImplementation: async () =>
        new Response(staged.pose, {
          status: 200,
          headers: {'content-type': 'application/zip'},
        }),
    }),
  );
  assert.deepEqual(staged.pose, opaquePoseZip);
  const remoteSource = assetSourceOf(await outputSource(remote), 'OpaquePose');
  assert.equal(remoteSource.integrity, integrity(opaquePoseZip));
  assert.equal(remoteSource.size, opaquePoseZip.length);
});

test('converts a URL-only TM directory to local and rsync forms', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'story.k4.yml'), remotePoseDirectorySourceText());
  const requests: string[] = [];
  const directoryResponse = (url: URL) => {
    requests.push(url.href);
    const filename = path.posix.basename(url.pathname);
    const bytes = remotePoseDirectoryFiles[filename];
    assert(bytes, `unexpected pose directory request: ${url.href}`);
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': filename.endsWith('.json')
          ? 'application/json'
          : 'application/octet-stream',
      },
    });
  };
  const local = await convertDsl4ProjectAssets(
    options(root, 'remote-pose-directory-local-output', {
      to: 'local',
      fetchImplementation: async (input) => directoryResponse(fetchedUrl(input)),
    }),
  );
  const localSource = await outputSource(local);
  assert.match(assetFileOf(localSource, 'DirectoryPose'), /^assets\//u);
  for (const [filename, bytes] of Object.entries(remotePoseDirectoryFiles)) {
    assert.deepEqual(
      await readFile(
        path.join(local.outputDirectory, assetFileOf(localSource, 'DirectoryPose'), filename),
      ),
      bytes,
    );
  }
  assert.deepEqual(requests.sort(), [
    'https://cdn.example.com/pose/metadata.json?revision=1',
    'https://cdn.example.com/pose/model.json?revision=1',
    'https://cdn.example.com/pose/weights.bin?revision=1',
  ]);

  const staged: {pose?: Buffer<ArrayBuffer>} = {};
  const remote = await convertDsl4ProjectAssets(
    options(root, 'remote-pose-directory-rsync-output', {
      to: 'remote',
      rsyncDestination: 'author@assets.example.com:/srv/www/k4-assets',
      remoteBaseUrl: 'https://cdn.example.com/k4-assets/',
      runRsync: async (command) => {
        staged.pose = await onlyFileIn(rsyncSourceDirectory(command));
      },
      fetchImplementation: async (input) => {
        const url = fetchedUrl(input);
        if (url.pathname.startsWith('/pose/')) return directoryResponse(url);
        return new Response(requireDefined(staged.pose, 'the synchronized pose archive'), {
          status: 200,
          headers: {'content-type': 'application/zip'},
        });
      },
    }),
  );
  const synchronizedPose = requireDefined(staged.pose, 'the synchronized pose archive');
  const remoteSource = assetSourceOf(await outputSource(remote), 'DirectoryPose');
  assert.equal(remoteSource.contentType, 'application/zip');
  assert.equal(remoteSource.integrity, integrity(synchronizedPose));
  const archive = unzipSync(synchronizedPose);
  assert.deepEqual(Object.keys(archive).sort(), Object.keys(remotePoseDirectoryFiles).sort());
  for (const [filename, bytes] of Object.entries(remotePoseDirectoryFiles)) {
    assert.deepEqual(Buffer.from(entryOf(archive, filename)), bytes);
  }
});

test('rejects malformed URL-only TM directories without output', async (t) => {
  const cases = [
    {
      output: 'remote-pose-invalid-json-output',
      model: Buffer.from('{'),
    },
    {
      output: 'remote-pose-multiple-weights-output',
      model: Buffer.from('{"weightsManifest":[{"paths":["weights.bin","weights-2.bin"]}]}'),
    },
    {
      output: 'remote-pose-unsafe-weights-output',
      model: Buffer.from('{"weightsManifest":[{"paths":["../weights.bin"]}]}'),
    },
  ];
  for (const fixtureCase of cases) {
    const root = await fixture(t);
    await writeFile(path.join(root, 'story.k4.yml'), remotePoseDirectorySourceText());
    await assert.rejects(
      convertDsl4ProjectAssets(
        options(root, fixtureCase.output, {
          to: 'local',
          fetchImplementation: async (input) => {
            const filename = path.posix.basename(fetchedUrl(input).pathname);
            const bytes =
              filename === 'model.json' ? fixtureCase.model : remotePoseDirectoryFiles[filename];
            assert(bytes);
            return new Response(bytes, {
              status: 200,
              headers: {'content-type': 'application/octet-stream'},
            });
          },
        }),
      ),
      (error) => thrown(error).code === 'K4-ASSET-CONVERT-REMOTE-POSE-001',
    );
    await assert.rejects(stat(path.join(root, fixtureCase.output)), {code: 'ENOENT'});
  }
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
    assert.equal(assetOf(source, assetId).delivery, 'embedded');
    assert.match(assetFileOf(source, assetId), /^assets\//u);
    const materialized = await readFile(
      path.join(result.outputDirectory, ...assetFileOf(source, assetId).split('/')),
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
  assert.match(assetFileOf(source, 'RescuePose'), /^assets\//u);
  for (const [name, bytes] of Object.entries(poseFiles)) {
    assert.deepEqual(
      await readFile(
        path.join(result.outputDirectory, ...assetFileOf(source, 'RescuePose').split('/'), name),
      ),
      bytes,
    );
  }
  const {project} = sb3(await readFile(result.sb3Path));
  assert.equal(
    stageOf(project).costumes.some(({name}) => name === 'Existing'),
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
  assert.equal(result.sourceManifestPath, path.join(result.outputDirectory, 'project.source.yml'));
  assert.equal(result.assetsDirectory, path.join(result.outputDirectory, 'assets'));
  const manifest = parse(await readFile(result.sourceManifestPath, 'utf8'));
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
  assert.equal(assetFileOf(source, 'LocalBackdrop'), 'assets/local.svg');
  assert.equal(assetFileOf(source, 'RescuePose'), 'models/rescue');
  assert.match(assetFileOf(source, 'ProjectBackdrop'), /^assets\//u);
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
  assert.equal(snapshotAssetSource(snapshot.manifest.assets, 'ProjectBackdrop').type, 'file');
});

test('validates every final project asset reference before committing output', async (t) => {
  const cases: {output: string; base: Buffer; to: ConversionOptions['to']; assets: string[]}[] = [
    {
      output: 'missing-selected-project-output',
      base: baseSb3({includeProjectAsset: false, includeProjectBytes: false}),
      to: 'project',
      assets: ['ProjectBackdrop'],
    },
    {
      output: 'missing-unselected-project-output',
      base: baseSb3({includeProjectAsset: false, includeProjectBytes: false}),
      to: 'local',
      assets: ['LocalBackdrop'],
    },
    {
      output: 'missing-project-archive-output',
      base: baseSb3({includeProjectBytes: false}),
      to: 'project',
      assets: ['ProjectBackdrop'],
    },
  ];
  for (const fixtureCase of cases) {
    const root = await fixture(t);
    await writeFile(path.join(root, 'base.sb3'), fixtureCase.base);
    await assert.rejects(
      convertDsl4ProjectAssets(
        options(root, fixtureCase.output, {
          to: fixtureCase.to,
          assets: fixtureCase.assets,
        }),
      ),
      (error) => thrown(error).code === 'K4-ASSET-CONVERT-PROJECT-001',
    );
    await assert.rejects(stat(path.join(root, fixtureCase.output)), {code: 'ENOENT'});
  }

  const root = await fixture(t);
  const result = await convertDsl4ProjectAssets(
    options(root, 'valid-project-noop-output', {
      to: 'project',
      assets: ['ProjectBackdrop'],
    }),
  );
  assert.equal(result.converted.ProjectBackdrop, 'project');
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
      fetchImplementation: async (input) => {
        const body = fetchedUrl(input).pathname.endsWith('local.svg') ? localBytes : projectBytes;
        return new Response(body, {
          status: 200,
          headers: {'content-type': 'image/svg+xml'},
        });
      },
    }),
  );
  const source = await outputSource(result);
  assert.deepEqual(assetSourceOf(source, 'LocalBackdrop'), remoteMap.LocalBackdrop);
  assert.deepEqual(assetSourceOf(source, 'ProjectBackdrop'), remoteMap.ProjectBackdrop);
  const {project} = sb3(await readFile(result.sb3Path));
  assert.equal(
    stageOf(project).costumes.some(({name}) => name === 'Existing'),
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
  assert.deepEqual(assetSourceOf(await outputSource(result), 'LocalBackdrop'), remoteSource);
});

test('synchronizes content-addressed local, project, remote, and pose assets with rsync over SSH', async (t) => {
  const root = await fixture(t);
  const synchronized = new Map<string, Buffer<ArrayBuffer>>();
  let syncComplete = false;
  const staged: {command?: RsyncCommand} = {};
  const result = await convertDsl4ProjectAssets(
    options(root, 'rsync-output', {
      to: 'remote',
      assets: ['LocalBackdrop', 'ProjectBackdrop', 'RemoteBackdrop', 'RescuePose'],
      rsyncDestination: 'author@assets.example.com:/srv/www/k4-assets',
      remoteBaseUrl: 'https://cdn.example.com/k4-assets/',
      rsyncSshPort: 2222,
      rsyncTimeoutMs: 4321,
      runRsync: async (command) => {
        staged.command = command;
        assert.equal(command.executable, 'rsync');
        assert.equal(command.timeoutMs, 4321);
        assert.equal(command.arguments.includes('--delete'), false);
        assert.equal(
          command.arguments.find((argument) => argument.startsWith('--rsh=')),
          '--rsh=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -p 2222',
        );
        assert.equal(command.arguments.at(-1), 'author@assets.example.com:/srv/www/k4-assets/');
        const sourceDirectory = rsyncSourceDirectory(command);
        for (const filename of await readdir(sourceDirectory)) {
          synchronized.set(filename, await readFile(path.join(sourceDirectory, filename)));
        }
        syncComplete = true;
      },
      fetchImplementation: async (input) => {
        const url = fetchedUrl(input);
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
  assert(staged.command);
  assert.equal(synchronized.size, 4);
  const source = await outputSource(result);
  for (const assetId of ['LocalBackdrop', 'ProjectBackdrop', 'RemoteBackdrop', 'RescuePose']) {
    const remote = assetSourceOf(source, assetId);
    assert.equal(assetOf(source, assetId).delivery, 'remote');
    assert.match(remote.url, /^https:\/\/cdn\.example\.com\/k4-assets\//u);
    const filename = decodeURIComponent(path.posix.basename(new URL(remote.url).pathname));
    const bytes = synchronized.get(filename);
    assert(bytes);
    assert.equal(remote.integrity, integrity(bytes));
    assert.equal(remote.size, bytes.length);
  }
  const poseSource = assetSourceOf(source, 'RescuePose');
  assert.equal(poseSource.contentType, 'application/zip');
  const poseArchive = unzipSync(
    requireDefined(
      synchronized.get(decodeURIComponent(path.posix.basename(new URL(poseSource.url).pathname))),
      'the synchronized pose archive',
    ),
  );
  assert.deepEqual(Object.keys(poseArchive).sort(), Object.keys(poseFiles).sort());
  for (const [filename, bytes] of Object.entries(poseFiles)) {
    assert.deepEqual(Buffer.from(entryOf(poseArchive, filename)), bytes);
  }
  const {project} = sb3(await readFile(result.sb3Path));
  assert.equal(
    stageOf(project).costumes.some(({name}) => name === 'Existing'),
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
    (error) => thrown(error).code === 'K4-ASSET-CONVERT-RSYNC-CONFIG-001',
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
    (error) => thrown(error).code === 'K4-ASSET-CONVERT-RSYNC-001',
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
    (error) => thrown(error).code === 'K4-ASSET-CONVERT-REMOTE-INTEGRITY-001',
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
    (error) => thrown(error).code === 'K4-ASSET-CONVERT-UNSUPPORTED-001',
  );
  await assert.rejects(stat(path.join(root, 'unsupported-output')), {code: 'ENOENT'});
  await assert.rejects(
    convertDsl4ProjectAssets(
      options(root, 'pose-project-output', {
        to: 'project',
        assets: ['RescuePose'],
      }),
    ),
    (error) => thrown(error).code === 'K4-ASSET-CONVERT-UNSUPPORTED-001',
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
    (error) => thrown(error).code === 'K4-ASSET-CONVERT-REMOTE-INTEGRITY-001',
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
    (error) => thrown(error).code === 'K4-ASSET-CONVERT-OUTPUT-EXISTS-001',
  );
  assert.equal(await readFile(path.join(root, 'existing-output', 'keep.txt'), 'utf8'), 'keep');
});
