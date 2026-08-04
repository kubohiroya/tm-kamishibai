// Name: Scalable Bubbles
// ID: kubohiroyascalablebubbles
// Description: Keep say and think bubbles proportional to the TurboWarp stage size.
// By: Hiroya Kubo
// License: MPL-2.0

/* global Scratch */

(function (Scratch) {
  'use strict';

  const extensionId = 'kubohiroyascalablebubbles';
  const bubbleStateKey = 'Scratch.looks';
  const defaultFontPercent = 100;
  const minimumFontPercent = 1;
  const maximumFontPercent = 1000;
  const baseStageWidth = 480;
  const baseStageHeight = 360;
  const baseStyle = {
    maxLineWidth: 170,
    minWidth: 50,
    strokeWidth: 4,
    padding: 10,
    cornerRadius: 16,
    tailHeight: 12,
    fontSize: 14,
    lineHeight: 16,
  };

  class ScalableBubblesExtension {
    constructor() {
      this.runtime = Scratch.vm?.runtime;
      if (!this.runtime) throw new Error('Scalable Bubbles requires the TurboWarp VM.');

      this.activeFontPercents = new WeakMap();
      this.pendingFontPercents = new WeakMap();
      this.handleSayOrThink = this.handleSayOrThink.bind(this);
      this.handleStageSizeChanged = this.handleStageSizeChanged.bind(this);
      this.runtime.on('SAY', this.handleSayOrThink);
      this.runtime.on('STAGE_SIZE_CHANGED', this.handleStageSizeChanged);
    }

    getInfo() {
      return {
        id: extensionId,
        name: 'Scalable Bubbles',
        color1: '#9966ff',
        blocks: [
          {
            opcode: 'say',
            blockType: Scratch.BlockType.COMMAND,
            text: 'say [MESSAGE] with font size [SIZE]',
            arguments: {
              MESSAGE: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: 'Hello!\\nHow are you?',
              },
              SIZE: {
                type: Scratch.ArgumentType.NUMBER,
                defaultValue: defaultFontPercent,
              },
            },
          },
          {
            opcode: 'think',
            blockType: Scratch.BlockType.COMMAND,
            text: 'think [MESSAGE] with font size [SIZE]',
            arguments: {
              MESSAGE: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: 'Hmm...\\nI wonder.',
              },
              SIZE: {
                type: Scratch.ArgumentType.NUMBER,
                defaultValue: defaultFontPercent,
              },
            },
          },
        ],
      };
    }

    normalizeFontPercent(value) {
      if (typeof value === 'string' && value.trim() === '') return defaultFontPercent;
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue)) return defaultFontPercent;
      return Math.min(maximumFontPercent, Math.max(minimumFontPercent, numericValue));
    }

    normalizeMessage(value) {
      return Scratch.Cast.toString(value).replace(/\\r\\n|\\n|\\r/gu, '\n');
    }

    getStageScale() {
      const nativeSize = this.runtime.renderer?.getNativeSize?.();
      if (!Array.isArray(nativeSize) || nativeSize.length < 2) return 1;
      const width = Number(nativeSize[0]);
      const height = Number(nativeSize[1]);
      if (!(width > 0) || !(height > 0)) return 1;
      return Math.min(width / baseStageWidth, height / baseStageHeight);
    }

    createStyle(fontPercent) {
      const stageScale = this.getStageScale();
      const fontScale = stageScale * (fontPercent / defaultFontPercent);
      return {
        maxLineWidth: baseStyle.maxLineWidth * stageScale,
        minWidth: baseStyle.minWidth * stageScale,
        strokeWidth: baseStyle.strokeWidth * stageScale,
        padding: baseStyle.padding * stageScale,
        cornerRadius: baseStyle.cornerRadius * stageScale,
        tailHeight: baseStyle.tailHeight * stageScale,
        fontSize: baseStyle.fontSize * fontScale,
        lineHeight: baseStyle.lineHeight * fontScale,
      };
    }

    getTextBubbleSkin(skinId) {
      const skins = this.runtime.renderer?._allSkins;
      if (!skins || skinId === null || skinId === undefined) return null;
      return (typeof skins.get === 'function' ? skins.get(skinId) : skins[skinId]) ?? null;
    }

    applyBubbleStyle(target, type, text, fontPercent) {
      const bubbleState = target?.getCustomState?.(bubbleStateKey);
      if (!bubbleState || bubbleState.skinId === null || bubbleState.skinId === undefined) return;

      const normalizedText = this.normalizeMessage(text);
      if (bubbleState.text !== normalizedText) {
        bubbleState.text = normalizedText;
        this.runtime.renderer?.updateTextSkin?.(
          bubbleState.skinId,
          type,
          normalizedText,
          bubbleState.onSpriteRight,
          [0, 0],
        );
      }

      const skin = this.getTextBubbleSkin(bubbleState.skinId);
      if (typeof skin?.setStyle !== 'function') return;
      skin.setStyle(this.createStyle(fontPercent));
      target.onTargetVisualChange?.(target);
      this.runtime.requestRedraw?.();
    }

    handleSayOrThink(target, type, text) {
      const pendingFontPercent = this.pendingFontPercents.get(target);
      this.pendingFontPercents.delete(target);
      const fontPercent = pendingFontPercent ?? defaultFontPercent;
      const bubbleState = target?.getCustomState?.(bubbleStateKey);
      const normalizedText = this.normalizeMessage(bubbleState?.text ?? text);
      if (normalizedText === '') {
        this.activeFontPercents.delete(target);
        return;
      }
      this.activeFontPercents.set(target, fontPercent);
      this.applyBubbleStyle(target, type, normalizedText, fontPercent);
    }

    handleStageSizeChanged() {
      for (const target of this.runtime.targets ?? []) {
        const bubbleState = target?.getCustomState?.(bubbleStateKey);
        if (!bubbleState?.text) continue;
        this.applyBubbleStyle(
          target,
          bubbleState.type,
          bubbleState.text,
          this.activeFontPercents.get(target) ?? defaultFontPercent,
        );
      }
    }

    showBubble(type, args, util) {
      const fontPercent = this.normalizeFontPercent(args.SIZE);
      const message = this.normalizeMessage(args.MESSAGE);
      this.pendingFontPercents.set(util.target, fontPercent);
      try {
        this.runtime.emit('SAY', util.target, type, message);
      } finally {
        this.pendingFontPercents.delete(util.target);
      }
    }

    say(args, util) {
      this.showBubble('say', args, util);
    }

    think(args, util) {
      this.showBubble('think', args, util);
    }
  }

  if (!Scratch.extensions.unsandboxed) {
    throw new Error('Scalable Bubbles must run unsandboxed.');
  }
  Scratch.extensions.register(new ScalableBubblesExtension());
})(Scratch);
