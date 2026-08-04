import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const extensionSource = await readFile(
  new URL('../app/extensions/kubohiroyascalablebubbles.js', import.meta.url),
  'utf8',
);

function loadExtension({unsandboxed = true} = {}) {
  const runtime = new EventEmitter();
  const bubbleState = {
    onSpriteRight: true,
    skinId: 1,
    text: '',
    type: 'say',
  };
  const styleUpdates = [];
  const textUpdates = [];
  const skin = {
    setStyle(style) {
      styleUpdates.push(style);
    },
  };
  let nativeSize = [480, 360];
  let repositionCount = 0;
  let redrawCount = 0;
  const renderer = {
    _allSkins: {1: skin},
    getNativeSize: () => nativeSize,
    updateTextSkin: (...args) => textUpdates.push(args),
  };
  const target = {
    getCustomState: (key) => (key === 'Scratch.looks' ? bubbleState : null),
    onTargetVisualChange: (changedTarget) => {
      assert.equal(changedTarget, target);
      repositionCount += 1;
    },
  };
  runtime.renderer = renderer;
  runtime.targets = [target];
  runtime.requestRedraw = () => {
    redrawCount += 1;
  };

  runtime.on('SAY', (_target, type, text) => {
    bubbleState.type = type;
    bubbleState.text = String(text).slice(0, 330);
  });

  const registeredExtensions = [];
  const Scratch = {
    ArgumentType: {NUMBER: 'number', STRING: 'string'},
    BlockType: {COMMAND: 'command'},
    Cast: {toString: (value) => String(value)},
    extensions: {
      register: (extension) => registeredExtensions.push(extension),
      unsandboxed,
    },
    vm: {runtime},
  };
  vm.runInNewContext(extensionSource, {Scratch}, {filename: 'kubohiroyascalablebubbles.js'});

  return {
    bubbleState,
    extension: registeredExtensions[0],
    getRedrawCount: () => redrawCount,
    getRepositionCount: () => repositionCount,
    registeredExtensions,
    runtime,
    setNativeSize: (width, height) => {
      nativeSize = [width, height];
    },
    styleUpdates,
    target,
    textUpdates,
  };
}

test('registers explicit say and think blocks with a size-100 default', () => {
  const {extension, registeredExtensions} = loadExtension();
  assert.equal(registeredExtensions.length, 1);
  const info = extension.getInfo();
  assert.equal(info.id, 'kubohiroyascalablebubbles');
  assert.deepEqual(
    Array.from(info.blocks, (block) => [block.opcode, block.arguments.SIZE.defaultValue]),
    [
      ['say', 100],
      ['think', 100],
    ],
  );
});

test('keeps standard bubbles proportional to the stage at the default size', () => {
  const {runtime, setNativeSize, styleUpdates, target} = loadExtension();

  runtime.emit('SAY', target, 'say', 'Hello');
  assert.equal(styleUpdates.at(-1).fontSize, 14);
  assert.equal(styleUpdates.at(-1).lineHeight, 16);
  assert.equal(styleUpdates.at(-1).maxLineWidth, 170);

  setNativeSize(960, 720);
  runtime.emit('SAY', target, 'think', 'Hello');
  assert.equal(styleUpdates.at(-1).fontSize, 28);
  assert.equal(styleUpdates.at(-1).lineHeight, 32);
  assert.equal(styleUpdates.at(-1).maxLineWidth, 340);

  runtime.emit('SAY', target, 'say', 'x'.repeat(400));
  assert.equal(target.getCustomState('Scratch.looks').text.length, 330);
});

test('supports relative font sizes and escaped multiline text', () => {
  const {bubbleState, extension, runtime, setNativeSize, styleUpdates, target, textUpdates} =
    loadExtension();
  setNativeSize(960, 720);

  runtime.emit('SAY', target, 'say', 'Standard 1\\nStandard 2');
  assert.equal(bubbleState.text, 'Standard 1\nStandard 2');
  assert.equal(textUpdates.at(-1)[2], 'Standard 1\nStandard 2');

  extension.say({MESSAGE: 'Line 1\\nLine 2', SIZE: 150}, {target});
  assert.equal(bubbleState.text, 'Line 1\nLine 2');
  assert.equal(styleUpdates.at(-1).fontSize, 42);

  extension.think({MESSAGE: 'Small', SIZE: 50}, {target});
  assert.equal(bubbleState.type, 'think');
  assert.equal(styleUpdates.at(-1).fontSize, 14);
});

test('restyles and repositions a visible bubble after the stage size changes', () => {
  const {
    extension,
    getRedrawCount,
    getRepositionCount,
    runtime,
    setNativeSize,
    styleUpdates,
    target,
  } = loadExtension();
  extension.say({MESSAGE: 'Hello', SIZE: 150}, {target});
  assert.equal(styleUpdates.at(-1).fontSize, 21);

  const redrawsBeforeResize = getRedrawCount();
  const repositionsBeforeResize = getRepositionCount();
  setNativeSize(960, 720);
  runtime.emit('STAGE_SIZE_CHANGED', 960, 720);

  assert.equal(styleUpdates.at(-1).fontSize, 42);
  assert.equal(getRedrawCount(), redrawsBeforeResize + 1);
  assert.equal(getRepositionCount(), repositionsBeforeResize + 1);
});

test('uses safe defaults and limits for invalid font sizes', () => {
  const {extension, styleUpdates, target} = loadExtension();
  extension.say({MESSAGE: 'Default', SIZE: ''}, {target});
  assert.equal(styleUpdates.at(-1).fontSize, 14);
  extension.say({MESSAGE: 'Minimum', SIZE: -100}, {target});
  assert.equal(styleUpdates.at(-1).fontSize, 0.14);
  extension.say({MESSAGE: 'Maximum', SIZE: 10000}, {target});
  assert.equal(styleUpdates.at(-1).fontSize, 140);
});

test('rejects sandboxed execution', () => {
  assert.throws(
    () => loadExtension({unsandboxed: false}),
    /Scalable Bubbles must run unsandboxed/u,
  );
});
