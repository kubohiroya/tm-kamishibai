import assert from 'node:assert/strict';
import {test} from 'vitest';
import {parse} from 'yaml';
import {normalizeDsl4VmProjectSnapshot} from '../src/dsl4/platform/vm-project-snapshot.js';
import {dsl4TestSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';
import {createDsl4StructuredBlockSourceDeclaration} from '../src/dsl4/structured-block-source.js';
import {extractDsl4BlockSourcesFromProject} from '../src/dsl4/turbowarp-yaml-json-block-source.js';
import {createDsl4AssetDependencyIndex} from '../src/dsl4/asset-dependency-index.js';

test('audio uses sound assets, requires one source, and validates each operation and value', () => {
  const source = (actions: unknown[], kind = 'sound') =>
    JSON.stringify({kamishibai: '4.0', assets: {Music: kind}, scenes: {opening: actions}});
  const prepare = {
    audio: {id: 'music', asset: 'Music', volume: 35, muted: false, playbackRate: 1.5},
  };
  const operations = [
    ...['playUntilDone', 'play', 'loop', 'stop', 'pause', 'resume'].map((operation) => ({
      id: 'music',
      operation,
    })),
    {id: 'music', operation: 'seek', seconds: 1.5},
    {id: 'music', operation: 'setVolume', volume: 0},
    {id: 'music', operation: 'setMuted', muted: true},
    {id: 'music', operation: 'setPlaybackRate', rate: 4},
  ];
  const result = frontend.parse(
    source([prepare, ...operations.map((args) => ({audioControl: args}))]),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.match(JSON.stringify(createDsl4AssetDependencyIndex(result.storyDocument!)), /Music/u);
  assert.equal(frontend.parse(source([prepare], 'backdrop')).ok, false);
  for (const audio of [
    {id: 'music'},
    {id: 'music', asset: 'Missing'},
    {id: 'music', asset: 'Music', url: 'https://example.com/a.mp3'},
    {id: 'music', url: 'javascript:alert(1)'},
    {id: 'music', url: 'https://user:password@example.com/a.mp3'},
    {...prepare.audio, volume: -1},
    {...prepare.audio, muted: 'false'},
    {...prepare.audio, playbackRate: 0},
    {...prepare.audio, x: 0},
  ])
    assert.equal(frontend.parse(source([{audio}])).ok, false, JSON.stringify(audio));
  for (const args of [
    {id: 'music', operation: 'unknown'},
    {id: 'music', operation: 'seek'},
    {id: 'music', operation: 'seek', seconds: -1},
    {id: 'music', operation: 'setMuted', muted: 'false'},
    {id: 'music', operation: 'setVolume', volume: -1},
    {id: 'music', operation: 'stop', volume: 10},
  ])
    assert.equal(
      frontend.parse(source([prepare, {audioControl: args}])).ok,
      false,
      JSON.stringify(args),
    );
});

test('audio and audioControl round-trip through runtime and bundle block forms', () => {
  const actions = [
    {
      audio: {
        id: 'music',
        url: 'https://example.com/music.mp3',
        volume: 70,
        muted: false,
        playbackRate: 0.5,
        fadeIn: 0.5,
        fadeOut: 1.5,
        stableId: 'prepare-music',
      },
    },
    ...['playUntilDone', 'play', 'loop', 'stop', 'pause', 'resume'].map((operation) => ({
      audioControl: {id: 'music', operation},
    })),
    {audioControl: {id: 'music', operation: 'seek', seconds: 2}},
    {audioControl: {id: 'music', operation: 'setVolume', volume: 35}},
    {audioControl: {id: 'music', operation: 'setMuted', muted: true}},
    {audioControl: {id: 'music', operation: 'setPlaybackRate', rate: 1.5}},
    {audioControl: {id: 'music', operation: 'playUntilDone', fadeIn: 0, volume: 200, fadeOut: 2}},
    {audioControl: {id: 'music', operation: 'stop', fadeOut: 0.25}},
  ];
  for (const form of ['runtime', 'bundle'] as const) {
    const blocks = createDsl4StructuredBlockSourceDeclaration({
      source: {kamishibai: '4.0', scenes: {opening: actions}},
      form,
      hatId: 'hat',
    });
    const extracted = extractDsl4BlockSourcesFromProject({
      targets: [{isStage: true, name: 'Stage', blocks}],
    });
    const decoded = parse(extracted.sources['Stage.k4.yml']!);
    assert.deepEqual(decoded.scenes.opening, actions);
    assert.equal(frontend.parse(extracted.sources['Stage.k4.yml']!).ok, true);
  }
});

test('validates fade seconds and permits fades only on playback and stop operations', () => {
  const check = (action: unknown) =>
    frontend.parse(JSON.stringify({kamishibai: '4.0', scenes: {opening: [action]}})).ok;
  assert.equal(
    check({audio: {id: 'music', url: 'https://example.com/a.mp3', fadeIn: 0.25, fadeOut: 2}}),
    true,
  );
  for (const operation of ['play', 'playUntilDone', 'loop', 'resume']) {
    assert.equal(
      check({audioControl: {id: 'music', operation, fadeIn: 0, volume: 200, fadeOut: 1.5}}),
      true,
    );
  }
  assert.equal(check({audioControl: {id: 'music', operation: 'stop', fadeOut: 0.5}}), true);
  for (const value of [-1, '1', null]) {
    assert.equal(
      check({audio: {id: 'music', url: 'https://example.com/a.mp3', fadeIn: value}}),
      false,
    );
    assert.equal(check({audioControl: {id: 'music', operation: 'play', fadeOut: value}}), false);
  }
  for (const action of [
    {audioControl: {id: 'music', operation: 'stop', fadeIn: 1}},
    {audioControl: {id: 'music', operation: 'pause', fadeOut: 1}},
    {audioControl: {id: 'music', operation: 'seek', seconds: 1, fadeIn: 1}},
  ])
    assert.equal(check(action), false);
});

test('retains audio blocks that were saved before the fade inputs existed', () => {
  for (const form of ['runtime', 'bundle'] as const) {
    const actions = [
      {audio: {id: 'music', url: 'https://example.com/a.mp3'}},
      {audioControl: {id: 'music', operation: 'play'}},
    ];
    const blocks = createDsl4StructuredBlockSourceDeclaration({
      source: {kamishibai: '4.0', scenes: {opening: actions}},
      form,
      hatId: 'hat',
    });
    for (const block of Object.values(blocks)) {
      delete block.inputs.VOLUME;
      delete block.inputs.FADEIN;
      delete block.inputs.FADEOUT;
    }
    const extracted = extractDsl4BlockSourcesFromProject({
      targets: [{isStage: true, name: 'Stage', blocks}],
    });
    assert.deepEqual(parse(extracted.sources['Stage.k4.yml']!).scenes.opening, actions);
  }
});

test('retains volume from older audio actionOptions without a volume input', () => {
  const actions = [
    {audio: {id: 'music', url: 'https://example.com/a.mp3', volume: 175, muted: true}},
  ];
  const blocks = createDsl4StructuredBlockSourceDeclaration({
    source: {kamishibai: '4.0', scenes: {opening: actions}},
    form: 'runtime',
    hatId: 'hat',
  });
  const audio = Object.values(blocks).find((block) => block.opcode.endsWith('_audio'))!;
  const wrapper = blocks[audio.parent!]!;
  delete audio.inputs.VOLUME;
  wrapper.inputs.PROPERTIES = [
    1,
    [10, JSON.stringify({arguments: {volume: 175, muted: true}, textFormat: 'plain'})],
  ];
  const extracted = extractDsl4BlockSourcesFromProject({
    targets: [{isStage: true, name: 'Stage', blocks}],
  });
  assert.deepEqual(parse(extracted.sources['Stage.k4.yml']!).scenes.opening, actions);
});

test('reads audio declarations after Packager omits false shadow flags in its VM snapshot', () => {
  const source = {
    kamishibai: '4.0',
    assets: {Music: 'sound'},
    scenes: {
      opening: [
        {audio: {id: 'music', asset: 'Music'}},
        {
          audioControl: {
            id: 'music',
            operation: 'playUntilDone',
            fadeIn: 0.2,
            volume: 150,
            fadeOut: 0.4,
          },
        },
      ],
    },
  };
  const blocks = createDsl4StructuredBlockSourceDeclaration({source, form: 'bundle', hatId: 'hat'});
  for (const block of Object.values(blocks))
    if (block.shadow === false) delete (block as {shadow?: boolean}).shadow;
  const project = {targets: [{isStage: true, name: 'Stage', blocks}]};
  const normalized = normalizeDsl4VmProjectSnapshot(project);
  const extracted = extractDsl4BlockSourcesFromProject(normalized);
  assert.deepEqual(parse(extracted.sources['Stage.k4.yml']!), source);
  assert.equal(
    Object.values(blocks).some((block) => !Object.hasOwn(block, 'shadow')),
    true,
  );
  assert.equal(
    Object.values(blocks).some((block) => block.shadow === true),
    true,
  );
});
