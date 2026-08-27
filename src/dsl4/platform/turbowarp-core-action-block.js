import {createTurboWarpBlockDefinitions} from '@kubohiroya/turbowarp-extension-manifest';
import Ajv2020 from 'ajv/dist/2020.js';

import {dsl4CoreActionManifest} from '../core-action-manifest.js';
import {deepFreeze} from '../story-document.js';
import {
  dsl4BlockSourceCommandOpcode,
  dsl4BlockSourceHatOpcode,
} from '../turbowarp-yaml-json-block-source.js';

const defaultJsonLimits = Object.freeze({maxCharacters: 16_384, maxDepth: 32, maxNodes: 1_024});
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

/** @param {string} name @param {'string' | 'number'} type @param {unknown} defaultValue @param {string} [menu] */
function argument(name, type, defaultValue, menu) {
  return Object.freeze({name, type, defaultValue, ...(menu ? {menu} : {})});
}

/** @param {string} command @param {string} text @param {ReadonlyArray<ReturnType<typeof argument>>} args */
function block(command, text, args = []) {
  return Object.freeze({command, text, arguments: Object.freeze(args)});
}

export const dsl4TurboWarpCoreActionBlockSpecs = Object.freeze([
  block('stage', 'set stage backdrop [BACKDROP]', [argument('BACKDROP', 'string', 'Backdrop')]),
  block('bgm', 'play BGM [SOUND]', [argument('SOUND', 'string', 'Music')]),
  block('sound', 'play sound [SOUND] until done', [argument('SOUND', 'string', 'Sound')]),
  block('wait', 'wait [SECONDS] seconds', [argument('SECONDS', 'number', 1)]),
  block('debugger', 'debugger'),
  block('broadcastMessageAndWait', 'broadcast [MESSAGE] and wait', [
    argument('MESSAGE', 'string', 'message'),
  ]),
  block('transition', 'transition [EFFECT] for [SECONDS] seconds', [
    argument('EFFECT', 'string', 'fadeOut', 'dsl4TransitionEffect'),
    argument('SECONDS', 'number', 1),
  ]),
  block('goto', 'go to scene [SCENE]', [argument('SCENE', 'string', 'scene')]),
  block('branch', 'choose branch [BRANCH]', [argument('BRANCH', 'string', 'branch')]),
  block('keyInputToChangeScene', 'wait for key routes [ROUTES]', [
    argument('ROUTES', 'string', '{"Space":"next"}'),
  ]),
  block('touchInputToChangeScene', 'wait for actor touch routes [ROUTES]', [
    argument('ROUTES', 'string', '{"Actor":"next"}'),
  ]),
  block('poseInputToChangeScene', 'wait for pose routes [ROUTES]', [
    argument('ROUTES', 'string', '{"pose":"next"}'),
  ]),
  block('imageInputToChangeScene', 'wait for image label routes [ROUTES]', [
    argument('ROUTES', 'string', '{"label":"next"}'),
  ]),
  block('show', 'show actor [TARGET] skin [SKIN] x [X] y [Y] scale [SCALE] %', [
    argument('TARGET', 'string', 'Actor'),
    argument('SKIN', 'string', 'Skin'),
    argument('X', 'number', 0),
    argument('Y', 'number', 0),
    argument('SCALE', 'number', 100),
  ]),
  block('hide', 'hide actor [TARGET]', [argument('TARGET', 'string', 'Actor')]),
  block('setTransparency', 'set actor [TARGET] transparency spec [SPEC]', [
    argument('TARGET', 'string', 'Actor'),
    argument('SPEC', 'string', '50'),
  ]),
  block('moveTo', 'move actor [TARGET] to x [X] y [Y] in [SECONDS] seconds [EASING]', [
    argument('TARGET', 'string', 'Actor'),
    argument('X', 'number', 0),
    argument('Y', 'number', 0),
    argument('SECONDS', 'number', 1),
    argument('EASING', 'string', 'linear', 'dsl4MoveEasing'),
  ]),
  block('say', 'actor [TARGET] say spec [SPEC]', [
    argument('TARGET', 'string', 'Actor'),
    argument('SPEC', 'string', '{"text":"Hello","seconds":1}'),
  ]),
  block('think', 'actor [TARGET] think spec [SPEC]', [
    argument('TARGET', 'string', 'Actor'),
    argument('SPEC', 'string', '{"text":"Hmm","seconds":1}'),
  ]),
  block('setSkin', 'set actor [TARGET] skin [SKIN] optional scale [SCALE]', [
    argument('TARGET', 'string', 'Actor'),
    argument('SKIN', 'string', 'Skin'),
    argument('SCALE', 'string', ''),
  ]),
  block('setLayer', 'set actor [TARGET] layer [LAYER]', [
    argument('TARGET', 'string', 'Actor'),
    argument('LAYER', 'string', 'front'),
  ]),
  block('loop', 'loop actor [TARGET] costume steps [STEPS]', [
    argument('TARGET', 'string', 'Actor'),
    argument('STEPS', 'string', '[{"skin":"Skin","seconds":1}]'),
  ]),
  block('setText', 'set text actor [TARGET] to [TEXT] style [STYLE]', [
    argument('TARGET', 'string', 'Caption'),
    argument('TEXT', 'string', 'Text'),
    argument('STYLE', 'string', 'style'),
  ]),
  block('pose', 'recognize actor [TARGET] pose steps [STEPS]', [
    argument('TARGET', 'string', 'Actor'),
    argument('STEPS', 'string', '[{"pose":"pose"}]'),
  ]),
]);

