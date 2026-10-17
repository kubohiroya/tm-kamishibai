import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';
import {parse} from 'yaml';

import {canonicalizeDsl4Source} from '../dsl4/source-canonicalizer.js';
import {
  dsl4BlockSourceBundleExtensionId,
  Dsl4BlockSourceError,
  dsl4BlockSourceHatOpcode,
  dsl4BlockSourceRuntimeExtensionId,
  extractDsl4BlockSourcesFromProject,
} from '../dsl4/turbowarp-yaml-json-block-source.js';
import {
  createDsl4StructuredBlockSourceDeclaration,
  createDsl4BlockAuthoringExtensionSource,
  dsl4BlockAuthoringExtensionId,
} from '../dsl4/structured-block-source.js';
import {serializeDsl4CanonicalDocument} from './dsl4-validate.js';

import {fixedZipTimestamp} from './constants.js';
import {Sb3BuilderError} from './errors.js';

/** The block ids one declaration takes. Ids only have to be unique inside their own target. */
const hatBlockId = 'dsl4SourceHat';

export class Dsl4BlockSourceAuthorError extends Sb3BuilderError {
  constructor(message: string, details: {code?: string; cause?: unknown} = {}) {
    super(message, {
      stage: 'dsl4-block-source-author',
      ...(details.code === undefined ? {} : {code: details.code}),
      ...(details.cause === undefined ? {} : {cause: details.cause}),
    });
    this.name = 'Dsl4BlockSourceAuthorError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string, code?: string): never {
  throw new Dsl4BlockSourceAuthorError(message, code === undefined ? {} : {code});
}

/**
 * Which opcode form the base project's own extension uses.
 *
 * The runtime ships as a member of the bundle in a released base, and as its own extension in a
 * development one. Reading it off the project keeps the written blocks resolvable in the editor
 * instead of guessing a form that only the reader would accept.
 */
function opcodeFormForProject(project: Record<string, unknown>): 'runtime' | 'bundle' {
  const declared = new Set<string>([
    ...(Array.isArray(project.extensions)
      ? project.extensions.filter((id) => typeof id === 'string')
      : []),
    ...(isRecord(project.extensionURLs) ? Object.keys(project.extensionURLs) : []),
  ]);
  if (declared.has(dsl4BlockSourceBundleExtensionId)) return 'bundle';
  if (declared.has(dsl4BlockSourceRuntimeExtensionId)) return 'runtime';
  return fail(
    `Base SB3 must load ${dsl4BlockSourceBundleExtensionId} or ${dsl4BlockSourceRuntimeExtensionId} so the written blocks resolve`,
    'K4-BLOCK-AUTHOR-EXTENSION-001',
  );
}

function stageOf(project: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(project.targets)) fail('Base SB3 project must contain targets');
  const stages = project.targets.filter((target) => isRecord(target) && target.isStage === true);
  if (stages.length !== 1) fail('Base SB3 project must contain exactly one Stage');
  return stages[0] as Record<string, unknown>;
}

/**
 * Write one DSL 4.0 YAML source into a copy of a base SB3 as a block declaration.
 *
 * The result is an authoring source, not a runnable build: the declaration blocks are inert at
 * runtime and exist for the author to read, edit, and remix, while `build-dsl4` is what turns
 * them back into a runnable SB3. The source is validated first, so an invalid story fails instead
 * of producing a project that only looks right.
 */
