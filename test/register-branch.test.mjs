import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import {loadKamishibaiProject} from './helpers/sb3-project.mjs';

const project = loadKamishibaiProject();
const stage = project.targets.find((target) => target.isStage);
const relatedDocumentation = [
  '03-user-guide.md',
  '04-dsl-manual.md',
  '05-command-reference.md',
  '01-executive-summary-adult.md',
].map((filename) => ({
  filename,
  source: readFileSync(new URL(`../docs/general/${filename}`, import.meta.url), 'utf8'),
}));

function literalString(input) {
  const value = input?.[1];
  return Array.isArray(value) && value[0] === 10 ? String(value[1]) : undefined;
}

function referencedBlockId(input) {
  return input?.slice(1).find((value) => typeof value === 'string');
}

function findProcedureCall(proccode) {
  const entry = Object.entries(stage.blocks).find(
    ([, block]) => block.opcode === 'procedures_call' && block.mutation?.proccode === proccode,
  );
  assert(entry, `Procedure call not found: ${proccode}`);
  return {id: entry[0], block: entry[1]};
}

function loadRuntimeExpression(runtimeVariables) {
  const extensionUrl = project.extensionURLs.kubohiroyaruntimeexpression;
  assert.match(extensionUrl, /^data:text\/javascript;base64,/u);
  const source = Buffer.from(extensionUrl.split(',', 2)[1], 'base64').toString('utf8');
  let extension;
  const runtime = {
    ext_lmsTempVars2: {
      getRuntimeVariable: ({VAR}) => runtimeVariables.get(VAR),
      runtimeVariableExists: ({VAR}) => runtimeVariables.has(VAR),
      setRuntimeVariable: ({VAR}, value) => runtimeVariables.set(VAR, value),
    },
    on: () => {},
  };
  const Scratch = {
    ArgumentType: {NUMBER: 'number', STRING: 'string'},
    BlockType: {BOOLEAN: 'boolean', COMMAND: 'command'},
    extensions: {
      register: (registeredExtension) => {
        extension = registeredExtension;
      },
      unsandboxed: true,
    },
    translate: (value) => value,
    vm: {runtime},
  };

  vm.runInNewContext(source, {Scratch, performance}, {filename: 'RuntimeExpression.js'});
  assert(extension, 'Runtime Expression extension did not register itself.');
  return extension;
}

test('preserves every character after the first top-level equals sign', () => {
  const {block: execCommandCall} = findProcedureCall('exec command %s %s');
  const valueAssignment = stage.blocks[execCommandCall.parent];
  assert.equal(valueAssignment.opcode, 'lmsTempVars2_setThreadVariable');
  assert.equal(literalString(valueAssignment.inputs.VAR), 'value');

  const valueReporter = stage.blocks[referencedBlockId(valueAssignment.inputs.STRING)];
  assert.equal(valueReporter.opcode, 'procedures_call');
  assert.equal(valueReporter.mutation.proccode, 'substr of %s after %s');

  const argumentIds = JSON.parse(valueReporter.mutation.argumentids);
  const sourceReporter = stage.blocks[referencedBlockId(valueReporter.inputs[argumentIds[0]])];
  assert.equal(sourceReporter.opcode, 'lmsTempVars2_getThreadVariable');
  assert.equal(literalString(sourceReporter.inputs.VAR), 'keyValue');
  assert.equal(literalString(valueReporter.inputs[argumentIds[1]]), '=');
});

test('evaluates equality comparisons used by registerBranch conditions', () => {
  const runtimeExpression = loadRuntimeExpression(
    new Map([
      ['score', '1'],
      ['state', 'ready'],
    ]),
  );

  assert.equal(runtimeExpression.runtimeCondition({EXPRESSION: 'score == 1'}), true);
  assert.equal(runtimeExpression.runtimeCondition({EXPRESSION: 'score != 2'}), true);
  assert.equal(runtimeExpression.runtimeCondition({EXPRESSION: 'state === "ready"'}), true);
  assert.equal(runtimeExpression.runtimeCondition({EXPRESSION: 'state !== "closed"'}), true);
  assert.throws(
    () => runtimeExpression.runtimeCondition({EXPRESSION: 'score = 1'}),
    /Unexpected character/u,
  );
});

test('documents equality comparisons as supported syntax', () => {
  for (const {filename, source} of relatedDocumentation) {
    assert.doesNotMatch(
      source,
      /条件式内の等価比較は避け|`=`[^\n]*(?:なるべく避け|使うのが安全)/u,
      `${filename} still discourages equals signs without matching the implementation.`,
    );
  }

  for (const filename of ['04-dsl-manual.md', '05-command-reference.md']) {
    const source = relatedDocumentation.find((document) => document.filename === filename).source;
    for (const operator of ['==', '!=', '===', '!==']) {
      assert(source.includes(`\`${operator}\``), `${filename} does not document ${operator}.`);
    }
    assert.match(source, /最初の `=`/u);
    assert.match(source, /registerBranch=.*==/u);
  }
});
