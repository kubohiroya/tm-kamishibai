import assert from 'node:assert/strict';
import {test, vi} from 'vitest';
import {
  resolveDsl4Viewport,
  computeDsl4ViewportTransform,
  applyDsl4Viewport,
} from '../src/dsl4/viewport.js';
import {dsl4TestSourceFrontend as frontend} from './helpers/dsl4-test-frontend.ts';
test('keeps an undeclared DSL4 viewport at 480x360 without a new switch', () => {
  assert.deepEqual(resolveDsl4Viewport(), {
    width: 480,
    height: 360,
    orientation: 'landscape',
    fit: 'contain',
  });
  assert.equal(frontend.parse("kamishibai: '4.0'\nscenes:\n  opening: []\n").ok, true);
  assert.doesNotThrow(() => applyDsl4Viewport({}, undefined));
});
test('parses portrait viewport declarations and rejects invalid orientation and budgets', () => {
  const parse = (body: string) =>
    frontend.parse(`kamishibai: '4.0'\nviewport: ${body}\nscenes:\n  opening: []\n`);
  const result = parse('{width: 360, height: 640, orientation: portrait, fit: cover}');
  assert.equal(result.ok, true);
  if (result.ok)
    assert.deepEqual(result.storyDocument.viewport, {
      width: 360,
      height: 640,
      orientation: 'portrait',
      fit: 'cover',
    });
  for (const body of [
    '{width: 360, height: 640, orientation: landscape}',
    '{width: 0, height: 640}',
    '{width: 4096, height: 4096}',
    '{width: 360, height: 640, adaptive: true}',
  ])
    assert.equal(parse(body).ok, false);
});
for (const fit of ['contain', 'cover'] as const)
  test(`shares centered transforms and pointer coordinates for ${fit}, safe area and orientation changes`, () => {
    const viewport = resolveDsl4Viewport({width: 360, height: 640, fit});
    for (const bounds of [
      {x: 30, y: 10, width: 1000, height: 600},
      {x: 10, y: 50, width: 420, height: 1000},
    ]) {
      const transform = computeDsl4ViewportTransform(viewport, bounds, {
        left: 20,
        right: 10,
        top: 15,
        bottom: 5,
      });
      for (const [x, y] of [
        [0, 0],
        [40, -50],
        [-100, 120],
      ]) {
        const client = transform.toClient(x!, y!);
        const stage = transform.toStage(client.x, client.y);
        assert(Math.abs(stage.x - x!) < 1e-9);
        assert(Math.abs(stage.y - y!) < 1e-9);
      }
      assert.equal(transform.toStage(bounds.x, bounds.y).inside, false);
      assert.equal(
        transform.toStage(...(Object.values(transform.toClient(0, 0)) as [number, number])).inside,
        true,
      );
    }
  });
test('updates native stage size for WebGL, overlays and VM input together', () => {
  const setStageSize = vi.fn();
  applyDsl4Viewport({setStageSize}, {width: 360, height: 640});
  assert.deepEqual(setStageSize.mock.calls, [[360, 640]]);
  assert.throws(() => applyDsl4Viewport({}, {width: 360, height: 640}), /native stage/u);
  assert.throws(
    () => computeDsl4ViewportTransform(resolveDsl4Viewport(), {width: 1, height: 1}, {left: 1}),
    /safe area/u,
  );
});

test('keeps newer viewport owners active while older preview owners dispose, and retries native resize failure', async () => {
  const {createDsl4ViewportOwner} = await import('../src/dsl4/viewport.js');
  const runtime = {
    stageWidth: 480,
    stageHeight: 360,
    setStageSize(width: number, height: number) {
      this.stageWidth = width;
      this.stageHeight = height;
    },
  };
  const first = createDsl4ViewportOwner(runtime, {width: 360, height: 640});
  first.activate();
  const next = createDsl4ViewportOwner(runtime, {width: 960, height: 540});
  next.activate();
  first.dispose();
  assert.equal(runtime.stageWidth, 960);
  const resize = runtime.setStageSize;
  let fail = true;
  runtime.setStageSize = function (width, height) {
    if (fail) throw new Error('native resize failed');
    resize.call(this, width, height);
  };
  assert.throws(() => next.dispose(), /native resize failed/u);
  assert.equal(runtime.stageWidth, 960);
  fail = false;
  next.dispose();
  assert.deepEqual([runtime.stageWidth, runtime.stageHeight], [480, 360]);
});

test('parses the portable portrait/front/background fixture', async () => {
  const {readFile} = await import('node:fs/promises');
  const source = await readFile(
    new URL('./fixtures/dsl4/viewport-portrait.kamishibai.yaml', import.meta.url),
    'utf8',
  );
  const result = frontend.parse(source);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});
