import {deepFreeze} from './story-document.js';

export const dsl4BlockSourceHatOpcode = 'whenDsl4Source';
export const dsl4BlockSourceCommandOpcode = 'dsl4SourceFromYamlJson';
export const dsl4BlockSourceRuntimeExtensionId = 'kubohiroyakamishibairuntime4';
export const dsl4BlockSourceBundleExtensionId = 'kubohiroyakamishibai4';
export const yamlJsonExtensionId = 'kubohiroyayamljson';

const sourceSuffix = '.k4.yml';
const simpleKeyPattern = /^[A-Za-z_][A-Za-z0-9_-]*$/u;
const scalarInputTypes = new Set([4, 5, 6, 7, 8]);
const stringInputTypes = new Set([10, 11, 12, 13]);

export const dsl4BlockSourceDefaultLimits = Object.freeze({
  maxTargets: 256,
  maxBlocksPerTarget: 8192,
  maxReporterNodes: 4096,
  maxReporterDepth: 128,
  maxScalarCodeUnits: 65536,
});

export class Dsl4BlockSourceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {object} [details]
   * @param {string} [details.targetName]
   * @param {string} [details.blockId]
   * @param {unknown} [details.cause]
   */
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : {cause: details.cause});
    this.name = 'Dsl4BlockSourceError';
    this.code = code;
    this.targetName = details.targetName ?? null;
    this.blockId = details.blockId ?? null;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} code @param {string} message @param {object} [details] @returns {never} */
function fail(code, message, details) {
  throw new Dsl4BlockSourceError(code, message, details);
}

/** @param {unknown} input @returns {Readonly<Record<string, number>>} */
function resolveLimits(input) {
  if (input === undefined) return dsl4BlockSourceDefaultLimits;
  if (!isRecord(input)) fail('K4-BLOCK-SOURCE-LIMIT-001', 'Block source limits must be an object');
  const unknown = Object.keys(input).filter(
    (key) => !Object.hasOwn(dsl4BlockSourceDefaultLimits, key),
  );
  if (unknown.length > 0) {
    fail('K4-BLOCK-SOURCE-LIMIT-001', `Unknown block source limits: ${unknown.sort().join(', ')}`);
  }
  const limits = {...dsl4BlockSourceDefaultLimits, ...input};
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      fail('K4-BLOCK-SOURCE-LIMIT-001', `${name} must be a positive safe integer`);
    }
  }
  return Object.freeze(limits);
}

/** @param {unknown} target */
function targetBlocks(target) {
  if (!isRecord(target) || typeof target.name !== 'string' || typeof target.isStage !== 'boolean') {
    fail('K4-BLOCK-SOURCE-PROJECT-001', 'SB3 target metadata is invalid');
  }
  if (!isRecord(target.blocks)) {
    fail('K4-BLOCK-SOURCE-PROJECT-001', 'SB3 target blocks are invalid', {
      targetName: target.name,
    });
  }
  return /** @type {Record<string, unknown>} */ (target.blocks);
}

/** @param {string} opcode @param {string} member */
function isRuntimeOpcode(opcode, member) {
  return (
    opcode === member ||
    opcode === `${dsl4BlockSourceRuntimeExtensionId}_${member}` ||
    opcode === `${dsl4BlockSourceBundleExtensionId}_${dsl4BlockSourceRuntimeExtensionId}__${member}`
  );
}

/** @param {string} opcode @param {string} member */
function isYamlJsonOpcode(opcode, member) {
  return opcode === member || opcode === `${yamlJsonExtensionId}_${member}`;
}

/** @param {unknown} value @param {Readonly<Record<string, number>>} limits */
function boundedScalar(value, limits) {
  const text = String(value);
  if (text.length > limits.maxScalarCodeUnits) {
    fail('K4-BLOCK-SOURCE-LIMIT-001', 'YAML/JSON scalar exceeds the code unit limit');
  }
  return text;
}

/** @param {string} name */
function sourcePathForTargetName(name) {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('\0') ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    fail('K4-BLOCK-SOURCE-PATH-001', 'Target name cannot be used as a DSL source filename', {
      targetName: name,
    });
  }
  return name.endsWith(sourceSuffix) ? name : `${name}${sourceSuffix}`;
}

/** @param {unknown} input */
function literalInputValue(input) {
  if (!Array.isArray(input)) return '';
  const type = input[0];
  const value = input[1];
  if (scalarInputTypes.has(type)) return Number(value);
  if (stringInputTypes.has(type)) return value;
  return value ?? '';
}

