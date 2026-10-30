import assert from 'node:assert/strict';
import {test} from 'vitest';
import {encodeReference} from '@kubohiroya/turbowarp-embedded-yaml';
const reference = {providerId: 'kamishibai-dsl4', documentId: 'story'};

import {
  createDsl4EmbeddedYamlHatDefinition,
  dsl4BundledEmbeddedYamlHatOpcode,
  dsl4EmbeddedYamlHatIconURI,
  dsl4EmbeddedYamlHatOpcode,
  installDsl4EmbeddedYamlHat,
  removeDsl4EmbeddedYamlHats,
} from '../src/dsl4/embedded-yaml-hat.js';

function fixture(channel: 'bundled' | 'unbundled' = 'bundled') {
  const component = {
    source: {
      mode: 'embedded',
      text: "kamishibai: '4.0'\nscenes:\n  opening: []\n",
    },
    application: {mode: 'story'},
  };
  const stage = {
    isStage: true,
    name: 'Stage',
    blocks: {
      start: {
        opcode: 'event_whenflagclicked',
        parent: null,
        next: null,
        topLevel: true,
        x: 12,
        y: 24,
      },
    } as Record<string, Record<string, unknown>>,
    comments: {} as Record<string, unknown>,
  };
  const sprite = {isStage: false, name: 'Actor', blocks: {}};
  const project: Record<string, unknown> = {
    targets: [stage, sprite],
    extensionStorage:
      channel === 'bundled'
        ? {
            kubohiroyakamishibai4: {
              formatVersion: 1,
              components: {kubohiroyakamishibairuntime4: component},
            },
          }
        : {kubohiroyakamishibairuntime4: component},
  };
  return {project, stage, sprite, component};
}

test('the declaration has a dedicated YAML file icon and no source argument or executable edge', () => {
  const definition = createDsl4EmbeddedYamlHatDefinition({HAT: 'hat'});
  assert.equal(definition.opcode, 'embeddedYaml');
  assert.equal(definition.blockType, 'hat');
  assert.equal(definition.text, 'embedded YAML [DOCUMENT]');
  assert.equal(definition.isEdgeActivated, false);
  assert.deepEqual(definition.arguments.DOCUMENT, {
    type: 'string',
    menu: 'embeddedYamlDocuments',
    defaultValue: encodeReference(reference),
  });
  assert.equal(definition.blockIconURI, dsl4EmbeddedYamlHatIconURI);
  const svg = decodeURIComponent(definition.blockIconURI.split(',')[1]!);
  assert.match(svg, /viewBox="0 0 48 48"/);
  assert.match(svg, />YAML<\/text>/);
  assert.equal(svg.includes('<script'), false);
});

test('each channel gets one Stage marker while existing scripts and the sole source text stay intact', () => {
  for (const channel of ['bundled', 'unbundled'] as const) {
    const f = fixture(channel);
    const source = JSON.stringify(f.component);
    const start = structuredClone(f.stage.blocks.start);
    const id = installDsl4EmbeddedYamlHat(f.project, {channel});
    assert.equal(typeof id, 'string');
    const marker = f.stage.blocks[id!];
    assert.equal(
      marker!.opcode,
      channel === 'bundled' ? dsl4BundledEmbeddedYamlHatOpcode : dsl4EmbeddedYamlHatOpcode,
    );
    assert.deepEqual(marker!.inputs, {});
    assert.deepEqual(marker!.fields, {DOCUMENT: [encodeReference(reference), null]});
    assert.equal(marker!.next, null);
    assert.equal(marker!.parent, null);
    assert.equal(marker!.topLevel, true);
    assert.ok(Number(marker!.y) < Number(start!.y));
    assert.deepEqual(f.stage.blocks.start, start);
    assert.deepEqual(f.sprite.blocks, {});
    assert.equal(JSON.stringify(f.component), source);
    assert.equal(JSON.stringify(marker).includes(f.component.source.text), false);
    const after = JSON.stringify(f.project);
    assert.equal(installDsl4EmbeddedYamlHat(f.project, {channel}), id);
    assert.equal(JSON.stringify(f.project), after);
  }
});

test('a colliding block ID is preserved and a channel transition reuses the existing declaration', () => {
  const f = fixture('unbundled');
  f.stage.blocks['embedded-yaml-document'] = {opcode: 'looks_show'};
  const id = installDsl4EmbeddedYamlHat(f.project, {channel: 'unbundled'});
  assert.equal(id, 'embedded-yaml-document-2');
  assert.equal(f.stage.blocks['embedded-yaml-document']!.opcode, 'looks_show');
  f.project.extensionStorage = {
    kubohiroyakamishibai4: {
      components: {kubohiroyakamishibairuntime4: f.component},
    },
  };
  assert.equal(installDsl4EmbeddedYamlHat(f.project, {channel: 'bundled'}), id);
  assert.equal(f.stage.blocks[id!]!.opcode, dsl4BundledEmbeddedYamlHatOpcode);
});

test('menu, compiled-only and block-authored projects are not given an embedded document marker', () => {
  for (const variant of ['menu', 'compiled', 'blocks', 'config', 'legacy'] as const) {
    const f = fixture();
    if (variant === 'menu') f.component.application.mode = 'menu';
    else if (variant === 'compiled') Object.assign(f.component, {compiled: {formatVersion: 1}});
    else
      f.stage.blocks.declaration = {
        opcode:
          variant === 'blocks'
            ? 'kubohiroyakamishibaiauthoring4_kamishibai'
            : variant === 'config'
              ? 'kubohiroyakamishibaiauthoring4_kamishibaiConfig'
              : 'example_whenDsl4Source',
      };
    const original = JSON.stringify(f.project);
    assert.equal(installDsl4EmbeddedYamlHat(f.project, {channel: 'bundled'}), null);
    assert.equal(JSON.stringify(f.project), original);
  }
});

test('marker removal retains user commands attached below it and removes its own attached comment only', () => {
  const f = fixture();
  const id = installDsl4EmbeddedYamlHat(f.project, {channel: 'bundled'})!;
  f.stage.blocks[id]!.next = 'user-command';
  f.stage.blocks['user-command'] = {
    opcode: 'looks_show',
    parent: id,
    next: null,
  };
  f.stage.comments.marker = {blockId: id, text: 'marker comment'};
  f.stage.comments.user = {
    blockId: 'user-command',
    text: 'keep this comment',
  };
  assert.equal(removeDsl4EmbeddedYamlHats(f.project), 1);
  assert.equal(f.stage.blocks[id], undefined);
  assert.equal(f.stage.blocks['user-command']!.parent, null);
  assert.equal(f.stage.blocks['user-command']!.topLevel, true);
  assert.equal(f.stage.blocks.start!.opcode, 'event_whenflagclicked');
  assert.equal(f.stage.comments.marker, undefined);
  assert.deepEqual(f.stage.comments.user, {
    blockId: 'user-command',
    text: 'keep this comment',
  });
  assert.equal(removeDsl4EmbeddedYamlHats(f.project), 0);
});
