import {
  createDsl4PublicationStageArchive,
  unpackDsl4PublicationStageArchive,
} from './publication-stage-archive.js';
import {strToU8, zipSync} from 'fflate';
import {loadDsl4RuntimeComponent} from '../runtime-artifact-loader.js';
import type {Dsl4SourceFrontend} from '../source-frontend.js';
import {createDsl4PublicationSourceProvider} from '../publication-loader.js';
import {
  convertDsl4PublicationToCompiledProfile,
  type Dsl4DistributionProfile,
  dsl4DistributionProfiles,
} from '../compiled-project.js';
import {
  publicationSegmentProject,
  readDsl4PublicationChapterText,
  validateDsl4PublicationProject,
} from './publication-project.js';

/** Preserve every verified chapter in one Standard-compatible SB3, including offline sources. */
export async function createDsl4PublicationDistributionSb3({
  project,
  projectFiles,
  sourceFrontend,
  maxSourceBytes,
  maxAssetFiles,
  maxTotalAssetBytes,
  distributionProfile,
}: {
  project: unknown;
  projectFiles: unknown;
  sourceFrontend: Dsl4SourceFrontend;
  maxSourceBytes: number;
  maxAssetFiles: number;
  maxTotalAssetBytes: number;
  /** Omit to keep the publication's current profile; `compiled` drops every chapter's YAML. */
  distributionProfile?: Dsl4DistributionProfile;
}) {
  if (distributionProfile !== undefined && !dsl4DistributionProfiles.includes(distributionProfile))
    throw new TypeError(`distributionProfile must be ${dsl4DistributionProfiles.join(' or ')}`);
  const current = validateDsl4PublicationProject(project, sourceFrontend);
  if (distributionProfile === 'source' && current.profile === 'compiled')
    throw new TypeError('A compiled publication cannot be saved with its sources again');
  if (distributionProfile === 'compiled' && current.profile === 'source') {
    // Compile a copy: the open project keeps its YAML for further editing.
    project = structuredClone(project);
    await convertDsl4PublicationToCompiledProfile(project as Record<string, unknown>, {
      sourceFrontend,
      maxSourceBytes,
    });
  }
  const publication = validateDsl4PublicationProject(project, sourceFrontend);
  const provider = createDsl4PublicationSourceProvider({
    mode: 'offline',
    readEntry: async (entry) => {
      const text = readDsl4PublicationChapterText(publication, entry);
      return text === undefined ? null : strToU8(text);
    },
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
