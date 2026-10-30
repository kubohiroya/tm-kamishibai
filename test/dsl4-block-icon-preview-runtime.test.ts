import assert from 'node:assert/strict';
import {test} from 'vitest';
import {createBubbleComposition} from '@kubohiroya/turbowarp-bubble/composition';
import {createDsl4BubblePlatform} from '../src/dsl4/platform/bubble-platform.js';
import {composeBubbleStyles} from '../src/dsl4/bubble-style.js';
import {
  createDsl4BlockIconPreviewProject,
  resolveDsl4BlockIconPreviewLocation,
  projectDsl4NamedBlockIconPreview,
} from '../src/dsl4/block-icon-preview-location.js';
import {
  createDsl4BlockIconPreviewSession,
  createDsl4BlockIconPreviewRuntime,
  createDsl4BlockIconPreviewPresentation,
  createDsl4IsolatedPreviewAssetManager,
} from '../src/dsl4/platform/block-icon-preview-runtime.js';
import {createDsl4StructuredBlockSourceDeclaration} from '../src/dsl4/structured-block-source.js';
import {prepareDsl4EmbeddedBlockStoryProject} from '../src/dsl4/platform/embedded-block-story.js';
import {loadDsl4RuntimeComponent} from '../src/dsl4/runtime-artifact-loader.js';
import {dsl4TestSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';
import {dsl4TestProductionSourceFrontend as productionFrontend} from './helpers/dsl4-test-frontend.ts';
import {migrateDsl4LegacyBlockProject} from '../src/dsl4/embedded-yaml-migration.js';
import {buildKamishibaiDocumentViewCandidate} from '../src/dsl4/embedded-yaml-project-views.js';
import {deferred, withDeadline, waitUntil} from './helpers/async-test-helpers.ts';

const source = {
  kamishibai: '4.0',
  assets: {Beach: 'backdrop', Skin: 'costume:Hero'},
  actors: {Hero: 'Skin'},
  controls: {keymaps: {production: {Space: 'navigation.nextAction'}}},
  scenes: {
    opening: [
      {stage: 'Beach'},
      {'Hero.show': {skin: 'Skin', x: 0, y: -20, scale: 100}},
      {wait: 600},
      {'Hero.moveTo': {x: 80, y: 30, seconds: 2, easing: 'easeOut'}},
      {'Hero.say': {text: 'Hello', seconds: 1}},
      {stage: 'Beach'},
    ],
    ending: [{wait: 0}],
  },
};
const limits = {
  maxSourceBytes: 1024 * 1024,
  maxAssetFiles: 64,
  maxTotalAssetBytes: 64 * 1024 * 1024,
};

function fixture(input: Record<string, unknown> = source) {
  const blocks = createDsl4StructuredBlockSourceDeclaration({
    source: input,
    form: 'runtime',
    hatId: 'hat',
    simpleSpeech: false,
  });
  const project = {targets: [{id: 'stage', name: 'Stage', isStage: true, blocks}]};
  const reference = (command: string) => {
    const entry = Object.entries(blocks).find(([, block]) => block.opcode.endsWith(`_${command}`));
    assert.ok(entry);
    return {targetId: 'stage', blockId: entry[0], opcode: entry[1].opcode};
  };
  return {project, blocks, reference};
}

async function story(project = fixture().project) {
  const prepared = await prepareDsl4EmbeddedBlockStoryProject(project, frontend, limits);
  const loaded = await loadDsl4RuntimeComponent(prepared, frontend, limits);
  assert.ok(loaded.ok, JSON.stringify(loaded.diagnostics));
  return (loaded as unknown as {storyDocument: Readonly<Record<string, unknown>>}).storyDocument;
}

test('preview drafts change only the selected literal in a cloned block graph', () => {
  const {project: base, blocks, reference} = fixture();
  const project = {...base, monitors: [{opcode: 'thirdparty_load', visible: true}]};
  const selected = reference('moveTo');
  const before = structuredClone(project);
  const preview = createDsl4BlockIconPreviewProject(project, selected, {X: 45, SECONDS: 0.75});
  assert.deepEqual(project, before);
  assert.deepEqual(preview.monitors, []);
  const changed = (preview as typeof project).targets[0]!.blocks[selected.blockId]!;
  assert.deepEqual(changed.inputs.X, [1, [4, 45]]);
  assert.deepEqual(changed.inputs.SECONDS, [1, [4, 0.75]]);
  assert.deepEqual(changed.inputs.Y, blocks[selected.blockId]!.inputs.Y);
  assert.throws(() =>
    createDsl4BlockIconPreviewProject(project, {...selected, opcode: 'other'}, {X: 10}),
  );
});

test('preview refuses a connected expression instead of changing its fallback shadow', () => {
  const {project, blocks, reference} = fixture();
  const selected = reference('moveTo');
  blocks[selected.blockId]!.inputs.X = [3, 'expression', [4, 20]];
  assert.throws(
    () => createDsl4BlockIconPreviewProject(project, selected, {X: 10}),
    /式やレポーター/,
  );
});

test('authored scene and action blocks resolve to normalized runtime positions', async () => {
  const {project, reference} = fixture();
  const document = await story(project);
  assert.deepEqual(resolveDsl4BlockIconPreviewLocation(project, reference('scene'), document), {
    sceneId: 'opening',
    actionPath: null,
  });
  assert.deepEqual(resolveDsl4BlockIconPreviewLocation(project, reference('moveTo'), document), {
    sceneId: 'opening',
    actionPath: '/scenes/opening/actions/3',
  });
  assert.deepEqual(resolveDsl4BlockIconPreviewLocation(project, reference('say'), document), {
    sceneId: 'opening',
    actionPath: '/scenes/opening/actions/4',
  });
});

async function migratedFixture(
  project: Record<string, unknown>,
  documentPaths: Record<string, string> = {},
) {
  const prepared = await prepareDsl4EmbeddedBlockStoryProject(project, productionFrontend, limits);
  return (
    await migrateDsl4LegacyBlockProject(prepared, {
      sourceFrontend: productionFrontend,
      entryFile: 'main.k4.yml',
      documentPaths,
    })
  ).project;
}

test('named schema-view draft is projected into a preview source without changing the canonical document', async () => {
  const f = fixture();
  const project = await migratedFixture(f.project);
  const before = structuredClone(project);
  const selected = f.reference('moveTo');
  const draft = createDsl4BlockIconPreviewProject(project, selected, {X: 44, SECONDS: 0.35});
  const named = await projectDsl4NamedBlockIconPreview(draft, productionFrontend, limits);
  assert.ok(named);
  const loaded = await loadDsl4RuntimeComponent(named.project, productionFrontend, limits);
  assert.ok(loaded.ok, JSON.stringify(loaded.diagnostics));
  const document = (loaded as unknown as {storyDocument: Record<string, unknown>}).storyDocument;
  assert.deepEqual(
    resolveDsl4BlockIconPreviewLocation(draft, selected, document, undefined, named.blockSources),
    {sceneId: 'opening', actionPath: '/scenes/opening/actions/3'},
  );
  const scenes = document.scenes as {id: string; actions: {args: Record<string, unknown>}[]}[];
  assert.equal(scenes.find((s) => s.id === 'opening')!.actions[3]!.args.x, 44);
  assert.equal(scenes.find((s) => s.id === 'opening')!.actions[3]!.args.seconds, 0.35);
  assert.deepEqual(project, before);
});

test('named include graph preserves module identity and previews edits in an included scene', async () => {
  const entry = createDsl4StructuredBlockSourceDeclaration({
    source: {...source, scenes: {opening: [{stage: 'Beach'}]}},
    form: 'runtime',
    hatId: 'entry',
    idPrefix: 'entry-',
    includeLabels: ['part'],
    simpleSpeech: false,
  });
  const part = createDsl4StructuredBlockSourceDeclaration({
    source: {scenes: {ending: [{'Hero.moveTo': {x: 80, y: 30, seconds: 2}}]}},
    form: 'runtime',
    hatId: 'part',
    idPrefix: 'part-',
    label: 'part',
    simpleSpeech: false,
  });
  const project = await migratedFixture(
    {targets: [{id: 'stage', name: 'Stage', isStage: true, blocks: {...entry, ...part}}]},
    {part: 'parts/ending.k4.yml'},
  );
  const selectedEntry = Object.entries(part).find(([, b]) => b.opcode.endsWith('_moveTo'))!;
  const selected = {targetId: 'stage', blockId: selectedEntry[0], opcode: selectedEntry[1].opcode};
  const before = structuredClone(project);
  const draft = createDsl4BlockIconPreviewProject(project, selected, {Y: 65});
  const named = await projectDsl4NamedBlockIconPreview(draft, productionFrontend, limits);
  assert.ok(named);
  assert.ok(named.blockSources.sources['parts/ending.k4.yml']);
  const loaded = await loadDsl4RuntimeComponent(named.project, productionFrontend, limits);
  assert.ok(loaded.ok, JSON.stringify(loaded.diagnostics));
  const document = (loaded as unknown as {storyDocument: Record<string, unknown>}).storyDocument;
  assert.deepEqual(
    resolveDsl4BlockIconPreviewLocation(draft, selected, document, undefined, named.blockSources),
    {sceneId: 'ending', actionPath: '/scenes/ending/actions/0'},
  );
  assert.equal(
    (document.scenes as {id: string; actions: {args: Record<string, unknown>}[]}[]).find(
      (s) => s.id === 'ending',
    )!.actions[0]!.args.y,
    65,
  );
  assert.deepEqual(project, before);
});

test('unreadable named schema-view inputs are rejected rather than replaying the older canonical source', async () => {
  const f = fixture();
  const project = await migratedFixture(f.project);
  const selected = f.reference('moveTo');
  const blocks = (
    project.targets as {blocks: Record<string, {inputs: Record<string, unknown>}>}[]
  )[0]!.blocks;
  blocks[selected.blockId]!.inputs.X = [2, 'missing-dynamic-reporter'];
  const before = structuredClone(project);
  await assert.rejects(
    projectDsl4NamedBlockIconPreview(project, productionFrontend, limits),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'K4-BLOCK-PREVIEW-SOURCE',
  );
  assert.deepEqual(project, before);
});

test('single embedded document schema views preview draft edits through the production frontend', async () => {
  const prepared = await prepareDsl4EmbeddedBlockStoryProject(
    fixture().project,
    productionFrontend,
    limits,
  );
  const component = (
    (prepared.extensionStorage as Record<string, unknown>).kubohiroyakamishibai4 as {
      components: {kubohiroyakamishibairuntime4: {source: {text: string}}};
    }
  ).components.kubohiroyakamishibairuntime4;
  (prepared.targets as {blocks: Record<string, unknown>}[])[0]!.blocks = {};
  const built = await buildKamishibaiDocumentViewCandidate(
    {
      project: prepared,
      source: component.source.text,
      reference: {providerId: 'kamishibai-dsl4', documentId: 'story'},
      request: {kind: 'schema-blocks', direction: 'from-source'},
    },
    {
      frontend: productionFrontend,
      replaceSource: async () => {
        throw new Error('from-source must not reflect into canonical source');
      },
    },
  );
  const blocks = (built.project.targets as {blocks: Record<string, {opcode: string}>}[])[0]!.blocks;
  const entry = Object.entries(blocks).find(([, block]) => block.opcode.endsWith('_moveTo'))!;
  const selected = {targetId: 'stage', blockId: entry[0], opcode: entry[1].opcode};
  const before = structuredClone(built.project);
  const draft = createDsl4BlockIconPreviewProject(built.project, selected, {X: -30});
  const named = await projectDsl4NamedBlockIconPreview(draft, productionFrontend, limits);
  assert.ok(named);
  const loaded = await loadDsl4RuntimeComponent(named.project, productionFrontend, limits);
  assert.ok(loaded.ok, JSON.stringify(loaded.diagnostics));
  const document = (loaded as unknown as {storyDocument: Record<string, unknown>}).storyDocument;
  assert.deepEqual(
    resolveDsl4BlockIconPreviewLocation(draft, selected, document, undefined, named.blockSources),
    {sceneId: 'opening', actionPath: '/scenes/opening/actions/3'},
  );
  assert.deepEqual(built.project, before);
});

test('native text Bubble draft changes reach the normalized speech without changing the saved graph', async () => {
  const blocks = createDsl4StructuredBlockSourceDeclaration({
    source,
    form: 'runtime',
    hatId: 'hat',
    simpleSpeech: true,
  });
  const entry = Object.entries(blocks).find(([, b]) => b.opcode.endsWith('_sayText'))!;
  assert.ok(entry);
  const project = {targets: [{id: 'stage', name: 'Stage', isStage: true, blocks}]};
  const before = structuredClone(project);
  const selected = {targetId: 'stage', blockId: entry[0], opcode: entry[1].opcode};
  const draft = createDsl4BlockIconPreviewProject(project, selected, {
    TEXT: 'Draft Bubble',
    SECONDS: 0.4,
  });
  const prepared = await prepareDsl4EmbeddedBlockStoryProject(draft, productionFrontend, limits);
  const loaded = await loadDsl4RuntimeComponent(prepared, productionFrontend, limits);
  assert.ok(loaded.ok, JSON.stringify(loaded.diagnostics));
  const document = (loaded as unknown as {storyDocument: Record<string, unknown>}).storyDocument;
  assert.deepEqual(resolveDsl4BlockIconPreviewLocation(draft, selected, document), {
    sceneId: 'opening',
    actionPath: '/scenes/opening/actions/4',
  });
  assert.deepEqual(
    (document.scenes as {actions: {args: Record<string, unknown>}[]}[])[0]!.actions[4]!.args,
    {text: 'Draft Bubble', seconds: 0.4},
  );
  assert.deepEqual(project, before);
});

test('motion preview reconstructs prior presentation quickly and returns during the real motion', async () => {
  const document = await story();
  const motion = deferred();
  const log: [string, unknown][] = [];
  const abort = new AbortController();
  const preview = createDsl4BlockIconPreviewSession({
    storyDocument: document,
    sceneId: 'opening',
    actionPath: '/scenes/opening/actions/3',
    mode: 'action',
    signal: abort.signal,
    port: {
      stage: (args: Readonly<Record<string, unknown>>) => {
        log.push(['stage', args]);
      },
      show: (args: Readonly<Record<string, unknown>>) => {
        log.push(['show', args]);
      },
      wait: () => assert.fail('a prefix wait must not delay preview'),
      moveTo: (args: Readonly<Record<string, unknown>>) => {
        log.push(['moveTo', args]);
        return motion.promise;
      },
      say: () => assert.fail('the following action must not execute'),
    },
  });
  try {
    await withDeadline(preview.start(), 'motion preview readiness', 2000);
    assert.deepEqual(
      log.map(([name]) => name),
      ['stage', 'show', 'moveTo'],
    );
    assert.deepEqual(log[2]![1], {target: 'Hero', x: 80, y: 30, seconds: 2, easing: 'easeOut'});
    motion.resolve(undefined);
    await withDeadline(preview.finished, 'motion preview completion', 2000);
    assert.deepEqual(
      log.map(([name]) => name),
      ['stage', 'show', 'moveTo'],
    );
  } finally {
    await preview.dispose();
  }
});

test('still previews finish earlier moves instantly and retain the selected speech without timers', async () => {
  const document = await story();
  let move: Readonly<Record<string, unknown>> | undefined;
  let speech: Readonly<Record<string, unknown>> | undefined;
  const abort = new AbortController();
  const preview = createDsl4BlockIconPreviewSession({
    storyDocument: document,
    sceneId: 'opening',
    actionPath: '/scenes/opening/actions/4',
    mode: 'still',
    signal: abort.signal,
    port: {
      stage() {},
      show() {},
      wait() {},
      moveTo(args: Readonly<Record<string, unknown>>) {
        move = args;
      },
      say(args: Readonly<Record<string, unknown>>, context: unknown) {
        speech = args;
        const signal = (context as {signal: AbortSignal}).signal;
        return new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), {once: true}),
        );
      },
    },
  });
  try {
    await withDeadline(preview.start(), 'speech preview readiness', 2000);
    assert.equal(move?.seconds, 0);
    assert.equal(speech?.text, 'Hello');
    assert.equal(speech?.waitFor, 'advance');
    assert.equal(speech?.seconds, undefined);
    assert.equal(speech?.characterIntervalSeconds, undefined);
  } finally {
    await preview.dispose();
  }
});

