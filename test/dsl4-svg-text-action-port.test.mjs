import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createDsl4SvgTextPlatform} from '../src/dsl4/platform/index.js';
import {createDsl4RuntimeController} from '../src/dsl4/runtime-controller.js';

function storyDocument(textStyles = {}) {
  return {kind: 'StoryDocument', version: '4.0', textStyles};
}

function fakeRuntime() {
  const created = [];
  const destroyed = [];
  const updates = [];
  let nextSkinId = 1;
  let redraws = 0;
  return {
    created,
    destroyed,
    updates,
    getRedraws: () => redraws,
    runtime: {
      renderer: {
        createSVGSkin(svg) {
          created.push(svg);
          return nextSkinId++;
        },
        destroySkin(skinId) {
          destroyed.push(skinId);
        },
        getNativeSize() {
          return [480, 360];
        },
        updateDrawableSkinId(drawableId, skinId) {
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

test('maps StoryDocument styles and renders text through the direct composition API', async () => {
  const fake = fakeRuntime();
  const hero = actor();
  const resolved = [];
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
    resolveActor(actorId, actionContext) {
      resolved.push([actorId, actionContext.sceneId]);
      return hero;
    },
  });

  await platform.port.setText(
    {target: 'Hero', text: 'おしまい\nまたね', style: 'title'},
    context(),
  );

  assert.equal(platform.enabled, true);
  assert.equal(Object.isFrozen(platform), true);
  assert.equal(Object.isFrozen(platform.port), true);
  assert.deepEqual(resolved, [['Hero', 'opening']]);
  assert.deepEqual(fake.updates, [[7, 1]]);
  assert.equal(fake.getRedraws(), 1);
  assert.match(fake.created[0], /fill="#112233"/u);
  assert.match(fake.created[0], /fill="#ffffff"/u);
  assert.match(fake.created[0], /font-family="Noto Sans JP"/u);
  assert.match(fake.created[0], /font-size="21"/u);
  assert.match(fake.created[0], /text-anchor="middle"/u);
  assert.match(fake.created[0], /おしまい/u);
  assert.match(fake.created[0], /またね/u);
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
  assert.equal(controller.getTrace().filter(({type}) => type === 'action.commit').length, 1);
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

  await platform.port.setText({target: 'Caption', text: 'first', style: 'default'}, context());
  await platform.port.setText({target: 'Caption', text: 'second', style: 'default'}, context());
  assert.deepEqual(fake.destroyed, [1]);

  currentTarget = secondTarget;
  await platform.port.setText({target: 'Caption', text: 'third', style: 'default'}, context());
  assert.deepEqual(fake.destroyed, [1, 2]);
  platform.releaseTarget('Caption');
  assert.deepEqual(fake.destroyed, [1, 2, 3]);
  assert.throws(
    () => platform.releaseTarget('Caption'),
    (error) => error.code === 'K4-SVG-TEXT-005',
  );

  currentTarget = firstTarget;
  await platform.port.setText({target: 'Caption', text: 'fourth', style: 'default'}, context());
  platform.releaseAll();
  platform.releaseAll();
  assert.deepEqual(fake.destroyed, [1, 2, 3, 4]);
  await assert.rejects(
    platform.port.setText({target: 'Caption', text: 'later', style: 'default'}, context()),
    (error) => error.code === 'K4-SVG-TEXT-006',
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

  await first.port.setText({target: 'Hero', text: 'first', style: 'shared'}, context());
  await second.port.setText({target: 'Hero', text: 'second', style: 'shared'}, context());
  assert.match(firstFake.created[0], /fill="#ff0000"/u);
  assert.match(secondFake.created[0], /fill="#0000ff"/u);

  await assert.rejects(
    first.port.setText({target: 'Hero', text: 'bad', style: 'missing'}, context()),
    (error) => error.code === 'K4-SVG-TEXT-002',
  );
  await assert.rejects(
    first.port.setText({target: 'Hero', text: 1, style: 'shared'}, context()),
    (error) => error.code === 'K4-SVG-TEXT-001',
  );
  const cancelled = new AbortController();
  cancelled.abort('advance');
  await assert.rejects(
    first.port.setText({target: 'Hero', text: 'cancelled', style: 'shared'}, context(cancelled)),
    (error) => error.name === 'AbortError',
  );
  assert.equal(firstFake.created.length, 1);

  first.releaseAll();
  assert.deepEqual(firstFake.destroyed, [1]);
  assert.deepEqual(secondFake.destroyed, []);
  second.releaseAll();
});

test('contains late actor resolution and validates the resolved TurboWarp target', async () => {
  const fake = fakeRuntime();
  let resolveActor;
  const actorPromise = new Promise((resolve) => {
    resolveActor = resolve;
  });
  const platform = createDsl4SvgTextPlatform({
    enabled: true,
    runtime: fake.runtime,
    storyDocument: storyDocument(),
    resolveActor: () => actorPromise,
  });
  const controller = new AbortController();
  const pending = platform.port.setText(
    {target: 'Hero', text: 'late', style: 'default'},
    context(controller),
  );
  controller.abort('navigate');
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  resolveActor(actor());
  await Promise.resolve();
  assert.deepEqual(fake.created, []);

  const invalid = createDsl4SvgTextPlatform({
    enabled: true,
    runtime: fake.runtime,
    storyDocument: storyDocument(),
    resolveActor: () => ({id: 'stage', isStage: true, drawableID: 0}),
  });
  await assert.rejects(
    invalid.port.setText({target: 'Hero', text: 'bad', style: 'default'}, context()),
    (error) => error.code === 'K4-SVG-TEXT-003',
  );
  platform.releaseAll();
  invalid.releaseAll();
});
