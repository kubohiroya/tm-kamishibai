import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {createDsl4SourceFrontend} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = path.join(projectRoot, 'test', 'fixtures', 'dsl4');
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);

async function validateFixture(group, name) {
  const source = await readFile(path.join(fixtureRoot, group, name), 'utf8');
  return frontend.parse(source, {sourceId: name});
}

function semanticProjection(storyDocument) {
  return {
    assets: storyDocument.assets,
    scenes: storyDocument.scenes.map((scene) => ({
      id: scene.id,
      poseModel: scene.poseModel,
      actions: scene.actions.map(({command, target, args, stableId}) => ({
        command,
        target,
        args,
        ...(stableId ? {stableId} : {}),
      })),
    })),
  };
}

function assertDeepFrozen(value) {
  if (typeof value !== 'object' || value === null) return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test('the approved comprehensive DSL 4.0 example satisfies schema and semantics', async () => {
  const result = await validateFixture('valid', 'comprehensive.kamishibai.yaml');
  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, []);
  assertDeepFrozen(result.storyDocument);
  assert.equal(result.storyDocument.kind, 'StoryDocument');
  assert.equal(result.storyDocument.version, '4.0');
  assert.equal(result.storyDocument.metadata.sourceId, 'comprehensive.kamishibai.yaml');
  assert.deepEqual(
    result.storyDocument.scenes.map((scene) => scene.id),
    ['opening', 'rescue', 'seaRoute', 'ending'],
  );
  assert.equal(result.storyDocument.scenes[0].actions[2].id, '/scenes/opening/actions/2');
  assert.equal(result.storyDocument.scenes[0].actions[2].stableId, 'openingTitle');
  assert.ok(result.storyDocument.sourceMap['/scenes/opening/actions/2/args/text']);
  assert.deepEqual(result.storyDocument.poseRecognition.modelInitialization, {
    policy: 'latest-needed',
    parallel: false,
  });
  assert.deepEqual(result.storyDocument.poseRecognition.feedback, {mode: 'scratchMirror'});
  assert.deepEqual(result.storyDocument.poseRecognition.navigation, {allowSkip: false});
  assert.deepEqual(result.storyDocument.poseRecognition.preview, {mirroring: 'mirrored'});
  assert.equal(result.storyDocument.scenes[0].posePreview, null);
  assert.deepEqual(result.storyDocument.scenes[1].posePreview, {mirroring: 'unmirrored'});
  assert.equal(result.storyDocument.scenes[2].posePreview, null);
  assert.ok(result.storyDocument.sourceMap['/poseRecognition/feedback/mode']);
  assert.ok(result.storyDocument.sourceMap['/poseRecognition/modelInitialization/policy']);
  assert.ok(result.storyDocument.sourceMap['/poseRecognition/modelInitialization/parallel']);
  assert.ok(result.storyDocument.sourceMap['/poseRecognition/navigation/allowSkip']);
  assert.ok(result.storyDocument.sourceMap['/poseRecognition/preview/mirroring']);
  assert.ok(result.storyDocument.sourceMap['/scenes/rescue/posePreview/mirroring']);
});

test('normalizes transition defaults and per-scene or per-action overrides', () => {
  const result = frontend.parse(
    `
kamishibai: '4.0'
presentation:
  transitions:
    scene: 0
    backdrop: 0.4
    actorSkin: {effect: crossfade, seconds: 0.3, easing: linear}
    actorVisibility: {effect: cut}
audio:
  bgm:
    transition: 0.8
assets:
  Beach: backdrop
  HeroIdle: costume:Hero
  HeroHappy: costume:Hero
  OpeningSound: sound
actors: {Hero: HeroIdle}
scenes:
  opening:
    entryTransition: 0.5
    actions:
      - stage: {backdrop: Beach, transition: 0.2}
      - bgm: {sound: OpeningSound, transition: {effect: crossfade, seconds: 1, curve: linear}, restart: true}
      - Hero.show: {skin: HeroIdle, x: 0, y: 0, scale: 100, transition: 0.15}
      - Hero.setSkin: {skin: HeroHappy, transition: 0}
      - Hero.hide: {transition: {effect: crossfade, seconds: 0.25}}
`,
    {sourceId: 'transitions.kamishibai.yaml'},
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.storyDocument.presentation.transitions, {
    scene: {effect: 'cut'},
    backdrop: {effect: 'crossfade', seconds: 0.4, easing: 'easeInOut'},
    actorSkin: {effect: 'crossfade', seconds: 0.3, easing: 'linear'},
    actorVisibility: {effect: 'cut'},
  });
  assert.deepEqual(result.storyDocument.audio.bgm.transition, {
    effect: 'crossfade',
    seconds: 0.8,
    curve: 'equalPower',
  });
  assert.deepEqual(result.storyDocument.scenes[0].entryTransition, {
    effect: 'crossfade',
    seconds: 0.5,
    easing: 'easeInOut',
  });
  assert.deepEqual(
    result.storyDocument.scenes[0].actions.map((action) => action.args.transition),
    [
      {effect: 'crossfade', seconds: 0.2, easing: 'easeInOut'},
      {effect: 'crossfade', seconds: 1, curve: 'linear'},
      {effect: 'crossfade', seconds: 0.15, easing: 'easeInOut'},
      {effect: 'cut'},
      {effect: 'crossfade', seconds: 0.25, easing: 'easeInOut'},
    ],
  );
  for (const path of [
    '/presentation/transitions/scene',
    '/audio/bgm/transition',
    '/scenes/opening/entryTransition',
    '/scenes/opening/actions/1/args/transition/curve',
  ]) {
    assert.ok(result.storyDocument.sourceMap[path], path);
  }
});

test('rejects transition fields that belong to a different transition kind', () => {
  for (const source of [
    'presentation:\n  transitions:\n    scene: {effect: crossfade, seconds: 1, curve: linear}',
    'audio:\n  bgm:\n    transition: {effect: crossfade, seconds: 1, easing: linear}',
  ]) {
    const result = frontend.parse(`kamishibai: '4.0'\n${source}\nscenes:\n  opening: []\n`, {
      sourceId: 'invalid-transition.kamishibai.yaml',
    });
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(({code}) => code.startsWith('K4-SCHEMA')));
  }
});

test('normalizes compact and named broadcastMessageAndWait actions with exact message text', () => {
  const source = `
kamishibai: '4.0'
scenes:
  opening:
    - broadcastMessageAndWait: "Opening Effect"
    - broadcastMessageAndWait:
        message: "演出 メッセージ"
        stableId: broadcast-2
`;
  const result = frontend.parse(source, {sourceId: 'broadcast.kamishibai.yaml'});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(
    result.storyDocument.scenes[0].actions.map(({command, target, args, stableId}) => ({
      command,
      target,
      args,
      ...(stableId ? {stableId} : {}),
    })),
    [
      {
        command: 'broadcastMessageAndWait',
        target: null,
        args: {message: 'Opening Effect'},
      },
      {
        command: 'broadcastMessageAndWait',
        target: null,
        args: {message: '演出 メッセージ'},
        stableId: 'broadcast-2',
      },
    ],
  );
  assert.ok(result.storyDocument.sourceMap['/scenes/opening/actions/0/args/message']);
  assert.ok(result.storyDocument.sourceMap['/scenes/opening/actions/1/args/message']);
  assert.ok(result.storyDocument.sourceMap['/scenes/opening/actions/1/stableId']);

  for (const action of [
    '    - broadcastMessageAndWait: ""',
    '    - broadcastMessageAndWait: 1',
    '    - broadcastMessageAndWait: {message: ok, unexpected: true}',
    '    - broadcastMessageAndWait: {stableId: missing-message}',
  ]) {
    const invalid = frontend.parse(`kamishibai: '4.0'\nscenes:\n  opening:\n${action}\n`, {
      sourceId: 'story.kamishibai.yaml',
    });
    assert.equal(invalid.ok, false, action);
    const diagnostic = invalid.diagnostics.find(({code}) => code.startsWith('K4-SCHEMA'));
    assert.ok(diagnostic, action);
    assert.equal(diagnostic.sourceId, 'story.kamishibai.yaml');
    assert.equal(diagnostic.range.start.line, 4);
  }
});

