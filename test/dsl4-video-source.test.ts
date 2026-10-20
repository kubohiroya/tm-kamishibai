import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'vitest';

import {loadDsl4LocalAssetSnapshot} from '../src/builder/dsl4-local-assets.js';
import {contentTypeFor} from '../src/builder/dsl4-asset-media.js';
import {createDsl4EmbeddedAssetBundle} from '../src/dsl4/asset-bundle-descriptor.js';
import {
  createDsl4EmbeddedAssetLifecycle,
  createDsl4RemoteAssetLifecycle,
} from '../src/dsl4/embedded-asset-lifecycle.js';
import {createDsl4VideoAssetAdapter} from '../src/dsl4/platform/video-asset-adapter.js';
import {createDsl4AssetDependencyIndex} from '../src/dsl4/asset-dependency-index.js';
import {dsl4TestSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';

const video = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109]);
const actions = `scenes:\n  main:\n    - video: {id: movie, asset: Movie, x: 0, y: 0, width: 320, height: 180}\n    - videoControl: {id: movie, operation: playUntilDone}\n`;
const limits = {
  maxFiles: 10,
  maxFileBytes: 4096,
  maxTotalBytes: 8192,
  subtleCrypto: webcrypto.subtle,
};

test('validates video source exclusivity, asset kind, rectangle dimensions and operations', () => {
  const valid = {
    id: 'movie',
    url: 'https://example.com/movie.mp4',
    x: 0,
    y: 0,
    width: 320,
    height: 180,
  };
  for (const args of [
    valid,
    {...valid, muted: true},
    {...valid, plane: 'background', zIndex: -2},
    {...valid, plane: 'front', zIndex: 0},
  ]) {
    assert.equal(
      frontend.parse(JSON.stringify({kamishibai: '4.0', scenes: {main: [{video: args}]}})).ok,
      true,
    );
  }
  for (const args of [
    {...valid, asset: 'Movie'},
    {...valid, url: undefined},
    {...valid, width: 0},
    {...valid, height: -1},
    {...valid, muted: 'yes'},
    {...valid, plane: 'sprite'},
    {...valid, plane: null},
    {...valid, zIndex: 1.5},
    {...valid, zIndex: '2'},
    {...valid, zIndex: Number.MAX_SAFE_INTEGER + 1},
    {...valid, url: 'https://user:pass@example.com/a.mp4'},
  ]) {
    assert.equal(
      frontend.parse(JSON.stringify({kamishibai: '4.0', scenes: {main: [{video: args}]}})).ok,
      false,
      JSON.stringify(args),
    );
  }
  assert.equal(frontend.parse(`kamishibai: '4.0'\nassets: {Movie: sound}\n${actions}`).ok, false);
  assert.equal(
    frontend.parse(
      `kamishibai: '4.0'\nscenes: {main: [{videoControl: {id: movie, operation: unknown}}]}`,
    ).ok,
    false,
  );
});

test('file video survives bundle creation, dependency indexing, materialization and release', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsl4-video-'));
  try {
    await writeFile(path.join(root, 'movie.mp4'), video);
    const parsed = frontend.parse(
      `kamishibai: '4.0'\nassets: {Movie: {kind: video, file: movie.mp4}}\n${actions}`,
    );
    assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
    const story = parsed.storyDocument!;
    const snapshot = await loadDsl4LocalAssetSnapshot(root, story, limits);
    const bundle = await createDsl4EmbeddedAssetBundle(story, snapshot, limits);
    assert.equal(contentTypeFor(video, 'movie.mp4', 'video'), 'video/mp4');
    assert.match(JSON.stringify(createDsl4AssetDependencyIndex(story)), /Movie/u);
    const revoked: string[] = [];
    const lifecycle = createDsl4EmbeddedAssetLifecycle({
      runtimeComponent: {storyDocument: story, assetBundle: bundle, getAssetFile: () => video},
      adapter: createDsl4VideoAssetAdapter({
        createObjectURL: () => 'blob:movie',
        revokeObjectURL: (url) => {
          revoked.push(url);
        },
      }),
      setLoading() {},
    });
    await lifecycle.prepare({assetIds: ['Movie']}, {signal: new AbortController().signal});
    assert.equal((lifecycle.getResource('Movie') as {objectUrl: string}).objectUrl, 'blob:movie');
    await lifecycle.release({reason: 'test'});
    assert.deepEqual(revoked, ['blob:movie']);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('remote video uses the existing remote loader and rejects non-video Content-Type', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsl4-video-remote-'));
  try {
    const parsed = frontend.parse(
      `kamishibai: '4.0'\nassets: {Movie: {kind: video, delivery: remote, source: {url: 'https://example.com/movie.mp4'}}}\n${actions}`,
    );
    assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
    const story = parsed.storyDocument!;
    const snapshot = await loadDsl4LocalAssetSnapshot(root, story, limits);
    const bundle = await createDsl4EmbeddedAssetBundle(story, snapshot, limits);
    for (const contentType of ['video/mp4', 'image/png']) {
      const lifecycle = createDsl4RemoteAssetLifecycle({
        runtimeComponent: {
          storyDocument: story,
          assetBundle: bundle,
          getAssetFile() {
            throw new Error('remote');
          },
        },
        adapter: createDsl4VideoAssetAdapter({
          createObjectURL: () => 'blob:movie',
          revokeObjectURL() {},
        }),
        setLoading() {},
        loadRemoteAsset: () => ({bytes: video, contentType}),
      });
      const preparing = lifecycle.prepare(
        {assetIds: ['Movie']},
        {signal: new AbortController().signal},
      );
      if (contentType === 'video/mp4') await preparing;
      else await assert.rejects(preparing);
      await lifecycle.release({reason: 'test'});
    }
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
