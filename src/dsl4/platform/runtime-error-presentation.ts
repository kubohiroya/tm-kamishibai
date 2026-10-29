import {diagnosticText, runtimeErrorCauses} from '../runtime-error-context.js';

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const actionNames: Readonly<Record<string, readonly [string, string]>> = {
  stage: ['背景を変える', 'Change backdrop'],
  bgm: ['BGMを再生する', 'Play BGM'],
  stopBgm: ['BGMを止める', 'Stop BGM'],
  setBgmVolume: ['BGMの音量を変える', 'Change BGM volume'],
  audio: ['音声を再生する', 'Play audio'],
  audioControl: ['音声を操作する', 'Control audio'],
  video: ['動画を再生する', 'Play video'],
  videoControl: ['動画を操作する', 'Control video'],
  transition: ['場面を切り替える', 'Transition'],
  gotoSegment: ['別の章へ移動する', 'Go to segment'],
  setVariable: ['変数の値を設定する', 'Set variable'],
  changeVariable: ['変数の値を変える', 'Change variable'],
  toggleVariable: ['変数を切り替える', 'Toggle variable'],
  keyInputToChangeScene: ['キー入力で場面を選ぶ', 'Choose scene by key'],
  touchInputToChangeScene: ['タッチで場面を選ぶ', 'Choose scene by touch'],
  setTransparency: ['透明度を変える', 'Change transparency'],
  moveTo: ['移動する', 'Move'],
  setSkin: ['見た目を変える', 'Change costume'],
  setLayer: ['重なり順を変える', 'Change layer'],
  loop: ['見た目を繰り返す', 'Loop costumes'],
  setText: ['文字を設定する', 'Set text'],
  broadcastMessageAndWait: ['メッセージを送って待つ', 'Broadcast and wait'],
  debugger: ['デバッグで停止する', 'Pause for debugging'],
  backdrop: ['背景を変える', 'Change backdrop'],
  setBackdrop: ['背景を変える', 'Change backdrop'],
  show: ['表示する', 'Show'],
  hide: ['隠す', 'Hide'],
  say: ['セリフを表示する', 'Say'],
  think: ['心の声を表示する', 'Think'],
  wait: ['待つ', 'Wait'],
  goto: ['場面へ移動する', 'Go to scene'],
  branch: ['条件で場面を選ぶ', 'Choose scene'],
  pose: ['ポーズを認識する', 'Recognize pose'],
  poseInputToChangeScene: ['ポーズで場面を選ぶ', 'Choose scene by pose'],
  imageInputToChangeScene: ['画像で場面を選ぶ', 'Choose scene by image'],
  playSound: ['音を再生する', 'Play sound'],
  sound: ['音を再生する', 'Play sound'],
  playVideo: ['動画を再生する', 'Play video'],
};

function pathParts(value: unknown): string[] {
  const path = diagnosticText(value);
  if (path.startsWith('$')) {
    return [...path.matchAll(/\.([^.[\]]+)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]/gu)].map(
      (match) => match[1] ?? match[2] ?? match[3] ?? '',
    );
  }
  if (!path.startsWith('/')) return [];
  return path
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

export function runtimeErrorPlace(diagnostic: Record<string, unknown>, locale: 'ja' | 'en') {
  const ja = locale === 'ja';
  const context = record(diagnostic.failureContext);
  const parts = pathParts(diagnostic.storyPath ?? diagnostic.path);
  const sceneId =
    diagnosticText(context.sceneId) || (parts[0] === 'scenes' ? (parts[1] ?? '') : '');
  const indexText = parts[2] === 'actions' ? parts[3] : parts[2];
  const actionIndex =
    Number.isSafeInteger(context.actionIndex) && Number(context.actionIndex) >= 0
      ? Number(context.actionIndex)
      : indexText !== undefined && /^\d+$/u.test(indexText)
        ? Number(indexText)
        : null;
  const command = diagnosticText(context.command);
  const action = actionNames[command]?.[ja ? 0 : 1] ?? command;
  const target = diagnosticText(diagnostic.targetName);
  const block = diagnosticText(diagnostic.blockName);
  const asset =
    diagnosticText(context.assetId ?? diagnostic.assetId) ||
    (parts[0] === 'assets' ? (parts[1] ?? '') : '');
  const field = diagnostic.validation ? pathParts(diagnostic.path).at(-1) : '';
  const location = [
    target ? (ja ? `ステージ／スプライト「${target}」` : `Stage / sprite “${target}”`) : '',
    sceneId ? (ja ? `場面「${sceneId}」` : `Scene “${sceneId}”`) : '',
    actionIndex === null
      ? ''
      : ja
        ? `${actionIndex + 1}番目の処理${action ? `「${action}」` : ''}`
        : `Action ${actionIndex + 1}${action ? `: ${action}` : ''}`,
    block ? (ja ? `ブロック「${block}」` : `Block “${block}”`) : '',
    asset ? (ja ? `素材「${asset}」` : `Asset “${asset}”`) : '',
    field && !/^\d+$/u.test(field) ? (ja ? `確認する項目「${field}」` : `Field “${field}”`) : '',
  ].filter(Boolean);
  return location.join(' → ');
}