test('normalizes the argument-free debugger action and rejects supplied arguments', () => {
  const result = frontend.parse(
    "kamishibai: '4.0'\nscenes:\n  opening:\n    - debugger:\n    - wait: 0\n",
    {sourceId: 'debugger.kamishibai.yaml'},
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(semanticProjection(result.storyDocument).scenes[0].actions[0], {
    command: 'debugger',
    target: null,
    args: {},
  });

  for (const sourceArguments of ['true', '{}', 'stop']) {
    const invalid = frontend.parse(
      `kamishibai: '4.0'\nscenes:\n  opening:\n    - debugger: ${sourceArguments}\n`,
      {sourceId: 'invalid-debugger.kamishibai.yaml'},
    );
    assert.equal(invalid.ok, false, sourceArguments);
    assert.ok(invalid.diagnostics.some(({code}) => code.startsWith('K4-SCHEMA')));
  }
});

test('normalizes say and think completion, typewriter, start sound, and source positions', () => {
  const source = `
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
  HeroVoice: sound
  TalkTick: sound
actors:
  Hero: HeroIdle
scenes:
  opening:
    - Hero.say:
        text: 時間で進む
        seconds: 2
    - Hero.say:
        text: 入力で進む
        waitFor: advance
    - Hero.think:
        stableId: thinking
        text: どちらか早い方
        seconds: 5
        waitFor: advance
        characterIntervalSeconds: 0.08
        startSound: HeroVoice
        characterSound: TalkTick
        noSoundCharacters: "「」"
        restCharacters: "、。…"
        restCharacterIntervalSeconds: 0.5
`;
  const result = frontend.parse(source, {sourceId: 'speech.kamishibai.yaml'});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(
    result.storyDocument.scenes[0].actions.map(({command, target, args, stableId}) => ({
      command,
      target,
      args,
      ...(stableId ? {stableId} : {}),
    })),
    [
      {command: 'say', target: 'Hero', args: {text: '時間で進む', seconds: 2}},
      {command: 'say', target: 'Hero', args: {text: '入力で進む', waitFor: 'advance'}},
      {
        command: 'think',
        target: 'Hero',
        args: {
          text: 'どちらか早い方',
          seconds: 5,
          waitFor: 'advance',
          characterIntervalSeconds: 0.08,
          startSound: 'HeroVoice',
          characterSound: 'TalkTick',
          noSoundCharacters: '「」',
          restCharacters: '、。…',
          restCharacterIntervalSeconds: 0.5,
        },
        stableId: 'thinking',
      },
    ],
  );
  for (const field of [
    'text',
    'seconds',
    'waitFor',
    'characterIntervalSeconds',
    'startSound',
    'characterSound',
    'noSoundCharacters',
    'restCharacters',
    'restCharacterIntervalSeconds',
  ]) {
    assert.ok(result.storyDocument.sourceMap[`/scenes/opening/actions/2/args/${field}`], field);
  }
  assert.ok(result.storyDocument.sourceMap['/scenes/opening/actions/2/stableId']);
});

test('normalizes named bubble close policies and rejects ambiguous completion', () => {
  const source = `
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
actors:
  Hero: HeroIdle
bubbleClosePolicies:
  three seconds:
    seconds: 3
  user advance:
    waitFor: advance
  advance or timeout:
    seconds: 10
    waitFor: advance
scenes:
  opening:
    - Hero.say:
        text: 時間で閉じる
        closePolicy: three seconds
    - Hero.say:
        text: 入力で閉じる
        closePolicy: user advance
    - Hero.think:
        text: 先に成立した方で閉じる
        closePolicy: advance or timeout
`;
  const result = frontend.parse(source, {sourceId: 'close-policy.kamishibai.yaml'});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.storyDocument.bubbleClosePolicies, {
    'three seconds': {seconds: 3},
    'user advance': {waitFor: 'advance'},
    'advance or timeout': {seconds: 10, waitFor: 'advance'},
  });
  assert.deepEqual(
    result.storyDocument.scenes[0].actions.map(({args}) => args),
    [
      {text: '時間で閉じる', closePolicy: 'three seconds'},
      {text: '入力で閉じる', closePolicy: 'user advance'},
      {text: '先に成立した方で閉じる', closePolicy: 'advance or timeout'},
    ],
  );
  for (const path of [
    '/bubbleClosePolicies',
    '/bubbleClosePolicies/three seconds',
    '/bubbleClosePolicies/three seconds/seconds',
    '/bubbleClosePolicies/user advance/waitFor',
    '/bubbleClosePolicies/advance or timeout/seconds',
    '/bubbleClosePolicies/advance or timeout/waitFor',
    '/scenes/opening/actions/0/args/closePolicy',
  ]) {
    assert.ok(result.storyDocument.sourceMap[path], path);
  }

  const missing = frontend.parse(
    source.replace('closePolicy: user advance', 'closePolicy: missing'),
  );
  assert.equal(missing.ok, false);
  assert.ok(
    missing.diagnostics.some(
      ({code, path}) =>
        code === 'K4-REF-001' && path === '$.scenes["opening"][1]["Hero.say"].closePolicy',
    ),
    JSON.stringify(missing.diagnostics),
  );

  for (const replacement of [
    '        closePolicy: three seconds\n        seconds: 3',
    '        closePolicy: three seconds\n        waitFor: advance',
  ]) {
    const ambiguous = frontend.parse(
      source.replace('        closePolicy: three seconds', replacement),
    );
    assert.equal(ambiguous.ok, false, replacement);
    assert.ok(ambiguous.diagnostics.some(({code}) => code.startsWith('K4-SCHEMA')));
  }

  for (const replacement of [
    '  three seconds: {}',
    '  three seconds: {seconds: 3, unexpected: true}',
    '  " three seconds": {seconds: 3}',
  ]) {
    const invalid = frontend.parse(source.replace('  three seconds:\n    seconds: 3', replacement));
    assert.equal(invalid.ok, false, replacement);
  }
});

