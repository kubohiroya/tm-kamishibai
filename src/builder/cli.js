import {readFile} from 'node:fs/promises';
import path from 'node:path';

import {
  convertDsl32File,
  Dsl32ConversionError,
  formatConversionDiagnostic,
} from '../converter/index.js';
import {packageVersion} from './constants.js';
import {runDsl4LocalPreviewCommand} from './dsl4-local-preview-command.js';
import {dsl4LocalPreviewBrowserBootstrapDefaults} from './dsl4-local-preview-browser-bootstrap.js';
import {createDsl4ProductionSourceFrontend} from './dsl4-source-frontend.js';
import {
  formatDsl4Diagnostic,
  serializeDsl4ValidationResult,
  validateDsl4SourceFile,
} from './dsl4-validate.js';
import {Sb3BuilderError} from './errors.js';
import {buildDsl4RuntimeComponentFile, buildSb3Bundle} from './index.js';

const dsl4SchemaUrl = new URL('../../schema/dsl-4.schema.json', import.meta.url);

export function usage() {
  return `Usage:
  tmpose-kamishibai build-sb3 --base BASE.sb3 --script SOURCE.txt \\
    --assets assets.lock.json --output dist/sample --profile editor [options]

  tmpose-kamishibai build-dsl4 --base BASE.sb3 --project-root DIR \\
    --source-manifest project.source.json --output dist/story.sb3 \\
    --control-profile production --channel bundled \\
    --max-source-bytes N --max-asset-file-bytes N \\
    --max-asset-files N --max-total-asset-bytes N [options]

  tmpose-kamishibai convert-dsl4 --input SOURCE.txt \\
    --output STORY.kamishibai.yaml [--pose-models REPLACEMENTS.json]

  tmpose-kamishibai validate-dsl4 --input STORY.kamishibai.yaml \\
    --max-source-bytes N [--format pretty|json]

  tmpose-kamishibai preview-dsl4 --watch --base BASE.sb3 --project-root DIR \\
    --source-manifest project.source.json --control-profile production \\
    --channel bundled --max-source-bytes N --max-asset-file-bytes N \\
    --max-asset-files N --max-total-asset-bytes N [options]

DSL 3.1/3.2 build-sb3 options:
  --allow-file-root DIR   Allow file: assets below DIR (repeatable)
  --allow-http            Permit plain HTTP assets (HTTPS is the default)
  --timeout-ms N          Per-request timeout in milliseconds
  --max-asset-bytes N     Maximum bytes per asset
  --max-script-bytes N    Maximum embedded script bytes
  --max-redirects N       Maximum HTTP redirects

DSL 4.0 build-dsl4 options:
  --history-navigation-available  Permit a selected history.* keymap
  --replace-existing              Replace a same-channel component in the base SB3

DSL 4.0 preview-dsl4 options:
  --watch                         Keep watching the selected source (required)
  --port N                        Loopback port; 0 lets the OS select one (default)
  --replace-existing              Replace a same-channel component in the base SB3

convert-dsl4 options:
  --pose-models FILE      Map exact TMPoseURL values to local poseModel assets

validate-dsl4 options:
  --format FORMAT         Diagnostic output: pretty (default) or json

General options:
  --help                  Show this help
  --version               Show the package version

build-sb3 takes an output basename and writes .sb3, .txt, and .manifest.json.
build-dsl4 writes one self-contained SB3 after revalidating the disk candidate.
preview-dsl4 builds a development-only browser runtime in memory, opens the system
browser, and reports success only after the authenticated runtime-ready acknowledgement.
validate-dsl4 uses the production canonicalizer, schema, semantics, and diagnostics.
convert-dsl4 never modifies its DSL 3.2 input and atomically replaces only the
explicitly selected YAML output.`;
}

/**
 * @param {string[]} arguments_
 * @returns {{input: string, format: 'pretty' | 'json', maxSourceBytes: number}}
 */