test('abort cancels the active action and disposal releases the session once', async () => {
  const document = await story();
  const abort = new AbortController();
  let cancellations = 0;
  const preview = createDsl4BlockIconPreviewSession({
    storyDocument: document,
    sceneId: 'opening',
    actionPath: '/scenes/opening/actions/3',
    mode: 'action',
    signal: abort.signal,
    port: {
      stage() {},
      show() {},
      wait() {},
      moveTo(_args: Readonly<Record<string, unknown>>, context: unknown) {
        return new Promise<void>((resolve) =>
          (context as {signal: AbortSignal}).signal.addEventListener(
            'abort',
            () => {
              cancellations++;
              resolve();
            },
            {once: true},
          ),
        );
      },
    },
  });
  await withDeadline(preview.start(), 'abortable preview readiness', 2000);
  abort.abort();
  await preview.dispose();
  await preview.dispose();
  assert.equal(cancellations, 1);
});

test('scene replay keeps authored timing and stops before changing to another scene', async () => {
  const document = await story();
  const abort = new AbortController();
  const log: [string, unknown][] = [];
  const preview = createDsl4BlockIconPreviewSession({
    storyDocument: document,
    sceneId: 'opening',
    actionPath: null,
    mode: 'scene',
    signal: abort.signal,
    port: {
      hideSceneActors(args: Readonly<Record<string, unknown>>) {
        log.push(['scene', args.to]);
      },
      stage() {
        log.push(['stage', null]);
      },
      show() {},
      wait(args: Readonly<Record<string, unknown>>) {
        log.push(['wait', args.seconds]);
      },
      moveTo(args: Readonly<Record<string, unknown>>) {
        log.push(['move', args.seconds]);
      },
      say(args: Readonly<Record<string, unknown>>) {
        log.push(['say', args.seconds]);
      },
    },
  });
  try {
    await withDeadline(preview.start(), 'scene preview readiness', 2000);
    await withDeadline(preview.finished, 'scene preview completion', 2000);
    assert.deepEqual(log, [
      ['scene', 'opening'],
      ['stage', null],
      ['wait', 600],
      ['move', 2],
      ['say', 1],
      ['stage', null],
    ]);
  } finally {
    await preview.dispose();
  }
});