test('normalizes and composes reusable bubble styles with human-readable names', () => {
  const source = `
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
  TalkTick: sound
  WrongTick: backdrop
  Next1:
    kind: image
    file: ui/next-1.png
  Next2:
    kind: image
    file: ui/next-2.png
actors:
  Hero: HeroIdle
bubbleStyles:
  Novel base:
    characterIntervalSeconds: 0.08
    noSoundCharacters: "「」"
  日本語 効果音:
    characterSound: TalkTick
    restCharacters: "、。…"
    restCharacterIntervalSeconds: 0.5
    continueIndicator:
      frames: [Next1, Next2]
      frameIntervalSeconds: 0.12
  Hero style:
    styles:
      - Novel base
      - 日本語 効果音
scenes:
  opening:
    - Hero.say:
        text: スタイルで進む。
        waitFor: advance
        styles:
          - Hero style
`;
  const result = frontend.parse(source, {sourceId: 'bubble-style.kamishibai.yaml'});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.storyDocument.bubbleStyles, {
    'Novel base': {
      characterIntervalSeconds: 0.08,
      noSoundCharacters: '「」',
    },
    '日本語 効果音': {
      characterSound: 'TalkTick',
      restCharacters: '、。…',
      restCharacterIntervalSeconds: 0.5,
      continueIndicator: {
        frames: ['Next1', 'Next2'],
        frameIntervalSeconds: 0.12,
      },
    },
    'Hero style': {
      styles: ['Novel base', '日本語 効果音'],
    },
  });
  assert.deepEqual(result.storyDocument.scenes[0].actions[0].args, {
    text: 'スタイルで進む。',
    waitFor: 'advance',
    styles: ['Hero style'],
  });
  for (const [style, fields] of [
    ['Novel base', ['characterIntervalSeconds', 'noSoundCharacters']],
    [
      '日本語 効果音',
      ['characterSound', 'restCharacters', 'restCharacterIntervalSeconds', 'continueIndicator'],
    ],
  ]) {
    for (const field of fields) {
      assert.ok(result.storyDocument.sourceMap[`/bubbleStyles/${style}/${field}`], field);
    }
  }
  assert.ok(result.storyDocument.sourceMap['/bubbleStyles/Hero style/styles']);
  assert.ok(result.storyDocument.sourceMap['/bubbleStyles/Hero style/styles/0']);
  assert.ok(result.storyDocument.sourceMap['/bubbleStyles/Hero style/styles/1']);
  assert.ok(result.storyDocument.sourceMap['/scenes/opening/actions/0/args/styles']);
  assert.ok(result.storyDocument.sourceMap['/scenes/opening/actions/0/args/styles/0']);
  assert.ok(
    result.storyDocument.sourceMap['/bubbleStyles/日本語 効果音/continueIndicator/frames/0'],
  );
  assert.ok(
    result.storyDocument.sourceMap['/bubbleStyles/日本語 効果音/continueIndicator/frames/1'],
  );
  assert.ok(
    result.storyDocument.sourceMap[
      '/bubbleStyles/日本語 効果音/continueIndicator/frameIntervalSeconds'
    ],
  );

  for (const [needle, replacement] of [
    ['      - 日本語 効果音', '      - missing'],
    ['      - 日本語 効果音', '      - Novel base'],
    ['          - Hero style', '          - missing'],
    ['    characterSound: TalkTick\n', ''],
    ['    characterSound: TalkTick', '    characterSound: WrongTick'],
    ['    restCharacterIntervalSeconds: 0.5\n', ''],
    ['      frames: [Next1, Next2]', '      frames: [Next1]'],
    ['      frameIntervalSeconds: 0.12', '      frameIntervalSeconds: 0'],
  ]) {
    const invalid = frontend.parse(source.replace(needle, replacement));
    assert.equal(invalid.ok, false, replacement);
  }

  for (const replacement of [
    '        style: Novel base',
    '        styles: Novel base',
    '        styles: []',
  ]) {
    const invalid = frontend.parse(
      source.replace('        styles:\n          - Hero style', replacement),
    );
    assert.equal(invalid.ok, false, replacement);
  }

  for (const invalidName of ['" Novel base"', '"Novel base "']) {
    const invalid = frontend.parse(source.replace('  Novel base:', `  ${invalidName}:`));
    assert.equal(invalid.ok, false, invalidName);
  }

  const missingSound = frontend.parse(
    source.replace('    characterSound: TalkTick', '    characterSound: MissingTick'),
  );
  assert.equal(missingSound.ok, false);
  assert.ok(
    missingSound.diagnostics.some(
      ({code, path}) =>
        code === 'K4-REF-001' && path === '$.bubbleStyles.日本語 効果音.characterSound',
    ),
    JSON.stringify(missingSound.diagnostics),
  );
});

test('rejects recursive bubble style composition', () => {
  const result = frontend.parse(`
kamishibai: '4.0'
bubbleStyles:
  style-a:
    styles:
      - style-b
  style-b:
    styles:
      - style-a
scenes:
  opening:
    - wait: 0
`);

  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(({code}) => code === 'K4-BUBBLE-STYLE-CYCLE-001'),
    JSON.stringify(result.diagnostics),
  );
});

test('accepts Bubble 0.4 wrapping, lip-sync, reveal, audio, and motion styles', () => {
  const source = `
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
  Face: {kind: image, file: face.png}
  Blink: {kind: image, file: blink.png}
  Lip1: {kind: image, file: lip1.png}
  Lip2: {kind: image, file: lip2.png}
  Next1: {kind: image, file: next1.png}
  Next2: {kind: image, file: next2.png}
  Voice: sound
  RevealTick: sound
  Finish: sound
actors:
  Hero: HeroIdle
textStyles:
  dialogue: {font: sans-serif}
bubbleStyles:
  cinematic:
    textStyle: dialogue
    maxWidth: 240
    textLocale: ja
    portrait:
      base: Face
      blink: {frames: [Blink], frameIntervalSeconds: 0.4}
      lipSync: {frames: [Lip1, Lip2], frameIntervalSeconds: 0.1}
    continueIndicator: {frames: [Next1, Next2], frameIntervalSeconds: 0.2}
    reveal:
      unit: CHARACTER
      delimiters: " /"
      showDelimiters: true
      layout: RESERVED
      intervalSeconds: 0.05
      sound: RevealTick
    audio: {voice: Voice, reveal: RevealTick, finish: Finish}
    showAnimation: {name: fadeIn, durationSeconds: 0.2, ease: easeOut}
    visibleAnimations:
      - {name: shake, direction: right, count: 2, ease: easeInOut}
      - {name: animateBubbleShape, visualStyle: YELLING, speed: 1.5, durationSeconds: 0.3}
    hideAnimation: {name: floatOut, direction: down, speed: 1}
scenes:
  opening:
    - Hero.say: {text: hello, waitFor: advance, styles: [cinematic]}
`;
  const result = frontend.parse(source, {sourceId: 'bubble-advanced.kamishibai.yaml'});

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.storyDocument.bubbleStyles.cinematic.audio, {
    voice: 'Voice',
    reveal: 'RevealTick',
    finish: 'Finish',
  });
  assert.deepEqual(result.storyDocument.bubbleStyles.cinematic.portrait.lipSync.frames, [
    'Lip1',
    'Lip2',
  ]);
  for (const path of [
    '/bubbleStyles/cinematic/maxWidth',
    '/bubbleStyles/cinematic/portrait/lipSync/frames/1',
    '/bubbleStyles/cinematic/reveal/sound',
    '/bubbleStyles/cinematic/audio/finish',
    '/bubbleStyles/cinematic/showAnimation/durationSeconds',
    '/bubbleStyles/cinematic/visibleAnimations/1/visualStyle',
  ]) {
    assert.ok(result.storyDocument.sourceMap[path], path);
  }

  const conflict = frontend.parse(
    source.replace('    reveal:\n', '    characterIntervalSeconds: 0.1\n    reveal:\n'),
  );
  assert.equal(conflict.ok, false);
  assert.ok(conflict.diagnostics.some(({code}) => code === 'K4-SPEECH-STYLE-002'));

  const duplicateVoice = frontend.parse(
    source.replace('waitFor: advance, styles:', 'waitFor: advance, startSound: Voice, styles:'),
  );
  assert.equal(duplicateVoice.ok, false);
  assert.ok(
    duplicateVoice.diagnostics.some(
      ({code, path}) => code === 'K4-SPEECH-STYLE-002' && path.endsWith('.startSound'),
    ),
  );

  const wrongAudioKind = frontend.parse(source.replace('finish: Finish', 'finish: Face'));
  assert.equal(wrongAudioKind.ok, false);
  assert.ok(
    wrongAudioKind.diagnostics.some(
      ({code, path}) => code === 'K4-REF-002' && path.endsWith('.audio.finish'),
    ),
  );
});

