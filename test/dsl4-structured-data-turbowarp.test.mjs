import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDsl4StructuredDataTurboWarpSurfaces,
  dsl4StructuredDataDefaultFeatureFlags,
  dsl4StructuredDataDeveloperManifest,
  dsl4StructuredDataStandaloneManifest,
  resolveDsl4StructuredDataFeatureFlags,
} from '../src/dsl4/index.js';

const expectedStandaloneContract = [
  ['defaultScope', [], 'ScopeRef'],
  ['createScope', ['PARENT_SCOPE', 'LABEL'], 'ScopeRef | ExceptionRef'],
  ['newEntryFromJson', ['JSON', 'TYPE_TAG', 'OWNER_SCOPE'], 'OwnerRef | ExceptionRef'],
  ['duplicateReference', ['REFERENCE', 'OWNER_SCOPE'], 'ReferenceLease | ExceptionRef'],
  ['queryKind', ['SOURCE', 'PATH'], 'kind string | ExceptionRef'],
  ['queryScalar', ['SOURCE', 'PATH'], 'Scratch scalar | ExceptionRef'],
  ['queryReference', ['SOURCE', 'PATH', 'OWNER_SCOPE'], 'ReferenceLease | ExceptionRef'],
  ['queryCollection', ['SOURCE', 'PATH', 'OWNER_SCOPE'], 'CollectionRef | ExceptionRef'],
  ['newQueryIterator', ['SOURCE', 'PATH', 'OWNER_SCOPE'], 'IteratorRef | ExceptionRef'],
  ['newCollectionIterator', ['COLLECTION', 'OWNER_SCOPE'], 'IteratorRef | ExceptionRef'],
  ['iteratorNext', ['ITERATOR'], '"item" | "done" | ExceptionRef'],
  ['iteratorCurrentKind', ['ITERATOR'], 'kind string | ExceptionRef'],
  ['iteratorCurrentScalar', ['ITERATOR'], 'Scratch scalar | ExceptionRef'],
  ['iteratorCurrentReference', ['ITERATOR', 'OWNER_SCOPE'], 'ReferenceLease | ExceptionRef'],
  ['releaseReference', ['REFERENCE'], 'true | ExceptionRef'],
  ['releaseCollection', ['COLLECTION'], 'true | ExceptionRef'],
  ['releaseIterator', ['ITERATOR'], 'true | ExceptionRef'],
  ['freeEntry', ['OWNER'], 'true | ExceptionRef'],
  ['releaseScope', ['SCOPE'], 'true | ExceptionRef'],
  ['isReference', ['VALUE'], 'Boolean (active Core handle)'],
  ['isException', ['VALUE'], 'Boolean (Adapter exception)'],
  ['exceptionCode', ['EXCEPTION'], 'code | ExceptionRef'],
  ['exceptionOperation', ['EXCEPTION'], 'operation | ExceptionRef'],
  ['exceptionMessage', ['EXCEPTION'], 'safe message | ExceptionRef'],
  ['releaseException', ['EXCEPTION'], 'true | ExceptionRef'],
];

function fakeScratch({unsandboxed = true} = {}) {
  const registered = [];
  return {
    Scratch: {
      extensions: {
        unsandboxed,
        register(extension) {
          registered.push(extension);
        },
      },
      BlockType: {REPORTER: 'reporter', BOOLEAN: 'Boolean'},
      ArgumentType: {STRING: 'string', NUMBER: 'number'},
      Cast: {
        toString(value) {
          return `string:${String(value)}`;
        },
        toNumber(value) {
          return Number(value) + 0.5;
        },
      },
    },
    registered,
  };
}

function fakeAdapter() {
  const calls = [];
  const adapter = {};
  for (const definition of [
    ...dsl4StructuredDataStandaloneManifest.blocks,
    ...dsl4StructuredDataDeveloperManifest.blocks,
  ]) {
    adapter[definition.opcode] = (...args) => {
      calls.push([definition.opcode, ...args]);
      if (definition.opcode === 'debugSnapshot') return {redacted: true};
      if (definition.opcode === 'debugLimits') return {bounded: true};
      return `result:${definition.opcode}`;
    };
  }
  return {adapter, calls};
}

test('freezes the exact #261 Standalone opcode, argument, shape, and return contract', () => {
  assert.equal(dsl4StructuredDataStandaloneManifest.id, 'kubohiroyastructdata1');
  assert.equal(dsl4StructuredDataDeveloperManifest.id, 'kubohiroyastructdata1debug');
  assert.deepEqual(
    dsl4StructuredDataStandaloneManifest.blocks.map((definition) => [
      definition.opcode,
      Object.keys(definition.arguments),
      definition.returns,
    ]),
    expectedStandaloneContract,
  );
  assert.deepEqual(
    dsl4StructuredDataStandaloneManifest.blocks.map((definition) => definition.blockType),
    expectedStandaloneContract.map(([opcode]) =>
      opcode === 'isReference' || opcode === 'isException' ? 'BOOLEAN' : 'REPORTER',
    ),
  );
  assert.deepEqual(
    dsl4StructuredDataDeveloperManifest.blocks.map((definition) => definition.opcode),
    [
      'debugSnapshot',
      'debugAssertInvariants',
      'debugHandleKind',
      'debugNormalizedPath',
      'debugLimits',
    ],
  );
  assert.equal(Object.isFrozen(dsl4StructuredDataStandaloneManifest.blocks[0]), true);
  assert.equal(Object.isFrozen(dsl4StructuredDataDeveloperManifest.blocks), true);
});

