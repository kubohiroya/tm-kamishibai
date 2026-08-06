import assert from 'node:assert/strict';
import test from 'node:test';

import {createDsl4AssetManagerAdapter} from '../src/dsl4/platform/index.js';

function mimeType(sourceName) {
  if (sourceName.endsWith('.svg')) return 'image/svg+xml';
  if (sourceName.endsWith('.png')) return 'image/png';
  if (sourceName.endsWith('.wav')) return 'audio/wav';
  return 'application/octet-stream';
}

function fakeComposition(overrides = {}) {
  const calls = {project: [], embedded: [], release: []};
  return {
    calls,
    composition: Object.freeze({
      async registerProjectAsset(input) {
        calls.project.push(input);
        return Object.freeze({name: input.name, mimeType: 'image/svg+xml'});
      },
      async registerEmbeddedAsset(input) {
        calls.embedded.push(input);
        return Object.freeze({name: input.name, mimeType: mimeType(input.sourceName)});
      },
      releaseAsset(name) {
        calls.release.push(name);
      },
      ...overrides,
    }),
  };
}

function projectAsset(id, kind, name, target) {
  return {
    asset: {
      id,
      kind,
      ...(target ? {target} : {}),
      source: {type: 'project', name},
    },
    files: [],
  };
}

function embeddedAsset(id, kind, filePath, bytes = new Uint8Array([1, 2, 3])) {
  return {
    asset: {id, kind, source: {type: 'file'}},
    files: [{path: filePath, bytes}],
  };
}

