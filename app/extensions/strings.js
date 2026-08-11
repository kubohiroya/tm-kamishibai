// Name: Text
// ID: strings
// Description: Manipulate characters and text.
// By: CST1229 <https://scratch.mit.edu/users/CST1229/>
// By: BludIsAnLemon <https://scratch.mit.edu/users/BludIsAnLemon/>
// By: Man-o-Valor <https://scratch.mit.edu/users/Man-o-Valor/>
// License: MIT AND MPL-2.0
//
// This compatibility copy keeps the legacy DSL 3.2 project self-contained.

(function (Scratch) {
  'use strict';

  const Cast = Scratch.Cast;
  const ArgumentType = Scratch.ArgumentType;
  const BlockType = Scratch.BlockType;

  const string = (name, defaultValue = '') => ({
    type: ArgumentType.STRING,
    defaultValue,
  });

  class StringsExtension {
    getInfo() {
      return {
        id: 'strings',
        name: 'Text',
        docsURI: 'https://extensions.turbowarp.org/text.js',
        blocks: [
          {
            opcode: 'count',
            blockType: BlockType.REPORTER,
            text: 'count [SUBSTRING] in [STRING]',
            arguments: {SUBSTRING: string('SUBSTRING'), STRING: string('STRING')},
          },
          {
            opcode: 'identical',
            blockType: BlockType.BOOLEAN,
            text: '[OPERAND1] identical to [OPERAND2]?',
            arguments: {OPERAND1: string('OPERAND1'), OPERAND2: string('OPERAND2')},
          },
          {
            opcode: 'indexof',
            blockType: BlockType.REPORTER,
            text: 'index of [SUBSTRING] in [STRING]',
            arguments: {SUBSTRING: string('SUBSTRING'), STRING: string('STRING')},
          },
          {
            opcode: 'letters_of',
            blockType: BlockType.REPORTER,
            text: 'letters [LETTER1] to [LETTER2] of [STRING]',
            arguments: {
              LETTER1: {type: ArgumentType.NUMBER, defaultValue: 1},
              LETTER2: {type: ArgumentType.NUMBER, defaultValue: 1},
              STRING: string('STRING'),
            },
          },
          {
            opcode: 'menu_positions',
            blockType: BlockType.REPORTER,
            text: 'text position',
            disableMonitor: true,
          },
          {
            opcode: 'menu_trimMethod',
            blockType: BlockType.REPORTER,
            text: 'trim method',
            disableMonitor: true,
          },
          {
            opcode: 'posWith',
            blockType: BlockType.BOOLEAN,
            text: '[STRING] [POSITION] [SUBSTRING]?',
            arguments: {
              STRING: string('STRING'),
              POSITION: string('POSITION', 'starts'),
              SUBSTRING: string('SUBSTRING'),
            },
          },
          {
            opcode: 'replaceRegex',
            blockType: BlockType.REPORTER,
            text: 'replace regex /[REGEX]/[FLAGS] in [STRING] with [REPLACE]',
            arguments: {
              REGEX: string('REGEX'),
              FLAGS: string('FLAGS'),
              STRING: string('STRING'),
              REPLACE: string('REPLACE'),
            },
          },
          {
            opcode: 'split',
            blockType: BlockType.REPORTER,
            text: 'item [ITEM] of [STRING] split by [SPLIT]',
            arguments: {
              ITEM: {type: ArgumentType.NUMBER, defaultValue: 1},
              STRING: string('STRING'),
              SPLIT: string('SPLIT'),
            },
          },
          {
            opcode: 'trim',
            blockType: BlockType.REPORTER,
            text: 'trim whitespace [STRING] from [METHOD]',
            arguments: {STRING: string('STRING'), METHOD: string('METHOD', 'both')},
          },
        ],
        menus: {
          positions: ['starts', 'ends'],
          trimMethod: ['left', 'both', 'right'],
        },
      };
    }

    count(args) {
      const value = Cast.toString(args.STRING);
      const substring = Cast.toString(args.SUBSTRING);
      return substring ? value.split(substring).length - 1 : 0;
    }

    identical(args) {
      return Cast.toString(args.OPERAND1) === Cast.toString(args.OPERAND2);
    }

    indexof(args) {
      const index = Cast.toString(args.STRING).indexOf(Cast.toString(args.SUBSTRING));
      return index < 0 ? 0 : index + 1;
    }

    letters_of(args) {
      const value = Cast.toString(args.STRING);
      const first = Math.max(1, Math.trunc(Cast.toNumber(args.LETTER1)));
      const last = Math.max(first, Math.trunc(Cast.toNumber(args.LETTER2)));
      return value.slice(first - 1, last);
    }

    menu_positions(args) {
      return args.positions ?? 'starts';
    }

    menu_trimMethod(args) {
      return args.trimMethod ?? 'both';
    }

    posWith(args) {
      const value = Cast.toString(args.STRING);
      const substring = Cast.toString(args.SUBSTRING);
      return args.POSITION === 'ends' ? value.endsWith(substring) : value.startsWith(substring);
    }

    replaceRegex(args) {
      try {
        return Cast.toString(args.STRING).replace(
          new RegExp(Cast.toString(args.REGEX), Cast.toString(args.FLAGS)),
          Cast.toString(args.REPLACE),
        );
      } catch {
        return Cast.toString(args.STRING);
      }
    }

    split(args) {
      const values = Cast.toString(args.STRING).split(Cast.toString(args.SPLIT));
      return values[Math.trunc(Cast.toNumber(args.ITEM)) - 1] ?? '';
    }

    trim(args) {
      const value = Cast.toString(args.STRING);
      if (args.METHOD === 'left') return value.trimStart();
      if (args.METHOD === 'right') return value.trimEnd();
      return value.trim();
    }
  }

  Scratch.extensions.register(new StringsExtension());
})(Scratch);