export function createRuntimeErrorPresentation(
  diagnostic: Record<string, unknown>,
  locale: 'ja' | 'en',
) {
  const ja = locale === 'ja';
  const code = diagnosticText(diagnostic.diagnosticCode ?? diagnostic.code);
  const outerCode = diagnosticText(diagnostic.code);
  const context = record(diagnostic.failureContext);
  const causes = Array.isArray(context.causes)
    ? context.causes.slice(0, 6).map(record)
    : runtimeErrorCauses(diagnostic);
  const names = [diagnostic.name, ...causes.map((cause) => cause.name)];
  const codes = [outerCode, code, ...causes.map((cause) => diagnosticText(cause.code))];
  let title = ja ? '紙芝居を続けられませんでした' : 'The story could not continue';
  let explanation = ja ? '原因を特定できませんでした。' : 'The cause could not be determined.';
  let recovery = ja
    ? '分かっている場所を確認してください。解決しない場合は「診断情報をコピー」で情報を取得し、制作者に相談してください。'
    : 'Check the location below. If the problem persists, copy the diagnostic information and contact the author.';
  const choose = (
    titles: readonly [string, string],
    explanations: readonly [string, string],
    recoveries: readonly [string, string],
  ) => {
    title = titles[ja ? 0 : 1];
    explanation = explanations[ja ? 0 : 1];
    recovery = recoveries[ja ? 0 : 1];
  };
  const cameraOperation =
    /^(?:pose|poseInputToChangeScene|imageInputToChangeScene|camera)$/u.test(
      String(context.command),
    ) || codes.some((value) => /CAMERA|POSE-PORT/u.test(value));
  if (
    (cameraOperation && names.includes('NotAllowedError')) ||
    codes.includes('K4-CAMERA-PERMISSION-DENIED')
  ) {
    choose(
      ['カメラの利用が許可されませんでした', 'Camera access was not allowed'],
      [
        'カメラの許可またはブラウザの利用制限により、開始できませんでした。',
        'The camera could not start because of permissions or browser restrictions.',
      ],
      [
        'ブラウザのサイト設定でカメラの許可を確認してください。学校・組織の端末では管理者への確認が必要な場合があります。',
        'Check camera permission in the browser’s site settings. Managed devices may require help from an administrator.',
      ],
    );
  } else if (
    names.some((name) =>
      ['NotFoundError', 'NotReadableError', 'OverconstrainedError'].includes(String(name)),
    ) &&
    cameraOperation
  ) {
    choose(
      ['カメラを開始できませんでした', 'The camera could not start'],
      [
        'カメラの接続または利用条件を満たせませんでした。',
        'The camera was unavailable or could not meet the requested settings.',
      ],
      [
        'カメラの接続と選択を確認し、他のアプリで使用中なら終了してください。',
        'Check the camera connection and selection, and close other apps using it.',
      ],
    );
  } else if (code === 'K4-ASSET-REMOTE-DISABLED') {
    choose(
      [
        'このプレビューではリモート素材を読み込めません',
        'Remote assets are unavailable in this preview',
      ],
      [
        'ローカルプレビューは、この素材のリモート配信に対応していません。',
        'Local preview does not support remote delivery for this asset.',
      ],
      [
        'プレビュー中は素材をローカル配信に切り替えるか、build-dsl4でビルドした作品で確認してください。',
        'Use local delivery while previewing, or build the story with build-dsl4 to test remote delivery.',
      ],
    );
  } else if (codes.some((value) => /K4-ASSET-(?:MISSING|PROJECT-MISSING)/u.test(value))) {
    choose(
      ['必要な素材が見つかりません', 'A required asset was not found'],
      [
        '台本で指定された素材を読み込めませんでした。',
        'An asset referenced by the script could not be loaded.',
      ],
      [
        '素材名、登録したファイル、台本の参照先が一致しているか確認してください。',
        'Check that the asset name, registered file and script reference match.',
      ],
    );
  } else if (code.startsWith('K4-ASSET') || code.startsWith('K4-POSENET')) {
    choose(
      ['素材を準備できませんでした', 'An asset could not be prepared'],
      [
        '素材の読込または検証に失敗しました。詳しい原因は技術的な詳細で確認できます。',
        'Loading or validating an asset failed. See the technical details for the reported cause.',
      ],
      [
        '該当素材のファイル・配信先・対応形式を確認してください。再読込だけで直らない場合は診断情報を制作者に渡してください。',
        'Check the asset file, delivery location and format. If reloading does not help, send the diagnostics to the author.',
      ],
    );
  } else if (code === 'K4-SOURCE-MISSING') {
    choose(
      ['台本ファイルが見つかりません', 'The script file was not found'],
      [
        '作品が参照している台本ファイルを開けませんでした。',
        'A script file referenced by the project could not be opened.',
      ],
      [
        '表示したファイルが選択したフォルダ内に存在するか、ファイル名と参照先が一致しているか確認してください。',
        'Check that the indicated file exists in the selected folder and that its name matches the reference.',
      ],
    );
  } else if (code.startsWith('K4-EXPRESSION')) {
    choose(
      ['式を処理できませんでした', 'An expression could not be processed'],
      [
        '条件式または値を求める式の検証・評価に失敗しました。',
        'Validating or evaluating an expression failed.',
      ],
      [
        '該当箇所の変数名、値の型、演算子を確認してください。詳しい検証結果は技術的な詳細で確認できます。',
        'Check variable names, value types and operators at the indicated location. See the technical details for the reported failure.',
      ],
    );
  } else if (code.startsWith('K4-YAML')) {
    choose(
      ['台本の書き方を確認してください', 'Check the script syntax'],
      ['台本をYAMLとして読み取れませんでした。', 'The script could not be read as YAML.'],
      [
        '表示した行の前後で、字下げ、コロン、引用符、括弧の対応を確認してください。',
        'Check indentation, colons, quotes and matching brackets around the indicated line.',
      ],
    );
  } else if (
    record(diagnostic.validation).keyword ||
    code.startsWith('K4-SCHEMA') ||
    code === 'K4-NARRATIVE-SOURCE-001'
  ) {
    const validation = record(diagnostic.validation);
    const field = diagnosticText(validation.field);
    const expected = diagnosticText(validation.expected);
    choose(
      ['台本の項目を確認してください', 'Check the script fields'],
      [
        '台本の項目や値が、使える形式に合っていません。',
        'A script field or value does not match the supported format.',
      ],
      [
        '表示した箇所の項目名と値を確認してください。英語の検証結果は技術的な詳細で確認できます。',
        'Check the field name and value at the indicated location. The original validation result is in the technical details.',
      ],
    );
    if (validation.alternative === true) {
      explanation = ja
        ? 'この記述は、対応する形式のいずれにも一致しません。'
        : 'This entry does not match any of the supported formats.';
      recovery = ja
        ? '該当ブロックまたは台本の項目と値の組合せを確認してください。技術的な詳細は候補形式ごとの検証結果であり、すべてを同時に満たす指示ではありません。'
        : 'Check the fields and values in the indicated block or script. Technical details list failures for alternative formats; they are not instructions to satisfy every alternative.';
    } else if (validation.keyword === 'required' && field) {
      explanation = ja
        ? `必須項目「${field}」がありません。`
        : `The required field “${field}” is missing.`;
      recovery = ja
        ? `表示した箇所に「${field}」を追加してください。`
        : `Add “${field}” at the indicated location.`;
    } else if (validation.keyword === 'additionalProperties' && field) {
      explanation = ja
        ? `項目「${field}」は、この場所では使えません。`
        : `The field “${field}” is not supported here.`;
      recovery = ja
        ? `「${field}」の綴りと記述する場所を確認してください。`
        : `Check the spelling and location of “${field}”.`;
    } else if (validation.keyword === 'type' && expected) {
      const types: Record<string, string> = {
        string: '文字列',
        number: '数値',
        integer: '整数',
        boolean: 'trueまたはfalse',
        array: '一覧',
        object: '項目の組',
      };
      explanation = ja
        ? `この値には${types[expected] ?? expected}を指定する必要があります。`
        : `This value must be of type ${expected}.`;
    }
  } else if (
    code.startsWith('K4-REF') ||
    code.startsWith('K4-RUNTIME-SCENE') ||
    code.startsWith('K4-RUNTIME-BRANCH')
  ) {
    choose(
      ['台本の参照先を確認してください', 'Check the script reference'],
      [
        '指定された場面・素材・定義などの参照先を解決できませんでした。',
        'A referenced scene, asset or definition could not be resolved.',
      ],
      [
        '表示した処理の参照名と、対応する定義が存在するか確認してください。',
        'Check the reference name and whether the matching definition exists.',
      ],
    );
  } else if (outerCode.startsWith('K4-BLOCK-SOURCE')) {
    choose(
      ['台本のブロックを確認してください', 'Check the script block'],
      [
        '台本として読み取れないブロックまたは接続が含まれています。',
        'A block or connection could not be read as part of the script.',
      ],
      [
        '該当ブロックと接続を確認してください。台本用の対応ブロックを使用してください。',
        'Check the indicated block and its connections. Use blocks supported by the script.',
      ],
    );
  } else if (code.startsWith('K4-HOST-') || code === 'K4-RUNTIME-PORT-001') {
    choose(
      ['この実行環境では処理を実行できません', 'This environment cannot run the operation'],
      [
        '必要な機能が不足しているか、実行環境の設定に問題があります。',
        'A required capability is missing or the runtime configuration is invalid.',
      ],
      [
        '対応する実行環境か制作者に確認してください。「診断情報をコピー」で調査用の情報を渡せます。',
        'Ask the author to check runtime compatibility. Copy the diagnostics to help investigate.',
      ],
    );
  } else if (codes.some((value) => /KVS_|SESSION_BINARY/u.test(value))) {
    choose(
      ['一時保存した素材を利用できません', 'Temporary asset storage is unavailable'],
      [
        'ブラウザの一時ストレージで問題が発生しました。',
        'A problem occurred in temporary browser storage.',
      ],
      [
        '技術的な詳細に表示したストレージの案内を確認してください。解決しない場合は診断情報を制作者に渡してください。',
        'Follow the storage guidance in the technical details. If the problem persists, send the diagnostics to the author.',
      ],
    );
    if (typeof diagnostic.message === 'string') recovery = diagnosticText(diagnostic.message);
  }
  const place = runtimeErrorPlace(diagnostic, locale);
  const range = record(diagnostic.range);
  const start = record(range.start);
  const source = diagnosticText(diagnostic.displayName ?? diagnostic.sourceId);
  const file = source && source !== 'main' ? source : '';
  const position =
    Number.isSafeInteger(start.line) && Number(start.line) > 0
      ? ja
        ? `${start.line}行${Number(start.column) > 0 ? ` ${start.column}列` : ''}`
        : `line ${start.line}${Number(start.column) > 0 ? `, column ${start.column}` : ''}`
      : '';
  const generated = diagnostic.generatedSource === true || Boolean(diagnostic.blockId);
  const sourcePlace = file
    ? `${generated ? (ja ? '生成台本: ' : 'Generated script: ') : ''}${file}${position ? ` (${position})` : ''}`
    : '';
  return {
    title,
    explanation,
    impact: ja
      ? 'このエラーにより、紙芝居の開始または再生を中断しました。'
      : 'This error interrupted starting or playing the story.',
    recovery,
    place:
      [place, sourcePlace].filter(Boolean).join('\n') ||
      (ja ? '発生箇所を特定できませんでした。' : 'The location could not be determined.'),
    generated,
  };
}

