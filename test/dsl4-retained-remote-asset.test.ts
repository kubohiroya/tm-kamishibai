import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {test} from 'vitest';

import {
  createDsl4EmbeddedAssetBundle,
  dsl4RetainedRemotePayloadPath,
  validateDsl4EmbeddedAssetBundle,
} from '../src/dsl4/asset-bundle-descriptor.js';
import {createDsl4EmbeddedAssetLifecycle} from '../src/dsl4/embedded-asset-lifecycle.js';
import {createDsl4BinaryEntryAssetBundle} from '../src/dsl4/binary-entry-provider.js';
import {createDsl4VideoAssetAdapter} from '../src/dsl4/platform/video-asset-adapter.js';
import {dsl4TestSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';

const video = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109]);
const integrity = `sha256-${createHash('sha256').update(video).digest('hex')}`;
const url = 'https://example.test/movie.mp4';
const limits = {
  maxFiles: 10,
  maxFileBytes: 4096,
  maxTotalBytes: 8192,
  subtleCrypto: webcrypto.subtle,
};
const actions = `scenes:\n  main:\n    - video: {id: movie, asset: Movie, x: 0, y: 0, width: 320, height: 180}\n    - videoControl: {id: movie, operation: playUntilDone}\n`;

/** A remote asset whose source pins the bytes, which is what a retained copy is checked against. */
function remoteStory() {
  const source = `kamishibai: '4.0'\nassets:\n  Movie:\n    kind: video\n    delivery: remote\n    source:\n      url: '${url}'\n      integrity: '${integrity}'\n      contentType: video/mp4\n      size: ${video.length}\n${actions}`;
  const parsed = frontend.parse(source);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  return parsed.storyDocument!;
}

/** A snapshot that serves the reserved retained path, which is how a build asks to retain bytes. */
const retainingSnapshot = (story: Readonly<Record<string, unknown>>, bytes = video) => ({
  manifest: {
    formatVersion: 1,
    assets: [
      {
        id: 'Movie',
        kind: 'video',
        loading: 'eager',
        source: {type: 'remote', url, integrity, contentType: 'video/mp4', size: video.length},
      },
    ],
  },
  getFile(assetId: string, filePath: string) {
    if (assetId === 'Movie' && filePath === dsl4RetainedRemotePayloadPath) return bytes;
    throw new Error(`no such file: ${assetId}/${filePath}`);
  },
  story,
});

test('a build retains a remote asset only when its snapshot serves the reserved path', async () => {
  const story = remoteStory();
  const retained = await createDsl4EmbeddedAssetBundle(story, retainingSnapshot(story), limits);
  assert.deepEqual(
    retained.files.map((file: {assetId: string; path: string}) => [file.assetId, file.path]),
    [['Movie', dsl4RetainedRemotePayloadPath]],
  );
  // The payload carries this bundle's own SRI integrity, not the source's hex pin.
  assert.match(retained.files[0]!.integrity, /^sha256-[A-Za-z0-9+/]+=*$/u);
  assert.notEqual(retained.files[0]!.integrity, integrity);

  // A snapshot without the reserved path leaves the asset remote-only, as it was before.
  const remoteOnly = await createDsl4EmbeddedAssetBundle(
    story,
    {
      manifest: retainingSnapshot(story).manifest,
      getFile() {
        throw new Error('no retained copy');
      },
    },
    limits,
  );
  assert.deepEqual(remoteOnly.files, []);
});

