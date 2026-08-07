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
  assert.deepEqual(result.storyDocument.poseRecognition.feedback, {mode: 'scratchMirror'});
  assert.deepEqual(result.storyDocument.poseRecognition.navigation, {allowSkip: false});
  assert.deepEqual(result.storyDocument.poseRecognition.preview, {mirroring: 'mirrored'});
  assert.equal(result.storyDocument.scenes[0].posePreview, null);
  assert.deepEqual(result.storyDocument.scenes[1].posePreview, {mirroring: 'unmirrored'});
  assert.equal(result.storyDocument.scenes[2].posePreview, null);
  assert.ok(result.storyDocument.sourceMap['/poseRecognition/feedback/mode']);
  assert.ok(result.storyDocument.sourceMap['/poseRecognition/navigation/allowSkip']);
  assert.ok(result.storyDocument.sourceMap['/poseRecognition/preview/mirroring']);
  assert.ok(result.storyDocument.sourceMap['/scenes/rescue/posePreview/mirroring']);
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

test('normalizes reusable speech styles and validates style references and dependencies', () => {
  const source = `
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
  TalkTick: sound
  WrongTick: backdrop
actors:
  Hero: HeroIdle
speechStyles:
  novel:
    characterIntervalSeconds: 0.08
    characterSound: TalkTick
    noSoundCharacters: "「」"
    restCharacters: "、。…"
    restCharacterIntervalSeconds: 0.5
scenes:
  opening:
    - Hero.say:
        text: スタイルで進む。
        waitFor: advance
        style: novel
`;
  const result = frontend.parse(source, {sourceId: 'speech-style.kamishibai.yaml'});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.storyDocument.speechStyles, {
    novel: {
      characterIntervalSeconds: 0.08,
      characterSound: 'TalkTick',
      noSoundCharacters: '「」',
      restCharacters: '、。…',
      restCharacterIntervalSeconds: 0.5,
    },
  });
  assert.deepEqual(result.storyDocument.scenes[0].actions[0].args, {
    text: 'スタイルで進む。',
    waitFor: 'advance',
    style: 'novel',
  });
  for (const field of [
    'characterIntervalSeconds',
    'characterSound',
    'noSoundCharacters',
    'restCharacters',
    'restCharacterIntervalSeconds',
  ]) {
    assert.ok(result.storyDocument.sourceMap[`/speechStyles/novel/${field}`], field);
  }
  assert.ok(result.storyDocument.sourceMap['/scenes/opening/actions/0/args/style']);

  for (const [needle, replacement] of [
    ['        style: novel', '        style: missing'],
    ['        style: novel', '        style: novel\n        characterIntervalSeconds: 0.1'],
    ['    characterSound: TalkTick\n', ''],
    ['    characterSound: TalkTick', '    characterSound: WrongTick'],
    ['    restCharacterIntervalSeconds: 0.5\n', ''],
  ]) {
    const invalid = frontend.parse(source.replace(needle, replacement));
    assert.equal(invalid.ok, false, replacement);
  }

  const missingSound = frontend.parse(
    source.replace('    characterSound: TalkTick', '    characterSound: MissingTick'),
  );
  assert.equal(missingSound.ok, false);
  assert.ok(
    missingSound.diagnostics.some(
      ({code, path}) => code === 'K4-REF-001' && path === '$.speechStyles.novel.characterSound',
    ),
    JSON.stringify(missingSound.diagnostics),
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
      result.diagnostics.some(({code}) => code.startsWith('K4-SCHEMA')),
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
  assert.deepEqual(valid.storyDocument.poseRecognition.navigation, {allowSkip: false});
  assert.deepEqual(valid.storyDocument.poseRecognition.preview, {mirroring: 'mirrored'});

  for (const policy of [
    ['feedback', '    mode: hidden\n'],
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

test('remote delivery requires verified metadata and stays independent from loading policy', async () => {
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
  'pose-recognition-missing-sound.kamishibai.yaml',
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
  'non-nfc-id.kamishibai.yaml',
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
  ['invalid-id.kamishibai.yaml', 'K4-ID-INVALID'],
  ['unknown-top-level-key.kamishibai.yaml', 'K4-SCHEMA-UNKNOWN-KEY'],
  ['modifier-key.kamishibai.yaml', 'K4-KEY-UNSUPPORTED'],
  ['non-nfc-id.kamishibai.yaml', 'K4-ID-001'],
  ['duplicate-id.kamishibai.yaml', 'K4-YAML-001'],
]) {
  test(`${name} reports ${code}`, async () => {
    const result = await validateFixture('invalid', name);
    assert.ok(result.diagnostics.some((error) => error.code === code));
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