const blockSpecByCommand = new Map(
  dsl4TurboWarpCoreActionBlockSpecs.map((spec) => [spec.command, spec]),
);

/** @param {string} code @param {string} message @param {unknown} [cause] */
function blockError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : {cause});
  Object.defineProperty(error, 'code', {value: code});
  return error;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {unknown} */
function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
}

/** @param {unknown} value @param {Readonly<{maxDepth: number, maxNodes: number}>} limits */
function validateJsonTree(value, limits) {
  const pending = [{value, depth: 0}];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    nodes += 1;
    if (nodes > limits.maxNodes) {
      throw blockError(
        'K4-BLOCK-ACTION-JSON-LIMIT',
        'TurboWarp action JSON exceeds the node limit',
      );
    }
    if (current.depth > limits.maxDepth) {
      throw blockError(
        'K4-BLOCK-ACTION-JSON-LIMIT',
        'TurboWarp action JSON exceeds the depth limit',
      );
    }
    if (!Array.isArray(current.value) && !isRecord(current.value)) continue;
    for (const [key, child] of Object.entries(current.value)) {
      if (forbiddenKeys.has(key)) {
        throw blockError(
          'K4-BLOCK-ACTION-JSON-001',
          'TurboWarp action JSON contains a forbidden object key',
        );
      }
      pending.push({value: child, depth: current.depth + 1});
    }
  }
  return value;
}

/** @param {unknown} input @param {Readonly<{maxCharacters: number, maxDepth: number, maxNodes: number}>} limits */
function parseJson(input, limits) {
  const source = String(input);
  if (source.length > limits.maxCharacters) {
    throw blockError(
      'K4-BLOCK-ACTION-JSON-LIMIT',
      'TurboWarp action JSON exceeds the character limit',
    );
  }
  try {
    return validateJsonTree(JSON.parse(source), limits);
  } catch (error) {
    if (isRecord(error) && typeof error.code === 'string') throw error;
    throw blockError('K4-BLOCK-ACTION-JSON-001', 'TurboWarp action JSON is invalid', error);
  }
}

/** @param {unknown} input @param {string} name */
function numberValue(input, name) {
  const value = Number(input);
  if (!Number.isFinite(value)) {
    throw blockError('K4-BLOCK-ACTION-001', `TurboWarp action ${name} must be a finite number`);
  }
  return value;
}

/** @param {Readonly<Record<string, unknown>>} args @param {Readonly<Record<string, unknown>>} spec */
function validateBlockArguments(args, spec) {
  const expected = /** @type {ReadonlyArray<Readonly<{name: string}>>} */ (spec.arguments).map(
    ({name}) => name,
  );
  const actual = Object.keys(args).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((name, index) => name !== sortedExpected[index])
  ) {
    throw blockError(
      'K4-BLOCK-ACTION-001',
      `TurboWarp action ${String(spec.command)} arguments are incomplete or unknown`,
    );
  }
}

/**
 * Convert one Scratch argument record to the source-shaped value checked by
 * the same JSON Schema definition as its YAML action.
 *
 * @param {string} command
 * @param {Readonly<Record<string, unknown>>} args
 * @param {Readonly<{maxCharacters: number, maxDepth: number, maxNodes: number}>} limits
 */
