import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import {test} from 'vitest';
import canonicalSchema from '../schema/dsl-4.schema.json' with {type: 'json'};
import {
  createDsl4BlockAuthoringEditorDefinitions,
  createDsl4CoreActionBlockEditorDefinitions,
} from '../src/builder/dsl4-block-authoring-editors.js';
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

for (const form of ['runtime', 'bundle'] as const) {
  test(`projects the canonical pose steps into a ${form} STEPS editor without relaxing constraints`, () => {
    const editors = createDsl4CoreActionBlockEditorDefinitions(form);
    assert.equal(editors.length, 1);
    const [editor] = editors;
    assert.equal(editor!.apiVersion, 1);
    assert.equal(
      editor!.extensionId,
      form === 'runtime' ? 'kubohiroyakamishibairuntime4' : 'kubohiroyakamishibai4',
    );
    assert.deepEqual(editor!.opcodes, [
      form === 'runtime'
        ? 'kubohiroyakamishibairuntime4_pose'
        : 'kubohiroyakamishibai4_kubohiroyakamishibairuntime4__pose',
    ]);
    assert.equal(editor!.argument, 'STEPS');
    assert.equal(editor!.format, 'json');
    const projected = new Ajv({strict: false}).compile(editor!.schema);
    const canonical = new Ajv2020({strict: false});
    canonical.addSchema(canonicalSchema);
    const original = canonical.compile({
      $ref: `${canonicalSchema.$id}#/$defs/poseArgs/properties/steps`,
    });
    const cases: [unknown, boolean][] = [
      [[{pose: '頭を守る'}], true],
      [[{pose: '頭を守る', skin: 'ProtectHead', sound: 'SuccessSound'}], true],
      [[{pose: 'Ready'}, {pose: 'Finish', skin: 'Finished'}], true],
      [[], false],
      [[{}], false],
      [[{skin: 'ProtectHead'}], false],
      [[{pose: ''}], false],
      [[{pose: 1}], false],
      [[{pose: 'Ready', skin: 1}], false],
      [[{pose: 'Ready', sound: ''}], false],
      [[{pose: 'Ready', confidence: 0.8}], false],
      [[{pose: 'Ready', extra: true}], false],
      [{steps: [{pose: 'Ready'}]}, false],
      [null, false],
      ['[]', false],
    ];
    for (const [sample, expected] of cases) {
      const label = JSON.stringify(sample);
      assert.equal(original(sample), expected, `canonical: ${label}`);
      assert.equal(projected(sample), expected, `projected: ${label}`);
    }
    assert.equal(editor!.schema.$schema, 'http://json-schema.org/draft-07/schema#');
    assert.ok(!JSON.stringify(editor!.schema).includes('"default":'));
    assert.ok(!JSON.stringify(editor!.schema).includes('#/$defs/'));
  });
}

test('a core-action form registration failure releases the eight preceding definition forms', () => {
  let extensionRegistered = false;
  let calls = 0;
  let removed = 0;
  let warnings = 0;
  runInNewContext(
    createDsl4BlockAuthoringExtensionSource([
      ...definitions,
      ...createDsl4CoreActionBlockEditorDefinitions('bundle'),
    ]),
    {
      console: {
        warn() {
          warnings++;
        },
      },
      Scratch: {
        extensions: {
          register() {
            extensionRegistered = true;
          },
        },
        gui: {
          blockEditors: {
            apiVersion: 1,
            registerSchema() {
              if (++calls === 9) throw new Error('core-action form unavailable');
              return () => {
                removed++;
              };
            },
          },
        },
      },
    },
  );
  assert.ok(extensionRegistered);
  assert.equal(calls, 9);
  assert.equal(removed, 8);
  assert.equal(warnings, 1);
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
    runInNewContext(createDsl4BlockAuthoringExtensionSource(definitions), {
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
  runInNewContext(createDsl4BlockAuthoringExtensionSource(definitions), {
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
  runInNewContext(createDsl4BlockAuthoringExtensionSource(definitions), {
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
