import assert from 'node:assert/strict';
import test from 'node:test';

import {createAssetManagerComposition} from '@kubohiroya/turbowarp-asset-manager/composition';

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

function productionComposition(runtime) {
  const previousScratch = globalThis.Scratch;
  globalThis.Scratch = {vm: {runtime}};
  try {
    return createAssetManagerComposition();
  } finally {
    if (previousScratch === undefined) Reflect.deleteProperty(globalThis, 'Scratch');
    else globalThis.Scratch = previousScratch;
  }
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
    {name: 'Beach', nameMode: 'literal', locator: {kind: 'backdrop', name: 'Beach'}},
    {
      name: 'HeroHappy',
      nameMode: 'literal',
      locator: {kind: 'costume', target: 'Hero', name: 'happy'},
    },
    {name: 'Opening', nameMode: 'literal', locator: {kind: 'sound', name: 'Opening'}},
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

test('maps logical actor IDs to the physical sprite used by 3.2 project costumes', async () => {
  const fake = fakeComposition();
  const actorTarget = {
    isStage: false,
    isOriginal: true,
    sprite: {name: 'Actor', costumes: [{name: 'Urashima-walk-1', skinId: 1}]},
    lookupVariableByNameAndType(name, type) {
      assert.equal(name, 'actorName');
      assert.equal(type, '');
      return {value: 'Urashima'};
    },
  };
  const adapter = createDsl4AssetManagerAdapter({
    composition: fake.composition,
    runtime: {targets: [{isStage: true, sprite: {name: 'Stage'}}, actorTarget]},
  });

  await adapter.prepare(projectAsset('UrashimaWalk', 'costume', 'Urashima-walk-1', 'Urashima'));

  assert.deepEqual(fake.calls.project, [
    {
      name: 'UrashimaWalk',
      nameMode: 'literal',
      locator: {kind: 'costume', target: 'Actor', name: 'Urashima-walk-1'},
    },
  ]);
});

test('uses the 3.2 actor template before logical actor clones are created', async () => {
  const fake = fakeComposition();
  const adapter = createDsl4AssetManagerAdapter({
    composition: fake.composition,
    runtime: {
      targets: [
        {
          isStage: false,
          isOriginal: true,
          sprite: {name: 'Actor'},
          lookupVariableByNameAndType() {
            return {value: '_template_'};
          },
        },
      ],
    },
  });

  await adapter.prepare(projectAsset('PrincessSkin', 'costume', 'Princess', 'Princess'));

  assert.equal(fake.calls.project[0].locator.target, 'Actor');
});

test('waits for a project costume skin before registering its project reference', async () => {
  const costume = {name: 'Princess', skinId: undefined};
  const projectCalls = [];
  const runtime = {
    targets: [
      {
        isStage: false,
        isOriginal: true,
        sprite: {name: 'Actor', costumes: [costume]},
        lookupVariableByNameAndType() {
          return {value: 'Princess'};
        },
      },
    ],
  };
  const composition = {
    async registerProjectAsset(input) {
      assert.equal(costume.skinId, 1);
      projectCalls.push(input);
      return {name: input.name, mimeType: 'image/svg+xml'};
    },
    async registerEmbeddedAsset() {
      throw new Error('embedded registration is not expected');
    },
    releaseAsset() {},
  };
  const adapter = createDsl4AssetManagerAdapter({composition, runtime});
  setTimeout(() => {
    costume.skinId = 1;
  }, 10);

  await adapter.prepare(projectAsset('PrincessSkin', 'costume', 'Princess', 'Princess'));
  assert.equal(projectCalls.length, 1);
});

test('prevents SOURCE_ASSET_NOT_FOUND with the production Asset Manager composition', async () => {
  const costume = {name: 'Princess', skinId: undefined};
  const actorTarget = {
    id: 'actor-target',
    isStage: false,
    isOriginal: true,
    sprite: {name: 'Actor', costumes: [costume], sounds: []},
    lookupVariableByNameAndType() {
      return {value: 'Princess'};
    },
  };
  const runtime = {
    targets: [
      {id: 'stage-target', isStage: true, sprite: {name: 'Stage', costumes: [], sounds: []}},
      actorTarget,
    ],
    on() {},
  };
  const composition = productionComposition(runtime);

  await assert.rejects(
    composition.registerProjectAsset({
      name: 'RawPrincessSkin',
      nameMode: 'literal',
      locator: {kind: 'costume', target: 'Actor', name: 'Princess'},
    }),
    (error) => error?.code === 'SOURCE_ASSET_NOT_FOUND',
  );

  const adapter = createDsl4AssetManagerAdapter({composition, runtime});
  let resource;
  setTimeout(() => {
    costume.skinId = 1;
  }, 10);
  try {
    resource = await adapter.prepare(
      projectAsset('PrincessSkin', 'costume', 'Princess', 'Princess'),
    );
    assert.equal(resource.mimeType, 'image/x-scratch-costume');
    assert.equal(composition.isRegistered('PrincessSkin'), true);
  } finally {
    if (resource) adapter.release(resource);
    composition.releaseAll();
  }
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
  assert.equal(fake.calls.embedded[0].nameMode, 'literal');
  assert.equal(fake.calls.embedded[0].sourceName, 'assets/opening.svg');
  assert.equal(fake.calls.embedded[0].mimeType, '');
  assert.strictEqual(fake.calls.embedded[0].bytes, svgBytes);
  assert.equal(svg.mimeType, 'image/svg+xml');
  assert.equal(bitmap.mimeType, 'image/png');
  assert.equal(audio.mimeType, 'audio/wav');
});

test('passes bitmapResolution only for raster costume and backdrop registrations', async () => {
  const fake = fakeComposition();
  const adapter = createDsl4AssetManagerAdapter({composition: fake.composition});
  const costume = embeddedAsset('HighDensityCostume', 'costume', 'assets/hero.png');
  costume.asset.bitmapResolution = 2;
  await adapter.prepare(costume);
  const svg = embeddedAsset('VectorBackdrop', 'backdrop', 'assets/ocean.svg');
  svg.asset.bitmapResolution = 2;
  await adapter.prepare(svg);
  const jpeg = remoteAsset(
    'RemoteBackdrop',
    'backdrop',
    'https://cdn.example.com/backdrop.jpg',
    'image/jpeg',
  );
  jpeg.asset.bitmapResolution = 1;
  await adapter.prepare(jpeg);

  assert.equal(fake.calls.embedded[0].bitmapResolution, 2);
  assert.equal(Object.hasOwn(fake.calls.embedded[1], 'bitmapResolution'), false);
  assert.equal(fake.calls.embedded[2].bitmapResolution, 1);

  const project = projectAsset('ProjectCostume', 'costume', 'hero', 'Hero');
  project.asset.bitmapResolution = 2;
  await adapter.prepare(project);
  assert.equal(Object.hasOwn(fake.calls.project[0].locator, 'bitmapResolution'), false);

  const invalid = embeddedAsset('InvalidResolution', 'costume', 'assets/hero.png');
  invalid.asset.bitmapResolution = 3;
  await assert.rejects(adapter.prepare(invalid), (error) => error.code === 'K4-ASSET-ADAPTER-001');
  assert.equal(fake.calls.embedded.length, 3);
});

test('preserves literal DSL and Scratch names through structured project locators', async () => {
  const fake = fakeComposition();
  const adapter = createDsl4AssetManagerAdapter({composition: fake.composition});
  const assetId = ' costume./%\u0001\u007f ';
  const target = 'Actor';
  const costumeName = ' look./:\u0002\u007f ';

  const resource = await adapter.prepare(projectAsset(assetId, 'costume', costumeName, target));

  assert.deepEqual(fake.calls.project, [
    {
      name: assetId,
      nameMode: 'literal',
      locator: {kind: 'costume', target, name: costumeName},
    },
  ]);
  assert.equal(resource.assetId, assetId);
  assert.equal(resource.name, assetId);
  adapter.release(resource);
  assert.deepEqual(fake.calls.release, [assetId]);
});

test('materializes a target-independent image Object URL and revokes it with the asset lease', async () => {
  const fake = fakeComposition();
  const created = [];
  const revoked = [];
  const adapter = createDsl4AssetManagerAdapter({
    composition: fake.composition,
    createObjectURL(blob) {
      created.push(blob);
      return 'blob:dsl4-control-icon';
    },
    revokeObjectURL(url) {
      revoked.push(url);
    },
  });
  const resource = await adapter.prepare(
    embeddedAsset('ControlIcon', 'image', 'ui/control.svg', new TextEncoder().encode('<svg/>')),
  );
  assert.equal(resource.kind, 'image');
  assert.equal(resource.objectUrl, 'blob:dsl4-control-icon');
  assert.equal(created.length, 1);
  assert.equal(created[0].type, 'image/svg+xml');
  adapter.release(resource);
  adapter.release(resource);
  assert.deepEqual(fake.calls.release, ['ControlIcon']);
  assert.deepEqual(revoked, ['blob:dsl4-control-icon']);

  await assert.rejects(
    adapter.prepare(projectAsset('ProjectImage', 'image', 'CostumeLike')),
    (error) => error.code === 'K4-ASSET-ADAPTER-002',
  );
});

test('requires injected Object URL creation and revocation as one owner pair', () => {
  const fake = fakeComposition();
  assert.throws(
    () =>
      createDsl4AssetManagerAdapter({
        composition: fake.composition,
        createObjectURL: () => 'blob:unowned',
      }),
    /must be provided together/u,
  );
  assert.throws(
    () =>
      createDsl4AssetManagerAdapter({
        composition: fake.composition,
        revokeObjectURL: () => {},
      }),
    /must be provided together/u,
  );
});

test('uses Object URL methods from the same global URL owner when no pair is injected', async () => {
  const originalUrlOwner = globalThis.URL;
  const fake = fakeComposition();
  const calls = [];
  const urlOwner = {
    createObjectURL(blob) {
      assert.strictEqual(this, urlOwner);
      calls.push(['create', blob.type]);
      return 'blob:global-owner';
    },
    revokeObjectURL(url) {
      assert.strictEqual(this, urlOwner);
      calls.push(['revoke', url]);
    },
  };
  globalThis.URL = urlOwner;
  try {
    const adapter = createDsl4AssetManagerAdapter({composition: fake.composition});
    const resource = await adapter.prepare(embeddedAsset('GlobalIcon', 'image', 'ui/global.svg'));
    adapter.release(resource);
  } finally {
    globalThis.URL = originalUrlOwner;
  }
  assert.deepEqual(calls, [
    ['create', 'image/svg+xml'],
    ['revoke', 'blob:global-owner'],
  ]);
});

test('fails closed when the global URL owner does not provide a complete pair', async () => {
  const originalUrlOwner = globalThis.URL;
  const fake = fakeComposition();
  globalThis.URL = {createObjectURL: () => 'blob:without-revoker'};
  try {
    const adapter = createDsl4AssetManagerAdapter({composition: fake.composition});
    await assert.rejects(
      adapter.prepare(embeddedAsset('UnownedIcon', 'image', 'ui/unowned.svg')),
      (error) => error.code === 'K4-ASSET-ADAPTER-006',
    );
  } finally {
    globalThis.URL = originalUrlOwner;
  }
  assert.deepEqual(fake.calls, {project: [], embedded: [], release: []});
});

test('cleans registrations and created URLs on Object URL error and abort paths', async () => {
  const creationFailure = fakeComposition();
  const creationFailureAdapter = createDsl4AssetManagerAdapter({
    composition: creationFailure.composition,
    createObjectURL() {
      throw new Error('creation failed');
    },
    revokeObjectURL() {
      assert.fail('no URL was created');
    },
  });
  await assert.rejects(
    creationFailureAdapter.prepare(
      embeddedAsset('CreationFailure', 'image', 'ui/creation-failure.svg'),
    ),
    (error) => error.code === 'K4-ASSET-ADAPTER-006',
  );
  assert.deepEqual(creationFailure.calls.release, ['CreationFailure']);

  const invalidUrl = fakeComposition();
  const invalidUrlAdapter = createDsl4AssetManagerAdapter({
    composition: invalidUrl.composition,
    createObjectURL: () => '',
    revokeObjectURL() {
      assert.fail('no valid URL was created');
    },
  });
  await assert.rejects(
    invalidUrlAdapter.prepare(embeddedAsset('InvalidUrl', 'image', 'ui/invalid-url.svg')),
    (error) => error.code === 'K4-ASSET-ADAPTER-006',
  );
  assert.deepEqual(invalidUrl.calls.release, ['InvalidUrl']);

  const controller = new AbortController();
  const aborted = fakeComposition();
  const revoked = [];
  const abortedAdapter = createDsl4AssetManagerAdapter({
    composition: aborted.composition,
    createObjectURL() {
      controller.abort('story-stopped');
      return 'blob:aborted';
    },
    revokeObjectURL(url) {
      revoked.push(url);
    },
  });
  await assert.rejects(
    abortedAdapter.prepare(embeddedAsset('AbortedIcon', 'image', 'ui/aborted.svg'), {
      signal: controller.signal,
    }),
    (error) => error.name === 'AbortError',
  );
  assert.deepEqual(aborted.calls.release, ['AbortedIcon']);
  assert.deepEqual(revoked, ['blob:aborted']);
});

test('revokes an Object URL even when composition release fails', async () => {
  const releaseCalls = [];
  const revoked = [];
  const fake = fakeComposition({
    releaseAsset(name) {
      releaseCalls.push(name);
      throw new Error('release failed');
    },
  });
  const adapter = createDsl4AssetManagerAdapter({
    composition: fake.composition,
    createObjectURL: () => 'blob:release-failure',
    revokeObjectURL: (url) => revoked.push(url),
  });
  const resource = await adapter.prepare(
    embeddedAsset('ReleaseFailure', 'image', 'ui/release-failure.svg'),
  );
  assert.throws(() => adapter.release(resource), /release failed/u);
  adapter.release(resource);
  assert.deepEqual(releaseCalls, ['ReleaseFailure']);
  assert.deepEqual(revoked, ['blob:release-failure']);
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
    nameMode: 'literal',
    sourceName: 'https://cdn.example.com/image.svg',
    mimeType: 'image/svg+xml',
    bytes: payload.files[0].bytes,
  });
});

test('rejects unsupported kinds and malformed materialization before registration', async () => {
  const fake = fakeComposition();
  const adapter = createDsl4AssetManagerAdapter({composition: fake.composition});
  const invalid = [
    {asset: {id: 'Pose', kind: 'recognitionModel', source: {type: 'file'}}, files: []},
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
