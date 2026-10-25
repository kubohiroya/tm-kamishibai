import assert from 'node:assert/strict';
import {test} from 'vitest';
import {decodeDsl4SaveData, encodeDsl4SaveBlob, decodeDsl4SaveBlob} from '../src/dsl4/save-data.js';

export function savedFixture() {
  return {
    formatVersion: 1,
    dslVersion: '4.0',
    storyId: 'story',
    sourceIntegrity: `sha256-${'a'.repeat(43)}=`,
    savedAt: '2026-10-25T00:00:00.000Z',
    runtime: {
      sceneId: 'opening',
      actionIndex: 1,
      variables: {score: 2, seen: true, name: '主人公'},
      status: 'paused',
      history: {
        mode: 'live',
        actionEntries: [],
        sceneVisits: [
          {
            visitId: 1,
            sceneId: 'opening',
            storyPath: '/scenes/opening',
            firstActionHistoryIndex: 0,
            enteredSequence: 0,
          },
        ],
        actionCursor: 0,
        sceneVisitCursor: 0,
        currentVisitId: 1,
        nextVisitId: 2,
        lastSequence: 0,
      },
    },
    presentation: {
      videos: [
        {
          display: {
            id: 'clip',
            asset: 'Movie',
            x: 20,
            y: -30,
            width: 180,
            height: 320,
            plane: 'background',
            zIndex: -2,
            fit: 'cover',
          },
          time: 2,
          paused: false,
          loop: true,
          volume: 35,
          muted: false,
          rate: 1.25,
        },
      ],
    },
  };
}
test('round trips a portable save Blob without transient URLs', async () => {
  const input = savedFixture();
  const blob = encodeDsl4SaveBlob(input);
  assert.deepEqual(await decodeDsl4SaveBlob(blob), input);
  assert.equal(Object.isFrozen(decodeDsl4SaveData(input).runtime.variables), true);
  assert.doesNotMatch(await blob.text(), /blob:/u);
});
test('rejects unknown envelope/runtime/video fields and future versions', () => {
  const input = savedFixture();
  for (const bad of [
    {...input, formatVersion: 2},
    {...input, unknown: true},
    {...input, dslVersion: '4.1'},
    {...input, runtime: {...input.runtime, unknown: true}},
    {...input, presentation: {videos: [{...input.presentation.videos[0], unknown: true}]}},
  ])
    assert.throws(() => decodeDsl4SaveData(bad));
});
test('rejects source revisions instead of silently migrating saves', () => {
  const input = savedFixture();
  assert.throws(
    () =>
      decodeDsl4SaveData(input, {
        identity: {storyId: 'other', sourceIntegrity: input.sourceIntegrity},
      }),
    /different story/u,
  );
  assert.throws(
    () =>
      decodeDsl4SaveData(input, {
        identity: {storyId: input.storyId, sourceIntegrity: `sha256-${'b'.repeat(43)}=`},
      }),
    /source revision/u,
  );
});
test('enforces Blob bytes, entry count and depth before restore', async () => {
  const input = savedFixture();
  assert.throws(() => decodeDsl4SaveData(input, {maxBytes: 10}), /byte limit/u);
  assert.throws(() => decodeDsl4SaveData(input, {maxEntries: 3}), /entry\/depth/u);
  assert.throws(() => decodeDsl4SaveData(input, {maxDepth: 2}), /entry\/depth/u);
  await assert.rejects(
    decodeDsl4SaveBlob(new Blob(['x'.repeat(100)]), {maxBytes: 10}),
    /byte limit/u,
  );
  await assert.rejects(decodeDsl4SaveBlob(new Blob(['{'])), /valid JSON/u);
});
test('rejects object URLs, duplicate videos, invalid settings and nonfinite state', () => {
  const input = savedFixture(),
    video = input.presentation.videos[0]!;
  for (const videos of [
    [{...video, display: {...video.display, asset: undefined, url: 'blob:transient'}}],
    [video, video],
    [{...video, time: NaN}],
    [{...video, volume: 101}],
    [{...video, rate: 0}],
    [{...video, display: {...video.display, width: -1}}],
  ])
    assert.throws(() => decodeDsl4SaveData({...input, presentation: {videos}}));
});
test('rejects getters and cycles without invoking untrusted accessors', () => {
  const input = savedFixture();
  let calls = 0;
  const unsafe = {
    ...input,
    get extra() {
      calls++;
      return true;
    },
  };
  assert.throws(() => decodeDsl4SaveData(unsafe), /accessors/u);
  assert.equal(calls, 0);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => decodeDsl4SaveData({...input, presentation: cycle}), /finite JSON/u);
});

test('rejects sparse arrays, hidden properties and transient variable handles', () => {
  const save = savedFixture();
  const sparse: unknown[] = [];
  sparse.length = 2;
  assert.throws(() => decodeDsl4SaveData({...save, presentation: {videos: sparse}}), /dense/u);
  const hidden = {...save};
  Object.defineProperty(hidden, 'extra', {value: 1});
  assert.throws(() => decodeDsl4SaveData(hidden), /nonenumerable/u);
  assert.throws(
    () =>
      decodeDsl4SaveData({...save, runtime: {...save.runtime, variables: {score: '@os1.handle'}}}),
    /handles/u,
  );
});
