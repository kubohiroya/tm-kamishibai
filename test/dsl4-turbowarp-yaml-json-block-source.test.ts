import assert from 'node:assert/strict';
import {test} from 'vitest';
import {
  extractDsl4BlockSourcesFromProject,
  Dsl4BlockSourceError,
} from '../src/dsl4/turbowarp-yaml-json-block-source.js';

for (const prefix of [
  'kubohiroyakamishibairuntime4_',
  'kubohiroyakamishibai4_kubohiroyakamishibairuntime4__',
]) {
  test(`rejects the removed source hat: ${prefix}`, () => {
    const project = {
      targets: [
        {
          name: 'Stage',
          isStage: true,
          blocks: {
            oldHat: {
              opcode: `${prefix}whenDsl4Source`,
              next: 'oldSource',
              parent: null,
              inputs: {},
              fields: {},
              shadow: false,
              topLevel: true,
            },
            oldSource: {
              opcode: `${prefix}dsl4SourceFromYamlJson`,
              next: null,
              parent: 'oldHat',
              inputs: {FRAGMENT: [1, [10, "kamishibai: '4.0'\nscenes: {opening: [{wait: 1}]}\n"]]},
              fields: {},
              shadow: false,
              topLevel: false,
            },
          },
        },
      ],
    };
    assert.throws(
      () => extractDsl4BlockSourcesFromProject(project),
      (error) =>
        error instanceof Dsl4BlockSourceError && error.code === 'K4-BLOCK-SOURCE-REMOVED-001',
    );
  });
}
