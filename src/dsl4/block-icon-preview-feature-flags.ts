interface BlockPreviewStartupEnvironment {
  readonly TW_BLOCK_ICON_PREVIEWS?: unknown;
  readonly location?: {readonly search?: unknown};
}

/** Project data cannot enable previews; only the explicit launch environment is trusted. */
export function readDsl4BlockIconPreviewsFlag(
  environment: BlockPreviewStartupEnvironment = globalThis as BlockPreviewStartupEnvironment,
): boolean {
  if (environment.TW_BLOCK_ICON_PREVIEWS === true) return true;
  const search = environment.location?.search;
  return (
    typeof search === 'string' && new URLSearchParams(search).get('twPlusBlockPreview') === '1'
  );
}

/** Fixed once at runtime startup, independently from saved story or block data. */
export const blockIconPreviewsEnabledAtStartup = readDsl4BlockIconPreviewsFlag();