export function authorDsl4BlockSourceSb3({
  baseBytes,
  sourceText,
  sourceFrontend,
  sourceId = 'main',
}: {
  baseBytes: Uint8Array;
  sourceText: string;
  sourceFrontend: import('../dsl4/source-frontend.js').Dsl4SourceFrontend;
  sourceId?: string;
}) {
  const canonicalSource = canonicalizeDsl4Source(sourceText);
  if (/^include:/mu.test(canonicalSource)) {
    fail(
      'A story with includes is not supported yet; author the root source only',
      'K4-BLOCK-AUTHOR-INCLUDE-001',
    );
  }
  const parsed = sourceFrontend.parse(canonicalSource, {sourceId});
  if (!parsed.ok) {
    return {ok: false as const, diagnostics: parsed.diagnostics};
  }

  const archive = unzipSync(baseBytes);
  const projectEntry = archive['project.json'];
  if (!projectEntry) fail('Base SB3 must contain project.json');
  const project = JSON.parse(strFromU8(projectEntry)) as Record<string, unknown>;
  const form = opcodeFormForProject(project);
  const stage = stageOf(project);
  const blocks = isRecord(stage.blocks) ? {...stage.blocks} : {};
  for (const [blockId, block] of Object.entries(blocks)) {
    if (
      isRecord(block) &&
      typeof block.opcode === 'string' &&
      block.opcode.endsWith(dsl4BlockSourceHatOpcode)
    ) {
      fail(
        `Stage already declares a DSL source in block ${blockId}`,
        'K4-BLOCK-AUTHOR-DUPLICATE-001',
      );
    }
  }
  let declaration;
  try {
    declaration = createDsl4StructuredBlockSourceDeclaration({
      source: parse(canonicalSource) as Record<string, unknown>,
      form,
      hatId: hatBlockId,
    });
  } catch (error) {
    if (error instanceof Dsl4BlockSourceError) {
      throw new Dsl4BlockSourceAuthorError(error.message, {code: error.code, cause: error});
    }
    throw error;
  }
  for (const blockId of Object.keys(declaration)) {
    if (Object.hasOwn(blocks, blockId)) {
      fail(`Base SB3 already uses block id ${blockId}`, 'K4-BLOCK-AUTHOR-DUPLICATE-001');
    }
  }
  const sourceHat = declaration[hatBlockId];
  if (sourceHat) {
    sourceHat.x = Math.max(
      40,
      ...Object.values(blocks).flatMap((block) =>
        isRecord(block) &&
        block.topLevel === true &&
        typeof block.x === 'number' &&
        Number.isFinite(block.x)
          ? [block.x + 800]
          : [],
      ),
    );
  }

  // The reader derives the source path from the target name, so the root source of a project is
  // always the Stage's own name with the suffix. There is nothing to choose here.
  const authoredStage = {...stage, blocks: {...blocks, ...declaration}};
  const authoredProject = {
    ...project,
    extensions: [
      ...new Set([
        ...(Array.isArray(project.extensions) ? project.extensions : []),
        dsl4BlockAuthoringExtensionId,
      ]),
    ],
    extensionURLs: {
      ...(isRecord(project.extensionURLs) ? project.extensionURLs : {}),
      [dsl4BlockAuthoringExtensionId]:
        'data:text/javascript;base64,' +
        Buffer.from(createDsl4BlockAuthoringExtensionSource()).toString('base64'),
    },
    targets: (project.targets as unknown[]).map((target) =>
      target === stage ? authoredStage : target,
    ),
  };

  // Read the written project back through the production reader, so a declaration this writer
  // cannot round-trip never reaches a file.
  const readBack = extractDsl4BlockSourcesFromProject(authoredProject);
  const reparsed = sourceFrontend.parse(readBack.sources[readBack.entryPath] ?? '', {sourceId});
  if (
    !reparsed.ok ||
    serializeDsl4CanonicalDocument(reparsed) !== serializeDsl4CanonicalDocument(parsed)
  ) {
    fail(
      'The written declaration did not read back as its own source',
      'K4-BLOCK-AUTHOR-ROUNDTRIP-001',
    );
  }

  const entries = Object.fromEntries(
    [
      ...Object.entries(archive),
      ['project.json', strToU8(`${JSON.stringify(authoredProject)}\n`)] as const,
    ]
      .reduce(
        (collected, [entryName, contents]) => collected.set(entryName, contents),
        new Map<string, Uint8Array>(),
      )
      .entries(),
  );
  const ordered = Object.fromEntries(
    Object.entries(entries).sort(([left], [right]) => (left < right ? -1 : 1)),
  );
  return {
    ok: true as const,
    bytes: Buffer.from(zipSync(ordered, {level: 6, mtime: fixedZipTimestamp})),
    sourcePath: readBack.entryPath,
    opcodeForm: form,
    diagnostics: parsed.diagnostics,
  };
}
