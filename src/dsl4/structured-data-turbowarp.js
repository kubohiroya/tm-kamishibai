import {createTurboWarpExtensionInfo} from '@kubohiroya/turbowarp-extension-manifest';

const standaloneId = 'kubohiroyastructdata1';
const developerId = 'kubohiroyastructdata1debug';
export const dsl4StructuredDataBlockIconURI = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M32 15v13M16 29h32M16 29v15M32 29v15M48 29v15"/><circle cx="32" cy="11" r="5"/><circle cx="16" cy="49" r="5"/><circle cx="32" cy="49" r="5"/><circle cx="48" cy="49" r="5"/></g></svg>',
)}`;
export const dsl4StructuredDataDebugBlockIconURI = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 14v10M11 25h24M11 25v14M23 25v14"/><circle cx="23" cy="10" r="4"/><circle cx="11" cy="44" r="4"/><circle cx="23" cy="44" r="4"/><circle cx="47" cy="41" r="12"/><path d="M47 34v8M47 48h.01"/></g></svg>',
)}`;

/** @template T @param {T} value @returns {Readonly<T>} */
function deepFreeze(value) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** @param {string} opcode @param {string} text @param {Record<string, string>} [arguments_] @param {'REPORTER' | 'BOOLEAN'} [blockType] @param {string} [returns] */
function block(opcode, text, arguments_ = {}, blockType = 'REPORTER', returns = 'scalar') {
  return {
    opcode,
    blockType,
    text,
    arguments: Object.fromEntries(
      Object.entries(arguments_).map(([name, type]) => [
        name,
        {type, defaultValue: type === 'NUMBER' ? 0 : ''},
      ]),
    ),
    returns,
  };
}

