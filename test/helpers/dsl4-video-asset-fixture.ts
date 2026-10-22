import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {
  createDsl4EmbeddedAssetBundle,
  validateDsl4EmbeddedAssetBundle,
} from '../../src/dsl4/asset-bundle-descriptor.js';
import {createDsl4EmbeddedAssetLifecycle} from '../../src/dsl4/embedded-asset-lifecycle.js';
import {createDsl4VideoAssetAdapter} from '../../src/dsl4/platform/video-asset-adapter.js';
import {createDsl4VideoActionPort} from '../../src/dsl4/platform/video-action-port.js';
import {releaseDsl4PlaybackAssets} from '../../src/dsl4/platform/playback-asset-release.js';
import {dsl4TestSourceFrontend as frontend} from './dsl4-test-frontend.ts';

/** Synthetic media/renderer resources; actual decoding remains covered by browser tests. */
class Video extends EventTarget {
  style: Record<string, string> = {};
  src = '';
  currentTime = 0;
  loop = false;
  muted = false;
  volume = 1;
  playbackRate = 1;
  readyState = 2;
  videoWidth = 160;
  videoHeight = 120;
  paused = true;
  ended = false;
  loads = 0;
  loadFailure: Error | null = null;
  frames = new Map<number, () => void>();
  nextFrame = 0;
  canvas = {
    width: 0,
    height: 0,
    getContext: () => ({fillStyle: '', fillRect() {}, drawImage() {}}),
  };
  ownerDocument = {defaultView: null, createElement: () => this.canvas};
  play() {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  load() {
    this.loads++;
    if (this.loadFailure) throw this.loadFailure;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  requestVideoFrameCallback(callback: () => void) {
    const id = ++this.nextFrame;
    this.frames.set(id, callback);
    return id;
  }
  cancelVideoFrameCallback(id: number) {
    this.frames.delete(id);
  }
}

export async function createVideoAssetFixture(
  fixtureOptions: {
    document?: Readonly<Record<string, unknown>>;
    movieMarker?: number;
    adapter?: ReturnType<typeof createDsl4VideoAssetAdapter>;
  } = {},
) {
  const parsed = frontend.parse(`kamishibai: '4.0'
assets:
  Movie: {kind: video, file: movie.webm, loading: lazy, retention: scene}
  Shared: {kind: video, file: shared.webm, loading: lazy, retention: scene}
scenes:
  first:
    - video: {id: first, asset: Movie, x: 0, y: 0, width: 160, height: 120}
    - video: {id: shared, asset: Shared, x: 0, y: 0, width: 160, height: 120}
  next:
    - video: {id: shared, asset: Shared, x: 0, y: 0, width: 160, height: 120}
`);
  assert(parsed.ok, JSON.stringify(parsed.diagnostics));
  const bytes = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]);
  const storyDocument = fixtureOptions.document ?? parsed.storyDocument;
  const bytesFor = (id: string) =>
    id === 'Shared'
      ? Uint8Array.from([...bytes, 1])
      : fixtureOptions.movieMarker === undefined
        ? bytes
        : Uint8Array.from([...bytes, fixtureOptions.movieMarker]);
  const options = {maxFiles: 4, maxTotalBytes: 1024, subtleCrypto: webcrypto.subtle};
  const descriptor = await createDsl4EmbeddedAssetBundle(
    storyDocument,
    {
      manifest: {
        formatVersion: 1,
        assets: ['Movie', 'Shared'].map((id) => ({
          id,
          kind: 'video',
          loading: 'lazy',
          source: {
            type: 'file',
            mode: 'file',
            inputPath: id.toLowerCase() + '.webm',
            files: [
              {
                path: id.toLowerCase() + '.webm',
                size: bytesFor(id).length,
                integrity: 'sha256-' + createHash('sha256').update(bytesFor(id)).digest('base64'),
              },
            ],
          },
        })),
      },
      getFile: (id: string) => new Uint8Array(bytesFor(id)),
    },
    options,
  );
  const validated = await validateDsl4EmbeddedAssetBundle(storyDocument, descriptor, options);
  const liveUrls = new Set<string>(),
    revoked: string[] = [],
    videos: Video[] = [],
    overlays = new Set<unknown>(),
    skins = new Set<number>(),
    drawables = new Set<number>(),
    order: string[] = [];
  let ordinal = 0;
  let revokeFailure: Error | null = null;
  const adapter =
    fixtureOptions.adapter ??
    createDsl4VideoAssetAdapter({
      createObjectURL() {
        const url = 'blob:video-' + ++ordinal;
        liveUrls.add(url);
        return url;
      },
      revokeObjectURL(url) {
        assert(
          videos.filter((v) => v.src === url).every((v) => v.paused),
          'Playback must be stopped before URL release',
        );
        assert(
          !videos.some((v) => v.src === url),
          'Every matching element must drop src before URL release',
        );
        order.push('revoke:' + url);
        liveUrls.delete(url);
        revoked.push(url);
        if (revokeFailure) throw revokeFailure;
      },
    });
  const base = createDsl4EmbeddedAssetLifecycle({
    runtimeComponent: {
      storyDocument,
      assetBundle: validated.descriptor,
      getAssetFile: validated.getFile,
    },
    adapter,
    setLoading() {},
  });
  const port = createDsl4VideoActionPort({
    renderer: {
      addOverlay(element: unknown) {
        overlays.add(element);
        return {container: {style: {}}};
      },
      removeOverlay(element: unknown) {
        order.push('overlay-release');
        overlays.delete(element);
      },
      createBitmapSkin() {
        const id = ++ordinal;
        skins.add(id);
        return id;
      },
      createDrawable() {
        const id = ++ordinal;
        drawables.add(id);
        return id;
      },
      destroySkin(id: number) {
        order.push('skin-release');
        skins.delete(id);
      },
      destroyDrawable(id: number) {
        order.push('drawable-release');
        drawables.delete(id);
      },
      updateBitmapSkin() {},
      updateDrawableSkinId() {},
      updateDrawablePosition() {},
      updateDrawableScale() {},
      setDrawableOrder() {},
      updateDrawableVisible() {},
    },
    getAssetResource: base.getResource,
    createVideo() {
      const v = new Video();
      videos.push(v);
      return v as unknown as HTMLVideoElement;
    },
  });
  const audioCalls: unknown[] = [];
  const audio = {
    releaseAssets(ids: readonly string[]) {
      order.push('audio-release');
      audioCalls.push(ids);
    },
    clear() {
      order.push('audio-clear');
    },
  };
  const lifecycle = {
    prepare: base.prepare,
    setLoading: base.setLoading,
    releaseAssets(payload: Readonly<{assetIds: readonly string[]}>) {
      return releaseDsl4PlaybackAssets({
        videoPort: port,
        audioPort: audio,
        assetIds: payload.assetIds,
        releaseBase: () => base.releaseAssets(payload),
      });
    },
    release(payload: Readonly<Record<string, unknown>>) {
      return releaseDsl4PlaybackAssets({
        videoPort: port,
        audioPort: audio,
        assetIds: undefined,
        releaseBase: () => base.release(payload),
      });
    },
  };
  const context = {signal: new AbortController().signal, generation: 1, sceneId: 'first'};
  const show = (id: string, asset: string, plane = 'front') =>
    port.video({id, asset, plane, x: 0, y: 0, width: 160, height: 120}, context);
  return {
    base,
    port,
    lifecycle,
    context,
    show,
    liveUrls,
    revoked,
    videos,
    overlays,
    skins,
    drawables,
    order,
    audioCalls,
    storyDocument,
    validated,
    setRevokeFailure(error: Error | null) {
      revokeFailure = error;
    },
  };
}
