import assert from 'node:assert/strict';
import test from 'node:test';

import {loadKamishibaiProject} from './helpers/sb3-project.mjs';

const project = loadKamishibaiProject();

function literalString(input) {
  const value = input?.[1];
  return Array.isArray(value) && value[0] === 10 ? String(value[1]) : undefined;
}

function referencedBlockIds(input) {
  return input?.slice(1).filter((value) => typeof value === 'string') ?? [];
}

function runtimeVariableName(block) {
  return literalString(block?.inputs?.VAR);
}

function allBlockEntries() {
  return project.targets.flatMap((target) =>
    Object.entries(target.blocks).map(([id, block]) => ({
      target,
      id,
      block,
    })),
  );
}

function descendants(target, rootId) {
  const result = new Map();
  const pending = [rootId];

  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || result.has(id)) {
      continue;
    }
    const block = target.blocks[id];
    if (!block) {
      continue;
    }
    result.set(id, block);
    pending.push(block.next);
    for (const input of Object.values(block.inputs ?? {})) {
      pending.push(...referencedBlockIds(input));
    }
  }

  return result;
}

function findProcedure(proccode) {
  for (const target of project.targets) {
    for (const [id, block] of Object.entries(target.blocks)) {
      if (block.opcode !== 'procedures_definition') {
        continue;
      }
      const prototypeId = referencedBlockIds(block.inputs.custom_block)[0];
      if (target.blocks[prototypeId]?.mutation?.proccode === proccode) {
        return {target, id, block};
      }
    }
  }
  throw new Error(`Procedure not found: ${proccode}`);
}

function findKeyScript(key) {
  for (const target of project.targets) {
    for (const [id, block] of Object.entries(target.blocks)) {
      if (block.opcode === 'event_whenkeypressed' && block.fields.KEY_OPTION?.[0] === key) {
        return {target, id, block};
      }
    }
  }
  throw new Error(`Key script not found: ${key}`);
}

function skipModeAssignments(blocks) {
  return [...blocks.values()].filter(
    (block) =>
      block.opcode === 'lmsTempVars2_setRuntimeVariable' &&
      runtimeVariableName(block) === 'skipMode',
  );
}

function skipModeDeletions(blocks) {
  return [...blocks.values()].filter(
    (block) =>
      block.opcode === 'lmsTempVars2_deleteRuntimeVariable' &&
      runtimeVariableName(block) === 'skipMode',
  );
}

function collectStrings(value, result = []) {
  if (typeof value === 'string') {
    result.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      collectStrings(entry, result);
    }
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      collectStrings(entry, result);
    }
  }
  return result;
}

test('uses absence as the only idle skipMode state', () => {
  assert.equal(
    collectStrings(project).filter((value) => value === 'none').length,
    0,
    'The retired skipMode sentinel "none" remains in project.json.',
  );

  const assignments = allBlockEntries()
    .filter(
      ({block}) =>
        block.opcode === 'lmsTempVars2_setRuntimeVariable' &&
        runtimeVariableName(block) === 'skipMode',
    )
    .map(({block}) => literalString(block.inputs.STRING));
  assert.deepEqual([...new Set(assignments)].sort(), ['action', 'pose', 'scene', 'title']);
});

test('maps rehearsal keys to guarded skip requests', () => {
  const expectedAssignments = new Map([
    ['space', ['pose']],
    ['right arrow', ['action']],
    ['down arrow', ['scene']],
  ]);

  for (const [key, expected] of expectedAssignments) {
    const {target, block} = findKeyScript(key);
    const blocks = descendants(target, block.next);
    assert.deepEqual(
      skipModeAssignments(blocks).map((assignment) => literalString(assignment.inputs.STRING)),
      expected,
      `${key} does not map to the expected skipMode request.`,
    );
    assert(
      [...blocks.values()].some(
        (candidate) =>
          candidate.opcode === 'lmsTempVars2_runtimeVariableExists' &&
          runtimeVariableName(candidate) === 'skipMode',
      ),
      `${key} does not guard its request with a skipMode existence check.`,
    );
  }

  const spaceScript = findKeyScript('space');
  assert(
    skipModeDeletions(descendants(spaceScript.target, spaceScript.block.next)).length > 0,
    'Space does not clear title mode before showing the cover.',
  );
});

test('continues pose iteration only while skipMode is absent', () => {
  const {target, block} = findProcedure('exec pose action %s');
  const blocks = descendants(target, block.next);
  const poseLoop = [...blocks.values()].find((candidate) => candidate.opcode === 'control_while');
  assert(poseLoop, 'Pose action loop is missing.');

  const conditionId = referencedBlockIds(poseLoop.inputs.CONDITION)[0];
  const conditionBlocks = descendants(target, conditionId);
  assert(
    [...conditionBlocks.values()].some(
      (candidate) =>
        candidate.opcode === 'operator_not' &&
        referencedBlockIds(candidate.inputs.OPERAND).some(
          (id) =>
            target.blocks[id]?.opcode === 'lmsTempVars2_runtimeVariableExists' &&
            runtimeVariableName(target.blocks[id]) === 'skipMode',
        ),
    ),
    'Pose loop does not use "not exists(skipMode)" as its idle condition.',
  );
  assert.equal(
    [...conditionBlocks.values()].filter(
      (candidate) =>
        candidate.opcode === 'lmsTempVars2_getRuntimeVariable' &&
        runtimeVariableName(candidate) === 'skipMode',
    ).length,
    0,
    'Pose loop still compares the skipMode value instead of checking existence.',
  );
  assert(
    skipModeDeletions(blocks).length > 0,
    'Pose iteration does not return skipMode to the absent state.',
  );
});

test('clears skipMode at scene and cover boundaries', () => {
  for (const proccode of ['exec scene # %s with %s', 'show cover']) {
    const {target, block} = findProcedure(proccode);
    assert(
      skipModeDeletions(descendants(target, block.next)).length > 0,
      `${proccode} does not clear skipMode.`,
    );
  }
});