test('rejects pre-0.2 Bubble portrait and indicator field names', () => {
  for (const field of [
    '      talk: {frames: [Face], frameIntervalSeconds: 0.1}',
    '    advanceIndicator: {frames: [Face, Face], frameIntervalSeconds: 0.1}',
  ]) {
    const result = frontend.parse(`
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
  Face: {kind: image, file: face.png}
actors: {Hero: HeroIdle}
bubbleStyles:
  old:
    portrait:
      base: Face
${field}
scenes: {opening: [{Hero.say: {text: hello, seconds: 1, styles: [old]}}]}
`);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(({code}) => code === 'K4-SCHEMA-UNKNOWN-KEY'));
  }
});

test('accepts one-frame portrait animation but requires two continue indicator frames', () => {
  const source = `
kamishibai: '4.0'
assets:
  Face:
    kind: image
    file: face.svg
  Blink:
    kind: image
    file: blink.svg
  Next1:
    kind: image
    file: next-1.svg
  Next2:
    kind: image
    file: next-2.svg
bubbleStyles:
  novel:
    portrait:
      base: Face
      blink:
        frames: [Blink]
        frameIntervalSeconds: 0.4
    continueIndicator:
      frames: [Next1, Next2]
      frameIntervalSeconds: 0.2
scenes:
  opening: []
`;
  const result = frontend.parse(source, {sourceId: 'bubble-animation.kamishibai.yaml'});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

  const invalid = frontend.parse(source.replace('[Next1, Next2]', '[Next1]'));
  assert.equal(invalid.ok, false);
  assert.ok(
    invalid.diagnostics.some(
      ({code, path}) => code === 'K4-SCHEMA-001' && path.includes('continueIndicator/frames'),
    ),
    JSON.stringify(invalid.diagnostics),
  );
});

test('rejects the legacy speechStyles top-level key', () => {
  const result = frontend.parse(`
kamishibai: '4.0'
speechStyles:
  novel:
    characterIntervalSeconds: 0.08
scenes:
  opening:
    - wait: 0
`);

  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(({code, path}) => code === 'K4-SCHEMA-UNKNOWN-KEY' && path === '$'),
    JSON.stringify(result.diagnostics),
  );
});

test('rejects incomplete or malformed speech and non-sound speech assets', () => {
  const source = `
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
  TalkTick: sound
  WrongTick: backdrop
actors:
  Hero: HeroIdle
scenes:
  opening:
    - Hero.say:
        text: hello
        seconds: 1
`;
  const replacements = [
    ['        seconds: 1\n', ''],
    ['        seconds: 1', '        waitFor: click'],
    ['        seconds: 1', '        seconds: -1'],
    ['        seconds: 1', '        seconds: 1\n        characterIntervalSeconds: 0'],
    ['        seconds: 1', '        seconds: 1\n        characterSound: TalkTick'],
    [
      '        seconds: 1',
      '        seconds: 1\n        characterIntervalSeconds: 0.1\n        noSoundCharacters: "「」"',
    ],
    [
      '        seconds: 1',
      '        seconds: 1\n        characterIntervalSeconds: 0.1\n        restCharacters: "、。…"',
    ],
    [
      '        seconds: 1',
      '        seconds: 1\n        characterIntervalSeconds: 0.1\n        restCharacterIntervalSeconds: 0.5',
    ],
    [
      '        seconds: 1',
      '        seconds: 1\n        characterIntervalSeconds: 0.1\n        restCharacters: "、。…"\n        restCharacterIntervalSeconds: 0',
    ],
    [
      '        seconds: 1',
      '        seconds: 1\n        characterIntervalSeconds: 0.1\n        characterSound: TalkTick\n        noSoundCharacters: ""',
    ],
    ['        seconds: 1', '        seconds: 1\n        unexpected: true'],
  ];
  for (const [needle, replacement] of replacements) {
    const result = frontend.parse(source.replace(needle, replacement));
    assert.equal(result.ok, false, replacement);
    assert.ok(
      result.diagnostics.some(
        ({code}) => code.startsWith('K4-SCHEMA') || code === 'K4-SPEECH-STYLE-001',
      ),
      replacement,
    );
  }

  for (const characterSound of ['MissingTick', 'WrongTick']) {
    const result = frontend.parse(
      source.replace(
        '        seconds: 1',
        `        waitFor: advance\n        characterIntervalSeconds: 0.1\n        characterSound: ${characterSound}`,
      ),
    );
    assert.equal(result.ok, false, characterSound);
    assert.ok(
      result.diagnostics.some(
        ({code, storyPath}) =>
          code === (characterSound === 'MissingTick' ? 'K4-REF-001' : 'K4-REF-002') &&
          storyPath === '/scenes/opening/actions/0/args/characterSound',
      ),
      JSON.stringify(result.diagnostics),
    );
  }

  for (const startSound of ['MissingVoice', 'WrongTick']) {
    const result = frontend.parse(
      source.replace('        seconds: 1', `        seconds: 1\n        startSound: ${startSound}`),
    );
    assert.equal(result.ok, false, startSound);
    assert.ok(
      result.diagnostics.some(
        ({code, storyPath}) =>
          code === (startSound === 'MissingVoice' ? 'K4-REF-001' : 'K4-REF-002') &&
          storyPath === '/scenes/opening/actions/0/args/startSound',
      ),
      JSON.stringify(result.diagnostics),
    );
  }
});

test('accepts named moveTo easing values and rejects unsupported movement curves', () => {
  const source = `
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
actors:
  Hero: HeroIdle
scenes:
  opening:
    - Hero.moveTo: {x: 10, y: 20, seconds: 1}
    - Hero.moveTo: {x: 20, y: 30, seconds: 1, easing: linear}
    - Hero.moveTo: {x: 30, y: 40, seconds: 1, easing: easeIn}
    - Hero.moveTo: {x: 40, y: 50, seconds: 1, easing: easeOut}
    - Hero.moveTo: {x: 50, y: 60, seconds: 1, easing: easeInOut}
`;
  const valid = frontend.parse(source, {sourceId: 'move-easing.kamishibai.yaml'});
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));
  assert.deepEqual(
    valid.storyDocument.scenes[0].actions.map(({args}) => args.easing),
    [undefined, 'linear', 'easeIn', 'easeOut', 'easeInOut'],
  );
  assert.ok(valid.storyDocument.sourceMap['/scenes/opening/actions/4/args/easing']);

  for (const easing of ['ease-in', 'spring', true, 1]) {
    const invalid = frontend.parse(
      source.replace('easing: easeInOut', `easing: ${String(easing)}`),
      {sourceId: 'invalid-move-easing.kamishibai.yaml'},
    );
    assert.equal(invalid.ok, false, String(easing));
    assert.ok(invalid.diagnostics.some(({code}) => code.startsWith('K4-SCHEMA')));
  }
});

