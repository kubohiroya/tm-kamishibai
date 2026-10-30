interface DocumentViewsStartupEnvironment {
  readonly TW_EMBEDDED_DOCUMENT_VIEWS?: unknown;
  readonly location?: {readonly search?: unknown};
}

/** Read only the launch environment; document/project data cannot enable this capability. */
export function readEmbeddedYamlDocumentViewsFlag(
  environment: DocumentViewsStartupEnvironment = globalThis as DocumentViewsStartupEnvironment,
): boolean {
  if (environment.TW_EMBEDDED_DOCUMENT_VIEWS === true) return true;
  const search = environment.location?.search;
  return typeof search === 'string' && new URLSearchParams(search).get('twPlusYamlEditor') === '1';
}
