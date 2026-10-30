import {describe, it, expect} from 'vitest';
import {
  createKamishibaiIncludeReferenceView,
  readKamishibaiIncludeReferenceView,
  dsl4EmbeddedYamlIncludeOpcode,
  dsl4BundledEmbeddedYamlIncludeOpcode,
  createDsl4EmbeddedYamlIncludeDefinition,
} from '../src/dsl4/embedded-yaml-include-views.js';
import {createDsl4StructuredBlockSourceDeclaration} from '../src/dsl4/structured-block-source.js';
import {extractDsl4BlockSourcesFromProject} from '../src/dsl4/turbowarp-yaml-json-block-source.js';
import {encodeSourceDocumentReference} from '@kubohiroya/turbowarp-document-data/composition';
const reference = (documentId: string) => ({
  providerId: 'test-owner',
  documentId,
});
const docs = [
  {reference: reference('story'), label: ''},
  {reference: reference('part'), label: 'part'},
  {reference: reference('shared'), label: 'shared'},
];
function declaration(label: string, id: string, includes: string[] = [], config = false) {
  return createDsl4StructuredBlockSourceDeclaration({
    source: {
      ...(config ? {variables: {volume: 50}} : {}),
      scenes: {[id]: [{wait: 1}]},
    },
    form: 'runtime',
    hatId: id,
    label,
    includeLabels: includes,
    idPrefix: id + '-',
  });
}
const project = () => ({
  targets: [
    {
      name: 'Stage',
      isStage: true,
      blocks: {
        ...declaration('', 'main', ['part', 'shared'], true),
        ...declaration('part', 'part', ['shared']),
        ...declaration('shared', 'shared'),
      },
    },
  ],
  extensionStorage: {owner: {canonicalMain: 'not copied by view'}},
  extensions: ['runtime'],
});
const build = (input = project(), form: 'bundled' | 'unbundled' = 'unbundled') =>
  createKamishibaiIncludeReferenceView(input, {
    entryReference: reference('story'),
    documents: docs,
    form,
  });
