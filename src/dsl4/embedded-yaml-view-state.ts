import {
  readDocumentViewMetadata,
  type DocumentViewState,
} from '@kubohiroya/turbowarp-embedded-yaml/view-metadata';
import {kamishibaiEmbeddedYamlReference} from './embedded-yaml-identity.js';
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** The owner component remains the only serialized source; derived views stay beside it. */
export function kamishibaiDocumentOwner(
  project: Record<string, unknown>,
): {owner: Record<string, unknown>; form: 'bundled' | 'unbundled'} | null {
  const storage = record(project.extensionStorage) ? project.extensionStorage : {};
  const bundle = record(storage.kubohiroyakamishibai4) ? storage.kubohiroyakamishibai4 : {};
  const components = record(bundle.components) ? bundle.components : {};
  if (record(components.kubohiroyakamishibairuntime4))
    return {owner: components.kubohiroyakamishibairuntime4, form: 'bundled'};
  if (record(storage.kubohiroyakamishibairuntime4))
    return {owner: storage.kubohiroyakamishibairuntime4, form: 'unbundled'};
  return null;
}
export function activeKamishibaiDocumentView(
  project: Record<string, unknown>,
): DocumentViewState | null {
  const selected = kamishibaiDocumentOwner(project);
  return selected
    ? readDocumentViewMetadata(selected.owner, kamishibaiEmbeddedYamlReference)
    : null;
}
/** Execution and packaging must never silently consume an older canonical source. */
export function assertKamishibaiDocumentSourceReady(project: Record<string, unknown>): void {
  const selected = kamishibaiDocumentOwner(project);
  if (selected?.owner.sourceDocuments !== undefined) {
    const metadata = record(selected.owner.editorViews) ? selected.owner.editorViews : {};
    const views = record(metadata.views) ? metadata.views : {};
    if (Object.values(views).some((view) => record(view) && view.activeKind !== 'source'))
      throw Object.assign(
        new Error(
          'Reflect every active document block view into source before running or packaging this story.',
        ),
        {code: 'K4-SOURCE-VIEW-UNAPPLIED'},
      );
  }
  const active = activeKamishibaiDocumentView(project)?.activeKind ?? 'source';
  if (active !== 'source')
    throw Object.assign(
      new Error(
        'Reflect the active block representation into source before running or packaging this story.',
      ),
      {code: 'K4-SOURCE-VIEW-UNAPPLIED'},
    );
}