/**
 * @param {Record<string, unknown>} blocks
 * @param {unknown} input
 * @param {Readonly<Record<string, number>>} limits
 * @param {Set<string>} visiting
 * @param {number} depth
 * @returns {unknown}
 */
function inputValue(blocks, input, limits, visiting, depth) {
  if (!Array.isArray(input) || input.length < 2) return '';
  const candidate = input[1];
  if (typeof candidate === 'string' && isRecord(blocks[candidate])) {
    return evaluateReporter(blocks, candidate, limits, visiting, depth + 1);
  }
  if (Array.isArray(candidate)) return literalInputValue(candidate);
  return candidate ?? '';
}

/** @param {number} value */
function finiteNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

/** @param {unknown} value */
function booleanValue(value) {
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  return !(text === '' || text === '0' || text === 'false');
}

/** @param {unknown} fragment */
function normalizeContent(fragment) {
  return typeof fragment === 'string' ? {kind: 'scalar', value: fragment} : fragment;
}

/** @param {unknown} fragment */
function blankAsEmpty(fragment) {
  return fragment === '' ? {kind: 'empty'} : fragment;
}

/** @param {unknown} fragment @returns {unknown[]} */
function flattenConcat(fragment) {
  if (isRecord(fragment) && fragment.kind === 'concat' && Array.isArray(fragment.children)) {
    return fragment.children.flatMap(flattenConcat);
  }
  return [fragment];
}

/** @param {unknown} entries */
function normalizeEntries(entries) {
  const fragment = normalizeContent(entries);
  if (isRecord(fragment) && fragment.kind === 'empty') return [];
  if (isRecord(fragment) && fragment.kind === 'map' && Array.isArray(fragment.entries)) {
    return fragment.entries;
  }
  const children = flattenConcat(fragment);
  if (children.every((child) => isRecord(child) && child.kind === 'pair')) return children;
  fail('K4-BLOCK-SOURCE-FRAGMENT-001', 'YAML/JSON map entries must be pair fragments');
}

/** @param {unknown} items */
function normalizeItems(items) {
  const fragment = normalizeContent(items);
  if (isRecord(fragment) && fragment.kind === 'empty') return [];
  if (isRecord(fragment) && fragment.kind === 'concat' && Array.isArray(fragment.children)) {
    return fragment.children;
  }
  return [fragment];
}

/** @param {unknown} left @param {unknown} right */
function concatFragments(left, right) {
  const children = [...flattenConcat(left), ...flattenConcat(right)].filter(
    (child) => !(isRecord(child) && child.kind === 'empty'),
  );
  if (children.length === 0) return {kind: 'empty'};
  if (children.length === 1) return children[0];
  return {kind: 'concat', children};
}

/**
 * @param {Record<string, unknown>} blocks
 * @param {string} blockId
 * @param {Readonly<Record<string, number>>} limits
 * @param {Set<string>} visiting
 * @param {number} depth
 * @returns {unknown}
 */
