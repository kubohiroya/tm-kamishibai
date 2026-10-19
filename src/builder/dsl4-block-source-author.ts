import {readDsl4SectionAuthoringState} from '../dsl4/block-source-section-state.js';
import type {Dsl4SectionAuthoringState} from '../dsl4/block-source-section-state.js';
import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';
import {parse} from 'yaml';

import {canonicalizeDsl4Source} from '../dsl4/source-canonicalizer.js';
import {
  dsl4BlockSourceBundleExtensionId,
  Dsl4BlockSourceError,
  dsl4BlockSourceRuntimeExtensionId,
  extractDsl4BlockSourcesFromProject,
} from '../dsl4/turbowarp-yaml-json-block-source.js';
import {
  createDsl4StructuredBlockSourceDeclaration,
  createDsl4BlockAuthoringExtensionSource,
  dsl4BlockAuthoringExtensionId,
  dsl4LabeledBlockSourceHatOpcode,
  dsl4ConfigBlockSourceHatOpcode,
} from '../dsl4/structured-block-source.js';
import {createDsl4SourceGraphFrontend} from '../dsl4/source-graph-frontend.js';
import {createDsl4BlockSourceGraph} from '../dsl4/block-source-export.js';
import {dsl4StandardProductionFeatureFlags} from '../dsl4/feature-flags.js';
import type {createDsl4SourceGraph} from '../dsl4/source-graph.js';
import {serializeDsl4CanonicalDocument} from './dsl4-validate.js';

import {fixedZipTimestamp} from './constants.js';
import {
  createDsl4BlockAuthoringEditorDefinitions,
  createDsl4CoreActionBlockEditorDefinitions,
} from './dsl4-block-authoring-editors.js';
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

interface AuthoringModule {
  sectionState?: Dsl4SectionAuthoringState | undefined;
  source: Record<string, unknown>;
  label: string;
  includeLabels: readonly string[];
}

/** Remove retired declarations from an embedded base extension's public registration. */
function removeRetiredSourceBlocks(url: unknown): unknown {
  const prefix = 'data:text/javascript;base64,';
  if (typeof url !== 'string' || !url.startsWith(prefix)) {
    fail(
      'Base runtime extension must be embedded as a JavaScript data URL',
      'K4-BLOCK-AUTHOR-EXTENSION-001',
    );
  }
  const source = Buffer.from(url.slice(prefix.length), 'base64').toString('utf8');
  // Keep metadata and bundled notices visible at the top of TurboWarp's security dialog.
  const header = source.match(/^(?:\s*\/\/[^\r\n]*\r?\n)*/u)?.[0] ?? '';
  const wrapped = `${header}(function(Scratch){
    const scoped = Object.create(Scratch);
    const extensions = Object.create(Scratch.extensions);
    Object.defineProperty(extensions, 'register', {value(extension){
      const getInfo = extension.getInfo.bind(extension);
      extension.getInfo = function(){
        const info = getInfo();
        return {...info, blocks: info.blocks.filter(block =>
          !block || typeof block.opcode !== 'string' ||
          !/^(?:kubohiroyakamishibairuntime4__)?(?:whenDsl4Source|dsl4SourceFromYamlJson)$/.test(block.opcode))};
      };
      return Scratch.extensions.register(extension);
    }});
    Object.defineProperty(scoped, 'extensions', {configurable: true, value: extensions});
    (function(Scratch){\n${source.slice(header.length)}\n})(scoped);
  })(Scratch);`;
  return prefix + Buffer.from(wrapped).toString('base64');
}

