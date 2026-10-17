import {deepFreeze} from './story-document.js';
import {
  dsl4BlockSourceHatOpcode,
  dsl4BlockSourceCommandOpcode,
  dsl4BlockSourceRuntimeExtensionId,
  dsl4BlockSourceBundleExtensionId,
  yamlJsonExtensionId,
  Dsl4BlockSourceError,
} from './block-source-shared.js';
import {
  readDsl4StructuredBlockSource,
  isDsl4StructuredSourceOpcode,
  dsl4LabeledBlockSourceHatOpcode,
} from './structured-block-source.js';
export {
  dsl4BlockSourceHatOpcode,
  dsl4BlockSourceCommandOpcode,
  dsl4BlockSourceRuntimeExtensionId,
  dsl4BlockSourceBundleExtensionId,
  yamlJsonExtensionId,
  Dsl4BlockSourceError,
} from './block-source-shared.js';

const sourceSuffix = '.k4.yml';
const simpleKeyPattern = /^[A-Za-z_][A-Za-z0-9_-]*$/u;
const scalarInputTypes = new Set([4, 5, 6, 7, 8]);
const stringInputTypes = new Set([10, 11, 12, 13]);

export const dsl4BlockSourceDefaultLimits = Object.freeze({
  maxTargets: 256,
  maxDeclarations: 256,
  maxBlocksPerTarget: 8192,
  maxReporterNodes: 4096,
  maxReporterDepth: 128,
  maxScalarCodeUnits: 65536,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string, details?: object): never {
  throw new Dsl4BlockSourceError(code, message, details);
}

function resolveLimits(input: unknown): Readonly<typeof dsl4BlockSourceDefaultLimits> {
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

function targetBlocks(target: unknown) {
  if (!isRecord(target) || typeof target.name !== 'string' || typeof target.isStage !== 'boolean') {
    fail('K4-BLOCK-SOURCE-PROJECT-001', 'SB3 target metadata is invalid');
  }
  if (!isRecord(target.blocks)) {
    fail('K4-BLOCK-SOURCE-PROJECT-001', 'SB3 target blocks are invalid', {
      targetName: target.name,
    });
  }
  return target.blocks as Record<string, unknown>;
}

function isRuntimeOpcode(opcode: string, member: string) {
  return (
    opcode === member ||
    opcode === `${dsl4BlockSourceRuntimeExtensionId}_${member}` ||
    opcode === `${dsl4BlockSourceBundleExtensionId}_${dsl4BlockSourceRuntimeExtensionId}__${member}`
  );
}

function isYamlJsonOpcode(opcode: string, member: string) {
  return opcode === member || opcode === `${yamlJsonExtensionId}_${member}`;
}

function boundedScalar(value: unknown, limits: Readonly<typeof dsl4BlockSourceDefaultLimits>) {
  const text = String(value);
  if (text.length > limits.maxScalarCodeUnits) {
    fail('K4-BLOCK-SOURCE-LIMIT-001', 'YAML/JSON scalar exceeds the code unit limit');
  }
  return text;
}

function sourcePathForTargetName(name: string) {
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

function literalInputValue(input: unknown) {
  if (!Array.isArray(input)) return '';
  const type = input[0];
  const value = input[1];
  if (scalarInputTypes.has(type)) return Number(value);
  if (stringInputTypes.has(type)) return value;
  return value ?? '';
}

function inputValue(
  blocks: Record<string, unknown>,
  input: unknown,
  limits: Readonly<typeof dsl4BlockSourceDefaultLimits>,
  visiting: Set<string>,
  depth: number,
): unknown {
  if (!Array.isArray(input) || input.length < 2) return '';
  const candidate = input[1];
  if (typeof candidate === 'string' && isRecord(blocks[candidate])) {
    return evaluateReporter(blocks, candidate, limits, visiting, depth + 1);
  }
  if (Array.isArray(candidate)) return literalInputValue(candidate);
  return candidate ?? '';
}

function finiteNumber(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function booleanValue(value: unknown) {
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  return !(text === '' || text === '0' || text === 'false');
}

function normalizeContent(fragment: unknown) {
  return typeof fragment === 'string' ? {kind: 'scalar', value: fragment} : fragment;
}

function blankAsEmpty(fragment: unknown) {
  return fragment === '' ? {kind: 'empty'} : fragment;
}

function flattenConcat(fragment: unknown): unknown[] {
  if (isRecord(fragment) && fragment.kind === 'concat' && Array.isArray(fragment.children)) {
    return fragment.children.flatMap(flattenConcat);
  }
  return [fragment];
}

function normalizeEntries(entries: unknown) {
  const fragment = normalizeContent(entries);
  if (isRecord(fragment) && fragment.kind === 'empty') return [];
  if (isRecord(fragment) && fragment.kind === 'map' && Array.isArray(fragment.entries)) {
    return fragment.entries;
  }
  const children = flattenConcat(fragment);
  if (children.every((child) => isRecord(child) && child.kind === 'pair')) return children;
  fail('K4-BLOCK-SOURCE-FRAGMENT-001', 'YAML/JSON map entries must be pair fragments');
}

function normalizeItems(items: unknown) {
  const fragment = normalizeContent(items);
  if (isRecord(fragment) && fragment.kind === 'empty') return [];
  if (isRecord(fragment) && fragment.kind === 'concat' && Array.isArray(fragment.children)) {
    return fragment.children;
  }
  return [fragment];
}

function concatFragments(left: unknown, right: unknown) {
  const children = [...flattenConcat(left), ...flattenConcat(right)].filter(
    (child) => !(isRecord(child) && child.kind === 'empty'),
  );
  if (children.length === 0) return {kind: 'empty'};
  if (children.length === 1) return children[0];
  return {kind: 'concat', children};
}

function evaluateReporter(
  blocks: Record<string, unknown>,
  blockId: string,
  limits: Readonly<typeof dsl4BlockSourceDefaultLimits>,
  visiting: Set<string>,
  depth: number,
): unknown {
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

function toValue(fragment: unknown): unknown {
  if (!isRecord(fragment)) return String(fragment ?? '');
  switch (fragment.kind) {
    case 'empty':
      return null;
    case 'scalar':
      return fragment.value;
    case 'pair': {
      const output: Record<string, unknown> = {};
      output[String(fragment.key)] = toValue(fragment.value);
      return output;
    }
    case 'map': {
      const output: Record<string, unknown> = {};
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
      const values: unknown[] = (Array.isArray(fragment.children) ? fragment.children : [])
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

function renderYamlValue(value: unknown, indent: number): string {
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

function renderValuePair(key: string, value: unknown, indent: number): string {
  const prefix = `${' '.repeat(indent)}${simpleKeyPattern.test(key) ? key : JSON.stringify(key)}:`;
  if (!isRecord(value) && !Array.isArray(value)) return `${prefix} ${renderScalar(value)}`;
  return `${prefix}\n${renderYamlValue(value, indent + 2)}`;
}

function renderSequenceItem(value: unknown, indent: number): string {
  const prefix = `${' '.repeat(indent)}-`;
  if (!isRecord(value) && !Array.isArray(value)) return `${prefix} ${renderScalar(value)}`;
  return `${prefix}\n${renderYamlValue(value, indent + 2)}`;
}

function renderScalar(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(finiteNumber(value));
  return JSON.stringify(String(value ?? ''));
}

function renderYaml(fragment: unknown): string {
  return `${renderYamlValue(toValue(fragment), 0)}\n`;
}

function sourceTextFromCommand(
  blocks: Record<string, unknown>,
  commandId: string,
  limits: Readonly<typeof dsl4BlockSourceDefaultLimits>,
) {
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
 */
/**
 * The opcode names a declaration takes, for the extension the project actually loads.
 *
 * A project that loads the bundle names the runtime's members through it, and the editor resolves
 * a block only under the name its own extension uses -- so writing the wrong form would still read
 * back here while showing up as an unknown block to the author.
 */
export function dsl4BlockSourceOpcodes(form: 'runtime' | 'bundle') {
  const prefix =
    form === 'bundle'
      ? `${dsl4BlockSourceBundleExtensionId}_${dsl4BlockSourceRuntimeExtensionId}__`
      : `${dsl4BlockSourceRuntimeExtensionId}_`;
  return Object.freeze({
    hat: `${prefix}${dsl4BlockSourceHatOpcode}`,
    command: `${prefix}${dsl4BlockSourceCommandOpcode}`,
  });
}

/** The target name that carries one source path, inverting `sourcePathForTargetName`. */
export function targetNameForSourcePath(sourcePath: string) {
  if (!sourcePath.endsWith(sourceSuffix)) {
    fail('K4-BLOCK-SOURCE-PATH-001', `DSL source filename must end with ${sourceSuffix}`);
  }
  const name = sourcePath.slice(0, -sourceSuffix.length);
  if (name.length === 0) {
    fail('K4-BLOCK-SOURCE-PATH-001', 'DSL source filename must name a target');
  }
  // Round-trip through the reader's own rule so a name it would reject never reaches a project.
  if (sourcePathForTargetName(name) !== sourcePath) {
    fail('K4-BLOCK-SOURCE-PATH-001', 'DSL source filename does not match its target name', {
      targetName: name,
    });
  }
  return name;
}

/**
 * The two blocks one DSL source declaration is made of: the hat, and the command that holds the
 * source text in its FRAGMENT input.
 */
export function createDsl4BlockSourceDeclaration({
  sourceText,
  form,
  hatId,
  commandId,
}: {
  sourceText: string;
  form: 'runtime' | 'bundle';
  hatId: string;
  commandId: string;
}) {
  if (typeof sourceText !== 'string' || sourceText.length === 0) {
    fail('K4-BLOCK-SOURCE-GRAPH-001', 'DSL source text must be a non-empty string');
  }
  if (hatId === commandId) {
    fail('K4-BLOCK-SOURCE-GRAPH-001', 'DSL source block ids must differ');
  }
  const opcodes = dsl4BlockSourceOpcodes(form);
  return deepFreeze({
    [hatId]: {
      opcode: opcodes.hat,
      next: commandId,
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
    },
    [commandId]: {
      opcode: opcodes.command,
      next: null,
      parent: hatId,
      inputs: {FRAGMENT: [1, [10, sourceText]]},
      fields: {},
      shadow: false,
      topLevel: false,
    },
  });
}

export function extractDsl4BlockSourcesFromProject(
  project: unknown,
  {limits: inputLimits}: {limits?: unknown} = {},
) {
  if (!isRecord(project) || !Array.isArray(project.targets)) {
    fail('K4-BLOCK-SOURCE-PROJECT-001', 'SB3 project must contain targets');
  }
  const limits = resolveLimits(inputLimits);
  if (project.targets.length > limits.maxTargets) {
    fail('K4-BLOCK-SOURCE-LIMIT-001', 'SB3 target count exceeds the block source limit');
  }

  const declarations: {
    targetName: string;
    isStage: boolean;
    blocks: Record<string, unknown>;
    hatId: string;
    hat: Record<string, unknown>;
    labeled: boolean;
    label: string;
    sourcePath: string;
  }[] = [];
  function staticText(
    blocks: Record<string, unknown>,
    input: unknown,
    parent: string,
    targetName: string,
    optional = false,
  ): string {
    if (input === undefined && optional) return '';
    if (Array.isArray(input) && [1, 2, 3].includes(input[0])) {
      let literal = input[1];
      if (typeof literal === 'string') {
        const shadow = blocks[literal];
        if (
          isRecord(shadow) &&
          shadow.opcode === 'text' &&
          shadow.shadow === true &&
          shadow.parent === parent &&
          shadow.topLevel === false &&
          shadow.next === null &&
          isRecord(shadow.fields) &&
          isRecord(shadow.inputs) &&
          !Object.keys(shadow.inputs).length
        ) {
          const field = shadow.fields.TEXT;
          if (Array.isArray(field)) literal = [10, field[0]];
        }
      }
      if (Array.isArray(literal) && literal[0] === 10 && typeof literal[1] === 'string') {
        boundedScalar(literal[1], limits);
        return literal[1];
      }
    }
    fail('K4-BLOCK-SOURCE-LABEL-001', 'Declaration version and labels require static text', {
      targetName,
      blockId: parent,
    });
  }
  for (const target of project.targets) {
    const blocks = targetBlocks(target);
    const blockIds = Object.keys(blocks);
    if (blockIds.length > limits.maxBlocksPerTarget) {
      fail('K4-BLOCK-SOURCE-LIMIT-001', 'SB3 target block count exceeds the block source limit', {
        targetName: (target as Record<string, unknown>).name,
      });
    }
    const hats = blockIds
      .filter((blockId) => {
        const block = blocks[blockId];
        return (
          isRecord(block) &&
          typeof block.opcode === 'string' &&
          (isRuntimeOpcode(block.opcode, dsl4BlockSourceHatOpcode) ||
            block.opcode === dsl4LabeledBlockSourceHatOpcode) &&
          block.topLevel === true &&
          block.parent === null
        );
      })
      .sort();
    if (hats.length === 0) continue;
    const targetName = (target as Record<string, unknown>).name as string;
    for (const hatId of hats) {
      const hat = blocks[hatId] as Record<string, unknown>;
      const labeled = hat.opcode === dsl4LabeledBlockSourceHatOpcode;
      if (
        hat.shadow !== false ||
        !isRecord(hat.inputs) ||
        (typeof hat.next !== 'string' && !(labeled && hat.next === null))
      ) {
        fail('K4-BLOCK-SOURCE-GRAPH-001', 'DSL source hat has invalid connections', {
          targetName,
          blockId: hatId,
        });
      }
      let label = '';
      if (labeled) {
        if (Object.keys(hat.inputs).some((key) => !['VERSION', 'LABEL'].includes(key))) {
          fail('K4-BLOCK-SOURCE-GRAPH-001', 'Unexpected input in source hat', {
            targetName,
            blockId: hatId,
          });
        }
        if (staticText(blocks, hat.inputs.VERSION, hatId, targetName) !== '4.0') {
          fail('K4-BLOCK-SOURCE-VERSION-001', 'Source declaration version must be 4.0', {
            targetName,
            blockId: hatId,
          });
        }
        label = staticText(blocks, hat.inputs.LABEL, hatId, targetName, true);
      }
      if (!label && declarations.some((item) => item.blocks === blocks && !item.label)) {
        fail(
          'K4-BLOCK-SOURCE-DUPLICATE-001',
          'Target contains more than one unlabeled DSL source hat',
          {targetName, blockId: hatId},
        );
      }
      declarations.push({
        targetName,
        isStage: (target as Record<string, unknown>).isStage === true,
        blocks,
        hatId,
        hat,
        labeled,
        label,
        sourcePath: '',
      });
      if (declarations.length > limits.maxDeclarations) {
        fail('K4-BLOCK-SOURCE-LIMIT-001', 'Project exceeds the source declaration limit', {
          targetName,
          blockId: hatId,
        });
      }
    }
  }
  const stages = declarations.filter((item) => item.isStage);
  const roots = stages.filter((item) => !item.label);
  const entry = roots.length === 1 ? roots[0] : stages.length === 1 ? stages[0] : undefined;
  if (!entry) {
    fail('K4-BLOCK-SOURCE-MISSING-001', 'Stage must contain one unambiguous root DSL source hat');
  }
  const labels = new Map<string, (typeof declarations)[number]>();
  for (const item of declarations) {
    if (!item.label) continue;
    if (labels.has(item.label)) {
      fail(
        'K4-BLOCK-SOURCE-DUPLICATE-001',
        `Source label is duplicated: ${JSON.stringify(item.label)}`,
        {
          targetName: item.targetName,
          blockId: item.hatId,
        },
      );
    }
    labels.set(item.label, item);
  }
  const numbered = [...labels.keys()].sort();
  const sources: Map<string, string> = new Map();
  for (const item of declarations) {
    item.sourcePath =
      item === entry || !item.label
        ? sourcePathForTargetName(item.targetName)
        : `blocks-${String(numbered.indexOf(item.label) + 1).padStart(4, '0')}${sourceSuffix}`;
    if (
      declarations.some(
        (other) =>
          other !== item &&
          other.sourcePath &&
          other.sourcePath.normalize('NFC').toLowerCase() ===
            item.sourcePath.normalize('NFC').toLowerCase(),
      )
    ) {
      fail('K4-BLOCK-SOURCE-DUPLICATE-001', 'DSL source filename is duplicated', {
        targetName: item.targetName,
        blockId: item.hatId,
      });
    }
  }
  const edges = new Map<string, {path: string; blockId: string}[]>();
  for (const item of declarations) {
    const {blocks, hat, hatId, sourcePath, targetName} = item;
    if (sources.has(sourcePath)) {
      fail('K4-BLOCK-SOURCE-DUPLICATE-001', 'DSL source filename is duplicated', {
        targetName,
      });
    }
    const first = typeof hat.next === 'string' ? blocks[hat.next] : undefined;
    let sourceText: string;
    try {
      sourceText =
        item.labeled || (isRecord(first) && isDsl4StructuredSourceOpcode(first.opcode))
          ? readDsl4StructuredBlockSource(
              blocks,
              hatId,
              (input) => {
                if (!Array.isArray(input) || input.length < 2 || ![1, 2, 3].includes(input[0])) {
                  fail('K4-BLOCK-SOURCE-GRAPH-001', 'Structured source input is missing');
                }
                const literal = input[1];
                if (
                  Array.isArray(literal) &&
                  !scalarInputTypes.has(literal[0]) &&
                  ![10, 11].includes(literal[0])
                ) {
                  fail(
                    'K4-BLOCK-SOURCE-GRAPH-001',
                    'Structured source requires a literal, not a dynamic variable or list',
                  );
                }
                if (typeof literal === 'string' && !isRecord(blocks[literal])) {
                  fail('K4-BLOCK-SOURCE-GRAPH-001', 'Structured source reporter is missing', {
                    blockId: literal,
                  });
                }
                // Preserve blank optional number fields instead of coercing them to zero.
                const value = Array.isArray(literal)
                  ? literal[1]
                  : inputValue(blocks, input, limits, new Set(), 0);
                if (
                  typeof value !== 'string' &&
                  typeof value !== 'number' &&
                  typeof value !== 'boolean'
                ) {
                  fail('K4-BLOCK-SOURCE-GRAPH-001', 'Structured source input must be a scalar');
                }
                boundedScalar(value, limits);
                return value;
              },
              {
                entry: item === entry,
                resolveInclude(blockId) {
                  const include = blocks[blockId] as Record<string, unknown>;
                  const label = staticText(
                    blocks,
                    (include.inputs as Record<string, unknown>).LABEL,
                    blockId,
                    targetName,
                  );
                  const resolved = labels.get(label);
                  if (!label || !resolved) {
                    fail(
                      'K4-BLOCK-SOURCE-LABEL-001',
                      `includeBlocks label is empty or missing: ${JSON.stringify(label)}`,
                      {targetName, blockId},
                    );
                  }
                  const outgoing = edges.get(sourcePath) ?? [];
                  outgoing.push({path: resolved.sourcePath, blockId});
                  edges.set(sourcePath, outgoing);
                  return resolved.sourcePath;
                },
              },
            )
          : sourceTextFromCommand(blocks, hat.next as string, limits);
    } catch (error) {
      if (error instanceof Dsl4BlockSourceError) {
        throw new Dsl4BlockSourceError(error.code, error.message, {
          targetName,
          blockId: error.blockId ?? hatId,
          cause: error,
        });
      }
      throw error;
    }
    sources.set(sourcePath, sourceText);
  }
  // Check every label, including unused modules, so a detached module cannot hide a cycle.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(path: string) {
    if (visited.has(path)) return;
    visiting.add(path);
    for (const edge of edges.get(path) ?? []) {
      if (visiting.has(edge.path)) {
        const item = declarations.find((candidate) => candidate.sourcePath === path)!;
        fail('K4-BLOCK-SOURCE-CYCLE-001', 'includeBlocks contains a self reference or cycle', {
          targetName: item.targetName,
          blockId: edge.blockId,
        });
      }
      visit(edge.path);
    }
    visiting.delete(path);
    visited.add(path);
  }
  for (const item of declarations) visit(item.sourcePath);
  return deepFreeze({
    formatVersion: 1,
    entryPath: entry.sourcePath,
    sources: Object.fromEntries([...sources].sort(([left], [right]) => (left < right ? -1 : 1))),
    sourceLocations: Object.fromEntries(
      declarations.map((item) => [
        item.sourcePath,
        {
          targetName: item.targetName,
          blockId: item.hatId,
        },
      ]),
    ),
  });
}
