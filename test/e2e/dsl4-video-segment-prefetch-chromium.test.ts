import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {access, mkdir, readFile, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'vitest';
import {chromium, type Browser} from 'playwright-core';

import {validateDsl4PublicationManifest} from '../../src/dsl4/publication-manifest.js';
import {dsl4TestSourceFrontend as frontend} from '../helpers/dsl4-test-frontend.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function chromeExecutable() {
  for (const candidate of [
    process.env.CHROME_BIN,
    process.env.GOOGLE_CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'google-chrome',
    'chromium',
  ]) {
    if (!candidate) continue;
    const resolved = candidate.includes('/')
      ? candidate
      : spawnSync('which', [candidate], {encoding: 'utf8'}).stdout.trim();
    if (resolved)
      try {
        await access(resolved);
        return resolved;
      } catch {
        /* Try the next installed browser. */
      }
  }
  throw new Error('Set CHROME_BIN to run the video segment prefetch regression');
}

test('prefetch stores a verified remote video in native IndexedDB and the cached bytes decode', async () => {
  const movie = await readFile(path.join(root, 'test/fixtures/dsl4/video-sample.webm'));
  const remoteUrl = 'https://cdn.example.com/video-sample.webm';
  const integrity = 'sha256-' + createHash('sha256').update(movie).digest('hex');
  const parsed = frontend.parse(`kamishibai: '4.0'
assets:
  Movie:
    kind: video
    delivery: remote
    loading: lazy
    retention: scene
    source: {url: '${remoteUrl}', integrity: ${integrity}, contentType: video/webm, size: ${movie.length}}
scenes:
  first:
    - video: {id: m, asset: Movie, x: 0, y: 0, width: 160, height: 120}
`);
  assert(parsed.ok, JSON.stringify(parsed.diagnostics));
  const manifest = validateDsl4PublicationManifest({
    formatVersion: 1,
    id: 'browser-prefetch',
    title: 'Browser prefetch',
    entrySegment: 's0',
    entryPoints: ['s0'],
    segments: ['s0', 's1'].map((id, i) => ({
      id,
      title: id,
      next: i === 0 ? ['s1'] : [],
      source: {entry: `${id}.yaml`, size: 1, integrity: 'sha256-' + '0'.repeat(64)},
    })),
  });
  let videoReads = 0;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/remote/video-sample.webm') videoReads++;
    const file = path.resolve(
      root,
      '.' +
        (pathname === '/remote/video-sample.webm'
          ? '/test/fixtures/dsl4/video-sample.webm'
          : pathname),
    );
    if (
      !file.startsWith(root) ||
      !['/dist/', '/node_modules/', '/test/fixtures/', '/remote/'].some((prefix) =>
        pathname.startsWith(prefix),
      )
    ) {
      response.writeHead(404).end();
      return;
    }
    try {
      const bytes = await readFile(file);
      const type = pathname.endsWith('.html')
        ? 'text/html'
        : pathname.endsWith('.webm')
          ? 'video/webm'
          : 'text/javascript';
      response.writeHead(200, {'content-type': type}).end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({executablePath: await chromeExecutable(), headless: true});
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(
      `http://127.0.0.1:${address.port}/test/fixtures/dsl4/browser/video-segment-prefetch.html`,
    );
    // Module scripts resolve the served dist and the page import map in the browser itself.
    await page.addScriptTag({
      type: 'module',
      content: `globalThis.__prefetchModules = {
        ...(await import('/dist/dsl4/publication-video-prefetch.js')),
        ...(await import('/dist/dsl4/platform/publication-video-prefetch-resolver.js')),
        ...(await import('@kubohiroya/turbowarp-asset-cache/composition')),
      };`,
    });
    await page.waitForFunction(() => Reflect.has(globalThis, '__prefetchModules'));
    const report = await page.evaluate(
      async ({manifest, storyDocument, remoteUrl, integrity, size}) => {
        const {
          createDsl4PublicationVideoPrefetch,
          createDsl4VerifiedVideoPrefetchResolver,
          createVerifiedRemoteBinaryCache,
        } = Reflect.get(globalThis, '__prefetchModules');
        const checks: string[] = [];
        const check = (condition: unknown, message: string) => {
          if (!condition) throw new Error(message);
          checks.push(message);
        };
        const cacheIdentity = {
          id: 'browserprefetch01',
          label: 'browser-prefetch.yaml',
          databaseName: 'tw-kamishibai-assets-v1--browser-prefetch--browserprefetch01',
        };
        const verifiedRemoteCacheOptions = {
          indexedDB,
          subtleCrypto: crypto.subtle,
          estimateStorage: async () => ({quota: 64 * 1024 * 1024, usage: 0}),
        };
        let hold: Promise<void> | null = null;
        const loadRemoteAsset = async (
          payload: Record<string, unknown>,
          context: {signal?: AbortSignal},
        ) => {
          if (payload.url !== remoteUrl) throw new Error('unexpected URL');
          await hold;
          const response = await fetch('/remote/video-sample.webm', {
            signal: context.signal ?? null,
          });
          return {bytes: new Uint8Array(await response.arrayBuffer()), contentType: 'video/webm'};
        };
        const prefetch = createDsl4PublicationVideoPrefetch({
          manifest,
          loadDocument: async () => storyDocument,
          resolveRemoteVideo: createDsl4VerifiedVideoPrefetchResolver({
            loadRemoteAsset,
            cacheIdentityFor: () => cacheIdentity,
            verifiedRemoteCacheOptions,
          }),
        });
        const session = createVerifiedRemoteBinaryCache({
          ...verifiedRemoteCacheOptions,
          cacheIdentity,
        });
        const input = {url: remoteUrl, integrity, size, contentType: 'video/webm'};
        try {
          await session.clear();
          // A cancelled warm-up stores nothing.
          let open!: () => void;
          hold = new Promise((resolve) => (open = resolve));
          const cancelled = prefetch.prefetchNext('s0');
          await new Promise((resolve) => setTimeout(resolve, 10));
          prefetch.cancel('transition');
          open();
          hold = null;
          const cancelledResults = await cancelled;
          check(cancelledResults[0]?.status === 'cancelled', 'cancelled-warm-up-reported');
          check((await session.getStats()).entries === 0, 'cancelled-warm-up-stores-nothing');
          const results = await prefetch.prefetchNext('s0');
          check(
            results.length === 1 && results[0]!.status === 'ready',
            'warm-up-ready-for-next-segment',
          );
          const stats = await session.getStats();
          check(stats.entries === 1 && stats.bytes === size, 'native-IDB-holds-verified-bytes');
          const hit = await session.resolve(input, {
            load: () => Promise.reject(new Error('transition must not reach the network')),
          });
          check(hit.source === 'indexeddb' && hit.cacheRead === 'hit', 'transition-is-cache-hit');
          const objectUrl = URL.createObjectURL(new Blob([hit.bytes], {type: 'video/webm'}));
          const video = document.createElement('video');
          video.muted = true;
          video.src = objectUrl;
          await new Promise<void>((resolve, reject) => {
            video.addEventListener('loadeddata', () => resolve(), {once: true});
            video.addEventListener('error', () => reject(new Error('decode failed')), {once: true});
          });
          const [width, height] = [video.videoWidth, video.videoHeight];
          check(width > 0 && height > 0, 'cached-bytes-decode-natively');
          video.removeAttribute('src');
          video.load();
          URL.revokeObjectURL(objectUrl);
          return {checks, width, height, stats};
        } finally {
          await session.clear();
          await session.releaseStoryCacheLease();
        }
      },
      {
        manifest,
        storyDocument: parsed.storyDocument,
        remoteUrl,
        integrity,
        size: movie.length,
      },
    );
    assert.deepEqual(errors, []);
    assert.equal(report.checks.length, 6);
    assert(videoReads >= 1 && videoReads <= 2, `video reads: ${videoReads}`);
    const output = path.join(root, 'tmp/video-segment-prefetch-browser');
    await mkdir(output, {recursive: true});
    const result = {browser: await browser.version(), videoReads, report, pageErrors: errors};
    await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally {
    try {
      await browser?.close();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
});
