import {randomBytes} from 'node:crypto';
import {readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {loadDsl4RuntimeComponent} from '../dsl4/runtime-artifact-loader.js';
import {installBundleTransactionally} from './atomic-output.js';
import {buildDsl4RuntimeComponent, Dsl4BuildError} from './dsl4-build.js';
import {ensureDsl4ExternalSourceCacheIdentity} from './dsl4-external-source.js';
import {Sb3BuilderError} from './errors.js';
import {readSb3} from './sb3.js';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name */
function requiredPath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Sb3BuilderError(`${name} must be a non-empty filesystem path`, {
      stage: 'dsl4-build-output',
      code: 'K4-BUILD-OUTPUT-001',
    });
  }
  return path.resolve(value);
}

/** @param {string} filePath @param {string} description */
async function readInput(filePath, description) {
  try {
    return Buffer.from(await readFile(filePath));
  } catch (error) {
    throw new Sb3BuilderError(`Cannot read ${description}`, {
      stage: 'dsl4-build-input',
      code: 'K4-BUILD-INPUT-001',
      cause: error,
    });
  }
}

/** @param {Buffer} bytes */
function parseSourceManifest(bytes) {
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch (error) {
    throw new Sb3BuilderError('Source manifest must be valid UTF-8 JSON', {
      stage: 'dsl4-build-input',
      code: 'K4-SOURCE-MANIFEST-JSON-001',
      cause: error,
    });
  }
  if (!isRecord(value)) {
    throw new Sb3BuilderError('Source manifest JSON must contain one object', {
      stage: 'dsl4-build-input',
      code: 'K4-SOURCE-MANIFEST-JSON-001',
    });
  }
  return value;
}

/** @param {string} manifestPath @param {Readonly<Record<string, unknown>>} manifest */
async function persistSourceManifest(manifestPath, manifest) {
  const temporaryPath = `${manifestPath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {flag: 'wx'});
    await rename(temporaryPath, manifestPath);
  } catch (error) {
    await rm(temporaryPath, {force: true}).catch(() => {});
    throw new Sb3BuilderError('Cannot persist the stable story cache identity', {
      stage: 'dsl4-build-input',
      code: 'K4-SOURCE-MANIFEST-WRITE-001',
      cause: error,
    });
  }
}

/**
 * Build and atomically install one self-contained DSL 4.0 SB3.
 *
 * @param {object} options
 * @param {string} options.baseSb3
 * @param {string} options.projectRoot
 * @param {string} options.sourceManifest
 * @param {string} options.output
 * @param {{parse(source: string, options?: {sourceId?: string}): Readonly<Record<string, any>>}} options.sourceFrontend
 * @param {string} options.controlProfile
 * @param {'bundled' | 'unbundled'} options.channel
 * @param {number} options.maxSourceBytes
 * @param {number} options.maxAssetFileBytes
 * @param {number} options.maxAssetFiles
 * @param {number} options.maxTotalAssetBytes
 * @param {boolean} [options.historyNavigationAvailable]
 * @param {boolean} [options.replaceExisting]
 * @param {{digest: Function}} [options.subtleCrypto]
 * @param {() => string} [options.createStoryId]
 */
export async function buildDsl4RuntimeComponentFile(options) {
  if (!isRecord(options)) {
    throw new TypeError('DSL 4.0 file build options are required');
  }
  const baseSb3 = requiredPath(options.baseSb3, 'baseSb3');
  const projectRoot = requiredPath(options.projectRoot, 'projectRoot');
  const sourceManifestPath = requiredPath(options.sourceManifest, 'sourceManifest');
  const output = requiredPath(options.output, 'output');
  const outputFilename = path.basename(output);
  const outputName = path.basename(outputFilename, '.sb3');
  if (
    path.extname(outputFilename) !== '.sb3' ||
    outputName.length === 0 ||
    outputFilename !== `${outputName}.sb3`
  ) {
    throw new Sb3BuilderError('output must name one .sb3 file', {
      stage: 'dsl4-build-output',
      code: 'K4-BUILD-OUTPUT-001',
    });
  }
  if (!options.sourceFrontend || typeof options.sourceFrontend.parse !== 'function') {
    throw new TypeError('sourceFrontend must provide parse');
  }

  const [baseSb3Bytes, sourceManifestBytes] = await Promise.all([
    readInput(baseSb3, 'base SB3'),
    readInput(sourceManifestPath, 'source manifest'),
  ]);
  const identity = ensureDsl4ExternalSourceCacheIdentity(parseSourceManifest(sourceManifestBytes), {
    ...(options.createStoryId === undefined ? {} : {createStableId: options.createStoryId}),
  });
  const sourceManifest = identity.manifest;
  const buildOptions = {
    baseSb3Bytes,
    projectRoot,
    sourceManifest,
    sourceFrontend: options.sourceFrontend,
    controlProfile: options.controlProfile,
    channel: options.channel,
    maxSourceBytes: options.maxSourceBytes,
    maxAssetFileBytes: options.maxAssetFileBytes,
    maxAssetFiles: options.maxAssetFiles,
    maxTotalAssetBytes: options.maxTotalAssetBytes,
    historyNavigationAvailable: options.historyNavigationAvailable ?? false,
    replaceExisting: options.replaceExisting ?? false,
    ...(options.subtleCrypto === undefined ? {} : {subtleCrypto: options.subtleCrypto}),
  };
  const built = await buildDsl4RuntimeComponent(buildOptions);
  if (identity.created) await persistSourceManifest(sourceManifestPath, sourceManifest);
  const outputPaths = await installBundleTransactionally({
    outputDirectory: path.dirname(output),
    outputName,
    files: new Map([[outputFilename, built.bytes]]),
    validateCandidate: async (candidateDirectory) => {
      const candidateBytes = await readFile(path.join(candidateDirectory, outputFilename));
      if (!candidateBytes.equals(built.bytes)) {
        throw new Sb3BuilderError('Candidate SB3 bytes changed before validation', {
          stage: 'dsl4-output-verify',
          code: 'K4-BUILD-CANDIDATE-MISMATCH',
        });
      }
      const {project} = readSb3(candidateBytes);
      const loaded = await loadDsl4RuntimeComponent(project, options.sourceFrontend, {
        maxSourceBytes: options.maxSourceBytes,
        maxAssetFiles: options.maxAssetFiles,
        maxAssetBytes: options.maxTotalAssetBytes,
        historyNavigationAvailable: options.historyNavigationAvailable ?? false,
        ...(options.subtleCrypto === undefined ? {} : {subtleCrypto: options.subtleCrypto}),
      });
      if (!loaded.ok) {
        const first = loaded.diagnostics[0];
        throw new Dsl4BuildError(first?.message ?? 'Candidate DSL 4.0 SB3 validation failed', {
          stage: 'dsl4-output-verify',
          code: first?.code ?? 'K4-BUILD-VALIDATION-001',
          diagnostics: loaded.diagnostics,
        });
      }
    },
  });
  return Object.freeze({
    outputPath: outputPaths[outputFilename],
    runtimeComponent: built.runtimeComponent,
  });
}