export const dsl4StructuredDataStandaloneManifest = deepFreeze({
  id: standaloneId,
  name: 'Structured Data',
  developer: false,
  blocks: [
    block('defaultScope', 'default structured data scope', {}, 'REPORTER', 'ScopeRef'),
    block(
      'createScope',
      'create scope under [PARENT_SCOPE] named [LABEL]',
      {PARENT_SCOPE: 'STRING', LABEL: 'STRING'},
      'REPORTER',
      'ScopeRef | ExceptionRef',
    ),
    block(
      'newEntryFromJson',
      'new entry from JSON [JSON] type [TYPE_TAG] in [OWNER_SCOPE]',
      {JSON: 'STRING', TYPE_TAG: 'STRING', OWNER_SCOPE: 'STRING'},
      'REPORTER',
      'OwnerRef | ExceptionRef',
    ),
    block(
      'duplicateReference',
      'duplicate reference [REFERENCE] in [OWNER_SCOPE]',
      {REFERENCE: 'STRING', OWNER_SCOPE: 'STRING'},
      'REPORTER',
      'ReferenceLease | ExceptionRef',
    ),
    block(
      'queryKind',
      'kind of [PATH] in [SOURCE]',
      {SOURCE: 'STRING', PATH: 'STRING'},
      'REPORTER',
      'kind string | ExceptionRef',
    ),
    block(
      'queryScalar',
      'scalar at [PATH] in [SOURCE]',
      {SOURCE: 'STRING', PATH: 'STRING'},
      'REPORTER',
      'Scratch scalar | ExceptionRef',
    ),
    block(
      'queryReference',
      'reference at [PATH] in [SOURCE] owned by [OWNER_SCOPE]',
      {SOURCE: 'STRING', PATH: 'STRING', OWNER_SCOPE: 'STRING'},
      'REPORTER',
      'ReferenceLease | ExceptionRef',
    ),
    block(
      'queryCollection',
      'collection at [PATH] in [SOURCE] owned by [OWNER_SCOPE]',
      {SOURCE: 'STRING', PATH: 'STRING', OWNER_SCOPE: 'STRING'},
      'REPORTER',
      'CollectionRef | ExceptionRef',
    ),
    block(
      'newQueryIterator',
      'iterator for [PATH] in [SOURCE] owned by [OWNER_SCOPE]',
      {SOURCE: 'STRING', PATH: 'STRING', OWNER_SCOPE: 'STRING'},
      'REPORTER',
      'IteratorRef | ExceptionRef',
    ),
    block(
      'newCollectionIterator',
      'iterator for collection [COLLECTION] owned by [OWNER_SCOPE]',
      {COLLECTION: 'STRING', OWNER_SCOPE: 'STRING'},
      'REPORTER',
      'IteratorRef | ExceptionRef',
    ),
    block(
      'iteratorNext',
      'advance iterator [ITERATOR]',
      {ITERATOR: 'STRING'},
      'REPORTER',
      '"item" | "done" | ExceptionRef',
    ),
    block(
      'iteratorCurrentKind',
      'current kind of iterator [ITERATOR]',
      {ITERATOR: 'STRING'},
      'REPORTER',
      'kind string | ExceptionRef',
    ),
    block(
      'iteratorCurrentScalar',
      'current scalar of iterator [ITERATOR]',
      {ITERATOR: 'STRING'},
      'REPORTER',
      'Scratch scalar | ExceptionRef',
    ),
    block(
      'iteratorCurrentReference',
      'current reference of [ITERATOR] owned by [OWNER_SCOPE]',
      {ITERATOR: 'STRING', OWNER_SCOPE: 'STRING'},
      'REPORTER',
      'ReferenceLease | ExceptionRef',
    ),
    block(
      'releaseReference',
      'release reference [REFERENCE]',
      {REFERENCE: 'STRING'},
      'REPORTER',
      'true | ExceptionRef',
    ),
    block(
      'releaseCollection',
      'release collection [COLLECTION]',
      {COLLECTION: 'STRING'},
      'REPORTER',
      'true | ExceptionRef',
    ),
    block(
      'releaseIterator',
      'release iterator [ITERATOR]',
      {ITERATOR: 'STRING'},
      'REPORTER',
      'true | ExceptionRef',
    ),
    block('freeEntry', 'free entry [OWNER]', {OWNER: 'STRING'}, 'REPORTER', 'true | ExceptionRef'),
    block(
      'releaseScope',
      'release scope [SCOPE]',
      {SCOPE: 'STRING'},
      'REPORTER',
      'true | ExceptionRef',
    ),
    block(
      'isReference',
      'is [VALUE] a reference?',
      {VALUE: 'STRING'},
      'BOOLEAN',
      'Boolean (active Core handle)',
    ),
    block(
      'isException',
      'is [VALUE] an exception?',
      {VALUE: 'STRING'},
      'BOOLEAN',
      'Boolean (Adapter exception)',
    ),
    block(
      'exceptionCode',
      'exception code [EXCEPTION]',
      {EXCEPTION: 'STRING'},
      'REPORTER',
      'code | ExceptionRef',
    ),
    block(
      'exceptionOperation',
      'exception operation [EXCEPTION]',
      {EXCEPTION: 'STRING'},
      'REPORTER',
      'operation | ExceptionRef',
    ),
    block(
      'exceptionMessage',
      'exception message [EXCEPTION]',
      {EXCEPTION: 'STRING'},
      'REPORTER',
      'safe message | ExceptionRef',
    ),
    block(
      'releaseException',
      'release exception [EXCEPTION]',
      {EXCEPTION: 'STRING'},
      'REPORTER',
      'true | ExceptionRef',
    ),
  ],
});

export const dsl4StructuredDataDeveloperManifest = deepFreeze({
  id: developerId,
  name: 'Structured Data Debug',
  developer: true,
  blocks: [
    block('debugSnapshot', 'structured data debug snapshot', {}, 'REPORTER', 'JSON string'),
    block(
      'debugAssertInvariants',
      'assert structured data invariants',
      {},
      'REPORTER',
      'true | ExceptionRef',
    ),
    block(
      'debugHandleKind',
      'debug kind of handle [VALUE]',
      {VALUE: 'STRING'},
      'REPORTER',
      'string | ExceptionRef',
    ),
    block(
      'debugNormalizedPath',
      'debug path of [RESOURCE] item [INDEX]',
      {RESOURCE: 'STRING', INDEX: 'NUMBER'},
      'REPORTER',
      'string | ExceptionRef',
    ),
    block('debugLimits', 'structured data debug limits', {}, 'REPORTER', 'JSON string'),
  ],
});

export const dsl4StructuredDataDefaultFeatureFlags = deepFreeze({
  structuredDataStandaloneEnabled: false,
  structuredDataDebugEnabled: false,
});

const featureFlagKeys = new Set(Object.keys(dsl4StructuredDataDefaultFeatureFlags));
const registeredResult = deepFreeze({registered: true});
const notRegisteredResult = deepFreeze({registered: false});
const standaloneAdapterMethods = dsl4StructuredDataStandaloneManifest.blocks.map(
  (definition) => definition.opcode,
);
const developerAdapterMethods = dsl4StructuredDataDeveloperManifest.blocks.map(
  (definition) => definition.opcode,
);

