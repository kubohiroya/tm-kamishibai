import assert from 'node:assert/strict';
import {test} from 'vitest';

import {createFakeDocument} from './helpers/fake-dom.ts';
import {
  createDsl4UserMediaGate,
  supportsDsl4UserMediaGate,
} from '../src/dsl4/platform/user-media-gate.ts';

function requireChild(element: {children: {tagName: string; textContent: string}[]}) {
  const [child] = element.children;
  assert(child, 'the gate must keep its button');
  return child;
}

function gateFixture(
  overrides: {
    adopt?: (stream: unknown) => unknown;
    constraints?: Record<string, unknown>;
  } = {},
) {
  const document = createFakeDocument();
  const container = document.createElement('div');
  const outcomes: Array<{outcome: string; detail: unknown}> = [];
  const adopted: unknown[] = [];
  const gate = createDsl4UserMediaGate({
    document,
    container,
    labels: {prompt: 'カメラを準備する', working: '準備しています…', retry: 'もう一度試す'},
    ...(overrides.constraints === undefined ? {} : {constraints: overrides.constraints}),
    adopt:
      overrides.adopt ??
      ((stream: unknown) => {
        adopted.push(stream);
      }),
    onOutcome: (outcome, detail) => outcomes.push({outcome, detail}),
  });
  const element = gate.element as unknown as ReturnType<typeof document.createElement>;
  return {adopted, container, document, element, gate, outcomes};
}

test('asks with a button inside the element, as the capability element requires', () => {
  const {container, element} = gateFixture({constraints: {video: {width: 640}}});

  assert.equal(container.children.length, 1);
  assert.equal(container.children[0], element);
  assert.equal(element.tagName, 'USERMEDIA');
  assert.equal(element.getAttribute('data-dsl4-user-media-gate'), 'true');
  // The prompt only appears after a tap on a browser-controlled element, and that element is the
  // button the page puts inside. Without it there is nothing to tap.
  assert.equal(element.children.length, 1);
  assert.equal(requireChild(element).tagName, 'BUTTON');
  assert.equal(requireChild(element).textContent, 'カメラを準備する');
});

test('hands the granted stream over once and then stops asking', async () => {
  const {adopted, element, gate, outcomes} = gateFixture();
  const stream = {id: 'granted'};
  (element as unknown as {stream: unknown}).stream = stream;

  element.dispatch('stream');
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(adopted, [stream]);
  assert.deepEqual(
    outcomes.map(({outcome}) => outcome),
    ['granted'],
  );
  assert.equal(element.style.display, 'none');

  // A second event cannot hand the same stream over twice.
  element.dispatch('stream');
  await Promise.resolve();
  assert.deepEqual(adopted, [stream]);
  gate.dispose();
});

/**
 * A stand-in for what `<usermedia>` answers with: a camera track and the microphone track the
 * element adds whether or not the story asked for one.
 */
function fakeStream() {
  const audio = {
    kind: 'audio',
    stopped: false,
    stop() {
      audio.stopped = true;
    },
  };
  const video = {
    kind: 'video',
    stopped: false,
    stop() {
      video.stopped = true;
    },
  };
  const tracks: Array<{kind: string; stopped: boolean; stop(): void}> = [video, audio];
  return {
    audio,
    video,
    tracks,
    getTracks: () => [...tracks],
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
    removeTrack(track: unknown) {
      const index = tracks.indexOf(track as (typeof tracks)[number]);
      if (index >= 0) tracks.splice(index, 1);
    },
  };
}

test('stops the microphone the element adds and keeps the camera untouched', async () => {
  const {adopted, element} = gateFixture();
  const stream = fakeStream();
  (element as unknown as {stream: unknown}).stream = stream;

  element.dispatch('stream');
  await Promise.resolve();
  await Promise.resolve();

  // The prompt names the microphone and nothing can ask it away, so the element's answer carries
  // one. By the time the story has the stream it is stopped and gone from the track list.
  assert.equal(stream.audio.stopped, true);
  assert.deepEqual(stream.getAudioTracks(), []);
  assert.equal(stream.video.stopped, false);
  assert.deepEqual(stream.getTracks(), [stream.video]);
  assert.deepEqual(adopted, [stream]);
});

test('hands over a stream that cannot report its audio tracks', async () => {
  const {adopted, element, outcomes} = gateFixture();
  const stream = {id: 'granted'};
  (element as unknown as {stream: unknown}).stream = stream;

  element.dispatch('stream');
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(adopted, [stream]);
  assert.deepEqual(
    outcomes.map(({outcome}) => outcome),
    ['granted'],
  );
});

test('keeps the story startable when the person declines', () => {
  const {adopted, element, outcomes} = gateFixture();

  element.dispatch('cancel');

  assert.deepEqual(adopted, []);
  assert.deepEqual(
    outcomes.map(({outcome}) => outcome),
    ['cancelled'],
  );
  // Still on screen, now inviting another try: declining is not a failure the story reports.
  assert.notEqual(element.style.display, 'none');
  assert.equal(requireChild(element).textContent, 'もう一度試す');
});

test('reports a failed handover without hiding the way to retry', async () => {
  const failure = new Error('camera source refused the stream');
  const {element, outcomes} = gateFixture({
    adopt: () => {
      throw failure;
    },
  });
  (element as unknown as {stream: unknown}).stream = {id: 'granted'};

  element.dispatch('stream');
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(outcomes, [{outcome: 'error', detail: failure}]);
  assert.notEqual(element.style.display, 'none');
  assert.equal(requireChild(element).textContent, 'もう一度試す');
});

test('treats a stream event with no stream as a failure rather than adopting nothing', async () => {
  const {adopted, element, outcomes} = gateFixture();

  element.dispatch('stream');
  await Promise.resolve();

  assert.deepEqual(adopted, []);
  assert.equal(outcomes[0]?.outcome, 'error');
});

test('relabels with the title panel language and forgets nothing once granted', async () => {
  const {element, gate} = gateFixture();

  gate.setLabels({prompt: 'Enable the camera', retry: 'Try again'});
  assert.equal(requireChild(element).textContent, 'Enable the camera');

  (element as unknown as {stream: unknown}).stream = {id: 'granted'};
  element.dispatch('stream');
  await Promise.resolve();
  await Promise.resolve();
  gate.setLabels({prompt: 'カメラを準備する'});
  // Granted is granted: relabelling must not bring the button back.
  assert.equal(element.style.display, 'none');
});

test('removes itself and its listeners on dispose', () => {
  const {adopted, container, element, gate} = gateFixture();
  (element as unknown as {stream: unknown}).stream = {id: 'granted'};

  gate.dispose();
  element.dispatch('stream');

  assert.deepEqual(adopted, []);
  assert.equal(container.children.length, 0);
  gate.dispose();
});

test('detects the capability element rather than guessing from the user agent', () => {
  assert.equal(supportsDsl4UserMediaGate({HTMLUserMediaElement: class {}}), true);
  assert.equal(supportsDsl4UserMediaGate({}), false);
  assert.equal(supportsDsl4UserMediaGate(null), false);
});
