import assert from 'node:assert/strict';
import {test} from 'vitest';
import {parse} from 'yaml';
import {createDsl4StructuredBlockSourceDeclaration} from '../src/dsl4/structured-block-source.js';
import {encodeSourceDocumentReference} from '@kubohiroya/turbowarp-document-data/composition';
import {
  dsl4BundledEmbeddedYamlHatOpcode,
  dsl4BundledEmbeddedYamlConfigHatOpcode,
} from '../src/dsl4/embedded-yaml-identity.js';
import schema from '../schema/dsl-4.schema.json' with {type: 'json'};
import {createDsl4ProductionSourceFrontend} from '../src/builder/dsl4-source-frontend.js';
import {
  buildKamishibaiSchemaBlockView,
  readKamishibaiSchemaBlockView,
  sourceFromKamishibaiSchemaBlockView,
} from '../src/dsl4/embedded-yaml-representations.js';
const frontend = createDsl4ProductionSourceFrontend(schema);
const reference = {providerId: 'kamishibai-dsl4', documentId: 'story'};
const source =
  "# original comment\nkamishibai: '4.0'\ncontrols:\n  keymaps:\n    production:\n      Space: navigation.nextAction\nscenes:\n  opening:\n    - wait: 1\n";
function project() {
  return {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        blocks: {
          start: {
            opcode: 'event_whenflagclicked',
            parent: null,
            next: null,
            topLevel: true,
            x: 200,
            y: 200,
          },
        },
      },
    ],
    extensionStorage: {
      kubohiroyakamishibai4: {
        components: {
          kubohiroyakamishibairuntime4: {
            source: {mode: 'embedded', text: source, sourceId: 'main'},
            artifact: {unchanged: true},
            assets: {unchanged: true},
          },
        },
      },
    },
    extensions: ['kubohiroyakamishibai4'],
    extensionURLs: {kubohiroyakamishibai4: 'data:original'},
  };
}
function renameSavedIds(input: ReturnType<typeof project>) {
  const value = structuredClone(input);
  const target = value.targets[0]!;
  const blocks = target.blocks as Record<string, Record<string, unknown>>;
  const ids = new Map(Object.keys(blocks).map((id, index) => [id, `s${index}`]));
  const remap = (id: unknown) => (typeof id === 'string' && ids.has(id) ? ids.get(id) : id);
  target.blocks = Object.fromEntries(
    Object.entries(blocks).map(([id, block]) => [
      ids.get(id)!,
      {
        ...block,
        parent: remap(block.parent),
        next: remap(block.next),
        inputs: Object.fromEntries(
          Object.entries((block.inputs ?? {}) as Record<string, unknown[]>).map(([key, input]) => [
            key,
            input.map((part, index) => (index > 0 ? remap(part) : part)),
          ]),
        ),
      },
    ]),
  ) as unknown as typeof target.blocks;
  return value;
}
test('schema view keeps exact original source, storage and unrelated blocks; roots store only stable references', () => {
  const original = project();
  const before = structuredClone(original);
  const result = buildKamishibaiSchemaBlockView(original, {
    reference,
    source,
    sourceId: 'main',
    form: 'bundled',
    sourceFrontend: frontend,
  });
  assert.deepEqual(original, before);
  assert.deepEqual(result.project.extensionStorage, before.extensionStorage);
  assert.deepEqual(
    (result.project.targets as typeof original.targets)[0]!.blocks.start,
    before.targets[0]!.blocks.start,
  );
  assert.equal(
    sourceFromKamishibaiSchemaBlockView(result.project, result.descriptor, source, frontend),
    source,
  );
  assert.equal(JSON.stringify(result.descriptor).includes('twpeSchema'), false);
  const roots = Object.values(
    (result.project.targets as typeof original.targets)[0]!.blocks,
  ).filter((block: Record<string, unknown>) => String(block.opcode).includes('embeddedYaml'));
  assert.equal(roots.length, 1);
  assert.equal(roots[0]!.opcode, dsl4BundledEmbeddedYamlHatOpcode);
  assert.ok(
    !Object.values((result.project.targets as typeof original.targets)[0]!.blocks).some(
      (block: Record<string, unknown>) => String(block.opcode).includes('embeddedYamlConfig'),
    ),
  );
  assert.ok(
    roots.every((block: Record<string, unknown>) =>
      JSON.stringify(block).includes('tw-embedded-yaml:1:kamishibai-dsl4:story'),
    ),
  );
});
test('standard save ID optimization cannot break story/config discovery or the exact raw round trip', () => {
  const built = buildKamishibaiSchemaBlockView(project(), {
    reference,
    source,
    sourceId: 'main',
    form: 'bundled',
    sourceFrontend: frontend,
  });
  const optimized = renameSavedIds(built.project as ReturnType<typeof project>);
  assert.ok(readKamishibaiSchemaBlockView(optimized, built.descriptor, frontend).parsed.ok);
  assert.equal(
    sourceFromKamishibaiSchemaBlockView(optimized, built.descriptor, source, frontend),
    source,
  );
});
test('unresolved include and an occupied document root are rejected without changing original work', () => {
  const input = project();
  const before = JSON.stringify(input);
  assert.throws(() =>
    buildKamishibaiSchemaBlockView(input, {
      reference,
      source: source + 'include: [chapter.k4.yml]\n',
      sourceId: 'main',
      form: 'bundled',
      sourceFrontend: frontend,
    }),
  );
  assert.equal(JSON.stringify(input), before);
  const built = buildKamishibaiSchemaBlockView(input, {
    reference,
    source,
    sourceId: 'main',
    form: 'bundled',
    sourceFrontend: frontend,
  });
  assert.throws(
    () =>
      buildKamishibaiSchemaBlockView(built.project, {
        reference,
        source,
        sourceId: 'main',
        form: 'bundled',
        sourceFrontend: frontend,
      }),
    /existing|connected/i,
  );
});