test('later-scene preview inherits prior backdrop and variable writes through real scene transitions', async () => {
  const {project} = fixture({
    ...source,
    variables: {score: 0},
    scenes: {
      opening: [{stage: 'Beach'}, {setVariable: {name: 'score', value: 7}}, {goto: 'ending'}],
      ending: [
        {'Hero.show': {skin: 'Skin', x: 10, y: 20, scale: 80}},
        {'Hero.say': {text: 'Inherited', seconds: 1}},
      ],
    },
  });
  const document = await story(project);
  let backdrop = '';
  let variables: unknown;
  const abort = new AbortController();
  const preview = createDsl4BlockIconPreviewSession({
    storyDocument: document,
    sceneId: 'ending',
    actionPath: '/scenes/ending/actions/1',
    mode: 'action',
    signal: abort.signal,
    port: {
      hideSceneActors() {},
      stage(args: Readonly<Record<string, unknown>>) {
        backdrop = String(args.backdrop);
      },
      show() {},
      say(_args: unknown, context: unknown) {
        variables = (context as {variables: unknown}).variables;
        return new Promise<void>((resolve) =>
          (context as {signal: AbortSignal}).signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
      },
    },
  });
  try {
    await withDeadline(preview.start(), 'inherited scene preview', 2000);
    assert.equal(backdrop, 'Beach');
    assert.equal((variables as Record<string, unknown>).score, 7);
  } finally {
    await preview.dispose();
  }
});

test('still speech readiness follows actual asynchronous Bubble rendering', async () => {
  const document = await story();
  const rendered = deferred();
  const abort = new AbortController();
  let speechStarted = false;
  let ready = false;
  const preview = createDsl4BlockIconPreviewSession({
    storyDocument: document,
    sceneId: 'opening',
    actionPath: '/scenes/opening/actions/4',
    mode: 'still',
    signal: abort.signal,
    waitForSpeechRendered: () => rendered.promise,
    port: {
      stage() {},
      show() {},
      wait() {},
      moveTo() {},
      say(_args: unknown, context: unknown) {
        speechStarted = true;
        return new Promise<void>((resolve) =>
          (context as {signal: AbortSignal}).signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
      },
    },
  });
  try {
    const opening = preview.start().then(() => {
      ready = true;
    });
    await waitUntil(() => speechStarted);
    assert.equal(ready, false);
    rendered.resolve(undefined);
    await withDeadline(opening, 'rendered bubble preview', 2000);
    assert.equal(ready, true);
  } finally {
    await preview.dispose();
  }
});

test('input-dependent earlier routes produce an explicit error instead of a guessed later-scene frame', async () => {
  const {project} = fixture({
    ...source,
    scenes: {
      opening: [{keyInputToChangeScene: {Enter: 'ending'}}],
      ending: [{'Hero.say': {text: 'Conditional', seconds: 1}}],
    },
  });
  const document = await story(project);
  const abort = new AbortController();
  const preview = createDsl4BlockIconPreviewSession({
    storyDocument: document,
    sceneId: 'ending',
    actionPath: '/scenes/ending/actions/0',
    mode: 'still',
    signal: abort.signal,
    port: {
      keyInputToChangeScene() {
        assert.fail('must not synthesize user input');
      },
      say() {},
    },
  });
  try {
    await assert.rejects(preview.start(), /入力や認識結果/);
  } finally {
    await preview.dispose();
  }
});

test('the VM snapshot disables block-ID compression before matching an editor reference', async () => {
  const {project, reference} = fixture();
  const marker = new Error('reached project asset capture');
  const calls: unknown[][] = [];
  const runtime = createDsl4BlockIconPreviewRuntime({
    sourceFrontend: frontend,
    createVm: () => assert.fail('VM construction must not precede asset capture'),
    vm: {
      runtime: {targets: [{id: 'stage', sprite: {name: 'Stage'}}]},
      toJSON(targetId?: string, options?: {allowOptimization?: boolean}) {
        calls.push([targetId, options]);
        const snapshot = structuredClone(project);
        if (options?.allowOptimization !== false) snapshot.targets[0]!.blocks = {};
        return JSON.stringify(snapshot);
      },
      saveProjectSb3DontZip() {
        throw marker;
      },
    },
  });
  await assert.rejects(
    runtime.open({
      mount: {} as HTMLElement,
      snapshot: reference('moveTo'),
      mode: 'action',
      signal: new AbortController().signal,
    }),
    (error: unknown) => error === marker,
  );
  assert.deepEqual(calls, [[undefined, {allowOptimization: false}]]);
});

test('an Editor without the isolated-VM capability is rejected before touching host VM state', async () => {
  let reads = 0;
  const runtime = createDsl4BlockIconPreviewRuntime({
    sourceFrontend: frontend,
    vm: new Proxy(
      {},
      {
        get() {
          reads++;
          throw new Error('host state must remain untouched');
        },
      },
    ),
  });
  await assert.rejects(
    runtime.open({
      mount: {} as HTMLElement,
      snapshot: {targetId: 'stage', blockId: 'block', opcode: 'scene'},
      mode: 'still',
      signal: new AbortController().signal,
    }),
    /TurboWarp Plus Editorを更新/,
  );
  assert.equal(reads, 0);
});

test('the preview asset factory forwards features and options with the isolated runtime', () => {
  const isolatedRuntime = {id: 'isolated', renderer: {}, targets: []};
  const hostRuntime = {id: 'host'};
  const calls: unknown[][] = [];
  const result = {};
  const factory = Object.assign(
    (...args: unknown[]) => {
      calls.push(args);
      return result;
    },
    {supportsRuntimeIsolation: true},
  );
  const create = createDsl4IsolatedPreviewAssetManager(
    isolatedRuntime,
    factory as unknown as Parameters<typeof createDsl4IsolatedPreviewAssetManager>[1],
  );
  const features = {
    ENABLE_LIVE_ASSET_REPLACEMENT: true,
    ENABLE_STRICT_ASSET_KIND_REPLACEMENT: true,
    NAMED_ASSET_BODY_PROVIDER: false,
  };
  const options = {verifiedRemoteCache: {namespace: 'test'}, runtime: hostRuntime};
  assert.equal(create(features, options as unknown as Parameters<typeof create>[1]), result);
  assert.deepEqual(calls, [[features, {...options, runtime: isolatedRuntime}]]);
  assert.equal(options.runtime, hostRuntime);
});

test('a legacy asset factory is rejected without invoking its global-runtime constructor', () => {
  let calls = 0;
  const factory = () => {
    calls++;
    throw new Error('legacy constructor must never run');
  };
  assert.throws(
    () =>
      createDsl4IsolatedPreviewAssetManager(
        {},
        factory as unknown as Parameters<typeof createDsl4IsolatedPreviewAssetManager>[1],
      ),
    /素材キャッシュを更新/,
  );
  assert.equal(calls, 0);
});

test('stopping a completed action retains presentation assets until the preview is disposed', async () => {
  const document = await story();
  let releases = 0;
  const preview = createDsl4BlockIconPreviewSession({
    storyDocument: document,
    sceneId: 'opening',
    actionPath: '/scenes/opening/actions/1',
    mode: 'still',
    signal: new AbortController().signal,
    port: {stage() {}, show() {}},
    assetLifecycle: {
      prepare() {},
      setLoading() {},
      releaseAssets() {},
      release() {
        releases++;
      },
    },
  });
  await preview.start();
  await preview.finished;
  assert.equal(releases, 0);
  await preview.dispose();
  await preview.dispose();
  assert.equal(releases, 1);
});

test('styled static speech renders the full text silently with no reveal, motion or indicator timers', async () => {
  const document = {
    kind: 'StoryDocument',
    version: '4.0',
    scenes: [],
    bubbleStyles: {
      dialogue: {
        textStyle: 'dialogue-text',
        placement: 'up-right',
        visualStyle: 'WAVY',
        reveal: {unit: 'CHARACTER', intervalSeconds: 0.04},
        audio: {voice: 'Voice', reveal: 'Tick', finish: 'Finish'},
        continueIndicator: {frames: ['Next1', 'Next2'], frameIntervalSeconds: 0.1},
        portrait: {
          base: 'Face',
          blink: {frames: ['FaceBlink1', 'FaceBlink2'], frameIntervalSeconds: 0.1},
          lipSync: {frames: ['Lip1', 'Lip2'], frameIntervalSeconds: 0.1},
        },
        showAnimation: {name: 'fadeIn', durationSeconds: 0.2},
        hideAnimation: {name: 'fadeOut', durationSeconds: 0.1},
      },
    },
  };
  const before = structuredClone(document);
  async function render(storyDocument: Readonly<Record<string, unknown>>) {
    const texts: string[] = [];
    const sounds: unknown[] = [];
    let timers = 0;
    let motions = 0;
    let layout = '';
    const textCapability = {
      setText(input: {text: string}) {
        texts.push(input.text);
      },
      releaseTarget() {},
      measureText(input: {text: string}) {
        return input.text.length * 8;
      },
    };
    const assets = {
      isRegistered: () => true,
      getMimeType(name: unknown) {
        return ['Next', 'Face', 'Lip'].some((prefix) => String(name).startsWith(prefix))
          ? 'image/png'
          : 'audio/wav';
      },
      applyToTarget() {},
      async playSound(name: unknown) {
        sounds.push(name);
      },
    };
    const platform = createDsl4BubblePlatform({
      runtime: {renderer: {}},
      storyDocument,
      assetManager: assets,
      textCapability,
      createComposition() {
        return createBubbleComposition({
          textCapability,
          imageResolver: assets,
          audio: assets,
          scheduler: {
            setTimeout() {
              timers++;
              return 0;
            },
            clearTimeout() {},
          },
          createSurface(input) {
            layout = input.style.layoutProfile;
            return {
              targets: {
                text: {},
                continueIndicator: {id: 'indicator', isStage: false},
                portraitBase: {id: 'portrait', isStage: false},
                portraitBlink: {id: 'blink', isStage: false},
                portraitLipSync: {id: 'lip', isStage: false},
              },
              setLayerVisible() {},
              updateStyle() {},
              show() {},
              hide() {},
              dispose() {},
              animate() {
                motions++;
              },
            };
          },
        });
      },
    });
    await platform.composition.show({
      actor: {},
      actorKey: 'hero',
      kind: 'say',
      text: 'Full static text',
      styleName: 'dialogue',
      animationMode: 'awaiting-continue',
    });
    const result = {text: texts.at(-1), timers, sounds: sounds.length, motions, layout};
    await platform.releaseAll();
    return result;
  }
  const live = createDsl4BlockIconPreviewPresentation(document, 'action');
  assert.equal(live, document);
  const playing = await render(live);
  assert.notEqual(playing.text, 'Full static text');
  assert.ok(playing.timers > 0);
  assert.ok(playing.sounds > 0);
  assert.ok(playing.motions > 0);
  assert.deepEqual(await render(createDsl4BlockIconPreviewPresentation(document, 'still')), {
    text: 'Full static text',
    timers: 0,
    sounds: 0,
    motions: 0,
    layout: 'custom',
  });
  const minimal = {
    ...document,
    bubbleStyles: {dialogue: {reveal: {unit: 'CHARACTER', intervalSeconds: 0.04}}},
  };
  assert.equal((await render(minimal)).layout, 'custom');
  assert.deepEqual(await render(createDsl4BlockIconPreviewPresentation(minimal, 'still')), {
    text: 'Full static text',
    timers: 0,
    sounds: 0,
    motions: 0,
    layout: 'custom',
  });
  const fragments = createDsl4BlockIconPreviewPresentation(
    {
      ...minimal,
      bubbleStyles: {
        wavy: {visualStyle: 'WAVY', maxWidth: 240},
        dialogue: {reveal: {unit: 'CHARACTER', intervalSeconds: 0.04}},
      },
    },
    'still',
  );
  const effective = composeBubbleStyles(
    ['wavy', 'dialogue'],
    fragments.bubbleStyles as Record<string, Record<string, unknown>>,
  );
  assert.equal(effective.visualStyle, 'WAVY');
  assert.equal(effective.maxWidth, 240);
  assert.deepEqual(await render({...fragments, bubbleStyles: {dialogue: effective}}), {
    text: 'Full static text',
    timers: 0,
    sounds: 0,
    motions: 0,
    layout: 'custom',
  });
  assert.deepEqual(document, before);
});
