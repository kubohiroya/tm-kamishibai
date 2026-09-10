import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4SvgTextPlatform} from '../src/dsl4/platform/index.js';
import {createDsl4RuntimeController} from '../src/dsl4/runtime-controller.js';
import {thrown} from './helpers/thrown-error.ts';
import {requireDefined, requireRecord} from './helpers/require-value.ts';

function storyDocument(textStyles = {}) {
  return {kind: 'StoryDocument', version: '4.0', textStyles};
}

/**
 * Read the `setText` the platform installs when it is enabled.
 *
 * The port is declared as the empty object when the platform is off, which is what the disabled
 * case asserts; every other case has just asked for the enabled platform.
 */
function setText(platform: {port: unknown}) {
  return requireDefined(
    (platform.port as {setText?: (payload: unknown, context: unknown) => Promise<void>}).setText,
    'the setText port method',
  );
}

function fakeRuntime() {
  const created: string[] = [];
  const destroyed: number[] = [];
  const updates: [number, number][] = [];
  let nextSkinId = 1;
  let redraws = 0;
  return {
    created,
    destroyed,
    updates,
    getRedraws: () => redraws,
    runtime: {
      renderer: {
        createSVGSkin(svg: string) {
          created.push(svg);
          return nextSkinId++;
        },
        destroySkin(skinId: number) {
          destroyed.push(skinId);
        },
        getNativeSize() {
          return [480, 360];
        },
        updateDrawableSkinId(drawableId: number, skinId: number) {
          updates.push([drawableId, skinId]);
        },
      },
      requestRedraw() {
        redraws += 1;
      },
    },
  };
}

function actor(id = 'hero-target', drawableID = 7) {
  return {id, isStage: false, drawableID};
}

function context(controller = new AbortController()) {
  return {signal: controller.signal, generation: 1, sceneId: 'opening'};
}

test('defaults OFF without inspecting runtime dependencies or registering blocks', () => {
  let factoryCalls = 0;
  const platform = createDsl4SvgTextPlatform({
    runtime: new Proxy({}, {get: () => assert.fail('runtime must not be read')}),
    storyDocument: new Proxy({}, {get: () => assert.fail('story must not be read')}),
    resolveActor: new Proxy(() => {}, {apply: () => assert.fail('resolver must not be called')}),
    createComposition() {
      factoryCalls += 1;
    },
  });

  assert.equal(factoryCalls, 0);
  assert.equal(platform.enabled, false);
  assert.deepEqual(Object.keys(platform.port), []);
  assert.equal(platform.composition, null);
  assert.equal(Object.isFrozen(platform), true);
  platform.releaseAll();
});

test('renders ruby through the rich composition and keeps plain text on the simple path', async () => {
  const fake = fakeRuntime();
  const caption = actor('caption-target', 9);
  const platform = createDsl4SvgTextPlatform({
    enabled: true,
    runtime: fake.runtime,
    storyDocument: storyDocument({
      body: {
        background: '#000000',
        color: '#ffffff',
        font: 'Noto Sans JP',
        size: 100,
        align: 'center',
      },
    }),
    resolveActor() {
      return caption;
    },
  });

  // A plain string keeps the existing layout path.
  await setText(platform)({target: 'Caption', text: 'ただの文', style: 'body'}, context());
  const plain = requireDefined(fake.created[0], 'the plain skin');
  assert.match(plain, /ただの文/u);

  // Ruby reaches the rich renderer, so both the base and the reading appear in the SVG.
  await setText(platform)(
    {
      target: 'Caption',
      text: ['むかし', {ruby: {base: '竹取', reading: 'たけとり'}}, 'の翁'],
      style: 'body',
    },
    context(),
  );
  const ruby = requireDefined(fake.created[1], 'the ruby skin');
  assert.match(ruby, /竹取/u);
  assert.match(ruby, /たけとり/u);
  assert.match(ruby, /むかし/u);
  assert.match(ruby, /の翁/u);
});