test('bundle validation accepts a retained remote payload and still requires file payloads', async () => {
  const story = remoteStory();
  const bundle = await createDsl4EmbeddedAssetBundle(story, retainingSnapshot(story), limits);
  const validated = await validateDsl4EmbeddedAssetBundle(story, bundle, limits);
  assert.equal(validated.descriptor.files.length, 1);
  // The retained copy is reachable through the bundle's own lookup, keyed by the reserved path.
  assert.deepEqual(
    Buffer.from(validated.getFile('Movie', dsl4RetainedRemotePayloadPath)),
    Buffer.from(video),
  );

  // A copy that is not the pinned bytes is rejected rather than used.
  const tampered = {
    ...bundle,
    files: [{...bundle.files[0]!, data: Buffer.from('different').toString('base64')}],
  };
  await assert.rejects(
    validateDsl4EmbeddedAssetBundle(story, tampered, limits),
    /size does not match|integrity|Payload metadata/u,
  );
});

test('playback uses the retained copy instead of the network, and refuses a corrupt one', async () => {
  const story = remoteStory();
  const bundle = await createDsl4EmbeddedAssetBundle(story, retainingSnapshot(story), limits);
  const requested: string[] = [];

  const lifecycle = createDsl4EmbeddedAssetLifecycle({
    runtimeComponent: {
      storyDocument: story,
      assetBundle: bundle,
      getAssetFile: (assetId: string, filePath: string) => {
        requested.push(`${assetId}/${filePath}`);
        if (filePath === dsl4RetainedRemotePayloadPath) return video;
        throw new Error(`no such file: ${assetId}/${filePath}`);
      },
    },
    adapter: createDsl4VideoAssetAdapter({
      createObjectURL: () => 'blob:movie',
      revokeObjectURL: () => {},
    }),
    setLoading() {},
    subtleCrypto: webcrypto.subtle,
    // No remote loader is supplied, so reaching the network at all would fail the load.
  });
  await lifecycle.prepare({assetIds: ['Movie']}, {signal: new AbortController().signal});
  assert.equal((lifecycle.getResource('Movie') as {objectUrl: string}).objectUrl, 'blob:movie');
  assert.deepEqual(requested, [`Movie/${dsl4RetainedRemotePayloadPath}`]);
  await lifecycle.release({reason: 'test'});

  const corrupt = createDsl4EmbeddedAssetLifecycle({
    runtimeComponent: {
      storyDocument: story,
      assetBundle: bundle,
      getAssetFile: () => Buffer.from('not the pinned bytes'),
    },
    adapter: createDsl4VideoAssetAdapter({
      createObjectURL: () => 'blob:movie',
      revokeObjectURL: () => {},
    }),
    setLoading() {},
    subtleCrypto: webcrypto.subtle,
  });
  await assert.rejects(
    corrupt.prepare({assetIds: ['Movie']}, {signal: new AbortController().signal}),
    /do not match their integrity/u,
  );
});

/** An adapter that records what the lifecycle hands it, standing in for a real media adapter. */
function recordingAdapter() {
  const prepared: Record<string, unknown>[] = [];
  return {
    prepared,
    adapter: {
      prepare(payload: unknown) {
        prepared.push(payload as Record<string, unknown>);
        return {};
      },
      release() {},
    },
  };
}

test('a retained copy of the same size but different bytes is refused when the bundle is built', async () => {
  const story = remoteStory();
  const forged = Buffer.alloc(video.length, 7);
  assert.equal(forged.length, video.length, 'same size, so only the content can tell them apart');
  await assert.rejects(
    createDsl4EmbeddedAssetBundle(story, retainingSnapshot(story, forged), limits),
    /Retained payload does not match its remote source/u,
  );
});

test('a retained copy reaches the adapter with the integrity the network path would give', async () => {
  const story = remoteStory();
  const bundle = await createDsl4EmbeddedAssetBundle(story, retainingSnapshot(story), limits);
  const {prepared, adapter} = recordingAdapter();
  const lifecycle = createDsl4EmbeddedAssetLifecycle({
    runtimeComponent: {
      storyDocument: story,
      assetBundle: bundle,
      getAssetFile: (_assetId: string, filePath: string) => {
        if (filePath === dsl4RetainedRemotePayloadPath) return video;
        throw new Error(`no such file: ${filePath}`);
      },
    },
    adapter,
    setLoading() {},
    subtleCrypto: webcrypto.subtle,
  });
  await lifecycle.prepare({assetIds: ['Movie']}, {signal: new AbortController().signal});
  const files = prepared[0]!.files as {integrity?: unknown; contentType?: unknown}[];
  // Image adapters key shared object URLs by this value, so it must be present and exact.
  assert.equal(files[0]!.integrity, integrity);
  assert.equal(files[0]!.contentType, 'video/mp4');
  await lifecycle.release({reason: 'test'});
});

