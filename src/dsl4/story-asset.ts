/**
 * One asset of a normalized DSL 4.0 story document.
 *
 * The source frontend has already validated the document against the schema by the time anything
 * reads an asset off it, so this narrows the parse result for the fields its readers use rather
 * than re-checking them. It is deliberately not the schema's asset type: `createStoryDocument`
 * normalizes what the YAML declared, and the fields here are the normalized ones.
 *
 * The module has no imports so the pure DSL 4.0 core can use it.
 */
export interface Dsl4StoryDocumentAsset {
  kind?: string;
  loading?: string;
  target?: unknown;
  bitmapResolution?: number;
  name?: string;
  file?: unknown;
  delivery?: string;
  source?: Readonly<Record<string, unknown>>;
}