function parseValidateDsl4Arguments(arguments_) {
  const values = new Map();
  const allowed = new Set(['--input', '--format', '--max-source-bytes']);
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (!allowed.has(option)) {
      throw new Sb3BuilderError(`Unknown option: ${option}`, {stage: 'cli'});
    }
    if (!value || value.startsWith('--')) {
      throw new Sb3BuilderError(`${option} requires a value.`, {stage: 'cli'});
    }
    if (values.has(option)) {
      throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
    }
    values.set(option, value);
  }
  for (const required of ['--input', '--max-source-bytes']) {
    if (!values.has(required)) {
      throw new Sb3BuilderError(`Missing required option: ${required}`, {stage: 'cli'});
    }
  }
  const maxSourceBytes = Number(values.get('--max-source-bytes'));
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1) {
    throw new Sb3BuilderError('--max-source-bytes must be an integer >= 1.', {stage: 'cli'});
  }
  const format = values.get('--format') ?? 'pretty';
  if (format !== 'pretty' && format !== 'json') {
    throw new Sb3BuilderError('--format must be either pretty or json.', {stage: 'cli'});
  }
  return {
    input: path.resolve(/** @type {string} */ (values.get('--input'))),
    format,
    maxSourceBytes,
  };
}

/**
 * @param {string[]} arguments_
 * @returns {Parameters<typeof convertDsl32File>[0]}
 */
function parseConvertDsl4Arguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (!['--input', '--output', '--pose-models'].includes(option)) {
      throw new Sb3BuilderError(`Unknown option: ${option}`, {stage: 'cli'});
    }
    if (!value || value.startsWith('--')) {
      throw new Sb3BuilderError(`${option} requires a value.`, {stage: 'cli'});
    }
    if (values.has(option)) {
      throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
    }
    values.set(option, value);
  }
  for (const required of ['--input', '--output']) {
    if (!values.has(required)) {
      throw new Sb3BuilderError(`Missing required option: ${required}`, {stage: 'cli'});
    }
  }
  return {
    inputPath: path.resolve(/** @type {string} */ (values.get('--input'))),
    outputPath: path.resolve(/** @type {string} */ (values.get('--output'))),
    ...(values.has('--pose-models')
      ? {poseModelMapPath: path.resolve(/** @type {string} */ (values.get('--pose-models')))}
      : {}),
  };
}

/**
 * @param {string[]} rest
 * @returns {Parameters<typeof buildSb3Bundle>[0]}
 */
function parseBuildSb3Arguments(rest) {
  const values = new Map();
  const allowedFileRoots = [];
  let allowHttp = false;
  const numericOptions = new Set([
    '--timeout-ms',
    '--max-asset-bytes',
    '--max-script-bytes',
    '--max-redirects',
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === '--allow-http') {
      allowHttp = true;
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Sb3BuilderError(`${option} requires a value.`, {stage: 'cli'});
    }
    if (option === '--allow-file-root') {
      allowedFileRoots.push(path.resolve(value));
    } else if (
      ['--base', '--script', '--assets', '--output', '--profile'].includes(option) ||
      numericOptions.has(option)
    ) {
      if (values.has(option)) {
        throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
      }
      values.set(option, value);
    } else {
      throw new Sb3BuilderError(`Unknown option: ${option}`, {stage: 'cli'});
    }
    index += 1;
  }
  for (const required of ['--base', '--script', '--assets', '--output', '--profile']) {
    if (!values.has(required)) {
      throw new Sb3BuilderError(`Missing required option: ${required}`, {stage: 'cli'});
    }
  }
  /** @param {string} option */
  const numberValue = (option) => {
    const raw = values.get(option);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    const minimum = option === '--max-redirects' ? 0 : 1;
    if (!Number.isInteger(value) || value < minimum) {
      throw new Sb3BuilderError(`${option} must be an integer >= ${minimum}.`, {stage: 'cli'});
    }
    return value;
  };
  const outputBase = path.resolve(/** @type {string} */ (values.get('--output')));
  const profile = values.get('--profile');
  if (profile !== 'editor' && profile !== 'player') {
    throw new Sb3BuilderError('--profile must be either editor or player.', {stage: 'cli'});
  }
  return {
    baseSb3: path.resolve(/** @type {string} */ (values.get('--base'))),
    sourceScript: path.resolve(/** @type {string} */ (values.get('--script'))),
    assetManifest: path.resolve(/** @type {string} */ (values.get('--assets'))),
    outputDirectory: path.dirname(outputBase),
    outputName: path.basename(outputBase),
    profile,
    allowedFileRoots: allowedFileRoots.length > 0 ? allowedFileRoots : undefined,
    allowHttp,
    requestTimeoutMs: numberValue('--timeout-ms'),
    maxAssetBytes: numberValue('--max-asset-bytes'),
    maxEmbeddedScriptBytes: numberValue('--max-script-bytes'),
    maxRedirects: numberValue('--max-redirects'),
  };
}

