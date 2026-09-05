import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';

import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';

import {
  createDsl4BlockSourceGraph,
  planDsl4BlockSourceExport,
  resolveDsl4BlockSourceExportName,
} from '../dsl4/block-source-export.js';
import {createDsl4SourceGraphFrontend} from '../dsl4/source-graph-frontend.js';
import {Dsl4SourceGraphError} from '../dsl4/source-graph.js';
import {deepFreeze} from '../dsl4/story-document.js';
import {
  Dsl4BlockSourceError,
  extractDsl4BlockSourcesFromProject,
} from '../dsl4/turbowarp-yaml-json-block-source.js';
import {installBundleTransactionally} from './atomic-output.js';
import {fixedZipTimestamp} from './constants.js';
import {formatDsl4Diagnostic} from './dsl4-validate.js';
import {Sb3BuilderError} from './errors.js';
import {readSb3} from './sb3.js';

export const dsl4BlockSourceExportDefaults = Object.freeze({
  maxInputBytes: 512 * 1024 * 1024,
});

export class Dsl4BlockSourceExportError extends Sb3BuilderError {
  /**
   * @param {string} message
   * @param {{stage: string, code: string, diagnostics?: readonly unknown[], cause?: unknown}} details
   */
  constructor(message, details) {
    super(message, details);
    this.name = 'Dsl4BlockSourceExportError';
    this.diagnostics = deepFreeze(structuredClone(details.diagnostics ?? []));
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name */
function requiredPath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Sb3BuilderError(`${name} must be a non-empty filesystem path`, {
      stage: 'dsl4-block-export',
      code: 'K4-BLOCK-EXPORT-OUTPUT-001',
    });
  }
  return path.resolve(value);
}

/** @param {unknown} value @param {string} name @param {number} fallback */
function positiveSafeInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

/**
 * Derive the work name from the input filename when the caller does not name the export.
 *
 * @param {string} inputPath
 */
export function defaultDsl4BlockSourceExportName(inputPath) {
  return path.basename(inputPath, path.extname(inputPath));
}

/** @param {string} inputPath @param {number} maxInputBytes */
async function readInputSb3(inputPath, maxInputBytes) {
  let inputState;
  try {
    inputState = await stat(inputPath);
  } catch (error) {
    throw new Dsl4BlockSourceExportError('Cannot read the input SB3', {
      stage: 'dsl4-block-export-input',
      code: 'K4-BLOCK-EXPORT-INPUT-001',
      cause: error,
    });
  }
  if (!inputState.isFile()) {
    throw new Dsl4BlockSourceExportError('The input SB3 is not a regular file', {
      stage: 'dsl4-block-export-input',
      code: 'K4-BLOCK-EXPORT-INPUT-001',
    });
  }
  if (inputState.size > maxInputBytes) {
    throw new Dsl4BlockSourceExportError(`The input SB3 exceeds ${maxInputBytes} bytes`, {
      stage: 'dsl4-block-export-input',
      code: 'K4-BLOCK-EXPORT-INPUT-002',
    });
  }
  let bytes;
  try {
    bytes = Buffer.from(await readFile(inputPath));
  } catch (error) {
    throw new Dsl4BlockSourceExportError('Cannot read the input SB3', {
      stage: 'dsl4-block-export-input',
      code: 'K4-BLOCK-EXPORT-INPUT-001',
      cause: error,
    });
  }
  if (bytes.byteLength > maxInputBytes) {
    throw new Dsl4BlockSourceExportError(`The input SB3 exceeds ${maxInputBytes} bytes`, {
      stage: 'dsl4-block-export-input',
      code: 'K4-BLOCK-EXPORT-INPUT-002',
    });
  }
  return bytes;
}

/** @param {unknown} error @param {string} stage @returns {never} */
function failDomain(error, stage) {
  if (error instanceof Dsl4BlockSourceError || error instanceof Dsl4SourceGraphError) {
    throw new Dsl4BlockSourceExportError(error.message, {
      stage,
      code: error.code,
      cause: error,
    });
  }
  throw error;
}

/**
 * Serialize one deterministic ZIP package for a multi-source export plan.
 *
 * @param {Readonly<{files: readonly Readonly<{path: string, text: string}>[]}>} plan
 */
