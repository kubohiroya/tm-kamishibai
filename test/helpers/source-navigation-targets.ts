import assert from 'node:assert/strict';
import {readReference} from '@kubohiroya/turbowarp-document-source';
import {requireArray, requireDefined, requireRecord} from './require-value.js';

/** Check the sole permitted source-build addition while preserving every original target member. */
export function assertSourceNavigationTargets(
  actual: unknown,
  original: unknown,
  channel: 'bundled' | 'unbundled',
): void {
  const targets = requireArray(structuredClone(actual), 'the built targets');
  const stage = requireRecord(
    targets.find((target) => requireRecord(target, 'a target').isStage === true),
    'the Stage',
  );
  const blocks = requireRecord(stage.blocks, 'the Stage blocks');
  const opcode =
    channel === 'bundled'
      ? 'kubohiroyakamishibai4_kubohiroyakamishibairuntime4__embeddedYaml'
      : 'kubohiroyakamishibairuntime4_embeddedYaml';
  const markers = Object.entries(blocks).filter(
    ([, block]) => requireRecord(block, 'a Stage block').opcode === opcode,
  );
  assert.equal(markers.length, 1);
  const [id, value] = requireDefined(markers[0], 'the sole navigation marker');
  const marker = requireRecord(value, 'the navigation marker');
  assert.deepEqual(readReference(marker, stage), {
    providerId: 'kamishibai-dsl4',
    documentId: 'story',
  });
  assert.equal(marker.parent, null);
  assert.equal(marker.next, null);
  assert.equal(marker.topLevel, true);
  assert.equal(marker.shadow, false);
  assert.deepEqual(marker.inputs, {});
  assert.deepEqual(Object.keys(requireRecord(marker.fields, 'literal document fields')), [
    'DOCUMENT',
  ]);
  delete blocks[id];
  assert.deepEqual(targets, original);
}
