import {fromByteArray, toByteArray} from 'base64-js';
import {strToU8, unzipSync, zipSync} from 'fflate';
import {computeDsl4Sha256Integrity} from '../source-descriptor.js';
import {readDsl4ProjectPublication} from './publication-project.js';

/** Retain project originals across Packager's convertToPackagedRuntime asset-data disposal. */
export async function createDsl4PublicationStageArchive(
  project: Readonly<Record<string, unknown>>,
  projectFiles: unknown,
) {
  const embedded = (readDsl4ProjectPublication(project) as {stageArchive?: unknown} | null)
    ?.stageArchive;
  if (embedded !== undefined) return validateDsl4PublicationStageArchive(embedded);
  if (!projectFiles || typeof projectFiles !== 'object' || Array.isArray(projectFiles))
    throw new TypeError('Standard project files required');
  const archive: Record<string, Uint8Array> = Object.create(null);
  let total = 0;
  for (const [name, value] of Object.entries(projectFiles)) {
    if (name === 'project.json') continue;
    if (
      name.startsWith('/') ||
      name.includes('\\') ||
      name.includes('\0') ||
      name.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new TypeError('Unsafe publication archive entry');
    const bytes =
      typeof value === 'string'
        ? strToU8(value)
        : value instanceof Uint8Array
          ? new Uint8Array(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : null;
    if (!bytes) throw new TypeError('Invalid Standard project file');
    total += bytes.length;
    if (total > 64 * 1024 * 1024 || Object.keys(archive).length >= 4096)
      throw new TypeError('Publication stage assets exceed limit');
    archive[name] = bytes;
  }
  const scratchProject = structuredClone(project) as {
    extensions?: unknown;
    extensionURLs?: unknown;
    extensionStorage?: unknown;
    monitors?: unknown;
    targets: {
      blocks: unknown;
      comments?: unknown;
      costumes?: {md5ext?: string}[];
      sounds?: {md5ext?: string}[];
    }[];
  };
  delete scratchProject.extensions;
  delete scratchProject.extensionURLs;
  delete scratchProject.extensionStorage;
  for (const target of scratchProject.targets) {
    target.blocks = {};
    target.comments = {};
    for (const asset of [...(target.costumes ?? []), ...(target.sounds ?? [])]) {
      if (typeof asset.md5ext === 'string' && !archive[asset.md5ext])
        throw new TypeError(`Publication requires original project asset: ${asset.md5ext}`);
    }
  }
  const bytes = zipSync({...archive, 'project.json': strToU8(JSON.stringify(scratchProject))});
  if (bytes.length > 64 * 1024 * 1024)
    throw new TypeError('Publication stage archive exceeds limit');
  unpackDsl4PublicationStageArchive(bytes);
  return {
    bytes,
    descriptor: {
      size: bytes.length,
      integrity: await computeDsl4Sha256Integrity(bytes),
      data: fromByteArray(bytes),
    },
  };
}
export async function validateDsl4PublicationStageArchive(input: unknown) {
  const descriptor = input as {size?: unknown; integrity?: unknown; data?: unknown};
  if (
    !descriptor ||
    !Number.isSafeInteger(descriptor.size) ||
    Number(descriptor.size) < 1 ||
    Number(descriptor.size) > 64 * 1024 * 1024 ||
    typeof descriptor.data !== 'string' ||
    descriptor.data.length !== Math.ceil(Number(descriptor.size) / 3) * 4
  )
    throw new TypeError('Invalid publication stage archive');
  const bytes = toByteArray(descriptor.data);
  if (
    bytes.length !== descriptor.size ||
    fromByteArray(bytes) !== descriptor.data ||
    (await computeDsl4Sha256Integrity(bytes)) !== descriptor.integrity
  )
    throw new TypeError('Publication stage archive integrity mismatch');
  unpackDsl4PublicationStageArchive(bytes);
  return {
    bytes,
    descriptor: {
      size: bytes.length,
      integrity: String(descriptor.integrity),
      data: descriptor.data,
    },
  };
}

/** Check entry metadata before inflation to keep copied originals within the same memory bound. */
export function unpackDsl4PublicationStageArchive(bytes: Uint8Array) {
  let total = 0,
    count = 0;
  return unzipSync(bytes, {
    filter(entry) {
      if (
        ++count > 4096 ||
        entry.originalSize > 64 * 1024 * 1024 ||
        (total += entry.originalSize) > 64 * 1024 * 1024
      )
        throw new TypeError('Publication expanded stage archive exceeds limit');
      if (
        entry.name.startsWith('/') ||
        entry.name.includes('\\') ||
        entry.name.includes('\0') ||
        entry.name.split('/').some((part) => !part || part === '.' || part === '..')
      )
        throw new TypeError('Unsafe publication stage archive entry');
      return true;
    },
  });
}