export function formatRuntimeErrorReport(
  diagnostic: Record<string, unknown>,
  locale: 'ja' | 'en',
  runtimeVersion = '',
) {
  const presentation = createRuntimeErrorPresentation(diagnostic, locale);
  const context = record(diagnostic.failureContext);
  const start = record(record(diagnostic.range).start);
  const causes = Array.isArray(context.causes)
    ? context.causes.slice(0, 6).map(record)
    : runtimeErrorCauses(diagnostic);
  const fields: [string, unknown][] = [
    ['Version', runtimeVersion],
    ['Code', diagnostic.code],
    ['Original code', diagnostic.diagnosticCode],
    ['Message', diagnostic.message],
    ['Location', presentation.place],
    ['Source', diagnostic.displayName ?? diagnostic.sourceId],
    ['Line', start.line],
    ['Column', start.column],
    ['Path', diagnostic.path],
    ['Story path', diagnostic.storyPath],
    ['Phase', diagnostic.phase],
    ['Block', diagnostic.blockId],
    ['Opcode', diagnostic.blockOpcode],
    ['Alternative format', record(diagnostic.validation).alternative === true ? 'yes' : ''],
    [
      'Validation',
      diagnostic.validation
        ? ['keyword', 'field', 'expected']
            .map((key) => `${key}=${diagnosticText(record(diagnostic.validation)[key], 160)}`)
            .join(', ')
        : '',
    ],
    ...causes.map((cause, index): [string, unknown] => [
      `Cause ${index + 1}`,
      [cause.name, cause.code, cause.message].filter(Boolean).join(': '),
    ]),
    ...(Array.isArray(context.cleanupCauses)
      ? context.cleanupCauses.slice(0, 6).map((cause, index): [string, unknown] => [
          `Cleanup ${index + 1}`,
          [record(cause).name, record(cause).code, record(cause).message]
            .map((part) => diagnosticText(part, 500))
            .filter(Boolean)
            .join(': '),
        ])
      : []),
  ];
  return [
    presentation.title,
    ...fields
      .map(([label, value]) => {
        const text = diagnosticText(value);
        return text ? `${label}: ${text}` : '';
      })
      .filter(Boolean),
  ].join('\n');
}
