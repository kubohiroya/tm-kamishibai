import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4BrowserRemoteAssetLoader} from '../src/dsl4/platform/browser-remote-asset-loader.js';
import {thrown} from './helpers/thrown-error.ts';

/** The fetch response members the loader reads, as this suite fakes them. */
function response(chunks: readonly Uint8Array[], headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    url: 'https://cdn.example.com/model.json',
    headers: {get: (name: string) => headers[name.toLowerCase()] ?? null},
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}

test('loads one HTTPS response with omitted credentials and a bounded byte stream', async () => {
  const requests: {url: string; options: Readonly<Record<string, unknown>>}[] = [];
  const loader = createDsl4BrowserRemoteAssetLoader({
    maxBytes: 4,
    timeoutMs: 1000,
    async fetch(url: string, options: Readonly<Record<string, unknown>>) {
      requests.push({url, options});
      return response([new Uint8Array([1, 2]), new Uint8Array([3])], {
        'content-length': '3',
        'content-type': 'application/json; charset=utf-8',
      });
    },
  });

  const loaded = await loader(
    {assetId: 'Pose', url: 'https://cdn.example.com/model.json'},
    {signal: new AbortController().signal},
  );
  assert.deepEqual(loaded.bytes, new Uint8Array([1, 2, 3]));
  assert.equal(loaded.contentType, 'application/json; charset=utf-8');
  const [request] = requests;
  assert.ok(request, 'the loader must have issued one request');
  assert.equal(request.url, 'https://cdn.example.com/model.json');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.redirect, 'follow');
});

test('rejects insecure URLs, oversized streams, and timeouts', async () => {
  const secureLoader = createDsl4BrowserRemoteAssetLoader({
    maxBytes: 2,
    timeoutMs: 1000,
    fetch: async () => response([new Uint8Array([1, 2, 3])]),
  });
  await assert.rejects(
    secureLoader({url: 'http://cdn.example.com/model.json'}),
    (error) => thrown(error).code === 'K4-ASSET-REMOTE-URL-001',
  );
  await assert.rejects(
    secureLoader({url: 'https://cdn.example.com/model.json'}),
    (error) => thrown(error).code === 'K4-ASSET-REMOTE-LIMIT-001',
  );

  const timeoutLoader = createDsl4BrowserRemoteAssetLoader({
    maxBytes: 2,
    timeoutMs: 1,
    schedule(callback) {
      queueMicrotask(callback);
      return 1;
    },
    cancelSchedule() {},
    // The loader declares `init` as an open record, so the signal is read back out of it rather
    // than destructured into a narrower parameter the loader could not call.
    fetch(_url: string, init: Readonly<Record<string, unknown>>) {
      const {signal} = init;
      if (!(signal instanceof AbortSignal)) {
        throw new TypeError('the loader must pass an AbortSignal');
      }
      return new Promise<never>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
      });
    },
  });
  await assert.rejects(
    timeoutLoader({url: 'https://cdn.example.com/model.json'}),
    (error) => thrown(error).code === 'K4-ASSET-REMOTE-TIMEOUT-001',
  );
});