/** Install inert declarations in a copy of the base; never replace existing authoring work. */
function writeAuthoredProject(
  baseBytes: Uint8Array,
  modules: readonly AuthoringModule[],
  sourceSections = false,
) {
  const archive = unzipSync(baseBytes);
  const projectEntry = archive['project.json'];
  if (!projectEntry) fail('Base SB3 must contain project.json');
  const project = JSON.parse(strFromU8(projectEntry)) as Record<string, unknown>;
  const form = opcodeFormForProject(project);
  const stage = stageOf(project);
  for (const target of project.targets as Record<string, unknown>[]) {
    const existing = isRecord(target.blocks) ? target.blocks : {};
    for (const [blockId, block] of Object.entries(existing)) {
      if (
        isRecord(block) &&
        typeof block.opcode === 'string' &&
        block.opcode.endsWith('whenDsl4Source')
      ) {
        fail(
          'Base SB3 contains a removed source hat; use a base without a block script',
          'K4-BLOCK-SOURCE-REMOVED-001',
        );
      }
      if (
        isRecord(block) &&
        typeof block.opcode === 'string' &&
        (block.opcode === dsl4LabeledBlockSourceHatOpcode ||
          block.opcode === dsl4ConfigBlockSourceHatOpcode)
      ) {
        fail(
          `${target.name === stage.name ? 'Stage' : 'Target'} already declares a DSL source in block ${blockId}`,
          'K4-BLOCK-AUTHOR-DUPLICATE-001',
        );
      }
    }
  }
  const blocks = isRecord(stage.blocks) ? {...stage.blocks} : {};
  const startX = Math.max(
    40,
    ...Object.values(blocks).flatMap((block) =>
      isRecord(block) &&
      block.topLevel === true &&
      typeof block.x === 'number' &&
      Number.isFinite(block.x)
        ? [block.x + 900]
        : [],
    ),
  );
  for (const [index, module] of modules.entries()) {
    const hatId = index === 0 ? hatBlockId : `${hatBlockId}${index}`;
    let declaration;
    try {
      declaration = createDsl4StructuredBlockSourceDeclaration({
        ...module,
        form,
        hatId,
        idPrefix: index === 0 ? 'dsl4SourceBlock' : `dsl4Module${index}Block`,
      });
    } catch (error) {
      if (error instanceof Dsl4BlockSourceError) {
        throw new Dsl4BlockSourceAuthorError(error.message, {code: error.code, cause: error});
      }
      throw error;
    }
    for (const [blockId, block] of Object.entries(declaration)) {
      if (Object.hasOwn(blocks, blockId)) {
        fail(`Base SB3 already uses block id ${blockId}`, 'K4-BLOCK-AUTHOR-DUPLICATE-001');
      }
      blocks[blockId] = block;
    }
    for (const block of Object.values(declaration)) {
      if (block.topLevel) block.x = startX + index * 1800 + (block.x ?? 40) - 40;
    }
  }
  const authoredProject = {
    ...project,
    extensions: [
      ...new Set([
        ...(Array.isArray(project.extensions) ? project.extensions : []),
        dsl4BlockAuthoringExtensionId,
      ]),
    ],
    extensionURLs: {
      ...Object.fromEntries(
        Object.entries(isRecord(project.extensionURLs) ? project.extensionURLs : {}).map(
          ([id, url]) => [
            id,
            id === dsl4BlockSourceBundleExtensionId || id === dsl4BlockSourceRuntimeExtensionId
              ? removeRetiredSourceBlocks(url)
              : url,
          ],
        ),
      ),
      [dsl4BlockAuthoringExtensionId]: `data:text/javascript;base64,${Buffer.from(
        createDsl4BlockAuthoringExtensionSource(
          [
            ...createDsl4BlockAuthoringEditorDefinitions(dsl4BlockAuthoringExtensionId),
            ...createDsl4CoreActionBlockEditorDefinitions(form),
          ],
          {sourceSections},
        ),
      ).toString('base64')}`,
    },
    targets: (project.targets as Record<string, unknown>[]).map((target) =>
      target === stage ? {...stage, blocks} : target,
    ),
  };
  return {archive, authoredProject, form};
}

function serializeAuthoredProject(prepared: ReturnType<typeof writeAuthoredProject>) {
  const entries = {
    ...prepared.archive,
    'project.json': strToU8(`${JSON.stringify(prepared.authoredProject)}\n`),
  };
  const ordered = Object.fromEntries(
    Object.entries(entries).sort(([left], [right]) => (left < right ? -1 : 1)),
  );
  return Buffer.from(zipSync(ordered, {level: 6, mtime: fixedZipTimestamp}));
}

