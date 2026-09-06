import type {Dsl4StoryDocumentAsset} from '../dsl4/story-asset.js';
import type {AssetMaterial} from './asset-material.js';
import {contentTypeFor, extensionFor, imageDimensions, soundMetadata} from './dsl4-asset-media.js';
import {Sb3BuilderError} from './errors.js';
import {md5} from './hash.js';

const projectKinds = new Set(['backdrop', 'costume', 'sound']);

interface Sb3ProjectAssetDescriptor {
  [key: string]: unknown;
  name?: unknown;
  assetId?: unknown;
  dataFormat?: unknown;
  md5ext?: unknown;
}

interface ProjectAssetReference {
  kind: string;
  target?: unknown;
  name?: string;
  bitmapResolution?: number;
}

function projectAssetTarget(asset: Readonly<ProjectAssetReference>, assetId: string) {
  if (typeof asset.target !== 'string' || asset.target.length === 0) {
    fail(`Project asset ${assetId} must declare a target`, 'K4-ASSET-CONVERT-PROJECT-001');
  }
  return asset.target;
}

function requireProjectAssetReference(
  assetId: string,
  asset: Readonly<Dsl4StoryDocumentAsset>,
): ProjectAssetReference {
  if (typeof asset.kind !== 'string' || asset.kind.length === 0) {
    fail(`Project asset ${assetId} must declare a kind`, 'K4-ASSET-CONVERT-PROJECT-001');
  }
  return {
    kind: asset.kind,
    target: asset.target,
    ...(asset.name === undefined ? {} : {name: asset.name}),
    ...(asset.bitmapResolution === undefined ? {} : {bitmapResolution: asset.bitmapResolution}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string, code: string, cause?: unknown): never {
  throw new Sb3BuilderError(message, {stage: 'dsl4-asset-convert', code, cause});
}

export function projectTargetName(target: Record<string, unknown>) {
  return typeof target.name === 'string' ? target.name : '';
}

function projectActorVariableMatches(target: Record<string, unknown>, actorId: string) {
  const variables = isRecord(target.variables) ? target.variables : {};
  return Object.values(variables).some(
    (value) => Array.isArray(value) && value[0] === 'actorName' && value[1] === actorId,
  );
}

export function projectTarget(
  project: Record<string, unknown>,
  asset: Readonly<ProjectAssetReference>,
  assetId = '',
) {
  const targets = Array.isArray(project.targets)
    ? (project.targets as Record<string, unknown>[])
    : [];
  if (asset.kind === 'backdrop' || asset.kind === 'sound') {
    const [stage, ...extraStages] = targets.filter((target) => target.isStage === true);
    if (!stage || extraStages.length > 0) {
      fail('SB3 must contain exactly one Stage target', 'K4-ASSET-CONVERT-PROJECT-001');
    }
    return stage;
  }
  const assetTarget = projectAssetTarget(asset, assetId);
  const named = targets.filter(
    (target) => target.isStage !== true && projectTargetName(target) === assetTarget,
  );
  const [namedTarget] = named;
  if (named.length === 1 && namedTarget) return namedTarget;
  const logical = targets.filter(
    (target) => target.isStage !== true && projectActorVariableMatches(target, assetTarget),
  );
  const [logicalTarget] = logical;
  if (logical.length === 1 && logicalTarget) return logicalTarget;
  const templates = targets.filter(
    (target) => target.isStage !== true && projectActorVariableMatches(target, '_template_'),
  );
  const [templateTarget] = templates;
  if (templates.length === 1 && templateTarget) return templateTarget;
  fail(
    `Costume target cannot be resolved exactly once in the SB3: ${assetTarget}`,
    'K4-ASSET-CONVERT-PROJECT-001',
  );
}

function projectAssetSlot(
  project: Record<string, unknown>,
  assetId: string,
  asset: Readonly<ProjectAssetReference>,
) {
  const target = projectTarget(project, asset, assetId);
  const collectionName = asset.kind === 'sound' ? 'sounds' : 'costumes';
  const collection = target[collectionName] ?? [];
  if (!Array.isArray(collection)) {
    fail(
      `SB3 target ${projectTargetName(target)} has an invalid ${collectionName} collection`,
      'K4-ASSET-CONVERT-PROJECT-001',
    );
  }
  return {target, collectionName, collection: collection as Sb3ProjectAssetDescriptor[]};
}

export function readProjectMaterial(
  archive: Record<string, Uint8Array>,
  project: Record<string, unknown>,
  assetId: string,
  asset: Dsl4StoryDocumentAsset,
): AssetMaterial {
  const projectAsset = requireProjectAssetReference(assetId, asset);
  const {collection} = projectAssetSlot(project, assetId, projectAsset);
  const name = projectAsset.name ?? assetId;
  const matches = collection.filter((candidate) => candidate?.name === name);
  if (matches.length !== 1) {
    fail(
      `Project asset ${assetId} must resolve exactly once by name ${String(name)}`,
      'K4-ASSET-CONVERT-PROJECT-001',
    );
  }
  const [descriptor] = matches;
  // The count check above leaves exactly one descriptor.
  if (!descriptor) fail('SB3 asset descriptor is missing', 'K4-ASSET-CONVERT-PROJECT-001');
  const filename =
    typeof descriptor.md5ext === 'string'
      ? descriptor.md5ext
      : `${String(descriptor.assetId)}.${String(descriptor.dataFormat)}`;
  const bytes = archive[filename];
  if (!bytes) {
    fail(`SB3 archive entry is missing for ${assetId}`, 'K4-ASSET-CONVERT-PROJECT-001');
  }
  const contents = Buffer.from(bytes);
  return Object.freeze({
    files: Object.freeze([
      Object.freeze({
        path: filename,
        bytes: contents,
        contentType: contentTypeFor(contents, filename, projectAsset.kind),
      }),
    ]),
  });
}

export function addProjectAsset(
  archive: Record<string, Uint8Array>,
  project: Record<string, unknown>,
  assetId: string,
  asset: Readonly<ProjectAssetReference>,
  material: Readonly<AssetMaterial>,
) {
  if (!projectKinds.has(asset.kind)) {
    fail(
      `Asset kind ${asset.kind} cannot be represented as an SB3 project asset: ${assetId}`,
      'K4-ASSET-CONVERT-UNSUPPORTED-001',
    );
  }
  if (material.files.length !== 1) {
    fail(`Project asset ${assetId} must contain exactly one file`, 'K4-ASSET-CONVERT-PROJECT-001');
  }
  const file = material.files[0];
  if (!file) fail(`Project asset ${assetId} must contain a file`, 'K4-ASSET-CONVERT-PROJECT-001');
  const bytes = Buffer.from(file.bytes);
  const contentType = file.contentType ?? contentTypeFor(bytes, file.path, asset.kind);
  const dataFormat = extensionFor(contentType, asset.kind);
  if (!['gif', 'jpeg', 'jpg', 'mp3', 'ogg', 'png', 'svg', 'wav'].includes(dataFormat)) {
    fail(
      `Content-Type ${contentType} is not supported by SB3 project assets`,
      'K4-ASSET-CONVERT-UNSUPPORTED-001',
    );
  }
  const {target, collectionName, collection} = projectAssetSlot(project, assetId, asset);
  const name = assetId;
  const existing = collection.filter((candidate) => candidate?.name === name);
  if (existing.length > 0) {
    fail(
      `SB3 project asset name already exists at ${projectTargetName(target)}/${collectionName}: ${name}`,
      'K4-ASSET-CONVERT-PROJECT-COLLISION-001',
    );
  }
  const digest = md5(bytes);
  const filename = `${digest}.${dataFormat}`;
  const archived = archive[filename];
  if (archived && !Buffer.from(archived).equals(bytes)) {
    fail(`SB3 archive filename collision: ${filename}`, 'K4-ASSET-CONVERT-PROJECT-COLLISION-001');
  }
  archive[filename] = new Uint8Array(bytes);
  if (asset.kind === 'sound') {
    const metadata = soundMetadata(bytes, contentType);
    collection.push({
      name,
      assetId: digest,
      dataFormat,
      format: '',
      rate: metadata.rate,
      sampleCount: metadata.sampleCount,
      md5ext: filename,
    });
  } else {
    const dimensions = imageDimensions(bytes, contentType);
    collection.push({
      name,
      bitmapResolution: asset.bitmapResolution ?? 1,
      dataFormat,
      assetId: digest,
      md5ext: filename,
      rotationCenterX: dimensions.width / 2,
      rotationCenterY: dimensions.height / 2,
    });
  }
  target[collectionName] = collection;
  return name;
}

export function removeProjectAsset(
  archive: Record<string, Uint8Array>,
  project: Record<string, unknown>,
  assetId: string,
  asset: Readonly<ProjectAssetReference>,
) {
  const {target, collectionName, collection} = projectAssetSlot(project, assetId, asset);
  const name = asset.name ?? assetId;
  const matches = collection
    .map((candidate, index) => ({candidate, index}))
    .filter(({candidate}) => candidate?.name === name);
  if (matches.length !== 1) {
    fail(
      `Project asset ${assetId} must resolve exactly once before removal`,
      'K4-ASSET-CONVERT-PROJECT-001',
    );
  }
  const [firstMatch] = matches;
  // The count check above leaves exactly one match.
  if (!firstMatch) fail('Project asset did not resolve', 'K4-ASSET-CONVERT-PROJECT-001');
  const {candidate, index} = firstMatch;
  collection.splice(index, 1);
  target[collectionName] = collection;
  const filename =
    typeof candidate.md5ext === 'string'
      ? candidate.md5ext
      : `${String(candidate.assetId)}.${String(candidate.dataFormat)}`;
  const stillReferenced = (Array.isArray(project.targets) ? project.targets : []).some(
    (projectTarget) =>
      isRecord(projectTarget) &&
      ['costumes', 'sounds'].some(
        (key) =>
          Array.isArray(projectTarget?.[key]) &&
          projectTarget[key].some((entry) => {
            const reference =
              typeof entry?.md5ext === 'string'
                ? entry.md5ext
                : `${String(entry?.assetId)}.${String(entry?.dataFormat)}`;
            return reference === filename;
          }),
      ),
  );
  if (!stillReferenced) delete archive[filename];
}