test('edited schema values return through the shared CST codec while retaining original comments', () => {
  const built = buildKamishibaiSchemaBlockView(project(), {
    reference,
    source,
    sourceId: 'main',
    form: 'bundled',
    sourceFrontend: frontend,
  });
  const target = (
    built.project.targets as {
      blocks: Record<string, Record<string, unknown>>;
    }[]
  )[0]!;
  const wait = Object.values(target.blocks).find((block) =>
    String(block.opcode).endsWith('__wait'),
  )!;
  assert.ok(wait);
  (wait.inputs as Record<string, unknown>).SECONDS = [1, [4, 2]];
  const patched = sourceFromKamishibaiSchemaBlockView(
    built.project,
    built.descriptor,
    source,
    frontend,
  );
  assert.notEqual(patched, source);
  assert.ok(patched.includes('# original comment'));
  assert.ok(patched.includes("kamishibai: '4.0'"));
  assert.equal(
    (built.project.extensionStorage as ReturnType<typeof project>['extensionStorage'])
      .kubohiroyakamishibai4.components.kubohiroyakamishibairuntime4.source.text,
    source,
  );
});

test('legacy configuration hats remain readable although new schema views use one document body', () => {
  const legacy = project(),
    decl = createDsl4StructuredBlockSourceDeclaration({
      source: parse(source) as Record<string, unknown>,
      form: 'bundle',
      hatId: 'legacy-story',
      idPrefix: 'legacy-',
      version: '4.0',
      simpleSpeech: false,
      textSafeLiterals: true,
    });
  for (const b of Object.values(decl))
    if (b.opcode.endsWith('_kamishibai') || b.opcode.endsWith('_kamishibaiConfig')) {
      b.opcode = b.opcode.endsWith('_kamishibaiConfig')
        ? dsl4BundledEmbeddedYamlConfigHatOpcode
        : dsl4BundledEmbeddedYamlHatOpcode;
      b.inputs = {};
      b.fields = {DOCUMENT: [encodeSourceDocumentReference(reference), null]};
    }
  Object.assign(legacy.targets[0]!.blocks, decl);
  const descriptor = {
    version: 2 as const,
    kind: 'schema-blocks' as const,
    reference,
    form: 'bundled' as const,
    sourceId: 'main',
  };
  assert.ok(readKamishibaiSchemaBlockView(legacy, descriptor, frontend).parsed.ok);
  assert.equal(sourceFromKamishibaiSchemaBlockView(legacy, descriptor, source, frontend), source);
});
