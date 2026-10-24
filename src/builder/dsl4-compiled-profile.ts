import {
  createDsl4CompiledStoryArtifact,
  Dsl4CompiledStoryError,
} from '../dsl4/compiled-story-artifact.js';
import {dsl4SourceStoragePaths, resolveDsl4EmbeddedSource} from '../dsl4/source-descriptor.js';
import type {Dsl4SourceFrontend} from '../dsl4/source-frontend.js';
import {
  dsl4ConfigBlockSourceHatOpcode,
  dsl4LabeledBlockSourceHatOpcode,
} from '../dsl4/structured-block-source.js';
import type {Dsl4SubtleCrypto} from '../dsl4/subtle-crypto.js';
import {Sb3BuilderError} from './errors.js';

/** The distribution profiles a build can write. `sealed` is not implemented yet. */
export const dsl4DistributionProfiles = Object.freeze(['source', 'compiled'] as const);
export type Dsl4DistributionProfile = (typeof dsl4DistributionProfiles)[number];

const sourceHatOpcodes = new Set([dsl4LabeledBlockSourceHatOpcode, dsl4ConfigBlockSourceHatOpcode]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new Sb3BuilderError(message, {stage: 'dsl4-compile', code, cause});
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
 * Turn a verified `source` build's project.json into the `compiled` profile, in place.
 *
 * The story is re-parsed from the embedded canonical source, exactly as the runtime loader would
 * do, and that StoryDocument is compiled. The YAML descriptor is replaced by the Story IR in the
 * same storage channel; the runtime artifact descriptor is left as it is, because it already names
 * the source integrity the compiled story carries.
 */
export async function convertDsl4ProjectToCompiledProfile(
  project: Record<string, unknown>,
  {
    sourceFrontend,
    maxSourceBytes,
    subtleCrypto = globalThis.crypto?.subtle,
  }: {
    sourceFrontend: Dsl4SourceFrontend;
    maxSourceBytes: number;
    subtleCrypto?: Dsl4SubtleCrypto | undefined;
  },
) {
  const source = await resolveDsl4EmbeddedSource(project, {maxSourceBytes, subtleCrypto});
  const parsed = sourceFrontend.parse(source.descriptor.text, {
    sourceId: source.descriptor.sourceId,
  });
  if (!parsed.ok) fail('K4-COMPILED-BUILD-001', 'Embedded source no longer parses');
  let compiled;
  try {
    compiled = await createDsl4CompiledStoryArtifact(parsed.storyDocument, {
      sourceIntegrity: source.descriptor.integrity,
      ...(source.descriptor.cacheIdentity === undefined
        ? {}
        : {cacheIdentity: source.descriptor.cacheIdentity}),
      subtleCrypto,
    });
  } catch (error) {
    if (error instanceof Dsl4CompiledStoryError) fail(error.code, error.message, error);
    throw error;
  }
  const segments = dsl4SourceStoragePaths[source.channel as keyof typeof dsl4SourceStoragePaths]
    .split('.')
    .slice(0, -1);
  let owner: unknown = project;
  for (const segment of segments) owner = isRecord(owner) ? owner[segment] : undefined;
  if (!isRecord(owner) || owner.source === undefined)
    fail('K4-COMPILED-BUILD-001', 'Embedded source storage could not be located');
  delete owner.source;
  owner.compiled = structuredClone(compiled);
  removeDsl4BlockSourceDeclarations(project);
  return compiled;
}