function evaluateReporter(blocks, blockId, limits, visiting, depth) {
  if (depth > limits.maxReporterDepth || visiting.size > limits.maxReporterNodes) {
    fail('K4-BLOCK-SOURCE-LIMIT-001', 'YAML/JSON reporter graph exceeds its limit', {blockId});
  }
  if (visiting.has(blockId)) {
    fail('K4-BLOCK-SOURCE-GRAPH-001', 'YAML/JSON reporter graph contains a cycle', {blockId});
  }
  const block = blocks[blockId];
  if (!isRecord(block) || typeof block.opcode !== 'string') {
    fail('K4-BLOCK-SOURCE-GRAPH-001', 'YAML/JSON reporter block is missing', {blockId});
  }
  const inputs = isRecord(block.inputs) ? block.inputs : {};
  visiting.add(blockId);
  try {
    if (isYamlJsonOpcode(block.opcode, 'string')) {
      return {
        kind: 'scalar',
        value: boundedScalar(inputValue(blocks, inputs.VALUE, limits, visiting, depth), limits),
      };
    }
    if (isYamlJsonOpcode(block.opcode, 'number')) {
      return {
        kind: 'scalar',
        value: finiteNumber(Number(inputValue(blocks, inputs.VALUE, limits, visiting, depth))),
      };
    }
    if (isYamlJsonOpcode(block.opcode, 'boolean')) {
      return {
        kind: 'scalar',
        value: booleanValue(inputValue(blocks, inputs.VALUE, limits, visiting, depth)),
      };
    }
    if (isYamlJsonOpcode(block.opcode, 'nullValue')) return {kind: 'scalar', value: null};
    if (isYamlJsonOpcode(block.opcode, 'pair')) {
      return {
        kind: 'pair',
        key: boundedScalar(inputValue(blocks, inputs.KEY, limits, visiting, depth), limits),
        value: normalizeContent(inputValue(blocks, inputs.VALUE, limits, visiting, depth)),
      };
    }
    if (isYamlJsonOpcode(block.opcode, 'map')) {
      return {
        kind: 'map',
        entries: normalizeEntries(
          blankAsEmpty(inputValue(blocks, inputs.ENTRIES, limits, visiting, depth)),
        ),
      };
    }
    if (isYamlJsonOpcode(block.opcode, 'sequence')) {
      return {
        kind: 'sequence',
        items: normalizeItems(
          blankAsEmpty(inputValue(blocks, inputs.ITEMS, limits, visiting, depth)),
        ),
      };
    }
    if (isYamlJsonOpcode(block.opcode, 'concat')) {
      return concatFragments(
        blankAsEmpty(inputValue(blocks, inputs.LEFT, limits, visiting, depth)),
        blankAsEmpty(inputValue(blocks, inputs.RIGHT, limits, visiting, depth)),
      );
    }
    if (isYamlJsonOpcode(block.opcode, 'renderYaml')) {
      return renderYaml(inputValue(blocks, inputs.FRAGMENT, limits, visiting, depth));
    }
    if (isYamlJsonOpcode(block.opcode, 'renderJson')) {
      return `${JSON.stringify(toValue(inputValue(blocks, inputs.FRAGMENT, limits, visiting, depth)), null, 2)}\n`;
    }
    fail('K4-BLOCK-SOURCE-FRAGMENT-001', `Unsupported YAML/JSON reporter opcode: ${block.opcode}`, {
      blockId,
    });
  } finally {
    visiting.delete(blockId);
  }
}

/** @param {unknown} fragment @returns {unknown} */
function toValue(fragment) {
  if (!isRecord(fragment)) return String(fragment ?? '');
  switch (fragment.kind) {
    case 'empty':
      return null;
    case 'scalar':
      return fragment.value;
    case 'pair': {
      /** @type {Record<string, unknown>} */
      const output = {};
      output[String(fragment.key)] = toValue(fragment.value);
      return output;
    }
    case 'map': {
      /** @type {Record<string, unknown>} */
      const output = {};
      for (const entry of Array.isArray(fragment.entries) ? fragment.entries : []) {
        if (!isRecord(entry) || entry.kind !== 'pair') {
          fail('K4-BLOCK-SOURCE-FRAGMENT-001', 'YAML/JSON map contains a non-pair entry');
        }
        output[String(entry.key)] = toValue(entry.value);
      }
      return output;
    }
    case 'sequence':
      return (Array.isArray(fragment.items) ? fragment.items : []).map(toValue);
    case 'concat': {
      /** @type {unknown[]} */
      const values = (Array.isArray(fragment.children) ? fragment.children : [])
        .filter((child) => !(isRecord(child) && child.kind === 'empty'))
        .map(toValue);
      if (values.length === 0) return null;
      if (values.every((value) => isRecord(value) && !Array.isArray(value))) {
        return Object.assign({}, ...values);
      }
      return values;
    }
    default:
      fail('K4-BLOCK-SOURCE-FRAGMENT-001', 'YAML/JSON fragment is invalid');
  }
}

/** @param {unknown} value @param {number} indent @returns {string} */
function renderYamlValue(value, indent) {
  if (isRecord(value) && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${' '.repeat(indent)}{}`;
    return entries.map(([key, child]) => renderValuePair(key, child, indent)).join('\n');
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${' '.repeat(indent)}[]`;
    return value.map((child) => renderSequenceItem(child, indent)).join('\n');
  }
  return `${' '.repeat(indent)}${renderScalar(value)}`;
}

/** @param {string} key @param {unknown} value @param {number} indent @returns {string} */
function renderValuePair(key, value, indent) {
  const prefix = `${' '.repeat(indent)}${simpleKeyPattern.test(key) ? key : JSON.stringify(key)}:`;
  if (!isRecord(value) && !Array.isArray(value)) return `${prefix} ${renderScalar(value)}`;
  return `${prefix}\n${renderYamlValue(value, indent + 2)}`;
}

/** @param {unknown} value @param {number} indent @returns {string} */
function renderSequenceItem(value, indent) {
  const prefix = `${' '.repeat(indent)}-`;
  if (!isRecord(value) && !Array.isArray(value)) return `${prefix} ${renderScalar(value)}`;
  return `${prefix}\n${renderYamlValue(value, indent + 2)}`;
}

