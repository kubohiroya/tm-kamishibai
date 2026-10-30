import {decodeSourceDocumentReference} from '@kubohiroya/turbowarp-document-data/composition';
import {readKamishibaiDocumentViewSource} from './embedded-yaml-project-views.js';
import {readKamishibaiGraphDocumentViewSource} from './embedded-yaml-graph-views.js';
import {kamishibaiDocumentOwner} from './embedded-yaml-document-owner.js';
import {
  readEmbeddedYamlSourceGraphRecord,
  sourceGraphDocumentPath,
} from './embedded-yaml-source-graph.js';
import {validateKamishibaiEmbeddedYamlRoot} from './embedded-yaml-root-validation.js';
import type {Dsl4SourceFrontend} from './source-frontend.js';
export {
  activeKamishibaiDocumentView,
  kamishibaiDocumentOwner,
} from './embedded-yaml-document-owner.js';
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** Clean views may run; unreadable, stale or edited views cannot consume older canonical text. */
export function assertKamishibaiDocumentSourceReady(
  project: Record<string, unknown>,
  options: {sourceFrontend?: Dsl4SourceFrontend} = {},
): void {
  const selected = kamishibaiDocumentOwner(project);
  if (!selected) return;
  const metadata = record(selected.owner.editorViews) ? selected.owner.editorViews : {};
  const views = record(metadata.views) ? metadata.views : {};
  const active = Object.entries(views).filter(
    ([, view]) => !record(view) || view.activeKind !== 'source',
  );
  if (!active.length) return;
  try {
    validateKamishibaiEmbeddedYamlRoot(project, {allowLegacySingle: true});
    const graph =
      selected.owner.sourceDocuments === undefined
        ? null
        : readEmbeddedYamlSourceGraphRecord(selected.owner.sourceDocuments);
    for (const [encoded, view] of active) {
      if (!record(view) || !['yaml-blocks', 'schema-blocks'].includes(String(view.activeKind)))
        throw new Error('An active document representation is unknown.');
      const reference = decodeSourceDocumentReference(encoded);
      const expected = graph
        ? graph.files[sourceGraphDocumentPath(graph, reference.documentId)]!.source
        : record(selected.owner.source)
          ? selected.owner.source.text
          : undefined;
      const visible = graph
        ? readKamishibaiGraphDocumentViewSource(project, reference)
        : readKamishibaiDocumentViewSource(project, reference, options.sourceFrontend);
      if (typeof expected !== 'string' || visible !== expected)
        throw new Error('The visible document differs from its canonical source.');
    }
  } catch (cause) {
    throw Object.assign(
      new Error(
        'Reflect edited or stale document block views into source before running or packaging this story.',
      ),
      {code: 'K4-SOURCE-VIEW-UNAPPLIED', cause},
    );
  }
}
