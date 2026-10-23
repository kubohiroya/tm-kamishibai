import assert from 'node:assert/strict';
import {test} from 'vitest';
import {runInNewContext} from 'node:vm';
import {createDsl4NarrativeRowsEditor} from '../src/dsl4/narrative-row-editor.js';
import {createDsl4BlockAuthoringExtensionSource} from '../src/dsl4/structured-block-source.js';
import {createDsl4NarrativeEditorDefinitions} from '../src/dsl4/narrative-blocks.js';

test('table drafts keep the literal untouched until a validated patch and preserve unchanged formatting', () => {
  const definition = createDsl4NarrativeRowsEditor('authoring');
  const original = ' [ {"名前":"長兄", "待ち時間":1, "親切":false} ] ';
  const snapshot = {arguments: {ITEMS: {kind: 'literal', value: original}}};
  const draft = definition.read(snapshot);
  assert.deepEqual(definition.validate(draft), []);
  assert.deepEqual(definition.createPatch(draft, snapshot), []);
  draft.rows[0]!.名前 = '末弟';
  draft.rows[0]!.親切 = true;
  assert.equal(snapshot.arguments.ITEMS.value, original);
  const patch = definition.createPatch(draft, snapshot);
  assert.equal(patch[0]!.argument, 'ITEMS');
  assert.deepEqual(JSON.parse(patch[0]!.value), [{名前: '末弟', 待ち時間: 1, 親切: true}]);
});

test('table rejects partial numbers, different column types, duplicate names and reporter snapshots', () => {
  const definition = createDsl4NarrativeRowsEditor('authoring');
  const snapshot = {arguments: {ITEMS: {kind: 'literal', value: '[{"時間":1}]'}}};
  const draft = definition.read(snapshot);
  draft.rows[0]!.時間 = '1e';
  assert(definition.validate(draft).length);
  assert.throws(() => definition.createPatch(draft, snapshot), /確認/);
  draft.rows[0]!.時間 = 1;
  draft.rows.push({時間: true});
  assert(definition.validate(draft).length);
  draft.rows.pop();
  draft.columns.push({...draft.columns[0]!});
  assert(definition.validate(draft).length);
  assert.throws(() => definition.read({arguments: {ITEMS: {kind: 'reporter'}}}), /固定/);
});

test('embedded authoring code registers the custom table once and falls back to schema-only hosts', () => {
  for (const custom of [false, true]) {
    const registered: string[] = [];
    const api: Record<string, unknown> = {
      apiVersion: 1,
      registerSchema(definition: {editorId: string}) {
        registered.push(definition.editorId);
        return () => {};
      },
    };
    if (custom)
      api.register = (definition: {editorId: string}) => {
        registered.push(definition.editorId);
        return () => {};
      };
    const source = createDsl4BlockAuthoringExtensionSource(
      createDsl4NarrativeEditorDefinitions('kubohiroyakamishibaiauthoring4'),
      {narrativeControlEnabled: true},
    );
    runInNewContext(source, {
      Scratch: {extensions: {register() {}}, gui: {blockEditors: api}},
      console,
    });
    assert.equal(
      registered.filter((id) => id === (custom ? 'narrative-rows-table' : 'narrative-rows')).length,
      1,
    );
    assert(!registered.includes(custom ? 'narrative-rows' : 'narrative-rows-table'));
  }
});
