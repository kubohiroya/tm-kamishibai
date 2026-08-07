import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  createDsl4KeymapInputAdapter,
  createDsl4RuntimeController,
  createDsl4SourceFrontend,
} from '../src/dsl4/index.js';
import {
  createDsl4ActorActionPort,
  createDsl4TurboWarpActorPlatform,
} from '../src/dsl4/platform/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);

function manualScheduler() {
  let currentTime = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    scheduler: {
      now: () => currentTime,
      setTimeout(callback, milliseconds) {
        const id = nextId++;
        timers.set(id, {callback, due: currentTime + milliseconds});
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    pendingCount: () => timers.size,
    advance(milliseconds) {
      const target = currentTime + milliseconds;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.due <= target)
          .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        currentTime = timer.due;
        timer.callback();
      }
      currentTime = target;
    },
  };
}

function speechRuntime() {
  const bubbles = [];
  const actor = {
    id: 'hero-target',
    isStage: false,
    x: 0,
    y: 0,
    lookupVariableByNameAndType(name, type) {
      return name === 'actorName' && type === '' ? {value: 'Hero'} : undefined;
    },
    setXY() {},
    setSize() {},
    setVisible() {},
  };
  return {
    actor,
    bubbles,
    runtime: {
      targets: [actor],
      ext_scratch3_looks: {
        _say(message, target) {
          bubbles.push({kind: 'say', message, target: target.id});
        },
        _think(message, target) {
          bubbles.push({kind: 'think', message, target: target.id});
        },
      },
    },
  };
}

function parseSpeech(command, args) {
  const parsed = frontend.parse(`
kamishibai: '4.0'
assets:
  HeroIdle: costume:Hero
  Tick: sound
  Voice: sound
actors:
  Hero: HeroIdle
scenes:
  opening:
    - Hero.${command}:
${Object.entries(args)
  .map(([key, value]) => `        ${key}: ${JSON.stringify(value)}`)
  .join('\n')}
    - wait: 0
`);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  return parsed.storyDocument;
}

