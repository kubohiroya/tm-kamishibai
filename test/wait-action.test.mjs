import assert from 'node:assert/strict';
import test from 'node:test';

import {loadKamishibaiProject} from './helpers/sb3-project.mjs';

const project = loadKamishibaiProject();

function referencedBlockIds(input) {
  return input?.slice(1).filter((value) => typeof value === 'string') ?? [];
}

function literalString(input) {
  const value = input?.[1];
  return Array.isArray(value) && value[0] === 10 ? String(value[1]) : undefined;
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
    for (const block of Object.values(target.blocks)) {
      if (block.opcode !== 'procedures_definition') {
        continue;
      }
      const prototypeId = referencedBlockIds(block.inputs.custom_block)[0];
      if (target.blocks[prototypeId]?.mutation?.proccode === proccode) {
        return {target, block};
      }
    }
  }
  throw new Error(`Procedure not found: ${proccode}`);
}

function inputBlock(target, block, inputName) {
  return target.blocks[referencedBlockIds(block.inputs[inputName])[0]];
}

test('waits until the count-up timer reaches the requested duration', () => {
  const {target, block} = findProcedure('wait %s seconds');
  const blocks = descendants(target, block.next);

  assert(
    [...blocks.values()].some(
      (candidate) =>
        candidate.opcode === 'lmsTimers_startResetTimer' &&
        literalString(candidate.inputs.TIMER) === 'timer',
    ),
    'The wait action does not reset its timer to zero before waiting.',
  );
  assert.equal(
    [...blocks.values()].filter((candidate) => candidate.opcode === 'lmsTimers_setTimer').length,
    0,
    'The wait action sets an initial value that start/reset immediately discards.',
  );

  const loop = [...blocks.values()].find((candidate) => candidate.opcode === 'control_while');
  assert(loop, 'The wait action loop is missing.');
  const conditionBlocks = descendants(target, referencedBlockIds(loop.inputs.CONDITION)[0]);
  const durationComparison = [...conditionBlocks.values()].find(
    (candidate) =>
      candidate.opcode === 'operator_lt' &&
      inputBlock(target, candidate, 'OPERAND1')?.opcode === 'lmsTimers_valueOfTimer' &&
      inputBlock(target, candidate, 'OPERAND2')?.opcode === 'argument_reporter_string_number' &&
      inputBlock(target, candidate, 'OPERAND2')?.fields.VALUE?.[0] === 'seconds',
  );
  assert(durationComparison, 'The wait action does not continue while timer < requested seconds.');
  assert.equal(
    [...conditionBlocks.values()].filter((candidate) => candidate.opcode === 'operator_gt').length,
    0,
    'The wait action still uses the invalid timer > 0 continuation condition.',
  );
});

test('keeps scene-change and skip guards and removes the timer', () => {
  const {target, block} = findProcedure('wait %s seconds');
  const blocks = descendants(target, block.next);
  const loop = [...blocks.values()].find((candidate) => candidate.opcode === 'control_while');
  assert(loop, 'The wait action loop is missing.');
  const conditionBlocks = descendants(target, referencedBlockIds(loop.inputs.CONDITION)[0]);

  for (const variableName of ['nextSceneLabel', 'skipMode']) {
    assert(
      [...conditionBlocks.values()].some((candidate) => {
        if (candidate.opcode !== 'operator_not') {
          return false;
        }
        const exists = inputBlock(target, candidate, 'OPERAND');
        return (
          exists?.opcode === 'lmsTempVars2_runtimeVariableExists' &&
          literalString(exists.inputs.VAR) === variableName
        );
      }),
      `The wait action does not stop when ${variableName} exists.`,
    );
  }

  assert(
    [...blocks.values()].some(
      (candidate) =>
        candidate.opcode === 'lmsTimers_removeTimer' &&
        literalString(candidate.inputs.TIMER) === 'timer',
    ),
    'The wait action does not remove its timer after completion.',
  );
});