/**
 * @typedef {Omit<Parameters<typeof buildDsl4RuntimeComponentFile>[0], 'sourceFrontend'>} Dsl4CliOptions
 */

/**
 * @param {string[]} rest
 * @returns {Dsl4CliOptions}
 */
function parseBuildDsl4Arguments(rest) {
  const values = new Map();
  const flags = new Set();
  const booleanOptions = new Set(['--history-navigation-available', '--replace-existing']);
  const valueOptions = new Set([
    '--base',
    '--project-root',
    '--source-manifest',
    '--output',
    '--control-profile',
    '--channel',
    '--max-source-bytes',
    '--max-asset-file-bytes',
    '--max-asset-files',
    '--max-total-asset-bytes',
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (booleanOptions.has(option)) {
      if (flags.has(option)) {
        throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
      }
      flags.add(option);
      continue;
    }
    if (!valueOptions.has(option)) {
      throw new Sb3BuilderError(`Unknown option: ${option}`, {stage: 'cli'});
    }
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Sb3BuilderError(`${option} requires a value.`, {stage: 'cli'});
    }
    if (values.has(option)) {
      throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
    }
    values.set(option, value);
    index += 1;
  }
  for (const required of valueOptions) {
    if (!values.has(required)) {
      throw new Sb3BuilderError(`Missing required option: ${required}`, {stage: 'cli'});
    }
  }
  /** @param {string} option */
  const positiveInteger = (option) => {
    const value = Number(values.get(option));
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Sb3BuilderError(`${option} must be an integer >= 1.`, {stage: 'cli'});
    }
    return value;
  };
  const channel = values.get('--channel');
  if (channel !== 'bundled' && channel !== 'unbundled') {
    throw new Sb3BuilderError('--channel must be either bundled or unbundled.', {stage: 'cli'});
  }
  return {
    baseSb3: path.resolve(/** @type {string} */ (values.get('--base'))),
    projectRoot: path.resolve(/** @type {string} */ (values.get('--project-root'))),
    sourceManifest: path.resolve(/** @type {string} */ (values.get('--source-manifest'))),
    output: path.resolve(/** @type {string} */ (values.get('--output'))),
    controlProfile: /** @type {string} */ (values.get('--control-profile')),
    channel,
    maxSourceBytes: positiveInteger('--max-source-bytes'),
    maxAssetFileBytes: positiveInteger('--max-asset-file-bytes'),
    maxAssetFiles: positiveInteger('--max-asset-files'),
    maxTotalAssetBytes: positiveInteger('--max-total-asset-bytes'),
    historyNavigationAvailable: flags.has('--history-navigation-available'),
    replaceExisting: flags.has('--replace-existing'),
  };
}

/**
 * @typedef {Omit<Dsl4CliOptions, 'output' | 'historyNavigationAvailable'> & {watch: true, port: number}} Dsl4PreviewCliOptions
 */

/**
 * @param {string[]} rest
 * @returns {Dsl4PreviewCliOptions}
 */