/** Write one validated standalone story. Graph callers use the asynchronous graph author below. */
export function authorDsl4BlockSourceSb3({
  baseBytes,
  sourceText,
  sourceFrontend,
  sourceId = 'main',
  sourceSections = false,
}: {
  baseBytes: Uint8Array;
  sourceText: string;
  sourceFrontend: import('../dsl4/source-frontend.js').Dsl4SourceFrontend;
  sourceId?: string;
  sourceSections?: boolean;
}) {
  const canonicalSource = canonicalizeDsl4Source(sourceText);
  if (/^include:/mu.test(canonicalSource)) {
    fail(
      'A story with includes requires authorDsl4BlockSourceGraphSb3 or the author-block-dsl CLI',
      'K4-BLOCK-AUTHOR-INCLUDE-001',
    );
  }
  const parsed = sourceFrontend.parse(canonicalSource, {sourceId});
  if (!parsed.ok) return {ok: false as const, diagnostics: parsed.diagnostics};
  const prepared = writeAuthoredProject(
    baseBytes,
    [
      {
        source: parse(canonicalSource) as Record<string, unknown>,
        sectionState: readDsl4SectionAuthoringState(canonicalSource),
        label: '',
        includeLabels: [],
      },
    ],
    sourceSections,
  );
  const readBack = extractDsl4BlockSourcesFromProject(prepared.authoredProject);
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
  return {
    ok: true as const,
    bytes: serializeAuthoredProject(prepared),
    sourcePath: readBack.entryPath,
    opcodeForm: prepared.form,
    diagnostics: parsed.diagnostics,
  };
}

/** Author the validated include graph without flattening module declarations or references. */
export async function authorDsl4BlockSourceGraphSb3({
  baseBytes,
  sourceGraph,
  sourceFrontend,
  sourceId = 'main',
  sourceSections = false,
}: {
  baseBytes: Uint8Array;
  sourceGraph: Awaited<ReturnType<typeof createDsl4SourceGraph>>;
  sourceFrontend: import('../dsl4/source-frontend.js').Dsl4SourceFrontend;
  sourceId?: string;
  sourceSections?: boolean;
}) {
  const graphFrontend = createDsl4SourceGraphFrontend(sourceFrontend);
  const parseOptions = {
    featureFlags: {...dsl4StandardProductionFeatureFlags, dsl4SourceIncludes: true},
    sourceId,
    maxComposedSourceBytes: sourceGraph.limits.maxTotalSourceBytes,
  };
  const parsed = graphFrontend.parse(sourceGraph, parseOptions);
  if (!parsed.ok) return {ok: false as const, diagnostics: parsed.diagnostics};
  const modules = sourceGraph.discoveryOrder.map((sourcePath): AuthoringModule => {
    const node = sourceGraph.nodes.find((candidate) => candidate?.sourcePath === sourcePath)!;
    const sectionState = readDsl4SectionAuthoringState(node.canonicalSource);
    const source = parse(node.canonicalSource) as Record<string, unknown>;
    delete source.include;
    // All authored modules live at the virtual root. Keep file references rooted at the same
    // project directory rather than changing their meaning when nested modules are exported.
    for (const asset of sourceGraph.assetFiles) {
      if (
        !isRecord(asset) ||
        asset.sourcePath !== sourcePath ||
        typeof asset.assetId !== 'string' ||
        !isRecord(source.assets)
      )
        continue;
      const value = source.assets[asset.assetId];
      if (isRecord(value)) value.file = asset.path;
    }
    return {
      source,
      sectionState,
      label: sourcePath === sourceGraph.entryPath ? '' : sourcePath,
      includeLabels: node.includes.map((edge) => edge.path),
    };
  });
  const prepared = writeAuthoredProject(baseBytes, modules, sourceSections);
  const readBack = extractDsl4BlockSourcesFromProject(prepared.authoredProject);
  const graph = await createDsl4BlockSourceGraph(readBack, sourceGraph.limits);
  const reparsed = graphFrontend.parse(graph, parseOptions);
  // Reparse the composed YAML for semantic comparison: graph origins intentionally use the
  // original paths on input and the generated module paths on output.
  if (
    !reparsed.ok ||
    serializeDsl4CanonicalDocument(sourceFrontend.parse(reparsed.canonicalSource, {sourceId})) !==
      serializeDsl4CanonicalDocument(sourceFrontend.parse(parsed.canonicalSource, {sourceId}))
  ) {
    fail(
      'The written include declarations did not read back as their composed source',
      'K4-BLOCK-AUTHOR-ROUNDTRIP-001',
    );
  }
  return {
    ok: true as const,
    bytes: serializeAuthoredProject(prepared),
    sourcePath: readBack.entryPath,
    opcodeForm: prepared.form,
    diagnostics: parsed.diagnostics,
  };
}
