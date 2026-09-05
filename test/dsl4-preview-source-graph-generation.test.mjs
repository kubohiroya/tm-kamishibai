import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'vitest';

import {createDsl4ProductionSourceFrontend} from '../src/builder/index.js';
import {createDsl4PreviewSourceGraphGeneration, createDsl4SourceGraph} from '../src/dsl4/index.js';

const schema = JSON.parse(
  await readFile(new URL('../schema/dsl-4.schema.json', import.meta.url), 'utf8'),
);
const frontend = createDsl4ProductionSourceFrontend(schema);

async function graphWithScene(sceneSourcePath) {
  const sources = new Map([
    [
      'story.k4.yml',
      sceneSourcePath === 'story.k4.yml'
        ? "include: chapter.k4.yml\nkamishibai: '4.0'\nscenes:\n  opening: []\n"
        : "include: chapter.k4.yml\nkamishibai: '4.0'\n",
    ],
    ['chapter.k4.yml', sceneSourcePath === 'chapter.k4.yml' ? 'scenes:\n  opening: []\n' : '{}\n'],
  ]);
  return createDsl4SourceGraph('story.k4.yml', {
    readSource(sourcePath) {
      const source = sources.get(sourcePath);
      if (source === undefined) throw new Error(`Missing fixture ${sourcePath}`);
      return source;
    },
  });
}

test('identifies a preview generation by every source path and canonical node', async () => {
  const rootDeclaration = await createDsl4PreviewSourceGraphGeneration(
    await graphWithScene('story.k4.yml'),
    {
      sourceFrontend: frontend,
      sourceId: 'main',
      displayName: 'story.k4.yml',
      maxComposedSourceBytes: 16 * 1024,
      subtleCrypto: webcrypto.subtle,
    },
  );
  const includedDeclaration = await createDsl4PreviewSourceGraphGeneration(
    await graphWithScene('chapter.k4.yml'),
    {
      sourceFrontend: frontend,
      sourceId: 'main',
      displayName: 'story.k4.yml',
      maxComposedSourceBytes: 16 * 1024,
      subtleCrypto: webcrypto.subtle,
    },
  );

  assert.equal(rootDeclaration.result.ok, true);
  assert.equal(includedDeclaration.result.ok, true);
  assert.equal(rootDeclaration.result.canonicalSource, includedDeclaration.result.canonicalSource);
  assert.notEqual(rootDeclaration.key, includedDeclaration.key);
  assert.deepEqual(includedDeclaration.sourcePaths, ['story.k4.yml', 'chapter.k4.yml']);
  assert.match(includedDeclaration.result.sourceSnapshot.integrity, /^sha256-/u);
  assert.equal(includedDeclaration.result.sourceSnapshot.integrity, includedDeclaration.key);
  assert.equal(Object.isFrozen(includedDeclaration), true);
  assert.equal(Object.isFrozen(includedDeclaration.result), true);
});