/** @param {unknown} value @returns {string} */
function renderScalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(finiteNumber(value));
  return JSON.stringify(String(value ?? ''));
}

/** @param {unknown} fragment @returns {string} */
function renderYaml(fragment) {
  return `${renderYamlValue(toValue(fragment), 0)}\n`;
}

/**
 * @param {Record<string, unknown>} blocks
 * @param {string} commandId
 * @param {Readonly<Record<string, number>>} limits
 */
function sourceTextFromCommand(blocks, commandId, limits) {
  const command = blocks[commandId];
  if (
    !isRecord(command) ||
    typeof command.opcode !== 'string' ||
    !isRuntimeOpcode(command.opcode, dsl4BlockSourceCommandOpcode)
  ) {
    fail('K4-BLOCK-SOURCE-GRAPH-001', 'DSL source hat must be followed by a DSL source command', {
      blockId: commandId,
    });
  }
  if (command.next !== null) {
    fail('K4-BLOCK-SOURCE-GRAPH-001', 'DSL source command must be the only block under the hat', {
      blockId: commandId,
    });
  }
  const inputs = isRecord(command.inputs) ? command.inputs : {};
  const value = inputValue(blocks, inputs.FRAGMENT, limits, new Set(), 0);
  return typeof value === 'string' ? value : renderYaml(value);
}

/**
 * Extract virtual DSL 4.0 source files from TurboWarp YAML/JSON blocks inside one SB3 project.
 *
 * @param {unknown} project
 * @param {{limits?: unknown}} [options]
 */
export function extractDsl4BlockSourcesFromProject(project, {limits: inputLimits} = {}) {
  if (!isRecord(project) || !Array.isArray(project.targets)) {
    fail('K4-BLOCK-SOURCE-PROJECT-001', 'SB3 project must contain targets');
  }
  const limits = resolveLimits(inputLimits);
  if (project.targets.length > limits.maxTargets) {
    fail('K4-BLOCK-SOURCE-LIMIT-001', 'SB3 target count exceeds the block source limit');
  }

  /** @type {Map<string, string>} */
  const sources = new Map();
  let entryPath = '';
  for (const target of project.targets) {
    const blocks = targetBlocks(target);
    const blockIds = Object.keys(blocks);
    if (blockIds.length > limits.maxBlocksPerTarget) {
      fail('K4-BLOCK-SOURCE-LIMIT-001', 'SB3 target block count exceeds the block source limit', {
        targetName: /** @type {Record<string, unknown>} */ (target).name,
      });
    }
    const hats = blockIds
      .filter((blockId) => {
        const block = blocks[blockId];
        return (
          isRecord(block) &&
          typeof block.opcode === 'string' &&
          isRuntimeOpcode(block.opcode, dsl4BlockSourceHatOpcode) &&
          block.topLevel === true &&
          block.parent === null
        );
      })
      .sort();
    if (hats.length === 0) continue;
    const targetName = /** @type {string} */ (/** @type {Record<string, unknown>} */ (target).name);
    if (hats.length > 1) {
      fail('K4-BLOCK-SOURCE-DUPLICATE-001', 'Target contains more than one DSL source hat', {
        targetName,
      });
    }
    const hat = /** @type {Record<string, unknown>} */ (blocks[hats[0]]);
    if (typeof hat.next !== 'string') {
      fail('K4-BLOCK-SOURCE-GRAPH-001', 'DSL source hat must have a block below it', {
        targetName,
        blockId: hats[0],
      });
    }
    const sourcePath = sourcePathForTargetName(targetName);
    if (sources.has(sourcePath)) {
      fail('K4-BLOCK-SOURCE-DUPLICATE-001', 'DSL source filename is duplicated', {
        targetName,
      });
    }
    const sourceText = sourceTextFromCommand(blocks, hat.next, limits);
    sources.set(sourcePath, sourceText);
    if (/** @type {Record<string, unknown>} */ (target).isStage === true) {
      if (entryPath) {
        fail(
          'K4-BLOCK-SOURCE-DUPLICATE-001',
          'Project contains more than one Stage DSL source hat',
        );
      }
      entryPath = sourcePath;
    }
  }
  if (!entryPath) {
    fail('K4-BLOCK-SOURCE-MISSING-001', 'Stage must contain one root DSL source hat');
  }
  return deepFreeze({
    formatVersion: 1,
    entryPath,
    sources: Object.fromEntries([...sources].sort(([left], [right]) => (left < right ? -1 : 1))),
  });
}
