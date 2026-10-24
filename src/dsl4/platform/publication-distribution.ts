import {
  createDsl4PublicationStageArchive,
  unpackDsl4PublicationStageArchive,
} from './publication-stage-archive.js';
import {strToU8, zipSync} from 'fflate';
import {loadDsl4RuntimeComponent} from '../runtime-artifact-loader.js';
import type {Dsl4SourceFrontend} from '../source-frontend.js';
import {createDsl4PublicationSourceProvider} from '../publication-loader.js';
import {
  publicationSegmentProject,
  readDsl4ProjectPublication,
  validateDsl4ProjectPublication,
} from './publication-project.js';

/** Preserve every verified chapter in one Standard-compatible SB3, including offline sources. */
export async function createDsl4PublicationDistributionSb3({
  project,
  projectFiles,
  sourceFrontend,
  maxSourceBytes,
  maxAssetFiles,
  maxTotalAssetBytes,
}: {
  project: unknown;
  projectFiles: unknown;
  sourceFrontend: Dsl4SourceFrontend;
  maxSourceBytes: number;
  maxAssetFiles: number;
  maxTotalAssetBytes: number;
}) {
  const publication = validateDsl4ProjectPublication(
    readDsl4ProjectPublication(project),
    sourceFrontend,
  );
  const provider = createDsl4PublicationSourceProvider({
    mode: 'offline',
    readEntry: async (entry) => strToU8(publication.sources[entry]!),
  });
  for (const segment of publication.manifest.segments) {
    await provider.read(segment);
    const result = await loadDsl4RuntimeComponent(
      publicationSegmentProject(
        project,
        publication.components[segment.id],
        publication.assetFiles,
      ),
      sourceFrontend,
      {maxSourceBytes, maxAssetFiles, maxTotalAssetBytes},
    );
    if (!result.ok) throw new TypeError(`Publication distribution rejected: ${segment.id}`);
  }
  if (!projectFiles || typeof projectFiles !== 'object' || Array.isArray(projectFiles))
    throw new TypeError('Standard project files required');
  const archive: Record<string, Uint8Array> = Object.create(null);
  let total = 0;
  const stage = await createDsl4PublicationStageArchive(
    project as Readonly<Record<string, unknown>>,
    projectFiles,
  );
  const distribution = structuredClone(project) as {
    extensionStorage: {kubohiroyakamishibai4: {publication: Record<string, unknown>}};
  };
  distribution.extensionStorage.kubohiroyakamishibai4.publication.stageArchive = stage.descriptor;
  const files: Record<string, unknown> = {
    ...unpackDsl4PublicationStageArchive(stage.bytes),
    ...projectFiles,
    'project.json': JSON.stringify(distribution),
  };
  if (Object.keys(files).length > 4096) throw new TypeError('Publication SB3 has too many entries');
  for (const [name, value] of Object.entries(files)) {
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
    if (!bytes) throw new TypeError('Invalid publication archive bytes');
    if (name === 'project.json' && bytes.length > 16 * 1024 * 1024)
      throw new TypeError('Publication project exceeds 16 MiB');
    total += bytes.length;
    if (total > 256 * 1024 * 1024) throw new TypeError('Publication archive exceeds 256 MiB');
    archive[name] = bytes;
  }
  return Object.freeze({bytes: zipSync(archive), filename: `${publication.manifest.id}.sb3`});
}
