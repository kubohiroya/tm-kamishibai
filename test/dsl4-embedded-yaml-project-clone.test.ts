import {describe, it, expect} from 'vitest';
import {cloneKamishibaiDocumentProject} from '../src/dsl4/embedded-yaml-project-clone.js';
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
describe('bounded document project copies', () => {
  it.each(['bundled', 'unbundled'])(
    'copies editable state while sharing immutable payloads without serializing them (%s)',
    (form) => {
      let traversals = 0;
      const payload = freeze({
        data: 'A'.repeat(4 * 1024 * 1024),
        toJSON() {
          traversals++;
          throw Error('Immutable payload must not be traversed by a representation copy');
        },
      });
      const component = {
        assets: payload,
        source: payload,
        sourceDocuments: payload,
        artifact: payload,
        editorViews: {
          version: 1,
          views: {document: {activeKind: 'source', descriptors: {}}},
        },
      };
      const components = {
        kubohiroyakamishibairuntime4: component,
        otherComponent: payload,
      };
      const namespace =
        form === 'bundled'
          ? {kubohiroyakamishibai4: {components, bundlePayload: payload}}
          : {kubohiroyakamishibairuntime4: component};
      const url = 'data:text/javascript,' + ' '.repeat(4 * 1024 * 1024);
      const original = freeze({
        extensions: ['runtime'],
        extensionURLs: {runtime: url} as Record<string, string>,
        targets: [
          {
            name: 'Stage',
            blocks: {hat: {opcode: 'hat', next: null as string | null}},
            comments: {note: {text: 'keep', blockId: 'hat'}},
            costumes: payload,
          },
        ],
        extensionStorage: {...namespace, unrelated: payload},
        unrelated: payload,
      });
      const copied = cloneKamishibaiDocumentProject(original),
        owner =
          form === 'bundled'
            ? copied.extensionStorage.kubohiroyakamishibai4!.components.kubohiroyakamishibairuntime4
            : copied.extensionStorage.kubohiroyakamishibairuntime4!;
      expect(copied).not.toBe(original);
      expect(copied.targets[0]).not.toBe(original.targets[0]);
      expect(copied.targets[0]!.blocks).not.toBe(original.targets[0]!.blocks);
      expect(copied.targets[0]!.comments).not.toBe(original.targets[0]!.comments);
      for (const field of ['assets', 'source', 'sourceDocuments', 'artifact'])
        expect(owner[field as keyof typeof owner]).toBe(payload);
      expect(copied.targets[0]!.costumes).toBe(payload);
      expect(copied.extensionStorage.unrelated).toBe(payload);
      expect(copied.unrelated).toBe(payload);
      expect(copied.extensionURLs.runtime).toBe(url);
      expect(copied.extensionURLs).not.toBe(original.extensionURLs);
      expect(copied.extensions).not.toBe(original.extensions);
      expect(owner.editorViews).not.toBe(component.editorViews);
      copied.extensions.push('authoring');
      copied.extensionURLs.authoring = 'data:small';
      copied.targets[0]!.blocks.hat.next = 'body';
      copied.targets[0]!.comments.note.text = 'edited';
      owner.editorViews.views.document.activeKind = 'schema-blocks';
      expect(original.extensions).toEqual(['runtime']);
      expect(original.extensionURLs).not.toHaveProperty('authoring');
      expect(original.targets[0]!.blocks.hat.next).toBeNull();
      expect(original.targets[0]!.comments.note.text).toBe('keep');
      expect(component.editorViews.views.document.activeKind).toBe('source');
      expect(traversals).toBe(0);
      if (form === 'bundled') {
        expect(copied.extensionStorage.kubohiroyakamishibai4).not.toBe(
          original.extensionStorage.kubohiroyakamishibai4,
        );
        expect(copied.extensionStorage.kubohiroyakamishibai4!.components).not.toBe(
          original.extensionStorage.kubohiroyakamishibai4!.components,
        );
        expect(copied.extensionStorage.kubohiroyakamishibai4!.components.otherComponent).toBe(
          payload,
        );
      }
    },
  );
});