test('maps StoryDocument styles and renders text through the direct composition API', async () => {
  const fake = fakeRuntime();
  const hero = actor();
  const resolved: [string, unknown][] = [];
  const platform = createDsl4SvgTextPlatform({
    enabled: true,
    runtime: fake.runtime,
    storyDocument: storyDocument({
      title: {
        background: '#112233',
        color: '#ffffff',
        font: 'Noto Sans JP',
        size: 150,
        align: 'center',
      },
    }),
    resolveActor(actorId: string, actionContext: Readonly<Record<string, unknown>>) {
      resolved.push([actorId, actionContext.sceneId]);
      return hero;
    },
  });

  await setText(platform)({target: 'Hero', text: 'おしまい\nまたね', style: 'title'}, context());

  assert.equal(platform.enabled, true);
  assert.equal(Object.isFrozen(platform), true);
  assert.equal(Object.isFrozen(platform.port), true);
  assert.deepEqual(resolved, [['Hero', 'opening']]);
  assert.deepEqual(fake.updates, [[7, 1]]);
  assert.equal(fake.getRedraws(), 1);
  assert.match(requireDefined(fake.created[0], 'the created skin'), /fill="#112233"/u);
  assert.match(requireDefined(fake.created[0], 'the created skin'), /fill="#ffffff"/u);
  assert.match(requireDefined(fake.created[0], 'the created skin'), /font-family="Noto Sans JP"/u);
  assert.match(requireDefined(fake.created[0], 'the created skin'), /font-size="21"/u);
  assert.match(requireDefined(fake.created[0], 'the created skin'), /text-anchor="middle"/u);
  assert.match(requireDefined(fake.created[0], 'the created skin'), /おしまい/u);
  assert.match(requireDefined(fake.created[0], 'the created skin'), /またね/u);
});

test('executes Actor.setText from the DSL 4.0 controller without a block port', async () => {
  const fake = fakeRuntime();
  const hero = actor();
  const document = {
    ...storyDocument({title: {color: '#ffffff'}}),
    variables: {},
    branches: {},
    scenes: [
      {
        id: 'opening',
        actions: [
          {
            id: '/scenes/opening/actions/0',
            command: 'setText',
            target: 'Caption',
            args: {text: 'おしまい', style: 'title'},
          },
        ],
      },
    ],
    sourceMap: {'/': {start: {line: 1, column: 1}, end: {line: 1, column: 1}}},
    metadata: {sourceId: 'main'},
  };
  const platform = createDsl4SvgTextPlatform({
    enabled: true,
    runtime: fake.runtime,
    storyDocument: document,
    resolveActor: () => hero,
  });
  const controller = createDsl4RuntimeController({
    storyDocument: document,
    port: platform.port,
  });

  const state = await controller.start();

  assert.equal(state.status, 'finished');
  assert.deepEqual(fake.updates, [[7, 1]]);
  assert.equal(
    controller
      .getTrace()
      .filter((entry) => requireRecord(entry, 'a trace entry').type === 'action.commit').length,
    1,
  );
  platform.releaseAll();
});

test('replaces skins, releases actor ownership, and finalizes once', async () => {
  const fake = fakeRuntime();
  const firstTarget = actor('first-target', 10);
  const secondTarget = actor('second-target', 20);
  let currentTarget = firstTarget;
  const platform = createDsl4SvgTextPlatform({
    enabled: true,
    runtime: fake.runtime,
    storyDocument: storyDocument(),
    resolveActor() {
      return currentTarget;
    },
  });

  await setText(platform)({target: 'Caption', text: 'first', style: 'default'}, context());
  await setText(platform)({target: 'Caption', text: 'second', style: 'default'}, context());
  assert.deepEqual(fake.destroyed, [1]);

  currentTarget = secondTarget;
  await setText(platform)({target: 'Caption', text: 'third', style: 'default'}, context());
  assert.deepEqual(fake.destroyed, [1, 2]);
  platform.releaseTarget('Caption');
  assert.deepEqual(fake.destroyed, [1, 2, 3]);
  assert.throws(
    () => platform.releaseTarget('Caption'),
    (error) => thrown(error).code === 'K4-SVG-TEXT-005',
  );

  currentTarget = firstTarget;
  await setText(platform)({target: 'Caption', text: 'fourth', style: 'default'}, context());
  platform.releaseAll();
  platform.releaseAll();
  assert.deepEqual(fake.destroyed, [1, 2, 3, 4]);
  await assert.rejects(
    setText(platform)({target: 'Caption', text: 'later', style: 'default'}, context()),
    (error) => thrown(error).code === 'K4-SVG-TEXT-006',
  );
});