describe('pure include reference projection', () => {
  it.each(['bundled', 'unbundled'] as const)(
    'replaces story/config/include locally and reads the same module graph (%s)',
    (form) => {
      const original = project(),
        copy = structuredClone(original),
        built = build(original, form);
      expect(original).toEqual(copy);
      expect(readKamishibaiIncludeReferenceView(built.project, built.descriptor).sources).toEqual(
        extractDsl4BlockSourcesFromProject(original).sources,
      );
      expect(built.project.extensionStorage).toEqual(original.extensionStorage);
      const opcodes = Object.values(built.project.targets[0]!.blocks).map((b) => b.opcode);
      expect(opcodes).not.toContain('kubohiroyakamishibaiauthoring4_includeBlocks');
      expect(opcodes.some((opcode) => String(opcode).includes('embeddedYamlConfig'))).toBe(false);
      expect(opcodes).toContain(
        form === 'bundled' ? dsl4BundledEmbeddedYamlIncludeOpcode : dsl4EmbeddedYamlIncludeOpcode,
      );
      expect(JSON.stringify(built.descriptor)).not.toContain('canonicalMain');
      expect(JSON.stringify(built.descriptor)).not.toContain('main-');
    },
  );
  it('discovers references after all block IDs are changed', () => {
    const built = build(),
      blocks = built.project.targets[0]!.blocks;
    const mapped = Object.fromEntries(Object.keys(blocks).map((id) => [id, 'new-' + id]));
    const renamed = Object.fromEntries(
      Object.entries(blocks).map(([id, b]) => {
        const c = structuredClone(b);
        if (c.next) c.next = mapped[c.next]!;
        if (c.parent) c.parent = mapped[c.parent]!;
        for (const v of Object.values(c.inputs))
          if (Array.isArray(v))
            for (const index of [1, 2])
              if (typeof v[index] === 'string') v[index] = mapped[v[index]];
        return [mapped[id]!, c];
      }),
    );
    built.project.targets[0]!.blocks = renamed;
    expect(readKamishibaiIncludeReferenceView(built.project, built.descriptor).sources).toEqual(
      extractDsl4BlockSourcesFromProject(project()).sources,
    );
  });
  it('refuses missing raw/reference bindings instead of flattening', () => {
    expect(() =>
      createKamishibaiIncludeReferenceView(project(), {
        entryReference: reference('story'),
        documents: docs.slice(0, 2),
        form: 'unbundled',
      }),
    ).toThrow(/canonical document reference/);
  });
  it('refuses duplicate labels, conflicting references, unknown refs, mixed legacy, and duplicate roles', () => {
    for (const documents of [
      [...docs, {reference: reference('other'), label: 'part'}],
      [...docs, {reference: reference('part'), label: 'other'}],
    ])
      expect(() =>
        createKamishibaiIncludeReferenceView(project(), {
          entryReference: reference('story'),
          documents,
          form: 'unbundled',
        }),
      ).toThrow(/unique/);
    for (const mode of ['unknown', 'mixed', 'duplicate']) {
      const built = build(),
        blocks = built.project.targets[0]!.blocks;
      const include = Object.values(blocks).find(
        (b) => b.opcode === dsl4EmbeddedYamlIncludeOpcode,
      )!;
      if (mode === 'unknown')
        include.fields.DOCUMENT = [encodeSourceDocumentReference(reference('missing')), null];
      if (mode === 'mixed') include.opcode = 'kubohiroyakamishibaiauthoring4_includeBlocks';
      if (mode === 'duplicate') blocks.copy = structuredClone(blocks.main!);
      expect(() => readKamishibaiIncludeReferenceView(built.project, built.descriptor)).toThrow();
    }
  });
  it('allows shared acyclic modules, rejects cycles and checks depth even on detached modules', () => {
    expect(() => build()).not.toThrow();
    const built = build();
    expect(() =>
      readKamishibaiIncludeReferenceView(built.project, {
        ...built.descriptor,
        maxIncludeDepth: 1,
      }),
    ).toThrow(/depth/);
    const blocks = built.project.targets[0]!.blocks;
    const shared = blocks.shared!;
    const newId = 'cycle';
    blocks[newId] = {
      opcode: dsl4EmbeddedYamlIncludeOpcode,
      next: null,
      parent: 'shared',
      inputs: {},
      fields: {
        DOCUMENT: [encodeSourceDocumentReference(reference('part')), null],
      },
      shadow: false,
      topLevel: false,
    };
    blocks[newId].next = shared.next;
    shared.next = newId;
    if (blocks[newId].next) blocks[blocks[newId].next!]!.parent = newId;
    expect(() => readKamishibaiIncludeReferenceView(built.project, built.descriptor)).toThrow(
      /cycle/,
    );
  });
  it('declares an inert document-reference command without source or legacy label fields', () => {
    const d = createDsl4EmbeddedYamlIncludeDefinition({
      BlockType: {COMMAND: 'command'},
    });
    expect(d.opcode).toBe('embeddedYamlInclude');
    expect(Object.keys(d.arguments)).toEqual(['DOCUMENT']);
    expect(d.blockType).toBe('command');
  });
});

it('validates detached include chains without flattening or ignoring unused modules', () => {
  const input = {
    targets: [
      {
        name: 'Stage',
        isStage: true,
        blocks: {
          ...declaration('', 'root'),
          ...declaration('part', 'detached', ['shared']),
          ...declaration('shared', 'shared', ['end']),
          ...declaration('end', 'end'),
        },
      },
    ],
  };
  const documents = [...docs, {reference: reference('end'), label: 'end'}];
  const options = {
    entryReference: reference('story'),
    documents,
    form: 'unbundled' as const,
  };
  expect(() =>
    createKamishibaiIncludeReferenceView(input, {
      ...options,
      maxIncludeDepth: 1,
    }),
  ).toThrow(/depth/);
  const built = createKamishibaiIncludeReferenceView(input, {
    ...options,
    maxIncludeDepth: 2,
  });
  expect(
    Object.keys(readKamishibaiIncludeReferenceView(built.project, built.descriptor).sources),
  ).toHaveLength(4);
});
