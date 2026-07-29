import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {generalDocumentConfig} from '../docs/config.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

const [
  projectSource,
  specification,
  developerGuide,
  docsIndex,
  stateDiagram,
  actorCloneSequence,
  scriptExecutionSequence,
] = await Promise.all([
  readFile(path.join(projectRoot, 'app/project.source.json'), 'utf8').then(JSON.parse),
  readFile(path.join(projectRoot, 'docs/general/07-internal-specification.md'), 'utf8'),
  readFile(path.join(projectRoot, 'docs/general/06-developer-guide.md'), 'utf8'),
  readFile(path.join(projectRoot, 'site/docs/index.html'), 'utf8'),
  readFile(path.join(projectRoot, 'docs/images/internal-state-transition.svg'), 'utf8'),
  readFile(path.join(projectRoot, 'docs/images/internal-actor-clone-sequence.svg'), 'utf8'),
  readFile(path.join(projectRoot, 'docs/images/internal-script-execution-sequence.svg'), 'utf8'),
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
  assert.match(docsIndex, /general\/07-internal-specification\//u);
  assert.match(docsIndex, /general\/07-internal-specification\.pdf/u);
  assert.match(stateDiagram, /<title id="title">紙芝居アプリの主要状態遷移<\/title>/u);
});

test('provides the terminology before the numbered specification', () => {
  const glossary = specification.match(
    /^## この文書で使う用語 \{#terminology \.unnumbered\}$(?<body>[\s\S]*?)(?=^## 文書の範囲と実装基準$)/mu,
  )?.groups?.body;

  assert(glossary, 'Internal specification is missing its terminology.');
  assert(
    specification.indexOf('## この文書で使う用語 {#terminology .unnumbered}') <
      specification.indexOf('## 文書の範囲と実装基準'),
  );
  assert.match(
    glossary,
    /表中の等幅書体（`Stage`、`script`、`action=`など）は、target名、変数名、DSL記法として\s*実装に現れる正確な綴り/u,
  );
  assert.match(glossary, /通常書体の用語は、概念または分類名/u);
  assert.match(glossary, /^### Scratch／TurboWarpのproject構造$/mu);
  assert.match(glossary, /^### cloneとActor$/mu);
  assert.match(glossary, /^### 紙芝居DSLと実行$/mu);
  assert.match(glossary, /^### 変数とblock$/mu);
  for (const term of [
    'project',
    'SB3',
    'target',
    '`Stage`',
    'sprite',
    'clone',
    '`Actor` target／アクタースプライト',
    'アクター',
    'asset',
    '紙芝居DSL／台本ファイル',
    '`script`',
    'scene',
    'command',
    'action',
    'action envelope',
    'message／broadcast',
    'Scratch変数／list',
    'runtime variable',
    'thread variable',
    'event hat／hat block',
    'カスタムブロック',
    'block ID',
  ]) {
    assert(glossary.includes(`| ${term}`), `Terminology is missing ${term}.`);
  }
  assert.match(glossary, /`Stage`\s+\| projectに1つだけある舞台のtarget/u);
  assert.match(glossary, /`Actor` targetから作られ、`actorName`で区別/u);
  assert.match(glossary, /Actor actionの宛先、command、引数/u);
});

test('defines Stage before listing the SB3 targets', () => {
  const sectionIntroduction = specification.match(
    /^## SB3の構成 \{#sb3-structure\}$(?<body>[\s\S]*?)(?=^### target一覧$)/mu,
  )?.groups?.body;

  assert(sectionIntroduction, 'Internal specification is missing the section 4 introduction.');
  assert.match(sectionIntroduction, /1つの\*\*Stage（ステージ）\*\* target/u);
  assert.match(sectionIntroduction, /背景（backdrop）を表示/u);
  assert.match(sectionIntroduction, /Stage自身にblock、variable、listを持てます/u);
  assert.match(
    sectionIntroduction,
    /座標を変えて動かしたり、\s*cloneを作ったりする対象ではありません/u,
  );
  assert.match(sectionIntroduction, /Stage targetを舞台の表示だけでなく、紙芝居全体の制御役/u);
  assert.match(sectionIntroduction, /台本の読込・解析、assetとactorの生成/u);
  assert.match(sectionIntroduction, /このStage targetとそこに置かれた\s*制御用block群を指します/u);
});

test('explains the actor command architecture and asset separation', () => {
  const section = specification.match(
    /^### アクターへ命令を届けるしくみ \{#actor-message-delivery\}$(?<body>[\s\S]*?)(?=^### target間の責務$)/mu,
  )?.groups?.body;

  assert(section, 'Internal specification is missing the actor architecture overview.');
  assert.match(section, /`Actor` targetを\*\*アクタースプライト\*\*/u);
  assert.match(section, /`actorName`を割り当てられた各cloneを\*\*アクター\*\*/u);
  for (const variable of ['actionTarget', 'actionCommand', 'actionParam', 'actionParam2']) {
    assert(section.includes(`\`${variable}\``), `Actor overview is missing ${variable}.`);
  }
  assert.match(section, /`execActorAction`をbroadcast/u);
  assert.match(section, /自分の`actorName`が`actionTarget`の\s*対象に含まれるか/u);
  assert.match(
    section,
    /\[TurboWarp Asset Manager\]\(https:\/\/github\.com\/kubohiroya\/turbowarp-asset-manager\)/u,
  );
  assert.match(section, /アクタースプライトと、実際に使う画像・音声を分けて/u);
  assert.match(section, /紙芝居DSLを解析・実行する処理系/u);
  assert.match(section, /実行基盤\s*（runtime）/u);
  assert.match(
    section,
    /!\[台本ファイルからアクターでの命令実行までのシーケンス\]\(\.\.\/images\/internal-script-execution-sequence\.svg\)/u,
  );
  assert.match(section, /Stage actionはStage内で実行され/u);
  assert.match(
    section,
    /Actor actionでは、Stageが`actionTarget`、\s*`actionCommand`、`actionParam`、`actionParam2`へaction envelopeを書き込んでから/u,
  );
  assert.match(section, /messageを受信した各`Actor` cloneは4変数を読み/u);

  assert.match(
    scriptExecutionSequence,
    /<title id="title">台本ファイルからアクターでの命令実行までのシーケンス<\/title>/u,
  );
  for (const diagram of [actorCloneSequence, scriptExecutionSequence]) {
    assert.match(diagram, />Stage内の<\/text>/u);
    assert.match(diagram, />\s*list・runtime variable\s*<\/text>/u);
    assert.match(diagram, />Actor target<\/text>/u);
    assert.match(diagram, />／clone群<\/text>/u);
  }
  for (const variable of ['actionTarget', 'actionCommand', 'actionParam', 'actionParam2']) {
    assert(
      scriptExecutionSequence.includes(variable),
      `Actor action sequence is missing ${variable}.`,
    );
  }
  assert.match(
    scriptExecutionSequence,
    /aria-label="action envelopeの4つのruntime variableへ書き込む"/u,
  );
  assert.match(
    scriptExecutionSequence,
    /aria-label="Actor cloneがaction envelopeの4つのruntime variableを読む"/u,
  );
  const stepIds = [...scriptExecutionSequence.matchAll(/<g id="(step-[^"]+)"/gu)].map(
    ([, id]) => id,
  );
  assert.deepEqual(stepIds, [
    'step-file-script',
    'step-script-scene-list',
    'step-scene-list-scene',
    'step-scene-command-list',
    'step-command-list-command',
    'step-command-action-list',
    'step-action-list-action',
    'step-parse-actor-action',
    'step-set-action-envelope',
    'step-broadcast-actor-action',
    'step-actor-receive',
    'step-actor-read-envelope',
    'step-actor-process',
  ]);
});

test('documents actor clone creation before actor action delivery', () => {
  const section = specification.match(
    /^#### 台本からアクターclone生成までのシーケンス$(?<body>[\s\S]*?)(?=^#### 台本からActor actionまでのシーケンス$)/mu,
  )?.groups?.body;

  assert(section, 'Internal specification is missing the actor clone sequence.');
  assert.match(
    section,
    /!\[台本のactor定義からアクターcloneを生成するシーケンス\]\(\.\.\/images\/internal-actor-clone-sequence\.svg\)/u,
  );
  assert.match(section, /`actor=`の値を`actorList`へ追加/u);
  assert.match(section, /`アクター名,初期skin名`/u);
  assert.match(section, /thread variableの`name`と`skin`へ分け/u);
  assert.match(section, /`actionTarget`へ`name`、`actionParam`へ`skin`を設定/u);
  assert.match(section, /`Actor` targetのclone/u);
  assert.match(
    section,
    /スプライトローカル変数`actorName`へ保存し、\s*`actionParam`をTurboWarp Asset Managerへ渡して初期skin/u,
  );
  assert.match(section, /0\.1秒待ち/u);
  assert.match(section, /共有runtime variableを次の\s*アクター用の値で上書き/u);
  assert.match(section, /clone生成時には`execActorAction`をbroadcastしません/u);
  assert.match(section, /`Actor` target本体はcloneの雛形として非表示/u);
  assert.match(section, /生成直後も非表示/u);
  assert.match(section, /後続のActor action/u);

  assert.match(
    actorCloneSequence,
    /<title id="title">台本のactor定義からアクターcloneを生成するシーケンス<\/title>/u,
  );
  const stepIds = [...actorCloneSequence.matchAll(/<g id="(step-[^"]+)"/gu)].map(([, id]) => id);
  assert.deepEqual(stepIds, [
    'step-actor-command-register',
    'step-create-actor-loop',
    'step-split-actor-definition',
    'step-set-clone-initializers',
    'step-create-actor-clone',
    'step-clone-start',
    'step-clone-read-name',
    'step-clone-set-skin',
    'step-wait-before-next-actor',
  ]);
  assert(
    actorCloneSequence.indexOf('<rect class="activation" x="877"') <
      actorCloneSequence.indexOf('<text class="frame-label"'),
    'The actorList loop label must render in front of the activation bars.',
  );

  const stage = projectSource.targets.find(({isStage}) => isStage);
  const actor = projectSource.targets.find(({name}) => name === 'Actor');
  const stageBlocks = Object.values(stage.blocks);
  const actorBlocks = Object.values(actor.blocks);

  assert(
    stageBlocks.some(
      (block) => block.opcode === 'data_addtolist' && block.fields?.LIST?.[0] === 'actorList',
    ),
    'Stage does not register actor commands in actorList.',
  );
  const createClone = stageBlocks.find(
    (block) =>
      block.opcode === 'control_create_clone_of' &&
      stage.blocks[inputBlockId(block.inputs?.CLONE_OPTION)]?.fields?.CLONE_OPTION?.[0] === 'Actor',
  );
  assert(createClone, 'Stage does not create Actor clones.');

  const setActionParam = stage.blocks[createClone.parent];
  const setActionTarget = stage.blocks[setActionParam.parent];
  const cloneWait = stage.blocks[createClone.next];
  assert.equal(setActionTarget.opcode, 'lmsTempVars2_setRuntimeVariable');
  assert.equal(literalString(setActionTarget.inputs?.VAR), 'actionTarget');
  assert.equal(setActionParam.opcode, 'lmsTempVars2_setRuntimeVariable');
  assert.equal(literalString(setActionParam.inputs?.VAR), 'actionParam');
  assert.equal(cloneWait.opcode, 'control_wait');
  assert.deepEqual(cloneWait.inputs?.DURATION, [1, [5, '0.1']]);

  assert.equal(actor.visible, false);
  const cloneStart = actorBlocks.find((block) => block.opcode === 'control_start_as_clone');
  const setActorName = actor.blocks[cloneStart.next];
  const setInitialSkin = actor.blocks[setActorName.next];
  assert.equal(setActorName.opcode, 'data_setvariableto');
  assert.equal(setActorName.fields?.VARIABLE?.[0], 'actorName');
  assert.equal(
    actor.blocks[inputBlockId(setActorName.inputs?.VALUE)]?.inputs?.VAR?.[1]?.[1],
    'actionTarget',
  );
  assert.equal(setInitialSkin.opcode, 'kubohiroyaassetmanager_setThisSpriteSkin');
  assert.equal(
    actor.blocks[inputBlockId(setInitialSkin.inputs?.NAME)]?.inputs?.VAR?.[1]?.[1],
    'actionParam',
  );
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

test('explains block IDs and uses consistent section 6 table vocabulary', () => {
  const section = specification.match(
    /^## event、カスタムブロック、呼出し関係 \{#events-custom-blocks-call-graph\}$(?<body>[\s\S]*?)(?=^## broadcastと状態遷移$)/mu,
  )?.groups?.body;

  assert(section, 'Internal specification is missing section 6.');
  assert.match(section, /`ID`はそのtargetの`blocks`\s*objectにあるkey/u);
  assert.match(section, /`project\.json`の`targets\[\]\.blocks`/u);
  assert.match(section, /buildとimportはblock IDを新規採番せず/u);
  assert.match(section, /削除と再作成、複製やcopy & paste/u);
  assert.match(section, /外部仕様、永続ID、他の版をまたぐ\s*参照には使いません/u);
  assert.doesNotMatch(section, /(?:直接|直後)の(?:下流|呼出し)/u);

  const tableHeaders = section
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.includes('---'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  const eventHeaders = tableHeaders.filter((cells) => cells.includes('trigger'));
  assert.equal(eventHeaders.length, 3);
  for (const header of eventHeaders) {
    assert.deepEqual(header, ['target', 'ID', 'trigger', '実行される内容']);
  }

  const customBlockHeaders = tableHeaders.filter((cells) => cells.includes('定義'));
  assert.equal(customBlockHeaders.length, 4);
  for (const header of customBlockHeaders) {
    assert.deepEqual(header, [
      'target',
      'ID',
      '定義',
      '引数',
      'warp',
      '呼び出す処理／送信するmessage',
    ]);
  }
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