test('a retained pose model is extracted like a fetched one, not handed on as an archive', async () => {
  const archiveBytes = Buffer.from('a pose model archive standing in for a zip');
  const archiveIntegrity = `sha256-${createHash('sha256').update(archiveBytes).digest('hex')}`;
  const poseUrl = 'https://example.test/pose.zip';
  const parsed = frontend.parse(
    `kamishibai: '4.0'\nassets:\n  Pose:\n    kind: recognitionModel\n    delivery: remote\n    source:\n      url: '${poseUrl}'\n      integrity: '${archiveIntegrity}'\n      contentType: application/zip\n      size: ${archiveBytes.length}\nscenes:\n  main: []\n`,
  );
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const story = parsed.storyDocument!;
  const loading = (story.assets as Record<string, {loading: string}>).Pose!.loading;
  const bundle = await createDsl4EmbeddedAssetBundle(
    story,
    {
      manifest: {
        formatVersion: 1,
        assets: [
          {
            id: 'Pose',
            kind: 'recognitionModel',
            loading,
            source: {
              type: 'remote',
              url: poseUrl,
              integrity: archiveIntegrity,
              contentType: 'application/zip',
              size: archiveBytes.length,
            },
          },
        ],
      },
      getFile(_assetId: string, filePath: string) {
        if (filePath === dsl4RetainedRemotePayloadPath) return archiveBytes;
        throw new Error(`no such file: ${filePath}`);
      },
    },
    limits,
  );
  const extractedFrom: Uint8Array[] = [];
  const {prepared, adapter} = recordingAdapter();
  const lifecycle = createDsl4EmbeddedAssetLifecycle({
    runtimeComponent: {
      storyDocument: story,
      assetBundle: bundle,
      getAssetFile: (_assetId: string, filePath: string) => {
        if (filePath === dsl4RetainedRemotePayloadPath) return archiveBytes;
        throw new Error(`no such file: ${filePath}`);
      },
    },
    adapter,
    setLoading() {},
    subtleCrypto: webcrypto.subtle,
    extractRemotePoseArchive: async (input: unknown) => {
      const {bytes} = input as {bytes: Uint8Array};
      extractedFrom.push(bytes);
      const file = (path: string) => ({
        path,
        bytes: new TextEncoder().encode(path),
        integrity: `sha256-${path}`,
        archiveIntegrity,
        extractorFormat: 'test',
      });
      return {
        archiveIntegrity,
        extractorFormat: 'test',
        files: [file('model.json'), file('metadata.json'), file('weights.bin')],
      };
    },
  });
  await lifecycle.prepare({assetIds: ['Pose']}, {signal: new AbortController().signal});
  assert.deepEqual(
    extractedFrom.map((bytes) => Buffer.from(bytes)),
    [archiveBytes],
  );
  assert.deepEqual(
    (prepared[0]!.files as {path: string}[]).map((entry) => entry.path),
    ['model.json', 'metadata.json', 'weights.bin'],
  );
  await lifecycle.release({reason: 'test'});
});

test('binary-entry packaging refuses a retained copy instead of silently dropping it', async () => {
  const story = remoteStory();
  await assert.rejects(
    createDsl4BinaryEntryAssetBundle(story, retainingSnapshot(story), limits),
    /cannot keep the retained copy of remote asset Movie/u,
  );
});