function parsePreviewDsl4Arguments(rest) {
  const values = new Map();
  const flags = new Set();
  const booleanOptions = new Set(['--watch', '--replace-existing']);
  const requiredValueOptions = new Set([
    '--base',
    '--project-root',
    '--source-manifest',
    '--control-profile',
    '--channel',
    '--max-source-bytes',
    '--max-asset-file-bytes',
    '--max-asset-files',
    '--max-total-asset-bytes',
  ]);
  const valueOptions = new Set([...requiredValueOptions, '--port']);
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (booleanOptions.has(option)) {
      if (flags.has(option)) {
        throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
      }
      flags.add(option);
      continue;
    }
    if (!valueOptions.has(option)) {
      throw new Sb3BuilderError(`Unknown option: ${option}`, {stage: 'cli'});
    }
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Sb3BuilderError(`${option} requires a value.`, {stage: 'cli'});
    }
    if (values.has(option)) {
      throw new Sb3BuilderError(`Duplicate option: ${option}`, {stage: 'cli'});
    }
    values.set(option, value);
    index += 1;
  }
  if (!flags.has('--watch')) {
    throw new Sb3BuilderError('Missing required option: --watch', {stage: 'cli'});
  }
  for (const required of requiredValueOptions) {
    if (!values.has(required)) {
      throw new Sb3BuilderError(`Missing required option: ${required}`, {stage: 'cli'});
    }
  }
  /** @param {string} option */
  const positiveInteger = (option) => {
    const value = Number(values.get(option));
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Sb3BuilderError(`${option} must be an integer >= 1.`, {stage: 'cli'});
    }
    return value;
  };
  const port = values.has('--port') ? Number(values.get('--port')) : 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Sb3BuilderError('--port must be an integer between 0 and 65535.', {stage: 'cli'});
  }
  const channel = values.get('--channel');
  if (channel !== 'bundled' && channel !== 'unbundled') {
    throw new Sb3BuilderError('--channel must be either bundled or unbundled.', {stage: 'cli'});
  }
  const maxAssetFileBytes = positiveInteger('--max-asset-file-bytes');
  const maxTotalAssetBytes = positiveInteger('--max-total-asset-bytes');
  if (maxAssetFileBytes > maxTotalAssetBytes) {
    throw new Sb3BuilderError('--max-asset-file-bytes must be <= --max-total-asset-bytes.', {
      stage: 'cli',
    });
  }
  const maxSourceBytes = positiveInteger('--max-source-bytes');
  const maxAssetFiles = positiveInteger('--max-asset-files');
  for (const [option, value, maximum] of [
    ['--max-source-bytes', maxSourceBytes, dsl4LocalPreviewBrowserBootstrapDefaults.maxSourceBytes],
    [
      '--max-asset-file-bytes',
      maxAssetFileBytes,
      dsl4LocalPreviewBrowserBootstrapDefaults.maxAssetBytes,
    ],
    ['--max-asset-files', maxAssetFiles, dsl4LocalPreviewBrowserBootstrapDefaults.maxAssetFiles],
    [
      '--max-total-asset-bytes',
      maxTotalAssetBytes,
      dsl4LocalPreviewBrowserBootstrapDefaults.maxAssetBytes,
    ],
  ]) {
    if (value > maximum) {
      throw new Sb3BuilderError(`${option} must be <= ${maximum}.`, {stage: 'cli'});
    }
  }
  return {
    watch: true,
    baseSb3: path.resolve(/** @type {string} */ (values.get('--base'))),
    projectRoot: path.resolve(/** @type {string} */ (values.get('--project-root'))),
    sourceManifest: path.resolve(/** @type {string} */ (values.get('--source-manifest'))),
    controlProfile: /** @type {string} */ (values.get('--control-profile')),
    channel,
    maxSourceBytes,
    maxAssetFileBytes,
    maxAssetFiles,
    maxTotalAssetBytes,
    replaceExisting: flags.has('--replace-existing'),
    port,
  };
}

/**
 * @param {string[]} arguments_
 * @returns {{action: 'help'} | {action: 'version'} | {action: 'build', options: Parameters<typeof buildSb3Bundle>[0]} | {action: 'build-dsl4', options: Dsl4CliOptions} | {action: 'preview-dsl4', options: Dsl4PreviewCliOptions} | {action: 'convert', options: Parameters<typeof convertDsl32File>[0]} | {action: 'validate-dsl4', options: ReturnType<typeof parseValidateDsl4Arguments>}}
 */