test('keeps both surfaces startup-fixed and disabled by default without touching host or adapter', () => {
  assert.deepEqual(dsl4StructuredDataDefaultFeatureFlags, {
    structuredDataStandaloneEnabled: false,
    structuredDataDebugEnabled: false,
  });
  assert.equal(Object.isFrozen(dsl4StructuredDataDefaultFeatureFlags), true);
  assert.deepEqual(resolveDsl4StructuredDataFeatureFlags(), dsl4StructuredDataDefaultFeatureFlags);
  assert.throws(() => resolveDsl4StructuredDataFeatureFlags({unknown: true}), TypeError);
  assert.throws(
    () => resolveDsl4StructuredDataFeatureFlags({structuredDataDebugEnabled: 1}),
    TypeError,
  );

  const options = {featureFlags: {}};
  Object.defineProperties(options, {
    Scratch: {get: () => assert.fail('disabled factory inspected Scratch')},
    adapter: {get: () => assert.fail('disabled factory inspected adapter')},
  });
  const surfaces = createDsl4StructuredDataTurboWarpSurfaces(options);
  assert.deepEqual(surfaces.featureFlags, dsl4StructuredDataDefaultFeatureFlags);
  assert.equal(surfaces.standalone, null);
  assert.equal(surfaces.developer, null);
  assert.deepEqual(surfaces.register(), {registered: false});
  assert.equal(Object.isFrozen(surfaces), true);
});

test('registers only enabled palettes once and forwards Scratch-cast arguments', () => {
  const {Scratch, registered} = fakeScratch();
  const {adapter, calls} = fakeAdapter();
  const mutableFlags = {
    structuredDataStandaloneEnabled: true,
    structuredDataDebugEnabled: false,
  };
  const surfaces = createDsl4StructuredDataTurboWarpSurfaces({
    Scratch,
    adapter,
    featureFlags: mutableFlags,
  });
  mutableFlags.structuredDataStandaloneEnabled = false;

  assert.equal(surfaces.standalone.getInfo().id, 'kubohiroyastructdata1');
  assert.deepEqual(
    surfaces.standalone.getInfo().blocks.map((definition) => definition.opcode),
    expectedStandaloneContract.map(([opcode]) => opcode),
  );
  assert.equal(surfaces.developer, null);
  assert.deepEqual(surfaces.register(), {registered: true});
  assert.deepEqual(surfaces.register(), {registered: false});
  assert.deepEqual(registered, [surfaces.standalone]);

  assert.equal(
    surfaces.standalone.queryReference({SOURCE: 1, PATH: 2, OWNER_SCOPE: 3}),
    'result:queryReference',
  );
  assert.deepEqual(calls.at(-1), ['queryReference', 'string:1', 'string:2', 'string:3']);
});

test('keeps the developer palette separate and casts numeric debug indices', () => {
  const {Scratch, registered} = fakeScratch();
  const {adapter, calls} = fakeAdapter();
  const surfaces = createDsl4StructuredDataTurboWarpSurfaces({
    Scratch,
    adapter,
    featureFlags: {structuredDataDebugEnabled: true},
  });

  assert.equal(surfaces.standalone, null);
  assert.equal(surfaces.developer.getInfo().id, 'kubohiroyastructdata1debug');
  assert.equal(surfaces.developer.debugLimits({}), '{"bounded":true}');
  assert.equal(
    surfaces.developer.debugNormalizedPath({RESOURCE: 'r', INDEX: '4'}),
    'result:debugNormalizedPath',
  );
  assert.deepEqual(calls.at(-1), ['debugNormalizedPath', 'string:r', 4.5]);
  surfaces.register();
  assert.deepEqual(registered, [surfaces.developer]);
});

test('retries a failed second registration without duplicating the first palette', () => {
  const attempts = [];
  let failDeveloper = true;
  const {Scratch} = fakeScratch();
  Scratch.extensions.register = (extension) => {
    const id = extension.getInfo().id;
    attempts.push(id);
    if (id.endsWith('debug') && failDeveloper) {
      failDeveloper = false;
      throw new Error('injected registration failure');
    }
  };
  const {adapter} = fakeAdapter();
  const surfaces = createDsl4StructuredDataTurboWarpSurfaces({
    Scratch,
    adapter,
    featureFlags: {
      structuredDataStandaloneEnabled: true,
      structuredDataDebugEnabled: true,
    },
  });

  assert.throws(() => surfaces.register(), /injected registration failure/u);
  assert.deepEqual(surfaces.register(), {registered: true});
  assert.deepEqual(surfaces.register(), {registered: false});
  assert.deepEqual(attempts, [
    'kubohiroyastructdata1',
    'kubohiroyastructdata1debug',
    'kubohiroyastructdata1debug',
  ]);
});

test('rejects sandboxed hosts and incomplete adapters before registration', () => {
  const {Scratch} = fakeScratch({unsandboxed: false});
  const {adapter} = fakeAdapter();
  assert.throws(
    () =>
      createDsl4StructuredDataTurboWarpSurfaces({
        Scratch,
        adapter,
        featureFlags: {structuredDataStandaloneEnabled: true},
      }),
    /unsandboxed TurboWarp/u,
  );

  const host = fakeScratch().Scratch;
  assert.throws(
    () =>
      createDsl4StructuredDataTurboWarpSurfaces({
        Scratch: host,
        adapter: {},
        featureFlags: {structuredDataStandaloneEnabled: true},
      }),
    /adapter\.defaultScope is required/u,
  );
});