function remoteAsset(id, kind, url, contentType, bytes = new Uint8Array([1, 2, 3])) {
  return {
    asset: {id, kind, source: {type: 'remote', url}},
    files: [{path: url, contentType, bytes}],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {promise, resolve};
}

test('maps project backdrop, costume, and stage sound references deterministically', async () => {
  const fake = fakeComposition();
  const adapter = createDsl4AssetManagerAdapter({composition: fake.composition});
  const backdrop = await adapter.prepare(projectAsset('Beach', 'backdrop', 'Beach'));
  const costume = await adapter.prepare(projectAsset('HeroHappy', 'costume', 'happy', 'Hero'));
  const sound = await adapter.prepare(projectAsset('Opening', 'sound', 'Opening'));

  assert.deepEqual(fake.calls.project, [
    {name: 'Beach', resourceId: 'backdrop:Beach'},
    {name: 'HeroHappy', resourceId: 'costume:Hero:happy'},
    {name: 'Opening', resourceId: 'sound:@stage:Opening'},
  ]);
  assert.deepEqual(
    [backdrop, costume, sound].map(({assetId, kind, name}) => [assetId, kind, name]),
    [
      ['Beach', 'backdrop', 'Beach'],
      ['HeroHappy', 'costume', 'HeroHappy'],
      ['Opening', 'sound', 'Opening'],
    ],
  );
  assert.ok([backdrop, costume, sound].every(Object.isFrozen));

  adapter.release(costume);
  adapter.release(costume);
  assert.deepEqual(fake.calls.release, ['HeroHappy']);
});

test('registers one embedded image or audio file with path-derived MIME normalization', async () => {
  const fake = fakeComposition();
  const adapter = createDsl4AssetManagerAdapter({composition: fake.composition});
  const svgBytes = new TextEncoder().encode('<svg/>');
  const svg = await adapter.prepare(
    embeddedAsset('OpeningImage', 'backdrop', 'assets/opening.svg', svgBytes),
  );
  const bitmap = await adapter.prepare(embeddedAsset('HeroCostume', 'costume', 'assets/hero.png'));
  const audio = await adapter.prepare(embeddedAsset('OpeningSound', 'sound', 'sounds/opening.wav'));

  assert.equal(fake.calls.embedded[0].name, 'OpeningImage');
  assert.equal(fake.calls.embedded[0].sourceName, 'assets/opening.svg');
  assert.equal(fake.calls.embedded[0].mimeType, '');
  assert.strictEqual(fake.calls.embedded[0].bytes, svgBytes);
  assert.equal(svg.mimeType, 'image/svg+xml');
  assert.equal(bitmap.mimeType, 'image/png');
  assert.equal(audio.mimeType, 'audio/wav');
});

test('registers verified remote bytes with their declared Content-Type', async () => {
  const fake = fakeComposition();
  const adapter = createDsl4AssetManagerAdapter({composition: fake.composition});
  const payload = remoteAsset(
    'RemoteImage',
    'backdrop',
    'https://cdn.example.com/image.svg',
    'image/svg+xml',
  );
  await adapter.prepare(payload);
  assert.deepEqual(fake.calls.embedded[0], {
    name: 'RemoteImage',
    sourceName: 'https://cdn.example.com/image.svg',
    mimeType: 'image/svg+xml',
    bytes: payload.files[0].bytes,
  });
});

test('rejects unsupported kinds and malformed materialization before registration', async () => {
  const fake = fakeComposition();
  const adapter = createDsl4AssetManagerAdapter({composition: fake.composition});
  const invalid = [
    {asset: {id: 'Pose', kind: 'poseModel', source: {type: 'file'}}, files: []},
    {asset: {id: 'Unknown', kind: 'video', source: {type: 'file'}}, files: []},
    {asset: {id: 'Empty', kind: 'sound', source: {type: 'file'}}, files: []},
    {
      asset: {id: 'Multiple', kind: 'backdrop', source: {type: 'file'}},
      files: [
        {path: 'a.svg', bytes: new Uint8Array([1])},
        {path: 'b.svg', bytes: new Uint8Array([2])},
      ],
    },
    {
      ...projectAsset('Project', 'backdrop', 'Beach'),
      files: [{path: 'unexpected.svg', bytes: new Uint8Array([1])}],
    },
    embeddedAsset('EmptyBytes', 'sound', 'empty.wav', new Uint8Array()),
    projectAsset('MissingTarget', 'costume', 'happy'),
    {asset: {id: 'Remote', kind: 'backdrop', source: {type: 'https'}}, files: []},
    {},
  ];
  for (const payload of invalid) {
    await assert.rejects(adapter.prepare(payload), (error) => typeof error.code === 'string');
  }
  await assert.rejects(
    adapter.prepare(embeddedAsset('BadSignal', 'sound', 'sound.wav'), {signal: {}}),
    /signal is invalid/u,
  );
  assert.deepEqual(fake.calls, {project: [], embedded: [], release: []});
});

test('keeps composition and release ownership isolated per adapter instance', async () => {
  const created = [];
  const createComposition = () => {
    const fake = fakeComposition();
    created.push(fake);
    return fake.composition;
  };
  const first = createDsl4AssetManagerAdapter({createComposition});
  const second = createDsl4AssetManagerAdapter({createComposition});
  const firstResource = await first.prepare(projectAsset('Beach', 'backdrop', 'Beach'));
  const secondResource = await second.prepare(projectAsset('Beach', 'backdrop', 'Beach'));

  first.release(firstResource);
  assert.deepEqual(created[0].calls.release, ['Beach']);
  assert.deepEqual(created[1].calls.release, []);
  assert.throws(() => first.release(secondResource), /not owned by this adapter/u);
});

test('cancels pending registration on Abort without publishing a resource', async () => {
  const registration = deferred();
  const fake = fakeComposition({
    registerEmbeddedAsset() {
      return registration.promise;
    },
  });
  const adapter = createDsl4AssetManagerAdapter({composition: fake.composition});
  const controller = new AbortController();
  const pending = adapter.prepare(embeddedAsset('Late', 'backdrop', 'late.svg'), {
    signal: controller.signal,
  });
  controller.abort('scene-superseded');
  registration.resolve({name: 'Late', mimeType: 'image/svg+xml'});

  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.deepEqual(fake.calls.release, ['Late']);
});