test('normalizes setTransparency as a direct 0 to 100 transparency value', () => {
  const source = (value) => `
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
actors:
  Hero: HeroIdle
scenes:
  opening:
    - Hero.setTransparency: ${value}
`;
  for (const transparency of [0, 50, 100]) {
    const result = frontend.parse(source(transparency), {sourceId: 'transparency.yaml'});
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(result.storyDocument.scenes[0].actions[0].args, {transparency});
    assert.ok(result.storyDocument.sourceMap['/scenes/opening/actions/0/args/transparency']);
  }

  const named = frontend.parse(source('\n        stableId: halfVisible\n        transparency: 50'));
  assert.equal(named.ok, true, JSON.stringify(named.diagnostics));
  assert.equal(named.storyDocument.scenes[0].actions[0].stableId, 'halfVisible');
  assert.deepEqual(named.storyDocument.scenes[0].actions[0].args, {transparency: 50});

  for (const invalid of [-1, 101, 'half', '{transparency: 50, extra: true}']) {
    const result = frontend.parse(source(invalid));
    assert.equal(result.ok, false, String(invalid));
    assert.ok(result.diagnostics.some(({code}) => code.startsWith('K4-SCHEMA')));
  }
});

test('normalizes foreground and background transparency transitions', () => {
  const source = (argumentsSource) => `
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
actors:
  Hero: HeroIdle
scenes:
  opening:
    - Hero.setTransparency:
${argumentsSource}
`;
  const foreground = frontend.parse(source('        from: 0\n        to: 50\n        seconds: 1'), {
    sourceId: 'foreground-transparency.yaml',
  });
  assert.equal(foreground.ok, true, JSON.stringify(foreground.diagnostics));
  assert.deepEqual(foreground.storyDocument.scenes[0].actions[0].args, {
    from: 0,
    to: 50,
    seconds: 1,
  });
  const explicitForeground = frontend.parse(
    source('        from: 0\n        to: 50\n        seconds: 1\n        background: false'),
  );
  assert.equal(explicitForeground.ok, true, JSON.stringify(explicitForeground.diagnostics));
  assert.equal(explicitForeground.storyDocument.scenes[0].actions[0].args.background, false);

  const background = frontend.parse(
    source(
      '        stableId: fadeHero\n        from: 0\n        to: 50\n        seconds: 1\n        background: true',
    ),
    {sourceId: 'background-transparency.yaml'},
  );
  assert.equal(background.ok, true, JSON.stringify(background.diagnostics));
  assert.equal(background.storyDocument.scenes[0].actions[0].stableId, 'fadeHero');
  assert.deepEqual(background.storyDocument.scenes[0].actions[0].args, {
    from: 0,
    to: 50,
    seconds: 1,
    background: true,
  });
  assert.ok(background.storyDocument.sourceMap['/scenes/opening/actions/0/args/from']);
  assert.ok(background.storyDocument.sourceMap['/scenes/opening/actions/0/args/to']);
  assert.ok(background.storyDocument.sourceMap['/scenes/opening/actions/0/args/seconds']);
  assert.ok(background.storyDocument.sourceMap['/scenes/opening/actions/0/args/background']);

  for (const invalid of [
    '        from: -1\n        to: 50\n        seconds: 1',
    '        from: 0\n        to: 101\n        seconds: 1',
    '        from: 0\n        to: 50\n        seconds: -1',
    '        from: 0\n        to: 50\n        seconds: 1\n        background: yes',
    '        from: 0\n        to: 50\n        seconds: 1\n        extra: true',
  ]) {
    const result = frontend.parse(source(invalid));
    assert.equal(result.ok, false, invalid);
    assert.ok(result.diagnostics.some(({code}) => code.startsWith('K4-SCHEMA')));
  }
});

test('normalizes pose policy defaults and rejects unknown keys, values, or types', () => {
  const base = [
    "kamishibai: '4.0'",
    'assets:',
    '  Tick: sound',
    '  Charge: sound',
    'poseRecognition:',
    '  idleSound: Tick',
    '  chargeSound: Charge',
    'scenes:',
    '  opening: []',
  ].join('\n');
  const valid = frontend.parse(base);
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));
  assert.deepEqual(valid.storyDocument.poseRecognition.feedback, {mode: 'scratchMirror'});
  assert.deepEqual(valid.storyDocument.poseRecognition.modelInitialization, {
    policy: 'legacy',
    parallel: false,
  });
  assert.deepEqual(valid.storyDocument.poseRecognition.navigation, {allowSkip: false});
  assert.deepEqual(valid.storyDocument.poseRecognition.preview, {mirroring: 'mirrored'});

  const silent = frontend.parse(
    [
      "kamishibai: '4.0'",
      'poseRecognition:',
      '  navigation:',
      '    allowSkip: true',
      'scenes:',
      '  opening: []',
    ].join('\n'),
  );
  assert.equal(silent.ok, true, JSON.stringify(silent.diagnostics));
  assert.equal(Object.hasOwn(silent.storyDocument.poseRecognition, 'idleSound'), false);
  assert.equal(Object.hasOwn(silent.storyDocument.poseRecognition, 'chargeSound'), false);

  const idleOnly = frontend.parse(base.replace('  chargeSound: Charge\n', ''));
  assert.equal(idleOnly.ok, true, JSON.stringify(idleOnly.diagnostics));
  assert.equal(idleOnly.storyDocument.poseRecognition.idleSound, 'Tick');
  assert.equal(Object.hasOwn(idleOnly.storyDocument.poseRecognition, 'chargeSound'), false);

  for (const policy of [
    ['feedback', '    mode: hidden\n'],
    ['modelInitialization', '    policy: newest\n'],
    ['modelInitialization', '    policy: latest-needed\n    parallel: yes\n'],
    ['modelInitialization', '    policy: legacy\n    extra: true\n'],
    ['feedback', '    mode: presenter\n    extra: true\n'],
    ['navigation', '    allowSkip: yes\n'],
    ['navigation', '    allowSkip: false\n    extra: true\n'],
    ['preview', '    mirroring: reversed\n'],
    ['preview', '    mirroring: mirrored\n    extra: true\n'],
    ['preview', '    mirroring: true\n'],
  ]) {
    const source = base.replace('scenes:', `  ${policy[0]}:\n${policy[1]}scenes:`);
    const result = frontend.parse(source);
    assert.equal(result.ok, false, source);
    assert.ok(result.diagnostics.some(({code}) => code.startsWith('K4-SCHEMA')));
  }
});

test('normalizes a scene pose preview override and maps its source position', () => {
  const source = [
    "kamishibai: '4.0'",
    'assets:',
    '  Tick: sound',
    '  Charge: sound',
    'poseRecognition:',
    '  idleSound: Tick',
    '  chargeSound: Charge',
    '  preview:',
    '    mirroring: unmirrored',
    'scenes:',
    '  opening:',
    '    posePreview:',
    '      mirroring: mirrored',
    '    actions: []',
    '  reset: []',
  ].join('\n');
  const valid = frontend.parse(source, {sourceId: 'pose-preview.kamishibai.yaml'});
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));
  assert.deepEqual(valid.storyDocument.poseRecognition.preview, {mirroring: 'unmirrored'});
  assert.deepEqual(valid.storyDocument.scenes[0].posePreview, {mirroring: 'mirrored'});
  assert.equal(valid.storyDocument.scenes[1].posePreview, null);
  assert.equal(
    valid.storyDocument.sourceMap['/scenes/opening/posePreview/mirroring'].start.line,
    13,
  );

  for (const replacement of [
    '      mirroring: reversed',
    '      mirroring: [mirrored]',
    '      mirroring: mirrored\n      extra: true',
  ]) {
    const invalid = frontend.parse(source.replace('      mirroring: mirrored', replacement), {
      sourceId: 'invalid-pose-preview.kamishibai.yaml',
    });
    assert.equal(invalid.ok, false, replacement);
    assert.ok(invalid.diagnostics.some(({code}) => code.startsWith('K4-SCHEMA')));
    assert.ok(invalid.diagnostics.every(({range}) => range.start.line > 0));
  }
});