function sourceValueForBlock(command, args, limits) {
  switch (command) {
    case 'stage':
      return String(args.BACKDROP);
    case 'bgm':
    case 'sound':
      return String(args.SOUND);
    case 'wait':
      return numberValue(args.SECONDS, 'SECONDS');
    case 'debugger':
      return null;
    case 'broadcastMessageAndWait':
      return String(args.MESSAGE);
    case 'transition':
      return {
        effect: String(args.EFFECT),
        seconds: numberValue(args.SECONDS, 'SECONDS'),
      };
    case 'goto':
      return String(args.SCENE);
    case 'branch':
      return String(args.BRANCH);
    case 'keyInputToChangeScene':
    case 'touchInputToChangeScene':
    case 'poseInputToChangeScene':
    case 'imageInputToChangeScene':
      return {routes: parseJson(args.ROUTES, limits)};
    case 'show':
      return {
        skin: String(args.SKIN),
        x: numberValue(args.X, 'X'),
        y: numberValue(args.Y, 'Y'),
        scale: numberValue(args.SCALE, 'SCALE'),
      };
    case 'hide':
      return {};
    case 'setTransparency':
      return parseJson(args.SPEC, limits);
    case 'moveTo':
      return {
        x: numberValue(args.X, 'X'),
        y: numberValue(args.Y, 'Y'),
        seconds: numberValue(args.SECONDS, 'SECONDS'),
        easing: String(args.EASING),
      };
    case 'say':
    case 'think':
      return parseJson(args.SPEC, limits);
    case 'setSkin': {
      const scale = String(args.SCALE);
      return {
        skin: String(args.SKIN),
        ...(scale.trim().length === 0 ? {} : {scale: numberValue(scale, 'SCALE')}),
      };
    }
    case 'setLayer': {
      const layer = String(args.LAYER);
      return layer === 'front' || layer === 'back' ? layer : numberValue(layer, 'LAYER');
    }
    case 'loop':
      return {steps: parseJson(args.STEPS, limits)};
    case 'setText':
      return {text: String(args.TEXT), style: String(args.STYLE)};
    case 'pose':
      return {steps: parseJson(args.STEPS, limits)};
    default:
      throw blockError('K4-BLOCK-ACTION-001', `Unknown TurboWarp action block: ${command}`);
  }
}

const scalarArgumentNames = Object.freeze({
  stage: 'backdrop',
  bgm: 'sound',
  sound: 'sound',
  wait: 'seconds',
  broadcastMessageAndWait: 'message',
  goto: 'scene',
  branch: 'branch',
  setLayer: 'layer',
});

/** @param {string} command @param {unknown} sourceValue */
function normalizeBlockArguments(command, sourceValue) {
  if (command === 'debugger') return {};
  if (command === 'setTransparency' && typeof sourceValue === 'number') {
    return {transparency: sourceValue};
  }
  if (Object.hasOwn(scalarArgumentNames, command)) {
    const argumentNames = /** @type {Readonly<Record<string, string>>} */ (scalarArgumentNames);
    return {[argumentNames[command]]: cloneValue(sourceValue)};
  }
  const normalized = /** @type {Record<string, unknown>} */ (cloneValue(sourceValue));
  delete normalized.stableId;
  return normalized;
}

/**
 * Create the public block definitions from the core action manifest.
 *
 * @param {Readonly<{ArgumentType: Readonly<Record<string, string>>, BlockType: Readonly<Record<string, string>>}>} Scratch
 * @param {{visible?: boolean}} [options]
 */
export function createDsl4TurboWarpCoreActionBlockSurface(Scratch, {visible = false} = {}) {
  if (!isRecord(Scratch) || !isRecord(Scratch.ArgumentType) || !isRecord(Scratch.BlockType)) {
    throw new TypeError('TurboWarp action block surface requires ArgumentType and BlockType');
  }
  if (typeof visible !== 'boolean') throw new TypeError('visible must be boolean');
  const blocks = createTurboWarpBlockDefinitions(
    Scratch,
    dsl4TurboWarpCoreActionBlockSpecs.map((spec) => ({
      opcode: spec.command,
      blockType: 'COMMAND',
      text: spec.text,
      arguments: Object.fromEntries(
        spec.arguments.map((input) => [
          input.name,
          {
            type: input.type === 'number' ? 'NUMBER' : 'STRING',
            defaultValue: input.defaultValue,
            ...(input.menu ? {menu: input.menu} : {}),
          },
        ]),
      ),
    })),
    {hideFromPalette: !visible},
  );
  return deepFreeze({
    blocks,
    menus: {
      dsl4TransitionEffect: {
        acceptReporters: true,
        items: ['fadeOut', 'fadeUp', 'fadeToWhite', 'fadeFromWhite', 'reset'],
      },
      dsl4MoveEasing: {
        acceptReporters: true,
        items: ['linear', 'easeIn', 'easeOut', 'easeInOut'],
      },
    },
  });
}

/**
 * Create the authoring-only DSL source declaration blocks.
 *
 * @param {Readonly<{ArgumentType: Readonly<Record<string, string>>, BlockType: Readonly<Record<string, string>>}>} Scratch
 * @param {{visible?: boolean}} [options]
 */