test('keeps compositions isolated and rejects malformed or cancelled actions', async () => {
  const firstFake = fakeRuntime();
  const secondFake = fakeRuntime();
  const firstTarget = actor('first-target', 1);
  const secondTarget = actor('second-target', 2);
  const first = createDsl4SvgTextPlatform({
    enabled: true,
    runtime: firstFake.runtime,
    storyDocument: storyDocument({shared: {color: '#ff0000'}}),
    resolveActor: () => firstTarget,
  });
  const second = createDsl4SvgTextPlatform({
    enabled: true,
    runtime: secondFake.runtime,
    storyDocument: storyDocument({shared: {color: '#0000ff'}}),
    resolveActor: () => secondTarget,
  });

  await setText(first)({target: 'Hero', text: 'first', style: 'shared'}, context());
  await setText(second)({target: 'Hero', text: 'second', style: 'shared'}, context());
  assert.match(requireDefined(firstFake.created[0], 'the created skin'), /fill="#ff0000"/u);
  assert.match(requireDefined(secondFake.created[0], 'the created skin'), /fill="#0000ff"/u);

  await assert.rejects(
    setText(first)({target: 'Hero', text: 'bad', style: 'missing'}, context()),
    (error) => thrown(error).code === 'K4-SVG-TEXT-002',
  );
  await assert.rejects(
    setText(first)({target: 'Hero', text: 1, style: 'shared'}, context()),
    (error) => thrown(error).code === 'K4-SVG-TEXT-001',
  );
  const cancelled = new AbortController();
  cancelled.abort('advance');
  await assert.rejects(
    setText(first)({target: 'Hero', text: 'cancelled', style: 'shared'}, context(cancelled)),
    (error) => thrown(error).name === 'AbortError',
  );
  assert.equal(firstFake.created.length, 1);

  first.releaseAll();
  assert.deepEqual(firstFake.destroyed, [1]);
  assert.deepEqual(secondFake.destroyed, []);
  second.releaseAll();
});

test('contains late actor resolution and validates the resolved TurboWarp target', async () => {
  const fake = fakeRuntime();
  let resolveActor: ((target: unknown) => void) | undefined;
  const actorPromise = new Promise<unknown>((resolve) => {
    resolveActor = resolve;
  });
  const platform = createDsl4SvgTextPlatform({
    enabled: true,
    runtime: fake.runtime,
    storyDocument: storyDocument(),
    resolveActor: () => actorPromise,
  });
  const controller = new AbortController();
  const pending = setText(platform)(
    {target: 'Hero', text: 'late', style: 'default'},
    context(controller),
  );
  controller.abort('navigate');
  await assert.rejects(pending, (error) => thrown(error).name === 'AbortError');
  requireDefined(resolveActor, 'the late actor resolution')(actor());
  await Promise.resolve();
  assert.deepEqual(fake.created, []);

  const invalid = createDsl4SvgTextPlatform({
    enabled: true,
    runtime: fake.runtime,
    storyDocument: storyDocument(),
    resolveActor: () => ({id: 'stage', isStage: true, drawableID: 0}),
  });
  await assert.rejects(
    setText(invalid)({target: 'Hero', text: 'bad', style: 'default'}, context()),
    (error) => thrown(error).code === 'K4-SVG-TEXT-003',
  );
  platform.releaseAll();
  invalid.releaseAll();
});
