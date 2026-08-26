import {contentTypeFor, extensionFor, imageDimensions, soundMetadata} from './dsl4-asset-media.js';
import {Sb3BuilderError} from './errors.js';
import {md5} from './hash.js';

const projectKinds = new Set(['backdrop', 'costume', 'sound']);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} message @param {string} code @param {unknown} [cause] @returns {never} */
function fail(message, code, cause) {
  throw new Sb3BuilderError(message, {stage: 'dsl4-asset-convert', code, cause});
}

/** @param {Record<string, unknown>} target */
export function projectTargetName(target) {
  return typeof target.name === 'string' ? target.name : '';
}

/** @param {Record<string, unknown>} target @param {string} actorId */
function projectActorVariableMatches(target, actorId) {
  const variables = isRecord(target.variables) ? target.variables : {};
  return Object.values(variables).some(
    (value) => Array.isArray(value) && value[0] === 'actorName' && value[1] === actorId,
  );
}

/** @param {Record<string, unknown>} project @param {Readonly<Record<string, any>>} asset */
export function projectTarget(project, asset) {
  const targets = Array.isArray(project.targets)
    ? /** @type {Record<string, unknown>[]} */ (project.targets)
    : [];
  if (asset.kind === 'backdrop' || asset.kind === 'sound') {
    const matches = targets.filter((target) => target.isStage === true);
    if (matches.length !== 1) {
      fail('SB3 must contain exactly one Stage target', 'K4-ASSET-CONVERT-PROJECT-001');
    }
    return matches[0];
  }
  const named = targets.filter(
    (target) => target.isStage !== true && projectTargetName(target) === asset.target,
  );
  if (named.length === 1) return named[0];
  const logical = targets.filter(
    (target) => target.isStage !== true && projectActorVariableMatches(target, asset.target),
  );
  if (logical.length === 1) return logical[0];
  const templates = targets.filter(
    (target) => target.isStage !== true && projectActorVariableMatches(target, '_template_'),
  );
  if (templates.length === 1) return templates[0];
  fail(
    `Costume target cannot be resolved exactly once in the SB3: ${String(asset.target)}`,
    'K4-ASSET-CONVERT-PROJECT-001',
  );
}

/** @param {Record<string, unknown>} project @param {Readonly<Record<string, any>>} asset */
function projectAssetSlot(project, asset) {
  const target = projectTarget(project, asset);
  const collectionName = asset.kind === 'sound' ? 'sounds' : 'costumes';
  const collection = target[collectionName] ?? [];
  if (!Array.isArray(collection)) {
    fail(
      `SB3 target ${projectTargetName(target)} has an invalid ${collectionName} collection`,
      'K4-ASSET-CONVERT-PROJECT-001',
    );
  }
  return {target, collectionName, collection: /** @type {Record<string, any>[]} */ (collection)};
}

/** @param {Record<string, Uint8Array>} archive @param {Record<string, unknown>} project @param {string} assetId @param {Readonly<Record<string, any>>} asset */
export function readProjectMaterial(archive, project, assetId, asset) {
  const {collection} = projectAssetSlot(project, asset);
  const name = asset.name ?? assetId;
  const matches = collection.filter((candidate) => candidate?.name === name);
  if (matches.length !== 1) {
    fail(
      `Project asset ${assetId} must resolve exactly once by name ${String(name)}`,
      'K4-ASSET-CONVERT-PROJECT-001',
    );
  }
  const descriptor = matches[0];
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
        contentType: contentTypeFor(contents, filename, asset.kind),
      }),
    ]),
  });
}

/** @param {Record<string, Uint8Array>} archive @param {Record<string, unknown>} project @param {string} assetId @param {Readonly<Record<string, any>>} asset @param {Readonly<Record<string, any>>} material */
export function addProjectAsset(archive, project, assetId, asset, material) {
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
  const bytes = Buffer.from(file.bytes);
  const contentType = file.contentType ?? contentTypeFor(bytes, file.path, asset.kind);
  const dataFormat = extensionFor(contentType, asset.kind);
  if (!['gif', 'jpeg', 'jpg', 'mp3', 'ogg', 'png', 'svg', 'wav'].includes(dataFormat)) {
    fail(
      `Content-Type ${contentType} is not supported by SB3 project assets`,
      'K4-ASSET-CONVERT-UNSUPPORTED-001',
    );
  }
  const {target, collectionName, collection} = projectAssetSlot(project, asset);
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

/** @param {Record<string, Uint8Array>} archive @param {Record<string, unknown>} project @param {string} assetId @param {Readonly<Record<string, any>>} asset */
export function removeProjectAsset(archive, project, assetId, asset) {
  const {target, collectionName, collection} = projectAssetSlot(project, asset);
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
  const [{candidate, index}] = matches;
  collection.splice(index, 1);
  target[collectionName] = collection;
  const filename =
    typeof candidate.md5ext === 'string'
      ? candidate.md5ext
      : `${String(candidate.assetId)}.${String(candidate.dataFormat)}`;
  const stillReferenced = (Array.isArray(project.targets) ? project.targets : []).some(
    (projectTarget) =>
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
