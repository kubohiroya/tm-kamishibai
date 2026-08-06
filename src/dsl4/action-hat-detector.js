import {createDsl4ActionRegistrySnapshot, Dsl4ActionRegistryError} from './action-registry.js';

const mutationKeys = new Set(['tagName', 'children', 'dsl4action']);
const declarationKeys = new Set(['version', 'name', 'target', 'parameters', 'quiesce']);
const parameterKeys = new Set(['name', 'type', 'required']);
const parameterTypes = new Set(['string', 'number', 'boolean']);
const quiesceModes = new Set(['finish-only', 'cancel-replay-safe']);

export const dsl4ActionHatDetectorDefaultLimits = Object.freeze({
  maxOriginalTargets: 256,
  maxTopLevelBlocksPerTarget: 4096,
  maxCustomActions: 64,
  maxParametersPerAction: 16,
  maxNameScalars: 64,
  maxMutationCodeUnits: 8192,
});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} code @param {string} message @returns {never} */
function fail(code, message) {
  throw new Dsl4ActionRegistryError(code, message);
}

/** @param {Record<string, unknown>} value @param {Set<string>} keys @param {string} label */
function requireExactKeys(value, keys, label) {
  const unknown = Object.keys(value).filter((key) => !keys.has(key));
  if (unknown.length > 0) {
    fail('K4-REGISTRY-MUTATION-001', `${label} has unknown keys`);
  }
}

/** @param {unknown} input @returns {Readonly<Record<string, number>>} */
function resolveLimits(input) {
  if (input === undefined) return dsl4ActionHatDetectorDefaultLimits;
  if (!isRecord(input)) fail('K4-REGISTRY-LIMIT-001', 'Action hat limits must be an object');
  const unknown = Object.keys(input).filter(
    (key) => !Object.hasOwn(dsl4ActionHatDetectorDefaultLimits, key),
  );
  if (unknown.length > 0) {
    fail('K4-REGISTRY-LIMIT-001', `Unknown action hat limits: ${unknown.sort().join(', ')}`);
  }
  const limits = {...dsl4ActionHatDetectorDefaultLimits, ...input};
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      fail('K4-REGISTRY-LIMIT-001', `${name} must be a positive safe integer`);
    }
  }
  return Object.freeze(limits);
}