test('normalizes pose overlay styles and confidence controls with source ranges', () => {
  const source = `
kamishibai: '4.0'
poseRecognition:
  preview:
    mirroring: mirrored
    overlay:
      visible: true
      jointStyles:
        leftWrist:
          color: '#ff00aa'
          opacity: 0.8
          radius: 6
        rightWrist:
          radius: 7
      boneStyle:
        color: '#00e5ff'
        width: 4
      minimumConfidence: 0.25
      confidenceScaling:
        jointOpacity: true
        boneWidth: true
scenes:
  opening: []
`;
  const result = frontend.parse(source, {sourceId: 'pose-overlay.kamishibai.yaml'});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.storyDocument.poseRecognition.preview.overlay, {
    visible: true,
    minimumConfidence: 0.25,
    jointStyles: {
      leftWrist: {color: '#ff00aa', opacity: 0.8, radius: 6},
      rightWrist: {color: '#00e5ff', opacity: 1, radius: 7},
    },
    boneStyle: {color: '#00e5ff', opacity: 0.9, width: 4},
    confidenceScaling: {
      jointOpacity: true,
      jointRadius: false,
      boneOpacity: false,
      boneWidth: true,
    },
  });
  for (const path of [
    '/poseRecognition/preview/overlay',
    '/poseRecognition/preview/overlay/visible',
    '/poseRecognition/preview/overlay/jointStyles/leftWrist/color',
    '/poseRecognition/preview/overlay/jointStyles/rightWrist/radius',
    '/poseRecognition/preview/overlay/boneStyle/width',
    '/poseRecognition/preview/overlay/minimumConfidence',
    '/poseRecognition/preview/overlay/confidenceScaling/jointOpacity',
    '/poseRecognition/preview/overlay/confidenceScaling/boneWidth',
  ]) {
    assert.ok(result.storyDocument.sourceMap[path], path);
  }

  for (const [needle, replacement] of [
    ['leftWrist:', 'neck:'],
    ['opacity: 0.8', 'opacity: 1.1'],
    ['radius: 6', 'radius: -1'],
    ["color: '#ff00aa'", "color: '   '"],
    ['width: 4', 'width: -1'],
    ['minimumConfidence: 0.25', 'minimumConfidence: 2'],
    ['jointOpacity: true', 'jointOpacity: yes'],
    ['boneWidth: true', 'extra: true'],
    ['visible: true', 'extra: true'],
  ]) {
    const invalid = frontend.parse(source.replace(needle, replacement));
    assert.equal(invalid.ok, false, replacement);
    assert.ok(invalid.diagnostics.some(({code}) => code.startsWith('K4-SCHEMA')));
  }

  const emptyOverlay = frontend.parse(
    source.replace(/    overlay:[\s\S]*?scenes:/u, '    overlay: {}\nscenes:'),
  );
  assert.equal(emptyOverlay.ok, false);
  assert.ok(emptyOverlay.diagnostics.some(({code}) => code.startsWith('K4-SCHEMA')));
});

test('normalizes camera preview controls, image assets, defaults, and source ranges', () => {
  const source = `
kamishibai: '4.0'
assets:
  Tick: sound
  Charge: sound
  ShowMirrored:
    kind: image
    file: ui/show-mirrored.svg
    loading: eager
  ShowUnmirrored:
    kind: image
    file: ui/show-unmirrored.svg
  CameraMenu:
    kind: image
    file: ui/camera.svg
poseRecognition:
  idleSound: Tick
  chargeSound: Charge
  preview:
    mirroring: mirrored
    controls:
      mirroring:
        position: top-center
        opacity: 0.8
        assets:
          showMirrored: ShowMirrored
          showUnmirrored: ShowUnmirrored
      cameraMenu:
        position: bottom-right
        buttonAsset: CameraMenu
scenes:
  opening: []
`;
  const result = frontend.parse(source, {sourceId: 'camera-preview-controls.yaml'});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.storyDocument.assets.ShowMirrored.kind, 'image');
  assert.equal(result.storyDocument.assets.ShowMirrored.retention, 'story');
  assert.deepEqual(result.storyDocument.poseRecognition.preview.controls, {
    mirroring: {
      opacity: 0.8,
      position: 'top-center',
      assets: {showMirrored: 'ShowMirrored', showUnmirrored: 'ShowUnmirrored'},
    },
    cameraMenu: {opacity: 1, position: 'bottom-right', buttonAsset: 'CameraMenu'},
  });
  for (const path of [
    '/poseRecognition/preview/controls',
    '/poseRecognition/preview/controls/mirroring/position',
    '/poseRecognition/preview/controls/mirroring/opacity',
    '/poseRecognition/preview/controls/mirroring/assets/showMirrored',
    '/poseRecognition/preview/controls/mirroring/assets/showUnmirrored',
    '/poseRecognition/preview/controls/cameraMenu/position',
    '/poseRecognition/preview/controls/cameraMenu/buttonAsset',
  ]) {
    assert.ok(result.storyDocument.sourceMap[path], path);
  }
  for (const position of [
    'top-center',
    'bottom-center',
    'left-center',
    'right-center',
    'top-right',
    'bottom-right',
    'top-left',
    'bottom-left',
  ]) {
    const positioned = frontend.parse(
      source.replace('position: top-center', `position: ${position}`),
    );
    assert.equal(positioned.ok, true, position);
  }

  for (const [needle, replacement] of [
    ['position: top-center', 'position: middle'],
    ['opacity: 0.8', 'opacity: 1.1'],
    [
      'showUnmirrored: ShowUnmirrored',
      'showUnmirrored: ShowUnmirrored\n          extra: ShowUnmirrored',
    ],
  ]) {
    const candidate = source.replace(needle, replacement);
    const invalid = frontend.parse(candidate);
    assert.equal(invalid.ok, false, replacement);
    assert.ok(invalid.diagnostics.some(({code}) => code.startsWith('K4-SCHEMA')));
  }
});

test('requires eager image references for every configured camera preview control', () => {
  const source = `
kamishibai: '4.0'
assets:
  Tick: sound
  Charge: sound
  Icon:
    kind: image
    file: ui/icon.svg
    loading: lazy
  Wrong: sound
poseRecognition:
  idleSound: Tick
  chargeSound: Charge
  preview:
    mirroring: mirrored
    controls:
      mirroring:
        position: top-left
        assets:
          showMirrored: Icon
          showUnmirrored: Wrong
scenes:
  opening: []
`;
  const result = frontend.parse(source);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(({code}) => code === 'K4-PREVIEW-CONTROL-ASSET-001'));
  assert.ok(result.diagnostics.some(({code}) => code === 'K4-REF-002'));
});

test('accepts Japanese NFC identifiers and keeps case-distinct identifiers separate', async () => {
  const result = await validateFixture('valid', 'unicode-identifiers.kamishibai.yaml');
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(
    result.storyDocument.scenes.map(({id}) => id),
    ['開始', 'Scene', 'scene'],
  );
  assert.equal(result.storyDocument.actors.主人公, '主人公衣装');
  assert.equal(result.storyDocument.variables.得点, 1);
  assert.equal(result.storyDocument.scenes[0].actions[1].stableId, '開始表示');
});