export function serializeDsl4BlockSourcePackage(plan) {
  const entries = Object.fromEntries(
    [...plan.files]
      .sort((left, right) => (left.path < right.path ? -1 : 1))
      .map((file) => [file.path, strToU8(file.text)]),
  );
  return Buffer.from(zipSync(entries, {level: 6, mtime: fixedZipTimestamp}));
}

/**
 * Read one exported package back so the committed artifact is verified before it is installed.
 *
 * @param {Buffer} bytes
 */
function readDsl4BlockSourcePackage(bytes) {
  const archive = unzipSync(new Uint8Array(bytes));
  return Object.fromEntries(
    Object.entries(archive).map(([entryName, contents]) => [entryName, strFromU8(contents)]),
  );
}

/**
 * Export the block DSL script embedded in one SB3 as DSL 4.0 YAML.
 *
 * The block source travels Block frontend, Source Graph, graph frontend validation, and only then
 * the YAML serializer, so a block-authored story is held to exactly the same schema, semantic, and
 * include rules as a YAML-authored one. An invalid source fails instead of writing plausible YAML,
 * and so does a Sprite whose declared DSL source no include reaches.
 *
 * @param {object} options
 * @param {string} options.input SB3 file carrying the DSL declaration hats
 * @param {string} options.outputDir Directory that receives the YAML file or the ZIP package
 * @param {string} [options.name] Work name used for the root YAML and the package stem
 * @param {{parse(source: string, options?: {sourceId?: string}): Readonly<Record<string, any>>}} options.sourceFrontend
 * @param {number} options.maxSourceBytes
 * @param {number} [options.maxTotalSourceBytes]
 * @param {number} [options.maxSourceFiles]
 * @param {number} [options.maxIncludeDepth]
 * @param {number} [options.maxInputBytes]
 */
