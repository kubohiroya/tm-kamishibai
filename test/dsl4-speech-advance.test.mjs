import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  createDsl4NavigationSession,
  createDsl4RuntimeController,
  createDsl4SourceFrontend,
} from '../src/dsl4/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);

function parseSpeech(action, controls = '') {
  const result = frontend.parse(`
kamishibai: '4.0'
${controls}
assets:
  HeroIdle: costume:Hero
  Voice: sound
actors:
  Hero: HeroIdle
scenes:
  opening:
${action}
`);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.storyDocument;
}

function keyEvent(code, overrides = {}) {
  const counters = {preventDefault: 0, stopPropagation: 0};
  return {
    code,
    defaultPrevented: false,
    repeat: false,
    preventDefault() {
      counters.preventDefault += 1;
      this.defaultPrevented = true;
    },
    stopPropagation() {
      counters.stopPropagation += 1;
    },
    counters,
    ...overrides,
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

test('keeps legacy timed say available and rejects extended speech while the flag is OFF', async () => {
  const legacy = createDsl4RuntimeController({
    storyDocument: parseSpeech(`
    - Hero.say:
        text: hello
        seconds: 0
`),
    port: {say: async () => {}},
  });
  assert.equal((await legacy.start()).status, 'finished');

  for (const action of [
    `
    - Hero.say:
        text: hello
        waitFor: advance
`,
    `
    - Hero.say:
        text: hello
        seconds: 1
        startSound: Voice
`,
    `
    - Hero.say:
        text: hello
        seconds: 1
        characterIntervalSeconds: 0.1
        characterSound: Voice
        noSoundCharacters: "、。"
`,
    `
    - Hero.think:
        text: hmm
        seconds: 1
`,
  ]) {
    assert.throws(
      () =>
        createDsl4RuntimeController({
          storyDocument: parseSpeech(action),
          port: {},
        }),
      /dsl4SpeechAdvanceTypewriter/u,
    );
  }

  assert.throws(
    () =>
      createDsl4RuntimeController({
        storyDocument: parseSpeech(
          `
    - Hero.say:
        text: hello
        seconds: 1
        styles:
          - novel
`,
          `bubbleStyles:
  novel:
    characterIntervalSeconds: 0.1
`,
        ),
        port: {},
      }),
    /dsl4SpeechAdvanceTypewriter/u,
  );
});

test('completes active speech from one eligible key without dispatching navigation twice', async () => {
  const controls = `
controls:
  keymaps:
    production:
      Space: navigation.nextAction
`;
  const storyDocument = parseSpeech(
    `
    - Hero.say:
        text: hello
        waitFor: advance
    - wait: 0
`,
    controls,
  );
  const calls = [];
  let waitCreated = false;
  const created = createDsl4NavigationSession({
    storyDocument,
    controlProfile: 'production',
    speechAdvanceTypewriterEnabled: true,
    port: {
      async say(_payload, context) {
        calls.push('say');
        const advance = context.createAdvanceWait();
        waitCreated = true;
        try {
          assert.deepEqual(await advance.promise, {
            outcome: 'advance',
            input: {kind: 'key', code: 'Space'},
          });
        } finally {
          advance.cancel();
        }
      },
      async wait() {
        calls.push('wait');
      },
    },
  });
  assert.equal(created.ok, true, JSON.stringify(created.diagnostics));
  const run = created.session.start();
  await waitFor(() => waitCreated, 'speech advance wait was not created');
  await Promise.resolve();

  const event = keyEvent('Space');
  assert.equal(created.session.handleKeyDown(event), true);
  assert.deepEqual(event.counters, {preventDefault: 1, stopPropagation: 1});
  assert.equal((await run).status, 'finished');
  assert.deepEqual(calls, ['say', 'wait']);

  const stale = keyEvent('Space');
  assert.equal(created.session.handleKeyDown(stale), true);
  await created.session.whenInputIdle();
  assert.deepEqual(calls, ['say', 'wait']);
  created.session.dispose();
});

test('reserves the speech-starting key before the advance wait is armed', async () => {
  const storyDocument = parseSpeech(
    `
    - Hero.say:
        text: hello
        waitFor: advance
    - wait: 0
`,
    `
controls:
  keymaps:
    production:
      Space: navigation.nextAction
`,
  );
  const calls = [];
  let startingEvent;
  let startingEventHandled;
  let created;
  created = createDsl4NavigationSession({
    storyDocument,
    controlProfile: 'production',
    speechAdvanceTypewriterEnabled: true,
    port: {
      async say(_payload, context) {
        calls.push('say');
        const advance = context.createAdvanceWait();
        startingEvent = keyEvent('Space');
        startingEventHandled = created.session.handleKeyDown(startingEvent);
        const outcome = await advance.promise;
        calls.push(outcome.outcome);
      },
      async wait() {
        calls.push('wait');
      },
    },
  });
  assert.equal(created.ok, true, JSON.stringify(created.diagnostics));

  const run = created.session.start();
  await waitFor(
    () => startingEventHandled !== undefined,
    'the speech-starting key was not presented during the unarmed interval',
  );
  assert.equal(startingEventHandled, true);
  assert.deepEqual(startingEvent.counters, {preventDefault: 1, stopPropagation: 1});
  assert.deepEqual(calls, ['say']);
  assert.equal(created.session.getState().runtime.actionIndex, 0);

  const advanceEvent = keyEvent('Space');
  assert.equal(created.session.handleKeyDown(advanceEvent), true);
  assert.deepEqual(advanceEvent.counters, {preventDefault: 1, stopPropagation: 1});
  assert.equal((await run).status, 'finished');
  assert.deepEqual(calls, ['say', 'advance', 'wait']);
  created.session.dispose();
});

test('accepts primary stage pointer only through the separately attached stage boundary', async () => {
  const storyDocument = parseSpeech(
    `
    - Hero.think:
        text: hmm
        waitFor: advance
`,
    `
controls:
  keymaps:
    production:
      Space: navigation.nextAction
`,
  );
  let waitCreated = false;
  const created = createDsl4NavigationSession({
    storyDocument,
    controlProfile: 'production',
    speechAdvanceTypewriterEnabled: true,
    port: {
      async think(_payload, context) {
        const advance = context.createAdvanceWait();
        waitCreated = true;
        try {
          await advance.promise;
        } finally {
          advance.cancel();
        }
      },
    },
  });
  assert.equal(created.ok, true, JSON.stringify(created.diagnostics));
  const listeners = new Map();
  const stage = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  created.session.attachStagePointer(stage);
  assert.equal(listeners.has('pointerup'), true);
  const run = created.session.start();
  await waitFor(() => waitCreated, 'speech advance wait was not created');
  await Promise.resolve();

  const counters = {preventDefault: 0, stopPropagation: 0};
  const event = {
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    preventDefault() {
      counters.preventDefault += 1;
    },
    stopPropagation() {
      counters.stopPropagation += 1;
    },
  };
  assert.equal(listeners.get('pointerup')(event), true);
  assert.deepEqual(counters, {preventDefault: 1, stopPropagation: 1});
  assert.equal((await run).status, 'finished');
  created.session.dispose();
  assert.equal(listeners.has('pointerup'), false);
});

test('cancels an active advance wait when the runtime is stopped', async () => {
  const storyDocument = parseSpeech(`
    - Hero.say:
        text: hello
        waitFor: advance
`);
  let outcome;
  let waitCreated = false;
  const controller = createDsl4RuntimeController({
    storyDocument,
    speechAdvanceTypewriterEnabled: true,
    port: {
      async say(_payload, context) {
        const advance = context.createAdvanceWait();
        waitCreated = true;
        outcome = await advance.promise;
      },
    },
  });
  const run = controller.start();
  await waitFor(() => waitCreated, 'speech advance wait was not created');
  controller.stop('test-stop');
  assert.equal((await run).status, 'stopped');
  assert.deepEqual(outcome, {outcome: 'cancelled'});
  assert.equal(controller.acceptAdvanceInput({kind: 'key', code: 'Space'}), false);
});