test('preserves literal asset and scene IDs with whitespace, punctuation, controls, and Unicode form', () => {
  const assetId = ' Asset.e\u0301%/~\u0001\u007f ';
  const bubbleAssetId = ' Bubble.e\u0301./\u0002 ';
  const sceneId = ' Scene.e\u0301%/~\n\u007f ';
  const result = frontend.parse(`
kamishibai: '4.0'
assets:
  " Asset.e\\u0301%/~\\x01\\x7F ": backdrop
  " Bubble.e\\u0301./\\x02 ":
    kind: image
    file: bubble.svg
bubbleStyles:
  literal:
    portrait:
      base: " Bubble.e\\u0301./\\x02 "
      blink:
        frames: [" Bubble.e\\u0301./\\x02 "]
        frameIntervalSeconds: 0.4
    continueIndicator:
      frames: [" Bubble.e\\u0301./\\x02 ", " Bubble.e\\u0301./\\x02 "]
      frameIntervalSeconds: 0.2
scenes:
  " Scene.e\\u0301%/~\\n\\x7F ":
    - stage: " Asset.e\\u0301%/~\\x01\\x7F "
    - goto: " Scene.e\\u0301%/~\\n\\x7F "
`);

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(Object.hasOwn(result.storyDocument.assets, assetId), true);
  assert.equal(result.storyDocument.assets[assetId].name, assetId);
  assert.equal(Object.hasOwn(result.storyDocument.assets, bubbleAssetId), true);
  assert.deepEqual(result.storyDocument.bubbleStyles.literal.portrait, {
    base: bubbleAssetId,
    blink: {frames: [bubbleAssetId], frameIntervalSeconds: 0.4},
  });
  assert.deepEqual(result.storyDocument.bubbleStyles.literal.continueIndicator, {
    frames: [bubbleAssetId, bubbleAssetId],
    frameIntervalSeconds: 0.2,
  });
  assert.equal(result.storyDocument.scenes[0].id, sceneId);
  assert.equal(
    result.storyDocument.scenes[0].actions[0].id,
    '/scenes/ Scene.é%25~1~0%0A%7F /actions/0',
  );
  assert.equal(
    Object.hasOwn(result.storyDocument.sourceMap, '/assets/ Asset.é%25~1~0%01%7F '),
    true,
  );
  assert.equal(
    Object.keys(result.storyDocument.sourceMap).some((path) => /[\u0000-\u001f\u007f]/u.test(path)),
    false,
  );
});

test('escapes literal scene controls in schema diagnostics and StoryPaths', () => {
  const result = frontend.parse(`
kamishibai: '4.0'
scenes:
  "broken\\x01\\x7F scene":
    - wait: invalid
`);

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.length > 0, true);
  for (const diagnostic of result.diagnostics) {
    assert.equal(/[\u0000-\u001f\u007f]/u.test(diagnostic.path), false);
    assert.equal(/[\u0000-\u001f\u007f]/u.test(diagnostic.storyPath ?? ''), false);
  }
  assert.equal(result.diagnostics[0].path.includes('\\u0001\\u007f'), true);
  assert.equal(result.diagnostics[0].storyPath.includes('%01%7F'), true);
});

test('verified remote delivery preserves metadata and stays independent from loading policy', async () => {
  const result = await validateFixture('valid', 'remote-assets.kamishibai.yaml');
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.storyDocument.assets.OpeningMusic, {
    id: 'OpeningMusic',
    delivery: 'remote',
    loading: 'eager',
    retention: 'story',
    kind: 'sound',
    source: {
      url: 'https://cdn.example.com/opening.ogg',
      integrity: 'sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      contentType: 'audio/ogg',
      size: 123456,
    },
  });
  assert.equal(result.storyDocument.assets.Ocean.delivery, 'remote');
  assert.equal(result.storyDocument.assets.Ocean.loading, 'lazy');
  assert.equal(result.storyDocument.assets.Ocean.retention, 'story');
  assert.equal(result.storyDocument.assets.RemotePose.kind, 'poseModel');
  assert.equal(result.storyDocument.assets.RemotePose.delivery, 'remote');
  assert.equal(result.storyDocument.assets.RemotePose.retention, 'scene');
  assert.equal(result.storyDocument.assets.HeroIdle.delivery, 'embedded');
  assert.equal(result.storyDocument.assets.HeroIdle.loading, 'eager');
  assert.equal(result.storyDocument.assets.HeroIdle.retention, 'story');
});

test('normalizes memory retention defaults while preserving explicit overrides', () => {
  const result = frontend.parse(`
kamishibai: '4.0'
assets:
  SceneImage:
    kind: backdrop
    name: SceneImage
    retention: scene
  StoryPose:
    kind: poseModel
    file: pose/story
    retention: story
  DefaultSound: sound
  DefaultPose:
    kind: poseModel
    file: pose/default
scenes:
  opening: []
`);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.storyDocument.assets.SceneImage.retention, 'scene');
  assert.equal(result.storyDocument.assets.StoryPose.retention, 'story');
  assert.equal(result.storyDocument.assets.DefaultSound.retention, 'story');
  assert.equal(result.storyDocument.assets.DefaultPose.retention, 'scene');
});

test('normalizes bitmap costume resolution metadata with a safe default', () => {
  const result = frontend.parse(`
kamishibai: '4.0'
assets:
  ProjectBackdrop: backdrop
  Hero:
    kind: costume
    target: Actor
    file: costumes/hero.png
    bitmapResolution: 2
  Ocean:
    kind: backdrop
    file: backdrops/ocean.svg
  RemoteBitmap:
    kind: backdrop
    delivery: remote
    bitmapResolution: 1
    source:
      url: https://cdn.example.com/ocean.png
      integrity: sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      contentType: image/png
      size: 123
scenes:
  opening: []
`);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.storyDocument.assets.ProjectBackdrop.bitmapResolution, 1);
  assert.equal(result.storyDocument.assets.Hero.bitmapResolution, 2);
  assert.equal(result.storyDocument.assets.Ocean.bitmapResolution, 1);
  assert.equal(result.storyDocument.assets.RemoteBitmap.bitmapResolution, 1);

  for (const value of [0, 3, 1.5, '2']) {
    const invalid = frontend.parse(`
kamishibai: '4.0'
assets:
  Hero:
    kind: costume
    target: Actor
    file: hero.png
    bitmapResolution: ${JSON.stringify(value)}
scenes:
  opening: []
`);
    assert.equal(invalid.ok, false, JSON.stringify(invalid.diagnostics));
    assert.ok(invalid.diagnostics.some(({code}) => code.startsWith('K4-SCHEMA')));
  }
});

test('remote delivery rejects malformed or credential-bearing HTTPS URLs semantically', async () => {
  const fixture = await readFile(
    path.join(fixtureRoot, 'valid', 'remote-assets.kamishibai.yaml'),
    'utf8',
  );
  for (const url of [
    'https://?',
    'https://#fragment',
    'https:///asset.webp',
    'https://user:pass@example.com/asset.webp',
    'https://cdn.example.com/asset.webp#fragment',
  ]) {
    const source = fixture.replace('url: https://cdn.example.com/opening.ogg', `url: '${url}'`);
    const result = frontend.parse(source, {sourceId: 'invalid-remote-url'});
    assert.equal(result.ok, false, url);
    assert.ok(
      result.diagnostics.some(({code}) => code === 'K4-ASSET-REMOTE-URL-001'),
      url,
    );
  }
});

test('accepts an unpinned TM directory URL while keeping partial verification metadata invalid', async () => {
  const result = frontend.parse(`
kamishibai: '4.0'
assets:
  LivePose:
    kind: poseModel
    delivery: remote
    loading: lazy
    source:
      url: https://teachablemachine.withgoogle.com/models/example/
scenes:
  opening:
    poseModel: LivePose
    actions: []
`);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.storyDocument.assets.LivePose.source, {
    url: 'https://teachablemachine.withgoogle.com/models/example/',
  });

  const partial = await validateFixture('invalid', 'remote-missing-integrity.kamishibai.yaml');
  assert.equal(partial.ok, false);
});