export async function exportDsl4BlockSourcesToYaml(options) {
  if (!isRecord(options)) throw new TypeError('DSL 4.0 block export options are required');
  const input = requiredPath(options.input, 'input');
  const outputDirectory = requiredPath(options.outputDir, 'outputDir');
  if (!options.sourceFrontend || typeof options.sourceFrontend.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse');
  }
  const maxSourceBytes = positiveSafeInteger(options.maxSourceBytes, 'maxSourceBytes', 0);
  if (maxSourceBytes < 1) throw new TypeError('maxSourceBytes must be a positive safe integer');
  const maxTotalSourceBytes = positiveSafeInteger(
    options.maxTotalSourceBytes,
    'maxTotalSourceBytes',
    maxSourceBytes,
  );
  if (maxTotalSourceBytes < maxSourceBytes) {
    throw new TypeError('maxTotalSourceBytes must be greater than or equal to maxSourceBytes');
  }
  const maxInputBytes = positiveSafeInteger(
    options.maxInputBytes,
    'maxInputBytes',
    dsl4BlockSourceExportDefaults.maxInputBytes,
  );
  const name = resolveDsl4BlockSourceExportName(
    options.name ?? defaultDsl4BlockSourceExportName(input),
  );

  const bytes = await readInputSb3(input, maxInputBytes);
  let project;
  try {
    ({project} = readSb3(bytes));
  } catch (error) {
    throw new Dsl4BlockSourceExportError(
      error instanceof Error ? error.message : 'The input SB3 could not be opened',
      {stage: 'dsl4-block-export-input', code: 'K4-BLOCK-EXPORT-INPUT-003', cause: error},
    );
  }

  let blockSourceSet;
  try {
    blockSourceSet = extractDsl4BlockSourcesFromProject(project);
  } catch (error) {
    failDomain(error, 'dsl4-block-export-frontend');
  }

  const graphLimits = {
    maxSourceBytes,
    maxTotalSourceBytes,
    ...(options.maxSourceFiles === undefined ? {} : {maxSourceFiles: options.maxSourceFiles}),
    ...(options.maxIncludeDepth === undefined ? {} : {maxIncludeDepth: options.maxIncludeDepth}),
  };
  let sourceGraph;
  try {
    sourceGraph = await createDsl4BlockSourceGraph(blockSourceSet, graphLimits);
  } catch (error) {
    failDomain(error, 'dsl4-block-export-graph');
  }

  const parsed = /** @type {Readonly<Record<string, any>>} */ (
    createDsl4SourceGraphFrontend(options.sourceFrontend).parse(sourceGraph, {
      featureFlags: {dsl4Runtime: true, dsl4SourceIncludes: true},
      sourceId: sourceGraph.entryPath,
      maxComposedSourceBytes: maxTotalSourceBytes,
    })
  );
  if (!parsed.ok) {
    const first = parsed.diagnostics[0];
    throw new Dsl4BlockSourceExportError(first?.message ?? 'Block DSL source validation failed', {
      stage: 'dsl4-block-export-validate',
      code: first?.code ?? 'K4-BLOCK-EXPORT-VALIDATION-001',
      diagnostics: parsed.diagnostics,
    });
  }

  let plan;
  try {
    plan = planDsl4BlockSourceExport({blockSourceSet, sourceGraph, name});
  } catch (error) {
    failDomain(error, 'dsl4-block-export-plan');
  }

  const contents =
    plan.kind === 'package'
      ? serializeDsl4BlockSourcePackage(plan)
      : Buffer.from(strToU8(plan.files[0].text));
  const outputPaths = await installBundleTransactionally({
    outputDirectory,
    outputName: plan.name,
    files: new Map([[plan.outputFilename, contents]]),
    validateCandidate: async (candidateDirectory) => {
      const candidate = Buffer.from(
        await readFile(path.join(candidateDirectory, plan.outputFilename)),
      );
      if (!candidate.equals(contents)) {
        throw new Dsl4BlockSourceExportError('Candidate export bytes changed before validation', {
          stage: 'dsl4-block-export-verify',
          code: 'K4-BLOCK-EXPORT-CANDIDATE-MISMATCH',
        });
      }
      const written =
        plan.kind === 'package'
          ? readDsl4BlockSourcePackage(candidate)
          : {[plan.outputFilename]: candidate.toString('utf8')};
      const expected = Object.fromEntries(
        plan.files.map((file) => [
          plan.kind === 'package' ? file.path : plan.outputFilename,
          file.text,
        ]),
      );
      const writtenNames = Object.keys(written).sort();
      const expectedNames = Object.keys(expected).sort();
      if (
        writtenNames.length !== expectedNames.length ||
        writtenNames.some((entryName, index) => entryName !== expectedNames[index]) ||
        expectedNames.some((entryName) => written[entryName] !== expected[entryName])
      ) {
        throw new Dsl4BlockSourceExportError('Candidate export does not match the export plan', {
          stage: 'dsl4-block-export-verify',
          code: 'K4-BLOCK-EXPORT-CANDIDATE-MISMATCH',
        });
      }
    },
  });

  return deepFreeze({
    formatVersion: plan.formatVersion,
    kind: plan.kind,
    name: plan.name,
    entryPath: plan.entryPath,
    entryFilename: plan.entryFilename,
    outputPath: outputPaths[plan.outputFilename],
    files: plan.files.map((file) => ({
      sourcePath: file.sourcePath,
      path: file.path,
      byteLength: file.byteLength,
    })),
    moduleFilenames: plan.moduleFilenames,
  });
}

/**
 * Report an export failure against the block source it came from.
 *
 * Every graph diagnostic already carries the virtual Sprite/Stage source path, so the report points
 * back at the TurboWarp target that declared the offending DSL hat.
 *
 * @param {Dsl4BlockSourceExportError} error
 * @param {string} displaySource
 */
export function formatDsl4BlockSourceExportFailure(error, displaySource) {
  const diagnostics = Array.isArray(error.diagnostics) ? error.diagnostics : [];
  if (diagnostics.length === 0) return `${displaySource}: ${error.code} ${error.message}\n`;
  return diagnostics
    .map((diagnostic) => {
      const projected = /** @type {Record<string, any>} */ (diagnostic);
      const source =
        typeof projected.sourceId === 'string' && projected.sourceId.length > 0
          ? `${displaySource}!${projected.sourceId}`
          : displaySource;
      return `${formatDsl4Diagnostic(projected, source)}\n`;
    })
    .join('');
}