export function createDsl4TurboWarpBlockSourceSurface(Scratch, {visible = false} = {}) {
  if (!isRecord(Scratch) || !isRecord(Scratch.ArgumentType) || !isRecord(Scratch.BlockType)) {
    throw new TypeError('TurboWarp block source surface requires ArgumentType and BlockType');
  }
  if (typeof Scratch.BlockType.HAT !== 'string' || typeof Scratch.BlockType.COMMAND !== 'string') {
    throw new TypeError('TurboWarp block source surface requires HAT and COMMAND block types');
  }
  if (typeof visible !== 'boolean') throw new TypeError('visible must be boolean');
  return deepFreeze({
    blocks: createTurboWarpBlockDefinitions(
      Scratch,
      [
        {
          opcode: dsl4BlockSourceHatOpcode,
          blockType: 'HAT',
          text: 'when kamishibai DSL source',
          arguments: {},
        },
        {
          opcode: dsl4BlockSourceCommandOpcode,
          blockType: 'COMMAND',
          text: 'use YAML/JSON fragment [FRAGMENT] as kamishibai DSL source',
          arguments: {
            FRAGMENT: {type: 'STRING', defaultValue: ''},
          },
        },
      ],
      {
        hideFromPalette: !visible,
        decorateBlock(definition) {
          return definition.blockType === 'HAT' ? {isEdgeActivated: false} : {};
        },
      },
    ),
    menus: {},
  });
}

/**
 * Create a Schema-backed adapter for the public TurboWarp action blocks.
 *
 * @param {Readonly<Record<string, any>>} schema
 * @param {{maxJsonCharacters?: number, maxJsonDepth?: number, maxJsonNodes?: number}} [options]
 */
export function createDsl4TurboWarpCoreActionBlockAdapter(schema, options = {}) {
  if (!isRecord(schema) || !isRecord(schema.$defs)) {
    throw new TypeError('TurboWarp action block adapter requires the DSL 4.0 schema');
  }
  if (!isRecord(options)) throw new TypeError('TurboWarp action block adapter options are invalid');
  const unknownOptions = Object.keys(options).filter(
    (name) => !['maxJsonCharacters', 'maxJsonDepth', 'maxJsonNodes'].includes(name),
  );
  if (unknownOptions.length > 0) {
    throw new TypeError(`Unknown TurboWarp action block adapter option: ${unknownOptions.sort()}`);
  }
  const limits = Object.freeze({
    maxCharacters: options.maxJsonCharacters ?? defaultJsonLimits.maxCharacters,
    maxDepth: options.maxJsonDepth ?? defaultJsonLimits.maxDepth,
    maxNodes: options.maxJsonNodes ?? defaultJsonLimits.maxNodes,
  });
  const maximumLimits = /** @type {Readonly<Record<string, number>>} */ (defaultJsonLimits);
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximumLimits[name]) {
      throw new TypeError(`${name} is outside the TurboWarp action JSON limit`);
    }
  }
  const AjvConstructor = /** @type {any} */ (Ajv2020);
  const ajv = new AjvConstructor({allErrors: true, strict: true});
  if (typeof schema.$id !== 'string' || schema.$id.length === 0) {
    throw new TypeError('TurboWarp action block adapter schema requires an $id');
  }
  ajv.addSchema(schema);
  const validators = new Map(
    dsl4CoreActionManifest.map((entry) => [
      entry.command,
      ajv.getSchema(`${schema.$id}#/$defs/${entry.schemaDefinition}`),
    ]),
  );
  if ([...validators.values()].some((validate) => typeof validate !== 'function')) {
    throw new TypeError('TurboWarp action block adapter Schema definitions are incomplete');
  }

  /** @param {string} command @param {unknown} blockArgs */
  function createAction(command, blockArgs) {
    const entry = dsl4CoreActionManifest.find((candidate) => candidate.command === command);
    const spec = blockSpecByCommand.get(command);
    if (!entry || !spec) {
      throw blockError('K4-BLOCK-ACTION-001', `Unknown TurboWarp action block: ${command}`);
    }
    if (!isRecord(blockArgs)) {
      throw blockError('K4-BLOCK-ACTION-001', `TurboWarp action ${command} arguments are invalid`);
    }
    validateBlockArguments(blockArgs, spec);
    const sourceValue = sourceValueForBlock(command, blockArgs, limits);
    const target = entry.target === 'actor' ? String(blockArgs.TARGET) : null;
    const sourceAction =
      entry.target === 'actor' ? {[`${target}.${command}`]: sourceValue} : {[command]: sourceValue};
    const validate = validators.get(command);
    if (!validate || !validate(sourceAction)) {
      const first = validate.errors?.[0];
      const location = first?.instancePath || '$';
      const keyword = first?.keyword || 'schema';
      throw blockError(
        'K4-BLOCK-ACTION-SCHEMA-001',
        `TurboWarp action ${command} failed ${keyword} validation at ${location}`,
      );
    }
    return deepFreeze({
      target,
      command,
      args: normalizeBlockArguments(command, sourceValue),
      handler: 'core',
    });
  }

  return Object.freeze({createAction, limits});
}