test('compact and named actions plus short and long scenes normalize identically', async () => {
  const compact = await validateFixture('valid', 'compact-normalization.kamishibai.yaml');
  const named = await validateFixture('valid', 'named-normalization.kamishibai.yaml');
  assert.equal(compact.ok, true);
  assert.equal(named.ok, true);
  assert.deepEqual(
    semanticProjection(compact.storyDocument),
    semanticProjection(named.storyDocument),
  );
});

for (const name of [
  'modifier-key.kamishibai.yaml',
  'multiple-action-keys.kamishibai.yaml',
  'unknown-action-argument.kamishibai.yaml',
  'list-for-scalar.kamishibai.yaml',
  'long-scene-missing-actions.kamishibai.yaml',
  'long-scene-mixed-action.kamishibai.yaml',
  'deprecated-text-asset.kamishibai.yaml',
  'non-scalar-variable.kamishibai.yaml',
  'cover-missing-backdrop.kamishibai.yaml',
  'pose-choices.kamishibai.yaml',
  'pose-empty-steps.kamishibai.yaml',
  'top-level-pose-models.kamishibai.yaml',
  'invalid-loading-policy.kamishibai.yaml',
  'invalid-retention-policy.kamishibai.yaml',
  'positional-multi-argument.kamishibai.yaml',
  'remote-asset.kamishibai.yaml',
  'remote-http.kamishibai.yaml',
  'remote-missing-integrity.kamishibai.yaml',
  'remote-invalid-integrity.kamishibai.yaml',
  'remote-invalid-metadata.kamishibai.yaml',
  'duplicate-id.kamishibai.yaml',
  'unknown-top-level-key.kamishibai.yaml',
  'custom-action-unknown-key.kamishibai.yaml',
]) {
  test(`schema rejects ${name}`, async () => {
    const result = await validateFixture('invalid', name);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.length > 0);
    assert.equal(result.storyDocument, undefined);
  });
}

for (const [name, code] of [
  ['version-number.kamishibai.yaml', 'K4-VERSION-001'],
  ['unknown-top-level-key.kamishibai.yaml', 'K4-SCHEMA-UNKNOWN-KEY'],
  ['modifier-key.kamishibai.yaml', 'K4-KEY-UNSUPPORTED'],
  ['duplicate-id.kamishibai.yaml', 'K4-YAML-001'],
]) {
  test(`${name} reports ${code}`, async () => {
    const result = await validateFixture('invalid', name);
    assert.ok(result.diagnostics.some((error) => error.code === code));
  });
}

for (const name of ['invalid-id.kamishibai.yaml', 'non-nfc-id.kamishibai.yaml']) {
  test(`${name} is accepted as a literal scene ID`, async () => {
    const result = await validateFixture('invalid', name);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  });
}

for (const [name, code] of [
  ['duplicate-stable-id.kamishibai.yaml', 'K4-STABLE-ID-001'],
  ['else-not-last.kamishibai.yaml', 'K4-BRANCH-001'],
  ['keymap-collision.kamishibai.yaml', 'K4-KEY-001'],
  ['missing-reference.kamishibai.yaml', 'K4-REF-001'],
  ['path-traversal.kamishibai.yaml', 'K4-ASSET-001'],
  ['wrong-asset-kind.kamishibai.yaml', 'K4-REF-002'],
  ['pose-action-without-model.kamishibai.yaml', 'K4-POSE-MODEL-001'],
  ['pose-input-without-model.kamishibai.yaml', 'K4-POSE-MODEL-001'],
]) {
  test(`semantic validation rejects ${name}`, async () => {
    const result = await validateFixture('invalid', name);
    assert.ok(result.diagnostics.some((error) => error.code === code));
  });
}

test('restricted YAML rejects aliases, anchors, merge keys, tags, duplicates, and multiple documents', () => {
  const sources = [
    "kamishibai: '4.0'\nscenes: &scenes\n  opening: []\ncopy: *scenes\n",
    "kamishibai: '4.0'\nbase: &base {opening: []}\nscenes:\n  <<: *base\n",
    "kamishibai: '4.0'\nscenes: !custom {opening: []}\n",
    "kamishibai: '4.0'\nscenes: {}\nscenes: {}\n",
    "kamishibai: '4.0'\nscenes: {}\n---\nkamishibai: '4.0'\nscenes: {}\n",
  ];
  for (const source of sources) {
    const result = frontend.parse(source);
    assert.ok(result.diagnostics.some((error) => error.code.startsWith('K4-YAML-')));
  }
});

test('YAML 1.2 keeps yes, no, and dates as strings while preserving booleans', () => {
  const result = frontend.parse(
    [
      "kamishibai: '4.0'",
      'variables:',
      '  yesValue: yes',
      '  noValue: no',
      '  dateValue: 2026-08-06',
      '  enabled: true',
      '  disabled: false',
      'scenes:',
      '  opening: []',
    ].join('\n'),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.storyDocument.variables, {
    yesValue: 'yes',
    noValue: 'no',
    dateValue: '2026-08-06',
    enabled: true,
    disabled: false,
  });
});

test('canonicalizes BOM and all line endings before reporting source positions', () => {
  const source = "\uFEFFkamishibai: '4.0'\r\nscenes:\r  opening:\r\n    - wait: 1\r";
  const result = frontend.parse(source, {sourceId: 'line-endings.kamishibai.yaml'});
  assert.equal(result.ok, true);
  assert.equal(result.canonicalSource, "kamishibai: '4.0'\nscenes:\n  opening:\n    - wait: 1\n");
  const action = result.storyDocument.scenes[0].actions[0];
  assert.equal(action.sourceRange.start.line, 4);
  assert.equal(action.sourceRange.start.column, 7);
});

test('diagnostics carry stable source identity, range, path, and deterministic order', async () => {
  const source = await readFile(
    path.join(fixtureRoot, 'invalid', 'wrong-asset-kind.kamishibai.yaml'),
    'utf8',
  );
  const first = frontend.parse(source, {sourceId: 'story.kamishibai.yaml'});
  const second = frontend.parse(source, {sourceId: 'story.kamishibai.yaml'});
  assert.equal(first.ok, false);
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.deepEqual(Object.keys(first.diagnostics[0]), [
    'version',
    'code',
    'severity',
    'message',
    'sourceId',
    'range',
    'storyPath',
    'path',
    'related',
  ]);
  assert.equal(first.diagnostics[0].sourceId, 'story.kamishibai.yaml');
  assert.equal(first.diagnostics[0].storyPath, '/scenes/opening/actions/0');
  assert.ok(first.diagnostics[0].range.start.line > 0);
});

test('rejects object-pollution mapping keys before conversion to JavaScript values', () => {
  const source = "kamishibai: '4.0'\nvariables:\n  __proto__: unsafe\nscenes:\n  opening: []\n";
  const result = frontend.parse(source);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(({code}) => code === 'K4-YAML-006'));
});

test('keeps StoryPath stable across comments and whitespace-only edits', () => {
  const sources = [
    "kamishibai: '4.0'\nscenes:\n  opening:\n    - wait: 1\n",
    "# comment\nkamishibai: '4.0'\n\nscenes:\n  opening:\n\n    - wait: 1 # comment\n",
  ];
  const results = sources.map((source) => frontend.parse(source));
  assert.ok(results.every(({ok}) => ok));
  assert.equal(results[0].storyDocument.scenes[0].actions[0].id, '/scenes/opening/actions/0');
  assert.equal(results[1].storyDocument.scenes[0].actions[0].id, '/scenes/opening/actions/0');
});