/** @param {unknown} [input] */
export function resolveDsl4StructuredDataFeatureFlags(input = {}) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Structured Data feature flags must be an object');
  }
  const candidate = /** @type {Record<string, unknown>} */ (input);
  if (Object.keys(candidate).some((key) => !featureFlagKeys.has(key))) {
    throw new TypeError('Structured Data feature flags contain an unknown field');
  }
  const resolved = {...dsl4StructuredDataDefaultFeatureFlags, ...candidate};
  for (const [name, value] of Object.entries(resolved)) {
    if (typeof value !== 'boolean') throw new TypeError(`${name} must be boolean`);
  }
  return deepFreeze(resolved);
}

/**
 * @param {any} Scratch
 * @param {Readonly<{id: string, name: string, developer: boolean, blocks: readonly any[]}>} manifest
 * @param {Record<string, Function>} handlers
 */
function createExtension(Scratch, manifest, handlers) {
  return Object.freeze({
    getInfo() {
      return createTurboWarpExtensionInfo(Scratch, manifest, {
        blockIconURI: manifest.developer
          ? dsl4StructuredDataDebugBlockIconURI
          : dsl4StructuredDataBlockIconURI,
        color1: manifest.developer ? '#555555' : '#2f6f9f',
        color2: manifest.developer ? '#444444' : '#275f88',
        color3: manifest.developer ? '#333333' : '#1f4f70',
        disableReporterMonitors: true,
      });
    },
    ...handlers,
  });
}

/** @param {any} Scratch @param {unknown} value */
function castString(Scratch, value) {
  return Scratch.Cast?.toString ? Scratch.Cast.toString(value) : String(value ?? '');
}

/** @param {any} Scratch @param {unknown} value */
function castNumber(Scratch, value) {
  return Scratch.Cast?.toNumber ? Scratch.Cast.toNumber(value) : Number(value);
}

/**
 * Create startup-fixed optional TurboWarp surfaces without registering them eagerly.
 *
 * @param {object} [options]
 */
