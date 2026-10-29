import {definitionRecord} from './definition-references.js';
import {computeDsl4Sha256Integrity} from './source-descriptor.js';
import type {Dsl4SubtleCrypto} from './subtle-crypto.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

/** Called only after the stored descriptor and all its retained payloads have been verified. */
export async function appendDsl4ImplicitProjectBundleAssets(
  verifiedBundle: unknown,
  story: Readonly<Record<string, unknown>>,
  missing: readonly string[],
  subtleCrypto: Dsl4SubtleCrypto | undefined,
) {
  const bundle = definitionRecord(verifiedBundle);
  const manifest = definitionRecord(bundle.manifest);
  const storyAssets = definitionRecord(story.assets);
  const assets = [
    ...(Array.isArray(manifest.assets) ? manifest.assets : []),
    ...missing.map((id) => {
      const asset = definitionRecord(storyAssets[id]);
      return {
        id,
        kind: asset.kind,
        loading: asset.loading,
        ...(asset.target === undefined ? {} : {target: asset.target}),
        ...(asset.bitmapResolution === undefined ? {} : {bitmapResolution: asset.bitmapResolution}),
        source: {type: 'project', name: asset.name},
      };
    }),
  ].sort((a, b) =>
    String(definitionRecord(a).id) < String(definitionRecord(b).id)
      ? -1
      : String(definitionRecord(a).id) > String(definitionRecord(b).id)
        ? 1
        : 0,
  );
  const content = {
    formatVersion: bundle.formatVersion,
    manifest: {formatVersion: 1, assets},
    files: bundle.files,
  };
  return {
    ...content,
    integrity: await computeDsl4Sha256Integrity(
      new TextEncoder().encode(JSON.stringify(canonical(content))),
      subtleCrypto,
    ),
  };
}
