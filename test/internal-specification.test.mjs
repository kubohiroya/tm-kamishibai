import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {generalDocumentConfig} from '../docs/config.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

const [projectSource, specification, developerGuide, docsIndex, stateDiagram] = await Promise.all([
  readFile(path.join(projectRoot, 'app/project.source.json'), 'utf8').then(JSON.parse),
  readFile(path.join(projectRoot, 'docs/general/07-internal-specification.md'), 'utf8'),
  readFile(path.join(projectRoot, 'docs/general/06-developer-guide.md'), 'utf8'),
  readFile(path.join(projectRoot, 'site/docs/index.html'), 'utf8'),
  readFile(path.join(projectRoot, 'docs/images/internal-state-transition.svg'), 'utf8'),
]);

const normalizedSpecification = specification.replaceAll('&#96;', '`').replaceAll('&#124;', '|');

function literalString(input) {
  const value = input?.[1];
  return Array.isArray(value) && value[0] === 10 && typeof value[1] === 'string'
    ? value[1]
    : undefined;
}

function inputBlockId(input) {
  return Array.isArray(input) && typeof input[1] === 'string' ? input[1] : undefined;
}

function assertCodeValue(value, label) {
  assert(
    normalizedSpecification.includes(`\`${value}\``) ||
      normalizedSpecification.includes(`<code>${value}</code>`),
    `Internal specification is missing ${label}: ${value}`,
  );
}