export function createDsl4StructuredDataTurboWarpSurfaces(options = {}) {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('Structured Data TurboWarp options must be an object');
  }
  const candidate = /** @type {Record<string, any>} */ (options);
  const featureFlags = resolveDsl4StructuredDataFeatureFlags(candidate.featureFlags);
  if (!featureFlags.structuredDataStandaloneEnabled && !featureFlags.structuredDataDebugEnabled) {
    return deepFreeze({
      featureFlags,
      standalone: null,
      developer: null,
      register: () => notRegisteredResult,
    });
  }

  const Scratch = candidate.Scratch;
  const adapter = candidate.adapter;
  if (
    !Scratch?.extensions?.unsandboxed ||
    typeof Scratch.extensions.register !== 'function' ||
    !Scratch.BlockType ||
    !Scratch.ArgumentType
  ) {
    throw new TypeError('Structured Data requires an unsandboxed TurboWarp Scratch host');
  }
  if (typeof adapter !== 'object' || adapter === null) {
    throw new TypeError('Structured Data adapter is required when a surface is enabled');
  }
  const requiredAdapterMethods = [
    ...(featureFlags.structuredDataStandaloneEnabled ? standaloneAdapterMethods : []),
    ...(featureFlags.structuredDataDebugEnabled ? developerAdapterMethods : []),
  ];
  for (const method of requiredAdapterMethods) {
    if (typeof adapter[method] !== 'function') {
      throw new TypeError(`Structured Data adapter.${method} is required`);
    }
  }

  const standaloneHandlers =
    /** @type {Record<string, (args: Record<string, unknown>) => unknown>} */ ({
      defaultScope: () => adapter.defaultScope(),
      createScope: (args) =>
        adapter.createScope(
          castString(Scratch, args.PARENT_SCOPE),
          castString(Scratch, args.LABEL),
        ),
      newEntryFromJson: (args) =>
        adapter.newEntryFromJson(
          castString(Scratch, args.JSON),
          castString(Scratch, args.TYPE_TAG),
          castString(Scratch, args.OWNER_SCOPE),
        ),
      duplicateReference: (args) =>
        adapter.duplicateReference(
          castString(Scratch, args.REFERENCE),
          castString(Scratch, args.OWNER_SCOPE),
        ),
      queryKind: (args) =>
        adapter.queryKind(castString(Scratch, args.SOURCE), castString(Scratch, args.PATH)),
      queryScalar: (args) =>
        adapter.queryScalar(castString(Scratch, args.SOURCE), castString(Scratch, args.PATH)),
      queryReference: (args) =>
        adapter.queryReference(
          castString(Scratch, args.SOURCE),
          castString(Scratch, args.PATH),
          castString(Scratch, args.OWNER_SCOPE),
        ),
      queryCollection: (args) =>
        adapter.queryCollection(
          castString(Scratch, args.SOURCE),
          castString(Scratch, args.PATH),
          castString(Scratch, args.OWNER_SCOPE),
        ),
      newQueryIterator: (args) =>
        adapter.newQueryIterator(
          castString(Scratch, args.SOURCE),
          castString(Scratch, args.PATH),
          castString(Scratch, args.OWNER_SCOPE),
        ),
      newCollectionIterator: (args) =>
        adapter.newCollectionIterator(
          castString(Scratch, args.COLLECTION),
          castString(Scratch, args.OWNER_SCOPE),
        ),
      iteratorNext: (args) => adapter.iteratorNext(castString(Scratch, args.ITERATOR)),
      iteratorCurrentKind: (args) =>
        adapter.iteratorCurrentKind(castString(Scratch, args.ITERATOR)),
      iteratorCurrentScalar: (args) =>
        adapter.iteratorCurrentScalar(castString(Scratch, args.ITERATOR)),
      iteratorCurrentReference: (args) =>
        adapter.iteratorCurrentReference(
          castString(Scratch, args.ITERATOR),
          castString(Scratch, args.OWNER_SCOPE),
        ),
      releaseReference: (args) => adapter.releaseReference(castString(Scratch, args.REFERENCE)),
      releaseCollection: (args) => adapter.releaseCollection(castString(Scratch, args.COLLECTION)),
      releaseIterator: (args) => adapter.releaseIterator(castString(Scratch, args.ITERATOR)),
      freeEntry: (args) => adapter.freeEntry(castString(Scratch, args.OWNER)),
      releaseScope: (args) => adapter.releaseScope(castString(Scratch, args.SCOPE)),
      isReference: (args) => adapter.isReference(castString(Scratch, args.VALUE)),
      isException: (args) => adapter.isException(castString(Scratch, args.VALUE)),
      exceptionCode: (args) => adapter.exceptionCode(castString(Scratch, args.EXCEPTION)),
      exceptionOperation: (args) => adapter.exceptionOperation(castString(Scratch, args.EXCEPTION)),
      exceptionMessage: (args) => adapter.exceptionMessage(castString(Scratch, args.EXCEPTION)),
      releaseException: (args) => adapter.releaseException(castString(Scratch, args.EXCEPTION)),
    });
  const developerHandlers =
    /** @type {Record<string, (args: Record<string, unknown>) => unknown>} */ ({
      debugSnapshot: () => JSON.stringify(adapter.debugSnapshot()),
      debugAssertInvariants: () => adapter.debugAssertInvariants(),
      debugHandleKind: (args) => adapter.debugHandleKind(castString(Scratch, args.VALUE)),
      debugNormalizedPath: (args) =>
        adapter.debugNormalizedPath(
          castString(Scratch, args.RESOURCE),
          castNumber(Scratch, args.INDEX),
        ),
      debugLimits: () => JSON.stringify(adapter.debugLimits()),
    });
  const standalone = featureFlags.structuredDataStandaloneEnabled
    ? createExtension(Scratch, dsl4StructuredDataStandaloneManifest, standaloneHandlers)
    : null;
  const developer = featureFlags.structuredDataDebugEnabled
    ? createExtension(Scratch, dsl4StructuredDataDeveloperManifest, developerHandlers)
    : null;
  let standaloneRegistered = false;
  let developerRegistered = false;

  return Object.freeze({
    featureFlags,
    standalone,
    developer,
    register() {
      let changed = false;
      if (standalone && !standaloneRegistered) {
        Scratch.extensions.register(standalone);
        standaloneRegistered = true;
        changed = true;
      }
      if (developer && !developerRegistered) {
        Scratch.extensions.register(developer);
        developerRegistered = true;
        changed = true;
      }
      return changed ? registeredResult : notRegisteredResult;
    },
  });
}
