const MiB = 1024 * 1024;

/**
 * Upper bounds for the publication data a project keeps resident: every chapter source, every
 * chapter component (with its base64 asset files), and the base64 stage archive. They match the
 * Standard limits applied when a publication is built (sources within the 64 MiB asset budget,
 * components within twice that, and a 64 MiB stage archive), so opening a saved publication
 * enforces the same totals that creating it did.
 */
export const dsl4PublicationResidentLimits = Object.freeze({
  maxSourceBytes: 64 * MiB,
  maxComponentBytes: 128 * MiB,
  maxStageArchiveBytes: Math.ceil((64 * MiB) / 3) * 4,
  maxTotalBytes: 64 * MiB + 128 * MiB + Math.ceil((64 * MiB) / 3) * 4,
});

export type Dsl4PublicationResidentLimits = typeof dsl4PublicationResidentLimits;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const utf8Length = (value: unknown) =>
  new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;

/**
 * Measure the stored publication data in UTF-8 bytes. Component bytes include the formatVersion 2
 * `assetFiles` table (reported again as `sharedAssetBytes`), so both formats share one budget, and
 * any `entryComponents` stored beside the publication (reported as `entryComponentBytes`).
 * `duplicateAssetBytes` counts asset files whose integrity already appeared in an earlier chapter
 * component: copies that formatVersion 1 keeps once per chapter and formatVersion 2 avoids.
 */
export function measureDsl4PublicationResidentBytes(
  publication: unknown,
  entryComponents: readonly unknown[] = [],
) {
  const input = isRecord(publication) ? publication : {};
  const sources = isRecord(input.sources) ? input.sources : {};
  const components = isRecord(input.components) ? input.components : {};
  let sourceBytes = 0;
  for (const source of Object.values(sources)) sourceBytes += utf8Length(source);
  let componentBytes = 0;
  let duplicateAssetBytes = 0;
  const seen = new Set<string>();
  for (const component of Object.values(components)) {
    componentBytes += utf8Length(component);
    const assets = isRecord(component) && isRecord(component.assets) ? component.assets : {};
    const files = Array.isArray(assets.files) ? assets.files : [];
    const local = new Set<string>();
    for (const file of files) {
      if (!isRecord(file) || typeof file.integrity !== 'string' || typeof file.data !== 'string')
        continue;
      if (seen.has(file.integrity) && !local.has(file.integrity))
        duplicateAssetBytes += file.data.length;
      local.add(file.integrity);
    }
    for (const integrity of local) seen.add(integrity);
  }
  const assetFiles = isRecord(input.assetFiles) ? input.assetFiles : {};
  let sharedAssetBytes = 0;
  // Base64 is ASCII, so its string length is its UTF-8 length.
  for (const data of Object.values(assetFiles))
    sharedAssetBytes += typeof data === 'string' ? data.length : utf8Length(data);
  componentBytes += sharedAssetBytes;
  let entryComponentBytes = 0;
  for (const component of entryComponents) entryComponentBytes += utf8Length(component);
  componentBytes += entryComponentBytes;
  const stage = isRecord(input.stageArchive) ? input.stageArchive : null;
  const stageArchiveBytes = typeof stage?.data === 'string' ? stage.data.length : 0;
  return Object.freeze({
    sourceBytes,
    componentBytes,
    stageArchiveBytes,
    totalBytes: sourceBytes + componentBytes + stageArchiveBytes,
    sharedAssetBytes,
    entryComponentBytes,
    duplicateAssetBytes,
  });
}

/** Reject publication data beyond the resident limits, naming the exceeded part. */
export function assertDsl4PublicationResidentBudget(
  publication: unknown,
  limits: Dsl4PublicationResidentLimits = dsl4PublicationResidentLimits,
  entryComponents: readonly unknown[] = [],
) {
  const measured = measureDsl4PublicationResidentBytes(publication, entryComponents);
  const exceeded = (
    [
      ['sources', measured.sourceBytes, limits.maxSourceBytes],
      ['components', measured.componentBytes, limits.maxComponentBytes],
      ['stage archive', measured.stageArchiveBytes, limits.maxStageArchiveBytes],
      ['total', measured.totalBytes, limits.maxTotalBytes],
    ] as const
  ).find(([, bytes, limit]) => bytes > limit);
  if (exceeded) {
    const error = new TypeError(
      `Publication ${exceeded[0]} exceed the resident budget (${exceeded[1]} > ${exceeded[2]} bytes)`,
    );
    Object.defineProperty(error, 'code', {value: 'K4-PUBLICATION-BUDGET-001'});
    throw error;
  }
  return measured;
}