/** @param {unknown} value @param {string} label @param {number} maxScalars @returns {string} */
function requireBoundedName(value, label, maxScalars) {
  if (typeof value !== 'string') {
    fail('K4-REGISTRY-MUTATION-001', `${label} must be a string`);
  }
  if ([...value].length > maxScalars) {
    fail('K4-REGISTRY-LIMIT-001', `${label} exceeds the Unicode scalar limit`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @returns {string} */
function requireSourceId(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('K4-REGISTRY-DETECT-001', `${label} must be a non-empty string`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @returns {Record<string, unknown>} */
function requireDeclarationRecord(value, label) {
  if (!isRecord(value)) {
    fail('K4-REGISTRY-MUTATION-001', `${label} must be a JSON object`);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} block
 * @param {Readonly<Record<string, number>>} limits
 * @param {string} targetId
 * @param {string} blockId
 * @returns {Record<string, unknown>}
 */
function readDeclaration(block, limits, targetId, blockId) {
  if (!isRecord(block.mutation)) {
    fail('K4-REGISTRY-MUTATION-001', 'Custom action hat mutation must be an object');
  }
  const mutation = block.mutation;
  requireExactKeys(mutation, mutationKeys, 'Custom action hat mutation');
  if (
    mutation.tagName !== 'mutation' ||
    !Array.isArray(mutation.children) ||
    mutation.children.length !== 0 ||
    typeof mutation.dsl4action !== 'string'
  ) {
    fail(
      'K4-REGISTRY-MUTATION-001',
      'Custom action hat mutation must contain tagName, empty children, and dsl4action JSON',
    );
  }
  if (mutation.dsl4action.length > limits.maxMutationCodeUnits) {
    fail('K4-REGISTRY-LIMIT-001', 'Custom action hat mutation exceeds its JSON size limit');
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(mutation.dsl4action);
  } catch {
    fail('K4-REGISTRY-MUTATION-001', 'Custom action hat declaration is invalid JSON');
  }
  const declaration = requireDeclarationRecord(parsed, 'Custom action hat declaration');
  requireExactKeys(declaration, declarationKeys, 'Custom action hat declaration');
  for (const required of ['version', 'name', 'target', 'parameters']) {
    if (!Object.hasOwn(declaration, required)) {
      fail('K4-REGISTRY-MUTATION-001', `Custom action hat declaration requires ${required}`);
    }
  }
  if (declaration.version !== 1) {
    fail('K4-REGISTRY-MUTATION-001', 'Custom action hat declaration version must be 1');
  }
  if (!Array.isArray(declaration.parameters)) {
    fail('K4-REGISTRY-MUTATION-001', 'Custom action hat parameters must be an array');
  }
  if (declaration.target !== 'actor') {
    fail('K4-REGISTRY-MUTATION-001', 'Custom action hat target must be actor');
  }
  if (
    Object.hasOwn(declaration, 'quiesce') &&
    (typeof declaration.quiesce !== 'string' || !quiesceModes.has(declaration.quiesce))
  ) {
    fail('K4-REGISTRY-MUTATION-001', 'Custom action hat quiesce mode is invalid');
  }
  if (declaration.parameters.length > limits.maxParametersPerAction) {
    fail('K4-REGISTRY-LIMIT-001', 'Custom action hat exceeds the parameter limit');
  }
  const parameters = declaration.parameters.map((input, index) => {
    const parameter = requireDeclarationRecord(input, `Custom action parameter ${index}`);
    requireExactKeys(parameter, parameterKeys, `Custom action parameter ${index}`);
    if (!Object.hasOwn(parameter, 'name') || !Object.hasOwn(parameter, 'type')) {
      fail('K4-REGISTRY-MUTATION-001', `Custom action parameter ${index} requires name and type`);
    }
    if (typeof parameter.type !== 'string' || !parameterTypes.has(parameter.type)) {
      fail('K4-REGISTRY-MUTATION-001', `Custom action parameter ${index} type is invalid`);
    }
    if (Object.hasOwn(parameter, 'required') && typeof parameter.required !== 'boolean') {
      fail('K4-REGISTRY-MUTATION-001', `Custom action parameter ${index} required is invalid`);
    }
    return {
      name: requireBoundedName(
        parameter.name,
        `Custom action parameter ${index} name`,
        limits.maxNameScalars,
      ),
      type: parameter.type,
      ...(Object.hasOwn(parameter, 'required') ? {required: parameter.required} : {}),
    };
  });
  return {
    name: requireBoundedName(declaration.name, 'Custom action name', limits.maxNameScalars),
    target: declaration.target,
    parameters,
    ...(Object.hasOwn(declaration, 'quiesce') ? {quiesce: declaration.quiesce} : {}),
    source: {targetId, hatBlockId: blockId},
  };
}

/** @param {unknown} target @returns {Record<string, unknown>} */
function targetBlocks(target) {
  if (!isRecord(target) || target.isOriginal !== true) {
    fail('K4-REGISTRY-DETECT-001', 'Original TurboWarp target is invalid');
  }
  const container = target.blocks;
  if (!isRecord(container)) {
    fail('K4-REGISTRY-DETECT-001', 'Original TurboWarp target blocks are invalid');
  }
  if (isRecord(container._blocks)) return container._blocks;
  return container;
}

/**
 * Detect one immutable Registry Snapshot without executing project blocks.
 *
 * @param {object} options
 * @param {unknown} options.runtime
 * @param {string} options.hatOpcode
 * @param {unknown} [options.limits]
 */
export function detectDsl4ActionRegistrySnapshot({runtime, hatOpcode, limits: inputLimits}) {
  if (!isRecord(runtime) || !Array.isArray(runtime.targets)) {
    fail('K4-REGISTRY-DETECT-001', 'TurboWarp runtime must provide a targets array');
  }
  if (typeof hatOpcode !== 'string' || hatOpcode.length === 0) {
    fail('K4-REGISTRY-DETECT-001', 'Custom action hat opcode must be a non-empty string');
  }
  const limits = resolveLimits(inputLimits);
  for (const candidate of runtime.targets) {
    if (!isRecord(candidate) || typeof candidate.isOriginal !== 'boolean') {
      fail('K4-REGISTRY-DETECT-001', 'TurboWarp target original-state metadata is invalid');
    }
  }
  const originals = runtime.targets.filter(
    (candidate) => isRecord(candidate) && candidate.isOriginal === true,
  );
  if (originals.length > limits.maxOriginalTargets) {
    fail('K4-REGISTRY-LIMIT-001', 'Original target limit was exceeded');
  }
  const targetIds = new Set();
  for (const target of originals) {
    const targetId = requireSourceId(target.id, 'Original target ID');
    if (targetIds.has(targetId)) {
      fail('K4-REGISTRY-DETECT-001', 'Original target ID is duplicated');
    }
    targetIds.add(targetId);
  }
  originals.sort((left, right) => {
    const leftId = /** @type {string} */ (left.id);
    const rightId = /** @type {string} */ (right.id);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });

  /** @type {Record<string, unknown>[]} */
  const entries = [];
  for (const target of originals) {
    const targetId = requireSourceId(target.id, 'Original target ID');
    const blocks = targetBlocks(target);
    const topLevelBlockIds = Object.keys(blocks)
      .filter((blockId) => isRecord(blocks[blockId]) && blocks[blockId].topLevel === true)
      .sort();
    if (topLevelBlockIds.length > limits.maxTopLevelBlocksPerTarget) {
      fail('K4-REGISTRY-LIMIT-001', 'Top-level block limit was exceeded');
    }
    for (const blockId of topLevelBlockIds) {
      const block = /** @type {Record<string, unknown>} */ (blocks[blockId]);
      if (block.opcode !== hatOpcode || block.parent !== null) continue;
      requireSourceId(blockId, 'Top-level block ID');
      if (entries.length >= limits.maxCustomActions) {
        fail('K4-REGISTRY-LIMIT-001', 'Custom action limit was exceeded');
      }
      entries.push(readDeclaration(block, limits, targetId, blockId));
    }
  }
  return createDsl4ActionRegistrySnapshot(entries);
}