export function parseCliArguments(arguments_) {
  if (arguments_.includes('--help') || arguments_.includes('-h')) return {action: 'help'};
  if (arguments_.includes('--version') || arguments_.includes('-v')) return {action: 'version'};
  const [command, ...rest] = arguments_;
  if (command === 'build-sb3') {
    return {action: 'build', options: parseBuildSb3Arguments(rest)};
  }
  if (command === 'build-dsl4') {
    return {action: 'build-dsl4', options: parseBuildDsl4Arguments(rest)};
  }
  if (command === 'convert-dsl4') {
    return {action: 'convert', options: parseConvertDsl4Arguments(rest)};
  }
  if (command === 'validate-dsl4') {
    return {action: 'validate-dsl4', options: parseValidateDsl4Arguments(rest)};
  }
  if (command === 'preview-dsl4') {
    return {action: 'preview-dsl4', options: parsePreviewDsl4Arguments(rest)};
  }
  throw new Sb3BuilderError(
    `Expected the build-sb3, build-dsl4, convert-dsl4, preview-dsl4, or validate-dsl4 command, received ${command ?? '(none)'}.`,
    {stage: 'cli'},
  );
}

/**
 * @param {string[]} arguments_
 * @param {{stdout?: Pick<NodeJS.WriteStream, 'write'>, stderr?: Pick<NodeJS.WriteStream, 'write'>}} [io]
 * @param {{runPreview?: typeof runDsl4LocalPreviewCommand}} [dependencies]
 */
export async function runCli(arguments_, io = {}, dependencies = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const parsed = parseCliArguments(arguments_);
  if (parsed.action === 'help') {
    stdout.write(`${usage()}\n`);
    return null;
  }
  if (parsed.action === 'version') {
    stdout.write(`${packageVersion}\n`);
    return null;
  }
  if (parsed.action === 'convert') {
    const result = await convertDsl32File(parsed.options);
    for (const diagnostic of result.diagnostics) {
      stderr.write(`${formatConversionDiagnostic(diagnostic)}\n`);
    }
    if (!result.ok || !result.outputPath) {
      const errorCount = result.diagnostics.filter(
        (diagnostic) => diagnostic.severity === 'error',
      ).length;
      throw new Dsl32ConversionError(
        `DSL 3.2 to 4.0 conversion failed with ${errorCount} error(s).`,
        result.diagnostics,
        {reported: true},
      );
    }
    stdout.write(`Converted ${result.outputPath}\n`);
    return result;
  }
  if (parsed.action === 'build') {
    const result = await buildSb3Bundle(parsed.options);
    stdout.write(`Built ${result.outputPaths[`${parsed.options.outputName}.sb3`]}\n`);
    stdout.write(`Built ${result.outputPaths[`${parsed.options.outputName}.txt`]}\n`);
    stdout.write(`Built ${result.outputPaths[`${parsed.options.outputName}.manifest.json`]}\n`);
    return result;
  }
  const schema = JSON.parse(await readFile(dsl4SchemaUrl, 'utf8'));
  if (parsed.action === 'validate-dsl4') {
    const result = await validateDsl4SourceFile({
      ...parsed.options,
      sourceFrontend: createDsl4ProductionSourceFrontend(schema),
    });
    if (parsed.options.format === 'json') {
      stdout.write(serializeDsl4ValidationResult(result));
    } else if (result.ok) {
      stdout.write(`${path.basename(parsed.options.input)}: valid\n`);
    } else {
      for (const diagnostic of result.diagnostics) {
        stderr.write(`${formatDsl4Diagnostic(diagnostic, path.basename(parsed.options.input))}\n`);
      }
    }
    return {...result, exitCode: result.ok ? 0 : 1};
  }
  if (parsed.action === 'preview-dsl4') {
    const runPreview = dependencies.runPreview ?? runDsl4LocalPreviewCommand;
    if (typeof runPreview !== 'function') throw new TypeError('runPreview must be a function');
    return runPreview(
      {
        ...parsed.options,
        sourceFrontend: createDsl4ProductionSourceFrontend(schema),
      },
      {stdout, stderr},
    );
  }
  const result = await buildDsl4RuntimeComponentFile({
    ...parsed.options,
    sourceFrontend: createDsl4ProductionSourceFrontend(schema),
  });
  stdout.write(`Built ${path.basename(result.outputPath)}\n`);
  return result;
}