function createSpeechExecution(command, args) {
  const fake = speechRuntime();
  const clock = manualScheduler();
  const sounds = [];
  const platform = createDsl4TurboWarpActorPlatform({
    runtime: fake.runtime,
    scheduler: clock.scheduler,
    speechAdvanceTypewriterEnabled: true,
    playSpeechSound(sound) {
      sounds.push(['play', sound]);
    },
    stopSpeechSound(sound) {
      sounds.push(['stop', sound]);
    },
  });
  const actorPort = createDsl4ActorActionPort({
    composition: {
      isRegistered: (name) => name === 'Tick' || name === 'Voice',
      getMimeType: (name) => (name === 'Tick' || name === 'Voice' ? 'audio/wav' : ''),
      applyToTarget() {},
    },
    resolveActor: platform.resolveActor,
    host: platform.host,
    speechAdvanceTypewriterEnabled: true,
  });
  let followingActions = 0;
  const controller = createDsl4RuntimeController({
    storyDocument: parseSpeech(command, args),
    port: {
      say: actorPort.say.bind(actorPort),
      think: actorPort.think.bind(actorPort),
      async wait() {
        followingActions += 1;
      },
    },
    speechAdvanceTypewriterEnabled: true,
  });
  return {clock, controller, fake, sounds, followingActions: () => followingActions};
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

test('advance during think typewriter reveals the full text and commits exactly once', async () => {
  const execution = createSpeechExecution('think', {
    text: 'こんにちは',
    seconds: 5,
    waitFor: 'advance',
    characterIntervalSeconds: 0.1,
    startSound: 'Voice',
    characterSound: 'Tick',
  });
  const run = execution.controller.start();
  assert.equal(execution.controller.acceptAdvanceInput({kind: 'key', code: 'KeyA'}), false);
  await waitFor(() => execution.fake.bubbles.length === 1, 'the first character was not shown');

  assert.deepEqual(execution.fake.bubbles, [{kind: 'think', message: 'こ', target: 'hero-target'}]);
  assert.deepEqual(execution.sounds, [
    ['play', 'Voice'],
    ['play', 'Tick'],
  ]);
  await Promise.resolve();
  assert.equal(execution.controller.acceptAdvanceInput({kind: 'key', code: 'KeyA'}), true);

  const state = await run;
  assert.equal(state.status, 'finished');
  assert.deepEqual(execution.fake.bubbles, [
    {kind: 'think', message: 'こ', target: 'hero-target'},
    {kind: 'think', message: 'こんにちは', target: 'hero-target'},
    {kind: 'think', message: '', target: 'hero-target'},
  ]);
  assert.deepEqual(execution.sounds, [
    ['play', 'Voice'],
    ['play', 'Tick'],
    ['stop', 'Voice'],
    ['stop', 'Tick'],
  ]);
  assert.equal(execution.followingActions(), 1);
  assert.equal(execution.clock.pendingCount(), 0);
  assert.equal(execution.controller.acceptAdvanceInput({kind: 'key', code: 'KeyB'}), false);
  assert.equal(
    execution.controller.getTrace().filter(({type}) => type === 'action.commit').length,
    2,
  );
  assert.equal(
    execution.controller.getTrace().filter(({type}) => type === 'action.cancel').length,
    0,
  );
});

test('seconds and waitFor race, and timeout skips sounds for bulk-revealed characters', async () => {
  const execution = createSpeechExecution('say', {
    text: 'abc',
    seconds: 0.25,
    waitFor: 'advance',
    characterIntervalSeconds: 0.2,
    startSound: 'Voice',
    characterSound: 'Tick',
  });
  const run = execution.controller.start();
  await waitFor(() => execution.fake.bubbles.length === 1, 'the first character was not shown');
  execution.clock.advance(200);
  execution.clock.advance(50);

  const state = await run;
  assert.equal(state.status, 'finished');
  assert.deepEqual(
    execution.fake.bubbles.map(({message}) => message),
    ['a', 'ab', 'abc', ''],
  );
  assert.deepEqual(execution.sounds, [
    ['play', 'Voice'],
    ['play', 'Tick'],
    ['play', 'Tick'],
    ['stop', 'Voice'],
    ['stop', 'Tick'],
  ]);
  assert.equal(execution.followingActions(), 1);
  assert.equal(execution.clock.pendingCount(), 0);
  assert.equal(execution.controller.acceptAdvanceInput({kind: 'pointer'}), false);
});

test('startSound plays once after bubble display and stops on cancellation', async () => {
  const execution = createSpeechExecution('say', {
    text: 'フルボイス',
    waitFor: 'advance',
    startSound: 'Voice',
  });
  const run = execution.controller.start();
  await waitFor(() => execution.fake.bubbles.length === 1, 'the speech bubble was not shown');
  assert.deepEqual(execution.fake.bubbles[0], {
    kind: 'say',
    message: 'フルボイス',
    target: 'hero-target',
  });
  assert.deepEqual(execution.sounds, [['play', 'Voice']]);

  execution.controller.stop('test-cancel');
  assert.equal((await run).status, 'stopped');
  assert.deepEqual(execution.sounds, [
    ['play', 'Voice'],
    ['stop', 'Voice'],
  ]);
  assert.deepEqual(execution.fake.bubbles.at(-1), {
    kind: 'say',
    message: '',
    target: 'hero-target',
  });
});

test('waitFor-only speech stays active after typewriter completion until one advance', async () => {
  const execution = createSpeechExecution('say', {
    text: 'abc',
    waitFor: 'advance',
    characterIntervalSeconds: 0.1,
    characterSound: 'Tick',
  });
  const run = execution.controller.start();
  await waitFor(() => execution.fake.bubbles.length === 1, 'the first character was not shown');
  execution.clock.advance(500);
  await Promise.resolve();

  assert.equal(execution.controller.getState().status, 'running');
  assert.deepEqual(
    execution.fake.bubbles.map(({message}) => message),
    ['a', 'ab', 'abc'],
  );
  assert.deepEqual(execution.sounds, [
    ['play', 'Tick'],
    ['play', 'Tick'],
    ['play', 'Tick'],
  ]);
  assert.equal(execution.clock.pendingCount(), 0);
  assert.equal(
    execution.controller.acceptAdvanceInput({kind: 'pointer', pointerType: 'touch'}),
    true,
  );
  assert.equal((await run).status, 'finished');
  assert.deepEqual(execution.fake.bubbles.at(-1), {
    kind: 'say',
    message: '',
    target: 'hero-target',
  });
  assert.deepEqual(execution.sounds.at(-1), ['stop', 'Tick']);
  assert.equal(execution.followingActions(), 1);
});

test('stop during typewriter clears timers, bubble, sound, and stale completion', async () => {
  const execution = createSpeechExecution('think', {
    text: 'abcdef',
    waitFor: 'advance',
    characterIntervalSeconds: 0.1,
    characterSound: 'Tick',
  });
  const run = execution.controller.start();
  await waitFor(() => execution.fake.bubbles.length === 1, 'the first character was not shown');

  execution.controller.stop('test-stop');
  assert.equal((await run).status, 'stopped');
  assert.equal(execution.clock.pendingCount(), 0);
  assert.deepEqual(
    execution.fake.bubbles.map(({message}) => message),
    ['a', ''],
  );
  assert.deepEqual(execution.sounds, [
    ['play', 'Tick'],
    ['stop', 'Tick'],
  ]);
  assert.equal(execution.followingActions(), 0);
  assert.equal(execution.controller.acceptAdvanceInput({kind: 'key', code: 'Space'}), false);

  const snapshot = JSON.stringify({bubbles: execution.fake.bubbles, sounds: execution.sounds});
  execution.clock.advance(10_000);
  await Promise.resolve();
  assert.equal(
    JSON.stringify({bubbles: execution.fake.bubbles, sounds: execution.sounds}),
    snapshot,
  );
});

test('contains character sound cleanup failure and still settles and clears the bubble', async () => {
  const fake = speechRuntime();
  const clock = manualScheduler();
  const platform = createDsl4TurboWarpActorPlatform({
    runtime: fake.runtime,
    scheduler: clock.scheduler,
    speechAdvanceTypewriterEnabled: true,
    playSpeechSound() {},
    stopSpeechSound() {
      throw new Error('sound cleanup failed');
    },
  });
  const operation = platform.host.createSay(fake.actor, {
    text: 'a',
    seconds: 0,
    characterIntervalSeconds: 0.1,
    characterSound: 'Tick',
  });

  await operation.start();
  assert.deepEqual(
    fake.bubbles.map(({message}) => message),
    ['a', ''],
  );
  assert.equal(clock.pendingCount(), 0);
});

test('stops only speech sound assets whose playback actually started', async () => {
  const fake = speechRuntime();
  const clock = manualScheduler();
  const sounds = [];
  const platform = createDsl4TurboWarpActorPlatform({
    runtime: fake.runtime,
    scheduler: clock.scheduler,
    speechAdvanceTypewriterEnabled: true,
    playSpeechSound(sound) {
      sounds.push(['play', sound]);
    },
    stopSpeechSound(sound) {
      sounds.push(['stop', sound]);
    },
  });
  const operation = platform.host.createSay(fake.actor, {
    text: '',
    seconds: 0,
    characterIntervalSeconds: 0.1,
    startSound: 'Voice',
    characterSound: 'Tick',
  });

  await operation.start();
  assert.deepEqual(sounds, [
    ['play', 'Voice'],
    ['stop', 'Voice'],
  ]);
});

test('fails closed when Unicode grapheme segmentation is unavailable', () => {
  const fake = speechRuntime();
  const clock = manualScheduler();
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
  Object.defineProperty(Intl, 'Segmenter', {configurable: true, value: undefined});
  try {
    const platform = createDsl4TurboWarpActorPlatform({
      runtime: fake.runtime,
      scheduler: clock.scheduler,
      speechAdvanceTypewriterEnabled: true,
    });
    assert.throws(
      () =>
        platform.host.createSay(fake.actor, {
          text: 'é',
          seconds: 1,
          characterIntervalSeconds: 0.1,
        }),
      /Intl\.Segmenter is required/u,
    );
  } finally {
    Object.defineProperty(Intl, 'Segmenter', descriptor);
  }
});

test('typewriter reveals one grapheme cluster per tick and validates character sound input', async () => {
  const fake = speechRuntime();
  const clock = manualScheduler();
  const platform = createDsl4TurboWarpActorPlatform({
    runtime: fake.runtime,
    scheduler: clock.scheduler,
    speechAdvanceTypewriterEnabled: true,
    playSpeechSound() {},
    stopSpeechSound() {},
  });
  const operation = platform.host.createSay(fake.actor, {
    text: '👨‍👩‍👧‍👦A',
    seconds: 1,
    characterIntervalSeconds: 0.1,
  });
  const pending = operation.start();
  assert.deepEqual(
    fake.bubbles.map(({message}) => message),
    ['👨‍👩‍👧‍👦'],
  );
  clock.advance(100);
  assert.deepEqual(
    fake.bubbles.map(({message}) => message),
    ['👨‍👩‍👧‍👦', '👨‍👩‍👧‍👦A'],
  );
  operation.finish('advance');
  await pending;

  assert.throws(
    () => platform.host.createSay(fake.actor, {text: 'x', seconds: 1, characterSound: 'Tick'}),
    /requires characterIntervalSeconds/u,
  );
  assert.throws(
    () =>
      platform.host.createSay(fake.actor, {
        text: 'x',
        seconds: 1,
        characterIntervalSeconds: 0.1,
        characterSound: '',
      }),
    /non-empty string/u,
  );
});

function inputEvent(overrides = {}) {
  const counters = {preventDefault: 0, stopPropagation: 0};
  return {
    code: 'KeyA',
    repeat: false,
    defaultPrevented: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    target: null,
    preventDefault() {
      counters.preventDefault += 1;
    },
    stopPropagation() {
      counters.stopPropagation += 1;
    },
    counters,
    ...overrides,
  };
}

test('unbound keys and primary pointer input use the advance gate before the keymap', () => {
  const accepted = [];
  let waiting = true;
  const adapter = createDsl4KeymapInputAdapter({
    keymap: {Space: 'navigation.nextAction'},
    dispatchCommand() {
      assert.fail('speech advance must not dispatch generic navigation');
    },
    consumeAnyKey(context) {
      accepted.push(context);
      const result = waiting;
      waiting = false;
      return result;
    },
    consumePointer(context) {
      accepted.push(context);
      return true;
    },
  });

  const key = inputEvent();
  assert.equal(adapter.handleKeyDown(key), true);
  assert.deepEqual(key.counters, {preventDefault: 1, stopPropagation: 1});
  assert.deepEqual(accepted[0], {code: 'KeyA'});

  const repeat = inputEvent({repeat: true});
  assert.equal(adapter.handleKeyDown(repeat), false);
  const modified = inputEvent({ctrlKey: true});
  assert.equal(adapter.handleKeyDown(modified), false);

  const pointer = inputEvent({pointerType: 'touch', isPrimary: true, button: 0});
  assert.equal(adapter.handlePointerUp(pointer), true);
  assert.deepEqual(pointer.counters, {preventDefault: 1, stopPropagation: 1});
  assert.deepEqual(accepted.at(-1), {pointerType: 'touch'});
  assert.equal(adapter.handlePointerUp(inputEvent({isPrimary: false, button: 0})), false);
  assert.equal(adapter.handlePointerUp(inputEvent({isPrimary: true, button: 2})), false);
});
