import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import {test} from 'vitest';
import canonicalSchema from '../schema/dsl-4.schema.json' with {type: 'json'};
import {createDsl4BlockAuthoringEditorDefinitions} from '../src/dsl4/block-authoring-editors.js';
import {
  createDsl4BlockAuthoringExtensionSource,
  dsl4BlockAuthoringExtensionId,
} from '../src/dsl4/structured-block-source.js';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');
const Ajv2020 = require('ajv/dist/2020.js');
const definitions = createDsl4BlockAuthoringEditorDefinitions(dsl4BlockAuthoringExtensionId);

test('projects the canonical schema into eight self-contained draft-07 VALUE editors', () => {
  assert.equal(definitions.length, 8);
  const roots = [
    'asset',
    'keymap',
    'assetId',
    'textStyle',
    'variableValue',
    'cover',
    'loadingScreen',
    'poseRecognition',
  ];
  const samples: unknown[][] = [
    [
      'backdrop',
      'costume:Hero',
      {kind: 'costume', target: 'Hero', file: 'hero.svg'},
      {kind: 'image', delivery: 'remote', source: {url: 'https://example.com/a.png'}},
      {kind: 'image', delivery: 'remote', source: {url: 'https://example.com/a.png', size: 1}},
      {kind: 'costume', file: 'hero.svg'},
      {kind: 'unknown'},
      null,
    ],
    [{Space: 'navigation.nextAction'}, {Space: 'invalid'}, {NotAKey: 'navigation.nextAction'}, {}],
    ['HeroIdle', '', {}, null],
    [{size: 24, color: '#ffffff'}, {size: -1}, {unknown: 1}, null],
    [0, 1.5, false, '', 'Hero', null, [], {}, Infinity],
    [{backdrop: 'Beach'}, {backdrop: 'Beach', bgm: 'Music'}, {}, {backdrop: 1}],
    [{backdrop: 'Beach', costumes: ['Loading']}, {backdrop: 'Beach', costumes: []}, {}],
    [{}, {preview: {mirroring: 'mirrored'}}, {preview: {mirroring: 'invalid'}}, {unknown: 1}],
  ];
  const canonical = new Ajv2020({strict: false, allErrors: true});
  canonical.addSchema(canonicalSchema);
  definitions.forEach((definition, index) => {
    assert.equal(definition.argument, 'VALUE');
    assert.equal(definition.format, 'json');
    assert.equal(definition.opcodes.length, 1);
    const projected = new Ajv({strict: false}).compile(definition.schema);
    const original = canonical.compile({$ref: `${canonicalSchema.$id}#/$defs/${roots[index]}`});
    for (const sample of samples[index]!) {
      assert.equal(
        projected(sample),
        original(sample),
        `${roots[index]}: ${JSON.stringify(sample)}`,
      );
    }
    assert.ok(!JSON.stringify(definition.schema).includes('"default":'));
  });
});

test('registers forms only with a compatible GUI API and releases registrations together', () => {
  for (const api of [
    undefined,
    {
      apiVersion: 2,
      registerSchema() {
        throw new Error('wrong API');
      },
    },
  ]) {
    let registered = false;
    runInNewContext(createDsl4BlockAuthoringExtensionSource(), {
      Scratch: {
        extensions: {
          register() {
            registered = true;
          },
        },
        gui: {blockEditors: api},
      },
    });
    assert.ok(registered);
  }
  const recorded: unknown[] = [];
  let removed = 0;
  let extension: {dispose(): void} | undefined;
  runInNewContext(createDsl4BlockAuthoringExtensionSource(), {
    Scratch: {
      extensions: {
        register(value: typeof extension) {
          extension = value;
        },
      },
      gui: {
        blockEditors: {
          apiVersion: 1,
          registerSchema(value: unknown) {
            recorded.push(value);
            return () => {
              removed++;
            };
          },
        },
      },
    },
  });
  assert.equal(recorded.length, 8);
  extension!.dispose();
  extension!.dispose();
  assert.equal(removed, 8);
});

test('registration failure removes partial forms and preserves ordinary blocks', () => {
  let registered = false;
  let calls = 0;
  let removed = 0;
  let warnings = 0;
  runInNewContext(createDsl4BlockAuthoringExtensionSource(), {
    console: {
      warn() {
        warnings++;
      },
    },
    Scratch: {
      extensions: {
        register() {
          registered = true;
        },
      },
      gui: {
        blockEditors: {
          apiVersion: 1,
          registerSchema() {
            if (++calls === 3) throw new Error('registration failed');
            return () => {
              removed++;
            };
          },
        },
      },
    },
  });
  assert.ok(registered);
  assert.equal(removed, 2);
  assert.equal(warnings, 1);
});
