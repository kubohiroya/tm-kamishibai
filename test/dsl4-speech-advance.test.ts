import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'vitest';
import {fileURLToPath} from 'node:url';

import {
  createDsl4NavigationSession,
  createDsl4RuntimeController,
  createDsl4SourceFrontend,
} from '../src/dsl4/index.js';
import {requireSession} from './helpers/result-outcome.ts';
import {requireDefined, requireRecord} from './helpers/require-value.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(path.join(projectRoot, 'schema', 'dsl-4.schema.json'), 'utf8'),
);
const frontend = createDsl4SourceFrontend(schema);

function parseSpeech(action: string, controls = '') {
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

function keyEvent(code: string, overrides: Record<string, unknown> = {}) {
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

/** The advance wait a speech action is handed. */
interface AdvanceWait {
  promise: Promise<unknown>;
  cancel(): void;
}

async function waitFor(predicate: () => unknown, message: string) {
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
  const calls: string[] = [];
  let waitCreated = false;
  const created = createDsl4NavigationSession({
    storyDocument,
    controlProfile: 'production',
    speechAdvanceTypewriterEnabled: true,
    port: {
      async say(_payload: unknown, context: {createAdvanceWait: () => AdvanceWait}) {
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
  const run = requireSession(created).start();
  await waitFor(() => waitCreated, 'speech advance wait was not created');
  await Promise.resolve();

  const event = keyEvent('Space');
  assert.equal(requireSession(created).handleKeyDown(event), true);
  assert.deepEqual(event.counters, {preventDefault: 1, stopPropagation: 1});
  assert.equal((await run).status, 'finished');
  assert.deepEqual(calls, ['say', 'wait']);

  const stale = keyEvent('Space');
  assert.equal(requireSession(created).handleKeyDown(stale), true);
  await (requireSession(created).whenInputIdle as () => Promise<void>)();
  assert.deepEqual(calls, ['say', 'wait']);
  requireSession(created).dispose();
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
  const calls: string[] = [];
  // Recorded through a holder: the session is created and read inside its own port callback, and a
  // `let` assigned there would keep its initial narrowing at every use afterwards.
  const record: {startingEvent?: ReturnType<typeof keyEvent>; startingEventHandled?: boolean} = {};
  const session: {created?: unknown} = {};
  session.created = createDsl4NavigationSession({
    storyDocument,
    controlProfile: 'production',
    speechAdvanceTypewriterEnabled: true,
    port: {
      async say(_payload: unknown, context: {createAdvanceWait: () => AdvanceWait}) {
        calls.push('say');
        const advance = context.createAdvanceWait();
        record.startingEvent = keyEvent('Space');
        record.startingEventHandled = requireSession(session.created).handleKeyDown(
          record.startingEvent,
        );
        const outcome = requireRecord(await advance.promise, 'the advance outcome');
        calls.push(String(outcome.outcome));
      },
      async wait() {
        calls.push('wait');
      },
    },
  });
  assert.equal(
    requireRecord(session.created, 'the navigation session result').ok,
    true,
    JSON.stringify(requireRecord(session.created, 'the navigation session result').diagnostics),
  );

  const run = requireSession(session.created).start();
  await waitFor(
    () => record.startingEventHandled !== undefined,
    'the speech-starting key was not presented during the unarmed interval',
  );
  assert.equal(record.startingEventHandled, true);
  assert.deepEqual(requireDefined(record.startingEvent, 'the speech-starting key event').counters, {
    preventDefault: 1,
    stopPropagation: 1,
  });
  assert.deepEqual(calls, ['say']);
  assert.equal(
    requireRecord(
      requireRecord(
        (requireSession(session.created).getState as () => unknown)(),
        'the session state',
      ).runtime,
      'its runtime state',
    ).actionIndex,
    0,
  );

  const advanceEvent = keyEvent('Space');
  assert.equal(requireSession(session.created).handleKeyDown(advanceEvent), true);
  assert.deepEqual(advanceEvent.counters, {preventDefault: 1, stopPropagation: 1});
  assert.equal((await run).status, 'finished');
  assert.deepEqual(calls, ['say', 'advance', 'wait']);
  requireSession(session.created).dispose();
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
      async think(_payload: unknown, context: {createAdvanceWait: () => AdvanceWait}) {
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
  const listeners = new Map<string, (event: unknown) => unknown>();
  const stage = {
    addEventListener(type: string, listener: (event: unknown) => unknown) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string, listener: (event: unknown) => unknown) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  (requireSession(created).attachStagePointer as (stage: unknown) => void)(stage);
  assert.equal(listeners.has('pointerup'), true);
  const run = requireSession(created).start();
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
  assert.equal(requireDefined(listeners.get('pointerup'), 'the pointerup listener')(event), true);
  assert.deepEqual(counters, {preventDefault: 1, stopPropagation: 1});
  assert.equal((await run).status, 'finished');
  requireSession(created).dispose();
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
      async say(_payload: unknown, context: {createAdvanceWait: () => AdvanceWait}) {
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
