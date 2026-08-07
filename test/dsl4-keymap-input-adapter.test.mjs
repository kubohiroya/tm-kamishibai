import assert from 'node:assert/strict';
import test from 'node:test';

import {createDsl4KeymapInputAdapter} from '../src/dsl4/index.js';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {promise, resolve};
}

function keyEvent(code, overrides = {}) {
  const counters = {preventDefault: 0, stopPropagation: 0};
  return {
    code,
    key: overrides.key ?? code,
    defaultPrevented: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    target: null,
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

function pointerEvent(overrides = {}) {
  const counters = {preventDefault: 0, stopPropagation: 0};
  return {
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    defaultPrevented: false,
    target: null,
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

function element({tagName = 'DIV', role, contentEditable, parentElement, ignore = false} = {}) {
  const attributes = new Map();
  if (role !== undefined) attributes.set('role', role);
  if (contentEditable !== undefined) attributes.set('contenteditable', contentEditable);
  if (ignore) attributes.set('data-kamishibai-keymap-ignore', '');
  return {
    tagName,
    parentElement,
    isContentEditable: contentEditable === 'true',
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
  };
}

test('validates the resolved keymap and event target contract', () => {
  assert.throws(
    () =>
      createDsl4KeymapInputAdapter({
        keymap: {Space: 1},
        dispatchCommand: async () => {},
      }),
    /commands must be strings/,
  );
  const adapter = createDsl4KeymapInputAdapter({
    keymap: {},
    dispatchCommand: async () => {},
  });
  assert.throws(() => adapter.attach({addEventListener() {}}), /event listener registration/);
  assert.throws(
    () =>
      createDsl4KeymapInputAdapter({
        keymap: {},
        dispatchCommand() {},
        shouldConsumeCommand() {
          return true;
        },
      }),
    /requires immediate command dispatch/u,
  );
  for (const option of [
    'consumeAnyKey',
    'consumePointer',
    'shouldDeferKey',
    'arbitratePointer',
    'cancelPointer',
  ]) {
    assert.throws(
      () =>
        createDsl4KeymapInputAdapter({
          keymap: {},
          dispatchCommand() {},
          [option]: true,
        }),
      new RegExp(option, 'u'),
    );
  }
  assert.throws(
    () =>
      createDsl4KeymapInputAdapter({
        keymap: {},
        dispatchCommand() {},
        arbitratePointer: () => 'allow',
      }),
    /requires consumePointer/u,
  );
});

test('uses code only and never falls back to locale-dependent key', async () => {
  const calls = [];
  const adapter = createDsl4KeymapInputAdapter({
    keymap: {KeyA: 'navigation.nextAction'},
    dispatchCommand: async (command, context) => calls.push({command, context}),
  });
  const boundCode = keyEvent('KeyA', {
    key: 'q',
    composedPath: () => [element(), {}],
  });
  const unboundCode = keyEvent('KeyQ', {key: 'a'});
  assert.equal(adapter.handleKeyDown(boundCode), true);
  assert.equal(adapter.handleKeyDown(unboundCode), false);
  await adapter.whenIdle();
  assert.deepEqual(calls, [{command: 'navigation.nextAction', context: {code: 'KeyA'}}]);
});

test('does not consume unbound Arrow or Space keys', async () => {
  let calls = 0;
  const adapter = createDsl4KeymapInputAdapter({
    keymap: {Enter: 'navigation.nextAction'},
    dispatchCommand: async () => calls++,
  });
  for (const code of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space']) {
    const event = keyEvent(code);
    assert.equal(adapter.handleKeyDown(event), false);
    assert.deepEqual(event.counters, {preventDefault: 0, stopPropagation: 0});
  }
  await adapter.whenIdle();
  assert.equal(calls, 0);
});

test('does not consume modifier combinations or already handled events', async () => {
  let calls = 0;
  const adapter = createDsl4KeymapInputAdapter({
    keymap: {Space: 'navigation.nextAction'},
    dispatchCommand: async () => calls++,
  });
  for (const overrides of [
    {ctrlKey: true},
    {altKey: true},
    {metaKey: true},
    {shiftKey: true},
    {isComposing: true},
    {defaultPrevented: true},
  ]) {
    const event = keyEvent('Space', overrides);
    assert.equal(adapter.handleKeyDown(event), false);
    assert.deepEqual(event.counters, {preventDefault: 0, stopPropagation: 0});
  }
  await adapter.whenIdle();
  assert.equal(calls, 0);
});

test('does not consume keys from interactive or explicitly ignored focus paths', async () => {
  let calls = 0;
  const adapter = createDsl4KeymapInputAdapter({
    keymap: {Space: 'navigation.nextAction'},
    dispatchCommand: async () => calls++,
  });
  const targets = [
    element({tagName: 'INPUT'}),
    element({tagName: 'TEXTAREA'}),
    element({tagName: 'SELECT'}),
    element({tagName: 'BUTTON'}),
    element({tagName: 'A'}),
    element({contentEditable: 'true'}),
    element({role: 'menu'}),
    element({role: 'menuitem'}),
    element({role: 'textbox'}),
    element({ignore: true}),
    element({parentElement: element({tagName: 'BUTTON'})}),
  ];
  for (const target of targets) {
    const event = keyEvent('Space', {target});
    assert.equal(adapter.handleKeyDown(event), false);
    assert.deepEqual(event.counters, {preventDefault: 0, stopPropagation: 0});
  }
  await adapter.whenIdle();
  assert.equal(calls, 0);
});

test('routes an eligible initial key to speech advance before mapped navigation', async () => {
  const advances = [];
  const commands = [];
  const adapter = createDsl4KeymapInputAdapter({
    keymap: {Space: 'navigation.nextAction'},
    consumeAnyKey(context) {
      advances.push(context);
      return true;
    },
    dispatchCommand: async (command) => commands.push(command),
  });
  const accepted = keyEvent('Space');
  assert.equal(adapter.handleKeyDown(accepted), true);
  assert.deepEqual(accepted.counters, {preventDefault: 1, stopPropagation: 1});
  assert.deepEqual(advances, [{code: 'Space'}]);
  assert.equal(Object.isFrozen(advances[0]), true);
  await adapter.whenIdle();
  assert.deepEqual(commands, []);

  for (const event of [
    keyEvent('Space', {repeat: true}),
    keyEvent('Space', {isComposing: true}),
    keyEvent('Space', {ctrlKey: true}),
    keyEvent('Space', {target: element({tagName: 'BUTTON'})}),
  ]) {
    adapter.handleKeyDown(event);
  }
  await adapter.whenIdle();
  assert.deepEqual(advances, [{code: 'Space'}]);
  assert.deepEqual(commands, []);
});

test('falls through to an ordinary mapped command when speech advance is inactive', async () => {
  const commands = [];
  const adapter = createDsl4KeymapInputAdapter({
    keymap: {Space: 'navigation.nextAction'},
    consumeAnyKey: () => false,
    dispatchCommand: async (command) => commands.push(command),
  });
  assert.equal(adapter.handleKeyDown(keyEvent('Space')), true);
  await adapter.whenIdle();
  assert.deepEqual(commands, ['navigation.nextAction']);
});

test('attaches pointer advance only to the explicitly scoped stage target', () => {
  const keyListeners = new Map();
  const stageListeners = new Map();
  const target = (listeners) => ({
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  });
  const pointers = [];
  const adapter = createDsl4KeymapInputAdapter({
    keymap: {},
    consumePointer(context) {
      pointers.push(context);
      return true;
    },
    dispatchCommand() {},
  });
  adapter.attach(target(keyListeners));
  assert.equal(keyListeners.has('keydown'), true);
  assert.equal(keyListeners.has('pointerup'), false);
  adapter.attachPointer(target(stageListeners));
  assert.equal(stageListeners.has('pointerup'), true);

  const accepted = pointerEvent({pointerType: 'touch'});
  assert.equal(stageListeners.get('pointerup')(accepted), true);
  assert.deepEqual(accepted.counters, {preventDefault: 1, stopPropagation: 1});
  assert.deepEqual(pointers, [{pointerType: 'touch'}]);
  for (const event of [
    pointerEvent({isPrimary: false}),
    pointerEvent({button: 1}),
    pointerEvent({target: element({tagName: 'BUTTON'})}),
  ]) {
    assert.equal(adapter.handlePointerUp(event), false);
    assert.deepEqual(event.counters, {preventDefault: 0, stopPropagation: 0});
  }
  adapter.detachPointer();
  assert.equal(stageListeners.has('pointerup'), false);
  adapter.dispose();
  assert.equal(keyListeners.has('keydown'), false);
});

test('defers exact story keys and arbitrates one physical pointer sequence', async () => {
  const listeners = new Map();
  const target = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  const commands = [];
  const cancellations = [];
  let pointerDecision = 'defer';
  const adapter = createDsl4KeymapInputAdapter({
    keymap: {Enter: 'navigation.nextAction'},
    dispatchCommand: async (command) => commands.push(command),
    shouldDeferKey: ({code}) => code === 'Enter',
    consumePointer: () => true,
    arbitratePointer: () => pointerDecision,
    cancelPointer: ({pointerType}) => cancellations.push(pointerType),
  });
  adapter.attach(target);
  adapter.attachPointer(target);

  const storyKey = keyEvent('Enter');
  assert.equal(listeners.get('keydown')(storyKey), false);
  assert.deepEqual(storyKey.counters, {preventDefault: 0, stopPropagation: 0});
  await adapter.whenIdle();
  assert.deepEqual(commands, []);

  const deferredPointer = pointerEvent({pointerType: 'touch'});
  assert.equal(listeners.get('pointerup')(deferredPointer), false);
  assert.deepEqual(deferredPointer.counters, {preventDefault: 0, stopPropagation: 0});

  pointerDecision = 'suppress';
  const suppressedPointer = pointerEvent({pointerType: 'touch'});
  assert.equal(listeners.get('pointerup')(suppressedPointer), true);
  assert.deepEqual(suppressedPointer.counters, {preventDefault: 1, stopPropagation: 1});

  pointerDecision = 'allow';
  const navigationPointer = pointerEvent({pointerType: 'mouse'});
  assert.equal(listeners.get('pointerup')(navigationPointer), true);
  assert.deepEqual(navigationPointer.counters, {preventDefault: 1, stopPropagation: 1});

  assert.equal(listeners.get('pointercancel')({pointerType: 'touch', isPrimary: true}), false);
  assert.deepEqual(cancellations, ['touch']);
  adapter.dispose();
  assert.equal(listeners.has('pointerup'), false);
  assert.equal(listeners.has('pointercancel'), false);
});

test('consumes one bound initial keydown and suppresses repeat dispatch', async () => {
  const calls = [];
  const adapter = createDsl4KeymapInputAdapter({
    keymap: {ArrowLeft: 'history.previousAction'},
    dispatchCommand: async (command) => calls.push(command),
  });
  const initial = keyEvent('ArrowLeft');
  const repeated = keyEvent('ArrowLeft', {repeat: true});
  assert.equal(adapter.handleKeyDown(initial), true);
  assert.equal(adapter.handleKeyDown(repeated), true);
  await adapter.whenIdle();
  assert.deepEqual(initial.counters, {preventDefault: 1, stopPropagation: 1});
  assert.deepEqual(repeated.counters, {preventDefault: 1, stopPropagation: 1});
  assert.deepEqual(calls, ['history.previousAction']);
});

test('does not consume a synchronously refused command and reserves an accepted command immediately', async () => {
  let available = true;
  const calls = [];
  const adapter = createDsl4KeymapInputAdapter({
    keymap: {Space: 'navigation.nextAction'},
    shouldConsumeCommand: () => available,
    dispatchImmediately: true,
    dispatchCommand(command) {
      calls.push(command);
      available = false;
    },
  });

  const accepted = keyEvent('Space');
  assert.equal(adapter.handleKeyDown(accepted), true);
  assert.deepEqual(accepted.counters, {preventDefault: 1, stopPropagation: 1});

  const refused = keyEvent('Space');
  assert.equal(adapter.handleKeyDown(refused), false);
  assert.deepEqual(refused.counters, {preventDefault: 0, stopPropagation: 0});
  const repeated = keyEvent('Space', {repeat: true});
  assert.equal(adapter.handleKeyDown(repeated), false);
  assert.deepEqual(repeated.counters, {preventDefault: 0, stopPropagation: 0});

  await adapter.whenIdle();
  assert.deepEqual(calls, ['navigation.nextAction']);
});

test('keeps commands without a consumption decision on the serialized queue', async () => {
  const calls = [];
  const adapter = createDsl4KeymapInputAdapter({
    keymap: {ArrowLeft: 'history.previousAction'},
    shouldConsumeCommand: () => undefined,
    dispatchImmediately: true,
    dispatchCommand: async (command) => calls.push(command),
  });
  const event = keyEvent('ArrowLeft');

  assert.equal(adapter.handleKeyDown(event), true);
  assert.deepEqual(event.counters, {preventDefault: 1, stopPropagation: 1});
  assert.deepEqual(calls, []);
  await adapter.whenIdle();
  assert.deepEqual(calls, ['history.previousAction']);
});

test('serializes commands in arrival order without retaining raw events', async () => {
  const first = deferred();
  const calls = [];
  const contexts = [];
  const adapter = createDsl4KeymapInputAdapter({
    keymap: {
      ArrowLeft: 'history.previousAction',
      ArrowUp: 'history.previousScene',
    },
    async dispatchCommand(command, context) {
      calls.push(command);
      contexts.push(context);
      if (calls.length === 1) await first.promise;
    },
  });
  const firstEvent = keyEvent('ArrowLeft');
  const secondEvent = keyEvent('ArrowUp');
  adapter.handleKeyDown(firstEvent);
  adapter.handleKeyDown(secondEvent);
  await Promise.resolve();
  assert.deepEqual(calls, ['history.previousAction']);
  first.resolve();
  await adapter.whenIdle();
  assert.deepEqual(calls, ['history.previousAction', 'history.previousScene']);
  assert.deepEqual(contexts, [{code: 'ArrowLeft'}, {code: 'ArrowUp'}]);
  assert.equal(Object.isFrozen(contexts[0]), true);
  assert.equal(Object.hasOwn(contexts[0], 'event'), false);
});

test('contains dispatch and error-observer rejections and continues the queue', async () => {
  const errors = [];
  const calls = [];
  const adapter = createDsl4KeymapInputAdapter({
    keymap: {Digit1: 'history.previousAction', Digit2: 'history.previousScene'},
    async dispatchCommand(command) {
      calls.push(command);
      if (command === 'history.previousAction') throw new Error('command failed');
    },
    async onError(error, context) {
      errors.push({message: error.message, context});
      throw new Error('observer failed');
    },
  });
  adapter.handleKeyDown(keyEvent('Digit1'));
  adapter.handleKeyDown(keyEvent('Digit2'));
  await adapter.whenIdle();
  await Promise.resolve();
  assert.deepEqual(calls, ['history.previousAction', 'history.previousScene']);
  assert.deepEqual(errors, [
    {
      message: 'command failed',
      context: {command: 'history.previousAction', code: 'Digit1'},
    },
  ]);
});

test('attaches once and stops processing after detach or dispose', async () => {
  const listeners = new Map();
  const target = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  let calls = 0;
  const adapter = createDsl4KeymapInputAdapter({
    keymap: {Space: 'navigation.nextAction'},
    dispatchCommand: async () => calls++,
  });
  adapter.attach(target);
  adapter.attach(target);
  listeners.get('keydown')(keyEvent('Space'));
  adapter.detach();
  assert.equal(listeners.has('keydown'), false);
  adapter.attach(target);
  adapter.dispose();
  assert.equal(listeners.has('keydown'), false);
  assert.equal(adapter.handleKeyDown(keyEvent('Space')), false);
  assert.throws(() => adapter.attach(target), /disposed/);
  await adapter.whenIdle();
  assert.equal(calls, 1);
});
