import {parseDocument, stringify} from 'yaml';

import {dsl4RecommendedSourceFilenameSuffix} from './source-filename.js';
import {createDsl4SourceGraph, Dsl4SourceGraphError} from './source-graph.js';
import {deepFreeze} from './story-document.js';
import {Dsl4BlockSourceError} from './turbowarp-yaml-json-block-source.js';

const textEncoder = new TextEncoder();

export const dsl4BlockSourceExportFormatVersion = 1;
export const dsl4BlockSourceExportPackageSuffix = '-k4';
export const dsl4BlockSourceExportMaximumNameLength = 96;

// Windows refuses these stems with any extension, so a portable export never emits them.
const reservedFilenameStems = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({length: 9}, (_value, index) => `com${index + 1}`),
  ...Array.from({length: 9}, (_value, index) => `lpt${index + 1}`),
]);
const unsafeFilenameCharacters = /[\u0000-\u001F\u007F/\\:*?"<>|]/u;

/** One extracted block DSL source set: the entry module plus every module it can include. */
interface Dsl4BlockSourceSet {
  readonly entryPath: string;
  readonly sources: Readonly<Record<string, string>>;
}

/**
 * The part of a validated Source Graph the export plan reads. Node members stay `unknown` because
 * the plan re-validates each one where it uses it: `sourcePath` through `String`, and
 * `canonicalSource` through `serializeDsl4SourceYaml`.
 */
export interface Dsl4BlockSourceExportGraph {
  readonly entryPath: string;
  readonly nodes: readonly {readonly sourcePath: unknown; readonly canonicalSource: unknown}[];
}

function fail(code: string, message: string, details: {sourcePath?: string} = {}): never {
  throw new Dsl4BlockSourceError(code, message, {
    ...(details.sourcePath === undefined ? {} : {targetName: details.sourcePath}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reject any filename that cannot travel safely through a ZIP package or a checkout. */
function assertPortableFilename(value: string, label: string, details: {sourcePath?: string} = {}) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('K4-BLOCK-EXPORT-NAME-001', `${label} must be a non-empty filename`, details);
  }
  if (value.length > dsl4BlockSourceExportMaximumNameLength) {
    fail(
      'K4-BLOCK-EXPORT-NAME-001',
      `${label} exceeds ${dsl4BlockSourceExportMaximumNameLength} characters`,
      details,
    );
  }
  if (unsafeFilenameCharacters.test(value)) {
    fail('K4-BLOCK-EXPORT-NAME-001', `${label} contains an unsafe filename character`, details);
  }
  if (
    value.startsWith('.') ||
    value.startsWith(' ') ||
    value.endsWith('.') ||
    value.endsWith(' ')
  ) {
    fail(
      'K4-BLOCK-EXPORT-NAME-001',
      `${label} must not start or end with a dot or a space`,
      details,
    );
  }
  if (reservedFilenameStems.has((value.split('.')[0] ?? '').toLowerCase())) {
    fail('K4-BLOCK-EXPORT-NAME-001', `${label} uses a reserved filename`, details);
  }
}

/** Resolve the export root name and reject anything that cannot become a portable filename stem. */
export function resolveDsl4BlockSourceExportName(name: unknown) {
  if (typeof name !== 'string' || name.length === 0) {
    fail('K4-BLOCK-EXPORT-NAME-001', 'Export name must be a non-empty string');
  }
  const value = name;
  if (value.includes('.')) {
    fail('K4-BLOCK-EXPORT-NAME-001', 'Export name must not contain a dot');
  }
  assertPortableFilename(value, 'Export name');
  return value;
}

/**
 * Build the virtual Source Graph for one extracted block DSL source set.
 *
 * Include resolution, missing include targets, include cycles, and cross-source declaration
 * duplicates are all diagnosed here, exactly as they are for a YAML project on disk.
 */
export function createDsl4BlockSourceGraph(
  blockSourceSet: Dsl4BlockSourceSet,
  limits?: Partial<typeof import('./source-graph.js').dsl4SourceGraphDefaultLimits>,
) {
  if (
    !isRecord(blockSourceSet) ||
    typeof blockSourceSet.entryPath !== 'string' ||
    !isRecord(blockSourceSet.sources)
  ) {
    throw new TypeError('blockSourceSet must provide entryPath and sources');
  }
  const sources = blockSourceSet.sources;
  return createDsl4SourceGraph(blockSourceSet.entryPath, {
    ...(limits === undefined ? {} : {limits}),
    readSource(sourcePath) {
      const source = sources[sourcePath];
      if (typeof source !== 'string') {
        throw new Dsl4SourceGraphError(
          'K4-SOURCE-MISSING',
          'Included block DSL source is missing',
          {
            sourceId: sourcePath,
            sourcePath,
          },
        );
      }
      return source;
    },
  });
}

/**
 * Re-emit one already validated DSL 4.0 source as canonical YAML.
 *
 * Serializing the parsed value rather than the incoming text keeps the output independent from
 * however the block renderer happened to quote its scalars, so the same block tree always writes
 * byte-identical YAML.
 */
export function serializeDsl4SourceYaml(
  canonicalSource: unknown,
  {sourcePath}: {sourcePath?: string} = {},
) {
  if (typeof canonicalSource !== 'string') {
    throw new TypeError('canonicalSource must be a string');
  }
  const document = parseDocument(canonicalSource, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    version: '1.2',
  });
  if (document.errors.length > 0) {
    fail('K4-BLOCK-EXPORT-YAML-001', 'Block DSL source is not valid YAML', {
      ...(sourcePath === undefined ? {} : {sourcePath}),
    });
  }
  return stringify(document.toJS({maxAliasCount: 0}), {lineWidth: 0});
}

/**
 * Plan the deterministic YAML file set for one validated block DSL Source Graph.
 *
 * The root source is renamed to the requested work name; every reachable module keeps the filename
 * its Sprite already contributes to the include graph, so include references stay resolvable.
 *
 * Every declared module must be reachable. A Sprite that declares a DSL source no include names is
 * authored content the export would silently drop, so it fails instead.
 */
export function planDsl4BlockSourceExport({
  blockSourceSet,
  sourceGraph,
  name,
}: {
  blockSourceSet: Dsl4BlockSourceSet;
  sourceGraph: Dsl4BlockSourceExportGraph;
  name: unknown;
}) {
  if (
    !isRecord(blockSourceSet) ||
    typeof blockSourceSet.entryPath !== 'string' ||
    !isRecord(blockSourceSet.sources)
  ) {
    throw new TypeError('blockSourceSet must provide entryPath and sources');
  }
  if (
    !isRecord(sourceGraph) ||
    !Array.isArray(sourceGraph.nodes) ||
    typeof sourceGraph.entryPath !== 'string'
  ) {
    throw new TypeError('sourceGraph must be a validated DSL 4.0 Source Graph');
  }
  const rootName = resolveDsl4BlockSourceExportName(name);
  const entryFilename = `${rootName}${dsl4RecommendedSourceFilenameSuffix}`;
  const packageName = `${rootName}${dsl4BlockSourceExportPackageSuffix}`;
  const entryPath = sourceGraph.entryPath;

  const reachable = new Set(sourceGraph.nodes.map((node) => String(node.sourcePath)));
  const unreferenced = Object.keys(blockSourceSet.sources)
    .filter((sourcePath) => !reachable.has(sourcePath))
    .sort();
  if (unreferenced.length > 0) {
    fail(
      'K4-BLOCK-EXPORT-UNREFERENCED-001',
      `No include reaches ${unreferenced.map((sourcePath) => JSON.stringify(sourcePath)).join(', ')}. Add an include for each module, or remove its DSL source hat.`,
      unreferenced[0] === undefined ? {} : {sourcePath: unreferenced[0]},
    );
  }

  const files: {sourcePath: string; filename: string; text: string; byteLength: number}[] = [];
  const moduleFilenames: string[] = [];
  for (const node of sourceGraph.nodes) {
    const sourcePath = String(node.sourcePath);
    const isEntry = sourcePath === entryPath;
    const filename = isEntry ? entryFilename : sourcePath;
    assertPortableFilename(filename, `Export filename ${JSON.stringify(sourcePath)}`, {sourcePath});
    if (!isEntry) moduleFilenames.push(filename);
    const text = serializeDsl4SourceYaml(node.canonicalSource, {sourcePath});
    files.push({sourcePath, filename, text, byteLength: textEncoder.encode(text).byteLength});
  }

  const claimed = new Map<string, string>();
  for (const file of files) {
    const previous = claimed.get(file.filename);
    if (previous !== undefined) {
      fail(
        'K4-BLOCK-EXPORT-COLLISION-001',
        `Export filename ${JSON.stringify(file.filename)} is claimed by both ${JSON.stringify(previous)} and ${JSON.stringify(file.sourcePath)}`,
        {sourcePath: file.sourcePath},
      );
    }
    claimed.set(file.filename, file.sourcePath);
  }

  const packaged = moduleFilenames.length > 0;
  return deepFreeze({
    formatVersion: dsl4BlockSourceExportFormatVersion,
    name: rootName,
    kind: packaged ? 'package' : 'single',
    entryPath,
    entryFilename,
    packageName,
    outputFilename: packaged ? `${packageName}.zip` : entryFilename,
    files: [...files]
      .sort((left, right) => (left.filename < right.filename ? -1 : 1))
      .map((file) => ({
        sourcePath: file.sourcePath,
        filename: file.filename,
        path: packaged ? `${packageName}/${file.filename}` : file.filename,
        text: file.text,
        byteLength: file.byteLength,
      })),
    moduleFilenames: [...moduleFilenames].sort(),
  });
}
