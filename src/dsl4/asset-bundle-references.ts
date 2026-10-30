import {definitionRecord} from './definition-references.js';
import {validateDsl4EmbeddedAssetBundle} from './asset-bundle-descriptor.js';
import {validateDsl4BinaryEntryAssetBundle} from './binary-entry-provider.js';
import {computeDsl4Sha256Integrity} from './source-descriptor.js';
import type {Dsl4SubtleCrypto} from './subtle-crypto.js';
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const json = (value: unknown) => JSON.stringify(canonical(value));
function nonFileAsset(id: string, asset: Record<string, unknown>) {
  return {
    id,
    kind: asset.kind,
    loading: asset.loading,
    ...(asset.target === undefined ? {} : {target: asset.target}),
    ...(asset.bitmapResolution === undefined ? {} : {bitmapResolution: asset.bitmapResolution}),
    source:
      asset.delivery === 'remote'
        ? {type: 'remote', ...definitionRecord(asset.source)}
        : {type: 'project', name: asset.name},
  };
}
/** Authenticate retained bytes before rebinding references; never re-sign a corrupt bundle. */
export async function rebindDsl4AssetBundleReferences(
  story: Readonly<Record<string, unknown>>,
  previous: Record<string, unknown>,
  options: {
    maxFiles: number;
    maxFileBytes?: number;
    maxTotalBytes: number;
    subtleCrypto?: Dsl4SubtleCrypto | undefined;
    implicitProjectAssets?: readonly string[];
  },
): Promise<{
  descriptor: Readonly<Record<string, unknown>>;
  getFile?: (assetId: string, filePath: string) => Uint8Array;
}> {
  const rows = definitionRecord(previous.manifest).assets;
  const oldRows = Array.isArray(rows) ? rows : [];
  const assets = definitionRecord(story.assets);
  const implicit =
    options.implicitProjectAssets === undefined ? null : new Set(options.implicitProjectAssets);
  let priorStory: Readonly<Record<string, unknown>>;
  if (implicit) {
    const priorAssets = {...assets};
    const retained = new Map(
      oldRows.map((row) => [definitionRecord(row).id, definitionRecord(row)]),
    );
    for (const id of implicit) {
      const row = retained.get(id),
        asset = definitionRecord(assets[id]);
      if (!row) {
        delete priorAssets[id];
        continue;
      }
      const source = definitionRecord(row.source);
      if (
        source.type !== 'project' ||
        source.name !== asset.name ||
        !['costume', 'backdrop'].includes(String(asset.kind))
      )
        continue;
      const prior = {...asset};
      if (Object.hasOwn(row, 'bitmapResolution')) prior.bitmapResolution = row.bitmapResolution;
      else delete prior.bitmapResolution;
      priorAssets[id] = prior;
    }
    priorStory = json(priorAssets) === json(assets) ? story : {...story, assets: priorAssets};
  } else {
    priorStory = {
      ...story,
      assets: Object.fromEntries(
        oldRows.map((row) => {
          const asset = definitionRecord(row),
            source = definitionRecord(asset.source);
          return [
            String(asset.id),
            {
              kind: asset.kind,
              loading: asset.loading,
              ...(asset.target === undefined ? {} : {target: asset.target}),
              ...(asset.bitmapResolution === undefined
                ? {}
                : {bitmapResolution: asset.bitmapResolution}),
              ...(source.type === 'file'
                ? {file: source.inputPath}
                : source.type === 'remote'
                  ? {delivery: 'remote', source}
                  : {name: source.name}),
            },
          ];
        }),
      ),
    };
  }
  const binary = previous.formatVersion === 2 || previous.formatVersion === 3;
  const validate = async (value: Readonly<Record<string, unknown>>, bundle: unknown) =>
    binary
      ? {
          descriptor: await validateDsl4BinaryEntryAssetBundle(value, bundle, {
            ...options,
            maxFileBytes: options.maxFileBytes ?? options.maxTotalBytes,
          }),
        }
      : await validateDsl4EmbeddedAssetBundle(value, bundle, options);
  const verified = await validate(priorStory, previous);
  let nextRows: unknown[];
  if (implicit) {
    const retained = new Map(oldRows.map((row) => [String(definitionRecord(row).id), row]));
    for (const id of implicit) {
      const asset = definitionRecord(assets[id]),
        row = retained.get(id);
      if (!row) retained.set(id, nonFileAsset(id, asset));
      else if (asset.kind === 'costume' || asset.kind === 'backdrop') {
        const next = {...definitionRecord(row)};
        if (asset.bitmapResolution === undefined) delete next.bitmapResolution;
        else next.bitmapResolution = asset.bitmapResolution;
        retained.set(id, next);
      }
    }
    nextRows = [...retained.values()];
  } else {
    const retained = new Map(oldRows.map((row) => [String(definitionRecord(row).id), row]));
    nextRows = Object.entries(assets).map(([id, value]) => {
      const asset = definitionRecord(value);
      return typeof asset.file === 'string'
        ? (retained.get(id) ?? nonFileAsset(id, asset))
        : nonFileAsset(id, asset);
    });
  }
  nextRows.sort((a, b) =>
    String(definitionRecord(a).id) < String(definitionRecord(b).id)
      ? -1
      : String(definitionRecord(a).id) > String(definitionRecord(b).id)
        ? 1
        : 0,
  );
  const manifest = {formatVersion: 1, assets: nextRows};
  if (json(manifest) === json(previous.manifest)) {
    const checked = priorStory === story ? verified : await validate(story, previous);
    return {...checked, descriptor: previous};
  }
  const content = {formatVersion: previous.formatVersion, manifest, files: previous.files};
  return validate(story, {
    ...content,
    integrity: await computeDsl4Sha256Integrity(
      new TextEncoder().encode(json(content)),
      options.subtleCrypto,
    ),
  });
}
