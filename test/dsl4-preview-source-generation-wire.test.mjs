import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'vitest';

import {createDsl4ProductionSourceFrontend} from '../src/builder/index.js';
import {
  createDsl4PreviewSourceGenerationWire,
  decodeDsl4PreviewSourceGenerationWire,
  Dsl4PreviewSourceGenerationWireError,
  encodeDsl4PreviewSourceGenerationWire,
} from '../src/dsl4/index.js';

const schema = JSON.parse(
  await readFile(new URL('../schema/dsl-4.schema.json', import.meta.url), 'utf8'),
);
const frontend = createDsl4ProductionSourceFrontend(schema);

async function validResult() {
  const parsed = await frontend.parse("kamishibai: '4.0'\nscenes:\n  opening:\n    - wait: 10\n", {
    sourceId: 'main',
  });
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  return {
    ...parsed,
    sourceSnapshot: {
      sourceId: 'main',
      displayName: 'story.k4.yml',
      text: parsed.canonicalSource,
      byteLength: new TextEncoder().encode(parsed.canonicalSource).byteLength,
      integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    },
  };
}

test('round-trips one validated StoryDocument without raw source or local path fields', async () => {
  const result = await validResult();
  const bytes = encodeDsl4PreviewSourceGenerationWire({revision: 7, result});
  const decoded = decodeDsl4PreviewSourceGenerationWire(bytes);

  assert.equal(decoded.revision, 7);
  assert.equal(decoded.result.ok, true);
  assert.deepEqual(decoded.result.storyDocument, result.storyDocument);
  assert.deepEqual(decoded.result.sourceSnapshot, {
    sourceId: 'main',
    byteLength: result.sourceSnapshot.byteLength,
    integrity: result.sourceSnapshot.integrity,
  });
  assert.equal(Object.isFrozen(decoded), true);
  const serialized = new TextDecoder().decode(bytes);
  assert.equal(serialized.includes(result.canonicalSource), false);
  assert.equal(serialized.includes('story.k4.yml'), false);
  assert.equal(serialized.includes('/Users/'), false);
  assert.equal(serialized.includes('canonicalSource'), false);
  assert.equal(serialized.includes('"sourceSnapshot":{"text"'), false);
});

test('carries bounded invalid diagnostics without a stale StoryDocument', () => {
  const diagnostic = {
    version: 1,
    code: 'K4-YAML-001',
    severity: 'error',
    message: 'YAML is invalid',
    sourceId: 'main',
    range: {
      start: {line: 1, column: 1, offset: 0},
      end: {line: 1, column: 2, offset: 1},
    },
    path: '$',
    related: [],
  };
  const decoded = decodeDsl4PreviewSourceGenerationWire(
    encodeDsl4PreviewSourceGenerationWire({
      revision: 8,
      result: {ok: false, diagnostics: [diagnostic], sourceSnapshot: null},
    }),
  );
  assert.equal(decoded.result.ok, false);
  assert.equal(decoded.result.storyDocument, null);
  assert.deepEqual(decoded.result.diagnostics, [diagnostic]);
});

test('rejects oversized, malformed, stale-shape, and unbounded generation messages', async () => {
  const result = await validResult();
  assert.throws(
    () =>
      encodeDsl4PreviewSourceGenerationWire({
        revision: 1,
        result,
        maxMessageBytes: 32,
      }),
    (error) =>
      error instanceof Dsl4PreviewSourceGenerationWireError &&
      error.code === 'K4-PREVIEW-GENERATION-LIMIT',
  );
  assert.throws(
    () => decodeDsl4PreviewSourceGenerationWire(new Uint8Array(33), {maxMessageBytes: 32}),
    /1-32 bytes/u,
  );
  assert.throws(
    () => decodeDsl4PreviewSourceGenerationWire(new Uint8Array([0xff])),
    (error) => error.code === 'K4-PREVIEW-GENERATION-JSON',
  );
  const valid = createDsl4PreviewSourceGenerationWire({revision: 1, result});
  const unknown = structuredClone(valid);
  unknown.token = 'secret';
  assert.throws(
    () => decodeDsl4PreviewSourceGenerationWire(new TextEncoder().encode(JSON.stringify(unknown))),
    /unknown: token/u,
  );
  const rawSource = structuredClone(valid);
  rawSource.result.canonicalSource = result.canonicalSource;
  assert.throws(
    () =>
      decodeDsl4PreviewSourceGenerationWire(new TextEncoder().encode(JSON.stringify(rawSource))),
    /unknown: canonicalSource/u,
  );
  const leakedDiagnostic = structuredClone(valid);
  leakedDiagnostic.result.diagnostics = [
    {
      version: 1,
      code: 'K4-YAML-001',
      severity: 'error',
      message: 'YAML is invalid',
      sourceId: 'main',
      range: {
        start: {line: 1, column: 1, offset: 0},
        end: {line: 1, column: 1, offset: 0},
      },
      path: '$',
      related: [],
      absolutePath: '/Users/example/story.k4.yml',
    },
  ];
  assert.throws(
    () =>
      decodeDsl4PreviewSourceGenerationWire(
        new TextEncoder().encode(JSON.stringify(leakedDiagnostic)),
      ),
    /canonical DSL 4 envelope/u,
  );
  assert.throws(
    () =>
      createDsl4PreviewSourceGenerationWire({
        revision: 1,
        result: {...result, diagnostics: Array.from({length: 101}, () => result.diagnostics[0])},
      }),
    /at most 100/u,
  );
});

test('requires a valid snapshot and StoryDocument only for valid generations', async () => {
  const result = await validResult();
  assert.throws(
    () =>
      createDsl4PreviewSourceGenerationWire({
        revision: 1,
        result: {...result, sourceSnapshot: null},
      }),
    /source snapshot/u,
  );
  assert.throws(
    () =>
      createDsl4PreviewSourceGenerationWire({
        revision: 1,
        result: {...result, storyDocument: {kind: 'StoryDocument', version: '3.2'}},
      }),
    /DSL 4.0 StoryDocument/u,
  );
  assert.throws(
    () =>
      createDsl4PreviewSourceGenerationWire({
        revision: 0,
        result,
      }),
    /revision/u,
  );
});
