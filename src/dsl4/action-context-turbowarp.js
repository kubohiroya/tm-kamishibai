const notRegisteredResult = Object.freeze({registered: false});
const registeredResult = Object.freeze({registered: true});
const featureFlagKeys = new Set(['dsl4CustomActionsEnabled']);

export const dsl4ActionContextDefaultFeatureFlags = Object.freeze({
  dsl4CustomActionsEnabled: false,
});

export const dsl4ActionContextBlockBudget = Object.freeze({
  maximumOverheadBlocksPerHandler: 8,
});

/** @param {string} defaultValue */
const stringArgument = (defaultValue) => Object.freeze({type: 'STRING', defaultValue});

export const dsl4ActionContextManifest = Object.freeze({
  version: 1,
  id: 'kubohiroyakamishibai4actioncontext',
  name: 'Kamishibai Action Context',
  blocks: Object.freeze([
    Object.freeze({
      opcode: 'whenCustomAction',
      blockType: 'HAT',
      text: 'when kamishibai custom action',
      arguments: Object.freeze({}),
    }),
    Object.freeze({
      opcode: 'currentActionName',
      blockType: 'REPORTER',
      text: 'current action name',
      arguments: Object.freeze({}),
    }),
    Object.freeze({
      opcode: 'currentActionTarget',
      blockType: 'REPORTER',
      text: 'current action target',
      arguments: Object.freeze({}),
    }),
    Object.freeze({
      opcode: 'currentActionHasArgument',
      blockType: 'BOOLEAN',
      text: 'current action has argument [NAME]?',
      arguments: Object.freeze({NAME: stringArgument('name')}),
    }),
    Object.freeze({
      opcode: 'currentActionArgument',
      blockType: 'REPORTER',
      text: 'current action argument [NAME]',
      arguments: Object.freeze({NAME: stringArgument('name')}),
    }),
    Object.freeze({
      opcode: 'completeCurrentAction',
      blockType: 'COMMAND',
      text: 'complete current action',
      arguments: Object.freeze({}),
    }),
    Object.freeze({
      opcode: 'failCurrentAction',
      blockType: 'COMMAND',
      text: 'fail current action [MESSAGE]',
      arguments: Object.freeze({MESSAGE: stringArgument('failed')}),
    }),
    Object.freeze({
      opcode: 'gotoFromCurrentAction',
      blockType: 'COMMAND',
      text: 'go to scene [SCENE] from current action',
      arguments: Object.freeze({SCENE: stringArgument('scene')}),
    }),
  ]),
});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} input */
export function resolveDsl4ActionContextFeatureFlags(input = {}) {
  if (!isRecord(input)) throw new TypeError('Action Context feature flags must be an object');
  const unknown = Object.keys(input).filter((key) => !featureFlagKeys.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown Action Context feature flag: ${unknown.sort().join(', ')}`);
  }
  const resolved = {...dsl4ActionContextDefaultFeatureFlags, ...input};
  if (typeof resolved.dsl4CustomActionsEnabled !== 'boolean') {
    throw new TypeError('dsl4CustomActionsEnabled feature flag must be boolean');
  }
  return Object.freeze(resolved);
}

/** @param {any} Scratch @param {unknown} value */
function castString(Scratch, value) {
  return Scratch.Cast?.toString ? Scratch.Cast.toString(value) : String(value ?? '');
}

/**
 * Create the startup-fixed Action Context developer surface without registering it eagerly.
 *
 * @param {object} [options]
 * @param {unknown} [options.featureFlags]
 * @param {unknown} [options.Scratch]
 * @param {unknown} [options.adapter]
 * @param {(error: unknown, context: Readonly<{opcode: string}>) => unknown} [options.onError]
 */
export function createDsl4ActionContextTurboWarpSurface(options = {}) {
  if (!isRecord(options)) throw new TypeError('Action Context options must be an object');
  const featureFlags = resolveDsl4ActionContextFeatureFlags(options.featureFlags);
  if (!featureFlags.dsl4CustomActionsEnabled) {
    return Object.freeze({
      featureFlags,
      manifest: dsl4ActionContextManifest,
      extension: null,
      register: () => notRegisteredResult,
    });
  }

  const Scratch = /** @type {any} */ (options.Scratch);
  const adapter = /** @type {Record<string, Function>} */ (options.adapter);
  if (
    Scratch?.extensions?.unsandboxed !== true ||
    typeof Scratch.extensions.register !== 'function' ||
    !Scratch.BlockType ||
    !Scratch.ArgumentType
  ) {
    throw new TypeError('Action Context requires an unsandboxed TurboWarp Scratch host');
  }
  for (const name of ['HAT', 'REPORTER', 'BOOLEAN', 'COMMAND']) {
    if (Scratch.BlockType[name] === undefined) {
      throw new TypeError(`Action Context Scratch.BlockType.${name} is required`);
    }
  }
  if (Scratch.ArgumentType.STRING === undefined) {
    throw new TypeError('Action Context Scratch.ArgumentType.STRING is required');
  }
  if (!isRecord(adapter)) throw new TypeError('Action Context adapter must be an object');
  const adapterMethods = [
    'currentActionName',
    'currentActionTarget',
    'currentActionHasArgument',
    'currentActionArgument',
    'completeCurrentAction',
    'failCurrentAction',
    'gotoFromCurrentAction',
  ];
  for (const method of adapterMethods) {
    if (typeof adapter[method] !== 'function') {
      throw new TypeError(`Action Context adapter.${method} is required`);
    }
  }
  const onError = options.onError;
  if (onError !== undefined && typeof onError !== 'function') {
    throw new TypeError('Action Context onError must be a function');
  }

  /** @param {string} opcode @param {unknown} fallback @param {() => unknown} operation */
  function contain(opcode, fallback, operation) {
    try {
      return operation();
    } catch (error) {
      try {
        onError?.(error, Object.freeze({opcode}));
      } catch {
        // Error observers cannot change block behavior.
      }
      return fallback;
    }
  }

  const extension = Object.freeze({
    getInfo() {
      return {
        id: dsl4ActionContextManifest.id,
        name: dsl4ActionContextManifest.name,
        color1: '#6c4eb6',
        color2: '#593f99',
        color3: '#47327a',
        blocks: dsl4ActionContextManifest.blocks.map((definition) => ({
          opcode: definition.opcode,
          blockType: Scratch.BlockType[definition.blockType],
          text: definition.text,
          ...(definition.blockType === 'HAT' ? {isEdgeActivated: false} : {}),
          ...(definition.blockType === 'REPORTER' ? {disableMonitor: true} : {}),
          arguments: Object.fromEntries(
            Object.entries(definition.arguments).map(([name, argument]) => [
              name,
              {
                type: Scratch.ArgumentType[argument.type],
                defaultValue: argument.defaultValue,
              },
            ]),
          ),
        })),
      };
    },
    whenCustomAction() {
      return true;
    },
    /** @param {unknown} _args @param {unknown} util */
    currentActionName(_args, util) {
      return contain('currentActionName', '', () => adapter.currentActionName(util));
    },
    /** @param {unknown} _args @param {unknown} util */
    currentActionTarget(_args, util) {
      return contain('currentActionTarget', '', () => adapter.currentActionTarget(util));
    },
    /** @param {unknown} args @param {unknown} util */
    currentActionHasArgument(args, util) {
      return contain('currentActionHasArgument', false, () =>
        adapter.currentActionHasArgument(
          castString(Scratch, isRecord(args) ? args.NAME : ''),
          util,
        ),
      );
    },
    /** @param {unknown} args @param {unknown} util */
    currentActionArgument(args, util) {
      return contain('currentActionArgument', '', () =>
        adapter.currentActionArgument(castString(Scratch, isRecord(args) ? args.NAME : ''), util),
      );
    },
    /** @param {unknown} _args @param {unknown} util */
    completeCurrentAction(_args, util) {
      contain('completeCurrentAction', undefined, () => adapter.completeCurrentAction(util));
    },
    /** @param {unknown} args @param {unknown} util */
    failCurrentAction(args, util) {
      contain('failCurrentAction', undefined, () =>
        adapter.failCurrentAction(castString(Scratch, isRecord(args) ? args.MESSAGE : ''), util),
      );
    },
    /** @param {unknown} args @param {unknown} util */
    gotoFromCurrentAction(args, util) {
      contain('gotoFromCurrentAction', undefined, () =>
        adapter.gotoFromCurrentAction(castString(Scratch, isRecord(args) ? args.SCENE : ''), util),
      );
    },
  });

  let registered = false;
  return Object.freeze({
    featureFlags,
    manifest: dsl4ActionContextManifest,
    extension,
    register() {
      if (registered) return notRegisteredResult;
      Scratch.extensions.register(extension);
      registered = true;
      return registeredResult;
    },
  });
}
