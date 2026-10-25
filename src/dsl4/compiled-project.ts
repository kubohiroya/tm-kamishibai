import {
  createDsl4CompiledStoryArtifact,
  Dsl4CompiledStoryError,
} from './compiled-story-artifact.js';
import {validateDsl4PublicationManifest} from './publication-manifest.js';
import {
  dsl4SourceStoragePaths,
  resolveDsl4EmbeddedSource,
  validateDsl4EmbeddedSourceDescriptor,
} from './source-descriptor.js';
import type {Dsl4SourceFrontend} from './source-frontend.js';
import {
  dsl4ConfigBlockSourceHatOpcode,
  dsl4LabeledBlockSourceHatOpcode,
} from './block-source-shared.js';
import type {Dsl4SubtleCrypto} from './subtle-crypto.js';

/** The distribution profiles a build can write. */
export const dsl4DistributionProfiles = Object.freeze(['source', 'compiled'] as const);
export type Dsl4DistributionProfile = (typeof dsl4DistributionProfiles)[number];

/** Where a compiled publication keeps each chapter's Story IR, named by segment id, not by file. */
export function dsl4CompiledPublicationEntry(segmentId: string) {
  return `story/${segmentId}.json`;
}

const sourceHatOpcodes = new Set([dsl4LabeledBlockSourceHatOpcode, dsl4ConfigBlockSourceHatOpcode]);
const maxSegmentStoryBytes = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string): never {
  throw new Dsl4CompiledStoryError(code, message);
}

interface CompileOptions {
  sourceFrontend: Dsl4SourceFrontend;
  maxSourceBytes: number;
  subtleCrypto?: Dsl4SubtleCrypto | undefined;
}

/**
 * Drop every kamishibai source declaration stack, with its shadows and the comments on it.
 *
 * A block-source project keeps its YAML as text inputs under these hats, so the compiled profile
 * cannot leave them behind. Other scripts are untouched.
 */
export function removeDsl4BlockSourceDeclarations(project: Record<string, unknown>) {
  if (!Array.isArray(project.targets)) fail('K4-COMPILED-BUILD-001', 'Project has no targets');
  let removed = 0;
  for (const target of project.targets) {
    if (!isRecord(target) || !isRecord(target.blocks)) continue;
    const blocks = target.blocks;
    const root = (id: string) => {
      const seen = new Set<string>();
      let current = id;
      for (;;) {
        const block = blocks[current];
        if (!isRecord(block) || typeof block.parent !== 'string' || seen.has(current))
          return current;
        seen.add(current);
        current = block.parent;
      }
    };
    const doomed = new Set(
      Object.keys(blocks).filter((id) => {
        const top = blocks[root(id)];
        return isRecord(top) && typeof top.opcode === 'string' && sourceHatOpcodes.has(top.opcode);
      }),
    );
    for (const id of doomed) delete blocks[id];
    removed += doomed.size;
    if (isRecord(target.comments)) {
      for (const [id, comment] of Object.entries(target.comments)) {
        if (isRecord(comment) && typeof comment.blockId === 'string' && doomed.has(comment.blockId))
          delete target.comments[id];
      }
    }
  }
  return removed;
}

/**
 * Replace one runtime component's YAML descriptor by its compiled story, in place.
 *
 * The story is re-parsed from the embedded canonical source, exactly as the runtime loader would,
 * and that StoryDocument is compiled. The runtime artifact descriptor is left as it is, because it
 * already names the source integrity the compiled story carries.
 */
export async function compileDsl4RuntimeComponentStorage(
  component: Record<string, unknown>,
  {sourceFrontend, maxSourceBytes, subtleCrypto = globalThis.crypto?.subtle}: CompileOptions,
) {
  if (component.compiled !== undefined)
    fail('K4-COMPILED-BUILD-001', 'Runtime component is already compiled');
  const descriptor = await validateDsl4EmbeddedSourceDescriptor(component.source, {
    maxSourceBytes,
    subtleCrypto,
  });
  const parsed = sourceFrontend.parse(descriptor.text, {sourceId: descriptor.sourceId});
  if (!parsed.ok) fail('K4-COMPILED-BUILD-001', 'Embedded source no longer parses');
  const compiled = await createDsl4CompiledStoryArtifact(parsed.storyDocument, {
    sourceIntegrity: descriptor.integrity,
    ...(descriptor.cacheIdentity === undefined ? {} : {cacheIdentity: descriptor.cacheIdentity}),
    subtleCrypto,
  });
  delete component.source;
  component.compiled = structuredClone(compiled);
  return compiled;
}

