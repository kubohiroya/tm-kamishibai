import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';

import {fixedZipTimestamp} from './constants.js';
import {configureEmbeddedScript} from './embedded-script.js';
import {Sb3BuilderError, toAssetError} from './errors.js';
import {md5} from './hash.js';

/** @param {unknown} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Sb3BuilderError(message, {stage: 'build-sb3'});
}

/** @param {string} entryName */
function validateArchiveEntryName(entryName) {
  assert(
    entryName.length > 0 && !entryName.includes('\0'),
    `Unsafe empty or NUL ZIP entry: ${JSON.stringify(entryName)}`,
  );
  assert(!entryName.includes('\\'), `ZIP entry uses a backslash: ${JSON.stringify(entryName)}`);
  assert(
    !entryName.startsWith('/') && !/^[A-Za-z]:/u.test(entryName),
    `ZIP entry is absolute: ${JSON.stringify(entryName)}`,
  );
  const parts = entryName.replace(/\/$/u, '').split('/');
  assert(
    parts.every((part) => part && part !== '.' && part !== '..'),
    `ZIP entry has an unsafe path segment: ${JSON.stringify(entryName)}`,
  );
}

/** @param {Buffer | Uint8Array} archiveBytes */
export function readSb3(archiveBytes) {
  let archive;
  try {
    archive = unzipSync(new Uint8Array(archiveBytes));
  } catch (error) {
    throw new Sb3BuilderError('Base SB3 is not a valid ZIP archive.', {
      stage: 'read-base-sb3',
      cause: error,
    });
  }
  const entries = Object.entries(archive);
  assert(entries.length > 0, 'Base SB3 is empty.');
  for (const [entryName] of entries) validateArchiveEntryName(entryName);
  const projectEntry = archive['project.json'];
  assert(projectEntry, 'Base SB3 does not contain project.json.');
  let project;
  try {
    project = JSON.parse(strFromU8(projectEntry));
  } catch (error) {
    throw new Sb3BuilderError('Base SB3 project.json is invalid JSON.', {
      stage: 'read-base-sb3',
      cause: error,
    });
  }
  assert(
    project && typeof project === 'object' && !Array.isArray(project),
    'Base SB3 project.json must be an object.',
  );
  assert(Array.isArray(project.targets), 'Base SB3 project.json targets must be an array.');
  return {archive, project};
}

/**
 * @param {Record<string, Uint8Array>} archive
 * @param {Record<string, unknown>} project
 */
export function serializeSb3(archive, project) {
  const outputArchive = {...archive, 'project.json': strToU8(`${JSON.stringify(project)}\n`)};
  const orderedEntries = Object.fromEntries(
    Object.entries(outputArchive)
      .filter(([entryName]) => !entryName.endsWith('/'))
      .sort(([left], [right]) => {
        if (left === 'project.json') return -1;
        if (right === 'project.json') return 1;
        return left.localeCompare(right, 'en');
      }),
  );
  return Buffer.from(zipSync(orderedEntries, {level: 6, mtime: fixedZipTimestamp}));
}

/** @param {Record<string, unknown>} project @param {string} targetName */
function findTarget(project, targetName) {
  const targets = /** @type {Record<string, unknown>[]} */ (project.targets);
  const matches = targets.filter((target) =>
    targetName === '@stage'
      ? target.isStage === true
      : target.isStage !== true && target.name === targetName,
  );
  assert(
    matches.length === 1,
    `SB3 target must resolve exactly once: ${targetName} (found ${matches.length}).`,
  );
  return matches[0];
}

/**
 * @param {Buffer | Uint8Array} baseArchiveBytes
 * @param {import('./assets.js').ResolvedAsset[]} resolvedAssets
 * @param {{profile: 'editor' | 'player', scriptBytes: Buffer | Uint8Array, maxEmbeddedScriptBytes?: number}} options
 */
export function buildSb3Archive(baseArchiveBytes, resolvedAssets, options) {
  const {archive, project: baseProject} = readSb3(baseArchiveBytes);
  const project = structuredClone(baseProject);
  configureEmbeddedScript(
    project,
    options.profile,
    options.scriptBytes,
    options.maxEmbeddedScriptBytes,
  );
  const mappings = [];
  for (const resolved of resolvedAssets) {
    const {contents, entry} = resolved;
    try {
      const target = findTarget(project, entry.target);
      const collectionName =
        entry.kind === 'backdrop' || entry.kind === 'costume' ? 'costumes' : 'sounds';
      const collection = /** @type {Record<string, any>[]} */ (target[collectionName] ?? []);
      assert(
        Array.isArray(collection),
        `Target ${entry.target} ${collectionName} must be an array.`,
      );
      if (collection.some((asset) => asset?.name === entry.sb3Name)) {
        throw new Error(
          `SB3 asset name already exists at ${entry.target}/${collectionName}: ${entry.sb3Name}`,
        );
      }
      const assetId = md5(contents);
      const filename = `${assetId}.${entry.dataFormat}`;
      const existingContents = archive[filename];
      if (existingContents && Buffer.compare(Buffer.from(existingContents), contents) !== 0) {
        throw new Error(`SB3 archive filename collision: ${filename}`);
      }
      archive[filename] = new Uint8Array(contents);
      let projectAsset;
      if (collectionName === 'costumes') {
        projectAsset = {
          name: entry.sb3Name,
          bitmapResolution: /** @type {number} */ (entry.metadata.bitmapResolution),
          dataFormat: entry.dataFormat,
          assetId,
          md5ext: filename,
          rotationCenterX: /** @type {number} */ (entry.metadata.rotationCenterX),
          rotationCenterY: /** @type {number} */ (entry.metadata.rotationCenterY),
        };
      } else {
        projectAsset = {
          name: entry.sb3Name,
          assetId,
          dataFormat: entry.dataFormat,
          format: /** @type {string} */ (entry.metadata.format),
          rate: /** @type {number} */ (entry.metadata.rate),
          sampleCount: /** @type {number} */ (entry.metadata.sampleCount),
          md5ext: filename,
        };
      }
      collection.push(projectAsset);
      target[collectionName] = collection;
      mappings.push({
        assetId,
        filename,
        kind: entry.kind,
        name: entry.name,
        sb3Name: entry.sb3Name,
        target: entry.target,
      });
    } catch (error) {
      throw toAssetError(error, {assetName: entry.name, inputUri: entry.uri, stage: 'build-sb3'});
    }
  }
  const bytes = serializeSb3(archive, project);
  return {bytes, mappings, project};
}