test('publishes the internal specification as a general HTML/PDF document', () => {
  const document = generalDocumentConfig.documents.find(
    ({sourceFilename}) => sourceFilename === '07-internal-specification.md',
  );

  assert.equal(document?.title, '紙芝居アプリ内部仕様書');
  assert.match(specification, /^# 紙芝居アプリ内部仕様書$/mu);
  assert.match(specification, /\[CC BY-SA 4\.0\]/u);
  assert.match(developerGuide, /\[紙芝居アプリ内部仕様書\]\(07-internal-specification\.md\)/u);
  assert.doesNotMatch(developerGuide, /^## 2\. 成果物プロファイル$/mu);
  assert.match(docsIndex, /general\/07-internal-specification\.html/u);
  assert.match(docsIndex, /general\/07-internal-specification\.pdf/u);
  assert.match(stateDiagram, /<title id="title">紙芝居アプリの主要状態遷移<\/title>/u);
});

test('documents invalidScript as a terminal error instead of a pose transition', () => {
  const invalidScriptSenders = projectSource.targets.flatMap((target) =>
    Object.entries(target.blocks ?? {})
      .filter(
        ([, block]) =>
          block.opcode === 'event_broadcast' &&
          JSON.stringify(block.inputs?.BROADCAST_INPUT).includes('"invalidScript"'),
      )
      .map(([id, block]) => ({id, block, target})),
  );

  assert.equal(invalidScriptSenders.length, 3);
  for (const {id, block, target} of invalidScriptSenders) {
    const stopBlock = target.blocks[block.next];
    assert.equal(
      stopBlock?.opcode,
      'control_stop',
      `${target.name}:${id} is not followed by stop.`,
    );
    assert.equal(stopBlock.fields?.STOP_OPTION?.[0], 'all');
  }

  const prompt = projectSource.targets.find(({name}) => name === 'prompt');
  const receiver = Object.values(prompt.blocks).find(
    (block) =>
      block.opcode === 'event_whenbroadcastreceived' &&
      block.fields?.BROADCAST_OPTION?.[0] === 'invalidScript',
  );
  const setErrorSkin = prompt.blocks[receiver.next];
  const showPrompt = prompt.blocks[setErrorSkin.next];

  assert.equal(setErrorSkin.opcode, 'kubohiroyaassetmanager_setThisSpriteSkin');
  assert.match(JSON.stringify(setErrorSkin.inputs?.NAME), /ui\.invalidScript/u);
  assert.equal(showPrompt.opcode, 'looks_show');

  assert.match(stateDiagram, /<g id="state-script-error" aria-label="台本エラー表示・実行停止">/u);
  assert.match(
    stateDiagram,
    /<g id="transition-invalid-script-from-preparation" aria-label="台本準備から台本エラー表示・実行停止">/u,
  );
  assert.match(
    stateDiagram,
    /<g id="transition-invalid-script-from-scene" aria-label="シーン実行から台本エラー表示・実行停止">/u,
  );
  assert.match(specification, /`invalidScript`はpose待機への遷移ではありません/u);
  assert.match(
    specification,
    /\| 台本エラー表示・実行停止\s+\| 台本・command・scene解析エラー時の`invalidScript`/u,
  );
});

test('keeps the implementation snapshot aligned with the current SB3 source', () => {
  const blocks = projectSource.targets.flatMap((target) => Object.entries(target.blocks ?? {}));
  const eventHats = blocks.filter(
    ([, block]) =>
      block.topLevel === true &&
      block.parent === null &&
      (block.opcode.startsWith('event_') || block.opcode === 'control_start_as_clone'),
  );
  const procedureDefinitions = blocks.filter(
    ([, block]) => block.opcode === 'procedures_definition',
  );
  const scratchVariables = projectSource.targets.flatMap((target) =>
    Object.values(target.variables ?? {}),
  );
  const scratchLists = projectSource.targets.flatMap((target) => Object.values(target.lists ?? {}));
  const broadcasts = new Set(
    projectSource.targets.flatMap((target) => Object.values(target.broadcasts ?? {})),
  );
  const runtimeVariableNames = new Set();
  const threadVariableNames = new Set();

  for (const [, block] of blocks) {
    const variableName = literalString(block.inputs?.VAR);
    if (variableName === undefined) continue;
    if (
      block.opcode.includes('RuntimeVariable') ||
      block.opcode === 'lmsTempVars2_runtimeVariableExists'
    ) {
      runtimeVariableNames.add(variableName);
    }
    if (block.opcode.includes('ThreadVariable')) {
      threadVariableNames.add(variableName);
    }
  }

  const expectedCounts = new Map([
    ['target（Stageを含む）', projectSource.targets.length],
    ['block', blocks.length],
    ['event hat', eventHats.length],
    ['カスタムブロック定義', procedureDefinitions.length],
    ['Scratch変数', scratchVariables.length],
    ['Scratch list', scratchLists.length],
    ['broadcast message', broadcasts.size],
    ['静的なruntime variable名', runtimeVariableNames.size],
    ['静的なthread variable名', threadVariableNames.size],
    ['TurboWarp機能拡張', projectSource.extensions.length],
  ]);

  for (const [label, count] of expectedCounts) {
    assert.match(
      specification,
      new RegExp(
        `\\| ${label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*\\|\\s*${count}\\s*\\|`,
        'u',
      ),
      `Internal specification has a stale ${label} count.`,
    );
  }
});

test('lists every target, variable, list, extension, message, hat, and custom block', () => {
  for (const target of projectSource.targets) {
    assertCodeValue(target.name, 'target');
    for (const [, variableName] of Object.values(target.variables ?? {})) {
      assertCodeValue(variableName, 'Scratch variable');
    }
    for (const [listName] of Object.values(target.lists ?? {})) {
      assertCodeValue(listName, 'Scratch list');
    }
  }

  for (const extensionId of projectSource.extensions) {
    assertCodeValue(extensionId, 'extension');
  }

  const broadcasts = new Set(
    projectSource.targets.flatMap((target) => Object.values(target.broadcasts ?? {})),
  );
  for (const broadcast of broadcasts) {
    assertCodeValue(broadcast, 'broadcast message');
  }

  for (const target of projectSource.targets) {
    for (const [blockId, block] of Object.entries(target.blocks ?? {})) {
      const isEventHat =
        block.topLevel === true &&
        block.parent === null &&
        (block.opcode.startsWith('event_') || block.opcode === 'control_start_as_clone');
      if (isEventHat) {
        assertCodeValue(blockId, `${target.name} event hat`);
      }

      if (block.opcode === 'procedures_definition') {
        const prototypeId = inputBlockId(block.inputs?.custom_block);
        const proccode = target.blocks[prototypeId]?.mutation?.proccode;
        assertCodeValue(blockId, `${target.name} custom block definition`);
        assertCodeValue(proccode, `${target.name} custom block proccode`);
      }
    }
  }
});

test('lists every statically named runtime and thread variable', () => {
  const namesByKind = new Map([
    ['runtime', new Set()],
    ['thread', new Set()],
  ]);

  for (const target of projectSource.targets) {
    for (const block of Object.values(target.blocks ?? {})) {
      const variableName = literalString(block.inputs?.VAR);
      if (variableName === undefined) continue;
      if (
        block.opcode.includes('RuntimeVariable') ||
        block.opcode === 'lmsTempVars2_runtimeVariableExists'
      ) {
        namesByKind.get('runtime').add(variableName);
      }
      if (block.opcode.includes('ThreadVariable')) {
        namesByKind.get('thread').add(variableName);
      }
    }
  }

  for (const [kind, names] of namesByKind) {
    for (const name of names) {
      assertCodeValue(name, `${kind} variable`);
    }
  }

  assert.match(specification, /`branch:<branchName>`/u);
  assert.match(specification, /DSLで指定されたruntime variable名を動的に設定/u);
});