/** Turn a verified `source` project.json into the `compiled` profile, in place. */
export async function convertDsl4ProjectToCompiledProfile(
  project: Record<string, unknown>,
  options: CompileOptions,
) {
  const source = await resolveDsl4EmbeddedSource(project, {
    maxSourceBytes: options.maxSourceBytes,
    ...(options.subtleCrypto === undefined ? {} : {subtleCrypto: options.subtleCrypto}),
  });
  const segments = dsl4SourceStoragePaths[source.channel as keyof typeof dsl4SourceStoragePaths]
    .split('.')
    .slice(0, -1);
  let owner: unknown = project;
  for (const segment of segments) owner = isRecord(owner) ? owner[segment] : undefined;
  if (!isRecord(owner) || owner.source === undefined)
    fail('K4-COMPILED-BUILD-001', 'Embedded source storage could not be located');
  const compiled = await compileDsl4RuntimeComponentStorage(owner, options);
  removeDsl4BlockSourceDeclarations(project);
  return compiled;
}

async function sha256Hex(bytes: Uint8Array, subtleCrypto: Dsl4SubtleCrypto | undefined) {
  if (!subtleCrypto) fail('K4-COMPILED-BUILD-001', 'SHA-256 digest capability is unavailable');
  const digest = new Uint8Array(await subtleCrypto.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Turn a project carrying a `source` publication into the `compiled` profile, in place.
 *
 * Every chapter component is compiled and the YAML chapter sources are dropped. The manifest keeps
 * its chapters, titles and links, but each chapter now names its Story IR bytes
 * (`story/<segment>.json`) with their size and digest instead of the YAML file, and no URL: a
 * compiled publication carries its chapters itself. The entry project's own component and its
 * source hats are compiled too, since they hold the entry chapter's YAML.
 */
export async function convertDsl4PublicationToCompiledProfile(
  project: Record<string, unknown>,
  options: CompileOptions,
) {
  const storage = isRecord(project.extensionStorage) ? project.extensionStorage : null;
  const bundle =
    storage && isRecord(storage.kubohiroyakamishibai4) ? storage.kubohiroyakamishibai4 : null;
  const publication = bundle && isRecord(bundle.publication) ? bundle.publication : null;
  if (!publication || (publication.formatVersion !== 1 && publication.formatVersion !== 2))
    fail('K4-COMPILED-PUBLICATION-001', 'Project does not carry a version 1 or 2 publication');
  if (publication.profile !== undefined)
    fail('K4-COMPILED-PUBLICATION-001', 'Publication is already compiled');
  const manifest = validateDsl4PublicationManifest(publication.manifest);
  if (!isRecord(publication.components))
    fail('K4-COMPILED-PUBLICATION-001', 'Publication has no chapter components');
  // A freshly selected publication shares the entry chapter's component object with the project's
  // own runtime component; compile copies so each is converted exactly once.
  const components = structuredClone(publication.components);
  publication.components = components;
  const segments = [];
  for (const segment of manifest.segments) {
    const component = components[segment.id];
    if (!isRecord(component))
      fail('K4-COMPILED-PUBLICATION-001', `Publication chapter is missing: ${segment.id}`);
    const compiled = await compileDsl4RuntimeComponentStorage(component, options);
    const bytes = new TextEncoder().encode(JSON.stringify(compiled.story));
    if (bytes.byteLength > maxSegmentStoryBytes)
      fail(
        'K4-COMPILED-PUBLICATION-SIZE-001',
        `Chapter ${segment.id} Story IR exceeds the ${maxSegmentStoryBytes} byte chapter limit`,
      );
    segments.push({
      ...structuredClone(segment),
      source: {
        entry: dsl4CompiledPublicationEntry(segment.id),
        integrity: `sha256-${await sha256Hex(bytes, options.subtleCrypto ?? globalThis.crypto?.subtle)}`,
        size: bytes.byteLength,
      },
    });
  }
  publication.manifest = validateDsl4PublicationManifest({...structuredClone(manifest), segments});
  delete publication.sources;
  publication.profile = 'compiled';
  await convertDsl4ProjectToCompiledProfile(project, options);
}
